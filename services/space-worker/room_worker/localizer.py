"""CPU-only registration of one camera image against an immutable room map.

The reconstruction volume is read-only. All feature/database work and pose
estimation happen in a disposable directory; no reference bundle adjustment
or reconstruction restart is performed.
"""
import collections
import datetime as dt
import io
import json
import logging
import math
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

import boto3
import numpy as np
import psycopg
import pycolmap
from botocore.config import Config
from PIL import Image
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .settings import BUCKET, DATABASE, SCRATCH

LOGGER = logging.getLogger("room-camera-localizer")
PAIR_BASE = 2147483647
THREADS = max(1, min(2, int(os.environ.get("ROOM_LOCALIZER_THREADS", "2"))))
MAX_FRAME_BYTES = 2 * 1024 * 1024


class LocalizationError(RuntimeError):
    """A safe, actionable error that may be shown to the camera owner."""


def connect():
    return psycopg.connect(DATABASE, row_factory=dict_row, connect_timeout=10)


def attempt_directory(manifest_key, job_id, scratch=SCRATCH, original_key=None):
    key = manifest_key
    match = re.fullmatch(r"outputs/([0-9a-fA-F-]{36})/([0-9a-fA-F-]{36})/[^/]+\.json", key)
    if not match and original_key:
        match = re.fullmatch(r"outputs/([0-9a-fA-F-]{36})/([0-9a-fA-F-]{36})/[^/]+\.json", original_key)
    if not match:
        raise LocalizationError("This room's original camera map cannot be identified. Reconstruct the room again or use manual floor matching.")
    try:
        room, attempt = str(uuid.UUID(match[1])), str(uuid.UUID(match[2]))
        if room != str(uuid.UUID(str(job_id))):
            raise ValueError("Wrong room")
    except ValueError as error:
        raise LocalizationError("This room's saved camera map is inconsistent. Use manual floor matching or reconstruct it again.") from error
    scratch = Path(scratch).resolve()
    result = (scratch / room / attempt).resolve()
    if not result.is_relative_to(scratch):
        raise LocalizationError("The room camera map is unavailable. Use manual floor matching.")
    return result


def metric_geometry(camera, pose, manifest, live_size, inliers, reprojection_error):
    transform = np.asarray(manifest.get("worldFromReconstruction", []), dtype=float)
    if transform.size != 16 or not np.isfinite(transform).all():
        raise LocalizationError("Save the room's scale and floor before aligning a camera.")
    transform = transform.reshape(4, 4, order="F")
    linear = transform[:3, :3]
    scale = math.sqrt(float(np.trace(linear.T @ linear)) / 3)
    if scale <= 1e-8 or not np.allclose(linear.T @ linear, np.eye(3) * scale * scale, rtol=1e-4, atol=1e-8) or np.linalg.det(linear) <= 0 or not np.allclose(transform[3], [0, 0, 0, 1], atol=1e-8):
        raise LocalizationError("The room scale and axes are invalid. Save its floor setup again.")
    camera_from_map = np.asarray(pose.matrix(), dtype=float)
    rotation = camera_from_map[:, :3]
    center_map = -rotation.T @ camera_from_map[:, 3]
    center = linear @ center_map + transform[:3, 3]
    world_from_camera = (linear / scale) @ rotation.T
    navigation = manifest.get("navigation", {})
    floor = float(navigation.get("floorY", 0))
    boundary = np.asarray(navigation.get("boundary", []), dtype=float)
    if not np.isfinite(center).all() or not .1 <= center[1] - floor <= 6 or boundary.ndim != 2 or boundary.shape[1:] != (2,) or len(boundary) < 3 or not np.isfinite(boundary).all():
        raise LocalizationError("The camera pose is not plausible above this room's floor. Show more room background and try aligning again.")
    if np.any(center[[0, 2]] < boundary.min(axis=0) - 3) or np.any(center[[0, 2]] > boundary.max(axis=0) + 3):
        raise LocalizationError("The matched camera is too far outside this room. Point it at the reconstructed room and retry.")
    if not np.allclose(world_from_camera.T @ world_from_camera, np.eye(3), atol=1e-5) or abs(np.linalg.det(world_from_camera) - 1) > 1e-5:
        raise LocalizationError("The camera orientation could not be validated. Show more room background and retry.")
    if str(camera.model).split(".")[-1] != "SIMPLE_RADIAL":
        raise LocalizationError("This camera lens model is unsupported. Use a normal camera view without a fisheye lens.")
    f, cx, cy, k1 = map(float, camera.params)
    if not all(math.isfinite(x) for x in (f, cx, cy, k1)) or not .2 * max(camera.width, camera.height) <= f <= 5 * max(camera.width, camera.height) or abs(k1) > 1:
        raise LocalizationError("The camera lens could not be estimated reliably. Remove digital zoom, show a wider room view and retry.")
    radius_squared = max((x - cx) ** 2 + (y - cy) ** 2 for x in (0, camera.width) for y in (0, camera.height)) / f ** 2
    if 1 + 3 * k1 * radius_squared < .15:
        raise LocalizationError("The lens estimate is unstable near the image edges. Use a standard camera view and retry.")
    sx, sy = live_size[0] / camera.width, live_size[1] / camera.height
    return {"center": dict(zip(("x", "y", "z"), map(float, center))),
            "worldFromCamera": world_from_camera.flatten().tolist(),
            "intrinsics": {"fx": f * sx, "fy": f * sy, "cx": cx * sx, "cy": cy * sy, "k1": k1, "k2": 0.},
            "source": "sfm", "inliers": int(inliers), "reprojectionErrorPx": float(reprojection_error)}


