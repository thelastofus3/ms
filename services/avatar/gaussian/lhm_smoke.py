"""Measured LHM-MINI appearance probe on a prepared, white-background image.

Not the production upload worker. Uses mean body shape, an explicit head crop,
FP16 neural stages and no face super-resolution. Records these approximations.
Run in /opt/lhm with the isolated environment and official downloaded assets.
"""

import argparse
import gc
import json
import sys
import time
import traceback
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--head-box", required=True, help="x0,y0,x1,y1 in source image")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    report = {
        "status": "running",
        "stage": "imports",
        "input": args.image,
        "approximations": [
            "mean SMPL-X shape",
            "explicit head crop",
            "prepared white background",
            "face super-resolution disabled",
            "FP16 staged inference",
        ],
    }
    started = time.monotonic()
    torch = None
    try:
        import numpy as np
        import torch
        import torchvision.transforms.functional as tvf
        from accelerate import Accelerator
        from PIL import Image, ImageOps
        from safetensors.torch import load_file

        # BasicSR 1.4 imports the pre-0.17 torchvision module name.
        sys.modules["torchvision.transforms.functional_tensor"] = tvf
        torch._dynamo.config.disable = True
        Accelerator(mixed_precision="fp16")
        from LHM.models.encoders.dinov2_fusion_wrapper import Dinov2FusionWrapper
        from LHM.models.encoders.sapiens_warpper import SapiensWrapper
        from LHM.models.modeling_human_lrm import ModelHumanLRMSapdinoBodyHeadSD3_5
        from LHM.models.rendering.gs_renderer import GaussianModel

        def stage(name):
            report["stage"] = name
            report["elapsed_s"] = time.monotonic() - started
            (output / "report.json").write_text(json.dumps(report, indent=2))
            print(name, flush=True)

        def release(module):
            module.cpu()
            gc.collect()
            torch.cuda.empty_cache()

        assert torch.cuda.is_available(), "CUDA required"
        report["gpu"] = torch.cuda.get_device_name()
        torch.cuda.reset_peak_memory_stats()
        stage("construct_model")
        # Keep the large Sapiens backbone off GPU until its stage.
        SapiensWrapper._build_sapiens = staticmethod(
            lambda name, pretrained=True: torch.jit.load(name, map_location="cpu")
        )
        build_dino = Dinov2FusionWrapper._build_dinov2
        Dinov2FusionWrapper._build_dinov2 = staticmethod(
            lambda name, modulation_dim=None, pretrained=True: build_dino(
                name, modulation_dim, pretrained=False
            )
        )
        config = json.loads(Path("pretrained_models/LHM-MINI/config.json").read_text())
        config.update(facesr=False, use_face_id=False)
        model = ModelHumanLRMSapdinoBodyHeadSD3_5(**config).eval()
        stage("load_weights")
        state = load_file("pretrained_models/LHM-MINI/model.safetensors")
        incompatible = model.load_state_dict(state, strict=False)
        missing = [
            key
            for key in incompatible.missing_keys
            if not key.startswith("fine_encoder.")
        ]
        if missing or incompatible.unexpected_keys:
            raise ValueError(
                f"Checkpoint mismatch: {missing}, {incompatible.unexpected_keys}"
            )
        del state
        gc.collect()
        image = Image.open(args.image).convert("RGB")
        head = image.crop(tuple(map(int, args.head_box.split(",")))).resize((224, 224))
        # Author sample already has a white background. Preserve aspect when fitting.
        body = ImageOps.pad(image, (512, 832), color="white")
        body.save(output / "input-body.jpg")
        head.save(output / "input-head.jpg")

        def tensor(im):
            return (
                torch.from_numpy(np.asarray(im).copy())
                .permute(2, 0, 1)
                .unsqueeze(0)
                .cuda()
                .float()
                / 255
            )

        body_tensor, head_tensor = tensor(body), tensor(head)
        with torch.inference_mode():
            stage("sapiens_encode")
            model.fine_encoder.half().cuda()
            body_input = model.fine_encoder._preprocess_image(body_tensor, 1024)
            with torch.autocast("cuda", dtype=torch.float16):
                (features,) = model.fine_encoder.model(body_input)
                body_features = features.permute(0, 2, 3, 1).flatten(1, 2)
            del body_input, features
            release(model.fine_encoder)
            stage("head_encode")
            model.encoder.cuda()
            with torch.autocast("cuda", dtype=torch.float16):
                head_features = model.encoder(head_tensor)
            release(model.encoder)
            image_features = torch.cat(
                [
                    body_features,
                    torch.nn.functional.pad(
                        head_features,
                        (0, body_features.shape[-1] - head_features.shape[-1]),
                    ),
                ],
                dim=1,
            )
            stage("query_body")
            model.renderer.cuda()
            params = {"betas": torch.zeros((1, 10), device="cuda")}
            query, params = model.renderer.get_query_points(
                params, device=body_tensor.device
            )
            stage("transformer")
            model.motion_embed_mlp.cuda()
            model.pcl_embed.cuda()
            model.transformer.cuda()
            with torch.autocast("cuda", dtype=torch.float16):
                motion = model.forward_moitonembed(body_features)
                latent = model.forward_transformer(image_features, None, query, motion)
            release(model.transformer)
            release(model.pcl_embed)
            release(model.motion_embed_mlp)
            stage("gaussian_decode")
            model.renderer.hyper_step(10000000)
            with torch.autocast("cuda", dtype=torch.float16):
                attributes, query, params = model.renderer.forward_gs(
                    latent,
                    query,
                    params,
                    additional_features={
                        "image_feats": image_features,
                        "image": body_tensor,
                    },
                )
            attr = attributes[0]
            xyz = query[0] + attr.offset_xyz
            for value in (xyz, attr.opacity, attr.rotation, attr.scaling, attr.shs):
                if not torch.isfinite(value).all():
                    raise ValueError("Non-finite neural output")
            gs = GaussianModel(
                xyz=xyz.float(),
                opacity=attr.opacity.float(),
                rotation=attr.rotation.float(),
                scaling=attr.scaling.float(),
                shs=attr.shs.float(),
                use_rgb=True,
            )
            gs.save_ply(str(output / "canonical.ply"))
            torch.save(
                {
                    "xyz": xyz.cpu(),
                    "query": query.cpu(),
                    "params": {k: v.cpu() for k, v in params.items()},
                    "attributes": {
                        key: getattr(attr, key).cpu()
                        for key in (
                            "offset_xyz",
                            "opacity",
                            "rotation",
                            "scaling",
                            "shs",
                        )
                    },
                },
                output / "neural-output.pt",
            )
            report.update(status="succeeded", num_splats=len(xyz))
    except Exception as exc:
        report.update(
            status="failed",
            error=f"{type(exc).__name__}: {exc}",
            traceback=traceback.format_exc(),
        )
        traceback.print_exc()
    finally:
        report["elapsed_s"] = time.monotonic() - started
        if torch is not None and torch.cuda.is_available():
            report["peak_allocated_bytes"] = torch.cuda.max_memory_allocated()
            report["peak_reserved_bytes"] = torch.cuda.max_memory_reserved()
        (output / "report.json").write_text(json.dumps(report, indent=2))
    return 0 if report["status"] == "succeeded" else 1


if __name__ == "__main__":
    raise SystemExit(main())
