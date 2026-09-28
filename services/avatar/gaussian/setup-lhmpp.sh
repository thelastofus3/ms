#!/usr/bin/env bash
set -euo pipefail
export PIP_CACHE_DIR=/runtime/pip-cache
python3 -m venv /runtime/env
python -m pip install 'pip<26' 'setuptools<70' wheel ninja
python -m pip install torch==2.3.0 torchvision==0.18.0 xformers==0.0.26.post1 --index-url https://download.pytorch.org/whl/cu121
python -m pip install --find-links /old-cache/wheels \
  numpy==1.26.4 scipy pillow==10.4.0 accelerate==0.30.1 \
  transformers==4.41.2 huggingface-hub==0.23.2 diffusers==0.32.0 \
  einops roma smplx==0.1.28 omegaconf==2.3.0 plyfile trimesh==4.4.9 \
  kornia==0.7.2 timm==1.0.15 addict loguru jaxtyping==0.2.38 \
  typeguard==2.13.3 opencv-python-headless==4.10.0.84 \
  'rembg[cpu]==2.0.63' matplotlib==3.8.4 imageio==2.34.1 \
  imageio-ffmpeg scikit-image kiui==0.2.14 pygltflib==1.16.2 \
  lpips==0.1.4 decord==0.6.0 modelscope ffmpegio megfile==4.1.0.post2 \
  gradio==4.43.0 spaces open3d==0.19.0 pytest fvcore iopath
python -m pip install spconv-cu120
python -m pip install torch-scatter -f https://data.pyg.org/whl/torch-2.3.0+cu121.html
python -m pip install --no-index --no-deps --no-cache-dir pytorch3d -f https://dl.fbaipublicfiles.com/pytorch3d/packaging/wheels/py310_cu121_pyt230/download.html
python -m pip install --no-build-isolation chumpy
python -m pip install gsplat==1.4.0
python -m pip freeze > /runtime/environment.txt
python -c 'import torch, xformers.ops, spconv, torch_scatter, pytorch3d; print(torch.__version__, torch.cuda.get_device_name(0)); print(torch.ones(8,device="cuda").sum().item())'
