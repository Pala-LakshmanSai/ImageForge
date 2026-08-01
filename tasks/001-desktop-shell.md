# Task 001 — Desktop shell and simulated product flow

## Acceptance criteria

- Implement Create, Progress, Library, Usage, and Settings navigation.
- Implement every Pod and batch state using deterministic fake adapters.
- Match `docs/DESIGN_SYSTEM.md` at 1440x900 and remain usable at 1280x720.
- Parse pasted/TXT prompts, show validation, select a destination, and simulate
  ordered progress/downloads without a backend.
- All controls used in the simulated flow work and tests cover core reducers.

## Non-goals

- Real RunPod calls, native credential storage, or GPU inference.
