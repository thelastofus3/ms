"""One reconstruction attempt inside a GPU batch job (LHC, see gpu_batch and remote): no network, so no database and no storage.

The worker outside downloaded the media to <scratch>/<job>/media/ and wrote batch-job.json into the attempt directory; this
process runs the normal pipeline there and leaves batch-result.json or batch-error.json. Stages go to batch-stage.json (the
worker copies them into the database), live progress to the usual live-progress.json; batch-stop asks it to stop.
"""
import json
import os
import shutil
import sys
import time
import traceback
from pathlib import Path

from .jobs import Lease, Stopped


def write(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, default=str))
    temporary.replace(path)


class FileLease(Lease):
    """The job's side of the lease: the worker outside renews the real one and stops this job when it is lost or cancelled."""

    def __init__(self, job, work):
        super().__init__(job)
        self.work = work

    def check(self):
        if (self.work / "batch-stop").exists():
            raise Stopped("The reconstruction was stopped")

    def stage(self, name, progress, announce=True):
        self.check()
        self.current_stage, self.stage_started = name, time.time()
        write(self.work / "batch-stage.json", {"stage": name, "progress": progress})
        if announce:
            self.progress(name.replace("_", " ").capitalize(), "Starting this step", force=True)

    def publish(self, manifest_key, diagnostics):
        raise RuntimeError("A batch job does not publish; the worker outside does")


class LocalStorage:
    """download_file() of the boto3 client, served from the media the worker outside already downloaded."""
    bucket = "local"

    def __init__(self, media, folder):
        self.index = {item["key"]: folder / f"{number:05d}.media" for number, item in enumerate(media)}

    def download_file(self, bucket, key, filename, Callback=None):
        source = self.index[key]
        try:
            os.link(source, filename)
        except OSError:
            shutil.copyfile(source, filename)
        if Callback:
            Callback(source.stat().st_size)


def main():
    work = Path(sys.argv[1])
    job = json.loads((work / "batch-job.json").read_text())
    for name in ("batch-result.json", "batch-error.json", "batch-stop"):
        (work / name).unlink(missing_ok=True)
    try:
        from .pipeline import reconstruct
        output, report = reconstruct(job, LocalStorage(job["media"], work.parent / "media"), work, FileLease(job, work))
        write(work / "batch-result.json", {"output": str(output), "report": report})
    except BaseException as error:
        traceback.print_exc()
        write(work / "batch-error.json", {"type": type(error).__name__, "message": str(error), "stopped": isinstance(error, Stopped)})
        raise SystemExit(1)


if __name__ == "__main__":
    main()
