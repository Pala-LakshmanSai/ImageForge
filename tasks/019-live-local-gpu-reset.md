# Task 019 — Keep Start usable after local GPU-record reset

## Problem

The supported **Reset local GPU records** action renames the complete
`gpu-switch` directory while the running `GpuSwitchService` and profile lock
still refer to that path. The reset then leaves only a newly created
`profile-control.lock`; Start reaches the switch preflight and fails with
`gpu_switch_store_unrecoverable` before any RunPod mutation.

## Acceptance criteria

- AC-1: Reset archives GPU start, pending-create, and switch journal evidence
  while preserving the live `profile-control.lock` path and exclusion lease.
- AC-2: The running switch and ordinary-Start services become clean
  revision-zero stores after reset, with required journal directories present
  and no stale grants, quotes, lease, record, issue, or pending Start.
- AC-3: A foreground Start preflight can load and authorize immediately after
  reset without relaunching ImageForge.
- AC-4: Reset and Start remain serialized by the process control gate and the
  cross-process profile lock.
- AC-5: Reset performs no RunPod create/delete request and does not alter queue,
  receipts, downloads, destination, or credentials.

## Non-goals

- NG-1: Changing GPU ranking, pricing, region, cloud, image, model, or volume.
- NG-2: Starting, stopping, deleting, or retrying a RunPod Pod automatically.
- NG-3: Changing normal switch recovery rules for corrupt or incomplete
  journals outside the explicit reset action.
- NG-4: Refactoring unrelated lifecycle, queue, worker, or renderer behavior.

## Relevant files

- `src-tauri/src/native/local_state.rs`: archive layout and lock preservation.
- `src-tauri/src/native/gpu_switch.rs`: live service reset and journal rebuild.
- `src-tauri/src/native/gpu_inventory.rs`: ordinary-Start journal rebuild and
  process-local Start state reset.
- `src-tauri/src/lib.rs`: reset serialization and service coordination.
- `src/screens/SettingsScreen.tsx`: existing explicit reset entry.

## Automated tests

- AC-1/AC-5: Native local-state test proves switch evidence is archived, lock
  stays at its original path, and operator-owned paths remain untouched.
- AC-2/AC-3: Native switch test proves a service reset after archive has clean
  state, rebuilt directories, and can mint a new foreground grant.
- AC-4: Command code review plus focused native tests prove both locks wrap the
  archive and in-memory reset sequence.
- Full Rust, frontend, TypeScript, lint, and production build gates pass before
  release.

## Manual verification

1. In packaged ImageForge while Offline, reset local GPU records.
2. Without relaunching, open Start GPU, select an approved live RTX 4090, and
   confirm Start.
3. Verify no `gpu_switch_store_unrecoverable` error occurs.
4. With explicit paid authorization, observe one Pod through Ready, record
   phase timings, then stop it immediately and verify zero active compute.

## Evidence required

- Before-fix filesystem proof: active switch root contains only
  `profile-control.lock`, while archived root contains journal directories.
- Failing-before and passing-after regression evidence.
- Independent review with no unresolved must-fix finding.
- Release commit, CI run, artifact hashes, signing status, and installed-app
  smoke evidence.
