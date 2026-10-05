import json
import logging
import os
import shutil
import time
import threading
import boto3
from botocore.config import Config
from .settings import BUCKET, SCRATCH
from .jobs import claim, Lease, Stopped, fail
from .pipeline import reconstruct

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def main():
    import torch
    missing = [name for name in ("colmap", "ffmpeg", "ffprobe", "ns-train", "ns-export") if not shutil.which(name)]
    if missing or not torch.cuda.is_available():
        raise RuntimeError(f"GPU worker requires CUDA and reconstruction tools; missing: {missing}")
    SCRATCH.mkdir(parents=True, exist_ok=True)
    storage = boto3.client("s3", endpoint_url=os.environ.get("ROOM_S3_ENDPOINT", "http://room-storage:9000"),
                          aws_access_key_id=os.environ.get("ROOM_S3_ACCESS_KEY", "rooms-local"),
                          aws_secret_access_key=os.environ.get("ROOM_S3_SECRET_KEY", "rooms-local-secret"),
                          region_name="us-east-1", config=Config(signature_version="s3v4", s3={"addressing_style": "path"}))
    storage.bucket = BUCKET
    logging.info("GPU worker ready: %s; waiting for room jobs", torch.cuda.get_device_name(0))
    while True:
        job = None
        try:
            job = claim()
            if job is None:
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
                lease.publish(prefix+"manifest.json", report)
                logging.info("Reconstructed %s; awaiting metric calibration", job["id"])
        except Exception as error:
            logging.exception("Room reconstruction stopped")
            if job:
                try:
                    diagnostics = {"workerError": type(error).__name__, "profile": job["profile"]}
                    # Logs are private storage artifacts; clients receive no raw command paths or secrets.
                    logs = work/"logs"
                    if logs.exists():
                        for log in logs.glob("*.log"):
                            storage.upload_file(str(log), BUCKET, prefix+"logs/"+log.name)
                        diagnostics["logPrefix"] = prefix+"logs/"
                    fail(job, "Worker interrupted; retry after checking worker/storage availability" if isinstance(error, Stopped) else str(error), diagnostics)
                except Exception:
                    logging.exception("Could not persist failure; lease recovery will reclaim the job")
            time.sleep(5)


if __name__ == "__main__":
    main()
