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
3. Ask native for one Task 014 inventory observation: the policy catalog and
   EU-RO-1 Secure availability GETs, one native monotonic receipt, and strict
   terminal projection. While the selector is foreground it refreshes on open
   and every 30 seconds; provider mutation rejects age `>= 60,000ms`.
4. Rank approved candidates using only matching, under-90-day benchmark-v2
   evidence and the exact wide-integer formula below. A valid expired profile
   remains manually selectable as **Benchmark expired** but has no score/cost.
   With no fresh measured ordinary quorum, Auto uses the reviewed fixed order
   intersected with that exact receipt-bearing live inventory.
5. Perform a second native two-GET/profile preflight. Manual Start creates one
   exact selected GPU; Auto creates the live-intersected order with
   `gpuTypePriority: custom`. A fallback/error/loading snapshot or checked-in
   order without a fresh receipt is explanatory only and cannot POST.
6. Create with the fixed template, immutable worker image digest, volume,
   secrets, one GPU, port `8000/http`, EU-RO-1 Secure and non-interruptible mode.
7. Parse the response's actual GPU and hourly rate into the same canonical
   integer micro-USD representation. A changed price requires explicit
   confirmation; an unavailable price blocks generation but never auto-deletes.
8. Capture the returned Pod ID and derive/discover its HTTPS proxy endpoint.
9. Poll Pod state and worker health through every boot phase until ready or a
   bounded provisioning timeout produces an actionable error.

Approved IDs:

- `NVIDIA GeForce RTX 4090`
- `NVIDIA GeForce RTX 5090`
- `NVIDIA L4`
- `NVIDIA RTX A4500`
- `NVIDIA RTX 4000 Ada Generation`
- `NVIDIA A100 80GB PCIe`
- `NVIDIA RTX PRO 6000 Blackwell Server Edition`
- `NVIDIA RTX PRO 6000 Blackwell Workstation Edition`
- RTX PRO 4500 Blackwell (use the exact catalog ID)
- RTX PRO 4000 Blackwell (use the exact catalog ID)
- `NVIDIA RTX 2000 Ada Generation` (slow emergency opt-in only)

The current studio profile targets `EU-RO-1`. Its observed cold-start priority
is RTX 4090, RTX PRO 4500 Blackwell, RTX 5090, RTX PRO 4000 Blackwell, L4, RTX
A4500, RTX 4000 Ada, A100 80GB PCIe, and the two RTX PRO 6000 Blackwell
editions. RTX 2000 Ada is an explicitly labeled slow/emergency fallback.
Intersect this profile with the exact IDs and availability returned by the live
catalog; do not manufacture a new GPU ID from its display label.

After comparable benchmarks exist, rank by estimated whole-batch cost, not
hourly price alone.
The 16 GB candidates remain eligible because the pinned 4B BF16 checkpoint is
documented at roughly 13 GB, but each must pass the real 1280x720 smoke gate.

RTX 2000 Ada is the only emergency opt-in because its throughput may be
impractical for 300-450 images. Never include it in an ordinary create request.
B200, A40/A6000, L40/L40S, and every GPU not listed above remain excluded even if
the catalog reports stock.

The worker image and catalog/create constraints require CUDA 13.0 or newer so
the same immutable image covers both Ada/Ampere fallbacks and RTX 50/RTX PRO
Blackwell. A host that cannot satisfy that runtime is unavailable, not a reason
to install or change software during Pod boot.

## Selection formula

For an offer with integer micro-USD/hour `p`, boot milliseconds `b`, median
microseconds/image `s`, and remaining image count `n`, compute with checked
unsigned-wide arithmetic only:

```text
runtime_us = b * 1000 + s * n
numerator = p * runtime_us
estimated_micro_usd = round_half_up(numerator / 3_600_000_000)
```

Auto value comparison uses the exact cross-product `p * s`; no division or
binary float is involved. TypeScript uses `BigInt`, Rust checked `u128`, and
Python an explicitly bounded integer with the shared U128 vectors. Overflow or
non-canonical output makes score/cost unavailable and never changes ranking in
favor of unsafe data. Measurements are eligible only when model revision,
precision, resolution, steps, immutable software image, prompt/seed fixture,
reference mode, sample count, raw JCS+LF hash and 90-day boundary match. A
catalog error cannot authorize Start; it leaves a read-only fallback and asks
the editor to Refresh GPUs.

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
   DELETE. A definite failure before the socket write cancels/releases the exact
   guard idempotently and sends zero DELETEs. Timeout, connection loss, 5xx/429,
   malformed response, or any ambiguity after the durable send boundary records
   `delete_uncertain`, keeps the guard until its bounded TTL, sends no automatic
   retry, and does not project a false `offline` state. Exact DELETE 404 counts
   as already stopped only after a fresh profile observation proves the same ID
   absent; another valid Pod remains visible rather than becoming global Offline.

The confirmation explains that compute and ephemeral container data are
terminated while the ImageForge network volume remains. The peer UI names the
requester, shows the bounded response deadline, and offers explicit **Keep GPU
running** and **Approve stop** actions. Generating before finalization cancels a
still-pending approval request; once finalization holds the lease, generation
fails with `gpu_stop_pending` until Stop succeeds, fails, or expires safely.

No job completion, idle state, application exit, timer, background process, or
connectivity failure may invoke termination.

## Switch GPU

Switch is a forward replacement transaction, not an in-place update. It starts
only from the visible/focused app after the editor selects a fresh live offer,
reviews the exact old/target GPU and prices, and explicitly confirms that the
current image may finish, the batch/queue will remain paused, the old Pod will
be permanently terminated, the same volume is preserved, the target may vanish,
downtime is expected, and billing continues after readiness.

1. Native holds the profile-control lock, CSPRNG-generates IDs, writes the strict
   queue reservation, parks/releases the queue runner and keep-awake, persists
   `planned`, and creates the worker consent request without an admission gap.
2. Every required live foreground principal may approve or deny once. A denial,
   expiry, owner loss, worker restart, corruption, or response ambiguity sends
   no provider mutation. Foreground Start/Stop/queue admission observes the same
   reservation/worker guard.
3. After approval, native privately finalizes. The worker finishes at most the
   current image, persists manifests/checksums, pauses the exact batch, and
   publishes the shared switch marker before `ready_to_delete`.
4. Native revalidates the exact old Pod/profile/worker and commits delete intent
   before one old-Pod DELETE. Timeout allows only one later explicit same-intent
   Resume retry after exact GET 200 identity proof. There is never a third
   DELETE. DELETE/GET 404 still requires a fresh profile list with no same ID.
5. Only after `old_absent`, native refetches live target evidence and sends one
   singleton replacement POST for that attempt. Response loss becomes
   `create_uncertain`; Resume reconciles exact provider attempt fingerprints and
   zero/one/multiple matches without a blind POST or name-based adoption.
6. Native and the replacement worker verify the selected GPU, same network
   volume/mount, immutable image, profile, CUDA/NVML device, model and shared
   marker. Success is **GPU ready — batch and queue are paused**. Resume batch,
   Resume queue and Stop GPU remain separate explicit actions.

At most one profile Pod/volume writer is ever authorized. A failed replacement
is never automatically deleted or replaced; exact cleanup and another attempt
each require their own labelled foreground confirmation. No alarm, queue
completion, price change, timer, relaunch, or background monitor can start or
advance Switch.

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
