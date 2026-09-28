#!/usr/bin/env bash
set -euo pipefail
export PIP_CACHE_DIR=/runtime/pip-cache
export FORCE_CUDA=1 TORCH_CUDA_ARCH_LIST=7.5 MAX_JOBS=2
mkdir -p /runtime/src
checkout() {
  local name="$1" url="$2" revision="$3"
  if [ ! -d "/runtime/src/$name/.git" ]; then git clone "$url" "/runtime/src/$name"; fi
  git -C "/runtime/src/$name" checkout --detach "$revision"
  git -C "/runtime/src/$name" submodule update --init --recursive
  python -m pip install --no-build-isolation --no-deps "/runtime/src/$name"
}
checkout gaussian-rasterizer https://github.com/ashawkey/diff-gaussian-rasterization.git 8829d14f814fccdaf840b7b0f3021a616583c0a1
checkout simple-knn https://github.com/camenduru/simple-knn.git 60f461f4a56b7967e5d8045bf92f8c33f36976d0
cp -r /opt/lhmpp/lib/pointops /runtime/src/pointops
python -m pip install --no-build-isolation --no-deps /runtime/src/pointops
python -m pip freeze > /runtime/environment.txt
python -c 'import torch; import pointops_cuda, diff_gaussian_rasterization, simple_knn._C; print("CUDA extensions imported")'
