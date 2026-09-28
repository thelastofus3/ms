import subprocess
import sys

import pytest

from avatar_service.hugs_preview import render_canonical


def test_existing_preview_is_not_overwritten(tmp_path):
    output = tmp_path / "output"
    output.mkdir()
    (output / "report.json").write_text("keep")
    with pytest.raises(FileExistsError):
        render_canonical(tmp_path / "checkpoint", output)
    assert (output / "report.json").read_text() == "keep"


def test_missing_checkpoint_does_not_publish_or_import_cuda(tmp_path):
    with pytest.raises(FileNotFoundError, match="config_train.yaml"):
        render_canonical(tmp_path / "checkpoint", tmp_path / "output")
    assert not (tmp_path / "output").exists()


def test_preview_help_works_without_research_dependencies():
    result = subprocess.run(
        [sys.executable, "-m", "avatar_service.hugs_preview", "--help"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0
    assert "--checkpoint" in result.stdout
    assert "--output" in result.stdout
