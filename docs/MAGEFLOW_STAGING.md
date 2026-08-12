# Mage-Flow staging evidence

Production (`imageforge-prod-50gb` / `ukh207b26r`, template `q8sfgixfy2`) is
untouched by everything in this document. Every step here runs against the
staging volume below, and no ImageForge contract changes until the go/no-go
gate at the end of Phase 2.

Plan: `docs/superpowers/plans/2026-08-12-mage-flow-turbo-migration.md`.

## Target model

- Family: Microsoft Research **Mage-Flow** — 4B native-resolution MMDiT plus
  Mage-VAE, rectified flow matching, MIT license, released 2026-07-22
  (`arXiv:2607.19064`).
- Diffusers repo: `microsoft/Mage-Flow-Turbo` (text-to-image, 4 steps).
- ComfyUI-format weights (`Comfy-Org/Mage-Flow`):
  - `diffusion_models/mage_flow_turbo_int8_convrot.safetensors` — 4.16 GB
  - `text_encoders/qwen3vl_4b_bf16.safetensors` — Qwen3-VL-4B text encoder
  - `vae/mage_flow_vae_bf16.safetensors`
- BF16 fallback transformer: `diffusion_models/mage_flow_turbo_bf16.safetensors`
  — 8.23 GB, reported ~18-20 GB peak at 1024².

Mage-Flow Turbo is text-to-image only. Batch reference images do not survive
the migration; the editing variant (`Mage-Flow-Edit-Turbo`) is deliberately out
of scope.

## Staging resources

| Resource | Value |
| --- | --- |
| Volume | `imageforge-mageflow-50gb` (`<VOLUME_ID>`), 50 GB, EU-RO-1 |
| Spike Pod | RunPod stock PyTorch image, one RTX 4090, volume at `/workspace` |
| Staging worker image | `<DIGEST>` (worker `0.2.0-mageflow-rc1`) |

Filled in as each phase runs. A row still holding a placeholder means that
phase has not been executed.

## Loader spike findings

`int8_convrot` is a Comfy-Org quantization with no upstream loader
documentation, so the loading path is decided by measurement, not assumption.

_Not yet run (Phase 0, Task 3)._

| Question | Result |
| --- | --- |
| Working import path | _pending_ |
| Pipeline / transformer class names | _pending_ |
| INT8 single-file load succeeds | _pending_ |
| Peak VRAM, INT8, 1280x720 | _pending_ |
| Peak VRAM, BF16, 1280x720 | _pending_ |
| Seconds per image, 1280x720 | _pending_ |
| Chosen path (A: diffusers, B: ComfyUI or BF16 fallback) | _pending_ |

## Health and throughput

_Not yet run (Phase 2, Task 9)._

## Quality gate versus FLUX.2 Klein

_Not yet run (Phase 2, Task 10)._
