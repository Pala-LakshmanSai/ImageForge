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
| Volume | `imageforge-mageflow-50gb` (`8zupqv4zrm`), 50 GB, EU-RO-1 |
| Spike Pod | `pytorch/pytorch:2.9.1-cuda12.8-cudnn9-runtime`, one RTX 4090, volume at `/workspace`. The 25 GB `runpod/pytorch` image stalled placement repeatedly; the smaller image starts in about 90 s |
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

Decision: **option 2, headless ComfyUI with INT8**, with BF16 kept as the
quality reference and the fallback. Results below.

## Generation results, official ComfyUI workflow

Run 2026-08-12 on Pod `636jsdssjgbilp` (RTX 4090, EU-RO-1) through headless
ComfyUI master, driving the official `image_mage_flow_turbo_t2i_int8`
graph. Four prompts, seed 7, 1280x720, 4 steps, cfg 1.0, euler/simple.

### A hand-built workflow produced misleading output first

The first attempt built the graph from node names and generated garbled text
and wrong compositions at every precision. Two errors, both mine:

- `CLIPLoader` `type` must be `"mage"`; a `qwen`-matching type was selected.
- `TextEncodeMageFlowEdit` **emits the latent** (outputs: positive, negative,
  LATENT). Feeding the sampler a generic `EmptySD3LatentImage` put it in the
  wrong latent space.

Those images say nothing about the model and were discarded. Anyone re-running
this must start from the official Comfy-Org template, not from `/object_info`.

### Quality

| Prompt category | Result |
| --- | --- |
| Text | `OPEN LATE` in gold leaf and `Espresso 3.50` on the chalkboard, both exact |
| Face and hands | Photorealistic, correct hand anatomy, requested skin/hair detail present |
| Spatial | All four constraints held: bicycle left of the blue door, tabby right of the bicycle on the doormat, fern above |

INT8, FP8 and BF16 are visually indistinguishable at 1280x720 on identical
seeds. ComfyUI documents the INT8 ConvRot variants as carrying a small quality
trade-off; it did not appear at this resolution and step count. INT8 therefore
clears the quality-first gate.

### Timing

| Precision | Median seconds/image | First image, includes model load |
| --- | --- | --- |
| int8 | 3.9 | 60.5 |
| fp8 | 4.1 | 38.1 |
| bf16 | 4.0 | 35.8 |

Two limits on this table:

1. **No compute advantage to INT8.** All three sit at roughly 4 s/image, so the
   INT8 benefit is file size and VRAM, not throughput.
2. **The load column is confounded and must not be quoted.** INT8 ran first and
   read its 4.16 GB cold off the network volume, while FP8 and BF16 share one
   8.23 GB file, so the BF16 run benefited from the FP8 run having just warmed
   it. The numbers hint that dequantising convrot costs load time rather than
   saving it. Boot was the second-ranked requirement, so it needs a clean
   per-precision cold-boot measurement before any claim is made.

## Integration status

Worker `0.2.0` ships the `mageflow` backend as the default. The worker owns a
ComfyUI child process bound to loopback, pinned at ComfyUI commit
`26d7f8556822d9d08c2d3e1878636ac3b4969af9` and baked into the image, so a Pod
boot clones nothing and downloads nothing.

Reference images are **disabled, not removed**. `ModelProfile.supports_references`
gates them, the active profile sets it to `False`, and the API refuses such a
batch at submission with `references_unsupported` rather than failing every
image after the batch is committed. The whole reference path still ships and
still has test coverage against the FLUX profile, so a future reference-capable
model is a one-flag change.

## Production volume

| | |
| --- | --- |
| Production volume | `imageforge-prod-50gb` (`kdqerqkwdh`), 50 GB, EU-RO-1 |
| Weights on it | 13 GB: INT8 ConvRot transformer, Qwen3-VL-4B text encoder, Mage-VAE |

Both earlier volumes, including the one holding the FLUX weights, were deleted
on 2026-08-12, so there is no no-download rollback. Restoring FLUX now means
staging its weights again.

The desktop connection profile carries the volume ID, so it has to name
`kdqerqkwdh` before the app can create a Pod.

## End-to-end verification

The published image `sha256:5606ac29...` was booted against `kdqerqkwdh` and
reached `ready`, which the worker only reports after ComfyUI starts, the INT8
weights load, and a warmup image is generated:

```
15:46:38 warmup loading
15:47:41 ready  ready
```

Roughly four minutes from Pod creation to a warm worker on a cold volume.

Pods must be created with `allowedCudaVersions: ["13.0"]`. A Pod placed without
that constraint landed on a host with a 12.4 driver, and the pinned cu130 wheels
cannot initialise CUDA there. The desktop app already applies the constraint.

## Health and throughput on the real worker

_Not yet run. The staging measurements above came from a bare ComfyUI on a spike
Pod, not from the worker's own health endpoint under batch load._
