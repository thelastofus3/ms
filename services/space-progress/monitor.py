"""Report observed tool progress without interrupting reconstruction or extending its lease."""
import logging
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import psycopg
import boto3
from botocore.config import Config
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from tensorboard.backend.event_processing.event_file_loader import EventFileLoader

DATABASE = os.environ["ROOM_DATABASE_DSN"]
SCRATCH = Path(os.environ.get("ROOM_SCRATCH", "/scratch"))
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
loaders = {}
training_steps = {}
storage = boto3.client("s3", endpoint_url=os.environ.get("ROOM_S3_ENDPOINT", "http://room-storage:9000"),
                       aws_access_key_id=os.environ.get("ROOM_S3_ACCESS_KEY", "rooms-local"),
                       aws_secret_access_key=os.environ.get("ROOM_S3_SECRET_KEY", "rooms-local-secret"),
                       region_name="us-east-1", config=Config(connect_timeout=3, read_timeout=5,
                       retries={"max_attempts": 1}, signature_version="s3v4"))
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def latest_counter(text, pattern):
    matches = list(re.finditer(pattern, text, re.I))
    return tuple(map(int, matches[-1].groups())) if matches else None


def observe(job):
    root = SCRATCH / str(job["id"]) / str(job["lease_token"])
    logs = sorted((root / "logs").glob("*.log"))
    text = ""
    log = logs[-1] if logs else None
    if log:
        with log.open("rb") as stream:
            stream.seek(max(0, log.stat().st_size - 512 * 1024))
            text = ANSI.sub("", stream.read().decode(errors="replace"))
    now = time.time()
    started = int(log.name.split("-", 1)[0]) / 1e9 if log else job["updated_at"].timestamp()
    updated = log.stat().st_mtime if log else started
    worker = None
    marker = root / "live-progress.json"
    if marker.is_file():
        candidate = json.loads(marker.read_text())
        if candidate.get("stage") == job["stage"]:
            started = candidate["startedAt"]
            checkpoint_finished = candidate.get("label") == "Save checkpoint" and log and int(log.name.split("-", 1)[0]) / 1e9 > candidate["updatedAt"]
            if candidate.get("activity") != "Starting this step" and not checkpoint_finished:
                worker = candidate
                updated = max(updated, candidate["updatedAt"])
    result = {"stage": job["stage"], "elapsedSeconds": max(0, int(now - started)),
              "quietSeconds": max(0, int(now - updated)),
              "observedAt": datetime.now(timezone.utc).isoformat(),
              "label": "Processing", "activity": "Working on this step", "percent": None}
    count = None
    images = len(list((root / "dataset" / "images").glob("*.jpg")))
    if job["stage"] == "poses":
        if "Processed file [" in text:
            count = latest_counter(text, r"Processed file\s*\[(\d+)/(\d+)\]")
            result.update(label="Feature extraction", unit="frames processed", activity="Finding visual features")
        elif "Matching block [" in text:
            count = latest_counter(text, r"Matching block\s*\[(\d+)/(\d+)\]")
            # COLMAP announces a block before processing it.
            if count:
                count = (max(0, count[0] - 1), count[1])
            result.update(label="Feature matching", unit="matching blocks completed", activity="Matching overlapping views")
        else:
            registered = re.findall(r"Registering image\s+#\d+\s*\((\d+)\)", text)
            if registered and images:
                # This is coverage of the current candidate, not time remaining or stage completion.
                count = (max(0, int(registered[-1]) - 1), images)
            result.update(label="Camera coverage", unit="views aligned in the current candidate",
                          activity="Refining camera positions and 3D points")
            if "Initializing with image pair" in text and not registered:
                result["activity"] = "Finding a stable initial pair of views"
    elif job["stage"] == "geometry":
        config = root / "dense" / "stereo" / "patch-match.cfg"
        lines = [line.strip() for line in config.read_text().splitlines() if line.strip() and not line.lstrip().startswith("#")] if config.is_file() else []
        names = set(lines[::2]) if lines else {path.name for path in (root / "dense" / "images").glob("*")}
        dense_images = len(names)
        depth_root = root / "dense" / "stereo" / "depth_maps"
        photometric = sum((depth_root / (name + ".photometric.bin")).is_file() for name in names)
        geometric = sum((depth_root / (name + ".geometric.bin")).is_file() for name in names)
        if dense_images and (photometric or geometric or "PatchMatch" in text):
            if geometric >= dense_images:
                result.update(label="Collision mesh", activity="Integrating depth, simplifying surfaces and finding a floor")
            else:
                count = (photometric + geometric, dense_images * 2)
                result.update(label="Depth estimation", unit="depth maps written across two passes",
                              activity="Checking geometric consistency" if geometric else "Estimating photometric depth on the GPU")
        else:
            count = latest_counter(text, r"Undistorting image\s*\[(\d+)/(\d+)\]")
            result.update(label="Prepare depth estimation", unit="images undistorted", activity="Preparing views for depth estimation")
    elif job["stage"] == "training":
        token = str(job["lease_token"])
        step = training_steps.get(token, 0)
        restored = re.findall(r"step-(\d+)\.ckpt", text)
        if restored:
            step = max(step, max(map(int, restored)))
        for event_path in (root / "training").rglob("*tfevents*"):
            if not event_path.is_file():
                continue
            updated = max(updated, event_path.stat().st_mtime)
            loader = loaders.setdefault(str(event_path), EventFileLoader(str(event_path)))
            for event in loader.Load():
                if event.HasField("summary"):
                    step = max(step, int(event.step))
        training_steps[token] = step
        total_steps = 15000 if job["profile"] == "local" else 30000
        checkpoint = root / "checkpoint.json"
        if checkpoint.is_file():
            total_steps = json.loads(checkpoint.read_text()).get("report", {}).get("trainingSchedule", {}).get("steps", total_steps)
        count = (step, total_steps)
        result.update(label="Training", unit="training iterations completed", activity="Optimizing Gaussian Splats",
                      quietSeconds=max(0, int(now - updated)))
    elif job["stage"] == "preprocessing":
        result.update(label="Prepare frames", activity="Decoding and selecting sharp frames")
        total = sum(item["size"] for item in job["media"])
        downloaded = sum(path.stat().st_size for path in (root / "input").glob("*.media"))
        if total and downloaded < total:
            count = (downloaded, total)
            result.update(label="Download capture", unit="bytes downloaded", activity="Reading uploaded media")
    elif job["stage"] == "publication":
        result.update(label="Save results", activity="Uploading reconstructed assets")
        paths = [path for path in (root / "output").iterdir() if path.is_file()]
        total = sum(path.stat().st_size for path in paths)
        if total and not worker:
            prefix = f"outputs/{job['id']}/{job['lease_token']}/"
            objects = storage.list_objects_v2(Bucket=os.environ.get("ROOM_S3_BUCKET", "rooms"), Prefix=prefix)
            names = {prefix + path.name for path in paths}
            count = (sum(item["Size"] for item in objects.get("Contents", []) if item["Key"] in names), total)
            result["unit"] = "bytes saved in storage"
    else:
        result["activity"] = {"export": "Exporting the trained scene", "optimization": "Compressing splats for the browser",
                              "validation": "Packaging scene assets", "publication": "Uploading reconstructed assets"}.get(job["stage"], "Processing")
    if count and count[1] > 0:
        result.update(completed=min(count[0], count[1]), total=count[1], percent=round(min(100, 100 * count[0] / count[1]), 1))
    if worker:
        result.update({key: worker[key] for key in ("label", "activity", "percent", "completed", "total", "unit") if key in worker})
        if worker["percent"] is None:
            for key in ("completed", "total", "unit"):
                result.pop(key, None)
        decode = root / "decode-progress.txt"
        if worker["label"] == "Decode video" and decode.is_file():
            counters = re.findall(r"out_time_us=(\d+)", decode.read_text(errors="replace"))
            if counters:
                seconds = min(worker["total"], int(counters[-1]) / 1e6)
                result.update(completed=round(seconds, 1), percent=round(100 * seconds / worker["total"], 1),
                              quietSeconds=max(0, int(now - decode.stat().st_mtime)))
    return result


