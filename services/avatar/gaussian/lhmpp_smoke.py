"""Measured local multiview experiment; no production jobs are marked successful.

Uses the upstream GS export routines, FP32 neural stages and a separately tested
Turing attention adapter. Every run has a new directory and a durable report.
"""

import argparse
import gc
import importlib.util
import json
import time
import traceback
from pathlib import Path
from types import SimpleNamespace


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--views", type=int, default=8)
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    report = {
        "status": "running",
        "stage": "imports",
        "settings": vars(args),
        "adaptations": [
            "FP32 neural stages (packed point attention retains upstream FP16)",
            "sequential image encoding",
            "CPU offload of encoder after encoding",
            "xformers packed point attention on Turing",
            "efficient SDPA instead of Flash-only joint attention",
            "raw Gaussians without neural image refinement",
            "FP32 implicit GEMM sparse convolutions",
        ],
    }
    start = time.monotonic()
    torch = None

    def stage(name):
        report["stage"] = name
        report["elapsed_s"] = time.monotonic() - start
        if torch is not None and torch.cuda.is_available():
            report["peak_allocated_bytes"] = torch.cuda.max_memory_allocated()
            report["peak_reserved_bytes"] = torch.cuda.max_memory_reserved()
        (output / "report.json").write_text(json.dumps(report, indent=2))
        print(name, flush=True)

    try:
        import numpy as np
        import torch
        from accelerate import Accelerator
        from lhmpp_attention import packed_attention
        from lhmpp_compat import (
            enable_legacy_numpy_aliases,
            enable_float32_sparse_convolutions,
        )
        from PIL import Image
        from safetensors.torch import load_file

        enable_legacy_numpy_aliases()
        torch._dynamo.config.disable = True
        torch.set_num_threads(4)
        torch.manual_seed(42)
        np.random.seed(42)
        Accelerator()
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is required for this reconstruction experiment")
        report["gpu"] = torch.cuda.get_device_name()
        torch.cuda.reset_peak_memory_stats()
        from core.models.encoders.dinov2_wrapper import Dinov2Wrapper
        from core.models.encoders.sonata import model as sonata
        from core.models.modeling_humana4o_lrm import ModelHumanA4OLRM
        from core.models.transformer_block import transformer_dit

        sonata.flash_attn = SimpleNamespace(
            flash_attn_varlen_qkvpacked_func=packed_attention
        )
        transformer_dit.sdpa_kernel = lambda backends: torch.backends.cuda.sdp_kernel(
            enable_flash=False, enable_math=True, enable_mem_efficient=True
        )
        build_dino = Dinov2Wrapper._build_dinov2
        Dinov2Wrapper._build_dinov2 = staticmethod(
            lambda name, modulation_dim=None, pretrained=True: build_dino(
                name, modulation_dim, pretrained=False
            )
        )

        spec = importlib.util.spec_from_file_location(
            "gs_export", "scripts/inference/to_gs_ply.py"
        )
        exporter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(exporter)
        config = json.loads((Path(args.model) / "config.json").read_text())
        config.update(use_face_id=False, facesr=False)
        stage("construct_model")
        model = ModelHumanA4OLRM(**config)
        model.eval()
        stage("load_weights")
        state = load_file(str(Path(args.model) / "model.safetensors"))
        incompatible = model.load_state_dict(state, strict=False)
        if incompatible.missing_keys or incompatible.unexpected_keys:
            raise ValueError(f"Checkpoint mismatch: {incompatible}")
        del state
        gc.collect()

        capture = Path(args.capture)
        manifest = json.loads((capture / "manifest.json").read_text())
        selected = manifest["selected"]
        if not 2 <= args.views <= len(selected):
            raise ValueError("views must select at least two available prepared images")
        # Explicit capture order starts at the front and surrounds the person.
        indices = np.linspace(0, len(selected), args.views, endpoint=False, dtype=int)
        selected = [selected[i] for i in indices]
        report["input_views"] = selected
        images = []
        for name in selected:
            frame = next(f for f in manifest["frames"] if f["source"] == name)
            with Image.open(capture / frame["normalized"]) as im:
                images.append(
                    torch.from_numpy(np.array(im.convert("RGB")))
                    .permute(2, 0, 1)
                    .float()
                    / 255
                )
        images = torch.stack(images)
        stage("encode_views")
        model.encoder.cuda()
        features = []
        with torch.inference_mode():
            for i, image in enumerate(images):
                features.append(model.encoder(image[None].cuda()).cpu())
                if not torch.isfinite(features[-1]).all():
                    raise FloatingPointError(f"Nonfinite encoder features: {selected[i]}")
                print("Encoded", selected[i], flush=True)
        encoded = torch.cat(features)
        model.encoder.cpu()
        gc.collect()
        torch.cuda.empty_cache()
        model.forward_encode_image = lambda image: encoded.to(image.device)
        stage("move_reconstruction_stages")
        model.transformer.cuda()
        model.motion_embed_mlp.cuda()
        if model.shape_head is not None:
            model.shape_head.cuda()
        model.renderer.cuda()
        enable_float32_sparse_convolutions(model)

        cfg = {"render_size": 512}
        motion = exporter._build_synthetic_motion_seq(cfg)
        actual_infer = model.infer_single_view
        cached = []

        def infer_and_save(*values, **kwargs):
            if not cached:
                cached.append(actual_infer(*values, **kwargs))
                stage("save_reconstruction_state")
                torch.save(
                    {
                        "outputs": cached[0],
                        "motion": motion,
                        "input_views": selected,
                        "config": config,
                    },
                    output / "reconstruction.pt",
                )
                for gaussian in cached[0][0]:
                    for key in ("offset_xyz", "shs", "opacity", "scaling", "rotation"):
                        if not torch.isfinite(getattr(gaussian, key)).all():
                            raise FloatingPointError(f"Nonfinite Gaussian {key}")
                if not torch.isfinite(cached[0][1]["neutral_coords"]).all():
                    raise FloatingPointError("Nonfinite neutral coordinates")
            return cached[0]

        model.infer_single_view = infer_and_save
        with torch.inference_mode():
            stage("reconstruct_and_export_canonical")
            exporter.run_tpose_export(
                model, images.cuda(), motion, "cuda", str(output / "canonical.ply")
            )
            for name, sign in [("pose-left", 1), ("pose-right", -1)]:
                pose_motion = {
                    **motion,
                    "smplx_params": {
                        k: v.clone() for k, v in motion["smplx_params"].items()
                    },
                }
                body = pose_motion["smplx_params"]["body_pose"]
                body.reshape(-1, 21, 3)[:, 17 if sign > 0 else 18, 1] = sign * 0.8
                stage("export_" + name)
                exporter.run_tpose_export(
                    model,
                    images.cuda(),
                    pose_motion,
                    "cuda",
                    str(output / (name + ".ply")),
                    export_animation_pose=True,
                )
        report["status"] = "exported_unreviewed"
        stage("awaiting_visual_verification")
    except Exception as exc:
        report["status"] = "failed"
        report["error"] = f"{type(exc).__name__}: {exc}"
        report["traceback"] = traceback.format_exc()
        stage(report["stage"])
        raise


if __name__ == "__main__":
    main()
