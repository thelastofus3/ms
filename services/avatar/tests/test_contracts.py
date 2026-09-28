import json
import struct
from pathlib import Path

import pytest
from pydantic import ValidationError

from avatar_service.models import BONE_NAMES, AvatarProfile, Manifest, PoseFrame
from avatar_service.packages import PackageError, validate_package, write_package


def test_profile_rejects_nonfinite_height_and_asset_paths():
    for value in [0, -1, float("nan"), float("inf"), 5]:
        with pytest.raises(ValidationError):
            AvatarProfile(name="Example", height_m=value)
    with pytest.raises(ValidationError):
        AvatarProfile(name="Example", clothing="../secret")


def test_pose_requires_normalized_rotation_and_valid_confidence():
    with pytest.raises(ValidationError):
        PoseFrame(sequence=1, timestamp_ms=1000, joints={"head": [0, 0, 0, 0]})
    with pytest.raises(ValidationError):
        PoseFrame(sequence=1, timestamp_ms=1000, confidence=2)
    with pytest.raises(ValidationError):
        PoseFrame(sequence=1, timestamp_ms=1000, joints={"unknown": [0, 0, 0, 1]})


def fixture_glb(path: Path):
    # Test-only miniature skinned mesh; not an avatar generation fallback.
    binary = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
    binary += bytes(12) + struct.pack("<12f", *([1, 0, 0, 0] * 3))
    document = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": n} for n in BONE_NAMES] + [{"mesh": 0, "skin": 0}],
        "skins": [{"joints": list(range(len(BONE_NAMES)))}],
        "meshes": [
            {
                "primitives": [
                    {"attributes": {"POSITION": 0, "JOINTS_0": 1, "WEIGHTS_0": 2}}
                ]
            }
        ],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": 36},
            {"buffer": 0, "byteOffset": 36, "byteLength": 12},
            {"buffer": 0, "byteOffset": 48, "byteLength": 48},
        ],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": 3,
                "type": "VEC3",
                "min": [0, 0, 0],
                "max": [1, 1, 0],
            },
            {"bufferView": 1, "componentType": 5121, "count": 3, "type": "VEC4"},
            {"bufferView": 2, "componentType": 5126, "count": 3, "type": "VEC4"},
        ],
    }
    document["nodes"][0]["children"] = list(range(1, len(document["nodes"])))
    raw = json.dumps(document).encode()
    raw += b" " * (-len(raw) % 4)
    path.write_bytes(
        struct.pack("<III", 0x46546C67, 2, 28 + len(raw) + len(binary))
        + struct.pack("<II", len(raw), 0x4E4F534A)
        + raw
        + struct.pack("<II", len(binary), 0x004E4942)
        + binary
    )
    return document


def test_package_detects_corruption_and_missing_bone(tmp_path):
    glb = tmp_path / "avatar.glb"
    fixture_glb(glb)
    mapping = {
        n: {"node": i, "rest": [0, 0, 0, 1], "basis": [0, 0, 0, 1]}
        for i, n in enumerate(BONE_NAMES)
    }
    manifest = write_package(
        tmp_path, AvatarProfile(name="Example"), mapping, generator="test-fixture"
    )
    assert validate_package(tmp_path).representation == "skinned-glb"
    assert (tmp_path / "package.zip").exists()
    glb.write_bytes(glb.read_bytes()[:-8])
    with pytest.raises(PackageError):
        validate_package(tmp_path)
    fixture_glb(glb)
    raw = manifest.model_dump(mode="json")
    del raw["rig"]["head"]
    (tmp_path / "manifest.json").write_text(json.dumps(raw))
    with pytest.raises(PackageError):
        validate_package(tmp_path)


def test_manifest_refuses_traversal():
    with pytest.raises(ValidationError):
        Manifest(model_file="../other.glb", sha256="0" * 64, height_m=1.7, rig={})


@pytest.mark.parametrize(
    "fault",
    [
        "accessor_overflow",
        "empty_primitives",
        "invalid_joint",
        "invalid_mesh",
        "invalid_child",
        "cycle",
        "invalid_scene",
        "invalid_animation_accessor",
        "invalid_inverse_bind",
    ],
)
def test_glb_rejects_broken_internal_references(tmp_path, fault):
    from avatar_service.packages import read_glb

    path = tmp_path / "avatar.glb"
    doc = fixture_glb(path)
    raw = path.read_bytes()
    json_size = struct.unpack_from("<I", raw, 12)[0]
    binary = raw[28 + json_size :]
    if fault == "accessor_overflow":
        doc["accessors"][0]["count"] = 1000000
    elif fault == "empty_primitives":
        doc["meshes"][0]["primitives"] = []
    elif fault == "invalid_joint":
        doc["skins"][0]["joints"][0] = 9999
    elif fault == "invalid_child":
        doc["nodes"][0]["children"] = [999999]
    elif fault == "cycle":
        doc["nodes"][0]["children"].append(0)
    elif fault == "invalid_scene":
        doc["scenes"][0]["nodes"] = [999999]
    elif fault == "invalid_animation_accessor":
        doc["animations"] = [
            {
                "samplers": [{"input": 99999, "output": 0}],
                "channels": [{"sampler": 0, "target": {"node": 0, "path": "rotation"}}],
            }
        ]
    elif fault == "invalid_inverse_bind":
        doc["skins"][0]["inverseBindMatrices"] = 99999
    else:
        doc["nodes"][-1]["mesh"] = 99
    encoded = json.dumps(doc).encode()
    encoded += b" " * (-len(encoded) % 4)
    path.write_bytes(
        struct.pack("<III", 0x46546C67, 2, 28 + len(encoded) + len(binary))
        + struct.pack("<II", len(encoded), 0x4E4F534A)
        + encoded
        + struct.pack("<II", len(binary), 0x004E4942)
        + binary
    )
    with pytest.raises(PackageError):
        read_glb(path)
