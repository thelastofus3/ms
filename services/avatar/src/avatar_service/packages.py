"""Validate self-contained GLBs and publish portable, checksummed packages."""

import hashlib
import json
import struct
import zipfile
from pathlib import Path
from uuid import uuid4

from .models import AvatarProfile, Manifest


class PackageError(ValueError):
    pass


def read_glb(path: Path):
    raw = path.read_bytes()
    if len(raw) < 20:
        raise PackageError("Truncated GLB")
    magic, version, size = struct.unpack_from("<III", raw)
    if (magic, version, size) != (0x46546C67, 2, len(raw)):
        raise PackageError("Invalid GLB header")
    offset = 12
    chunks = []
    while offset < len(raw):
        if offset + 8 > len(raw):
            raise PackageError("Truncated chunk header")
        length, kind = struct.unpack_from("<II", raw, offset)
        offset += 8
        if length % 4 or offset + length > len(raw):
            raise PackageError("Invalid GLB chunk size")
        chunks.append((kind, raw[offset : offset + length]))
        offset += length
    if not chunks or chunks[0][0] != 0x4E4F534A:
        raise PackageError("Missing JSON chunk")
    try:
        doc = json.loads(chunks[0][1])
    except (ValueError, UnicodeError) as exc:
        raise PackageError("Invalid GLB JSON") from exc
    if doc.get("asset", {}).get("version") != "2.0":
        raise PackageError("Unsupported glTF version")
    if any("uri" in x for x in doc.get("buffers", []) + doc.get("images", [])):
        raise PackageError("External resources are not allowed")
    if not doc.get("skins") or not doc.get("meshes"):
        raise PackageError("Skinned mesh required")
    binaries = [data for kind, data in chunks if kind == 0x004E4942]
    if (
        len(binaries) != 1
        or not doc.get("buffers")
        or doc["buffers"][0]["byteLength"] > len(binaries[0])
    ):
        raise PackageError("Missing or truncated binary buffer")
    for view in doc.get("bufferViews", []):
        if (
            view.get("buffer", 0) != 0
            or view.get("byteOffset", 0) < 0
            or view.get("byteLength", 0) < 0
            or view.get("byteOffset", 0) + view["byteLength"] > len(binaries[0])
        ):
            raise PackageError("Invalid buffer view")
    sizes = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
    components = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
    for accessor in doc.get("accessors", []):
        if "sparse" in accessor:
            raise PackageError(
                "Sparse accessors are not supported by this package version"
            )
        index = accessor.get("bufferView", -1)
        if not isinstance(index, int) or not 0 <= index < len(
            doc.get("bufferViews", [])
        ):
            raise PackageError("Invalid accessor buffer view")
        view = doc["bufferViews"][index]
        element = sizes.get(accessor.get("componentType"), 0) * components.get(
            accessor.get("type"), 0
        )
        count = accessor.get("count", 0)
        offset = accessor.get("byteOffset", 0)
        stride = view.get("byteStride", element)
        if (
            not element
            or not isinstance(count, int)
            or count < 1
            or offset < 0
            or stride < element
            or offset + (count - 1) * stride + element > view["byteLength"]
        ):
            raise PackageError("Accessor exceeds buffer view")
    nodes = doc.get("nodes", [])

    def valid_index(index, items):
        return type(index) is int and 0 <= index < len(items)

    parents = {}
    for index, node in enumerate(nodes):
        for child in node.get("children", []):
            if not valid_index(child, nodes) or child in parents:
                raise PackageError("Invalid child or multiple node parents")
            parents[child] = index
    # Iterative parent traversal avoids recursion limits on malformed deep trees.
    visited = set()
    for index in range(len(nodes)):
        path = set()
        while index not in visited:
            if index in path:
                raise PackageError("Cycle in node hierarchy")
            path.add(index)
            if index not in parents:
                break
            index = parents[index]
        visited.update(path)
    scenes = doc.get("scenes", [])
    if not scenes or not valid_index(doc.get("scene", 0), scenes):
        raise PackageError("Invalid default scene")
    for scene in scenes:
        for index in scene.get("nodes", []):
            if not valid_index(index, nodes) or index in parents:
                raise PackageError("Invalid scene root")
    accessors = doc.get("accessors", [])
    for skin in doc["skins"]:
        if "skeleton" in skin and not valid_index(skin["skeleton"], nodes):
            raise PackageError("Invalid skeleton root")
        if "inverseBindMatrices" in skin:
            index = skin["inverseBindMatrices"]
            if not valid_index(index, accessors):
                raise PackageError("Invalid inverse bind accessor")
            accessor = accessors[index]
            if (
                accessor["type"] != "MAT4"
                or accessor["componentType"] != 5126
                or accessor["count"] < len(skin["joints"])
            ):
                raise PackageError("Invalid inverse bind matrices")
        if not skin.get("joints") or any(
            not isinstance(i, int) or not 0 <= i < len(nodes) for i in skin["joints"]
        ):
            raise PackageError("Invalid skin joint")
    for animation in doc.get("animations", []):
        samplers = animation.get("samplers", [])
        for sampler in samplers:
            if not valid_index(sampler.get("input"), accessors) or not valid_index(
                sampler.get("output"), accessors
            ):
                raise PackageError("Invalid animation accessor")
        for channel in animation.get("channels", []):
            if not valid_index(channel.get("sampler"), samplers) or not valid_index(
                channel.get("target", {}).get("node"), nodes
            ):
                raise PackageError("Invalid animation target")
    for node in nodes:
        if "mesh" in node:
            if not isinstance(node["mesh"], int) or not 0 <= node["mesh"] < len(
                doc["meshes"]
            ):
                raise PackageError("Invalid mesh index")
            if not isinstance(node.get("skin"), int) or not 0 <= node["skin"] < len(
                doc["skins"]
            ):
                raise PackageError("Mesh node must have a skin")
    for mesh in doc["meshes"]:
        if not mesh.get("primitives"):
            raise PackageError("Empty mesh")
        for primitive in mesh.get("primitives", []):
            if (
                not {"POSITION", "JOINTS_0", "WEIGHTS_0"}
                <= primitive.get("attributes", {}).keys()
            ):
                raise PackageError("Every primitive must be skinned")
            references = list(primitive["attributes"].values())
            if "indices" in primitive:
                references.append(primitive["indices"])
            if any(
                not isinstance(i, int) or not 0 <= i < len(doc.get("accessors", []))
                for i in references
            ):
                raise PackageError("Invalid primitive accessor")
    return doc