def floor_homography(geometry, floor_y, width, height):
    rotation = np.asarray(geometry["worldFromCamera"], dtype=float).reshape(3, 3).T
    center = np.array([geometry["center"][axis] for axis in ("x", "y", "z")])
    lens = geometry["intrinsics"]
    intrinsic = np.array([[lens["fx"], 0, lens["cx"]], [0, lens["fy"], lens["cy"]], [0, 0, 1]])
    # Floor coordinates are (X,Z). Lens distortion is undone before applying H.
    plane_to_pixels = intrinsic @ np.column_stack((rotation[:, 0], rotation[:, 2], rotation @ (np.array([0, floor_y, 0]) - center)))
    try:
        homography = np.linalg.inv(plane_to_pixels) @ np.diag([width, height, 1])
    except np.linalg.LinAlgError as error:
        raise LocalizationError("The camera lies on an unstable floor plane. Check the room floor and retry.") from error
    gauge = homography[2, 2] if abs(homography[2, 2]) > 1e-10 else np.max(np.abs(homography))
    homography /= gauge
    if not np.isfinite(homography).all() or abs(np.linalg.det(homography)) < 1e-12:
        raise LocalizationError("The camera floor projection is unstable. Check the room floor and retry.")
    return homography.flatten().tolist()


class AlignmentLease:
    def __init__(self, job):
        self.job = job
        remaining = (job["created_at"] + dt.timedelta(minutes=10) - dt.datetime.now(dt.timezone.utc)).total_seconds()
        self.deadline = time.monotonic() + max(0, remaining)
        self.stopped = threading.Event()
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.heartbeat, daemon=True)
        self.last_progress = 0.

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.done.set()
        self.thread.join(timeout=12)

    def check(self):
        if time.monotonic() >= self.deadline:
            raise LocalizationError("Automatic alignment timed out after ten minutes. Show more of the room background and retry.")
        if self.stopped.is_set():
            raise LocalizationError("Camera alignment was cancelled, or the room setup changed. Retry against the current saved room.")

    def heartbeat(self):
        while not self.done.is_set():
            try:
                with connect() as db:
                    updated = db.execute("""UPDATE room_camera_alignments SET lease_until=LEAST(now()+interval '120 seconds',created_at+interval '10 minutes')
                        WHERE id=%s AND lease_token=%s AND state='RUNNING' AND lease_until>now()
                        AND created_at>now()-interval '10 minutes' RETURNING id""", (self.job["id"], self.job["lease_token"])).fetchone()
                if not updated:
                    self.stopped.set()
                    return
            except Exception:
                self.stopped.set()
                return
            self.done.wait(15)

    def stage(self, name):
        self.check()
        now = int(time.time() * 1000)
        with connect() as db:
            updated = db.execute("""UPDATE room_camera_alignments SET stage=%s,progress=%s,updated_at=now()
                WHERE id=%s AND lease_token=%s AND state='RUNNING' AND lease_until>now()
                AND created_at>now()-interval '10 minutes' RETURNING id""", (name, Jsonb({"startedAt": now, "updatedAt": now}), self.job["id"], self.job["lease_token"])).fetchone()
        if not updated:
            self.stopped.set()
            self.check()

    def progress(self, completed, total, unit, activity, force=False):
        self.check()
        now = time.monotonic()
        if not force and now - self.last_progress < 1:
            return
        self.last_progress = now
        data = {"completed": completed, "total": total, "unit": unit, "activity": activity,
                "percent": round(100 * completed / total, 1) if total > 0 else None,
                "updatedAt": int(time.time() * 1000)}
        with connect() as db:
            updated = db.execute("""UPDATE room_camera_alignments SET progress=progress || %s,updated_at=now()
                WHERE id=%s AND lease_token=%s AND state='RUNNING' AND lease_until>now() RETURNING id""",
                (Jsonb(data), self.job["id"], self.job["lease_token"])).fetchone()
        if not updated:
            self.stopped.set()
            self.check()


