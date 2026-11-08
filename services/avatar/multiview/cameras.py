"""Stage 1: calibrate the 24-view capture with COLMAP and report registration quality.

Runs inside the room-worker image:
  docker run --rm --gpus all -v <repo>/dataset/avatar:/input:ro -v <repo>/.runtime/avatar-multiview:/work \
    -v <repo>/services/avatar/multiview:/code:ro --entrypoint python masterproject-room-worker /code/cameras.py
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pycolmap

from progress import report as progress

INPUT, WORK = Path(os.environ.get("AVATAR_INPUT", "/input")), Path(os.environ.get("AVATAR_WORK", "/work"))


def run(*args):
    print("+", " ".join(map(str, args)), flush=True)
    subprocess.run([str(a) for a in args], check=True)


def main(single_camera="0"):
    images = WORK / "images"
    if not images.exists():
        images.mkdir(parents=True)
        for path in sorted(INPUT.glob("*.jpg")):
            shutil.copy(path, images / path.name)
    colmap = WORK / "colmap"
    shutil.rmtree(colmap, ignore_errors=True)
    (colmap / "sparse").mkdir(parents=True)
    database = colmap / "database.db"
    progress(0.05, "Finding image features")
    run("colmap", "feature_extractor", "--database_path", database, "--image_path", images,
        "--ImageReader.camera_model", "SIMPLE_RADIAL", "--ImageReader.single_camera", single_camera,
        "--SiftExtraction.use_gpu", "1", "--SiftExtraction.max_num_features", "16384",
        "--SiftExtraction.estimate_affine_shape", "1", "--SiftExtraction.domain_size_pooling", "1")
    progress(0.3, "Matching all view pairs")
    run("colmap", "exhaustive_matcher", "--database_path", database,
        "--SiftMatching.use_gpu", "1", "--SiftMatching.guided_matching", "1")
    progress(0.6, "Solving camera positions")
    run("colmap", "mapper", "--database_path", database, "--image_path", images, "--output_path", colmap / "sparse",
        "--Mapper.ba_refine_principal_point", "0")
    models = sorted((colmap / "sparse").iterdir(), key=lambda p: -pycolmap.Reconstruction(str(p)).num_reg_images())
    model = pycolmap.Reconstruction(str(models[0]))
    centers = {img.name: img.projection_center() for img in model.images.values()}
    ring = np.asarray([centers[name] for name in sorted(centers)])
    middle = ring.mean(axis=0)
    radii = np.linalg.norm(ring - middle, axis=1)
    report = {
        "models": [pycolmap.Reconstruction(str(p)).num_reg_images() for p in models],
        "registered": model.num_reg_images(), "images": len(list(images.glob("*.jpg"))),
        "points": model.num_points3D(), "meanReprojectionErrorPx": model.compute_mean_reprojection_error(),
        "meanTrackLength": model.compute_mean_track_length(),
        "cameras": {c.camera_id: {"model": str(c.model), "params": c.params.tolist(), "size": [c.width, c.height]}
                    for c in model.cameras.values()},
        "ringRadiusRelativeStd": float(radii.std() / radii.mean()),
        "unregistered": sorted({p.name for p in images.glob("*.jpg")} - set(centers)),
    }
    if models[0].name != "0":
        models[0].rename(colmap / "sparse" / "best")
    (WORK / "cameras-report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({k: v for k, v in report.items() if k != "cameras"}, indent=2))
    if report["registered"] < max(8, 0.75 * report["images"]):
        print(f"ERROR Only {report['registered']} of {report['images']} photos could be placed in 3D. "
              "Photograph the person from all sides with overlapping, sharp views of a textured background.", flush=True)
        sys.exit(1)
    progress(1.0, f"{report['registered']}/{report['images']} cameras, {report['meanReprojectionErrorPx']:.2f} px error",
             registered=report["registered"], reprojectionErrorPx=round(report["meanReprojectionErrorPx"], 3))


if __name__ == "__main__":
    main(*sys.argv[1:])
