# Task 016 — Fast cold worker boot

## Problem

Attaching an existing network volume with many terminal batch manifests makes worker initialization scale with all historical batches. A measured 85-manifest volume spent 611.6 seconds in storage recovery even though checkpoint verification took 0.16 seconds and GPU loading took 7.3 seconds. Frequent Pod start/stop therefore takes about 15 minutes.

## Acceptance criteria

- AC-1: Normal cold boot discovers the sole active batch by reading a crash-safe durable active-batch marker and its referenced manifest, without parsing terminal history.
- AC-2: Creating, resuming, retrying, cancelling, completing, failing, and recovering batches keep the active marker consistent with the manifest's lock-holding state.
- AC-3: A missing, corrupt, stale, or inconsistent marker cannot admit a second active batch; recovery performs a safe bounded/full compatibility scan and either repairs an unambiguous state or fails closed.
- AC-4: Existing v0.2.4 volumes without a marker remain compatible and acquire a correct marker during initialization.
- AC-5: Status and studio observation after initialization do not rescan historical manifests.
- AC-6: Submission replay, duplicate-submission detection, artifact recovery, process presence, active-volume lease, and GPU-control guards retain their existing fail-closed behavior.
- AC-7: Storage initialization progress/logging identifies active-batch recovery separately from model verification and loading.
- AC-8: An 85-terminal-manifest deterministic delayed-filesystem benchmark demonstrates O(1) manifest document reads on subsequent marker-backed boot, with benchmark numbers recorded as evidence.
- AC-9: Runtime container slimming is limited to dependencies proven unnecessary; otherwise current image composition is retained and the measured storage fix is delivered independently.

## Non-goals

- NG-1: Keeping a Pod or GPU warm between user sessions.
- NG-2: Deleting historical manifests, submission tombstones, images, or network-volume model weights.
- NG-3: Changing the model, warm-up inference, GPU-selection policy, one-active-batch rule, or explicit Start/Stop behavior.
- NG-4: Publishing a worker image, GitHub release, installer, or starting/stopping paid GPU resources.
- NG-5: Claiming a live RunPod speedup without a separately authorized paid validation run.

## Relevant files

- `worker/src/imageforge_worker/persistence.py`: crash-safe active marker and manifest storage.
- `worker/src/imageforge_worker/controller.py`: boot recovery and active-state transitions.
- `worker/src/imageforge_worker/startup.py`: initialization phase reporting.
- `worker/tests/`: compatibility, crash-seam, recovery, observation, and benchmark tests.
- `worker/Dockerfile`: runtime layer inspection and only proven-safe slimming.

## Automated tests

- Marker-backed boot with 85 terminal manifests reads only the marker-referenced manifest.
- Legacy markerless boot scans once, repairs the marker, and the next boot is O(1).
- Running, paused, interrupted, cancelling, completed, failed, and cancelled transitions publish or clear the marker at safe durable boundaries.
- Missing, corrupt, stale, mismatched, and duplicate-active cases recover unambiguously or fail closed.
- Injected crashes around marker write/rename/clear never permit a second active admission.
- Repeated status/studio polling does not increase historical manifest reads.
- Existing submission replay/corruption and duplicate-worker/lease tests remain green.
- Full worker test suite passes.

## Manual verification

1. Run the deterministic 85-manifest delayed-storage benchmark twice; expect compatibility scan only on first markerless boot and one manifest read on marker-backed boot.
2. Start the local worker fixture and poll health/status/studio repeatedly; expect stable active state and no historical-read growth.
3. Inspect the final Docker image dependency/layer report; record any retained large layers and rationale.

## Evidence required

- Focused and full worker test commands with pass counts.
- Before/after deterministic benchmark timings and `volume_manifest_reads` counts.
- Docker dependency/layer inspection result.
- Independent ImageForge review with no unresolved must-fix findings.

## Verification record — 2026-09-13

- `PYTHONPATH=/Volumes/ESD-USB/ImageForge/worker .venv/bin/pytest -q -m 'not real_gpu'`: 162 passed, 1 deselected.
- `.venv/bin/ruff check src tests`: all checks passed.
- Deterministic 20 ms/read, 85-manifest fixture: markerless migration 2.416 s and 85 reads; indexed restart plus first status 0.007 s and 0 reads.
- Post-repair review: no unresolved must-fix findings; worker source is safe to integrate.
- Docker runtime image verification remains blocked locally: Docker Desktop containerd metadata returned `input/output error`. No image was built or published and no paid GPU was started.
