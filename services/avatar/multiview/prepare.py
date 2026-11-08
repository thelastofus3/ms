"""Stage 3a: nerfstudio dataset for the person only.

RGBA images (alpha = soft person mask) + per-view OPENCV intrinsics from COLMAP + a coloured
visual-hull surface point cloud as initialisation. Held-out views are listed in the report and
excluded from transforms.json (`--eval` writes them to transforms-eval.json instead).
"""
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np
import pycolmap

from progress import report as progress

WORK = Path(os.environ.get("AVATAR_WORK", "/work"))


def frame(image, camera, path):
    world_from_camera = np.linalg.inv(np.vstack([np.asarray(image.cam_from_world.matrix()), [0, 0, 0, 1]]))
    # OpenCV (x right, y down, z forward) → OpenGL/nerfstudio (x right, y up, z backward).
    world_from_camera[:3, 1:3] *= -1
    f, cx, cy, k1 = camera.params
    return {"file_path": path, "transform_matrix": world_from_camera.tolist(), "fl_x": f, "fl_y": f, "cx": cx, "cy": cy,
            "w": camera.width, "h": camera.height, "k1": k1, "k2": 0., "p1": 0., "p2": 0., "camera_model": "OPENCV"}


def surface_points(model, hull, images):
    points, voxel = hull["points"], float(hull["voxel"])
    keys = np.round((points - points.min(0)) / voxel).astype(int)
    occupied = {tuple(k) for k in keys}
    neighbours = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
    surface = points[[any((k[0] + a, k[1] + b, k[2] + c) not in occupied for a, b, c in neighbours) for k in keys]]
    colours, counts = np.zeros((len(surface), 3)), np.zeros(len(surface))
    for image in model.images.values():
        camera, picture = model.cameras[image.camera_id], images[image.name]
        mask = cv2.imread(str(WORK / "masks" / (Path(image.name).stem + ".png")), cv2.IMREAD_GRAYSCALE) > 0
        matrix = np.asarray(image.cam_from_world.matrix())
        local = surface @ matrix[:, :3].T + matrix[:, 3]
        pixels = camera.img_from_cam(local)
        x, y = np.round(pixels[:, 0]).astype(int), np.round(pixels[:, 1]).astype(int)
        keep = (local[:, 2] > 0) & (x >= 0) & (y >= 0) & (x < camera.width) & (y < camera.height)
        keep[keep] &= mask[y[keep], x[keep]]
        # Points facing away are occluded, but an average over many views is a fine initial colour.
        colours[keep] += picture[y[keep], x[keep], ::-1]
        counts[keep] += 1
    colours = np.where(counts[:, None] > 0, colours / np.maximum(counts, 1)[:, None], 128)
    return surface, colours.astype(np.uint8)


def write_ply(path, points, colours):
    header = ("ply\nformat ascii 1.0\nelement vertex %d\nproperty float x\nproperty float y\nproperty float z\n"
              "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n" % len(points))
    body = "\n".join(f"{p[0]:.6f} {p[1]:.6f} {p[2]:.6f} {c[0]} {c[1]} {c[2]}" for p, c in zip(points, colours))
    path.write_text(header + body + "\n")


def main():
    model = pycolmap.Reconstruction(str(next((WORK / "colmap/sparse").iterdir())))
    dataset = WORK / "dataset"; (dataset / "images").mkdir(parents=True, exist_ok=True)
    pictures, train, evaluation = {}, [], []
    names = sorted(image.name for image in model.images.values())
    # Every 8th view is held out for an honest quality score once there are enough views to spare.
    holdout = set(names[::8]) if len(names) >= 16 else set()
    for image in sorted(model.images.values(), key=lambda i: i.name):
        picture = cv2.imread(str(WORK / "images" / image.name))
        alpha = cv2.imread(str(WORK / "masks" / (Path(image.name).stem + ".alpha.png")), cv2.IMREAD_GRAYSCALE)
        hard = cv2.imread(str(WORK / "masks" / (Path(image.name).stem + ".png")), cv2.IMREAD_GRAYSCALE)
        # Soft edges only where the hard (component-filtered) mask is, so tripods never leak in.
        alpha = np.where(cv2.dilate(hard, np.ones((7, 7), np.uint8)) > 0, alpha, 0).astype(np.uint8)
        name = f"images/{Path(image.name).stem}.png"
        cv2.imwrite(str(dataset / name), np.dstack([picture, alpha]))
        pictures[image.name] = picture
        (evaluation if image.name in holdout else train).append(frame(image, model.cameras[image.camera_id], name))
    hull = np.load(WORK / "hull.npz")
    surface, colours = surface_points(model, hull, pictures)
    write_ply(dataset / "hull.ply", surface, colours)
    for name, frames in (("transforms.json", train), ("transforms-eval.json", evaluation)):
        (dataset / name).write_text(json.dumps({"frames": frames, "ply_file_path": "hull.ply"}, indent=1))
    print(json.dumps({"train": len(train), "eval": [f["file_path"] for f in evaluation], "initPoints": len(surface)}))
    progress(1.0, f"{len(train)} training views, {len(evaluation)} held out, {len(surface):,} starting points")


if __name__ == "__main__":
    main(*sys.argv[1:])
