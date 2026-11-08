"""Stage 2: person masks per view (BiRefNet via rembg) + visual-hull consistency check.

  docker run --rm --gpus all -v <repo>/.runtime/avatar-multiview:/work -v <repo>/.runtime/models:/models \
    -v <repo>/services/avatar/multiview:/code:ro avatar-multiview /code/masks.py
Outputs: /work/masks/<view>.png (255 = person), /work/hull.npz, /work/masks-report.json, /work/masks-sheet.jpg
"""
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np
import pycolmap
from PIL import Image
from rembg import new_session, remove

from progress import report as progress

WORK = Path(os.environ.get("AVATAR_WORK", "/work"))


def largest_person(alpha, threshold=128):
    binary = (alpha >= threshold).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    if count <= 1:
        return np.zeros_like(binary)
    h, w = binary.shape
    # The subject stands near the image centre; tripods/lamps are thin and off-centre.
    centre = np.array([w / 2, h / 2])
    def score(i):
        x, y, bw, bh, area = stats[i]
        offset = np.linalg.norm(np.array([x + bw / 2, y + bh / 2]) - centre) / w
        return area * (1 - min(offset, 0.9))
    best = max(range(1, count), key=score)
    mask = (labels == best).astype(np.uint8)
    # Fill interior holes (e.g. between arm and torso stays open because it touches background).
    filled = mask.copy()
    flood = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(filled, flood, (0, 0), 1)
    return mask | (1 - filled)


def segment(sessions, image):
    """Fast human-segmentation pass finds the person; BiRefNet then runs once on that crop for clean edges."""
    rough = largest_person(np.asarray(remove(image, session=sessions["rough"], only_mask=True)))
    ys, xs = np.nonzero(rough)
    if not len(xs):
        print("ERROR No person was found in one of the photos. Every photo must show the whole person.", flush=True)
        sys.exit(1)
    h, w = rough.shape
    pad = int(0.12 * max(xs.max() - xs.min(), ys.max() - ys.min()))
    box = (max(0, xs.min() - pad), max(0, ys.min() - pad), min(w, xs.max() + pad), min(h, ys.max() + pad))
    crop_alpha = np.asarray(remove(image.crop(box), session=sessions["fine"], only_mask=True))
    refined = np.zeros(rough.shape, np.uint8)
    refined[box[1]:box[3], box[0]:box[2]] = crop_alpha
    # The coarse mask only gates distant objects (tripods); generous dilation keeps hands and hair.
    soft = np.where(cv2.dilate(rough, np.ones((45, 45), np.uint8)) > 0, refined, 0)
    return largest_person(soft) * 255, soft, box


def principal_point_of_ring(model):
    # Least-squares point closest to all optical axes = where the cameras look (the subject).
    a, b = np.zeros((3, 3)), np.zeros(3)
    for image in model.images.values():
        rotation = np.asarray(image.cam_from_world.rotation.matrix())
        axis, origin = rotation[2], image.projection_center()
        projector = np.eye(3) - np.outer(axis, axis)
        a += projector; b += projector @ origin
    return np.linalg.solve(a, b)


def visual_hull(model, masks, resolution=160, tolerance=1):
    centre = principal_point_of_ring(model)
    radius = np.mean([np.linalg.norm(img.projection_center() - centre) for img in model.images.values()])
    half = 0.5 * radius
    axis = np.linspace(-half, half, resolution)
    grid = np.stack(np.meshgrid(axis, axis, axis, indexing="ij"), -1).reshape(-1, 3) + centre
    misses = np.zeros(len(grid), np.int16)
    for image in model.images.values():
        camera, mask = model.cameras[image.camera_id], masks[image.name]
        local = (np.asarray(image.cam_from_world.matrix())[:, :3] @ grid.T).T + np.asarray(image.cam_from_world.matrix())[:, 3]
        front = local[:, 2] > 1e-6
        pixels = np.full((len(grid), 2), -1.)
        pixels[front] = camera.img_from_cam(local[front])
        x, y = np.round(pixels[:, 0]).astype(int), np.round(pixels[:, 1]).astype(int)
        inside = front & (x >= 0) & (y >= 0) & (x < mask.shape[1]) & (y < mask.shape[0])
        hit = np.zeros(len(grid), bool)
        hit[inside] = mask[y[inside], x[inside]] > 0
        misses += ~hit
    occupied = misses <= tolerance
    return grid[occupied], centre, radius, axis[1] - axis[0]


