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
3. Query RunPod's bearer-authenticated v2 catalog for one-GPU Secure Cloud Pod
   availability and current price. Filter results to the network volume's data
   center when that granularity is present. Catalog data is advisory because it
   can change immediately.
4. Rank approved candidates using the batch-aware cost estimate below. With no
   comparable measurements, use the documented cold-start priority.
5. Create a Pod with the fixed template, volume, secrets, one GPU, port
   `8000/http`, ordered `gpuTypeIds`, and `gpuTypePriority: custom`. RunPod tries
   the order against current capacity, so selection is not based on a stale
   inventory response.
6. Record the response's actual GPU and hourly rate for estimates/benchmarks.
7. Capture the returned Pod ID and derive/discover its HTTPS proxy endpoint.
8. Poll Pod state and worker health through every boot phase until ready or a
   bounded provisioning timeout produces an actionable error.

Approved IDs:

- `NVIDIA GeForce RTX 4090`
- `NVIDIA GeForce RTX 5090`
- `NVIDIA GeForce RTX 5080`
- `NVIDIA GeForce RTX 4080 SUPER`
- `NVIDIA GeForce RTX 4080`
- `NVIDIA GeForce RTX 3090 Ti`
- `NVIDIA GeForce RTX 3090`
- `NVIDIA L4`
- `NVIDIA RTX A5000`
- `NVIDIA RTX A4500`

Cold-start priority is the order above until identical ImageForge benchmarks
exist. After that, rank by estimated whole-batch cost, not hourly price alone.
The 16 GB candidates remain eligible because the pinned 4B BF16 checkpoint is
documented at roughly 13 GB, but each must pass the real 1280x720 smoke gate.

Emergency opt-in IDs are `NVIDIA A40`, `NVIDIA RTX A6000`, `NVIDIA L40`, and
`NVIDIA L40S`. They are compatible but may be poor value. Never include them in
an ordinary create request unless the user explicitly enables the emergency
tier after seeing the current hourly estimate.

## Selection formula

For an offer with price `p`, benchmarked boot duration `b`, benchmarked average
generation duration `s`, and prompt count `n`:

```text
estimated_job_cost = p * (b + s * n) / 3600
```

Use measurements only when model revision, precision, resolution, steps, and
software image match. Availability across the ordinary approved pool beats
waiting for a preferred unavailable GPU unless the user explicitly cancels the
fallback. A catalog error must not prevent the authoritative ordered creation
attempt; surface a warning and use the safe cold-start order.

## Choosing the network-volume data center

A network volume constrains the Pod to its data center. Before the volume is
created, compare the number and stock status of approved GPUs in candidate data
centers. For users in India, prefer `AP-IN-2` when it has at least three useful
approved families; otherwise favor a center with deeper stock and fast volume
storage over geographic proximity. Store the chosen data-center ID in the
connection profile and make the limitation visible in Advanced Settings.

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
