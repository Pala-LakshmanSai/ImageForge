# Runtime contract

- Model: `black-forest-labs/FLUX.2-klein-4B`, pinned revision.
- Precision: BF16; no NVFP4 in the portable release.
- Default: 1280x720, four steps, guidance 1.0, JPEG quality 95.
- Approved GPU types: RTX 4090 and RTX 5090; exactly one GPU per Pod.
- Default candidate: RTX 4090 until measured 5090 throughput exceeds its live
  price ratio at identical output settings.
- Normal boot performs no package install or model download.
- Readiness phases: process, storage, weights, GPU load, warm-up, ready.
- Model/output volume survives Pod replacement; Pod ID and proxy URL may change.
- Start and terminate require explicit user actions.
