# Architecture

## Components

### Desktop client

- React/TypeScript presentation and local state.
- Tauri/Rust commands for OS dialogs, credential vault, downloads, checksums,
  bounded authenticated WebP previews, receipt-bound full JPEG reads and
  exports, durable user-named batch-folder mappings, local manifest storage,
  and RunPod requests. Image bytes are held in a bounded session-local object
  URL cache only; worker credentials never cross into the renderer.
- A `RunPodProvider` interface with fake and real implementations.
- A `WorkerClient` interface with fake and HTTP implementations.

### RunPod management

The selection engine estimates cost/image from measured benchmark history and
orders approved GPU IDs by value. At every explicit start, one REST create call
uses RunPod's `gpuTypePriority: custom`, allowing RunPod to atomically try those
types in order against current capacity instead of trusting a stale availability
snapshot. Creation uses the fixed ImageForge template, one GPU, shared network
volume, required ports, and runtime secrets. The response supplies the actual
GPU, hourly rate, Pod ID, and the ID used for its proxy URL.

Only user actions create or terminate Pods. Polling may observe state but never
changes it. Concurrent start clicks are reconciled by discovering matching live
ImageForge Pods and presenting duplicates for manual cleanup; they are never
silently terminated.

### Worker

- FastAPI lifecycle exposes health before the model is ready.
- Pipeline loader verifies local weights and loads BF16 directly onto one GPU.
- A single generation controller owns an atomic active-batch lease.
- Durable JSON manifests live on the network volume. Updates use temp files and
  atomic rename. Completed artifacts are immutable.
- Preview and full files are downloadable independently with checksums.

## State machines

Pod: `offline -> selecting -> provisioning -> booting -> loading -> warming -> ready -> stopping -> offline`.

Batch: `draft -> validating -> running <-> paused -> completed | cancelled | failed | interrupted`.

Image: `pending -> generating -> ready -> downloaded` with `generating -> retrying -> failed`.

## Resume semantics

- The worker persists a generated artifact before advancing the manifest.
- On boot, an unfinished `running` image becomes `pending`; already-ready files
  with matching checksums remain ready.
- The active batch owner may resume or cancel. A second user remains blocked
  until the interrupted lease is explicitly resolved.
- The desktop compares its local receipt ledger with the server manifest and
  requests only missing or checksum-mismatched files. A terminal manifest is
  reconciled to a bounded fixed point before the UI reports completion, so
  newly exposed ready artifacts cannot remain waiting after polling stops.
- The internal batch UUID remains the worker identity. Native storage maps it
  durably to the sanitized user-entered batch name, migrates legacy UUID
  folders atomically, and preserves that mapping across restart and resume.

## Security boundaries

- RunPod API keys remain on the local device credential vault and are sent only
  to RunPod over TLS.
- Worker API uses per-user bearer credentials supplied as RunPod secrets.
- The worker never accepts output paths from clients.
- Filenames are server-generated and path-normalized.
- Prompt requests must be finite and non-empty; malformed input is rejected while
  practical OS, transport, storage, and GPU constraints remain explicit.
