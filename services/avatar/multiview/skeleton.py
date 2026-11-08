"""Stage 4: 3D body landmarks from MediaPipe Pose in every view, triangulated with the COLMAP cameras.

No body model (SMPL) is used. Left/right swaps, which MediaPipe makes on back views, are resolved per view
against a first triangulation. Output: AVATAR_WORK/skeleton.json (COLMAP world coordinates + quality).
"""
import json
import os
import sys
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
import pycolmap

from progress import report as progress

WORK = Path(os.environ.get("AVATAR_WORK", "/work"))
# MediaPipe pose landmark pairs that swap when the person is seen from behind.
SWAP = {i: j for a, b in [(1, 4), (2, 5), (3, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16), (17, 18), (19, 20),
                          (21, 22), (23, 24), (25, 26), (27, 28), (29, 30), (31, 32)] for i, j in ((a, b), (b, a))}


def detect(model, image, mask):
    """Run pose on a padded crop around the person mask; return 33×(x, y, visibility) in full-image pixels."""
    ys, xs = np.nonzero(mask)
    h, w = mask.shape
    pad = int(0.15 * (ys.max() - ys.min()))
    x0, y0, x1, y1 = max(0, xs.min() - pad), max(0, ys.min() - pad), min(w, xs.max() + pad), min(h, ys.max() + pad)
    crop = cv2.cvtColor(image[y0:y1, x0:x1], cv2.COLOR_BGR2RGB)
    result = model.process(crop)
    if not result.pose_landmarks:
        return None
    return np.array([[x0 + p.x * (x1 - x0), y0 + p.y * (y1 - y0), p.visibility] for p in result.pose_landmarks.landmark])


def triangulate(observations):
    """Linear (DLT) triangulation from (normalized point, 3×4 camera-from-world) pairs."""
    rows = []
    for (x, y), matrix in observations:
        rows += [x * matrix[2] - matrix[0], y * matrix[2] - matrix[1]]
    point = np.linalg.svd(np.asarray(rows))[2][-1]
    return point[:3] / point[3] if abs(point[3]) > 1e-12 else None


def reprojection(view, point):
    local = view["matrix"][:, :3] @ point + view["matrix"][:, 3]
    if local[2] <= 0:
        return np.inf
    return float(np.linalg.norm(view["camera"].img_from_cam(local[None])[0] - view["pixel"]))


def robust_point(views, threshold):
    """RANSAC over view pairs, then refit on inliers."""
    best = []
    for a in range(len(views)):
        for b in range(a + 1, len(views)):
            point = triangulate([(views[i]["normalized"], views[i]["matrix"]) for i in (a, b)])
            if point is None:
                continue
            inliers = [i for i, view in enumerate(views) if reprojection(view, point) < threshold]
            if len(inliers) > len(best):
                best = inliers
    if len(best) < 3:
        return None, [], np.inf
    point = triangulate([(views[i]["normalized"], views[i]["matrix"]) for i in best])
    errors = [reprojection(views[i], point) for i in best]
    return point, best, float(np.median(errors))


def main():
    model = pycolmap.Reconstruction(str(next((WORK / "colmap/sparse").iterdir())))
    pose = mp.solutions.pose.Pose(static_image_mode=True, model_complexity=2, enable_segmentation=False)
    detections, cameras = {}, {}
    images = sorted(model.images.values(), key=lambda image: image.name)
    for index, image in enumerate(images):
        picture = cv2.imread(str(WORK / "images" / image.name))
        mask = cv2.imread(str(WORK / "masks" / (Path(image.name).stem + ".png")), cv2.IMREAD_GRAYSCALE) > 0
        found = detect(pose, picture, mask)
        if found is not None:
            detections[image.name] = found
            cameras[image.name] = (model.cameras[image.camera_id], np.asarray(image.cam_from_world.matrix()))
        progress(0.8 * (index + 1) / len(images), f"Body landmarks found in {len(detections)}/{index + 1} photos")
    if len(detections) < 6:
        print("ERROR The body pose could not be detected in enough photos. Show the whole body in every photo.", flush=True)
        sys.exit(1)
    # Pixel tolerance scales with the person's size in the images.
    height = np.median([d[:, 1].max() - d[:, 1].min() for d in detections.values()])
    threshold = max(6.0, 0.02 * height)

    def solve(swapped):
        points, quality = {}, {}
        for landmark in range(33):
            views = []
            for name, found in detections.items():
                index = SWAP.get(landmark, landmark) if swapped.get(name) else landmark
                x, y, visibility = found[index]
                if visibility < 0.5:
                    continue
                camera, matrix = cameras[name]
                views.append({"name": name, "pixel": np.array([x, y]), "camera": camera, "matrix": matrix,
                              "normalized": camera.cam_from_img(np.array([[x, y]]))[0]})
            point, inliers, error = robust_point(views, threshold) if len(views) >= 3 else (None, [], np.inf)
            if point is not None:
                points[landmark] = point
                quality[landmark] = {"views": len(views), "inliers": len(inliers), "medianErrorPx": error}
        return points, quality

    swapped = {}
    points, quality = solve(swapped)
    progress(0.85, "Resolving left/right in back views")
    # A view is swapped if mirrored left/right labels reproject better onto the first 3D estimate.
    for name, found in detections.items():
        camera, matrix = cameras[name]
        view = lambda pixel: {"pixel": pixel, "camera": camera, "matrix": matrix}
        direct = mirrored = 0.
        for landmark in SWAP:
            if landmark in points and found[landmark][2] >= 0.5:
                direct += min(reprojection(view(found[landmark][:2]), points[landmark]), 100)
                mirrored += min(reprojection(view(found[SWAP[landmark]][:2]), points[landmark]), 100)
        swapped[name] = mirrored < 0.7 * direct
    points, quality = solve(swapped)
    required = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
    missing = [i for i in required if i not in points]
    if missing:
        print(f"ERROR Key body points could not be located in 3D (MediaPipe landmarks {missing}). "
              "Show the whole body, including hands and feet, from all sides.", flush=True)
        sys.exit(1)
    errors = [q["medianErrorPx"] for q in quality.values()]
    report = {"landmarks": {str(k): v.tolist() for k, v in points.items()}, "quality": {str(k): v for k, v in quality.items()},
              "detectedViews": len(detections), "swappedViews": sorted(n for n, s in swapped.items() if s),
              "thresholdPx": threshold, "medianErrorPx": float(np.median(errors))}
    (WORK / "skeleton.json").write_text(json.dumps(report, indent=1))
    print(json.dumps({k: v for k, v in report.items() if k not in ("landmarks", "quality")}, indent=1))
    progress(1.0, f"{len(points)}/33 body points in 3D from {len(detections)} photos, median error {report['medianErrorPx']:.1f} px "
             f"({len(report['swappedViews'])} back views relabelled)", points=len(points), medianErrorPx=round(report["medianErrorPx"], 2))


if __name__ == "__main__":
    main()
