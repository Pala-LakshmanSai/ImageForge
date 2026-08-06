# Task 015 — Resolve the live post-Start boot stall

## Problem

After an explicit GPU Start, RunPod creates and starts the requested Pod, but
ImageForge remains indefinitely at 39% with the message "Attaching the
persistent ImageForge network volume." The UI projection is not sufficient to
identify whether Pod observation, proxy discovery, worker process startup,
storage initialization, model loading, or health validation is the real
blocking point.

## Acceptance criteria

- AC-1: A live explicit Start is traced from the native provider request through
  Pod observation and every worker health attempt, with safe evidence identifying
  the first failing or non-advancing boundary.
- AC-2: With a healthy configured Pod, ImageForge advances from provisioning
  through the measured worker boot phases to Ready; it does not remain at the
  synthetic 39% storage stage after the worker reports a later phase.
- AC-3: When the worker cannot become healthy, ImageForge surfaces the actual
  typed boot/transport failure after the bounded readiness interval and keeps
  the running billed Pod visible and stoppable.
- AC-4: The fix preserves the fixed template, immutable worker image, EU-RO-1
  network volume, one-GPU policy, explicit Start/Stop boundary, and secret-safe
  diagnostics.
- AC-5: Automated coverage reproduces the discovered failure and proves the
  corrected post-Start observation/health path, including reconnect and worker
  boot-error behavior.

## Non-goals

- NG-1: Do not change GPU ranking, pricing policy, the FLUX model, generation
  settings, Pod template/volume identity, or Stop/Switch behavior.
- NG-2: Do not add automatic Pod termination, automatic paid retries, package
  installation, or model downloads during normal boot.
- NG-3: Do not redesign the progress bar beyond any minimal correction required
  to report the authoritative phase or failure.

## Relevant files

- `src/adapters/productionImageForgeAdapter.ts`: projects native Start and live
  Pod/worker observations into application state.
- `src/adapters/gpuLifecycleCoordinator.ts`: observes Pod state and worker health.
- `packages/runpod-client/src/lifecycle.ts`: maps provider and health responses
  into boot phases and readiness polling.
- `packages/runpod-client/src/health.ts`: validates `/v1/health` responses.
- `src-tauri/src/native/gpu_inventory.rs`: native Start journal and create result.
- `src-tauri/src/native/gpu_pod.rs`: authoritative managed-Pod observation.
- `src-tauri/src/native/worker.rs`: pinned worker proxy and authenticated API.
- `worker/src/imageforge_worker/app.py`: worker boot sequence and health route.
- `worker/src/imageforge_worker/inference/flux.py`: offline model and CUDA load.

## Automated tests

- Run the narrow desktop lifecycle/production-adapter tests and require all to
  pass with a fixture matching the discovered live failure.
- Run the RunPod client lifecycle/health tests and require all to pass.
- Run the narrow native Rust Start/Pod tests and require all to pass.
- Run worker health, FLUX adapter, persistence, and batch admission tests and
  require all non-paid tests to pass.
- After the repair, run desktop typecheck/build and the relevant full suites.

## Manual verification

1. Start from an authoritative offline observation and explicitly select/start
   one live GPU in the packaged ImageForge app.
2. Record the native Start/Pod observation sequence and worker/container logs
   without exposing credentials, prompts, or provider bodies.
3. Verify the network volume and pinned worker identity, then poll the derived
   proxy `/v1/health` through process, storage, weights, GPU load, warm-up, and
   Ready, or capture the exact bounded failure.
4. Confirm ImageForge reaches Ready and Generate admission is available while
   Stop GPU remains an explicit action.
5. Repeat one refresh/reconnect observation and confirm the state does not fall
   back to a stale 39% projection.

## Evidence required

- Timestamped safe native diagnostics and worker/container boot logs.
- The exact first failing request/phase from the reproduced run.
- Regression test output and production build/typecheck output.
- A final packaged-app screenshot showing Ready or the corrected typed failure.

## Findings from the live trace (2026-08-06)

Reproduced by starting one RTX 4090 Pod (`p24nu5m6s1l2ot`) from the packaged
app while polling the derived proxy `/v1/health` outside ImageForge.

| Time (UTC) | Observation |
| --- | --- |
| 18:12:25 | Native start journal records the Pod, state `provisioning` |
| 18:14:04 | Proxy answers 502 "Waiting for service to respond" |
| 18:14:21 | Worker answers 200: `phase=gpu_load`, `version=0.1.2` |
| 18:14:49 | Worker answers 200: `phase=ready`, `model=ready`, `gpu=ready` |
| 18:48 | ImageForge still shows `BOOTING · 39%` |

The worker booted normally (`storage` 18.2 s, `weights` 0.17 s, `gpu_load`
27.5 s, `warmup` 2.0 s) and was Ready roughly two and a half minutes after
create. Nothing on the Pod is stalled.

### Root cause

The pinned immutable image
`ghcr.io/pala-lakshmansai/imageforge-worker@sha256:f862e1ea…` is the **0.1.2**
build, but `packages/runpod-client/src/health.ts` pins `WORKER_VERSION` at
`0.1.3`. Every `/v1/health` response therefore fails the contract check and
raises `api_response_invalid`. `RunPodLifecycleController.#enrichPods`
flattened that into the generic `healthError` string, and `#podView` maps a
running Pod with any `healthError` to `booting` — the synthetic 39% stage —
with no bound and no surfaced reason.

The same stale image breaks coordinated Stop: the 0.1.2 image has no
`/v1/studio/*` routes (404, while `/v1/status` answers 401 and `/v1/batches`
answers 405), so Stop reports "The ImageForge worker returned an invalid
response shape".

The 0.1.3 image was never published. In
`Pala-LakshmanSai/imageforge-worker`, the last successful publish is commit
`dbb6b712` (2026-08-02), which is the 0.1.2 digest above. Every run since
fails before any step with:

> The job was not started because recent account payments have failed or your
> spending limit needs to be increased.

### Repairs

1. `worker/` source mirrored to the publisher repo as commit `8a89b17`. The
   image still needs a successful publish run, which is blocked on GitHub
   Actions billing. Once it publishes, repin the digest in
   `src/adapters/imageForgeAdapter.ts` and `src-tauri/src/native/{runpod,gpu_inventory}.rs`.
2. `packages/runpod-client/src/lifecycle.ts` now separates a worker health
   *contract* failure from a *transport* failure. A contract failure that
   outlives one bounded readiness interval (5 min) surfaces as the typed
   `worker_health_contract_failed` snapshot error and moves the Pod out of
   `booting`, while the billed Pod stays selected, visible, and stoppable.
