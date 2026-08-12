# Mage-Flow Turbo Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace FLUX.2 Klein 4B with Microsoft Mage-Flow Turbo (INT8 convrot) as ImageForge's only image model, with the new model fully proven on a second network volume before any production code changes.

**Architecture:** Production ImageForge is untouched through Phases 0–2. A second EU-RO-1 network volume (`imageforge-mageflow-50gb`) holds the new weights, and a throwaway staging Pod proves loading, VRAM, throughput and quality. The worker gains a second inference adapter selected by `IMAGEFORGE_INFERENCE_BACKEND=mageflow`, so both models coexist in one image and the cutover is a constants/contract change plus a template repin — production downtime is one Pod restart.

**Tech Stack:** Python 3.11 worker (FastAPI + diffusers 0.38 + PyTorch 2.13/cu130), TypeScript desktop (`packages/runpod-client`, `src/`), Rust native (`src-tauri`), RunPod EU-RO-1 network volumes, GHCR immutable worker images.

---

## Model facts (verified 2026-08-12)

- Family: Microsoft Research **Mage-Flow** — 4B native-resolution MMDiT + Mage-VAE, rectified flow matching, MIT license. Paper `arXiv:2607.19064`, released 2026-07-22.
- Diffusers-style repos: `microsoft/Mage-Flow-Turbo` (t2i, 4-step) and `microsoft/Mage-Flow-Edit-Turbo` (editing). Each is `transformer/ + vae/ + text_encoder/ + scheduler/`.
- ComfyUI-format single files (`Comfy-Org/Mage-Flow`):
  - `diffusion_models/mage_flow_turbo_int8_convrot.safetensors` — **4.16 GB** ← the target
  - `text_encoders/qwen3vl_4b_bf16.safetensors` (Qwen3-VL-4B text encoder)
  - `vae/mage_flow_vae_bf16.safetensors`
- Reported BF16 peak memory ~18–20 GB at 1024². INT8 transformer is ~half the BF16 transformer, so the 16 GB floor is plausible but **unproven** — Phase 0 measures it.
- Turbo variant is **text-to-image only**. Reference images (`image=` kwarg) do not survive the swap. User decision: refs optional → the reference path is disabled behind a capability flag.

### Open fork resolved by Phase 0, not by guesswork

`int8_convrot` is a Comfy-Org quantization, undocumented upstream, packaged as a ComfyUI single file. Two possible loaders:

- **Path A (preferred):** `diffusers` / `mage_flow` loads the single-file INT8 transformer alongside the HF `vae/`, `text_encoder/`, `scheduler/` folders. Keeps the existing worker architecture — one new adapter file.
- **Path B (fallback):** the INT8 file only runs under ComfyUI. Then the worker either embeds headless ComfyUI and drives its `/prompt` API, or the migration falls back to `microsoft/Mage-Flow-Turbo` BF16 diffusers weights (8.23 GB transformer, ~18–20 GB peak, raises the GPU floor to 24 GB and drops every 16 GB candidate from `docs/RUNPOD_OPERATIONS.md`).

Phase 0 Task 3 decides this with evidence. **Do not start Phase 1 before it is decided.**

### Prerequisites the studio owner must supply

The repository has no RunPod credentials. Before Phase 0:

- RunPod API key with volume + pod create rights, exported as `RUNPOD_API_KEY` in the executing shell (never committed).
- Budget acknowledgement: Phase 0 + Phase 2 are paid GPU hours (estimate 3–5 h on RTX 4090-class, plus a 50 GB volume at EU-RO-1 monthly rate until Phase 4 deletes the old one).

---

## File Structure

**Phase 0–2 (production untouched):**

- Create `worker/src/imageforge_worker/inference/mageflow.py` — the Mage-Flow Turbo adapter. Same `InferenceAdapter` protocol as `flux.py`; owns snapshot resolution, INT8 pipeline load, generation, GPU snapshot.
- Create `worker/src/imageforge_worker/model_profiles.py` — one frozen dataclass per model (id, revision, precision, files, steps, guidance, supports_references, min VRAM). Removes the "model identity scattered across constants" problem that makes this migration expensive.
- Create `worker/scripts/prepare_mageflow_volume.py` — one-time, explicitly confirmed downloader for the new volume.
- Create `worker/tests/test_mageflow_adapter.py` — mirrors `test_flux_adapter.py`.
- Create `docs/MAGEFLOW_STAGING.md` — Phase 0/2 evidence: spike findings, VRAM, latency, quality comparison.
- Modify `worker/src/imageforge_worker/config.py:44,60,75` — accept `mageflow` backend.
- Modify `worker/src/imageforge_worker/app.py:208` — wire the backend.

**Phase 3 (cutover, the only production-visible change):**

- `worker/src/imageforge_worker/constants.py:6-8,49-68` — model id/revision/precision/files, `INFERENCE_STEPS`, `GUIDANCE_SCALE`, `MIN_GPU_MEMORY_*`, `WORKER_VERSION`
- `worker/Dockerfile:15-16,30` — `ai.imageforge.model*` labels, `IMAGEFORGE_INFERENCE_BACKEND`
- `worker/pyproject.toml` — version
- `worker/scripts/run_volume_gate.py:163` — expected model id
- `packages/runpod-client/src/types.ts:94`, `src/config.ts:193-218`, `src/health.ts:14`, `src/benchmark-v2.ts:10,113`
- `packages/runpod-client/config/imageforge-runpod.schema.json:137`, `config/imageforge-runpod.example.json:22`
- `contracts/gpu-benchmark-raw-v2.schema.json:22`, `contracts/gpu-benchmark-v2.vectors.json:6`
- `src-tauri/src/native/worker.rs:31`
- `src/adapters/imageForgeAdapter.ts:39,90,175,184,223`, `src/adapters/gpuLifecycleCoordinator.ts:78`, `src/adapters/runtimeProjection.ts:52`, `src/domain/reducer.ts:527,817`, `src/screens/CreateScreen.tsx:387`, `src/screens/SettingsScreen.tsx:174,184`
- Test fixtures: `src/adapters/gpuLifecycleCoordinator.test.ts:657`, `src/adapters/imageForgeAdapter.test.ts:13`, `src/adapters/productionImageForgeAdapter.test.ts:127`, `packages/runpod-client/test/health.test.ts:184`, `packages/runpod-client/test/helpers.ts:10`
- Docs: `README.md`, `docs/PRODUCT_SPEC.md:67,105,123`, `docs/RUNPOD_OPERATIONS.md`, `docs/DEPLOYMENT_RUNBOOK.md`, `docs/ONBOARDING.md`, `docs/LEGACY_SYSTEM_AUDIT.md`, `docs/QA_LOG.md`

