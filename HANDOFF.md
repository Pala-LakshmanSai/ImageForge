# ImageForge — handoff: "images sit in Ready, save slowly"

You are picking up mid-task on a project you have never seen. Read this whole file
before touching anything. Everything below was measured, not guessed.

## The project

ImageForge is a Tauri 2 desktop app (macOS/Windows) at `/Volumes/ESD-USB/ImageForge`.
It drives **one** RunPod GPU pod running a Python/FastAPI worker that generates
300–450 images per batch with `Comfy-Org/Mage-Flow` (BF16, 4 steps,
guidance 1.0) and streams the finished JPEGs down to the user's Mac while
generation continues.

Read `AGENTS.md` first — its product/engineering invariants are binding. Task
acceptance criteria live in `tasks/`, design docs in `docs/`.

Layout:
- `src/` — React/TypeScript renderer
- `src-tauri/src/native/` — Rust: RunPod control, worker HTTP, artifact download
- `worker/` — Python worker that runs on the pod
- Worker image is published from a **separate** repo: `Pala-LakshmanSai/imageforge-worker`
  (GitHub Actions, native amd64, ~6 min). This repo only validates it.

Key env facts:
- Pod region EU-RO-1, RTX 4090. User is in India → ~400 ms round trip per request
  through the Cloudflare-fronted `*.proxy.runpod.net` tunnel.
- Worker data root `/workspace/imageforge` is a RunPod **network volume**
  (`RUNPOD_VOLUME_ID: ukh207b26r`). Reads/writes/fsync there are slow.
- Local destination folder is `~/Downloads`; receipts at
  `~/Downloads/.imageforge/receipts/<batch_id>/NNNNNN.json`, each with
  `verifiedAtUnixMs` — this is the best local record of when an image was saved.

## The reported problem

Images finish generating on the pod and then sit in the `ready` state for a long
time before being saved locally. Worse for the **later** images in a batch.

## Root cause (confirmed, not a hypothesis)

`GET /v1/status` re-read and re-validated **every manifest of every batch ever
created** on the network volume, synchronously, on the asyncio event loop, while
holding the controller's single global lock. The desktop polls it every 1.5 s
(`src/App.tsx:629`).

Two independent full scans per poll:
1. `controller.status()` → `store.submission_store_corrupt()` →
   `_scan_submission_history()` — reads + Pydantic-validates every manifest.
2. `_discover_active_locked()` — loads every manifest again to find the active batch.

Because that lock is also needed by `_claim_next_attempt`, `_record_success`,
`GET /artifacts/{i}`, and `POST /receipts`, a scan blocked **both** generation and
artifact serving.

Evidence:
- `/v1/health` — which touches no manifest, no disk, no lock — returned in
  **26–28 s continuously** against the live pod. Six *parallel* requests all
  completed at the identical instant (27.278 s): a hard event-loop block
  releasing everything at once, not network latency (TCP connect 40 ms, TLS 100 ms).
- Two independent historical batches in `~/Downloads/.imageforge/receipts/` show
  the same shape: images 1–200 saved at **1.4 s each** (draining an
  already-generated backlog — that is the true download speed), then **28 s each**
  once live. 28 s ≈ the stall.
- Generation is only 4 steps on a 4090 (~2–4 s/image), so 28 s/image was never
  generation-bound.
- Benchmark with production-shaped history (12 batches × 450 images = 8.6 MB of
  JSON): full scan **63.7 ms** on local SSD, **0.07 ms** cached. On the network
  volume that 8.6 MB re-read per 1.5 s is where the ~27 s came from.

## What has been fixed (committed, worker image published)

Branch `fix/worker-0.1.3-repin-boot-stall`, three commits:

- `17ba2c9 fix: stop re-reading the whole batch history on every status poll`
  - `worker/src/imageforge_worker/persistence.py`
    - `submission_store_corrupt()` caches its verdict against a **stat-only**
      fingerprint of the namespace (`_submission_namespace_fingerprint`).
    - New `_read_manifest_document()` keeps the last 4 manifest documents keyed by
      `(st_ino, st_size, st_mtime_ns)`. Manifests are always replaced atomically,
      so a fingerprint match proves the cached bytes still match the volume.
      Only the I/O is elided — every caller still gets a freshly parsed, unaliased
      model. Re-stats after reading so a torn/superseded document is never cached.
    - New public `manifest_fingerprint(batch_id)`.
  - `worker/src/imageforge_worker/controller.py`
    - `_discover_active_locked(recover=False)` skips batches whose manifest
      fingerprint is unchanged since it last saw them terminal
      (`_inactive_batch_fingerprints`). `recover=True` always does the real work.
  - New test `worker/tests/test_status_history_scaling.py` — pins that 5 idle
    status polls over 4 historical batches read ≤5 manifests (was 40), and that a
    manifest corrupted *after* the cache is warm still yields
    `create_block_reason == "submission_store_corrupt"` (fail-closed preserved).
- `294b34e build: release worker 0.1.4 with the status-scan fix`
- `8d2589e build: repin the desktop to worker image 0.1.4`
  - New image: `ghcr.io/pala-lakshmansai/imageforge-worker@sha256:5f3b524d462c12555a8649f5b4bb8530e66a14f871d17f444e86a685c406c410`
  - Repinned in `src-tauri/src/native/runpod.rs`, `gpu_inventory.rs`, `worker.rs`,
    `src/adapters/imageForgeAdapter.ts`, and `docs/DEPLOYMENT_RUNBOOK.md`.

