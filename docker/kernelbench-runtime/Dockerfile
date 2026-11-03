FROM pytorch/pytorch:2.1.2-cuda11.8-cudnn8-devel@sha256:66b41f1755d9644f6341cf4053cf2beaf3948e2573acf24c3b4c49f55e82f578

# JIT 编译只写入容器临时目录，限制并行编译，避免占满宿主 CPU 和内存。
ENV TORCH_EXTENSIONS_DIR=/tmp/torch_extensions \
    MAX_JOBS=2 \
    PYTHONDONTWRITEBYTECODE=1
RUN python -m pip install --no-cache-dir ninja==1.11.1.1 \
    && nvcc --version && c++ --version && python -c "import torch, ninja; print(torch.__version__)"
COPY evaluate.py /opt/kernelbench/evaluate.py
WORKDIR /workspace
