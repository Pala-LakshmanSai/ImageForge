# Task 018 — Make Start GPU use fresh lifecycle state without freezing

## Problem

Opening the live GPU selector calls the macOS Keychain synchronously from the
Tauri command on the AppKit main thread. A slow or wedged Keychain read freezes
the ImageForge window before the inventory loading state can render. Once the
read returns, the selector can also join the catalog against a stale terminated
Pod projection and incorrectly disable RTX 4090 as `Pinned current Pod` while
the app is Offline.

## Acceptance criteria

- AC-1: `gpu_inventory_begin_refresh` performs the credential preflight away
  from the UI thread and remains an asynchronous Tauri command.
- AC-2: A delayed credential read does not block the calling async executor;
  successful and typed-error behavior remains unchanged.
- AC-3: Inventory still validates the credential before reserving an
  observation or starting either RunPod catalog GET.
- AC-4: Opening or refreshing the selector first performs one authoritative
  managed-Pod observation, so a terminated Pod is cleared before live offers
  are joined and selectable.
- AC-5: Existing inventory, Start authority, GPU policy, and zero/one-Pod
  safety tests remain green.
- AC-6: Live verification opens the installed selector without freezing, then
  one explicitly requested paid cold start reaches Ready and is stopped with
  RunPod returning zero active compute.

## Non-goals

- NG-1: Changing GPU ranking, prices, region, cloud, CUDA, or image policy.
- NG-2: Changing Keychain contents or credential UX.
- NG-3: Retrying or automating any RunPod mutation.
- NG-4: Refactoring unrelated lifecycle, worker, or renderer code.

## Relevant files

- `src-tauri/src/lib.rs`: asynchronous Tauri inventory command boundary.
- `src-tauri/src/native/gpu_inventory.rs`: preflight ordering owner.
- `src-tauri/src/native/runpod.rs`: credential-vault blocking boundary.
- `src/adapters/gpuLifecycleCoordinator.ts`: Pod-before-catalog ordering.

## Automated tests

- Rust regression proves credential preflight runs on a blocking worker thread.
- Coordinator regression proves Pod observation precedes inventory refresh.
- Focused native inventory and RunPod tests pass.
- Full Rust, frontend, RunPod-client, typecheck, lint, and build gates pass.

## Manual verification

1. Launch the packaged app while RunPod has no active Pod.
2. Click `Start GPU`; verify the selector opens and the window remains usable.
3. Confirm a selectable approved RTX 4090 appears.
4. Start one RTX 4090, record Start-to-Ready phases and elapsed time.
5. Stop it immediately and verify ImageForge is Offline and RunPod has zero
   active compute / `$0.00/hr`.

## Evidence required

- Failing process sample showing AppKit main thread in Keychain read.
- Passing regression and full check counts.
- Installed-artifact selector and cold-start observations.
- Independent review with no unresolved must-fix findings.
- Release commit, CI run, artifact hashes, signing status, and GitHub release.
