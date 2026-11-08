"""Read-only diagnosis of automatic camera alignment for one camera JPEG.

Runs the production register_image path, but executes pose/learned subprocesses
in-process and prints every gate decision instead of one generic error.
Usage (inside the room-localizer image):
  python tests/localizer_frame_diagnose.py <room-job-id> <frame.jpg>
"""
import json
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from room_worker import learned_localizer as learned
from room_worker import localizer as loc


def log(event, **values):
    print(json.dumps({"event": event, **values}, default=float), flush=True)


class Lease:
    deadline = time.monotonic() + 1800

    def check(self):
        pass

    def stage(self, value):
        log("stage", stage=value)

    def progress(self, completed, total, unit, activity, force=False):
        if force:
            log("progress", completed=completed, total=total, unit=unit, activity=activity)


original_run, original_solve = loc.run_command, loc.solve_pose
original_validate, original_metric = loc.validated_registration, loc.metric_geometry


def run_command(command, directory, lease, timeout, error, progress_path=None):
    command = [str(value) for value in command]
    if command[1:3] == ["-m", "room_worker.localizer"] and command[3] == "--solve-pose":
        return loc.solve_pose(Path(command[4]), Path(command[5]))
    if command[1:3] == ["-m", "room_worker.learned_localizer"]:
        log("learned_fallback")
        try:
            return learned.run(Path(command[3]), Path(command[4]), Path(command[5]))
        except loc.LocalizationError as failure:
            log("learned_rejected", reason=str(failure))
            raise
    return original_run(command, directory, lease, timeout, error, progress_path)


def solve_pose(input_path, output_path):
    data = np.load(input_path)
    try:
        original_solve(input_path, output_path)
    except loc.LocalizationError as failure:
        log("solve_pose_failed", correspondences=len(data["image_points"]), reason=str(failure))
        raise
    result = json.loads(Path(output_path).read_text())
    errors = np.asarray(result["errors"])
    log("solve_pose", correspondences=len(data["image_points"]), inliers=int(sum(result["inliers"])),
        rms=float(np.sqrt(np.mean(errors ** 2))) if len(errors) else None, params=result["params"],
        initialFocal=float(data["focal"]), maxError=float(data["max_error"]))


def validated_registration(result, image_points, manifest, size, live_size, strong=False):
    mask = np.asarray(result["inliers"], dtype=bool)
    if mask.any():
        normalized = image_points[mask] / list(size)
        span = [float(np.ptp(normalized[:, 0])), float(np.ptp(normalized[:, 1]))]
    else:
        span = None
    try:
        value = original_validate(result, image_points, manifest, size, live_size, strong)
    except loc.LocalizationError as failure:
        log("validation_rejected", strong=strong, inliers=int(mask.sum()), total=len(mask), span=span,
            params=result["params"], reason=str(failure))
        raise
    log("validation_passed", inliers=int(mask.sum()), span=span, center=value["geometry"]["center"])
    return value


def metric_geometry(camera, pose, manifest, live_size, inliers, reprojection_error):
    f, cx, cy, k1 = map(float, camera.params)
    radius = max((x-cx)**2 + (y-cy)**2 for x in (0, camera.width) for y in (0, camera.height)) / f**2
    try:
        return original_metric(camera, pose, manifest, live_size, inliers, reprojection_error)
    except loc.LocalizationError as failure:
        matrix = np.asarray(pose.matrix())
        log("metric_rejected", focal=f, k1=k1, edgeTerm=1 + 3*k1*radius, fovDeg=float(np.degrees(2*np.arctan(camera.width/2/f))),
            centerReconstruction=(-matrix[:, :3].T @ matrix[:, 3]).tolist(), reason=str(failure))
        raise


loc.run_command, loc.solve_pose = run_command, solve_pose
loc.validated_registration, loc.metric_geometry = validated_registration, metric_geometry


def main(job_id, frame):
    with loc.connect() as db:
        version = db.execute("SELECT version,manifest_key FROM room_versions WHERE job_id=%s AND ready ORDER BY version DESC LIMIT 1", (job_id,)).fetchone()
        original = db.execute("SELECT manifest_key FROM room_versions WHERE job_id=%s AND version=1", (job_id,)).fetchone()
    storage = loc.storage_client()
    manifest = json.loads(loc.read_private(storage, version["manifest_key"], 1024 * 1024))
    attempt = loc.attempt_directory(version["manifest_key"], job_id, original_key=original["manifest_key"] if original else None)
    with Image.open(frame) as image:
        size = image.size
    log("start", attempt=str(attempt), frame=size, sceneVersion=version["version"])
    with tempfile.TemporaryDirectory(prefix="alignment-diagnosis-") as temporary:
        path = Path(temporary) / "capture.jpg"
        path.write_bytes(Path(frame).read_bytes())
        started = time.monotonic()
        try:
            result = loc.register_image(attempt, path, manifest, size, Path(temporary), Lease())
            log("located", seconds=time.monotonic()-started, geometry=result["geometry"])
        except loc.LocalizationError as failure:
            log("failed", seconds=time.monotonic()-started, reason=str(failure))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