---

## Phase 0 — Staging volume and loader spike (no ImageForge changes)

### Task 1: Create the staging network volume and template

**Files:**
- Create: `docs/MAGEFLOW_STAGING.md`

- [ ] **Step 1: Create the volume**

In the RunPod console (or API), create a **50 GB** network volume in **EU-RO-1** named `imageforge-mageflow-50gb`. Do not touch `imageforge-prod-50gb` (`ukh207b26r`).

```bash
curl -s -X POST https://rest.runpod.io/v1/networkvolumes \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"imageforge-mageflow-50gb","size":50,"dataCenterId":"EU-RO-1"}'
```

Expected: JSON containing an `id`. Record it.

- [ ] **Step 2: Record the staging resources**

Create `docs/MAGEFLOW_STAGING.md`:

```markdown
# Mage-Flow staging evidence

Production (`imageforge-prod-50gb` / `ukh207b26r`) is untouched by everything in
this document. Every step here runs against the staging volume below.

## Staging resources

- Volume: `imageforge-mageflow-50gb` (`<VOLUME_ID>`), 50 GB, EU-RO-1
- Spike Pod template: RunPod PyTorch base image, one GPU, volume at `/workspace`
- Purpose: prove `mage_flow_turbo_int8_convrot.safetensors` loads and generates
  before ImageForge changes any contract.

## Loader spike findings

_(filled in by Task 3)_

## Quality and throughput gate

_(filled in by Phase 2)_
```

- [ ] **Step 3: Commit**

```bash
git add docs/MAGEFLOW_STAGING.md
git commit -m "docs: record the Mage-Flow staging volume"
```

### Task 2: Download the weights onto the staging volume

**Files:**
- Create: `worker/scripts/prepare_mageflow_volume.py`

- [ ] **Step 1: Write the preparation script**

```python
"""One-time Mage-Flow Turbo download for an ImageForge staging network volume.

Normal worker boot never downloads weights; this command is the only place that
turns Hugging Face networking back on, and it requires an explicit confirmation
flag exactly like prepare_model.py does for FLUX.
"""

from __future__ import annotations

import argparse
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

COMFY_REPO = "Comfy-Org/Mage-Flow"
COMFY_FILES = (
    "diffusion_models/mage_flow_turbo_int8_convrot.safetensors",
    "text_encoders/qwen3vl_4b_bf16.safetensors",
    "vae/mage_flow_vae_bf16.safetensors",
)
DIFFUSERS_REPO = "microsoft/Mage-Flow-Turbo"
DIFFUSERS_ALLOW_PATTERNS = (
    "model_index.json",
    "scheduler/*",
    "text_encoder/*",
    "tokenizer/*",
    "vae/*",
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument(
        "--confirm-download",
        action="store_true",
        help="required acknowledgement that this one-time command downloads model weights",
    )
    parser.add_argument(
        "--include-bf16-fallback",
        action="store_true",
        help="also fetch the 8.23 GB BF16 transformer for the Path B fallback",
    )
    arguments = parser.parse_args()
    if not arguments.confirm_download:
        parser.error("--confirm-download is required; normal worker boot never downloads weights")

    with _hub_download_enabled():
        from huggingface_hub import hf_hub_download, snapshot_download

        for relative_name in COMFY_FILES:
            path = hf_hub_download(
                repo_id=COMFY_REPO,
                filename=relative_name,
                cache_dir=str(arguments.cache_dir),
            )
            print(f"fetched {relative_name} -> {path}")
        if arguments.include_bf16_fallback:
            path = hf_hub_download(
                repo_id=COMFY_REPO,
                filename="diffusion_models/mage_flow_turbo_bf16.safetensors",
                cache_dir=str(arguments.cache_dir),
            )
            print(f"fetched BF16 fallback -> {path}")
        snapshot = snapshot_download(
            repo_id=DIFFUSERS_REPO,
            cache_dir=str(arguments.cache_dir),
            allow_patterns=list(DIFFUSERS_ALLOW_PATTERNS),
        )
        print(f"fetched Diffusers scaffolding -> {snapshot}")


@contextmanager
def _hub_download_enabled() -> Iterator[None]:
    """Override only Hub offline mode for the explicitly confirmed preparation call."""

    previous = os.environ.get("HF_HUB_OFFLINE")
    os.environ["HF_HUB_OFFLINE"] = "0"
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("HF_HUB_OFFLINE", None)
        else:
            os.environ["HF_HUB_OFFLINE"] = previous


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Verify the script refuses without confirmation**

Run: `cd worker && python scripts/prepare_mageflow_volume.py --cache-dir /tmp/x`
Expected: exits non-zero with `--confirm-download is required`.

- [ ] **Step 3: Start a spike Pod attached to the staging volume**

Create a Pod from RunPod's stock PyTorch template (this is a spike, not a production template): one RTX 4090, `imageforge-mageflow-50gb` mounted at `/workspace`, no ImageForge secrets attached.

- [ ] **Step 4: Run the download on the spike Pod**

```bash
pip install "huggingface_hub>=0.28"
python prepare_mageflow_volume.py \
  --cache-dir /workspace/models/huggingface \
  --confirm-download \
  --include-bf16-fallback
```

Expected: four `fetched …` lines plus the Diffusers scaffolding path, ~21 GB written.

- [ ] **Step 5: Commit**

```bash
git add worker/scripts/prepare_mageflow_volume.py
git commit -m "feat(worker): add the one-time Mage-Flow volume preparation command"
```

### Task 3: Loader spike — decide Path A or Path B

**Files:**
- Modify: `docs/MAGEFLOW_STAGING.md`

- [ ] **Step 1: Try the diffusers single-file load on the spike Pod**

```bash
pip install "diffusers==0.38.*" "transformers>=4.57" accelerate safetensors
```

```python
import torch, time
from diffusers import MageFlowPipeline  # fall back to `from mage_flow import MageFlowPipeline`

