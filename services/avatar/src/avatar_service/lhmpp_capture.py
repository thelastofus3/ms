"""Local, explicit multiview preparation for the experimental LHM++ runner."""

import argparse
import hashlib
import json
import shutil
import tempfile
from pathlib import Path

from PIL import Image, ImageOps


def prepare(source, output, selected, segment):
    source, output = Path(source).resolve(), Path(output).resolve()
    selected = list(selected)
    if not 2 <= len(selected) <= 24 or len(set(selected)) != len(selected):
        raise ValueError("Select 2-24 distinct views")
    if any(Path(n).name != n or "/" in n or "\\" in n for n in selected):
        raise ValueError("Selected views must be filenames within the capture")
    photos = sorted(
        p
        for p in source.iterdir()
        if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
    )
    names = [p.name for p in photos]
    if not set(selected).issubset(names):
        raise ValueError("Selected view is missing from capture")
    if output.exists():
        raise FileExistsError(output)
    if output.is_relative_to(source):
        raise ValueError("Output must be outside the source capture")
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "version": 1,
        "selected": selected,
        "withheld": [n for n in names if n not in selected],
        "selection_method": "explicit filenames; no inferred camera calibration",
        "output_size": [504, 840],
        "frames": [],
    }
    with tempfile.TemporaryDirectory(
        prefix=".lhmpp-capture-", dir=output.parent
    ) as tmp:
        staging = Path(tmp) / "capture"
        for directory in ["all", "masks", "selected"]:
            (staging / directory).mkdir(parents=True)
        for path in photos:
            with Image.open(path) as original:
                image = ImageOps.exif_transpose(original).convert("RGB")
            mask = segment(image).convert("L")
            if mask.size != image.size:
                raise ValueError(f"Mask size mismatch: {path.name}")
            bbox = mask.point(lambda p: 255 if p > 127 else 0).getbbox()
            if bbox is None:
                raise ValueError(f"Person mask is empty: {path.name}")
            foreground = Image.composite(
                image, Image.new("RGB", image.size, "white"), mask
            ).crop(bbox)
            scale = min(454 / foreground.width, 756 / foreground.height)
            foreground = foreground.resize(
                (
                    max(1, round(foreground.width * scale)),
                    max(1, round(foreground.height * scale)),
                ),
                Image.Resampling.LANCZOS,
            )
            canvas = Image.new("RGB", (504, 840), "white")
            canvas.paste(
                foreground,
                ((504 - foreground.width) // 2, (840 - foreground.height) // 2),
            )
            normalized_name = path.name + ".png"
            canvas.save(staging / "all" / normalized_name)
            mask.save(staging / "masks" / normalized_name)
            if path.name in selected:
                index = selected.index(path.name)
                shutil.copyfile(
                    staging / "all" / normalized_name,
                    staging / "selected" / f"{index:02d}-{path.stem}.png",
                )
            report["frames"].append(
                {
                    "source": path.name,
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "size": list(image.size),
                    "bbox": list(bbox),
                    "normalized": "all/" + normalized_name,
                    "mask": "masks/" + normalized_name,
                }
            )
            print("Prepared", path.name, bbox, flush=True)
        (staging / "manifest.json").write_text(
            json.dumps(report, indent=2), encoding="utf-8"
        )
        staging.rename(output)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--views", nargs="+", required=True)
    args = parser.parse_args()
    import rembg

    session = rembg.new_session("u2net_human_seg", providers=["CPUExecutionProvider"])
    prepare(
        args.input,
        args.output,
        args.views,
        lambda image: rembg.remove(image, session=session, only_mask=True),
    )


if __name__ == "__main__":
    main()
