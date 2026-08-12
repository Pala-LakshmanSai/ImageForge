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

Run 2026-08-12 on Pod `xjtdjw78l0vuf3` (RTX 4090 24 GB, EU-RO-1, torch
2.9.1+cu130, driver 580.159.04) against volume `8zupqv4zrm`. Three passes:
pinned Diffusers 0.39.0, latest Diffusers, and the official `microsoft/Mage`
package.

**Result: Path A is dead. Diffusers cannot load Mage-Flow at all, in any
version, quantized or not.**

| Question | Result |
| --- | --- |
| `diffusers.MageFlowPipeline` | Not exported, 0.39.0 |
| `diffusers.MageFlowTransformer2DModel` | Not exported, 0.39.0 |
| Latest Diffusers | `pip install -U diffusers` stays at 0.39.0 — that **is** latest, and it has no Mage-Flow support |
| `pip install git+https://github.com/microsoft/Mage.git` | Fails: no `setup.py`/`pyproject.toml` at repo root. The package lives in the `mage_flow/` subdirectory and installs with `uv pip install -e .` from there |
| `microsoft/Mage-Flow-Turbo` on Hugging Face | **HTTP 401** — the repo is gated or private. Same for `microsoft/Mage-Flow`. Downloading it needs an accepted licence and a HF token |
| `Comfy-Org/Mage-Flow` | **HTTP 200**, public, no token needed |
| Weights on the staging volume | 21 GB downloaded: INT8 convrot 4.16 GB, BF16 8.23 GB, Qwen3-VL-4B text encoder, Mage-VAE |
| INT8 / BF16 generation timings | **Not measured** — blocked before any pipeline could be constructed |

### What this means

The INT8 convrot checkpoint is a **ComfyUI-format single file**. ComfyUI gained
native Mage-Flow support in core PR #15026; that is the only public loader for
it. The official `mage_flow` Python package loads the *gated* `microsoft/*`
Diffusers-style repositories instead, and does not consume the Comfy single
file.

ComfyUI's own documentation describes the INT8 ConvRot variants as the choice
for "low-VRAM environments ... with a small quality trade-off". Under this
project's quality-first priority that is a material statement: INT8 is
positioned by its publisher as a compromise, not as a free win.

### Remaining options

| Option | Weights | Loader | Quality | Cost to build |
| --- | --- | --- | --- | --- |
| 1. Official package | BF16, gated `microsoft/Mage-Flow-Turbo` | `mage_flow` package, in-process, closest to today's worker | Reference | Moderate: needs a HF token, an accepted licence, and a `flash-attn` build in the image |
| 2. Headless ComfyUI, INT8 | INT8 convrot, public | ComfyUI process plus its HTTP API | Publisher-declared trade-off | High: replaces the worker's whole inference layer, adds a ComfyUI-nightly dependency |
| 3. Headless ComfyUI, BF16 | BF16 single file, public, already on the volume | ComfyUI process plus its HTTP API | Reference | High, same as option 2, without the quantization risk |

Option 1 preserves the current architecture and the reference quality. Options
2 and 3 trade a large rewrite for public, ungated weights.

_Awaiting the studio owner's decision before Phase 1 begins._

## Health and throughput

_Not yet run (Phase 2, Task 9)._

## Quality gate versus FLUX.2 Klein

_Not yet run (Phase 2, Task 10)._
