# Runtime contract

- Model: `Comfy-Org/Mage-Flow`, pinned revision.
- Precision: BF16; no NVFP4 in the portable release.
- Default: 1280x720, four steps, guidance 1.0, JPEG quality 95.
- Ordinary approved GPU types: RTX 4090, RTX 5090, RTX 5080, RTX 4080 SUPER,
  RTX 4080, RTX 3090 Ti, RTX 3090, L4, RTX A5000, RTX A4500, and RTX 4000 Ada;
  exactly one GPU per Pod. RTX PRO 4500 Blackwell and RTX PRO 4000 Blackwell are
  also approved using the exact IDs returned by RunPod's live catalog. A40,
  A6000, L40, L40S, and the slow RTX 2000 Ada require explicit emergency opt-in.
- Current data center: `EU-RO-1`. Its unbenchmarked cold order is RTX 4090, RTX
  PRO 4500 Blackwell, RTX 5090, RTX PRO 4000 Blackwell, L4, RTX A4500, and RTX
  4000 Ada; RTX 2000 Ada is emergency-slow. Replace this order only with
  comparable whole-batch cost measurements at the pinned ImageForge settings.
- Normal boot performs no package install or model download.
- Readiness phases: process, storage, weights, GPU load, warm-up, ready.
- Model/output volume survives Pod replacement; Pod ID and proxy URL may change.
- Start and terminate require explicit user actions.