pipe = MageFlowPipeline.from_pretrained(
    "/workspace/models/huggingface/models--microsoft--Mage-Flow-Turbo/snapshots/<snapshot>",
    torch_dtype=torch.bfloat16,
    local_files_only=True,
)
pipe.to("cuda")
torch.cuda.reset_peak_memory_stats(0)
started = time.perf_counter()
image = pipe(
    prompt="A tall glass storefront with the words OPEN LATE etched in gold, "
           "a woman in a red coat reading a paperback, morning light",
    height=720, width=1280, num_inference_steps=4, guidance_scale=1.0,
    generator=torch.Generator(device="cuda").manual_seed(7),
).images[0]
print("seconds:", time.perf_counter() - started)
print("peak GiB:", torch.cuda.max_memory_allocated(0) / 1024**3)
image.save("/workspace/spike-bf16.jpg", quality=95)
```

Expected: an image, a per-image time, and a peak-VRAM number. If `MageFlowPipeline` is not importable from either module, record the exact `ImportError` — that is Path B evidence.

- [ ] **Step 2: Try swapping in the INT8 convrot transformer**

```python
from diffusers import MageFlowTransformer2DModel  # exact class name comes from step 1's package

transformer = MageFlowTransformer2DModel.from_single_file(
    "/workspace/models/huggingface/.../mage_flow_turbo_int8_convrot.safetensors",
    torch_dtype=torch.bfloat16,
    local_files_only=True,
)
pipe.transformer = transformer.to("cuda")
```

Then re-run the generation from Step 1 with the same seed and save `/workspace/spike-int8.jpg`.

Expected outcome is one of:
- **Path A confirmed** — image generated, peak VRAM recorded.
- **Path B forced** — record the exact exception (`unexpected key`, `KeyError`, unknown quant format …). `convrot` is a Comfy-Org-specific rotation-fused INT8 layout with no upstream diffusers loader, so this failing is a realistic result, not a mistake in the plan.

- [ ] **Step 3: Record the decision in `docs/MAGEFLOW_STAGING.md`**

Replace the "Loader spike findings" placeholder with: the working import path, exact pipeline/transformer class names, the exact working code snippet, per-image seconds at 1280×720, peak VRAM in GiB for INT8 and BF16, and the chosen path. If Path B: state whether the fallback is headless ComfyUI or BF16 diffusers, and say plainly that a 24 GB floor drops the 16 GB GPUs from the approved list.

- [ ] **Step 4: Save both spike images off the Pod for eyeballing**

```bash
scp root@<pod-host>:/workspace/spike-int8.jpg ./
```

- [ ] **Step 5: Commit**

```bash
git add docs/MAGEFLOW_STAGING.md
git commit -m "docs: record the Mage-Flow INT8 loader spike findings"
```

- [ ] **Step 6: Stop the spike Pod**

Delete the spike Pod. The volume persists. Do not leave a GPU billing.

**STOP. Report findings before Phase 1.** The adapter code in Phase 1 transcribes the snippet recorded in Step 3; writing it before the spike is guessing.

---

## Phase 1 — Second inference adapter behind a backend flag

### Task 4: Extract model identity into a profile module

**Files:**
- Create: `worker/src/imageforge_worker/model_profiles.py`
- Test: `worker/tests/test_model_profiles.py`

- [ ] **Step 1: Write the failing test**

```python
from imageforge_worker.model_profiles import FLUX2_KLEIN, MAGE_FLOW_TURBO, profile_for_backend


def test_flux_profile_matches_the_shipped_constants():
    from imageforge_worker import constants

    assert FLUX2_KLEIN.model_id == constants.MODEL_ID
    assert FLUX2_KLEIN.revision == constants.MODEL_REVISION
    assert FLUX2_KLEIN.steps == constants.INFERENCE_STEPS
    assert FLUX2_KLEIN.supports_references is True


def test_mage_flow_turbo_is_text_to_image_only():
    assert MAGE_FLOW_TURBO.supports_references is False
    assert MAGE_FLOW_TURBO.steps == 4


def test_profile_lookup_rejects_an_unknown_backend():
    assert profile_for_backend("flux") is FLUX2_KLEIN
    assert profile_for_backend("mageflow") is MAGE_FLOW_TURBO
    try:
        profile_for_backend("sdxl")
    except ValueError as error:
        assert "unknown inference backend" in str(error)
    else:
        raise AssertionError("expected ValueError")
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd worker && python -m pytest tests/test_model_profiles.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'imageforge_worker.model_profiles'`.

- [ ] **Step 3: Write the module**

```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Final


@dataclass(frozen=True, slots=True)
class ModelProfile:
    """Everything that identifies one pinned image model to the worker."""

    backend: str
    model_id: str
    revision: str
    precision: str
    steps: int
    guidance: float
    supports_references: bool
    min_gpu_memory_mib: int
    required_files: tuple[str, ...]


FLUX2_KLEIN: Final = ModelProfile(
    backend="flux",
    model_id="black-forest-labs/FLUX.2-klein-4B",
    revision="e7b7dc27f91deacad38e78976d1f2b499d76a294",
    precision="bfloat16",
    steps=4,
    guidance=1.0,
    supports_references=True,
    min_gpu_memory_mib=16_380,
    required_files=(
        "model_index.json",
        "scheduler/scheduler_config.json",
        "text_encoder/config.json",
        "text_encoder/model-00001-of-00002.safetensors",
        "text_encoder/model-00002-of-00002.safetensors",
        "text_encoder/model.safetensors.index.json",
        "tokenizer/tokenizer.json",
        "transformer/config.json",
        "transformer/diffusion_pytorch_model.safetensors",
        "vae/config.json",
        "vae/diffusion_pytorch_model.safetensors",
    ),
)

# Revision and min_gpu_memory_mib are set from the Phase 0 spike evidence in
# docs/MAGEFLOW_STAGING.md before this profile is used by a paid gate.
MAGE_FLOW_TURBO: Final = ModelProfile(
    backend="mageflow",
    model_id="microsoft/Mage-Flow-Turbo",
    revision="<PHASE_0_RECORDED_REVISION>",
    precision="int8-convrot",
    steps=4,
    guidance=1.0,
    supports_references=False,
    min_gpu_memory_mib=16_380,
    required_files=(
        "model_index.json",
        "scheduler/scheduler_config.json",
        "text_encoder/config.json",
        "tokenizer/tokenizer.json",
        "vae/config.json",
        "vae/diffusion_pytorch_model.safetensors",
    ),
)

_PROFILES: Final = {profile.backend: profile for profile in (FLUX2_KLEIN, MAGE_FLOW_TURBO)}


def profile_for_backend(backend: str) -> ModelProfile:
    try:
        return _PROFILES[backend]
    except KeyError as error:
        raise ValueError(f"unknown inference backend: {backend}") from error
