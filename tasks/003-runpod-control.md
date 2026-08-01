# Task 003 — Explicit RunPod lifecycle and dynamic GPU selection

## Acceptance criteria

- List live approved inventory and existing ImageForge Pods on every refresh.
- Rank available 4090/5090 offers using measured cost/image, with safe fallback.
- Start exactly one Pod from configured template/volume after an explicit click.
- Discover the new proxy endpoint automatically and surface every phase.
- Terminate only after an explicit Stop click and confirmation.
- Fake adapter tests cover unavailable inventory, create races, API errors,
  changed Pod IDs, and termination failures.

## Non-goals

- Timed shutdown, background shutdown, spot bidding, or multi-GPU Pods.
