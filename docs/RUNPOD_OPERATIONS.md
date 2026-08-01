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
- `NVIDIA L4`
- `NVIDIA RTX A4500`
- `NVIDIA RTX 4000 Ada Generation`
- RTX PRO 4500 Blackwell (use the exact catalog ID)
- RTX PRO 4000 Blackwell (use the exact catalog ID)
- `NVIDIA RTX 2000 Ada Generation` (slow emergency opt-in only)

The current studio profile targets `EU-RO-1`. Its observed cold-start priority
is RTX 4090, RTX PRO 4500 Blackwell, RTX 5090, RTX PRO 4000 Blackwell, L4, RTX
A4500, and RTX 4000 Ada. RTX 2000 Ada is an explicitly labeled slow/emergency
fallback. Intersect this profile with the exact IDs and availability returned by
the live catalog; do not manufacture a new GPU ID from its display label.

After comparable benchmarks exist, rank by estimated whole-batch cost, not
hourly price alone.
The 16 GB candidates remain eligible because the pinned 4B BF16 checkpoint is
documented at roughly 13 GB, but each must pass the real 1280x720 smoke gate.

RTX 2000 Ada is the only emergency opt-in because its throughput may be
impractical for 300-450 images. Never include it in an ordinary create request.
B200, RTX PRO 6000 variants, A40/A6000, L40/L40S, and every GPU not listed above
remain excluded even if the catalog reports stock.

The worker image and catalog/create constraints require CUDA 13.0 or newer so
the same immutable image covers both Ada/Ampere fallbacks and RTX 50/RTX PRO
Blackwell. A host that cannot satisfy that runtime is unavailable, not a reason
to install or change software during Pod boot.

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

A network volume constrains the Pod to its data center. The studio selected
`EU-RO-1` because it currently exposes a deeper compatible fallback pool than
the closer candidates and supports S3-compatible volume access. Store that ID
in the connection profile and make the limitation visible in Advanced Settings.
The live catalog remains authoritative because stock changes.

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
