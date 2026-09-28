import hashlib
import json
import shutil
import subprocess

import pytest
from PIL import Image

from avatar_service.capture import prepare_capture


def test_photos_normalized_hashed_and_marked_incomplete(tmp_path):
    source = tmp_path / "my photos"
    source.mkdir()
    Image.new("RGBA", (400, 200), "red").save(source / "a.png")
    Image.new("RGB", (100, 100), "blue").save(source / "b.jpg")
    output = tmp_path / "capture"
    result = prepare_capture(source, output, max_side=100, max_frames=1)
    assert result == json.loads((output / "manifest.json").read_text())
    assert result["status"] == "frames_only"
    assert result["training_ready"] is False
    assert len(result["frames"]) == 1
    frame = result["frames"][0]
    path = output / frame["file"]
    with Image.open(path) as im:
        assert im.size == (100, 50)
        assert im.mode == "RGB"
    assert frame["sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
    assert (source / "b.jpg").is_file()


def test_exif_rotation_and_metadata_removed(tmp_path):
    source = tmp_path / "photos"
    source.mkdir()
    exif = Image.Exif()
    exif[274] = 6
    exif[315] = "private author"
    Image.new("RGB", (80, 40)).save(source / "image.jpg", exif=exif)
    output = tmp_path / "out"
    result = prepare_capture(source, output)
    with Image.open(output / result["frames"][0]["file"]) as im:
        assert im.size == (40, 80)
        assert not im.getexif()


@pytest.mark.parametrize(
    "limits",
    [
        {"max_frames": 0},
        {"max_frames": 10001},
        {"max_frames": 1.5},
        {"max_side": 0},
        {"max_side": 8193},
        {"fps": 0},
        {"fps": float("nan")},
        {"fps": float("inf")},
    ],
)
def test_invalid_limits_do_not_publish(tmp_path, limits):
    with pytest.raises(ValueError):
        prepare_capture(tmp_path, tmp_path / "output", **limits)
    assert not (tmp_path / "output").exists()


def test_corrupt_photo_does_not_publish_partial_result(tmp_path):
    source = tmp_path / "photos"
    source.mkdir()
    Image.new("RGB", (8, 8)).save(source / "a.png")
    (source / "b.jpg").write_bytes(b"broken")
    output = tmp_path / "output"
    with pytest.raises(ValueError):
        prepare_capture(source, output)
    assert not output.exists()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["photos"]


def test_existing_output_and_source_are_preserved(tmp_path):
    output = tmp_path / "output"
    output.mkdir()
    sentinel = output / "keep.txt"
    sentinel.write_text("keep")
    with pytest.raises(FileExistsError):
        prepare_capture(tmp_path, output)
    assert sentinel.read_text() == "keep"


def test_output_inside_source_is_rejected(tmp_path):
    Image.new("RGB", (8, 8)).save(tmp_path / "a.jpg")
    with pytest.raises(ValueError):
        prepare_capture(tmp_path, tmp_path / "nested" / "output")
    assert not (tmp_path / "nested").exists()


def test_empty_input_is_rejected(tmp_path):
    source = tmp_path / "empty"
    source.mkdir()
    with pytest.raises(ValueError):
        prepare_capture(source, tmp_path / "output")


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg not installed")
def test_real_video_sampling_and_size_limit(tmp_path):
    source = tmp_path / "video with spaces.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=10",
            "-t",
            "2",
            "-pix_fmt",
            "yuv420p",
            str(source),
        ],
        check=True,
        timeout=30,
    )
    output = tmp_path / "output with spaces"
    result = prepare_capture(source, output, fps=2, max_frames=3, max_side=100)
    assert result["source_kind"] == "video"
    assert len(result["frames"]) == 3
    for frame in result["frames"]:
        with Image.open(output / frame["file"]) as im:
            assert max(im.size) <= 100


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg not installed")
def test_failed_ffmpeg_does_not_publish(tmp_path):
    source = tmp_path / "broken.mp4"
    source.write_bytes(b"bad video")
    with pytest.raises(ValueError, match="FFmpeg"):
        prepare_capture(source, tmp_path / "output")
    assert not (tmp_path / "output").exists()
