FROM nvidia/cuda:11.7.1-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 \
    PATH=/opt/conda/bin:$PATH TORCH_CUDA_ARCH_LIST=7.5 MAX_JOBS=2
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://repo.anaconda.com/miniconda/Miniconda3-py38_23.1.0-1-Linux-x86_64.sh -o /tmp/conda.sh \
    && bash /tmp/conda.sh -b -p /opt/conda && rm /tmp/conda.sh
RUN python -m pip install pip==24.0 setuptools==69.5.1 wheel==0.43.0 ninja==1.11.1.1 numpy==1.23.5 \
    && python -m pip install torch==1.13.1+cu117 torchvision==0.14.1+cu117 torchaudio==0.13.1 \
       --extra-index-url https://download.pytorch.org/whl/cu117
RUN python -m pip install fvcore==0.1.5.post20221221 iopath==0.1.10 \
    && python -m pip install --no-index pytorch3d \
       -f https://dl.fbaipublicfiles.com/pytorch3d/packaging/wheels/py38_cu117_pyt1131/download.html
WORKDIR /opt/hugs
COPY . /opt/hugs
RUN python -m pip install --no-build-isolation ./submodules/diff-gaussian-rasterization ./submodules/simple-knn \
    && python -m pip install -r requirements.txt chumpy==0.70 numpy==1.23.5
ENV PYTHONPATH=/opt/hugs
CMD ["python", "-c", "import torch; assert torch.cuda.is_available(); x=torch.ones(32,32,device='cuda'); print(torch.cuda.get_device_name(), (x@x).sum().item())"]
