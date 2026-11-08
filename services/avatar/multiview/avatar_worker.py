"""GPU worker: turns queued photo sets into person-only Gaussian avatars.

Layout (shared `avatar-photos` volume, written by photo_api):
  /data/<owner>/<capture>/{0.jpg,1.jpg,...,capture.json}
  /data/<owner>/<capture>/job.json         created by the API (state=queued), afterwards written only here
  /data/<owner>/<capture>/cancel-request   created by the API to cancel
  /data/<owner>/<capture>/work/            stage outputs + job.log
"""
import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

DATA = Path(os.environ.get("PHOTO_DATA_DIR", "/data"))
CODE = Path(__file__).resolve().parent
STEPS = os.environ.get("AVATAR_TRAIN_STEPS", "15000")
# Stage id → script and arguments; the job's own stage list (set by the API) decides which ones run.
SCRIPTS = {
    "frames": lambda video: ["frames.py"],
    # One lens for a video; photo sets may mix cameras/zoom.
    "cameras": lambda video: ["cameras.py", "1" if video else "0"],
    "masks": lambda video: ["masks.py"],
    "prepare": lambda video: ["prepare.py"],
    "train": lambda video: ["train.py", STEPS, "avatar"],
    "skeleton": lambda video: ["skeleton.py"],
    "rig": lambda video: ["rig.py"],
}
LOGGER = logging.getLogger("avatar-worker")


def now():
    return datetime.now(timezone.utc).isoformat()


def write(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding="utf-8")
    temporary.replace(path)


def jobs(state):
    found = []
    for path in DATA.glob("*/*/job.json"):
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if job.get("state") == state:
            found.append((job.get("createdAt", ""), path, job))
    return sorted(found, key=lambda item: item[0])


def run_stage(job, path, index, log):
    stage = job["stages"][index]
    stage_id, capture = stage["id"], path.parent
    work = capture / "work"
    video = any(item["id"] == "frames" for item in job["stages"])
    command = SCRIPTS[stage_id](video)
    # Video frames are extracted into work/input; photo sets are read from the capture folder itself.
    source = work / "input" if video and stage_id != "frames" else capture
    environment = {**os.environ, "AVATAR_INPUT": str(source), "AVATAR_WORK": str(work), "PYTHONUNBUFFERED": "1"}
    stage.update(state="running", startedAt=now(), progress=0.0)
    job.update(stage=stage_id); write(path, job)
    process = subprocess.Popen([sys.executable, str(CODE / command[0]), *command[1:]], cwd=work, env=environment,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    error, last_write = "", 0.
    for line in process.stdout:
        log.write(line); log.flush()
        if (capture / "cancel-request").exists():
            process.kill(); process.wait()
            raise InterruptedError("Cancelled")
        if line.startswith("ERROR "):
            error = line[6:].strip()
        if line.startswith("PROGRESS "):
            try:
                update = json.loads(line[9:])
            except ValueError:
                continue
            if update.get("fraction") is not None:
                stage["progress"] = float(update["fraction"])
            stage["message"] = update.get("message", stage.get("message", ""))
            stage.setdefault("metrics", {}).update({k: v for k, v in update.items() if k not in ("fraction", "message")})
            # Bound status writes; the final 1.0 update is always written.
            if time.monotonic() - last_write > 1 or stage["progress"] >= 1:
                write(path, job); last_write = time.monotonic()
    if process.wait():
        raise RuntimeError(error or f"{stage['label']} failed (exit code {process.returncode}). See the job log.")
    stage.update(state="done", progress=1.0, finishedAt=now())
    write(path, job)


def process(path, job):
    if (path.parent / "cancel-request").exists():
        (path.parent / "cancel-request").unlink(missing_ok=True)
        job.update(state="cancelled", finishedAt=now())
        write(path, job)
        return
    work = path.parent / "work"
    work.mkdir(exist_ok=True)
    job.update(state="running", startedAt=now(), error=None)
    write(path, job)
    LOGGER.info("Started avatar job %s", path.parent.name)
    with (work / "job.log").open("a", encoding="utf-8") as log:
        try:
            for index in range(len(job["stages"])):
                run_stage(job, path, index, log)
            report = json.loads((work / "train-report-avatar.json").read_text())
            job.update(state="done", stage="done", finishedAt=now(),
                       result={"model": "model.ply", "bytes": report["plyBytes"], "gaussians": report["gaussians"],
                               "rig": (work / "rig" / "manifest.json").is_file(),
                               "heldOut": report.get("mean", {}), "previews": sorted(p.name for p in (work / "renders").glob("*.jpg"))})
        except InterruptedError:
            job.update(state="cancelled", finishedAt=now())
        except Exception as error:  # Every failure is shown to the user; details stay in job.log.
            LOGGER.exception("Avatar job %s failed", path.parent.name)
            job.update(state="failed", error=str(error)[:500], finishedAt=now())
        for stage in job["stages"]:
            if stage["state"] == "running":
                stage["state"] = "failed" if job["state"] == "failed" else "cancelled"
        (path.parent / "cancel-request").unlink(missing_ok=True)
        write(path, job)
    LOGGER.info("Avatar job %s %s", path.parent.name, job["state"])


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    for _, path, job in jobs("running"):
        job.update(state="failed", error="The avatar worker restarted during processing. Start the job again.", finishedAt=now())
        write(path, job)
    LOGGER.info("Avatar worker ready; waiting for photo sets in %s", DATA)
    while True:
        queued = jobs("queued")
        if queued:
            _, path, job = queued[0]
            process(path, job)
        else:
            time.sleep(3)


if __name__ == "__main__":
    main()
