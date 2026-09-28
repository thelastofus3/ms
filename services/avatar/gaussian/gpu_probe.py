"""Execute CUDA and HUGS native kernels, independently of licensed SMPL assets."""

import json
import time

import torch
from diff_gaussian_rasterization import (
    GaussianRasterizationSettings,
    GaussianRasterizer,
)
from pytorch3d.ops import knn_points
from simple_knn._C import distCUDA2

assert torch.cuda.is_available(), "CUDA unavailable: use docker run --gpus all"
torch.cuda.reset_peak_memory_stats()
started = time.monotonic()
points = torch.rand(128, 3, device="cuda")
distances = distCUDA2(points)
assert torch.isfinite(distances).all()
knn = knn_points(points[None], points[None], K=2)
assert torch.isfinite(knn.dists).all()
settings = GaussianRasterizationSettings(
    image_height=64,
    image_width=64,
    tanfovx=1.0,
    tanfovy=1.0,
    bg=torch.zeros(3, device="cuda"),
    scale_modifier=1.0,
    viewmatrix=torch.eye(4, device="cuda"),
    projmatrix=torch.eye(4, device="cuda"),
    sh_degree=0,
    campos=torch.zeros(3, device="cuda"),
    prefiltered=False,
    debug=False,
)
rendered, radii = GaussianRasterizer(settings)(
    means3D=torch.tensor([[0.0, 0.0, 1.0]], device="cuda"),
    means2D=torch.zeros(1, 3, device="cuda"),
    colors_precomp=torch.ones(1, 3, device="cuda"),
    opacities=torch.ones(1, 1, device="cuda"),
    scales=torch.full((1, 3), 0.1, device="cuda"),
    rotations=torch.tensor([[1.0, 0.0, 0.0, 0.0]], device="cuda"),
)
assert torch.isfinite(rendered).all() and rendered.sum() > 0 and radii.max() > 0
torch.cuda.synchronize()
print(
    json.dumps(
        {
            "status": "cuda_kernels_passed",
            "avatar_inference": False,
            "gpu": torch.cuda.get_device_name(),
            "torch": torch.__version__,
            "cuda": torch.version.cuda,
            "elapsed_seconds": time.monotonic() - started,
            "peak_allocated_bytes": torch.cuda.max_memory_allocated(),
            "peak_reserved_bytes": torch.cuda.max_memory_reserved(),
        },
        indent=2,
    )
)