Verification status:
- Worker: 126 tests pass, `ruff` clean.
- Frontend: `tsc -b` clean, 418 vitest tests pass.
- Rust: **NOT yet verified** — see blocker below.
- Live effect: **NOT yet measured.** No pod has run the new image.

## Immediate blocker

`cargo test --release` and `npm run tauri:build` fail on this machine:

```
failed to define permissions for core:event: failed to read file
'.../out/permissions/event/autogenerated/._default.toml': stream did not contain valid UTF-8
```

These `._*` AppleDouble files are created by macOS on the exFAT removable disk
(`/Volumes/ESD-USB`). Tauri's build script reads that directory and chokes.
Workaround applied: `dot_clean -m src-tauri/target/release/build` plus
`COPYFILE_DISABLE=1`. A build was started with that but its outcome is unknown —
**check it first.** If `._*` files regenerate, strip them again before each build,
or add a build step that does.

Toolchain is NOT on PATH by default:
```bash
export RUSTUP_HOME=/Volumes/ESD-USB/ImageForge/.toolchains/rustup
export CARGO_HOME=/Volumes/ESD-USB/ImageForge/.toolchains/cargo
export PATH="/Volumes/ESD-USB/ImageForge/.toolchains/cargo/bin:$PATH"
```
Python worker venv: `worker/.venv/bin/python` (run pytest from `worker/`,
`--ignore=tests/test_real_gpu_smoke.py`).

## Your objective, in order

1. **Get the desktop app built and installed.** Resolve the AppleDouble build
   failure, run `cargo test --release`, then `npm run tauri:build`, then replace
   `/Applications/ImageForge.app` with the new bundle. The currently installed app
   is the OLD build pinned to the OLD image, so nothing is deployed on the desktop
   side yet.
2. **Measure the fix on a real pod.** Start a pod, run a batch, and prove it:
   - `curl -w '%{time_starttransfer}' https://<podId>-8000.proxy.runpod.net/v1/health`
     (unauthenticated, returns 200). It was 26–28 s. It should now be ~0.4 s.
   - After the batch, compute inter-save gaps from
     `~/Downloads/.imageforge/receipts/<batch_id>/*.json` `verifiedAtUnixMs`.
     Old live cadence was ~28 s/image. Target is a few seconds.
   - Report the real numbers. Do not claim success without them.
3. **If still slow, work the remaining known problems** (all real, all measured,
   none fixed yet — ordered by expected payoff):
   - **Artifact GET re-hashes the whole JPEG.** `controller.py:_file_matches`
     reads the file from the network volume and recomputes SHA-256 on every
     `GET /artifacts/{i}`, on the event loop, holding the lock — then
     `FileResponse` reads the same file again. Two full network-volume reads per
     download.
   - **One global `asyncio.Lock`** couples serving to generating. Splitting it
     (generation state vs. read path) removes the remaining coupling.
   - **Full manifest rewrite + fsync per acknowledged image** in
     `controller.accept_receipts` — dumps all ~450 records to the network volume
     for one image.
   - **No compression anywhere.** No `GZipMiddleware` in `worker/.../app.py`, and
     reqwest is built without the `gzip` feature (`src-tauri/Cargo.toml:27`) so it
     never sends `Accept-Encoding`. A completed 450-image manifest is ~0.72 MB and
     the client fetches it **twice per reconciliation pass**
     (`src/adapters/workerBatchCoordinator.ts:711`) on top of every 1.5 s poll.
     CAUTION: FastAPI's `GZipMiddleware` is not content-type aware and would also
     gzip JPEG `FileResponse`s, which breaks the strict `Content-Length` check in
     `src-tauri/src/native/download.rs`. Gzip JSON only, or add an ETag /
     `If-None-Match` on `get_batch` instead.
   - **Zero download concurrency.** Serial `await` loop
     (`src/adapters/workerBatchCoordinator.ts:671`) plus a global `io_lock` in
     `src-tauri/src/native/download.rs:93` held across GET → verify → fsync → ack.
     One image in flight, two serial round trips each, at ~400 ms RTT.
   - **Unbounded history growth.** Nothing prunes old batches from
     `/workspace/imageforge/batches`. The caches make this cheap now, but the
     volume still grows forever. Consider retention
     (`worker/src/imageforge_worker/cleanup_retention.py` exists).

## Rules to follow

- `AGENTS.md` is binding. Do not expand a task through opportunistic refactors.
- TDD: write the failing test first, and make it a test that would have caught the
  real defect (see `test_status_history_scaling.py` as the model).
- Do not claim anything is fixed without command output proving it.
- Deploying a worker change means: push `worker/` to
  `Pala-LakshmanSai/imageforge-worker` (its Actions workflow validates, builds
  amd64, pushes to GHCR, and prints the digest), then repin that digest in all
  five places listed above, then rebuild the desktop app.
- Starting a pod costs real money ($0.74/hr). Never add idle or automatic pod
  termination. Start/stop only on an explicit user click.
