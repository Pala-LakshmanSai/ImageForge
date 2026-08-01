# Runtime contract

- Model: `black-forest-labs/FLUX.2-klein-4B`, pinned revision.
- Precision: BF16; no NVFP4 in the portable release.
- Default: 1280x720, four steps, guidance 1.0, JPEG quality 95.
- Ordinary approved GPU types: RTX 4090, RTX 5090, RTX 5080, RTX 4080 SUPER,
  RTX 4080, RTX 3090 Ti, RTX 3090, L4, RTX A5000, and RTX A4500; exactly one GPU
  per Pod. A40, A6000, L40, and L40S require explicit emergency-tier opt-in.
- Default candidate: RTX 4090. Replace cold-start ordering only with comparable
  whole-batch cost measurements at the pinned ImageForge settings.
- Normal boot performs no package install or model download.
- Readiness phases: process, storage, weights, GPU load, warm-up, ready.
- Model/output volume survives Pod replacement; Pod ID and proxy URL may change.
- Start and terminate require explicit user actions.