def run_command(command, directory, lease, timeout, error, progress_path=None):
    lease.check()
    limit = min(lease.deadline, time.monotonic() + timeout)
    package_root = str(Path(__file__).resolve().parent.parent)
    environment = {**os.environ, "OMP_NUM_THREADS": str(THREADS), "OPENBLAS_NUM_THREADS": str(THREADS), "QT_QPA_PLATFORM": "offscreen",
                   "PYTHONPATH": package_root + os.pathsep + os.environ.get("PYTHONPATH", "")}
    with (directory / "private-command.log").open("ab") as output:
        process = subprocess.Popen([str(value) for value in command], cwd=directory, env=environment,
                                   stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        last_progress = None
        progress_stage = None
        try:
            while process.poll() is None:
                lease.check()
                if time.monotonic() >= limit:
                    raise LocalizationError(error)
                if progress_path and progress_path.is_file():
                    try:
                        progress = json.loads(progress_path.read_text())
                    except (OSError, ValueError):
                        progress = None
                    if progress and progress != last_progress:
                        stage = progress.get('stage', 'match_room')
                        if stage != progress_stage and stage in ('extract_features', 'match_room', 'estimate_pose', 'validate_pose'):
                            lease.stage(stage)
                            progress_stage = stage
                        lease.progress(progress['completed'], progress['total'], progress['unit'], progress['activity'], force=True)
                        last_progress = progress
                time.sleep(.25)
            if process.returncode:
                LOGGER.warning("Camera localization subprocess %s exited with code %s", Path(str(command[0])).name, process.returncode)
                raise LocalizationError(error)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=2)


def copy_reference_database(source_db, database, lease):
    """Published maps are immutable. Avoid WAL change detection on a read-only mount.

    A nonempty WAL is recovered from a private copy, never ignored or modified
    on the reconstruction volume.
    """
    wal = Path(str(source_db) + "-wal")
    source_path = source_db
    immutable = not wal.exists() or wal.stat().st_size == 0
    if not immutable:
        source_path = database.parent / "private-source.db"
        signatures = [(path, path.stat().st_size, path.stat().st_mtime_ns) for path in (source_db, wal)]
        for path, _, _ in signatures:
            lease.check()
            shutil.copyfile(path, source_path if path == source_db else Path(str(source_path) + "-wal"))
        if any(not path.exists() or (path.stat().st_size, path.stat().st_mtime_ns) != (size, modified) for path, size, modified in signatures):
            raise LocalizationError("The room reference database changed while loading. Wait for reconstruction to finish and retry.")
    uri = f"file:{source_path.as_posix()}?mode=ro&immutable=1" if immutable else str(source_path)
    started = time.monotonic()
    smallest_remaining, last_advance = float("inf"), started
    def progress(status, remaining, total):
        nonlocal smallest_remaining, last_advance
        lease.check()
        # Python 3.10 does not expose all SQLite result-code names.
        if status not in (0, 101, 5, 6):  # OK, DONE, BUSY, LOCKED
            raise LocalizationError("The room reference database cannot be read. Retry automatic alignment.")
        if remaining < smallest_remaining:
            smallest_remaining, last_advance = remaining, time.monotonic()
        if time.monotonic() - last_advance > 10 or time.monotonic() - started > 60:
            raise LocalizationError("Loading room references stalled. Retry alignment after checking room storage.")
        if total:
            lease.progress(total - remaining, total, "database pages", "Loading room reference database", force=status == 101)
    with sqlite3.connect(uri, uri=immutable) as source, sqlite3.connect(database) as target:
        source.backup(target, pages=512, progress=progress)


