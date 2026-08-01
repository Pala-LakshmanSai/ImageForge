# GPU and quality benchmark plan

## Fixed comparison

- Pinned ImageForge container and model revision
- BF16
- 1280x720
- Four steps
- Guidance 1.0
- JPEG quality 95
- Same 30 prompts and deterministic seeds

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

## Quality review

Create blinded contact sheets grouped by people, hands, interiors, landscapes,
historical scenes, vehicles, crowds, and low light. Score prompt fidelity,
photorealism, anatomy, texture, lighting, stock-footage usability, and severe
artifact rate. Never select a faster variant with a material quality regression.

## Decision

Update stored benchmark profiles only when all fixed comparison values match.
For the anticipated 300-450 image batch, select the lowest estimated total cost
among available approved offers. Preserve the raw benchmark JSON and contact
sheets as review evidence.
