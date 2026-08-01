# syntax=docker/dockerfile:1.7
FROM pytorch/pytorch:2.13.0-cuda12.6-cudnn9-runtime@sha256:6acf597eeb8e376a96580dde4952f37cc017fef732bb40bfc73f28f25e3f64b4

LABEL org.opencontainers.image.title="ImageForge Worker" \
      org.opencontainers.image.version="0.1.0" \
      ai.imageforge.api-schema="1" \
      ai.imageforge.model="black-forest-labs/FLUX.2-klein-4B" \
      ai.imageforge.model-revision="e7b7dc27f91deacad38e78976d1f2b499d76a294"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    DIFFUSERS_OFFLINE=1 \
    HF_HOME=/workspace/models/huggingface \
    IMAGEFORGE_DATA_ROOT=/workspace/imageforge \
    IMAGEFORGE_MODEL_CACHE_DIR=/workspace/models/huggingface \
    IMAGEFORGE_INFERENCE_BACKEND=flux

WORKDIR /opt/imageforge-worker
COPY pyproject.toml README.md ./
COPY src ./src

# Installation happens while the image is built, never during normal Pod boot.
RUN python --version | grep -Eq '^Python 3\.11\.' \
    && python -m pip install --no-cache-dir '.[gpu]'

EXPOSE 8000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=30 \
  CMD python -c "import json,urllib.request; r=json.load(urllib.request.urlopen('http://127.0.0.1:8000/v1/health', timeout=2)); assert r['process']['status']=='ok'" || exit 1

# One process is an invariant: the generation lease is process-level by design.
CMD ["python", "-m", "imageforge_worker"]