def copy_reference(attempt, temporary, lease):
    dataset = attempt / "dataset"
    source_db, source_model = dataset / "colmap/database.db", dataset / "colmap/sparse/0"
    if not source_db.is_file() or not all((source_model / name).is_file() for name in ("cameras.bin", "images.bin", "points3D.bin")):
        raise LocalizationError("The original room camera map is no longer available. Use manual floor matching, or reconstruct the room again.")
    database, model = temporary / "database.db", temporary / "reference"
    copy_reference_database(source_db, database, lease)
    model.mkdir()
    for name in ("cameras.bin", "images.bin", "points3D.bin"):
        lease.check()
        shutil.copyfile(source_model / name, model / name)
    reconstruction = pycolmap.Reconstruction(str(model))
    if len(reconstruction.images) < 3 or len(reconstruction.points3D) < 100:
        raise LocalizationError("This room does not retain enough stable background features. Use manual floor matching or a better room capture.")
    with sqlite3.connect(database) as db:
        images = {row[1]: row[0] for row in db.execute("SELECT image_id,name FROM images")}
    if any(images.get(image.name) != image.image_id for image in reconstruction.images.values()):
        raise LocalizationError("The saved room feature database and camera map disagree. Use manual matching or reconstruct the room again.")
    return database, reconstruction


def correspondences(database, reconstruction, query_name, *, table='two_view_geometries', minimum=30):
    if table not in ('two_view_geometries', 'matches'):
        raise ValueError('Unsupported correspondence evidence table')
    with sqlite3.connect(database) as db:
        row = db.execute("SELECT image_id FROM images WHERE name=?", (query_name,)).fetchone()
        if not row:
            raise LocalizationError("No useful camera features were extracted. Include textured room walls or furniture and retry.")
        query_id = row[0]
        row = db.execute("SELECT rows,cols,data FROM keypoints WHERE image_id=?", (query_id,)).fetchone()
        if not row or row[0] < 30:
            raise LocalizationError("Too few camera background features are visible. Show more textured room surfaces and retry.")
        keypoints = np.frombuffer(row[2], np.float32).reshape(row[0], row[1])[:, :2].astype(float)
        votes = collections.defaultdict(collections.Counter)
        for reference in reconstruction.images.values():
            pair = min(query_id, reference.image_id) * PAIR_BASE + max(query_id, reference.image_id)
            geometry = db.execute(f"SELECT rows,cols,data FROM {table} WHERE pair_id=?", (pair,)).fetchone()
            if not geometry or not geometry[0] or geometry[1] != 2:
                continue
            matches = np.frombuffer(geometry[2], np.uint32).reshape(geometry[0], 2)
            if query_id > reference.image_id:
                matches = matches[:, ::-1]
            for query_index, reference_index in matches:
                if query_index >= len(keypoints) or reference_index >= len(reference.points2D):
                    continue
                point = reference.points2D[int(reference_index)]
                if point.has_point3D() and point.point3D_id in reconstruction.points3D:
                    votes[int(query_index)][int(point.point3D_id)] += 1
    candidates = []
    for query_index, counts in votes.items():
        ranked = counts.most_common(2)
        if len(ranked) == 1 or ranked[0][1] > ranked[1][1]:
            candidates.append((ranked[0][1], query_index, ranked[0][0]))
    used_points, image_points, room_points = set(), [], []
    for _, query_index, point_id in sorted(candidates, reverse=True):
        if point_id in used_points:
            continue
        used_points.add(point_id)
        image_points.append(keypoints[query_index])
        room_points.append(reconstruction.points3D[point_id].xyz)
    if len(image_points) < minimum:
        raise LocalizationError(f"This camera view matched only {len(image_points)} reconstructed background landmarks; at least 30 are needed. Leave the camera fixed, step out of its view, show the same static walls or furniture as the room capture, and retry.")
    return np.asarray(image_points).reshape(-1, 2), np.asarray(room_points).reshape(-1, 3)


def solve_pose(input_path, output_path):
    """Runs as a bounded child process so C++ RANSAC cannot outlive its lease."""
    data = np.load(input_path, allow_pickle=False)
    width, height = map(int, data["size"])
    camera = pycolmap.Camera(model="SIMPLE_RADIAL", width=width, height=height,
                            params=[float(data["focal"]), width / 2, height / 2, 0.])
    estimation = pycolmap.AbsolutePoseEstimationOptions()
    estimation.estimate_focal_length = True
    estimation.ransac.max_error = min(4., float(data["max_error"]))
    estimation.ransac.max_num_trials = 5000
    estimation.ransac.min_inlier_ratio = .2
    refinement = pycolmap.AbsolutePoseRefinementOptions()
    refinement.refine_focal_length = True
    refinement.refine_extra_params = True
    refinement.max_num_iterations = 80
    result = pycolmap.estimate_and_refine_absolute_pose(data["image_points"], data["room_points"], camera, estimation, refinement)
    if result is None:
        raise LocalizationError("The room matches did not produce a camera pose. Show a wider static room view and retry.")
    pose = result["cam_from_world"]
    inliers = np.asarray(result["inlier_mask"], dtype=bool)
    camera_points = (np.asarray(pose.matrix())[:, :3] @ data["room_points"][inliers].T).T + np.asarray(pose.matrix())[:, 3]
    if np.any(camera_points[:, 2] <= 0):
        raise LocalizationError("The matched room features fall behind the camera. Try a clearer room view.")
    projected = np.asarray(camera.img_from_cam(camera_points))
    errors = np.linalg.norm(projected - data["image_points"][inliers], axis=1)
    output = {"pose": np.asarray(pose.matrix()).tolist(), "params": camera.params.tolist(),
              "inliers": inliers.tolist(), "errors": errors.tolist()}
    Path(output_path).write_text(json.dumps(output))


