"""Normalize capture frames locally; this does not perform avatar reconstruction."""

import argparse
import hashlib
import json
import math
import shutil
import subprocess
import tempfile
import warnings
from pathlib import Path

from PIL import Image, ImageOps

PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"}


def prepare_capture(
    source: Path, output: Path, *, max_frames=120, max_side=1024, fps=2.0
) -> dict:
    """Publish a new frame directory only after every selected frame succeeds.

    Photos are ordered by filename. Videos sample their beginning at ``fps``
    until ``max_frames``; this is not automatic viewpoint selection.
    """
    for name, value, maximum in [
        ("max_frames", max_frames, 10000),
        ("max_side", max_side, 8192),
    ]:
        if type(value) is not int or not 1 <= value <= maximum:
            raise ValueError(f"{name} must be an integer in 1..{maximum}")
    if (
        not isinstance(fps, (int, float))
        or not math.isfinite(fps)
        or not 0 < fps <= 120
    ):
        raise ValueError("fps must be finite and in (0, 120]")
    source, output = Path(source).resolve(), Path(output).resolve()
    if output.exists():
        raise FileExistsError(f"Output already exists: {output}")
    if not source.exists():
        raise ValueError(f"Source does not exist: {source}")
    if source.is_dir() and output.is_relative_to(source):
        raise ValueError("Output must be outside the input directory")
    is_video = source.is_file() and source.suffix.lower() in VIDEO_EXTENSIONS
    if source.is_dir():
        photos = sorted(
            (
                p
                for p in source.iterdir()
                if p.is_file() and p.suffix.lower() in PHOTO_EXTENSIONS
            ),
            key=lambda p: p.name,
        )[:max_frames]
    elif source.suffix.lower() in PHOTO_EXTENSIONS:
        photos = [source]
    elif is_video:
        photos = []
    else:
        raise ValueError("Use a supported video, photo, or directory of photos")
    if not is_video and not photos:
        raise ValueError("No supported photos found")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".capture-", dir=output.parent
    ) as temporary:
        staging = Path(temporary) / "publish"
        frames_dir = staging / "frames"
        frames_dir.mkdir(parents=True)
        if is_video:
            ffmpeg = shutil.which("ffmpeg")
            if not ffmpeg:
                raise ValueError(
                    "FFmpeg is required for video input; install it and add it to PATH"
                )
            decoded = Path(temporary) / "decoded"
            decoded.mkdir()
            scale = f"scale=w='min({max_side},iw)':h='min({max_side},ih)':force_original_aspect_ratio=decrease"
            try:
                process = subprocess.run(
                    [
                        ffmpeg,
                        "-nostdin",
                        "-v",
                        "error",
                        "-xerror",
                        "-i",
                        str(source),
                        "-map",
                        "0:v:0",
                        "-vf",
                        f"fps={fps},{scale}",
                        "-frames:v",
                        str(max_frames),
                        str(decoded / "%06d.png"),
                    ],
                    capture_output=True,
                    text=True,
                    errors="replace",
                    timeout=300,
                )
            except subprocess.TimeoutExpired as exc:
                raise ValueError(
                    "FFmpeg exceeded the 300 second capture timeout"
                ) from exc
            if process.returncode:
                raise ValueError(f"FFmpeg failed: {process.stderr[-2000:]}")
            photos = sorted(decoded.glob("*.png"))
            if not photos:
                raise ValueError("FFmpeg produced no frames")
        frames = []
        for index, path in enumerate(photos):
            destination = frames_dir / f"{index:06d}.jpg"
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("error", Image.DecompressionBombWarning)
                    with Image.open(path) as original:
                        if original.width * original.height > 40_000_000:
                            raise ValueError("Image exceeds 40 megapixels")
                        im = ImageOps.exif_transpose(original).convert("RGB")
                        im.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
                        im.info.clear()
                        im.save(destination, "JPEG", quality=95)
                        width, height = im.size
            except (
                OSError,
                ValueError,
                Image.DecompressionBombError,
                Image.DecompressionBombWarning,
            ) as exc:
                raise ValueError(f"Invalid photo {path.name}: {exc}") from exc
            frames.append(
                {
                    "file": f"frames/{destination.name}",
                    "width": width,
                    "height": height,
                    "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
                    "source_frame": index if is_video else path.name,
                }
            )
        manifest = {
            "schema_version": 1,
            "status": "frames_only",
            "training_ready": False,
            "source_kind": "video" if is_video else "photos",
            "sampling": {
                "fps": fps if is_video else None,
                "max_frames": max_frames,
                "max_side": max_side,
                "strategy": "video_start" if is_video else "filename_order",
            },
            "required_next_steps": [
                "person_masks",
                "camera_calibration",
                "smpl_fitting",
                "dataset_adapter",
            ],
            "frames": frames,
        }
        (staging / "manifest.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        # Never intentionally replace an existing output, including one created during decoding.
        if output.exists():
            raise FileExistsError(f"Output appeared during preparation: {output}")
        staging.rename(output)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--max-frames", type=int, default=120)
    parser.add_argument("--max-side", type=int, default=1024)
    parser.add_argument("--fps", type=float, default=2.0)
    args = parser.parse_args()
    try:
        result = prepare_capture(
            args.source,
            args.output,
            max_frames=args.max_frames,
            max_side=args.max_side,
            fps=args.fps,
        )
    except (ValueError, OSError) as exc:
        parser.exit(1, f"Capture failed: {exc}\n")
    print(
        json.dumps(
            {
                "output": str(args.output),
                "frames": len(result["frames"]),
                "status": result["status"],
            }
        )
    )


if __name__ == "__main__":
    main()
