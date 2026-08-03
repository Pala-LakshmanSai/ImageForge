# Task 011 — Keep generation, downloads, and shared GPU state live

## Problem

The production desktop polls the worker while a batch runs, but the batch
coordinator reconciles every newly ready artifact before emitting any updated
manifest state. When several images become ready between polls, the progress
screen can remain at zero saved images and an old generating frame, then jump
directly to every image saved. The files are protected by the native checksum
and receipt path, but the user cannot see that useful work is happening.

The desktop also refreshes RunPod lifecycle state only at startup or after a
manual refresh. If one editor explicitly stops the shared Pod, another open
client can remain visually Ready, keep the Create checklist green, and allow a
Generate click against a terminated worker. The late worker transport failure
then looks like an API incompatibility instead of converging the client to the
authoritative offline RunPod state.

## Acceptance criteria

- AC-1: As soon as a polled worker manifest exposes a ready artifact, the owned
  batch UI shows that frame as ready/downloading without waiting for all ready
  artifacts in the same reconciliation pass.
- AC-2: After each artifact is durably written, checksum-verified, and represented
  by a valid local receipt, subscribers receive an intermediate manifest event
  whose receipt list includes that frame. The progress saved count, queue row,
  live preview, and Library can therefore advance one image at a time.
- AC-3: A worker manifest in a terminal state is not projected as Complete or
  Partial failure while any successful ready/downloaded artifact still lacks a
  matching verified local receipt. The UI remains in a truthful saving state
  and does not expose terminal New brief behavior prematurely.
- AC-4: Final terminal reconciliation remains bounded and reaches the existing
  fixed point. Stale connection epochs, overlapping polls, retryable receipt
  acknowledgement gaps, checksum conflicts, and reconnect recovery do not emit
  misleading progress or trigger duplicate final writes.
- AC-5: The same React/coordinator behavior ships on macOS Apple silicon and
  Windows x64. A 24-image fake batch visibly records ordered saved counts from
  1 through 24, and a 450-image fake run remains responsive.
- AC-6: While setup is complete, each open production client performs bounded,
  coalesced, read-only RunPod observation and converges to Offline after another
  client explicitly terminates the selected Pod. Background observation never
  creates, starts, stops, or terminates compute and never causes offline/selecting
  UI flicker.
- AC-7: Generate is disabled when the latest authoritative lifecycle state is
  not Ready. A production Generate click performs a coalesced RunPod readiness
  preflight before creating a local batch or calling the worker; if the Pod was
  stopped remotely, the client remains on Create, projects Offline, performs no
  `POST /v1/batches`, and shows a direct GPU-offline message rather than a worker
  schema/API incompatibility error.
- AC-8: If a routine worker poll fails because a remote Stop removed the Pod,
  ImageForge refreshes RunPod state immediately. When RunPod confirms the Pod is
  gone, the authoritative Offline state supersedes the secondary worker error;
  if RunPod still reports the Pod, the original retryable worker failure remains
  visible and Stop safety is preserved.
- AC-9: An explicit Stop click from a stale client first reconciles the exact
  confirmed Pod. If another client already removed it, or it disappears during
  that Stop attempt, ImageForge clears the stale selection/session and reports
  Offline without issuing a second DELETE or presenting a lifecycle error. Only
  an authoritative absence of that exact target is treated as already stopped;
  authentication, timeout, and provider failures remain visible.

## Non-goals

- NG-1: Do not add WebSockets, server-sent events, a new worker API schema, or a
  new generation model.
- NG-2: Do not parallelize native artifact writes or weaken `.part`, checksum,
  size, dimension, atomic-rename, receipt, or path-confinement guarantees.
- NG-3: Do not change one-active-batch locking, RunPod GPU selection, explicit
  Start/Stop controls, or add automatic GPU termination.
- NG-4: Do not redesign the visual system or unrelated Create, Library, Setup,
  or Settings workflows.
- NG-5: Do not infer that a Pod was terminated solely from a proxy/health error,
  and do not weaken worker schema validation to hide stale or non-ImageForge
  responses.

## Relevant files