def rank_reference_names(database, reconstruction, query_name):
    """Cheap coarse SIFT retrieval changes ordering, never pose acceptance.

    One descriptor array is streamed at a time from the private database.
    Missing/degenerate evidence keeps every reference in a stable fallback;
    the full matching path therefore never loses room coverage.
    """
    references = sorted(reconstruction.images.items(), key=lambda item: (item[1].name, item[0]))
    fallback = [image.name for _, image in references]

    def summary(row):
        if not row or row[0] <= 0 or row[1] != 128 or row[2] is None or len(row[2]) != row[0] * row[1]:
            return None
        descriptors = np.frombuffer(row[2], np.uint8).reshape(row[0], row[1])
        pooled = descriptors.mean(axis=0, dtype=np.float64)
        length = float(np.linalg.norm(pooled))
        return pooled / length if length > 1e-8 else None

    try:
        with sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True) as db:
            row = db.execute("SELECT image_id FROM images WHERE name=?", (query_name,)).fetchone()
            if not row:
                return fallback
            query = summary(db.execute("SELECT rows,cols,data FROM descriptors WHERE image_id=?", (row[0],)).fetchone())
            if query is None:
                return fallback
            scores = []
            for image_id, image in references:
                descriptor = summary(db.execute("SELECT rows,cols,data FROM descriptors WHERE image_id=?", (image_id,)).fetchone())
                score = float(query @ descriptor) if descriptor is not None else -float("inf")
                scores.append((-score, image.name, image_id))
        return [name for _, name, _ in sorted(scores)]
    except sqlite3.Error:
        return fallback


def validated_registration(result, image_points, manifest, size, live_size, strong=False):
    """Apply identical spatial/metric gates to early and full-search poses.

    Early exit needs substantially stronger support than a final best-effort
    result. A small repeated patch never becomes acceptable just by matching
    many descriptors.
    """
    width, height = size
    scaling = max(live_size[0] / width, live_size[1] / height)
    mask = np.asarray(result["inliers"], dtype=bool)
    errors = np.asarray(result["errors"], dtype=float)
    count = int(mask.sum())
    rms = float(np.sqrt(np.mean(errors ** 2))) * scaling if count else float("inf")
    minimum_count, minimum_ratio, maximum_rms = (100, .35, 3.) if strong else (30, .2, 5.)
    if count < minimum_count or count / len(mask) < minimum_ratio or not math.isfinite(rms) or rms > maximum_rms:
        raise LocalizationError("Too few consistent room matches validate this camera. Include more static background, improve lighting and retry.")
    normalized = image_points[mask] / [width, height]
    # Four occupied cells alone are insufficient; evidence needs a broad 2D
    # span and covariance, not a narrow foreground object or repeated strip.
    covariance = np.linalg.eigvalsh(np.cov(normalized.T))
    cells = {tuple(np.minimum(3, np.floor(point * 4)).astype(int)) for point in normalized}
    if np.ptp(normalized[:, 0]) < .2 or np.ptp(normalized[:, 1]) < .15 or len(cells) < 4 or covariance[0] < .002:
        raise LocalizationError("Room matches cover too small an image area. Show more walls or furniture across the camera frame and retry.")
    matrix = np.asarray(result["pose"], dtype=float)
    pose = pycolmap.Rigid3d(pycolmap.Rotation3d(matrix[:, :3]), matrix[:, 3])
    camera = pycolmap.Camera(model="SIMPLE_RADIAL", width=width, height=height, params=result["params"])
    geometry = metric_geometry(camera, pose, manifest, live_size, count, rms)
    return {"geometry": geometry, "homography": floor_homography(geometry, float(manifest["navigation"]["floorY"]), *live_size),
            "points": [], "fitErrorMeters": 0.}


