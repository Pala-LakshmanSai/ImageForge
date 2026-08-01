# Existing USB production system audit

ImageForge keeps the useful operational lessons from
`/Volumes/ESD-USB/video production software` without carrying its video,
ComfyUI, Ollama, database, Redis, MinIO, or local Docker complexity into this
single-purpose desktop app.

## What is worth retaining

- The existing system correctly moved model files, custom nodes, the Ollama
  binary, and boot scripts onto `/workspace`. ImageForge retains the same
  persistent-volume principle for its pinned FLUX Diffusers snapshot.
- Its image stage is resumable and starts transferring each result while later
  GPU work continues. ImageForge retains that behavior with durable server
  manifests and native direct-to-device downloads.
- It bounds work submitted to one GPU and uses timeouts/retries instead of
  allowing an indefinitely stalled item. ImageForge makes those limits part of
  the versioned worker contract.
- It learned that all runtime software must be ready before the Pod starts.
  ImageForge therefore builds Python/CUDA dependencies into one pinned worker
  image and performs no package installation during normal boot.

## What ImageForge deliberately removes

- The old daily flow requires Pod ID, IP, SSH port, environment rewrites, local
  Docker services, and manual health scripts. ImageForge discovers the new Pod
  ID and proxy through the RunPod API and presents one explicit Start/Stop UI.
- ComfyUI and Ollama share the old GPU and contend for VRAM and execution time.
  ImageForge loads only `black-forest-labs/FLUX.2-klein-4B`; it has no local LLM
  and does not rewrite prompts.
- The old image route passes full image buffers through the web backend and
  MinIO. ImageForge downloads from the worker straight to the initiating Mac or
  Windows computer, verifies SHA-256, and atomically renames the local file.
- The old bootstrap can install or repair software over SSH. ImageForge normal
  boot is offline and immutable. Missing weights or an incompatible GPU fail
  readiness with a safe diagnosis rather than modifying the Pod at runtime.
- ComfyUI owns an internal prompt queue. ImageForge exposes no second-user
  queue: one durable batch owns the shared GPU lease, and another editor is
  blocked with the owner's live progress.

## Boot-time implication

The previous long startup was not an unavoidable property of GPU inference; it
was largely repeated installation plus two large services. ImageForge still
must attach the volume, load roughly 13 GB of BF16 model state, and perform one
warm-up image, but it removes downloads, package installation, custom-node
discovery, ComfyUI startup, Ollama startup, and LLM model loading from the paid
boot path. Real timing remains a measured release gate for each approved GPU.
