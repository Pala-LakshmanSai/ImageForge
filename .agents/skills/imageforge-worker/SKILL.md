---
name: imageforge-worker
description: Implement, optimize, test, or diagnose the ImageForge FastAPI FLUX worker and RunPod lifecycle integration, including GPU selection, health phases, exclusive batches, durable manifests, retries, resume, artifacts, authentication, Docker startup, and performance benchmarks.
---

# Build the ImageForge worker

1. Read `docs/ARCHITECTURE.md`, `docs/API_CONTRACT.md`, the task, and
   `references/runtime-contract.md`.
2. Preserve provider boundaries: RunPod lifecycle, worker HTTP, persistence,
   and inference must remain replaceable and independently fakeable.
3. Keep paid calls outside normal tests. Require an explicit real-GPU switch.
4. Use one model process, one GPU, one active-batch controller, and bounded
   image retries. Do not introduce a queue or background Pod termination.
5. Persist state before publishing completion. Use server-generated paths,
   immutable artifacts, checksums, and atomic manifest replacement.
6. Make health available before model readiness and expose each boot phase.
7. Load BF16 weights directly on GPU without CPU offload on approved hardware.
8. Pin image, Python, PyTorch, Diffusers, model revision, and API schema.
9. Test auth, malformed input, concurrent starts, busy responses, interruption,
   restart, pause/resume/cancel, receipts, and 450 ordered prompts.
10. Benchmark identical prompts/settings before changing the GPU value policy.

Never log credentials or prompt content by default. Never claim a cost or speed
improvement without recorded benchmark evidence.
