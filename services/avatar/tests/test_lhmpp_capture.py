import json

import pytest
from PIL import Image, ImageChops

from avatar_service import lhmpp_capture


def test_selected_views_and_withheld_images_are_explicit(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    for name in ["front.jpg", "back.jpg", "side.jpg"]:
        Image.new("RGB", (20, 30), (30, 60, 90)).save(source / name)
    original = (source / "front.jpg").read_bytes()

    def segment(image):
        mask = Image.new("L", image.size)
        mask.paste(255, (5, 5, 15, 25))
        return mask

    output = tmp_path / "prepared"
    report = lhmpp_capture.prepare(source, output, ["front.jpg", "back.jpg"], segment)
    assert report["selected"] == ["front.jpg", "back.jpg"]
    assert report["withheld"] == ["side.jpg"]
    assert len(report["frames"]) == 3
    assert len(list((output / "selected").glob("*.png"))) == 2
    assert Image.open(output / "selected/00-front.png").size == (504, 840)
    normalized = Image.open(output / "selected/00-front.png")
    assert ImageChops.difference(
        normalized, Image.new("RGB", normalized.size, "white")
    ).getbbox() == (63, 42, 441, 798)
    assert Image.open(output / "selected/00-front.png").getpixel((0, 0)) == (
        255,
        255,
        255,
    )
    assert (source / "front.jpg").read_bytes() == original
    assert json.loads((output / "manifest.json").read_text()) == report


def test_bad_mask_does_not_publish_capture(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    Image.new("RGB", (20, 30)).save(source / "front.jpg")
    Image.new("RGB", (20, 30)).save(source / "back.jpg")
    output = tmp_path / "prepared"
    with pytest.raises(ValueError, match="empty"):
        lhmpp_capture.prepare(
            source,
            output,
            ["front.jpg", "back.jpg"],
            lambda im: Image.new("L", im.size),
        )
    assert not output.exists()


@pytest.mark.parametrize(
    "selection",
    [["front.jpg"], ["front.jpg", "front.jpg"], ["front.jpg", "../back.jpg"]],
)
def test_invalid_multiview_selection_rejected(tmp_path, selection):
    source = tmp_path / "source"
    source.mkdir()
    with pytest.raises(ValueError):
        lhmpp_capture.prepare(source, tmp_path / "out", selection, lambda im: im)
