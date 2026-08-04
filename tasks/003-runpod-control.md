# Task 003 — Explicit RunPod lifecycle and dynamic GPU selection

Task 014 narrowly supersedes the catalog/ranking and exact-target Start surface
with native receipt-bound live inventory, lossless micro-USD prices, benchmark-
v2 evidence, and an explicit coordinated replacement saga. Task 003's one Pod,
one GPU, fixed profile/volume, explicit Start/Stop, no timer, and no silent
unapproved fallback rules remain binding.

## Acceptance criteria

- List existing ImageForge Pods on every refresh.
- Rank the approved 16-32 GB NVIDIA pool using measured cost/image with a 4090
  safe default, then use RunPod's ordered creation fallback to resolve live
  availability atomically.
- Start exactly one Pod from configured template/volume after an explicit click.
- Discover the new proxy endpoint automatically and surface every phase.
- Terminate only after an explicit Stop click and confirmation.
- Fake adapter tests cover unavailable candidates, create races, API errors,
  changed Pod IDs, catalog failure, emergency-tier opt-in, and termination
  failures.

## Non-goals

- Timed shutdown, background shutdown, spot bidding, or multi-GPU Pods.
