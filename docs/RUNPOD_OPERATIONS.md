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
that attachment. **Stop GPU** is a coordinated, fail-closed foreground action:

1. Refresh the exact selected Pod and reject a missing, replaced, or
   profile-mismatched termination target.
2. Ask the authenticated worker for a stop request bound to that exact Pod and
   requester session.
3. If a running, paused, or resumable interrupted batch owns the shared lease,
   veto Stop unconditionally. The operator must first let it finish or use the
   explicit batch cancel/interruption flow.
4. If the worker is idle, require one approval from every other live foreground
   principal. Exclude the requester's own windows and count another principal
   once even when they have several windows. A peer may approve or deny from
   any of their foreground sessions.
5. A denial, response deadline, worker restart, network uncertainty, malformed
   response, or lost requester session leaves the GPU running. Only an expired
   presence heartbeat removes an absent peer from consideration.
6. Once approval is unanimous, atomically acquire the worker's bounded
   finalization guard. While held, Create/Resume/Retry returns the typed
   `gpu_stop_pending` response instead of racing the delete.
7. Revalidate the exact Pod again, then publish `stopping` and send RunPod's Pod
   DELETE. A failure or timeout cancels/releases the exact guard idempotently
   and does not project a false `offline` state.

The confirmation explains that compute and ephemeral container data are
terminated while the ImageForge network volume remains. The peer UI names the
requester, shows the bounded response deadline, and offers explicit **Keep GPU
running** and **Approve stop** actions. Generating before finalization cancels a
still-pending approval request; once finalization holds the lease, generation
fails with `gpu_stop_pending` until Stop succeeds, fails, or expires safely.

No job completion, idle state, application exit, timer, background process, or
connectivity failure may invoke termination.

## Concurrent control

Pod names are not unique. Before creating, each client lists matching Pods. A
simultaneous race can still create duplicates, so clients must surface every
matching Pod and warn about duplicate hourly spend. Do not automatically delete
the newer/older Pod.

All open clients observe RunPod and authenticated worker studio status on a
bounded coalesced interval. Status polling is read-only. The Pod snapshot is
authoritative for compute state and the shared-volume active lease is
authoritative for batch ownership; local receipts and window presence never
become a generation lock. When RunPod reports `offline`, clients clear stale
worker state and ignore late heartbeats from the previous observation epoch.

The worker returns typed busy metadata (owner and progress) for any second
Create/Resume/Retry attempt. There is no second-batch queue. Studio presence is
ephemeral, authenticated, TTL-bounded, and restricted to safe client identity;
it is used only for idle-peer Stop consent.

The shared worker batch lease is expected to prevent two
Pods from generating simultaneously, but RunPod cross-Pod filesystem behavior
is deployment-specific; it is not trusted until the opt-in two-Pod EU-RO-1
volume gate in `worker/scripts/run_volume_gate.py` passes with isolated paths.
