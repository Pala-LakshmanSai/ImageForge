# Task 002 — Durable single-GPU worker

## Acceptance criteria

- Implement the documented worker API, authentication, health phases, atomic
  batch lock, manifests, retries, pause/resume/cancel, receipts, and artifacts.
- Provide deterministic fake inference for full local tests.
- Include a production FLUX adapter and pinned container/runtime definitions.
- Pass concurrency, restart/resume, ordering, and 450-prompt endurance tests.

## Non-goals

- RunPod lifecycle management or multiple simultaneous workers.
