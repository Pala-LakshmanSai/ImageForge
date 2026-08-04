# GPU and quality benchmark plan

## Fixed comparison

- Pinned ImageForge container and model revision
- BF16
- 1280x720
- Four steps
- Guidance 1.0
- JPEG quality 95
- Same 30 prompts and deterministic seeds
- Exact checked-in prompt/seed fixture version and SHA-256
- Exact reference mode and immutable worker-image registry digest

## Measurements

- Pod allocation duration
- Container/API-visible duration
- Storage validation and model-load duration
- Warm-up duration
- First-image latency
- Median and p95 seconds/image after warm-up
- Peak allocated/reserved VRAM
- JPEG encode and transfer duration
- Failure/retry count
- Current hourly price and calculated job/image cost
- Raw sample ordinal, seed, duration in integer microseconds, success/failure,
  fixture binding, and canonical evidence SHA-256

## Quality review

Create blinded contact sheets grouped by people, hands, interiors, landscapes,
historical scenes, vehicles, crowds, and low light. Score prompt fidelity,
photorealism, anatomy, texture, lighting, stock-footage usability, and severe
artifact rate. Never select a faster variant with a material quality regression.

## Decision

Task 014 benchmark v2 is strict checked-in evidence, not editable marketing
metadata. Each GPU has at least 30 successful fixed samples. Raw JSON is
validated, re-encoded as RFC 8785/JCS plus one LF, SHA-256 re-computed, and tied
to its profile median/p95, boot duration, fixture/reference/model/image fields.
Profile selection rejects malformed, future, incompatible, mismatched-hash or
under-sampled evidence. Valid evidence expires for Auto score/cost at exactly
90 days; the row remains manually selectable and says **Benchmark expired**.
Only absent/invalid/incompatible evidence says **Unmeasured**.

All prices are integer micro-USD. Auto comparison, speed-score numerator and
batch-cost numerator use the shared checked-unsigned-wide contract
(`BigInt`/checked `u128`/bounded Python integer) and checked-in max/overflow/
half-up vectors. No binary float enters ranking or persistence. Overflow makes
the affected score/cost `—` and cannot authorize a preferred ranking.

Update profiles only when every fixed field and re-computed raw hash matches.
For 300-450 images select the lowest exact estimated whole-batch cost among
fresh measured ordinary offers only when quorum exists; otherwise use the
reviewed cold order intersected with a fresh live inventory receipt. Preserve
raw benchmark JSON, profile, hashes and blinded contact sheets as release
evidence. Real GPU collection remains a separately authorized paid gate.
