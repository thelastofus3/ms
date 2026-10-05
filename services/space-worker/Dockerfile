FROM ghcr.io/nerfstudio-project/nerfstudio:1.1.5@sha256:b59b8e1012d7a43679d3234b3de9c8416a4b8435fcbf21b9d8c4494b8563f19e AS runtime-deps
ENV DEBIAN_FRONTEND=noninteractive QT_QPA_PLATFORM=offscreen TORCH_CUDA_ARCH_LIST="7.5;8.6;8.9" MAX_JOBS=2 PYTHONUNBUFFERED=1
ENV TORCH_HOME=/opt/room-models/torch ROOM_LOCALIZER_TORCH_THREADS=2
RUN apt-get update && apt-get install -y --no-install-recommends git cmake ninja-build zlib1g-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /worker
COPY requirements.txt .
RUN printf 'torch==2.1.2+cu118\ntorchvision==0.16.2+cu118\nnumpy==1.26.4\n' > /tmp/room-constraints.txt \
    && python -m pip install --no-cache-dir -c /tmp/room-constraints.txt -r requirements.txt
# The upstream image's optional pyceres 2.1 binding conflicts with pycolmap 3.11.
# COLMAP performs bundle adjustment in its CLI; this worker does not use pyceres.
RUN python -m pip uninstall -y pyceres
# Keep checked model weights in their own cached layer, before application code.
COPY room_worker/localizer_models.py /tmp/room-localizer-models.py
RUN python /tmp/room-localizer-models.py --download \
    && rm /tmp/room-localizer-models.py
FROM runtime-deps AS runtime
# Reconstruction keeps the upstream Torch cache; learned camera matching selects
# its separate baked model directory inside its disposable CPU subprocess.
ENV TORCH_HOME=/root/.cache/torch
COPY room_worker room_worker
ENTRYPOINT ["python", "-m", "room_worker"]
