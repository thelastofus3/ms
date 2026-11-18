"""reconstruct() for a server whose graphics card only batch jobs see (LHC): this process stays light (that tenant has 1 CPU,
2 GB RAM and 128 tasks for the web site as well) and does only what needs the network; batch_job runs the pipeline.

A job ends after 8 hours: the attempt directory is then set aside and a new job resumes from its checkpoints (camera
poses, depth maps written so far, trainer steps), as "Continue reconstruction" would.
"""
import json
import os
import sys
import threading
from pathlib import Path

from boto3.s3.transfer import TransferConfig

from . import gpu_batch
from .input_identity import validate_media
from .jobs import Stopped

RESUMES = 3
# Each transfer thread is a task of the tenant (128 in all, the API alone has 40).
TRANSFER = TransferConfig(max_concurrency=int(os.environ.get("ROOM_S3_THREADS", "2")))


def download(job, storage, folder, lease):
    """The media, once per job (kept for the attempts after a time limit); the job verifies their hashes."""
    folder.mkdir(parents=True, exist_ok=True)
    total, done, lock = sum(item["size"] for item in job["media"]), 0, threading.Lock()
    def counted(size):
        nonlocal done
        with lock:
            done += size
            lease.progress("Download capture", "Reading uploaded media", done, total, "bytes downloaded")
    lease.progress("Download capture", "Reading uploaded media", 0, total, "bytes downloaded", force=True)
    for number, item in enumerate(job["media"]):
        lease.check()
        target = folder / f"{number:05d}.media"
        if target.is_file() and target.stat().st_size == item["size"]:
            counted(item["size"])
            continue
        partial = target.with_suffix(".part")
        storage.download_file(storage.bucket, item["key"], str(partial), Callback=counted, Config=TRANSFER)
        partial.replace(target)


def reconstruct(job, storage, work: Path, lease):
    validate_media(job["media"])
    download(job, storage, work.parent / "media", lease)
    environment = {"ROOM_SCRATCH": os.environ.get("ROOM_SCRATCH", "/scratch"), "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
    for name in ("ROOM_MAX_SCRATCH_GIB", "ROOM_MAX_SPLATS"):
        if name in os.environ:
            environment[name] = os.environ[name]
    def mirror():
        try:
            stage = json.loads((work / "batch-stage.json").read_text())
        except (OSError, ValueError):
            return
        if stage["stage"] != lease.current_stage:
            lease.stage(stage["stage"], stage["progress"], announce=False)
    def waiting(reason):
        lease.progress("Waiting for the graphics card", "The shared graphics card is busy with other work; this step starts when it is free"
                       if reason == "busy" else "An avatar build is using the graphics card; this step starts after it", force=True)
    def tick():
        lease.check()
        mirror()
    for attempt in range(RESUMES + 1):
        work.mkdir(parents=True, exist_ok=True)
        (work / "batch-job.json").write_text(json.dumps(job, default=str))
        result = gpu_batch.run([sys.executable, "-m", "room_worker.batch_job", work], work, work / "logs" / "0-batch-job.log",
                               env=environment, tick=tick, waiting=waiting)
        mirror()
        try:
            done = json.loads((work / "batch-result.json").read_text())
            return Path(done["output"]), done["report"]
        except (OSError, ValueError):
            pass
        if result.timed_out and attempt < RESUMES:
            # The next job starts in a fresh directory and recovers this one's checkpoints (pipeline.recover).
            work.rename(work.with_name(f"{work.name}-part{attempt + 1}"))
            continue
        try:
            error = json.loads((work / "batch-error.json").read_text())
        except (OSError, ValueError):
            error = {}
        if error.get("stopped"):
            raise Stopped(error["message"])
        if result.out_of_memory:
            raise RuntimeError("The reconstruction ran out of memory (12 GB per GPU job). Choose Standard detail or fewer clips.")
        if result.timed_out:
            raise RuntimeError("The reconstruction reached the time limit of the shared graphics card several times. "
                               "Finished work is saved: press Continue reconstruction.")
        raise RuntimeError(error.get("message") or f"The GPU job failed (exit status {result.returncode}); see the attempt logs.")
