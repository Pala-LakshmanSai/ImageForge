# RunPod operations contract

## Why a new GPU can be used every session

An ImageForge session does not depend on a physical machine or a stable Pod ID.
The custom template defines software, the network volume defines persistent
weights/jobs, and runtime secrets define authentication. Pressing Start creates
a new disposable compute attachment around those durable pieces.

## Start GPU

1. Require an explicit click from the foreground application.
2. List existing ImageForge Pods. Connect to a healthy existing Pod rather than
   creating another one.
3. Rank approved candidates using the batch-aware cost estimate below. With no
   comparable measurements, use 4090 then 5090.
4. Create a Pod with the fixed template, volume, secrets, one GPU, port
   `8000/http`, ordered `gpuTypeIds`, and `gpuTypePriority: custom`. RunPod tries
   the order against current capacity, so selection is not based on a stale
   inventory response.
5. Record the response's actual GPU and hourly rate for estimates/benchmarks.
6. Capture the returned Pod ID and derive/discover its HTTPS proxy endpoint.
7. Poll Pod state and worker health through every boot phase until ready or a
   bounded provisioning timeout produces an actionable error.

Approved IDs:

- `NVIDIA GeForce RTX 4090`
- `NVIDIA GeForce RTX 5090`

## Selection formula

For an offer with price `p`, benchmarked boot duration `b`, benchmarked average
generation duration `s`, and prompt count `n`:

```text
estimated_job_cost = p * (b + s * n) / 3600
```

Use measurements only when model revision, precision, resolution, steps, and
software image match. Without comparable measurements, rank 4090 before 5090.
Availability always beats waiting for a preferred unavailable GPU unless the
user explicitly cancels the fallback.

## Stop GPU

ImageForge uses a network volume, so RunPod cannot pause the Pod while retaining
that attachment. The **Stop GPU** action sends RunPod's Pod DELETE operation
after a foreground confirmation. The dialog must say that compute and ephemeral
container data will be terminated while the ImageForge network volume remains.

No job completion, idle state, application exit, timer, background process, or
connectivity failure may invoke termination.

## Concurrent control

Pod names are not unique. Before creating, each client lists matching Pods. A
simultaneous race can still create duplicates, so clients must surface every
matching Pod and warn about duplicate hourly spend. Do not automatically delete
the newer/older Pod. The shared worker batch lease prevents two Pods from
generating simultaneously when they share a volume, but it does not make extra
compute free.
