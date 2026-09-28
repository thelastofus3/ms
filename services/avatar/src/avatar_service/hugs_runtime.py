"""Preflight and measured execution for the isolated, pinned HUGS runtime."""

from __future__ import annotations

import argparse
import json
import runpy
import sys
import time
from pathlib import Path

MOTIONS = {
    "lab": "SFU/0008/0008_ChaCha001_poses.npz",
    "seattle": "SFU/0005/0005_SideSkip001_poses.npz",
    "citron": "MPI_mosh/00093/irish_dance_poses.npz",
    "parkinglot": "SFU/0005/0005_2FeetJump001_poses.npz",
    "bike": "MPI_mosh/50002/misc_poses.npz",
    "jogging": "SFU/0007/0007_Cartwheel001_poses.npz",
}


def inspect_inputs(data: Path, sequence: str, checkpoint: Path | None = None) -> dict:
    if sequence not in MOTIONS:
        raise ValueError(
            "Pinned HUGS supports these NeuMan sequences: " + ", ".join(MOTIONS)
        )
    data = Path(data)
    prefix = "neuman/dataset/" + sequence
    required = [
        "smpl/SMPL_NEUTRAL.pkl",
        MOTIONS[sequence],
        prefix + "/4d_humans/smpl_optimized_aligned_scale.npz",
        *[
            prefix + "/sparse/" + f
            for f in ("cameras.txt", "images.txt", "points3D.txt")
        ],
    ]
    missing = [
        name
        for name in required
        if not (data / name).is_file() or (data / name).stat().st_size == 0
    ]
    for relative, pattern in [
        (prefix + "/images", "*"),
        (prefix + "/segmentations", "*"),
        (prefix + "/4d_humans/sam_segmentations", "*.png"),
    ]:
        if not any(
            p.is_file() and p.stat().st_size for p in (data / relative).glob(pattern)
        ):
            missing.append(relative + "/" + pattern)
    if checkpoint is not None:
        checkpoint = Path(checkpoint)
        if not (checkpoint / "config_train.yaml").is_file():
            missing.append(str(checkpoint / "config_train.yaml"))
        files = list(checkpoint.glob("*human*.pth")) + list(
            (checkpoint / "ckpt").glob("*human*.pth")
        )
        if not any(p.is_file() and p.stat().st_size for p in files):
            missing.append(str(checkpoint / "*human*.pth"))
    return {
        "ready": not missing,
        "check": "file_presence_only",
        "sequence": sequence,
        "missing": missing,
        "note": "Presence is not dataset validation or successful inference. SMPL UV is recommended by upstream; AMASS is loaded even for training.",
    }


def training_command(sequence: str, steps: int) -> list[str]:
    return [
        "main.py",
        "--cfg_file",
        "cfg_files/release/neuman/hugs_human.yaml",
        "--cfg_id",
        "0",
        "dataset.seq=" + sequence,
        "train.num_steps=" + str(steps),
        "output_path=/output",
    ]


def evaluation_command(checkpoint: Path, sequence: str, model_name: str) -> list[str]:
    if model_name not in ("hugs_triplane", "hugs_trimlp"):
        raise ValueError("Evaluation wrapper supports only HUGS triplane checkpoints")
    return [
        "scripts/evaluate.py",
        "-o",
        str(checkpoint),
        "dataset.seq=" + sequence,
        "human.name=hugs_trimlp",
    ]


def write_report(path: Path | None, report: dict):
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("data"))
    parser.add_argument("--sequence", choices=MOTIONS, default="lab")
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument(
        "--action", choices=["check", "train", "evaluate"], default="check"
    )
    parser.add_argument("--steps", type=int, default=100)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    report = inspect_inputs(args.data, args.sequence, args.checkpoint)
    if args.action == "evaluate" and args.checkpoint is None:
        report["missing"].append("--checkpoint is required for evaluate")
        report["ready"] = False
    if args.action == "check" or not report["ready"]:
        report["status"] = "prerequisites_present" if report["ready"] else "blocked"
        write_report(args.report, report)
        print(json.dumps(report, indent=2))
        return 0 if report["ready"] else 2
    if args.steps < 1:
        parser.error("--steps must be positive")
    if args.data.resolve() != Path("data").resolve() or not Path("hugs").is_dir():
        parser.error("Run inside the HUGS image with data mounted at /opt/hugs/data")
    import torch

    started = time.monotonic()
    report.update(action=args.action, status="failed")
    try:
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable; start Docker with --gpus all")
        torch.cuda.reset_peak_memory_stats()
        report["gpu"] = torch.cuda.get_device_name()
        report["free_bytes_before"], report["total_bytes"] = torch.cuda.mem_get_info()
        if args.action == "evaluate":
            from omegaconf import OmegaConf

            cfg = OmegaConf.load(args.checkpoint / "config_train.yaml")
            if cfg.mode in ("scene", "human_scene") and not list(
                args.checkpoint.glob("*scene*.pth")
            ):
                raise ValueError(
                    "This checkpoint config requires a scene checkpoint at its root"
                )
            script = "scripts/evaluate.py"
            sys.argv = evaluation_command(
                args.checkpoint, args.sequence, cfg.human.name
            )
        else:
            script = "main.py"
            sys.argv = training_command(args.sequence, args.steps)
        runpy.run_path(script, run_name="__main__")
        torch.cuda.synchronize()
        report["status"] = "completed"
    except (Exception, SystemExit) as exc:
        report["error"] = type(exc).__name__ + ": " + str(exc)
    finally:
        report["elapsed_seconds"] = time.monotonic() - started
        if torch.cuda.is_available():
            report["peak_allocated_bytes"] = torch.cuda.max_memory_allocated()
            report["peak_reserved_bytes"] = torch.cuda.max_memory_reserved()
        write_report(args.report, report)
        print(json.dumps(report, indent=2))
    return 0 if report["status"] == "completed" else 1


if __name__ == "__main__":
    sys.exit(main())
