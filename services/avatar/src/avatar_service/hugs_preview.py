"""Render a published HUGS triplane checkpoint in its canonical pose, without SMPL.

Run in the isolated HUGS image. This neither reconstructs a new person nor
animates one. Only load trusted checkpoints: the upstream format uses pickle.
"""

from __future__ import annotations

import argparse
import json
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace


def render_canonical(checkpoint: Path, output: Path) -> dict:
    checkpoint, output = Path(checkpoint).resolve(), Path(output).resolve()
    if output.exists():
        raise FileExistsError(f"Preview output already exists: {output}")
    for filename in ("config_train.yaml", "human_final.pth"):
        path = checkpoint / filename
        if not path.is_file() or not path.stat().st_size:
            raise FileNotFoundError(str(path))

    import torch

    with torch.no_grad():
        return _render(checkpoint, output)


def _render(checkpoint: Path, output: Path) -> dict:
    import torch
    from hugs.datasets.utils import get_rotating_camera
    from hugs.models.hugs_trimlp import HUGS_TRIMLP
    from hugs.models.modules.decoders import (
        AppearanceDecoder,
        DeformationDecoder,
        GeometryDecoder,
    )
    from hugs.models.modules.triplane import TriPlane
    from hugs.renderer.gs_renderer import render
    from hugs.utils.rotations import matrix_to_quaternion, rotation_6d_to_matrix
    from hugs.utils.vis import save_ply
    from omegaconf import OmegaConf
    from PIL import Image

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA unavailable; start the HUGS image with --gpus all")
    torch.cuda.reset_peak_memory_stats()
    started = time.monotonic()
    cfg = OmegaConf.load(checkpoint / "config_train.yaml")
    if cfg.human.name not in ("hugs_triplane", "hugs_trimlp") or cfg.human.use_surface:
        raise ValueError("Preview supports volumetric HUGS triplane checkpoints only")
    state = torch.load(checkpoint / "human_final.pth", map_location="cpu")
    modules = {
        "triplane": TriPlane(
            32,
            resX=cfg.human.triplane_res,
            resY=cfg.human.triplane_res,
            resZ=cfg.human.triplane_res,
        ),
        "appearance_dec": AppearanceDecoder(96),
        "geometry_dec": GeometryDecoder(96, use_surface=False),
        "deformation_dec": DeformationDecoder(
            96, disable_posedirs=cfg.human.disable_posedirs
        ),
    }
    for key, module in modules.items():
        module.load_state_dict(state[key], strict=True)
        module.eval().cuda()
    # canon_forward only needs these checkpoint-backed attributes. The original
    # HUGS constructor also creates SMPL, which is unnecessary for this stage.
    holder = SimpleNamespace(
        **modules,
        get_xyz=state["xyz"].cuda(),
        scaling_multiplier=state["scaling_multiplier"].cuda(),
        use_deformer=cfg.human.use_deformer,
    )
    canonical = HUGS_TRIMLP.canon_forward(holder)
    xyz = holder.get_xyz + canonical["xyz_offsets"]
    scales = canonical["scales"]
    if cfg.human.isotropic:
        scales = scales.mean(-1, keepdim=True).expand_as(scales)
    rotation = matrix_to_quaternion(rotation_6d_to_matrix(canonical["rot6d_canon"]))
    for value in (xyz, scales, rotation, canonical["opacity"], canonical["shs"]):
        if not torch.isfinite(value).all():
            raise ValueError("Checkpoint produced non-finite Gaussian parameters")
    if not (scales.abs() > 0).all():
        raise ValueError("Checkpoint produced degenerate zero Gaussian scales")
    # Upstream CUDA computes Sigma=(S R)^T(S R). Scale signs cancel; PLY
    # stores log(scale), requiring positive magnitudes. Verify image equivalence below.
    export_scales = scales.abs()
    degree = int(state["active_sh_degree"])
    if not 0 <= degree <= 3:
        raise ValueError("Unsupported spherical harmonics degree")
    canonical["shs"][:, (degree + 1) ** 2 :] = 0
    ply_data = {
        "xyz_canon": xyz,
        "scales_canon": export_scales,
        "rotq_canon": rotation,
        "opacity": canonical["opacity"].clamp(1e-6, 1 - 1e-6),
        "shs": canonical["shs"],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        dir=output.parent, prefix=".canonical-"
    ) as temporary:
        publish = Path(temporary) / "publish"
        publish.mkdir()
        save_ply(ply_data, str(publish / "canonical.ply"))
        cameras = get_rotating_camera(img_size=512, dist=5.0, nframes=5)
        render_times = []
        for index, camera in enumerate(cameras[:4]):
            torch.cuda.synchronize()
            frame_start = time.monotonic()
            rendered = render(
                xyz,
                canonical["shs"],
                canonical["opacity"],
                scales,
                rotation,
                camera,
                bg_color=torch.ones(3, device="cuda"),
                active_sh_degree=degree,
            )["render"]
            torch.cuda.synchronize()
            render_times.append(time.monotonic() - frame_start)
            if not torch.isfinite(rendered).all():
                raise ValueError("Non-finite rendered image")
            comparison = render(
                xyz,
                canonical["shs"],
                canonical["opacity"],
                export_scales,
                rotation,
                camera,
                bg_color=torch.ones(3, device="cuda"),
                active_sh_degree=degree,
            )["render"]
            torch.testing.assert_close(rendered, comparison, atol=1e-6, rtol=1e-5)
            pixels = (
                (rendered.clamp(0, 1).permute(1, 2, 0).cpu().numpy() * 255)
                .round()
                .astype("uint8")
            )
            if pixels.min() >= 240:
                raise ValueError("Empty canonical render")
            Image.fromarray(pixels).save(publish / f"view-{index}.png")
        torch.cuda.synchronize()
        report = {
            "status": "canonical_checkpoint_rendered",
            "animation": False,
            "personal_reconstruction": False,
            "gpu": torch.cuda.get_device_name(),
            "gaussians": xyz.shape[0],
            "active_sh_degree": degree,
            "negative_scale_components": int((scales < 0).sum().item()),
            "scale_sign_render_equivalence": True,
            "render_seconds_512px": render_times,
            "elapsed_seconds": time.monotonic() - started,
            "peak_allocated_bytes": torch.cuda.max_memory_allocated(),
            "peak_reserved_bytes": torch.cuda.max_memory_reserved(),
            "memory_scope": "PyTorch allocator; excludes CUDA context and external allocations",
            "source": str(checkpoint / "human_final.pth"),
            "method": "upstream canon_forward; strict four-module state_dict loading",
            "ply_adjustments": "covariance-equivalent absolute scales; zero inactive SH; opacity clamped to [1e-6,1-1e-6] for finite logits",
        }
        (publish / "report.json").write_text(
            json.dumps(report, indent=2), encoding="utf-8"
        )
        if output.exists():
            raise FileExistsError(f"Preview output appeared during rendering: {output}")
        publish.rename(output)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = render_canonical(args.checkpoint, args.output)
    except Exception as exc:
        parser.exit(1, f"Canonical preview failed: {type(exc).__name__}: {exc}\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