def estimate_registration(database, reconstruction, query_name, manifest, size, live_size, temporary, lease, timeout=75, strong=False):
    image_points, room_points = correspondences(database, reconstruction, query_name)
    if strong and len(image_points) < 100:
        raise LocalizationError("More room matches are needed before early camera validation.")
    lease.stage("estimate_pose")
    width, height = size
    focal = float(np.median([camera.calibration_matrix()[0, 0] / max(camera.width, camera.height)
                            for camera in reconstruction.cameras.values()])) * max(width, height)
    scaling = max(live_size[0] / width, live_size[1] / height)
    np.savez(temporary / "pose-input.npz", image_points=image_points, room_points=room_points,
             size=[width, height], focal=focal, max_error=min(4., 5 / scaling))
    run_command([sys.executable, "-m", "room_worker.localizer", "--solve-pose", temporary / "pose-input.npz", temporary / "pose-result.json"],
                temporary, lease, timeout, "The camera pose could not be estimated reliably. Show a wider room view and retry.")
    lease.stage("validate_pose")
    result = json.loads((temporary / "pose-result.json").read_text())
    return validated_registration(result, image_points, manifest, size, live_size, strong=strong)


def register_image(attempt, image_path, manifest, live_size, temporary, lease):
    lease.stage("load_room_map")
    database, reconstruction = copy_reference(attempt, temporary, lease)
    with Image.open(image_path) as frame:
        width, height = frame.size
        if frame.format != "JPEG" or max(width, height) > 1280 or min(width, height) < 32:
            raise LocalizationError("Submit a valid camera JPEG up to 1280 pixels per side.")
        if abs(width / height - live_size[0] / live_size[1]) > 2 / height:
            raise LocalizationError("The camera frame crop changed. Restart the camera and align its current full frame.")
        frame.load()
    query_name = "alignment-query.jpg"
    images = temporary / "images"
    images.mkdir()
    shutil.copyfile(image_path, images / query_name)
    (temporary / "query-list.txt").write_text(query_name + "\n")
    reference_names = [image.name for image in reconstruction.images.values()]
    if any(re.search(r"\s", name) for name in reference_names):
        raise LocalizationError("The room feature names cannot be matched automatically. Use manual floor matching.")
    lease.stage("extract_features")
    run_command(["colmap", "feature_extractor", "--database_path", database, "--image_path", images,
                 "--image_list_path", temporary / "query-list.txt", "--ImageReader.camera_model", "SIMPLE_RADIAL",
                 "--SiftExtraction.use_gpu", "0", "--SiftExtraction.num_threads", THREADS,
                 "--SiftExtraction.max_image_size", "1280", "--SiftExtraction.max_num_features", "4096"],
                temporary, lease, 100, "Camera feature extraction could not complete. Show a clearer room view and retry.")
    reference_names = rank_reference_names(database, reconstruction, query_name)
    lease.stage("match_room")
    # COLMAP 3.9 imports the entire list as one opaque block. Small explicit
    # batches expose actual completed work without guessing from elapsed time.
    match_deadline = min(lease.deadline, time.monotonic() + 360)
    # Check after 4, 16, 48, 112, 240, ... views: a useful early opportunity,
    # without launching the CPU pose solver after every small batch. Failed
    # attempts share the matching deadline and each gets at most 15 seconds.
    next_pose_check = 4
    lease.progress(0, len(reference_names), "reference views checked", "Comparing camera background with room viewpoints", force=True)
    # A small initial batch can already contain the nearest useful views.
    # Follow it with the rest of the first 16, then unchanged 16-view batches.
    for start in [0, 4] + list(range(16, len(reference_names), 16)):
        if start >= len(reference_names):
            continue
        batch_size = 4 if start == 0 else 12 if start == 4 else 16
        batch = reference_names[start:start + batch_size]
        (temporary / "pairs.txt").write_text("".join(f"{query_name} {name}\n" for name in batch))
        remaining = match_deadline - time.monotonic()
        if remaining <= 0:
            raise LocalizationError("Room matching took too long. Show more recognizable room background and retry.")
        run_command(["colmap", "matches_importer", "--database_path", database, "--match_list_path", temporary / "pairs.txt",
                     # COLMAP 3.9 CPU guided matching uses several dense N*M
                     # matrices and does not cap them via max_num_matches.
                     # One worker prevents simultaneous large reference pairs
                     # from multiplying the localizer's peak host memory.
                     "--match_type", "pairs", "--SiftMatching.use_gpu", "0", "--SiftMatching.num_threads", "1",
                     "--SiftMatching.guided_matching", "1", "--SiftMatching.max_num_matches", "8192"],
                    temporary, lease, remaining, "Room matching could not complete. Include more recognizable room background and retry.")
        checked = start + len(batch)
        lease.progress(checked, len(reference_names), "reference views checked", "Comparing camera background with room viewpoints", force=True)
        if checked >= next_pose_check and checked < len(reference_names):
            next_pose_check = 16 if checked == 4 else checked * 2 + 16
            if match_deadline - time.monotonic() >= 35:
                try:
                    result = estimate_registration(database, reconstruction, query_name, manifest, (width, height), live_size,
                                                   temporary, lease, timeout=15, strong=True)
                except LocalizationError:
                    # Cancellation/expiry must still stop promptly. A failed
                    # geometric hypothesis simply needs additional room views.
                    lease.check()
                    lease.stage("match_room")
                    lease.progress(checked, len(reference_names), "reference views checked",
                                   "Checking more room views for a reliable camera pose", force=True)
                else:
                    lease.progress(checked, len(reference_names), "reference views checked",
                                   "Sufficient room matches validated the camera; remaining views were not needed", force=True)
                    return result
    try:
        return estimate_registration(database, reconstruction, query_name, manifest, (width, height), live_size, temporary, lease)
    except LocalizationError:
        lease.check()
        # A webcam and a capture phone can see the same room yet share too few
        # classic SIFT corners. Recover additional independent static 3D points
        # from fixed source cameras, never relax the public pose acceptance.
        lease.stage('match_room')
        config = {'attempt': str(attempt), 'reference': str(temporary / 'reference'),
                  'database': str(database), 'query': str(images / query_name), 'queryName': query_name,
                  'manifest': manifest, 'size': [width, height], 'liveSize': list(live_size)}
        (temporary / 'learned-input.json').write_text(json.dumps(config))
        run_command([sys.executable, '-m', 'room_worker.learned_localizer', temporary / 'learned-input.json',
                     temporary / 'learned-result.json', temporary / 'learned-progress.json'],
                    temporary, lease, min(240, max(1, lease.deadline-time.monotonic())),
                    'Additional room background matching could not validate this camera. Keep the camera fixed, improve lighting and retry with more static background.',
                    progress_path=temporary / 'learned-progress.json')
        result = json.loads((temporary / 'learned-result.json').read_text())
        lease.stage('validate_pose')
        return validated_registration(result['pose'], np.asarray(result['imagePoints']), manifest, (width, height), live_size)


