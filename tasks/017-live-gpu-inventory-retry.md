# Task 017 — Restore live GPU inventory retry

## Problem

After a successful Pod run is stopped outside ImageForge, Start GPU can time out once and then fail immediately with `Native GPU inventory returned an invalid snapshot.` Native inventory joins a retained current-Pod projection into live catalog offers without recomputing the matching offer's `same_as_current` disabled relation, so the strict renderer rejects the snapshot before any Pod is created.

## Acceptance criteria

- AC-1: Joining a current Pod into a live inventory snapshot produces a renderer-valid relation; a matching live offer is non-selectable with `same_as_current`.
- AC-2: Clearing the current Pod restores the matching live offer's catalog-derived selectable/disabled state.
- AC-3: A null current Pod always projects with null `currentPodObservedAt` and `currentPodStale: false`, including stale/error transitions and retry after timeout.
- AC-4: Live valid RTX 4090 rows remain selectable when malformed unrelated catalog siblings are present and no current Pod exists.
- AC-5: Existing process epoch, receipt, price, CUDA 13.0, EU-RO-1 Secure Cloud, identity, and mutation authority validation remains unchanged.
- AC-6: Regression verification performs no RunPod create/delete mutation.

## Non-goals

- NG-1: Changing GPU ranking, approved GPU policy, price limits, region, cloud type, or CUDA requirement.
- NG-2: Changing worker image, model, network-volume data, or cold-boot implementation.
- NG-3: Retrying provider mutations or automatically starting/stopping Pods.
- NG-4: Refactoring unrelated lifecycle, Studio, or inventory code.

## Relevant files

- `src-tauri/src/native/gpu_inventory.rs`: native current-Pod/live-offer relation owner.
- `src-tauri/src/native/gpu_pod.rs`: validated current-Pod projection producer and regression coverage.
- `packages/runpod-client/src/gpu-selector.ts`: strict renderer relation contract; validation must not be weakened.
- `packages/runpod-client/test/gpu-selector.test.ts`: cross-language strict snapshot tests.

## Automated tests

- AC-1: Join a verified RTX 4090 current Pod into a ready RTX 4090 inventory and assert `same_as_current`, non-selectable output.
- AC-2: Clear that Pod and assert the available, priced offer becomes selectable again.
- AC-3: Apply stale/error metadata with no Pod and assert the strict null relation is canonical.
- AC-4: Parse a catalog containing malformed sibling rows plus one complete approved RTX 4090 row and assert the approved row survives.
- AC-5: Run focused native inventory/Pod tests and runpod-client selector tests unchanged.
- AC-6: Tests use deterministic local fixtures only and assert no provider mutation path is invoked.

## Manual verification

1. Launch the packaged app with the production profile while RunPod has no active Pod.
2. Click Start GPU, wait for live inventory, and confirm the selector shows a selectable approved RTX 4090 instead of an invalid-snapshot error.
3. Cancel before create for non-paid smoke verification.
4. With explicit action-time approval, perform one paid Start and stop immediately after timing evidence is captured.

## Evidence required

- Failing-before/passing-after regression test for current-Pod/live-offer join.
- Focused Rust and runpod-client test commands with pass counts.
- Production build/package/install smoke result and signing disclosure.
- Independent ImageForge review with no unresolved must-fix findings.
- Paid verification records exact Pod start/ready/stop timestamps and final `$0.00/hr` state.

## Verification record — 2026-09-13

- Fail-before native regression: matching RTX 4090 live offer remained selectable with `disabledReason: null`; assertion expected `same_as_current`.
- Pass-after focused suites: native inventory 19/19, native Pod 19/19, renderer coordinator 13/13, runpod-client 133/133.
- Full non-paid gates: native Rust 270 passed/2 ignored, frontend 424 passed, TypeScript checks and production web build passed.
- Tests used deterministic local fixtures and performed zero RunPod create/delete mutations.
- Fresh independent review after test repair: no must-fix or should-fix findings; safe to integrate.
