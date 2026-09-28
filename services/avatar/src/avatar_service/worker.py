import os
import shutil
import threading
import time
import uuid
from pathlib import Path

from .api import DATABASE_URL
from .generator import generate_avatar
from .models import AvatarProfile
from .packages import validate_package
from .store import Store


class Worker:
    def __init__(self, store, data_dir, *, generator=generate_avatar):
        self.store = store
        self.data_dir = Path(data_dir).resolve()
        self.generator = generator

    def run_once(self):
        attempt = str(uuid.uuid4())
        job = self.store.claim(attempt)
        if not job:
            return False
        output = self.data_dir / "artifacts" / job["id"] / attempt
        cancelled = threading.Event()
        stop = threading.Event()

        def heartbeat():
            while not stop.wait(1):
                try:
                    if not self.store.heartbeat(job["id"], attempt):
                        cancelled.set()
                        return
                except Exception:
                    cancelled.set()
                    return

        thread = threading.Thread(target=heartbeat, daemon=True)
        thread.start()
        published = False
        try:
            self.generator(
                AvatarProfile.model_validate_json(job["profile"]),
                output,
                cancelled=cancelled,
                avatar_id=job["avatar_id"],
                version=job["version"],
            )
            manifest = validate_package(output)
            if (
                str(manifest.avatar_id) != job["avatar_id"]
                or manifest.version != job["version"]
            ):
                raise ValueError(
                    "Generator returned a different avatar identity or version"
                )
            if not cancelled.is_set():
                published = self.store.finish(
                    job["id"], attempt, "SUCCEEDED", result_path=str(output)
                )
        except Exception as exc:
            self.store.finish(job["id"], attempt, "FAILED", error=str(exc)[-6000:])
        finally:
            stop.set()
            thread.join(timeout=3)
            if not published and output.exists():
                shutil.rmtree(output)
        return True


def main():
    worker = Worker(
        Store(os.getenv("AVATAR_DATABASE_URL", DATABASE_URL)),
        os.getenv("AVATAR_DATA_DIR", ".runtime/avatar-data"),
    )
    while True:
        if not worker.run_once():
            time.sleep(1)


if __name__ == "__main__":
    main()
