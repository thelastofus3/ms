import json
import subprocess
import sys

import pytest

from avatar_service.hugs_runtime import inspect_inputs


def test_missing_assets_are_reported_together(tmp_path):
    result = inspect_inputs(tmp_path, "lab")
    assert result["ready"] is False
    missing = result["missing"]
    assert "smpl/SMPL_NEUTRAL.pkl" in missing
    assert "neuman/dataset/lab/4d_humans/smpl_optimized_aligned_scale.npz" in missing
    assert "SFU/0008/0008_ChaCha001_poses.npz" in missing


def test_frames_manifest_is_not_a_neuman_dataset(tmp_path):
    (tmp_path / "manifest.json").write_text('{"status":"frames_only"}')
    (tmp_path / "frames").mkdir()
    assert not inspect_inputs(tmp_path, "lab")["ready"]


@pytest.mark.parametrize("sequence", ["../lab", "new-person", "/lab"])
def test_unsupported_sequences_are_not_silently_accepted(tmp_path, sequence):
    with pytest.raises(ValueError):
        inspect_inputs(tmp_path, sequence)


def test_empty_assets_do_not_satisfy_preflight(tmp_path):
    (tmp_path / "smpl").mkdir()
    (tmp_path / "smpl/SMPL_NEUTRAL.pkl").touch()
    assert "smpl/SMPL_NEUTRAL.pkl" in inspect_inputs(tmp_path, "lab")["missing"]


def test_run_stops_before_importing_cuda_when_assets_missing(tmp_path):
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "avatar_service.hugs_runtime",
            "--data",
            str(tmp_path),
            "--action",
            "train",
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 2
    report = json.loads(result.stdout)
    assert not report["ready"]
    assert "Traceback" not in result.stderr


def test_training_selects_one_upstream_config_before_sequence_override():
    from avatar_service.hugs_runtime import training_command

    command = training_command("lab", 100)
    # Upstream otherwise expands six configs before applying dataset.seq=lab.
    assert command[command.index("--cfg_id") + 1] == "0"
    assert "dataset.seq=lab" in command
    assert "train.num_steps=100" in command


def test_missing_assets_replace_stale_success_report(tmp_path):
    report_path = tmp_path / "run.json"
    report_path.write_text('{"status":"completed"}')
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "avatar_service.hugs_runtime",
            "--data",
            str(tmp_path),
            "--action",
            "evaluate",
            "--report",
            str(report_path),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 2
    assert json.loads(report_path.read_text())["status"] == "blocked"


def test_author_checkpoint_legacy_model_name_is_mapped_for_current_loader(tmp_path):
    from avatar_service.hugs_runtime import evaluation_command

    command = evaluation_command(tmp_path, "lab", "hugs_triplane")
    assert "human.name=hugs_trimlp" in command
    with pytest.raises(ValueError):
        evaluation_command(tmp_path, "lab", "unknown_model")