```

Replace `<PHASE_0_RECORDED_REVISION>` with the commit SHA recorded in `docs/MAGEFLOW_STAGING.md`. This is the one value that cannot exist before Phase 0 runs.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd worker && python -m pytest tests/test_model_profiles.py -v`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add worker/src/imageforge_worker/model_profiles.py worker/tests/test_model_profiles.py
git commit -m "refactor(worker): describe each pinned model with one profile"
```

### Task 5: Accept the `mageflow` backend in config

**Files:**
- Modify: `worker/src/imageforge_worker/config.py:60-61,75`
- Test: `worker/tests/test_config.py`

- [ ] **Step 1: Write the failing test**

Append to `worker/tests/test_config.py`:

```python
def test_mageflow_backend_is_accepted():
    settings = Settings.from_env(
        {
            "IMAGEFORGE_DATA_ROOT": "/workspace/imageforge",
            "IMAGEFORGE_MODEL_CACHE_DIR": "/workspace/models/huggingface",
            "IMAGEFORGE_INFERENCE_BACKEND": "mageflow",
            "IMAGEFORGE_AUTH_TOKENS_JSON": "[]",
        }
    )
    assert settings.inference_backend == "mageflow"


def test_unknown_backend_is_still_rejected():
    with pytest.raises(ValueError, match="inference backend"):
        Settings.from_env(
            {
                "IMAGEFORGE_DATA_ROOT": "/workspace/imageforge",
                "IMAGEFORGE_MODEL_CACHE_DIR": "/workspace/models/huggingface",
                "IMAGEFORGE_INFERENCE_BACKEND": "sdxl",
                "IMAGEFORGE_AUTH_TOKENS_JSON": "[]",
            }
        )
```

If the existing test file builds settings through a helper, use that helper instead of `Settings.from_env` directly — match the file's own style.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd worker && python -m pytest tests/test_config.py -k mageflow -v`
Expected: FAIL with `inference backend must be 'flux' or 'fake'`.

- [ ] **Step 3: Widen the allow-list**

In `worker/src/imageforge_worker/config.py`, replace lines 60–61:

```python
        if self.inference_backend not in {"flux", "mageflow", "fake"}:
            raise ValueError("inference backend must be 'flux', 'mageflow', or 'fake'")
```

- [ ] **Step 4: Run the config tests and watch them pass**

Run: `cd worker && python -m pytest tests/test_config.py -v`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add worker/src/imageforge_worker/config.py worker/tests/test_config.py
git commit -m "feat(worker): allow selecting the mageflow inference backend"
```

### Task 6: Write the Mage-Flow adapter

**Files:**
- Create: `worker/src/imageforge_worker/inference/mageflow.py`
- Test: `worker/tests/test_mageflow_adapter.py`

- [ ] **Step 1: Write the failing tests**

Model them on `worker/tests/test_flux_adapter.py`, substituting the class names recorded in Phase 0:

```python
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from imageforge_worker.domain import GenerationSettings
from imageforge_worker.inference.base import GenerationJob
from imageforge_worker.inference.mageflow import MageFlowInferenceAdapter


def test_incomplete_snapshot_is_rejected(tmp_path: Path):
    adapter = MageFlowInferenceAdapter(tmp_path)
    with pytest.raises(RuntimeError, match="incomplete"):
        adapter._resolve_local_snapshot()


def test_missing_int8_transformer_is_rejected(tmp_path: Path):
    adapter = MageFlowInferenceAdapter(tmp_path)
    with pytest.raises(RuntimeError, match="INT8 transformer"):
        adapter._resolve_int8_transformer_path()


def test_references_are_rejected_because_turbo_is_text_to_image_only(tmp_path: Path):
    adapter = MageFlowInferenceAdapter(tmp_path)
    adapter._pipeline = object()
    adapter._torch = SimpleNamespace()
    job = GenerationJob(
        index=1,
        prompt="a prompt",
        seed=0,
        settings=GenerationSettings(),
        references=(object(),),
    )
    with pytest.raises(RuntimeError, match="does not accept reference images"):
        adapter._generate_sync(job)


def test_a_non_nvidia_device_is_rejected(tmp_path: Path, monkeypatch):
    fake_torch = _fake_torch(gpu_name="Apple M3 Max")
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    adapter = MageFlowInferenceAdapter(tmp_path)
    with pytest.raises(RuntimeError, match="not an NVIDIA GPU"):
        adapter._load_pipeline("/snapshot", "/int8.safetensors")
```

Add `_fake_torch` by copying the fake-torch helper already used in `test_flux_adapter.py` rather than inventing a second one.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd worker && python -m pytest tests/test_mageflow_adapter.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'imageforge_worker.inference.mageflow'`.

- [ ] **Step 3: Write the adapter**

`worker/src/imageforge_worker/inference/mageflow.py` is a near-copy of `flux.py` with four differences: the profile comes from `MAGE_FLOW_TURBO`, `_resolve_int8_transformer_path` locates the single INT8 file, `_load_pipeline` uses the class names and load calls recorded in `docs/MAGEFLOW_STAGING.md`, and `_generate_sync` rejects references instead of forwarding them.

