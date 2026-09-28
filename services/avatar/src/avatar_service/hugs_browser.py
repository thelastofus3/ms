"""Export HUGS appearance and learned skinning for the browser experiment."""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
from pathlib import Path

from avatar_service.gaussian_rig import (
    SMPL_NAMES,
    SMPL_PARENTS,
    forward_joints,
    recover_rest_joints,
)


def export_browser(
    checkpoint: Path, preview_ply: Path, predictions: Path, output: Path
) -> dict:
    checkpoint, preview_ply, predictions, output = map(
        Path, (checkpoint, preview_ply, predictions, output)
    )
    if output.exists():
        raise FileExistsError(str(output))
    for path in (
        checkpoint / "human_final.pth",
        checkpoint / "config_train.yaml",
        preview_ply,
    ):
        if not path.is_file():
            raise FileNotFoundError(str(path))
    files = sorted(predictions.glob("*.npz"))
    if not files:
        raise ValueError(
            "Published SMPL24 joint predictions are required for the estimated rig"
        )
    import numpy as np
    import torch
    from hugs.models.modules.decoders import DeformationDecoder, GeometryDecoder
    from hugs.models.modules.triplane import TriPlane
    from omegaconf import OmegaConf
    from plyfile import PlyData
    from scipy.spatial.transform import Rotation

    rest_samples, fk_errors, observations = [], [], []
    for path in files:
        # These are trusted predictions from the official NeuMan archive, not uploads.
        observed = np.load(path, allow_pickle=True)["results"][0]
        rotations = (
            Rotation.from_rotvec(observed["poses"].reshape(24, 3)).as_matrix().tolist()
        )
        joints = observed["j3d_smpl24"].astype(float).tolist()
        rest = recover_rest_joints(joints, rotations, SMPL_PARENTS)
        reconstructed = np.array(forward_joints(rest, rotations, SMPL_PARENTS))
        fk_errors.append(float(np.max(np.abs(reconstructed - joints))))
        rest_samples.append(rest)
        observations.append((joints, rotations))
    rest = np.median(np.array(rest_samples), axis=0)
    aggregate_errors = [
        np.linalg.norm(
            np.array(forward_joints(rest.tolist(), rots, SMPL_PARENTS)) - joints, axis=1
        )
        for joints, rots in observations
    ]
    if max(fk_errors) > 1e-5:
        raise ValueError("Inverse kinematics did not reconstruct the observed joints")

    cfg = OmegaConf.load(checkpoint / "config_train.yaml")
    if int(cfg.human.sh_degree) != 0:
        raise ValueError("Browser compact export supports SH degree zero only")
    if not cfg.human.use_deformer or not cfg.human.disable_posedirs:
        raise ValueError(
            "Browser export currently requires learned skinning without pose blendshapes"
        )
    if not torch.cuda.is_available():
        raise RuntimeError("Run inside the HUGS image with --gpus all")
    with torch.no_grad():
        state = torch.load(checkpoint / "human_final.pth", map_location="cpu")
        plane = TriPlane(
            32, cfg.human.triplane_res, cfg.human.triplane_res, cfg.human.triplane_res
        )
        geometry = GeometryDecoder(96, use_surface=cfg.human.use_surface)
        deformation = DeformationDecoder(96, disable_posedirs=True)
        for module, key in (
            (plane, "triplane"),
            (geometry, "geometry_dec"),
            (deformation, "deformation_dec"),
        ):
            module.load_state_dict(state[key], strict=True)
            module.eval().cuda()
        original_xyz = state["xyz"].cuda()
        features = plane(original_xyz)
        xyz = (original_xyz + geometry(features)["xyz"]).cpu().numpy()
        weights = torch.softmax(deformation(features)["lbs_weights"] / 0.1, dim=-1)
        values, indices = torch.topk(weights, k=4, dim=-1)
        retained = values.sum(-1)
        selected = (values / retained[:, None]).cpu().numpy().astype("<f4")
        indices = indices.cpu().numpy().astype("u1")
        retained_stats = {
            "mean": float(retained.mean()),
            "minimum": float(retained.min()),
        }
    vertices = PlyData.read(str(preview_ply))["vertex"].data
    stored_xyz = np.column_stack([vertices[name] for name in ("x", "y", "z")])
    if stored_xyz.shape != xyz.shape or not np.allclose(stored_xyz, xyz, atol=1e-5):
        raise ValueError("Preview PLY order/positions do not match this checkpoint")
    scales = np.exp(np.column_stack([vertices[f"scale_{i}"] for i in range(3)]))
    rotation = np.column_stack([vertices[f"rot_{i}"] for i in range(4)])
    rotation /= np.linalg.norm(rotation, axis=1, keepdims=True)
    rgb = (
        np.column_stack([vertices[f"f_dc_{i}"] for i in range(3)]) * 0.28209479177387814
        + 0.5
    )
    alpha = 1 / (1 + np.exp(-vertices["opacity"]))
    for value in (xyz, scales, rotation, rgb, alpha, selected):
        if not np.isfinite(value).all():
            raise ValueError("Non-finite package data")
    if not np.allclose(selected.sum(-1), 1, atol=1e-6):
        raise ValueError("Skin weights must sum to one")
    rgba = np.column_stack([rgb, alpha])
    records = np.concatenate(
        [
            xyz.astype("<f4").view("u1").reshape(-1, 12),
            scales.astype("<f4").view("u1").reshape(-1, 12),
            np.clip(rgba * 255, 0, 255).round().astype("u1"),
            np.clip(rotation * 128 + 128, 0, 255).round().astype("u1"),
        ],
        axis=1,
    )
    if records.shape != (len(xyz), 32):
        raise ValueError("Invalid SPLAT record width")
    canonical = [[0.0, 0.0, 0.0] for _ in range(24)]
    canonical[1][2], canonical[2][2] = 1.0, -1.0
    manifest = {
        "schema_version": 1,
        "representation": "gaussian-rig",
        "name": f"HUGS / {cfg.dataset.seq}",
        "source": "Operator-supplied HUGS checkpoint and SMPL24 joint predictions",
        "personal_capture": None,
        "source_checkpoint_sha256": hashlib.sha256(
            (checkpoint / "human_final.pth").read_bytes()
        ).hexdigest(),
        "num_splats": len(xyz),
        "model": "avatar.splat",
        "indices": "indices.bin",
        "weights": "weights.bin",
        "weight_count": 4,
        "rig": {
            "parents": SMPL_PARENTS,
            "names": SMPL_NAMES,
            "rest_joints": rest.tolist(),
            "canonical_axis_angles": canonical,
        },
        "approximation": {
            "joint_source": "median inverse-FK of published ROMP SMPL24 joints",
            "is_exact_smpl_rig": False,
            "retained_weight_mass": retained_stats,
            "max_inverse_fk_error_m": max(fk_errors),
            "median_rig_mean_joint_error_m": float(np.mean(aggregate_errors)),
            "skinning": "four-weight covariance linear blend; RGBA/quaternion quantized to uint8",
        },
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        dir=output.parent, prefix=".gaussian-rig-"
    ) as temporary:
        publish = Path(temporary) / "publish"
        publish.mkdir()
        for name, data in (
            ("avatar.splat", records),
            ("indices.bin", indices),
            ("weights.bin", selected),
        ):
            (publish / name).write_bytes(data.tobytes())
        manifest["sha256"] = {
            name: hashlib.sha256((publish / name).read_bytes()).hexdigest()
            for name in ("avatar.splat", "indices.bin", "weights.bin")
        }
        (publish / "manifest.json").write_text(
            json.dumps(manifest, indent=2), encoding="utf-8"
        )
        if output.exists():
            raise FileExistsError(str(output))
        publish.rename(output)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--preview-ply", type=Path, required=True)
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = export_browser(
        args.checkpoint, args.preview_ply, args.predictions, args.output
    )
    print(
        json.dumps(
            {
                "num_splats": manifest["num_splats"],
                "approximation": manifest["approximation"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
