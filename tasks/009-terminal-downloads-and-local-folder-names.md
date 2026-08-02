# Task 009 — Finish terminal downloads and use named local batch folders

## Problem

The desktop can project a worker batch as complete after a reconciliation pass downloads the artifacts visible at the start of that pass, even when the refreshed terminal manifest exposes additional ready artifacts. The terminal UI then stops polling and leaves successful images waiting locally. Native downloads also use the internal batch UUID as the visible local folder instead of the batch name entered by the user.

## Acceptance criteria

### AC-1 — Terminal manifests reach a local fixed point

- A terminal worker manifest is not presented as complete while any successful artifact remains ready and lacks a verified local receipt.
- Reconciliation continues until every currently ready artifact has been downloaded, checksum-verified, acknowledged, and reflected by a refreshed manifest.
- Reconciliation is bounded and cannot spin without adding a receipt or observing a manifest change.

### AC-2 — Recovery completes interrupted terminal downloads

- Reopening or refreshing a terminal batch with missing local artifacts resumes those downloads without duplicate final writes.
- A retryable download or acknowledgement error remains actionable and does not falsely mark the batch complete.
- A 24-image batch observed at 21 verified and 3 ready reaches 24 verified without submitting a new batch.

### AC-3 — Local folders use the user batch name

- New local batch folders use the user-visible batch name, preserving case and ordinary spaces.
- Native code sanitizes path separators, control characters, Windows-invalid characters, trailing dots/spaces, reserved names, blank names, and excessive length.
- Existing unrelated folders are never overwritten; deterministic numeric suffixes are added only on a real collision.
- The worker batch UUID remains the internal API, lease, receipt-ledger, and server-artifact identity.

### AC-4 — The visible path is truthful

- The manifest, library, reveal action, and artifact detail show the actual named local path returned by native storage.
- Legacy UUID-based receipts and files remain readable and recoverable.

### AC-5 — Filesystem and lifecycle invariants remain intact

- Downloads still use `.part`, size and SHA-256 verification, atomic rename, path confinement, and durable receipts.
- No automatic GPU start or stop is introduced, and no second batch is queued.

## Binding non-goals

- Do not rename worker-side or network-volume artifact directories.
- Do not change the single-active-batch lease model.
- Do not add automatic Pod termination.
- Do not opportunistically redesign the library or prompt workflow.

## Relevant files

- `src/App.tsx`
- `src/adapters/workerBatchCoordinator.ts`
- `src/adapters/workerBatchCoordinator.test.ts`
- `src/adapters/productionImageForgeAdapter.ts`
- `src/adapters/productionPort.ts`
- `src/adapters/runtimeProjection.ts`
- `src/domain/types.ts`
- `src-tauri/src/download.rs`
- `src-tauri/src/destination.rs`
- `src-tauri/src/lib.rs`
- Native and desktop regression tests adjacent to those files

## Automated verification

- Coordinator regression: a refreshed terminal manifest exposes additional ready images and reconciliation downloads them before committing terminal state.
- Coordinator regression: terminal recovery is idempotent and retryable failures do not become complete.
- Native tests: name sanitization, reserved names, collision suffixing, path confinement, durable mapping, and legacy UUID receipt compatibility.
- Run the desktop Vitest suite, root typecheck, Rust tests, production build, and `git diff --check`.

## Manual verification

- Recover the observed 24-image batch from 21 local files to 24 without creating a new batch.
- Confirm the actual local directory and displayed artifact paths use the prompt-list batch name.
- Reveal the directory from the packaged app and confirm all files open in order.
- Relaunch the app and confirm receipts, progress, and folder identity remain stable.

## Evidence required

- Test output for the new coordinator and native regressions.
- Final local file count, absence of `.part` files, and receipt count for the recovered batch.
- Packaged macOS interactive screenshots or observable-state notes covering completion, named path, reveal, and relaunch.
