"""Stage 3b: train person-only Gaussians (splatfacto, RGBA + random background) and evaluate held-out views.

  docker run --rm --gpus all --shm-size 2g -v <repo>/.runtime/avatar-multiview:/work \
    -v <repo>/services/avatar/multiview:/code:ro avatar-multiview /code/train.py [steps] [run-name]
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch

from progress import report as progress

WORK = Path(os.environ.get("AVATAR_WORK", "/work"))


def train(steps, name):
    output = WORK / "training"
    command = ["ns-train", "splatfacto", "--data", WORK / "dataset", "--output-dir", output,
               "--experiment-name", "person", "--timestamp", name, "--vis", "tensorboard",
               "--max-num-iterations", steps, "--steps-per-save", 5000,
               "--pipeline.datamanager.cache-images", "gpu",
               "--pipeline.model.background-color", "random", "--pipeline.model.random-init", "False",
               "--pipeline.model.sh-degree", 3, "--pipeline.model.cull-alpha-thresh", 0.005,
               "--pipeline.model.densify-grad-thresh", 0.0006, "--pipeline.model.stop-split-at", int(steps * 0.6),
               "--pipeline.model.use-scale-regularization", "True",
               "nerfstudio-data", "--eval-mode", "all", "--orientation-method", "up", "--center-method", "poses"]
    started = time.monotonic()
    progress(0.0, "Starting Gaussian training", step=0, steps=steps)
    process = subprocess.Popen([str(c) for c in command], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    last = 0
    for line in process.stdout:
        print(line, end="", flush=True)
        # nerfstudio's console table: "1500 (10.00%)   ... ETA".
        match = re.match(r"\s*(\d+)\s+\((\d+(?:\.\d+)?)%\)", line)
        if match and int(match[1]) > last:
            last = int(match[1])
            elapsed = time.monotonic() - started
            remaining = elapsed / max(last, 1) * (steps - last)
            progress(0.9 * last / steps, f"Training step {last:,} of {steps:,}", step=last, steps=steps, etaSeconds=round(remaining))
    if process.wait():
        print("ERROR Gaussian training stopped unexpectedly. See the job log.", flush=True)
        sys.exit(1)
    return output / "person" / "splatfacto" / name / "config.yml", time.monotonic() - started


def evaluate(config):
    from nerfstudio.cameras.cameras import Cameras, CameraType
    from nerfstudio.utils.eval_utils import eval_setup
    from PIL import Image
    from torchmetrics.image import StructuralSimilarityIndexMeasure
    from torchmetrics.image.lpip import LearnedPerceptualImagePatchSimilarity
    _, pipeline, _, _ = eval_setup(config, test_mode="inference")
    model, parser = pipeline.model, pipeline.datamanager.train_dataparser_outputs
    transform, scale = parser.dataparser_transform.cpu().numpy(), parser.dataparser_scale
    ssim, lpips = StructuralSimilarityIndexMeasure(data_range=1.0), LearnedPerceptualImagePatchSimilarity(normalize=True)
    frames = json.loads((WORK / "dataset/transforms-eval.json").read_text())["frames"]
    if not frames:
        return {}, model.num_points
    results, renders = {}, WORK / "renders"; renders.mkdir(exist_ok=True)
    model.background_color = torch.ones(3, device=model.device)  # evaluate on white
    for frame in frames:
        pose = np.asarray(frame["transform_matrix"])
        pose = transform @ pose; pose[:3, 3] *= scale
        camera = Cameras(camera_to_worlds=torch.tensor(pose[None, :3], dtype=torch.float32), fx=frame["fl_x"], fy=frame["fl_y"],
                         cx=frame["cx"], cy=frame["cy"], width=frame["w"], height=frame["h"], camera_type=CameraType.PERSPECTIVE).to(model.device)
        with torch.no_grad():
            outputs = model.get_outputs_for_camera(camera)
        rendered = outputs["rgb"].clamp(0, 1).cpu()
        rgba = np.asarray(Image.open(WORK / "dataset" / frame["file_path"])).astype(np.float32) / 255
        target = torch.tensor(rgba[..., :3] * rgba[..., 3:] + (1 - rgba[..., 3:]))
        ys, xs = np.nonzero(rgba[..., 3] > 0.5)
        pad = 20
        y0, y1, x0, x1 = max(0, ys.min() - pad), ys.max() + pad, max(0, xs.min() - pad), xs.max() + pad
        a, b = rendered[y0:y1, x0:x1], target[y0:y1, x0:x1]
        mse = torch.mean((a - b) ** 2).item()
        tensors = a.permute(2, 0, 1)[None], b.permute(2, 0, 1)[None]
        name = Path(frame["file_path"]).stem
        results[name] = {"psnr": 10 * np.log10(1 / mse), "ssim": ssim(*tensors).item(), "lpips": lpips(*tensors).item()}
        Image.fromarray((torch.cat([b, a], 1).numpy() * 255).astype(np.uint8)).save(renders / f"{name}-gt-vs-render.jpg", quality=92)
    return results, model.num_points


def export(config):
    out = WORK / "export"
    subprocess.run(["ns-export", "gaussian-splat", "--load-config", str(config), "--output-dir", str(out),
                    "--output-filename", "person.ply"], check=True)
    return out / "person.ply"


def main(steps="15000", name="v1"):
    torch.cuda.reset_peak_memory_stats()
    config, seconds = train(int(steps), name)
    progress(0.92, "Scoring held-out photos")
    results, gaussians = evaluate(config)
    progress(0.96, "Exporting the 3D model")
    ply = export(config)
    mean = {k: float(np.mean([r[k] for r in results.values()])) for k in ("psnr", "ssim", "lpips")} if results else {}
    report = {"run": name, "steps": int(steps), "trainSeconds": round(seconds), "gaussians": int(gaussians),
              "heldOut": results, "mean": mean, "config": str(config), "ply": str(ply.relative_to(WORK)),
              "plyBytes": ply.stat().st_size}
    (WORK / f"train-report-{name}.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    quality = f"held-out PSNR {mean['psnr']:.1f} dB, SSIM {mean['ssim']:.3f}" if mean else "no held-out photos"
    progress(1.0, f"{int(gaussians):,} Gaussians · {quality}", gaussians=int(gaussians), **{k: round(v, 4) for k, v in mean.items()})


if __name__ == "__main__":
    main(*sys.argv[1:])
