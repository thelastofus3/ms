#!/usr/bin/env bash
set -euo pipefail
export PATH=/runtime/env/bin:$PATH
export TMPDIR=${TMPDIR:-/tmp/lhm-build}
export PIP_CACHE_DIR=/runtime/pip-cache
unset PIP_NO_CACHE_DIR
export PIP_NO_COMPILE=1
export CUDA_HOME=/usr/local/cuda
export TORCH_CUDA_ARCH_LIST=7.5
export FORCE_CUDA=1
export MAX_JOBS=2
mkdir -p /runtime/src "$TMPDIR"
python -m pip install 'setuptools==69.5.1' 'wheel==0.43.0' 'kornia==0.7.2' 'fvcore==0.1.5.post20221221' 'matplotlib==3.8.4'
python -m pip install --no-build-isolation 'chumpy==0.70'
checkout() {
  local name="$1" url="$2" revision="$3"
  if [ ! -d "/runtime/src/$name/.git" ]; then git clone "$url" "/runtime/src/$name"; fi
  git -C "/runtime/src/$name" checkout --detach "$revision"
  git -C "/runtime/src/$name" submodule update --init --recursive
  python -m pip install --no-build-isolation --no-deps "/runtime/src/$name"
}
checkout pytorch3d https://github.com/facebookresearch/pytorch3d.git 89653419d0973396f3eff1a381ba09a07fffc2ed
checkout gaussian-rasterizer https://github.com/ashawkey/diff-gaussian-rasterization.git 8829d14f814fccdaf840b7b0f3021a616583c0a1
checkout simple-knn https://github.com/camenduru/simple-knn.git 60f461f4a56b7967e5d8045bf92f8c33f36976d0
python -m pip freeze > /runtime/environment.txt