def main():
    logging.info("Live room progress reporter ready")
    while True:
        try:
            with psycopg.connect(DATABASE, row_factory=dict_row, connect_timeout=10) as db:
                jobs = db.execute("SELECT j.id,j.lease_token,j.stage,j.profile,j.updated_at,u.media FROM room_jobs j "
                                  "JOIN room_uploads u ON u.id=j.upload_id WHERE j.state='RUNNING' "
                                  "AND j.lease_until>now() AND NOT j.cancel_requested").fetchall()
                for job in jobs:
                    try:
                        progress = observe(job)
                        if progress:
                            # Preserve the owner worker's lease, stage and quality diagnostics.
                            db.execute("""UPDATE room_jobs SET diagnostics=jsonb_set(diagnostics,'{liveProgress}',%s,true)
                                WHERE id=%s AND lease_token=%s AND stage=%s AND state='RUNNING'
                                AND lease_until>now() AND NOT cancel_requested""",
                                       (Jsonb(progress), job["id"], job["lease_token"], job["stage"]))
                    except (OSError, ValueError):
                        logging.exception("Progress artifacts not yet readable")
                active_tokens = {str(job["lease_token"]) for job in jobs}
                for token in list(training_steps):
                    if token not in active_tokens:
                        training_steps.pop(token, None)
                active_roots = [str(SCRATCH / str(job["id"]) / str(job["lease_token"])) + "/" for job in jobs]
                for path in list(loaders):
                    if not any(path.startswith(root) for root in active_roots):
                        loaders.pop(path, None)
        except Exception:
            logging.exception("Progress reporter reconnecting")
        time.sleep(3)


if __name__ == "__main__":
    main()
