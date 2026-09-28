import pytest

from avatar_service.hugs_browser import export_browser


def test_export_does_not_replace_existing_package(tmp_path):
    output = tmp_path / "package"
    output.mkdir()
    (output / "keep").write_text("original")
    with pytest.raises(FileExistsError):
        export_browser(tmp_path, tmp_path / "absent.ply", tmp_path, output)
    assert (output / "keep").read_text() == "original"


def test_export_requires_checkpoint_before_loading_cuda(tmp_path):
    with pytest.raises(FileNotFoundError, match="human_final.pth"):
        export_browser(tmp_path, tmp_path / "absent.ply", tmp_path, tmp_path / "output")
    assert not (tmp_path / "output").exists()