```python
from __future__ import annotations

import asyncio
import io
import time
from pathlib import Path
from typing import Any

from PIL import Image

from ..constants import MIN_CUDA_VERSION, MIN_GPU_MEMORY_BYTES, MIN_GPU_MEMORY_MIB
from ..domain import GenerationSettings, HealthPhase
from ..model_profiles import MAGE_FLOW_TURBO
from .base import GenerationJob, InferenceResult, PhaseReporter
from .flux import _parse_cuda_version

INT8_TRANSFORMER_FILENAME = "mage_flow_turbo_int8_convrot.safetensors"


class MageFlowInferenceAdapter:
    """Pinned, offline-only INT8 Mage-Flow Turbo adapter for one approved CUDA GPU."""

    def __init__(self, model_cache_dir: Path) -> None:
        self.model_cache_dir = model_cache_dir
        self._pipeline: Any | None = None
        self._torch: Any | None = None
        self._gpu_name: str | None = None
        self._gpu_total_memory_bytes = 0

    async def startup(self, report_phase: PhaseReporter) -> None:
        await report_phase(HealthPhase.WEIGHTS, 0.1)
        snapshot_path = await asyncio.to_thread(self._resolve_local_snapshot)
        transformer_path = await asyncio.to_thread(self._resolve_int8_transformer_path)
        await report_phase(HealthPhase.WEIGHTS, 1.0)
        await report_phase(HealthPhase.GPU_LOAD, 0.05)
        await asyncio.to_thread(self._load_pipeline, snapshot_path, transformer_path)
        await report_phase(HealthPhase.GPU_LOAD, 1.0)
        await report_phase(HealthPhase.WARMUP, 0.1)
        warmup = GenerationJob(
            index=1,
            prompt="A neutral studio lighting calibration chart",
            seed=0,
            settings=GenerationSettings(),
        )
        await self.generate(warmup)
        if self._torch is not None:
            self._torch.cuda.synchronize()
            self._torch.cuda.reset_peak_memory_stats(0)
        await report_phase(HealthPhase.WARMUP, 1.0)
        await report_phase(HealthPhase.READY, 1.0)

    def _resolve_local_snapshot(self) -> str:
        self.model_cache_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        from huggingface_hub import snapshot_download

        # local_files_only is deliberate: normal Pod starts never download model weights.
        snapshot_path = snapshot_download(
            repo_id=MAGE_FLOW_TURBO.model_id,
            revision=MAGE_FLOW_TURBO.revision,
            cache_dir=str(self.model_cache_dir),
            local_files_only=True,
        )
        missing = [
            relative_name
            for relative_name in MAGE_FLOW_TURBO.required_files
            if not (Path(snapshot_path) / relative_name).is_file()
        ]
        if missing:
            raise RuntimeError("the pinned local Mage-Flow snapshot is incomplete")
        return snapshot_path

    def _resolve_int8_transformer_path(self) -> str:
        matches = sorted(self.model_cache_dir.rglob(INT8_TRANSFORMER_FILENAME))
        if not matches:
            raise RuntimeError("the pinned INT8 transformer is missing from the volume")
        return str(matches[0])

    def _load_pipeline(self, snapshot_path: str, transformer_path: str) -> None:
        import torch

        # Class names and load calls are transcribed from the Phase 0 spike
        # recorded in docs/MAGEFLOW_STAGING.md.
        from diffusers import MageFlowPipeline, MageFlowTransformer2DModel

        if not torch.cuda.is_available():
            self._torch = torch
            raise RuntimeError("CUDA is unavailable")
        if torch.cuda.device_count() != 1:
            self._torch = torch
            raise RuntimeError("ImageForge requires exactly one visible CUDA GPU")
        cuda_version = _parse_cuda_version(torch.version.cuda)
        if cuda_version < MIN_CUDA_VERSION:
            self._torch = torch
            raise RuntimeError("ImageForge requires a PyTorch CUDA runtime of at least 13.0")
        gpu_name = torch.cuda.get_device_name(0)
        total_memory = torch.cuda.get_device_properties(0).total_memory
        self._torch = torch
        self._gpu_name = gpu_name
        self._gpu_total_memory_bytes = total_memory
        if "NVIDIA" not in gpu_name.upper():
            raise RuntimeError("the visible CUDA device is not an NVIDIA GPU")
        if total_memory < MIN_GPU_MEMORY_BYTES:
            raise RuntimeError(f"the visible GPU has less than {MIN_GPU_MEMORY_MIB} MiB of VRAM")

        transformer = MageFlowTransformer2DModel.from_single_file(
            transformer_path,
            torch_dtype=torch.bfloat16,
            local_files_only=True,
        )
        pipeline = MageFlowPipeline.from_pretrained(
            snapshot_path,
            transformer=transformer,
            torch_dtype=torch.bfloat16,
            local_files_only=True,
        )
        pipeline.to("cuda")
        pipeline.set_progress_bar_config(disable=True)
        transformer_parameter = next(pipeline.transformer.parameters())
        if transformer_parameter.device.type != "cuda":
            raise RuntimeError("the Mage-Flow transformer was not loaded on CUDA")
        self._pipeline = pipeline

    async def generate(self, job: GenerationJob) -> InferenceResult:
        if self._pipeline is None or self._torch is None:
            raise RuntimeError("the Mage-Flow pipeline is not loaded")
        return await asyncio.to_thread(self._generate_sync, job)

    def _generate_sync(self, job: GenerationJob) -> InferenceResult:
        if job.references:
            raise RuntimeError("Mage-Flow Turbo does not accept reference images")
        torch = self._torch
        pipeline = self._pipeline
        torch.cuda.synchronize()
        inference_started = time.perf_counter()
        with torch.inference_mode():
            image = pipeline(
                prompt=job.prompt,
                height=job.settings.height,
                width=job.settings.width,
                guidance_scale=job.settings.guidance,
                num_inference_steps=job.settings.steps,
                generator=torch.Generator(device="cuda").manual_seed(job.seed),
            ).images[0]
        torch.cuda.synchronize()
        inference_ms = (time.perf_counter() - inference_started) * 1000

        image = image.convert("RGB")
        if image.size != (job.settings.width, job.settings.height):
            raise RuntimeError("Mage-Flow returned an unexpected image size")
        jpeg_started = time.perf_counter()
        jpeg_buffer = io.BytesIO()
        image.save(
            jpeg_buffer,
            format="JPEG",
            quality=job.settings.jpeg_quality,
            optimize=False,
            progressive=False,
            subsampling=0,
        )
        jpeg_encode_ms = (time.perf_counter() - jpeg_started) * 1000

        preview_started = time.perf_counter()
        preview: Image.Image = image.resize(
            (job.settings.preview_width, job.settings.preview_height), Image.Resampling.LANCZOS
        )
        preview_buffer = io.BytesIO()
        preview.save(preview_buffer, format="WEBP", quality=85, method=4, exact=True)
        preview_encode_ms = (time.perf_counter() - preview_started) * 1000
        return InferenceResult(
            jpeg=jpeg_buffer.getvalue(),
            preview=preview_buffer.getvalue(),
            inference_ms=inference_ms,
            jpeg_encode_ms=jpeg_encode_ms,
            preview_encode_ms=preview_encode_ms,
        )

    async def shutdown(self) -> None:
        pipeline = self._pipeline
        self._pipeline = None
        if pipeline is not None:
            del pipeline
        if self._torch is not None and self._torch.cuda.is_available():
            self._torch.cuda.empty_cache()

    def gpu_snapshot(self) -> dict[str, object]:
        if self._torch is None or not self._torch.cuda.is_available():
            return {
                "state": "loading",
                "available": False,
                "approved": False,
                "name": self._gpu_name,
                "device_count": 0,
                "total_memory_bytes": self._gpu_total_memory_bytes,
                "memory_allocated_bytes": 0,
                "memory_reserved_bytes": 0,
                "peak_memory_allocated_bytes": 0,
                "peak_memory_reserved_bytes": 0,
            }
        torch = self._torch
        return {
            "state": "ready" if self._pipeline is not None else "loading",
            "available": True,
            "approved": self._gpu_total_memory_bytes >= MIN_GPU_MEMORY_BYTES,
            "name": self._gpu_name,
            "device_count": torch.cuda.device_count(),
            "total_memory_bytes": self._gpu_total_memory_bytes,
            "memory_allocated_bytes": torch.cuda.memory_allocated(0),
            "memory_reserved_bytes": torch.cuda.memory_reserved(0),
            "peak_memory_allocated_bytes": torch.cuda.max_memory_allocated(0),
            "peak_memory_reserved_bytes": torch.cuda.max_memory_reserved(0),
        }
```

