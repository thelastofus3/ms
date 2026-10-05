"""Read-only integration probe using one already-retained room source image."""
import argparse
import hashlib
import json
import math
import shutil
import sys
import tempfile
import time
import uuid
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from room_worker.localizer import (attempt_directory, connect, metric_geometry, read_private,
                                   register_image, storage_client)
import pycolmap


class ProbeLease:
    def __init__(self):
        self.deadline = time.monotonic() + 600
        self.stages = []
        self.last_progress = {}
        self.completed = {}
        self.observed_memory_peak = 0

    def check(self):
        if time.monotonic() >= self.deadline:
            raise RuntimeError("Probe exceeded ten-minute deadline")
        memory = Path("/sys/fs/cgroup/memory.current")
        if memory.is_file():
            self.observed_memory_peak = max(self.observed_memory_peak, int(memory.read_text()))

    def stage(self, value):
        self.check()
        self.stages.append(value)
        print(json.dumps({"stage": value}), flush=True)

    def progress(self, completed, total, unit, activity, force=False):
        self.check()
        self.completed[unit] = {"checked": completed, "total": total, "activity": activity}
        previous = self.last_progress.get(unit, -total)
        if force or completed - previous >= max(1, total // 4):
            self.last_progress[unit] = completed
            print(json.dumps({"activity": activity, "completed": completed, "total": total, "unit": unit}), flush=True)


def fingerprint(attempt):
    files = [attempt / "dataset/colmap/database.db"] + sorted((attempt / "dataset/colmap/sparse/0").glob("*.bin"))
    wal = Path(str(files[0]) + "-wal")
    if wal.exists():
        files.append(wal)
    values = {}
    for file in files:
        digest = hashlib.sha256()
        with file.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        values[file.name] = digest.hexdigest()
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job", type=uuid.UUID, help="Select this READY room instead of the most recently changed READY room")
    parser.add_argument("--version", type=int, help="Use this calibrated manifest version instead of the latest")
    parser.add_argument("--source", help="Use this exact registered image name instead of the image with most mapped points")
    parser.add_argument("--report", type=Path, help="Save numerical evidence and, on failure, the private subprocess log")
    args = parser.parse_args()
    if args.version is not None and args.version < 1:
        parser.error("--version must be positive")
    with connect() as db:
        rows = db.execute("""SELECT j.id,v.manifest_key,v.version,
            (SELECT manifest_key FROM room_versions WHERE job_id=j.id AND version=1) original_key
            FROM room_jobs j JOIN LATERAL
            (SELECT manifest_key,ready,version FROM room_versions WHERE job_id=j.id AND (%s::integer IS NULL OR version=%s)
             ORDER BY version DESC LIMIT 1) v ON true
            WHERE j.state='READY' AND v.ready AND (%s::uuid IS NULL OR j.id=%s) ORDER BY j.updated_at DESC""",
            (args.version, args.version, args.job, args.job)).fetchall()
    chosen = None
    for row in rows:
        attempt = attempt_directory(row["manifest_key"], row["id"], original_key=row["original_key"])
        if (attempt / "dataset/colmap/sparse/0/points3D.bin").is_file():
            chosen = (row, attempt)
            break
    if chosen is None:
        raise RuntimeError("No ready room with a retained camera map is available")
    row, attempt = chosen
    storage = storage_client()
    manifest = json.loads(read_private(storage, row["manifest_key"], 1024 * 1024))
    reconstruction = pycolmap.Reconstruction(str(attempt / "dataset/colmap/sparse/0"))
    if args.source:
        source = next((image for image in reconstruction.images.values() if image.name == args.source), None)
        if source is None:
            raise RuntimeError("Requested source image is not registered in this room")
    else:
        source = max(reconstruction.images.values(), key=lambda image: sum(point.has_point3D() for point in image.points2D))
    source_file = attempt / "dataset/images" / source.name
    before = fingerprint(attempt)
    started = time.monotonic()
    lease = ProbeLease()
    def events():
        file = Path("/sys/fs/cgroup/memory.events")
        return dict((name, int(value)) for name, value in (line.split() for line in file.read_text().splitlines())) if file.is_file() else {}
    initial_events = events()
    def emit_report(value):
        value.update(observedContainerMemoryPeakBytes=lease.observed_memory_peak,
                     memoryEventsBefore=initial_events, memoryEventsAfter=events())
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(value, indent=2))
        print(json.dumps(value), flush=True)
    with tempfile.TemporaryDirectory(prefix="camera-registration-probe-") as folder:
        folder = Path(folder)
        with Image.open(source_file) as frame:
            live_size = frame.size
            frame.thumbnail((1280, 1280))
            frame.convert("RGB").save(folder / "query.jpg", quality=95)
        try:
            result = register_image(attempt, folder / "query.jpg", manifest, live_size, folder, lease)
        except Exception as error:
            emit_report({"passed": False, "error": str(error), "seconds": round(time.monotonic() - started, 3),
                         "job": str(row["id"]), "manifestVersion": row["version"], "sourceImage": source.name,
                         "stages": lease.stages, "matching": lease.completed.get("reference views checked"),
                         "referenceDatabaseAndModelUnchanged": before == fingerprint(attempt),
                         "realCameraAccess": False, "alignmentJobsCreated": 0})
            log = folder / "private-command.log"
            if args.report and log.is_file():
                shutil.copyfile(log, args.report.with_suffix(".log"))
            raise
    actual = result["geometry"]
    source_pose = source.cam_from_world() if callable(source.cam_from_world) else source.cam_from_world
    expected = metric_geometry(reconstruction.cameras[source.camera_id], source_pose, manifest, live_size, 100, 0)
    center_delta = np.linalg.norm(np.array(list(actual["center"].values())) - np.array(list(expected["center"].values())))
    first = np.asarray(actual["worldFromCamera"]).reshape(3, 3)
    second = np.asarray(expected["worldFromCamera"]).reshape(3, 3)
    angle = math.degrees(math.acos(float(np.clip((np.trace(first.T @ second) - 1) / 2, -1, 1))))
    immutable = before == fingerprint(attempt)
    assert immutable, "Registration changed the reference database/model"
    assert actual["inliers"] >= 30 and actual["reprojectionErrorPx"] <= 5
    assert center_delta < .2 and angle < 3, "Registered source view disagrees with its known camera pose"
    emit_report({"passed": True, "seconds": round(time.monotonic() - started, 3),
                      "job": str(row["id"]), "manifestVersion": row["version"], "sourceImage": source.name,
                      "inliers": actual["inliers"], "reprojectionErrorPx": actual["reprojectionErrorPx"],
                      "sourcePoseCenterErrorMeters": float(center_delta), "sourcePoseAngleErrorDegrees": angle,
                      "referenceDatabaseAndModelUnchanged": immutable, "referenceImages": len(reconstruction.images),
                      "referencePoints": len(reconstruction.points3D), "stages": lease.stages,
                      "matching": lease.completed.get("reference views checked"),
                      "realCameraAccess": False, "alignmentJobsCreated": 0})


if __name__ == "__main__":
    main()