- `src/adapters/workerBatchCoordinator.ts`: publish initial and per-receipt
  reconciliation state without breaking fixed-point or epoch guards.
- `src/adapters/workerBatchCoordinator.test.ts`: deferred multi-artifact event
  ordering, terminal-gap, stale-epoch, and duplicate-download regressions.
- `src/adapters/runtimeProjection.ts`: keep terminal worker state nonterminal
  until every successful artifact has a matching local receipt.
- `src/adapters/runtimeProjection.test.ts`: projection and visible saved-count
  assertions for partial local reconciliation.
- `src/App.test.tsx`: user-observable production runtime event progression.
- `src/App.tsx`: bounded background observation and pre-submit flow.
- `src/adapters/productionImageForgeAdapter.ts`: coalesced lifecycle preflight
  and worker-failure reconciliation without duplicate errors.
- `src/adapters/productionImageForgeAdapter.test.ts`: remote Stop, preflight,
  coalescing, and no-worker-submit regressions.
- `src/adapters/gpuLifecycleCoordinator.ts`: quiet read-only observation that
  preserves explicit-only lifecycle mutations.
- `packages/runpod-client/src/lifecycle.ts`: suppress transient selecting state
  for background observation while still publishing the final snapshot.
- `src/screens/ProgressScreen.tsx`: inspect only unless an existing status label
  cannot express ready/downloading/saved progression.
- `src/screens/CreateScreen.tsx`: expose preflight pending/offline truth without
  changing the established visual system.
- `src/native/nativeSmoke.ts`: assert intermediate saved counts before terminal
  completion so packaged CI catches this UX regression.

## Automated tests

- Coordinator test defers two artifact downloads and asserts subscription events
  expose ready state, then one receipt, then two receipts, before final terminal
  completion; each artifact is downloaded once and events stay index ordered.
- Coordinator tests retain bounded terminal acknowledgement, fixed-point,
  coalesced-poll, forgotten-epoch, checksum-conflict, and reconnect behavior.
- Projection test supplies a terminal worker manifest with missing local receipts
  and expects a saving/running phase, accurate per-frame statuses, and only
  locally verified assets; adding the final receipt permits Complete.
- App/UI test feeds consecutive production batch events and observes saved count,
  queue status, and live preview advance without waiting for terminal state.
- Production runtime/App tests model another client removing the selected Pod;
  the first client becomes Offline, disables Generate, and never calls
  `createBatch`. Concurrent background/manual/preflight observations coalesce.
- Worker-failure test confirms a RunPod refresh suppresses the misleading worker
  error only when RunPod authoritatively reports no active ImageForge Pod.
- Stop tests cover an already-absent confirmed target, disappearance after the
  preflight, and a genuine provider failure; only the first two converge safely
  to Offline without a second DELETE.
- Native smoke observes at least two increasing nonterminal saved counts before
  it accepts final New brief completion.
- Run the targeted Vitest files, full desktop Vitest suite, RunPod-client suite,
  typecheck, production build, Rust tests, and `git diff --check`.

## Manual verification

1. Run the deterministic production/fake-worker flow with delayed artifact
   downloads and confirm the progress screen first shows the ready/downloading
   frame, then increments saved images one by one.
2. Observe the selected queue row and live preview move to each newly saved frame
   while later prompts remain generating or waiting.
3. Confirm Complete and New brief appear only after the last successful JPEG is
   present in the named local folder and no `.part` files remain.
4. Exercise pause, resume/reconnect, cancel, and terminal download recovery and
   confirm saved frames remain visible without duplicate files.
5. With two clients, explicitly Stop GPU in one and confirm the other changes to
   Offline, clears its green GPU check, disables Generate, and does not create a
   batch; repeat with the clients reversed.
6. Launch packaged macOS and Windows artifacts and repeat the fake 24-image smoke
   with matching behavior at 1280x720, 1440x900, and 1920x1080 where available.

## Evidence required

- Ordered coordinator subscription events and targeted/full test output.
- Rendered progress-screen evidence showing intermediate saved counts.
- macOS and Windows native artifact metadata, hashes, install/launch smoke, and
  signing/notarization or unsigned disclosure.