def hull_iou(model, masks, points, voxel):
    result = {}
    for image in model.images.values():
        camera, mask = model.cameras[image.camera_id], masks[image.name] > 0
        local = (np.asarray(image.cam_from_world.matrix())[:, :3] @ points.T).T + np.asarray(image.cam_from_world.matrix())[:, 3]
        pixels = camera.img_from_cam(local)
        rendered = np.zeros(mask.shape, np.uint8)
        x, y = np.round(pixels[:, 0]).astype(int), np.round(pixels[:, 1]).astype(int)
        keep = (x >= 0) & (y >= 0) & (x < mask.shape[1]) & (y < mask.shape[0])
        rendered[y[keep], x[keep]] = 1
        footprint = max(3, int(np.ceil(camera.params[0] * voxel / np.median(local[:, 2]))) | 1)
        rendered = cv2.morphologyEx(rendered, cv2.MORPH_CLOSE, np.ones((footprint, footprint), np.uint8)) > 0
        union = np.count_nonzero(rendered | mask)
        result[image.name] = {"iou": float(np.count_nonzero(rendered & mask) / union) if union else 0.,
                              "maskOutsideHull": float(np.count_nonzero(mask & ~rendered) / max(1, np.count_nonzero(mask)))}
    return result


def main(model_name="birefnet-general"):
    images = sorted((WORK / "images").glob("*.jpg"))
    out = WORK / "masks"; out.mkdir(exist_ok=True)
    progress(0.02, "Loading the segmentation models")
    # CPU on purpose: BiRefNet in FP32 does not fit beside training on a 6 GB GPU (measured 6.6 s, then 151 s paging).
    cpu = ["CPUExecutionProvider"]
    sessions = {"rough": new_session("u2net_human_seg", providers=cpu), "fine": new_session(model_name, providers=cpu)}
    masks, boxes = {}, {}
    for index, path in enumerate(images):
        image = Image.open(path).convert("RGB")
        mask, soft, box = segment(sessions, image)
        cv2.imwrite(str(out / f"{path.stem}.png"), mask.astype(np.uint8))
        cv2.imwrite(str(out / f"{path.stem}.alpha.png"), soft.astype(np.uint8))
        masks[path.name], boxes[path.name] = mask, box
        print(path.name, "mask px", int(np.count_nonzero(mask)), "box", box, flush=True)
        progress(0.05 + 0.85 * (index + 1) / len(images), f"Person segmented in {index + 1}/{len(images)} photos")
    model = pycolmap.Reconstruction(str(next(p for p in (WORK / "colmap/sparse").iterdir())))
    progress(0.92, "Checking masks against each other (visual hull)")
    points, centre, radius, voxel = visual_hull(model, masks)
    np.savez(WORK / "hull.npz", points=points, centre=centre, radius=radius, voxel=voxel)
    ious = hull_iou(model, masks, points, voxel)
    report = {"model": model_name, "hullVoxels": len(points), "voxelSize": voxel, "ringRadius": radius,
              "minIoU": min(v["iou"] for v in ious.values()), "meanIoU": float(np.mean([v["iou"] for v in ious.values()])),
              "views": ious}
    (WORK / "masks-report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({k: v for k, v in report.items() if k != "views"}, indent=2))
    worst = sorted(ious.items(), key=lambda kv: kv[1]["iou"])[:5]
    progress(1.0, f"Mask agreement: mean IoU {report['meanIoU']:.2f}, worst {report['minIoU']:.2f}",
             meanIoU=round(report["meanIoU"], 3), minIoU=round(report["minIoU"], 3))
    print("worst views", [(k, round(v["iou"], 3), round(v["maskOutsideHull"], 3)) for k, v in worst])
    tiles = []
    for path in images:
        image = cv2.imread(str(path)); box = boxes[path.name]
        tint = image.copy(); tint[masks[path.name] == 0] = (tint[masks[path.name] == 0] * 0.25).astype(np.uint8)
        crop = tint[box[1]:box[3], box[0]:box[2]]
        tiles.append(cv2.resize(crop, (int(crop.shape[1] * 360 / crop.shape[0]), 360)))
    width = max(t.shape[1] for t in tiles)
    tiles = [cv2.copyMakeBorder(t, 0, 0, 0, width - t.shape[1], cv2.BORDER_CONSTANT) for t in tiles]
    rows = [np.hstack(tiles[i:i + 8]) for i in range(0, len(tiles), 8)]
    cv2.imwrite(str(WORK / "masks-sheet.jpg"), np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 85])


if __name__ == "__main__":
    main(*sys.argv[1:])
