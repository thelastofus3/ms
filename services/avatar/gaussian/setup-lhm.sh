#!/usr/bin/env bash
# Run inside existing CUDA base, with /runtime on the roomy external data disk.
set -euo pipefail
export MAMBA_ROOT_PREFIX=/runtime/mamba
export PIP_CACHE_DIR=/runtime/pip-cache
unset PIP_NO_CACHE_DIR
export PIP_NO_COMPILE=1
export TMPDIR=${TMPDIR:-/tmp/lhm-build}
export PIP_FIND_LINKS=/runtime/wheels
export TORCH_CUDA_ARCH_LIST=7.5
export MAX_JOBS=2
mkdir -p "$TMPDIR" /runtime/bin /runtime/wheels
if [ ! -x /runtime/bin/micromamba ]; then
  curl --fail --location --retry 3 https://micro.mamba.pm/api/micromamba/linux-64/latest -o /runtime/micromamba.tar.bz2
  tar -xjf /runtime/micromamba.tar.bz2 -C /runtime bin/micromamba
fi
if [ ! -x /runtime/env/bin/python ]; then
  /runtime/bin/micromamba create -y -p /runtime/env -c conda-forge python=3.10 pip
fi
export PATH=/runtime/env/bin:$PATH
install_cached() {
  if ! python -m pip install --no-index "$@"; then
    python -m pip install "$@"
  fi
}
install_cached 'torch==2.3.0' 'torchvision==0.18.0' 'xformers==0.0.26.post1' --index-url https://download.pytorch.org/whl/cu118
install_cached 'numpy==1.23.5' 'setuptools==69.5.1' 'wheel==0.43.0' 'Cython==3.0.12'
install_cached --no-build-isolation 'numpy==1.23.5' 'diffusers==0.32.0' 'transformers==4.41.2' 'accelerate==0.30.1' 'huggingface-hub==0.28.1' 'safetensors==0.5.3' 'timm==1.0.15' 'omegaconf==2.3.0' 'einops==0.8.1' 'smplx==0.1.28' 'trimesh==4.4.9' 'plyfile==1.0.3' 'opencv-python-headless==4.10.0.84' 'scipy==1.13.1' 'Pillow==10.4.0' 'jaxtyping==0.2.38' 'typeguard==2.13.3' 'loguru==0.7.3' 'roma==1.5.1' 'ninja==1.11.1.3' 'iopath==0.1.10' 'pyrender==0.1.45' 'gsplat==1.4.0' 'rembg==2.0.63' 'onnxruntime==1.20.1' 'basicsr==1.4.2'
python -m pip freeze > /runtime/environment.txt
