# ImageForge worker

This directory contains the Python 3.11/FastAPI worker for one ImageForge GPU.
It owns exactly one process-level batch lease, generates images sequentially on
one approved GPU, and stores crash-safe manifests on the RunPod network volume.
It never creates, stops, or terminates a Pod.

## Runtime contract

- API schema: `1`
- model: `black-forest-labs/FLUX.2-klein-4B`
- model revision: `e7b7dc27f91deacad38e78976d1f2b499d76a294`
- precision: BF16, loaded directly onto one NVIDIA CUDA device with at least 16 GiB VRAM
- output: 1280x720 JPEG quality 95 and 320x180 WebP preview
- inference: four steps, guidance 1.0
- retries: one initial attempt and two automatic retries
- prompts: 1-500, at most 4096 UTF-8 bytes each

The Docker base image, Python minor version, direct dependencies, PyTorch,
Diffusers, model revision, and schema are pinned. The production adapter uses
`local_files_only=True` while all Hugging Face offline flags are set. Model
weights must be provisioned once onto `/workspace/models/huggingface` before a
normal start. Boot never installs packages and never downloads weights.

For the separately authorized one-time volume preparation, run:

```sh
python -m imageforge_worker.prepare_model \
  --cache-dir /workspace/models/huggingface \
  --confirm-download
```

The command pins the same model revision and downloads only `model_index.json`
plus `scheduler/`, `text_encoder/`, `tokenizer/`, `transformer/`, and `vae/`.
It intentionally excludes the redundant root `flux-2-klein-4b.safetensors`
(which duplicates the Diffusers transformer) and repository sample images. The
required runtime tree is approximately 16 GB rather than the roughly 23.74 GB
full repository, leaving safe working room on the 50 GB EU-RO-1 network volume.
This preparation command is never invoked by the Docker entrypoint.

GPU family selection remains the desktop/RunPod provider's responsibility. The
worker is hardware-generic across the approved NVIDIA fallback pool: it checks
that exactly one CUDA device is visible and that the actual device has at least
16 GiB VRAM, then reports its real name, capacity, allocation, reservation, and
peak memory through health. An undersized device fails measured readiness
instead of attempting CPU offload.

RunPod network-volume Pods are terminated and recreated rather than stopped.
The new Pod gets a new ID, but `/workspace` persists. Recovery scans
`/workspace/imageforge/batches`, validates every ready artifact against its
size and SHA-256, changes a previously running batch to `interrupted`, and
retains that batch's lease until its owner resumes or cancels it. Manifests do
not contain or depend on a Pod ID.

## Authentication

Every route except `GET /v1/health` requires a bearer credential. Inject
`IMAGEFORGE_AUTH_TOKENS_JSON` from a RunPod secret; never commit it. The value is
a JSON list shaped as follows (values below are descriptive, not credentials):

```json
[
  {"user_id": "user-id", "display_name": "Display name", "token": "runtime-secret"}
]
```

Tokens are compared in constant time. Unknown batch IDs and batches owned by a
different user intentionally return the same `batch_not_found` response. The
worker does not log authorization headers or prompt content. OpenAPI and docs
routes are disabled in the production app.

## Local verification

Keep the environment and caches on the removable disk:

```sh
cd /Volumes/ESD-USB/ImageForge-worktrees/worker/worker
python3.11 -m venv .venv
PIP_CACHE_DIR=/Volumes/ESD-USB/ImageForge-caches/pip .venv/bin/pip install -e '.[test]'
TMPDIR=$PWD/.tmp .venv/bin/pytest
.venv/bin/ruff check src tests
```

Tests inject the deterministic fake adapter directly and make no RunPod calls.
The fake emits valid JPEG/WebP files derived from prompt, index, and seed. A
real-GPU test is excluded unless `IMAGEFORGE_REAL_GPU_TEST=1` is set explicitly;
running that paid gate also requires the pinned weights and an authorized Pod.

## API behavior

`POST /v1/batches` accepts `{"prompts":[...],"base_seed":0}`. Batch IDs and
all paths are server generated. If a lease is already held, the server returns
HTTP 423 with stable code `batch_busy`, the owner's display name, and progress;
there is no queue. Pause stops before the next image while retaining the lease.
Cancel allows the current image to finish, cancels the remainder, and releases
the lease. `retry-failed` reopens only terminally failed images when no other
batch owns the GPU.

Artifact responses include `Content-Type`, `Content-Length`, `Digest`, `ETag`,
`X-ImageForge-SHA256`, and `X-Checksum-SHA256`. A receipt must repeat the full
JPEG's verified SHA-256 and size. Receipts are durable acknowledgements; the
desktop remains responsible for its per-computer local receipt ledger.
