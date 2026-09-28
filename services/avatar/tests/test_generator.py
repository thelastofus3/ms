"""Real Blender integration; opt in with AVATAR_INTEGRATION=1."""

import os
import subprocess
import sys
import threading

import pytest

from avatar_service.packages import read_glb, validate_package


def test_unpinned_mpfb_is_rejected(tmp_path, monkeypatch):
    from avatar_service.generator import generate_avatar
    from avatar_service.models import AvatarProfile

    extension = tmp_path / "src/mpfb"
    extension.mkdir(parents=True)
    (extension / "blender_manifest.toml").write_text('version="0.0.0"')
    monkeypatch.setenv("AVATAR_MPFB", str(extension.parent))
    monkeypatch.setenv("AVATAR_ASSETS", str(tmp_path))
    with pytest.raises(RuntimeError, match="revision"):
        generate_avatar(
            AvatarProfile(name="Invalid"),
            tmp_path / "output",
            blender=__import__("pathlib").Path(sys.executable),
        )


@pytest.mark.skipif(os.getenv("AVATAR_INTEGRATION") != "1", reason="Requires Blender")
def test_cancellation_terminates_started_process(tmp_path, monkeypatch):
    import avatar_service.generator as module
    from avatar_service.generator import generate_avatar
    from avatar_service.models import AvatarProfile

    cancelled = threading.Event()
    processes = []
    real_popen = subprocess.Popen

    def start_then_cancel(*args, **kwargs):
        process = real_popen(*args, **kwargs)
        if "--background" in args[0]:
            processes.append(process)
            cancelled.set()
        return process

    monkeypatch.setattr(module.subprocess, "Popen", start_then_cancel)
    with pytest.raises(RuntimeError, match="cancelled"):
        generate_avatar(
            AvatarProfile(name="Cancelled"), tmp_path / "output", cancelled=cancelled
        )
    assert processes and processes[0].poll() is not None
    assert not (tmp_path / "output").exists()


def test_cancelled_generation_does_not_publish(tmp_path):
    from avatar_service.generator import generate_avatar
    from avatar_service.models import AvatarProfile

    cancelled = threading.Event()
    cancelled.set()
    with pytest.raises(RuntimeError, match="cancelled"):
        generate_avatar(
            AvatarProfile(name="Cancelled"), tmp_path / "result", cancelled=cancelled
        )
    assert not (tmp_path / "result").exists()


def test_cli_reports_missing_blender_without_publishing(tmp_path):
    profile = tmp_path / "profile.json"
    profile.write_text('{"name":"Test"}', encoding="utf-8")
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "avatar_service.cli",
            "generate",
            "--profile",
            str(profile),
            "--output",
            str(tmp_path / "result"),
            "--blender",
            str(tmp_path / "missing.exe"),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "Blender executable not found" in result.stderr
    assert not (tmp_path / "result").exists()


@pytest.mark.skipif(
    os.getenv("AVATAR_INTEGRATION") != "1",
    reason="Requires local Blender and MPFB assets",
)
def test_real_mpfb_export(tmp_path):
    profile = tmp_path / "profile.json"
    profile.write_text('{"name":"Integration","height_m":1.8}', encoding="utf-8")
    output = tmp_path / "result"
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "avatar_service.cli",
            "generate",
            "--profile",
            str(profile),
            "--output",
            str(output),
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    manifest = validate_package(output)
    doc = read_glb(output / "avatar.glb")
    assert manifest.height_m == 1.8
    assert len(doc["meshes"]) >= 4  # Body, eyes, clothes and hair.
    assert max(a["count"] for a in doc["accessors"]) > 1000
    assert {"idle", "walk"} <= set(manifest.clips)
    assert (output / "package.zip").stat().st_size > 10000
    parents = {
        child: i
        for i, node in enumerate(doc["nodes"])
        for child in node.get("children", [])
    }

    def multiply(a, b):
        x, y, z, w = a
        u, v, s, t = b
        return (
            w * u + x * t + y * s - z * v,
            w * v - x * s + y * t + z * u,
            w * s + x * v - y * u + z * t,
            w * t - x * u - y * v - z * s,
        )

    for binding in manifest.rig.values():
        rotation = (0, 0, 0, 1)
        chain = []
        index = binding.node
        while True:
            chain.append(index)
            if index not in parents:
                break
            index = parents[index]
        for index in reversed(chain):
            rotation = multiply(
                rotation, doc["nodes"][index].get("rotation", (0, 0, 0, 1))
            )
        # A canonical axis transformed into bone space and back must remain itself.
        aligned = multiply(rotation, binding.basis)
        assert abs(aligned[3]) == pytest.approx(1, abs=1e-5)


@pytest.mark.skipif(os.getenv("AVATAR_INTEGRATION") != "1", reason="Requires Blender")
@pytest.mark.parametrize("parameter", ["weight", "nose_width"])
def test_body_morphology_is_baked_into_static_geometry(tmp_path, parameter):
    import struct

    from avatar_service.generator import generate_avatar
    from avatar_service.models import AvatarProfile

    def body_vertices(path):
        doc = read_glb(path)
        raw = path.read_bytes()
        json_length = struct.unpack_from("<I", raw, 12)[0]
        binary_offset = 28 + json_length
        mesh = next(m for m in doc["meshes"] if m["name"].startswith("base"))
        a = doc["accessors"][mesh["primitives"][0]["attributes"]["POSITION"]]
        view = doc["bufferViews"][a["bufferView"]]
        offset = binary_offset + view.get("byteOffset", 0) + a.get("byteOffset", 0)
        return [
            struct.unpack_from("<3f", raw, offset + i * view.get("byteStride", 12))
            for i in range(a["count"])
        ]

    for name, weight in [("slim", 0.1), ("heavy", 0.9)]:
        generate_avatar(
            AvatarProfile(name=name, **{parameter: weight}), tmp_path / name
        )
    slim = body_vertices(tmp_path / "slim/avatar.glb")
    heavy = body_vertices(tmp_path / "heavy/avatar.glb")
    # Dropping morph targets without baking made both body meshes byte-identical.
    assert slim != heavy