- [ ] **Step 4: Run the adapter tests and watch them pass**

Run: `cd worker && python -m pytest tests/test_mageflow_adapter.py -v`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add worker/src/imageforge_worker/inference/mageflow.py worker/tests/test_mageflow_adapter.py
git commit -m "feat(worker): add the INT8 Mage-Flow Turbo inference adapter"
```

### Task 7: Wire the adapter into app startup

**Files:**
- Modify: `worker/src/imageforge_worker/app.py:208`
- Test: `worker/tests/test_app_backend_selection.py`

- [ ] **Step 1: Write the failing test**

```python
from pathlib import Path

from imageforge_worker.app import build_inference_adapter
from imageforge_worker.inference.fake import FakeInferenceAdapter
from imageforge_worker.inference.flux import FluxInferenceAdapter
from imageforge_worker.inference.mageflow import MageFlowInferenceAdapter


def test_each_backend_builds_its_own_adapter(tmp_path: Path):
    assert isinstance(build_inference_adapter("flux", tmp_path), FluxInferenceAdapter)
    assert isinstance(build_inference_adapter("mageflow", tmp_path), MageFlowInferenceAdapter)
    assert isinstance(build_inference_adapter("fake", tmp_path), FakeInferenceAdapter)
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd worker && python -m pytest tests/test_app_backend_selection.py -v`
Expected: FAIL with `ImportError: cannot import name 'build_inference_adapter'`.

- [ ] **Step 3: Extract and extend the selection**

In `worker/src/imageforge_worker/app.py`, replace the inline `if settings.inference_backend == "fake":` branch at line 208 with a call to a new module-level function:

```python
def build_inference_adapter(backend: str, model_cache_dir: Path) -> InferenceAdapter:
    if backend == "fake":
        from .inference.fake import FakeInferenceAdapter

        return FakeInferenceAdapter()
    if backend == "mageflow":
        from .inference.mageflow import MageFlowInferenceAdapter

        return MageFlowInferenceAdapter(model_cache_dir)
    from .inference.flux import FluxInferenceAdapter

    return FluxInferenceAdapter(model_cache_dir)
```

Keep the existing construction site's arguments identical — read the surrounding lines and pass whatever `FluxInferenceAdapter` is currently given.

- [ ] **Step 4: Run the whole worker suite**

Run: `cd worker && python -m pytest -q`
Expected: all passed, no new failures.

- [ ] **Step 5: Commit**

```bash
git add worker/src/imageforge_worker/app.py worker/tests/test_app_backend_selection.py
git commit -m "feat(worker): select the inference adapter from the configured backend"
```

### Task 8: Publish a staging worker image

**Files:**
- Modify: `worker/pyproject.toml`, `worker/src/imageforge_worker/constants.py:4`

- [ ] **Step 1: Bump the worker version**

Set `WORKER_VERSION` to `0.2.0-mageflow-rc1` in `worker/src/imageforge_worker/constants.py:4` and the matching `version` in `worker/pyproject.toml`.

Do **not** touch `packages/runpod-client/src/health.ts` yet. The desktop must keep expecting the production version while production is still on FLUX — this staging image is driven by curl, not by the desktop.

- [ ] **Step 2: Confirm the contract test fails as designed**

Run: `npm test -- workerHealthContract`
Expected: FAIL — the worker/desktop version binding is intentionally broken for the staging image. Note this in the commit body so nobody "fixes" it early.

- [ ] **Step 3: Build and push the staging image**

Trigger the `Pala-LakshmanSai/imageforge-worker` publisher workflow from this branch. Record the printed OCI digest in `docs/MAGEFLOW_STAGING.md`.

- [ ] **Step 4: Commit**

```bash
git add worker/pyproject.toml worker/src/imageforge_worker/constants.py docs/MAGEFLOW_STAGING.md
git commit -m "build(worker): publish the 0.2.0-mageflow-rc1 staging image

