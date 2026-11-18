import fcntl
import json
import logging
import os
import shutil
import time
import threading
import boto3
from botocore.config import Config
from .settings import BUCKET, SCRATCH
from .jobs import claim, Lease, Stopped, StorageQuotaExceeded, confirm_output, fail
from .pipeline import reconstruct
from . import gpu_batch
from .output_quota import reserve_files

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def main():
    import torch
    missing = [name for name in ("colmap", "ffmpeg", "ffprobe", "ns-train", "ns-export") if not shutil.which(name)]
    # With batch jobs (LHC) only the job sees the card; this process prepares, uploads and keeps the lease.
    if missing or not (torch.cuda.is_available() or gpu_batch.enabled()):
        raise RuntimeError(f"GPU worker requires CUDA and reconstruction tools; missing: {missing}")
    SCRATCH.mkdir(parents=True, exist_ok=True)
    storage = boto3.client("s3", endpoint_url=os.environ.get("ROOM_S3_ENDPOINT", "http://room-storage:9000"),
                          aws_access_key_id=os.environ.get("ROOM_S3_ACCESS_KEY", "rooms-local"),
                          aws_secret_access_key=os.environ.get("ROOM_S3_SECRET_KEY", "rooms-local-secret"),
                          region_name="us-east-1", config=Config(signature_version="s3v4", s3={"addressing_style": "path"}))
    storage.bucket = BUCKET
    logging.info("GPU worker ready: %s; waiting for room jobs", f"batch jobs in {gpu_batch.directory()}" if gpu_batch.enabled() else torch.cuda.get_device_name(0))
    # Shared with the avatar worker: two jobs on one 6 GB card stall each other and exhaust RAM, so the later one waits in its queue.
    gpu = open("/gpu-lock/gpu.lock", "a") if os.path.isdir("/gpu-lock") else None
    while True:
        job = None
        work = None
        allocations = {}
        try:
            if gpu:
                try:
                    fcntl.flock(gpu, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    time.sleep(5)
                    continue
            job = claim()
            if job is None:
                if gpu:
                    fcntl.flock(gpu, fcntl.LOCK_UN)
                time.sleep(5)
                continue
            logging.info("Claimed room job %s with profile %s", job["id"], job["profile"])
            work = SCRATCH/str(job["id"])/str(job["lease_token"])
            work.mkdir(parents=True)
            prefix = f"outputs/{job['id']}/{job['lease_token']}/"
            with Lease(job) as lease:
                output, report = reconstruct(job, storage, work, lease)
                lease.stage("publication", 0)
                paths = sorted(output.iterdir())
                lease.check()
                reserve_files(job, paths, prefix, allocations)
                lease.check()
                total_bytes = sum(path.stat().st_size for path in paths)
                uploaded = 0
                upload_lock = threading.Lock()
                def upload_progress(size):
                    nonlocal uploaded
                    with upload_lock:
                        uploaded += size
                        lease.progress("Save results", "Uploading reconstructed assets", uploaded, total_bytes, "bytes uploaded")
                lease.progress("Save results", "Uploading reconstructed assets", 0, total_bytes, "bytes uploaded", force=True)
                for path in paths:
                    lease.check()
                    storage.upload_file(str(path), BUCKET, prefix+path.name, Callback=upload_progress)
                    confirm_output(job, prefix+path.name, path.stat().st_size)
                lease.publish(prefix+"manifest.json", report)
                # A published room needs only dataset/ (camera alignment reads its COLMAP model). Depth maps, decoded frames and
                # trainer state are ~50 MB per frame and filled the disk when left behind.
                for other in work.parent.iterdir():
                    if other != work:
                        shutil.rmtree(other, ignore_errors=True)
                for name in ("dense", "frames", "input", "training"):
                    shutil.rmtree(work/name, ignore_errors=True)
                logging.info("Reconstructed %s; awaiting metric calibration", job["id"])
        except Exception as error:
            logging.exception("Room reconstruction stopped")
            if job:
                try:
                    diagnostics = {"workerError": type(error).__name__, "profile": job["profile"]}
                    # Logs are private storage artifacts; clients receive no raw command paths or secrets.
                    logs = work/"logs" if work else None
                    if logs and logs.exists() and not isinstance(error, (StorageQuotaExceeded, Stopped)):
                        try:
                            paths = sorted(log for log in logs.glob("*.log") if log.stat().st_size > 0)
                            reserve_files(job, paths, prefix+"logs/", allocations)
                            for log in paths:
                                storage.upload_file(str(log), BUCKET, prefix+"logs/"+log.name)
                                confirm_output(job, prefix+"logs/"+log.name, log.stat().st_size)
                            if paths:
                                diagnostics["logPrefix"] = prefix+"logs/"
                        except Exception:
                            logging.exception("Could not reserve or retain attempt logs")
                    fail(job, "The reconstruction was interrupted. Finished steps are saved: press Continue reconstruction." if isinstance(error, Stopped) else str(error),
                         diagnostics, interrupted=isinstance(error, Stopped))
                except Exception:
                    logging.exception("Could not persist failure; lease recovery will reclaim the job")
            time.sleep(5)
        finally:
            if gpu and job:
                fcntl.flock(gpu, fcntl.LOCK_UN)


if __name__ == "__main__":
    main()
