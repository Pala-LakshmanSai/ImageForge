# Task 020 — Trace and accurately report GPU Start refusals

## Problem
The installed app reports a failed Start after a live inventory recheck. The
native transport currently labels every definitive HTTP 400/422 rejection as
capacity exhaustion, hiding request errors behind misleading guidance.

## Acceptance criteria
- AC-1: Only a provider capacity message is reported as no capacity. Other
  definitive request rejections report that RunPod rejected the create request.
- AC-2: Opt-in diagnostics identify create send/response status and fixed refusal
  classification without logging response bodies, credentials, or private fields.
- AC-3: Definite refusals still require an empty managed-Pod observation before
  clearing the marker; uncertain results cannot authorize another POST.
- AC-4: Reproduce the installed Start flow through computer use and record the
  live request outcome, matching source constraints and final Pod state.

## Non-goals
- NG-1: No removal of fresh inventory/price checks, automatic retry/fallback,
  added GPUs, region/volume changes, worker changes, or automatic termination.
- NG-2: No unrelated application or worker changes.

## Authorized release scope
The user subsequently requested commit, production push, macOS DMG and Windows
EXE builds, and a new GitHub release. Publish v0.2.9 using the existing native CI
workflow and its artifact checks. Reuse completed local tests; do not repeat
broad local testing.

## Relevant files
- `src-tauri/src/native/runpod.rs`: create response classification and diagnostics.
- `src-tauri/src/native/error.rs`: existing opt-in diagnostic channel.

## Automated tests
- Capacity versus 400/422 request rejection and ambiguous 5xx classification.
- Existing marker/journal recovery tests and full Rust suite (completed).

## Manual verification
1. Start an available approved GPU from the installed UI; inspect opt-in native
   status/classification and compare the displayed result.
2. Verify provider Pod state after the attempt; do not replay an uncertain POST.

## Evidence required
- Timestamped UI observations, fixed request constraints, diagnostic status,
  test commands/results, and final active-Pod observation.