The desktop health-contract test fails on purpose until Phase 3: production is
still pinned to the FLUX worker version."
```

---

## Phase 2 — Prove it on the staging volume

### Task 9: Boot the staging worker and clear the health gate

**Files:**
- Modify: `docs/MAGEFLOW_STAGING.md`

- [ ] **Step 1: Create a staging Pod**

Same shape as production but: the staging image digest, volume `imageforge-mageflow-50gb`, `IMAGEFORGE_INFERENCE_BACKEND=mageflow`, its own throwaway `IMAGEFORGE_AUTH_TOKENS_JSON`. Production's volume, template and secret are not referenced.

- [ ] **Step 2: Watch the health endpoint reach ready**

```bash
curl -s https://<pod-id>-8000.proxy.runpod.net/v1/health | python -m json.tool
```

Expected: `"phase": "ready"`, `"model": {"status": "ready", …}`, `"version": "0.2.0-mageflow-rc1"`.

- [ ] **Step 3: Generate the fixed comparison set**

Submit one batch of 20 prompts through the authenticated batch route. The set must include, at minimum: 5 prompts with legible on-screen text (signage, book covers, packaging), 5 close-up human faces including hands, 5 multi-subject scenes with explicit spatial relationships, 5 prompts copied verbatim from a recent real production batch.

- [ ] **Step 4: Record throughput and memory**

From `/v1/health` and the batch manifest, record median ms/image at 1280×720, peak VRAM, and the boot-to-ready duration. Put them in `docs/MAGEFLOW_STAGING.md` next to the FLUX numbers already in `docs/QA_LOG.md`.

- [ ] **Step 5: Commit**

```bash
git add docs/MAGEFLOW_STAGING.md
git commit -m "docs: record the Mage-Flow staging health and throughput evidence"
```

### Task 10: Side-by-side quality gate

**Files:**
- Modify: `docs/MAGEFLOW_STAGING.md`

- [ ] **Step 1: Run the same 20 prompts on production FLUX**

Use an ordinary production session with the same seeds and aspect ratio. This is the only Phase 2 step that touches production, and it is read-only generation — no code, template, or volume change.

- [ ] **Step 2: Score both sets**

For each of the four prompt categories, count images that are usable without regeneration. Record the counts as a table: category, FLUX usable/20, Mage-Flow usable/20.

- [ ] **Step 3: Decide go / no-go**

Go requires Mage-Flow to be at least as good on faces and clearly better on text, with median ms/image no worse than 1.5× FLUX and peak VRAM inside the floor claimed by the profile. Write the decision and the numbers behind it into `docs/MAGEFLOW_STAGING.md`.

- [ ] **Step 4: Stop the staging Pod**

Delete the staging Pod. Keep the volume until Phase 4.

- [ ] **Step 5: Commit**

```bash
git add docs/MAGEFLOW_STAGING.md
git commit -m "docs: record the Mage-Flow versus FLUX quality gate"
```

**STOP. This is the go/no-go checkpoint.** On no-go, Phases 0–2 are discarded by deleting the staging volume; production never changed.

---

## Phase 3 — Cutover (the only production-visible change)

Every task in this phase lands on one branch and ships as one release. Production downtime is one Pod restart at Task 15.

### Task 11: Repoint the worker constants

**Files:**
- Modify: `worker/src/imageforge_worker/constants.py:6-8,44-46,49-68`
- Modify: `worker/Dockerfile:15-16,30`
- Modify: `worker/scripts/run_volume_gate.py:163`
- Modify: `worker/deploy/runtime.env.example`

- [ ] **Step 1: Update the failing tests first**

In `worker/tests/`, change every assertion that names `black-forest-labs/FLUX.2-klein-4B` to `microsoft/Mage-Flow-Turbo`, and every `MODEL_PRECISION` assertion to `int8-convrot`.

- [ ] **Step 2: Run the suite and watch it fail**

Run: `cd worker && python -m pytest -q`
Expected: FAIL on the model-identity assertions.

- [ ] **Step 3: Point the constants at the profile**

```python
from .model_profiles import MAGE_FLOW_TURBO

MODEL_ID: Final = MAGE_FLOW_TURBO.model_id
MODEL_REVISION: Final = MAGE_FLOW_TURBO.revision
MODEL_PRECISION: Final = MAGE_FLOW_TURBO.precision
INFERENCE_STEPS: Final = MAGE_FLOW_TURBO.steps
GUIDANCE_SCALE: Final = MAGE_FLOW_TURBO.guidance
MIN_GPU_MEMORY_MIB: Final = MAGE_FLOW_TURBO.min_gpu_memory_mib
```

Delete `MODEL_ALLOW_PATTERNS` and `REQUIRED_MODEL_FILES` from `constants.py`; `flux.py` now imports `FLUX2_KLEIN.required_files` from the profile module. Set `WORKER_VERSION` to `0.2.0`.

Set `IMAGEFORGE_INFERENCE_BACKEND=mageflow` in `worker/Dockerfile:30` and `worker/deploy/runtime.env.example`, and update the `ai.imageforge.model` / `ai.imageforge.model-revision` labels.

Update `worker/scripts/run_volume_gate.py:163` to expect the new model id.

- [ ] **Step 4: Run the suite and watch it pass**

Run: `cd worker && python -m pytest -q && ruff check .`
Expected: all passed, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add worker/
git commit -m "feat(worker)!: generate with Mage-Flow Turbo INT8 instead of FLUX.2 Klein"
```

### Task 12: Repoint the TypeScript contracts

**Files:**
- Modify: `packages/runpod-client/src/types.ts:94`, `src/config.ts:193-218`, `src/health.ts:14`, `src/benchmark-v2.ts:10,113`
- Modify: `packages/runpod-client/config/imageforge-runpod.schema.json:137`, `config/imageforge-runpod.example.json:22`
- Modify: `contracts/gpu-benchmark-raw-v2.schema.json:22`, `contracts/gpu-benchmark-v2.vectors.json:6`
- Modify: `packages/runpod-client/test/health.test.ts:184`, `test/helpers.ts:10`

- [ ] **Step 1: Update the fixtures first**

Change `model: "black-forest-labs/FLUX.2-klein-4B"` to `model: "microsoft/Mage-Flow-Turbo"` in `test/helpers.ts:10` and `test/health.test.ts:184`, and set `WORKER_VERSION` in `src/health.ts:14` to `0.2.0`.

- [ ] **Step 2: Run the package tests and watch them fail**

Run: `npm test --workspace packages/runpod-client`
Expected: FAIL — the literal union type and the `const` schema still say FLUX.

- [ ] **Step 3: Change the type, the validator, and the schemas**

Replace the literal `"black-forest-labs/FLUX.2-klein-4B"` with `"microsoft/Mage-Flow-Turbo"` at every listed line, and update the `config.ts:194` error message to `${field}.model must use Mage-Flow Turbo.`

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test --workspace packages/runpod-client && npm run typecheck`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add packages/ contracts/
git commit -m "feat(runpod-client)!: pin the desktop contract to Mage-Flow Turbo"
```

### Task 13: Invalidate the FLUX benchmark evidence

**Files:**
- Modify: `contracts/gpu-benchmark-v2.vectors.json:6`
- Modify: `docs/RUNPOD_OPERATIONS.md`

- [ ] **Step 1: Write the failing test**

Add to the benchmark suite in `packages/runpod-client/test/`:

```typescript
it("rejects a benchmark record measured on the previous model", () => {
  const record = { ...validRecord, modelId: "black-forest-labs/FLUX.2-klein-4B" };
  expect(() => parseBenchmarkV2(record)).toThrow(/modelId/);
});
```

- [ ] **Step 2: Run it**

Run: `npm test --workspace packages/runpod-client -- benchmark`
Expected: PASS once Task 12 landed — if it fails, the `const` in `benchmark-v2.ts:113` was missed.

- [ ] **Step 3: Delete the stale measurements**

Every stored benchmark-v2 record is now ineligible: `docs/RUNPOD_OPERATIONS.md` already requires a matching model revision, precision and steps. Remove the FLUX vectors from `contracts/gpu-benchmark-v2.vectors.json` and replace the "current studio profile" cold-start ranking paragraph in `docs/RUNPOD_OPERATIONS.md` with the reviewed fixed order plus a sentence saying no fresh measured quorum exists until Mage-Flow benchmarks are recorded.