def validate_package(directory: Path) -> Manifest:
    try:
        manifest = Manifest.model_validate_json(
            (directory / "manifest.json").read_text(encoding="utf-8")
        )
        glb = directory / manifest.model_file
        if hashlib.sha256(glb.read_bytes()).hexdigest() != manifest.sha256:
            raise PackageError("Checksum mismatch")
        doc = read_glb(glb)
        joints = {index for skin in doc["skins"] for index in skin["joints"]}
        for binding in manifest.rig.values():
            if binding.node >= len(doc["nodes"]) or binding.node not in joints:
                raise PackageError("Mapped bone is not a skin joint")
        return manifest
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise PackageError(str(exc)) from exc


def write_package(
    directory: Path,
    profile: AvatarProfile,
    rig: dict,
    *,
    generator="mpfb",
    revision="",
    avatar_id=None,
    version=1,
):
    doc = read_glb(directory / "avatar.glb")
    manifest = Manifest(
        avatar_id=avatar_id or uuid4(),
        version=version,
        sha256=hashlib.sha256((directory / "avatar.glb").read_bytes()).hexdigest(),
        height_m=profile.height_m,
        rig=rig,
        generator=generator,
        generator_revision=revision,
        clips=[a["name"] for a in doc.get("animations", []) if "name" in a],
    )
    (directory / "manifest.json").write_text(
        manifest.model_dump_json(indent=2), encoding="utf-8"
    )
    validate_package(directory)
    with zipfile.ZipFile(
        directory / "package.zip", "w", zipfile.ZIP_DEFLATED
    ) as archive:
        for name in ("manifest.json", "avatar.glb"):
            archive.write(directory / name, name)
    return manifest
