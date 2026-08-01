# Task 006 — Optional multi-reference image guidance

## Problem

FLUX.2 Klein 4B supports text-to-image and single/multi-reference editing, but
ImageForge currently exposes only text prompts. Editors sometimes need a visual
anchor (for example a subject, palette, or location) across a batch.

## Acceptance criteria

- AC-1: Create can optionally attach zero or more local image references to a
  batch; text-only generation remains the default and unchanged.
- AC-2: The UI previews selected references, shows filename/type/size, permits
  removal before launch, and never uploads them until the user explicitly
  starts the batch. The UI clearly explains that references apply to every
  prompt in that batch.
- AC-3: The native boundary transfers reference bytes only over the authenticated
  worker session, validates MIME/type/size and image decoding, and does not put
  worker credentials or local output paths in the renderer request.
- AC-4: The worker accepts optional references, decodes them in memory, passes a
  list of PIL images to the pinned `Flux2KleinPipeline(image=...)`, and passes
  no image argument for text-only batches.
- AC-5: Reference metadata is not copied into prompt text or logs. Batch
  manifests retain only safe metadata needed for reproducibility (filenames and
  checksums, never raw bytes).
- AC-6: The shared one-active-batch lease, ordered generation, retries,
  persistence, and downloads remain unchanged.

## Non-goals

- NG-1: Do not add another model, LLM prompt rewriting, LoRA, or ComfyUI.
- NG-2: Do not support per-prompt reference sets in this release; references
  are batch-level and apply to every prompt.
- NG-3: Do not promise identity-perfect editing; reference influence remains
  model-dependent.

## Relevant files

- `src/domain/types.ts`, `src/domain/reducer.ts`, `src/screens/CreateScreen.tsx`:
  typed batch draft and optional reference controls.
- `src/adapters/workerBatchCoordinator.ts`, `src/native/tauriBridge.ts`,
  `src-tauri/src/native/worker.rs`: authenticated transport.
- `worker/src/imageforge_worker/domain.py`, `controller.py`,
  `inference/base.py`, `inference/flux.py`, `inference/fake.py`: request and
  inference contract.
- `worker/tests/`, `src/**/*.test.*`, `src-tauri/src/native/worker.rs` tests:
  validation and fake coverage.

## Automated tests

- Text-only request passes with no reference argument.
- One and multiple valid references pass through fake inference in order.
- Malformed/non-image/oversized references are rejected without logging bytes.
- Concurrent batch lock and retry/resume behavior remain green.

## Manual verification

1. Select two images, confirm thumbnails and removal, then launch a fake batch;
   the worker receives both references and each generated slot completes.
2. Launch without references; confirm the request remains text-only and output
   behavior is unchanged.
3. Inspect logs and manifest; confirm no bearer token, raw image bytes, or local
   path is present.

## Evidence required

- Worker and desktop test output.
- A rendered Create-screen observation for references on/off.
- Review of the native request boundary and inference call.