Also update the "16 GB candidates remain eligible because the pinned 4B BF16 checkpoint is documented at roughly 13 GB" sentence to cite the INT8 Mage-Flow peak VRAM measured in Phase 0.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add contracts/ docs/RUNPOD_OPERATIONS.md
git commit -m "chore!: invalidate FLUX-era GPU benchmark evidence"
```

### Task 14: Repoint the native layer, the UI copy, and the docs

**Files:**
- Modify: `src-tauri/src/native/worker.rs:31`
- Modify: `src/adapters/imageForgeAdapter.ts:39,90,175,184,223`, `src/adapters/gpuLifecycleCoordinator.ts:78`, `src/adapters/runtimeProjection.ts:52`, `src/domain/reducer.ts:527,817`
- Modify: `src/screens/CreateScreen.tsx:387`, `src/screens/SettingsScreen.tsx:174,184`
- Modify: `src/adapters/gpuLifecycleCoordinator.test.ts:657`, `src/adapters/imageForgeAdapter.test.ts:13`, `src/adapters/productionImageForgeAdapter.test.ts:127`
- Modify: `README.md`, `docs/PRODUCT_SPEC.md:67,105,123`, `docs/ONBOARDING.md:27`, `docs/LEGACY_SYSTEM_AUDIT.md:12,29`, `docs/DEPLOYMENT_RUNBOOK.md`

- [ ] **Step 1: Update the test fixtures first**

In the three `src/adapters/*.test.ts` files, change `modelPreset: 'flux2-klein-bf16'` to `modelPreset: 'mageflow-turbo-int8'` and the model id strings to `microsoft/Mage-Flow-Turbo`.

- [ ] **Step 2: Run and watch them fail**

Run: `npm test`
Expected: FAIL on the preset literal and model id in `imageForgeAdapter.ts` and `gpuLifecycleCoordinator.ts`.

- [ ] **Step 3: Change the preset, the id, and the user-visible strings**

- `src/adapters/imageForgeAdapter.ts`: preset literal and type → `'mageflow-turbo-int8'` at lines 39, 90, 175, 184; line 223 detail → `'Loading Mage-Flow Turbo 4B from the volume · INT8'`
- `src/adapters/gpuLifecycleCoordinator.ts:78` and `src-tauri/src/native/worker.rs:31` → `microsoft/Mage-Flow-Turbo`
- `src/adapters/runtimeProjection.ts:52` → `'Loading Mage-Flow Turbo 4B from the network volume · INT8'`
- `src/domain/reducer.ts:527` → `'Loading Mage-Flow Turbo 4B · INT8'`; line 817 → `'Mage-Flow Turbo 4B is warm and ready for one batch.'`
- `src/screens/CreateScreen.tsx:387` → `<dd>Mage-Flow Turbo 4B</dd>`
- `src/screens/SettingsScreen.tsx:174` → model path `/workspace/models/mage-flow-turbo`; line 184 → `microsoft/<br />Mage-Flow-Turbo`

In the docs, replace every FLUX.2 Klein reference with Mage-Flow Turbo, and add one sentence to `docs/PRODUCT_SPEC.md` stating that Mage-Flow Turbo is text-to-image only, so batch reference images are no longer accepted.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all passed.

- [ ] **Step 5: Grep for stragglers**

Run: `grep -rn "FLUX\|klein" --include="*.ts" --include="*.tsx" --include="*.rs" --include="*.json" --include="*.md" src src-tauri packages contracts docs README.md | grep -v superpowers/plans`
Expected: only historical entries in `docs/QA_LOG.md` and `docs/LEGACY_SYSTEM_AUDIT.md` that deliberately describe the past.

- [ ] **Step 6: Commit**

```bash
git add src src-tauri docs README.md
git commit -m "feat!: present Mage-Flow Turbo as the ImageForge model"
```

### Task 15: Production cutover

**Files:**
- Modify: `docs/DEPLOYMENT_RUNBOOK.md`, `docs/QA_LOG.md`

- [ ] **Step 1: Prepare the production volume**

With no batch running, start one Pod on the **production** volume and run:

```bash
python /opt/imageforge-worker/scripts/prepare_mageflow_volume.py \
  --cache-dir /workspace/models/huggingface \
  --confirm-download
```

The FLUX snapshot stays on the volume — it is the rollback.

- [ ] **Step 2: Publish the 0.2.0 worker image**

Trigger the publisher workflow on the merge commit. Record the digest.

- [ ] **Step 3: Repin the template**

Update template `imageforge-flux-worker-v1` (`q8sfgixfy2`) to the new digest and set `IMAGEFORGE_INFERENCE_BACKEND=mageflow`. Rename the template to `imageforge-mageflow-worker-v1` in the console and update its ID in `docs/DEPLOYMENT_RUNBOOK.md`.

- [ ] **Step 4: Ship the desktop release and verify**

Both editors install the new desktop build, press Start GPU, and run one 5-prompt batch. Expected: `/v1/health` reports `version 0.2.0` and `microsoft/Mage-Flow-Turbo`, and the batch completes with ordered artifacts.

- [ ] **Step 5: Record the release evidence**

Add a `docs/QA_LOG.md` entry with the date, image digest, worker version, model revision, GPU used, and the smoke result.

- [ ] **Step 6: Commit**

```bash
git add docs/DEPLOYMENT_RUNBOOK.md docs/QA_LOG.md
git commit -m "docs: record the Mage-Flow Turbo production cutover"
```

---

## Phase 4 — Rollback and cleanup

### Task 16: Write down the rollback and retire the staging volume

**Files:**
- Modify: `docs/RECOVERY.md`

- [ ] **Step 1: Document the rollback**

Add a "Rolling back to FLUX.2 Klein" section to `docs/RECOVERY.md`: repin the template to the previous digest `sha256:38ed950746e98a65ae13eee35583408dc367e268d91697b49538e5a623efa5a4` with `IMAGEFORGE_INFERENCE_BACKEND=flux`, and have both editors install the previous desktop build. State that the FLUX snapshot remains on the production volume for this purpose and give the exact date after which it may be deleted.

- [ ] **Step 2: Delete the staging volume**

After one full week of production batches on Mage-Flow, delete `imageforge-mageflow-50gb` in the console to stop its monthly charge.

- [ ] **Step 3: Commit**

```bash
git add docs/RECOVERY.md
git commit -m "docs: record the FLUX rollback path for the Mage-Flow release"
```