def storage_client():
    return boto3.client("s3", endpoint_url=os.environ.get("ROOM_S3_ENDPOINT", "http://room-storage:9000"),
                        aws_access_key_id=os.environ.get("ROOM_S3_ACCESS_KEY", "rooms-local"),
                        aws_secret_access_key=os.environ.get("ROOM_S3_SECRET_KEY", "rooms-local-secret"), region_name="us-east-1",
                        config=Config(signature_version="s3v4", connect_timeout=10, read_timeout=20, retries={"max_attempts": 2}, s3={"addressing_style": "path"}))


def read_private(storage, key, limit):
    response = storage.get_object(Bucket=BUCKET, Key=key)
    try:
        if response.get("ContentLength", limit + 1) > limit:
            raise LocalizationError("The submitted alignment frame is too large. Restart the camera and retry.")
        value = response["Body"].read(limit + 1)
    finally:
        response["Body"].close()
    if len(value) > limit:
        raise LocalizationError("The submitted alignment frame is too large. Restart the camera and retry.")
    return value


def remove_frame(storage, alignment):
    try:
        storage.delete_object(Bucket=BUCKET, Key=alignment["frame_key"])
        with connect() as db:
            db.execute("UPDATE room_camera_alignments SET frame_deleted_at=now() WHERE id=%s AND frame_deleted_at IS NULL", (alignment["id"],))
    except Exception:
        LOGGER.warning("Temporary alignment frame cleanup will be retried")


def expire_and_clean(storage):
    with connect() as db:
        db.execute("""UPDATE room_camera_alignments SET state='FAILED',stage='failed',
            error=CASE WHEN created_at<=now()-interval '10 minutes' THEN 'Automatic alignment expired after ten minutes. Retry with a wider room view.'
            ELSE 'The camera alignment worker was interrupted. Retry automatic alignment.' END,
            lease_token=NULL,lease_until=NULL,result=NULL,updated_at=now()
            WHERE (state IN ('QUEUED','RUNNING','READY') AND created_at<=now()-interval '10 minutes')
               OR (state='RUNNING' AND (lease_until IS NULL OR lease_until<=now()))""")
        frames = db.execute("""SELECT id,frame_key FROM room_camera_alignments
            WHERE state IN ('READY','FAILED','CANCELLED','APPLIED') AND frame_deleted_at IS NULL
            ORDER BY updated_at LIMIT 100""").fetchall()
    for alignment in frames:
        remove_frame(storage, alignment)


