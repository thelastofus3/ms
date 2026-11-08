# Avatar multi-view pipeline: the room-worker CUDA stack (COLMAP, nerfstudio, gsplat) plus person segmentation.
# Requires the room worker image: docker compose build room-worker (compose builds avatar-worker from this file).
FROM masterproject-room-worker
# onnxruntime-gpu 1.18.x is the last PyPI build for CUDA 11.8 / cuDNN 8, matching torch 2.1.2+cu118 in the base image.
# rembg pulls the CPU onnxruntime, which shares the package directory: remove it, then restore the GPU files.
RUN printf 'torch==2.1.2+cu118\ntorchvision==0.16.2+cu118\nnumpy==1.26.4\nopencv-python-headless==4.10.0.84\n' > /tmp/avatar-constraints.txt \
    && python -m pip install --no-cache-dir -c /tmp/avatar-constraints.txt "rembg==2.0.59" "onnxruntime-gpu==1.18.1" "mediapipe==0.10.14" \
    && python -m pip uninstall -y onnxruntime \
    && python -m pip install --no-cache-dir --no-deps --force-reinstall "onnxruntime-gpu==1.18.1" \
    && ln -sf libnvrtc.so.11.2 /usr/local/cuda-11.8/targets/x86_64-linux/lib/libnvrtc.so
# cuDNN/cuBLAS come from torch's bundled libraries; cuDNN 8 also dlopens an unversioned libnvrtc.so.
ENV U2NET_HOME=/models/rembg \
    LD_LIBRARY_PATH=/usr/local/lib/python3.10/dist-packages/torch/lib:/usr/local/cuda-11.8/targets/x86_64-linux/lib:${LD_LIBRARY_PATH}
COPY *.py /code/
WORKDIR /code
ENTRYPOINT ["python"]
CMD ["/code/avatar_worker.py"]
