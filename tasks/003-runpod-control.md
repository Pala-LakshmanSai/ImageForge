# Task 003 — Explicit RunPod lifecycle and dynamic GPU selection

## Acceptance criteria

- List existing ImageForge Pods on every refresh.
- Rank 4090/5090 using measured cost/image with a 4090 safe default, then use
  RunPod's ordered creation fallback to resolve live availability atomically.
- Start exactly one Pod from configured template/volume after an explicit click.
- Discover the new proxy endpoint automatically and surface every phase.
- Terminate only after an explicit Stop click and confirmation.
- Fake adapter tests cover unavailable candidates, create races, API errors,
  changed Pod IDs, and termination failures.

## Non-goals

- Timed shutdown, background shutdown, spot bidding, or multi-GPU Pods.