def claim():
    with connect() as db:
        job = db.execute("""SELECT * FROM room_camera_alignments WHERE state='QUEUED'
            AND created_at>now()-interval '10 minutes' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED""").fetchone()
        if not job:
            return None
        token = uuid.uuid4()
        db.execute("""UPDATE room_camera_alignments SET state='RUNNING',stage='load_room_map',error=NULL,
            lease_token=%s,lease_until=LEAST(now()+interval '120 seconds',created_at+interval '10 minutes'),updated_at=now() WHERE id=%s""", (token, job["id"]))
        job["lease_token"] = token
        return job


def process_alignment(storage, job, lease):
    with connect() as db:
        version = db.execute("SELECT version,ready,manifest_key FROM room_versions WHERE job_id=%s ORDER BY version DESC LIMIT 1", (job["job_id"],)).fetchone()
        original = db.execute("SELECT manifest_key FROM room_versions WHERE job_id=%s AND version=1", (job["job_id"],)).fetchone()
    if not version or not version["ready"] or version["version"] != job["scene_version"] or version["manifest_key"] != job["manifest_key"]:
        raise LocalizationError("The saved room setup changed. Open the current room and align the camera again.")
    manifest = json.loads(read_private(storage, job["manifest_key"], 1024 * 1024))
    if not manifest.get("ready") or manifest.get("version") != job["scene_version"] or manifest.get("units") != "meters":
        raise LocalizationError("Save the room scale, floor and walking area before aligning its camera.")
    attempt = attempt_directory(job["manifest_key"], job["job_id"], original_key=original["manifest_key"] if original else None)
    image = read_private(storage, job["frame_key"], MAX_FRAME_BYTES)
    with tempfile.TemporaryDirectory(prefix="room-camera-alignment-") as temporary:
        temporary = Path(temporary)
        image_path = temporary / "capture.jpg"
        image_path.write_bytes(image)
        result = register_image(attempt, image_path, manifest, (job["image_width"], job["image_height"]), temporary, lease)
    lease.check()
    with connect() as db:
        updated = db.execute("""UPDATE room_camera_alignments a SET state='READY',stage='complete',result=%s,
            error=NULL,lease_token=NULL,lease_until=NULL,updated_at=now()
            WHERE a.id=%s AND a.lease_token=%s AND a.state='RUNNING' AND a.lease_until>now()
            AND a.created_at>now()-interval '10 minutes'
            AND EXISTS (SELECT 1 FROM room_versions v WHERE v.job_id=a.job_id AND v.version=a.scene_version AND v.ready
                AND v.manifest_key=a.manifest_key AND v.version=(SELECT max(version) FROM room_versions WHERE job_id=a.job_id))
            RETURNING a.id""", (Jsonb(result), job["id"], job["lease_token"])).fetchone()
    if not updated:
        raise LocalizationError("Alignment was cancelled or the room changed before the result was saved. Retry using the current room.")


def fail(job, message):
    with connect() as db:
        db.execute("""UPDATE room_camera_alignments SET state='FAILED',stage='failed',error=%s,result=NULL,
            lease_token=NULL,lease_until=NULL,updated_at=now()
            WHERE id=%s AND lease_token=%s AND state='RUNNING'""", (message[:1000], job["id"], job["lease_token"]))


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not shutil.which("colmap"):
        raise RuntimeError("Camera localizer requires COLMAP in the worker image")
    storage = storage_client()
    LOGGER.info("CPU camera localizer ready (%s threads)", THREADS)
    while True:
        job = None
        try:
            expire_and_clean(storage)
            job = claim()
            if job is None:
                time.sleep(3)
                continue
            with AlignmentLease(job) as lease:
                process_alignment(storage, job, lease)
            LOGGER.info("Camera alignment completed")
        except Exception as error:
            if isinstance(error, LocalizationError):
                LOGGER.warning("Camera alignment stopped: %s", error)
            else:
                LOGGER.warning("Camera alignment stopped (%s)", type(error).__name__)
            if job:
                message = str(error) if isinstance(error, LocalizationError) else "Automatic alignment could not complete. Show more static room background and retry; use manual floor matching if its camera map is unavailable."
                try:
                    fail(job, message)
                except Exception:
                    LOGGER.warning("Alignment failure will be recovered after its lease expires")
            time.sleep(3)
        finally:
            if job:
                remove_frame(storage, job)


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--solve-pose":
        solve_pose(sys.argv[2], sys.argv[3])
    else:
        main()
