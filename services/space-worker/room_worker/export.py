import hashlib
import math
from pathlib import Path
import numpy as np
from plyfile import PlyData
import spz
from .settings import MAX_SPLATS


def digest(path, progress=None):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b""):
            result.update(chunk)
            if progress:
                progress(len(chunk))
    return result.hexdigest()


def compress(ply: Path, output: Path, lease=None):
    """Construct the cloud explicitly: never infer a world-axis flip from the PLY suffix."""
    def activity(message):
        if lease:
            lease.progress("Compress scene", message, force=True)
    activity("Reading exported Gaussians")
    vertices = PlyData.read(str(ply))["vertex"].data
    fields = vertices.dtype.names
    required = ["x", "y", "z", "opacity", *[f"scale_{i}" for i in range(3)], *[f"rot_{i}" for i in range(4)], *[f"f_dc_{i}" for i in range(3)]]
    if not all(name in fields for name in required):
        raise ValueError("Trainer did not export a Gaussian PLY")
    count = len(vertices)
    if not 100 <= count <= MAX_SPLATS:
        raise ValueError(f"Export has {count} splats; browser limit is {MAX_SPLATS}. Use a smaller training profile.")
    def stack(names):
        values = np.column_stack([vertices[name] for name in names]).astype(np.float32)
        if not np.isfinite(values).all():
            raise ValueError("Gaussian export contains nonfinite values")
        return values
    activity("Packing Gaussian positions and appearance")
    cloud = spz.GaussianCloud()
    cloud.positions = stack(["x", "y", "z"]).flatten()
    cloud.scales = stack([f"scale_{i}" for i in range(3)]).flatten()
    rotations = stack(["rot_1", "rot_2", "rot_3", "rot_0"])
    rotations /= np.maximum(np.linalg.norm(rotations, axis=1, keepdims=True), 1e-8)
    cloud.rotations = rotations.flatten()
    cloud.alphas = stack(["opacity"]).flatten()
    # SPZ's cloud API stores SH DC coefficients here, despite the field name.
    cloud.colors = stack([f"f_dc_{i}" for i in range(3)]).flatten()
    rest = sorted([name for name in fields if name.startswith("f_rest_")], key=lambda name: int(name.split("_")[-1]))
    coefficients = len(rest)//3
    degree = int(math.sqrt(coefficients+1)-1)
    if len(rest)%3 or (degree+1)**2-1 != coefficients:
        raise ValueError("Invalid spherical-harmonic layout")
    cloud.sh_degree = degree
    if rest:
        cloud.sh = stack(rest).reshape(count, 3, coefficients).transpose(0, 2, 1).flatten()
    cloud.antialiased = False
    options = spz.PackOptions()
    options.from_coord = spz.CoordinateSystem.RUB
    # Default SPZ v3 avoids newer format features absent in the pinned Spark loader.
    options.version = 3
    activity("Encoding the compressed browser scene")
    if not spz.save_spz(cloud, options, str(output / "room.spz")):
        raise ValueError("SPZ encoder could not export the scene")
    return {"splats": count, "shDegree": degree}
