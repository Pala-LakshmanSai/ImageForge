# Architecture

## Components

### Desktop client

- React/TypeScript presentation and local state.
- Tauri/Rust commands for OS dialogs, credential vault, downloads, checksums,
  bounded authenticated WebP previews, receipt-bound full JPEG reads and
  exports, durable user-named batch-folder mappings, local manifest storage,
  and RunPod requests. Image bytes are held in a bounded session-local object
  URL cache only; worker credentials never cross into the renderer.
- A native device-queue journal, process runner lease, bounded keep-awake
  assertion, and fixed-copy notification outbox. React owns the foreground
  scheduler but cannot choose arbitrary queue paths, notification copy, power
  reasons, or filesystem roots.
- A `RunPodProvider` interface with fake and real implementations.
- A `WorkerClient` interface with fake and HTTP implementations.

### RunPod management

The GPU chip opens a compact selector backed by one native inventory observation:
two validated RunPod catalog GETs, one native process-epoch receipt, policy
filtering, and strict terminal `gpu-inventory-v1` projection. A visible sheet
refreshes immediately, re-observes once its receipt has 15,000 milliseconds of
validity left, and withdraws every row the moment that window elapses, so an
unattended sheet never presents an expired receipt as startable; a paid-action
confirmation suspends the background re-observation while it is on screen, and
a native `gpu_start_inventory_stale`, receipt, target, price, or revision
rejection re-observes in place. Final Start or Switch rejects a receipt at or
beyond 60,000 monotonic milliseconds. Catalog and Pod prices are
parsed losslessly into integer micro-USD. Inventory `securePrice`, Pod
`adjustedCostPerHr`, and Pod `costPerHr` accept exact JSON number tokens;
`costPerHr` also accepts the provider's decimal-string form. An omitted
`adjustedCostPerHr` means no adjustment and falls back to the exact base cost.
Both the native and renderer price parsers admit exactly these forms.
Binary floating point is never authority for
equality, ranking, persistence, confirmation, or fingerprints.

Pod observation reads only ImageForge's own Pods. Ownership is decided by the
reserved `imageforge` Pod name, and an unrelated Pod sharing the RunPod account
is skipped rather than failing the observation, so one foreign workload cannot
disable Pod state for the whole app.

An ImageForge-named Pod that fails managed validation fails closed while it is
provisioning, starting, or running: that is the case where an unrecognized
worker image can mean live billing or unknown code, so it keeps blocking Start
and can never become a second billed Pod. A Pod already in a terminal state
(`exited`, `terminated`) is excluded from the observation instead. Terminal
Pods accumulate in the account under whatever worker image was pinned when
they ran, they cannot bill or be resumed into the current Pod, and treating one
as fatal previously disabled all Pod state — and therefore Start — permanently,
with no in-app recovery.

The selection engine uses only checked-in Task 014 benchmark-v2 evidence whose
model/image/settings/fixture/hash match and whose age is under 90 days. Exact
wide-integer cross-products rank measured offers by whole-batch value; stale
evidence remains manually selectable as **Benchmark expired** but has no score
or cost. When measured quorum is unavailable, Auto uses the reviewed fixed order
intersected with the same fresh receipt-bearing live inventory. A fallback or
error snapshot is explanatory only and cannot authorize provider creation.

At every explicit Auto start, one REST create call uses RunPod's
`gpuTypePriority: custom`; a manual start uses one exact singleton target.
Creation uses the fixed ImageForge template, immutable worker image, one GPU,
shared network volume, required ports, and runtime secrets. The response's exact
Pod/GPU/price identity is revalidated; a changed or unavailable actual price
requires explicit acknowledgement rather than silent reuse.

Only user actions create or terminate Pods. Polling may observe state but never
changes it. Concurrent start clicks are reconciled by discovering matching live
ImageForge Pods and presenting duplicates for manual cleanup; they are never
silently terminated.

### Coordinated GPU replacement

Task 014 adds one native, crash-safe replacement saga; it does not add a second
running GPU or an in-place provider update. A foreground trusted-input grant and
native lease bind the exact old Pod, selected target, live inventory receipt,
authenticated requester, batch, profile, volume and immutable image. The worker
stores a crash-atomic consent request and later a shared `.gpu-switch-v1` marker.
Every worker process/Pod adopts that marker before generation and shares one
`.gpu-control-v1.lock` namespace with coordinated Stop.

Before worker finalization the other live principals may deny or approve.
Finalization finishes at most the current image and persists the artifact-safe
pause fixed point. Native then obtains worker delete intent, durably consumes a
private old-delete authority, and sends one exact old-Pod DELETE. A response-
uncertain logical deletion permits at most one explicit same-intent Resume retry
after a fresh exact GET still proves the Pod exists; there is never a third
DELETE. DELETE/GET 404 satisfies only the exact-ID leg, and a fresh fully
paginated profile list must also prove absence before any replacement POST.

The replacement request is one exact target with the same template, immutable
image, network volume/mount, EU-RO-1 Secure profile, port and secrets. One POST
is allowed per native attempt. Timeout or malformed success becomes
`create_uncertain`; reconciliation uses the provider-visible attempt marker and
canonical request/response fingerprints and never Pod name alone. Native and
worker verify Pod, volume, image, selected GPU, CUDA/NVML device, model and
marker before `ready_paused`/completion. No step auto-resumes work or stops the
new GPU.

The device queue and Switch share `profile-control.lock`. Begin atomically
writes a strict private `QUEUE_RESERVATION`, parks the current queue, releases
its runner/keep-awake, and commits the switch record without an admission gap.
Queue Run/Resume/dispatch and ordinary Start/Stop fail closed while that
reservation is prepared, active, or releasing. Every terminal switch outcome
releases the reservation only after matching worker tombstone and native
history; the queue remains paused for an explicit Resume.

### Worker

- FastAPI lifecycle exposes health before the model is ready.
- Pipeline loader verifies local weights and loads BF16 directly onto one GPU.
- A single generation controller owns an atomic active-batch lease.
- Authenticated studio heartbeats publish only bounded client identity and
  foreground presence. They never contain prompts, paths, or credentials.
- Coordinated Stop GPU requests and their short-lived finalization guard live
  beside the batch lease on the shared volume, so admission and termination
  cannot race across processes or Pods.
- Durable JSON manifests live on the network volume. Updates use temp files and
  atomic rename. Completed artifacts are immutable.
- Version-2 manifests crash-atomically bind a client submission UUID, owner
  principal, and worker-computed request fingerprint to the public manifest.
  Owner-only lookup/replay prevents duplicate admission after response loss;
  no worker-side waiting queue is introduced.
- Preview and full files are downloadable independently with checksums.

### Authoritative studio synchronization

Every desktop treats the live RunPod snapshot and authenticated worker studio
status as authoritative. A foreground client observes them on a bounded,
coalesced interval; observation never starts or stops compute. Worker status is
projected before local receipt reconciliation, so opening a second computer
shows the current ready, busy, resumable, or finalizing state without waiting
for that computer's receipt ledger.

The shared worker lease, rather than an open window or a local recovery task,
is the only generation lock. Exactly one running, paused, or resumable
interrupted batch can own it. Other clients may prepare prompts while locked,
but attempting to generate returns the typed owner/progress response instead
of creating a worker-side waiting batch. A user may separately stage immutable
batches in one device's private local queue; only its current dispatcher item
ever calls the worker and competes for the one lease.

### Device-local sequential queue

The queue is a local scheduler, not shared worker state. **Add to device queue**
copies a validated prompt/settings/reference snapshot into Tauri app data even
when the Pod is offline or busy. **Run queue** is a foreground authorization
that freezes one ordered cohort, persists it paused, acquires an exact native
runner lease, then persists running. Relaunch discards that in-memory
authorization, loads the durable run paused, and requires **Resume queue**.

Every first/successor admission is serialized through the production worker
coordinator. Recovery performs owner-only submission lookup before Pod/worker
status or destination/reference preflight. A 404 plus authoritative idle
preflight may POST the same client submission ID; an ambiguous lookup, foreign
busy batch, Stop guard, changed/offline Pod, interrupted batch, or local
storage/receipt failure parks the item and runner. The scheduler never starts,
replaces, or stops a Pod and never retries on a timer. A successor waits for a
terminal worker manifest and the existing local receipt/download fixed point.

The private store is `queue/v1` under Tauri app data:

```text
CURRENT
generations/<revision>.json
items/<queue-item-id>/<record-revision>.json
references/<sha256>.<jpg|png|webp>
alerts/<sha256-of-event-id>.json
```

Reference blobs are fsynced first, followed by immutable item records and the
generation; `CURRENT` is atomically replaced and its parent fsynced. The current
and two prior valid generations are retained. Startup can select the highest
valid generation, isolate one corrupt row as a safe placeholder, or fail closed
as `queue_store_unrecoverable`. Explicit Reset first quarantines the old tree;
it does not delete downloads or mutate remote compute.

Rust compares previous/candidate state at `queue_commit`: item and runner edges,
record revision `+1`, fixed-point completion, immutable run/cohort/remote IDs,
and current-run lease ownership are authoritative. Another process may stage
run-unassigned Next-run rows, but cannot mutate the current cohort. Completed
alarm acknowledgement/history operations are the narrow post-lease exception.
The sole copied-reference read command carries an explicit `edit` or `dispatch`
purpose. Edit may restore an exact unassigned staged row (or an assigned staged
row held by its runner); dispatch additionally requires the exact authorized
running cohort. This preserves editable local snapshots without turning a
renderer read into generation authority.

Completion creates one durable `queue-complete:<run UUID>` event only after the
whole cohort settles locally. A fixed privacy-safe OS notification and an
opt-in Web Audio alarm supplement a persistent in-app card. One 15-minute
snooze is durable; dismiss/acknowledge never stops the GPU. The optional scoped
power assertion prevents idle system sleep only while an authorized queue runs,
allows display sleep, and releases on pause, completion, error, lease loss,
reset, disable, and process exit.
Failed delivery is not a receipt: one attempt is allowed per process/relaunch
and by explicit Ring now, with no timer retry loop. Delivered keys are terminal;
acknowledged/non-ringing events cannot call native notification delivery. A
corrupt outbox remains visible as `queue_alert_outbox_invalid` while valid queue
rows remain recoverable.

Pod `offline` is a terminal authority boundary for that observation epoch. A
late worker heartbeat cannot restore a stale ready/running/finalizing state.
Owned or remotely observed in-flight work is projected as interrupted, local
worker bindings are cleared, and both computers converge on the same Pod state.

### Coordinated Stop GPU

Stop remains an explicit foreground action. The worker first vetoes the request
when any running, paused, or resumable interrupted batch owns the lease. When
the worker is idle, every other live foreground principal must approve once;
same-principal windows are excluded and multiple windows for one peer are
deduplicated. A denial, timeout, transport failure, or ambiguous response fails
closed and leaves the GPU running.

After unanimous approval, the worker atomically installs a bounded finalization
guard under the shared lease. New Create, Resume, and Retry mutations then
return `gpu_stop_pending`. The desktop revalidates the exact Pod identity and
profile through `gpu_normal_stop` before publishing `stopping` or sending the
single RunPod DELETE. A definite pre-send failure cancels/releases the exact
guard idempotently. A timeout, lost connection, 5xx/429, malformed response, or
other post-send ambiguity instead persists `delete_uncertain`, keeps the exact
guard until its bounded worker TTL, and never retries DELETE automatically.
Relaunch may observe only; after guard expiry it may settle/cancel that exact
worker request without provider mutation while retaining uncertain local
history. Restart can adopt only a valid, unexpired bounded guard. No heartbeat,
window close, batch completion, timer, or recovery path can terminate compute.

## State machines

Pod: `offline -> selecting -> provisioning -> booting -> loading -> warming -> ready -> stopping -> offline`.

Batch: `draft -> validating -> running <-> paused -> completed | cancelled | failed | interrupted`.

Image: `pending -> generating -> ready -> downloaded` with `generating -> retrying -> failed`.

Local queue item: `staged -> dispatching -> active -> saving -> completed |
completed_with_failures`, with explicit `needs_attention`, `interrupted`,
`cancelled`, then post-completion `historical`.

Local runner: `paused -> running -> pause_after_current | paused |
needs_attention | completed`; only `running` selects a successor. New runs are
persisted paused before lease acquisition.

Completion alarm: `armed | disarmed -> ringing -> snoozed -> ringing ->
acknowledged` (or quiet `disarmed -> acknowledged` after the fixed point).

## Resume semantics

- The worker persists a generated artifact before advancing the manifest.
- On boot, an unfinished `running` image becomes `pending`; already-ready files
  with matching checksums remain ready.
- The active batch owner may resume or cancel. A second user remains blocked
  until the interrupted lease is explicitly resolved.
- The desktop compares its local receipt ledger with the server manifest and
  requests only missing or checksum-mismatched files. A terminal manifest is
  reconciled to a bounded fixed point before the UI reports completion, so
  newly exposed ready artifacts cannot remain waiting after polling stops.
- The internal batch UUID remains the worker identity. Native storage maps it
  durably to the sanitized user-entered batch name, migrates legacy UUID
  folders atomically, and preserves that mapping across restart and resume.
- Receipt recovery is device-local and best-effort. It may enrich an owned
  batch after authoritative status is visible, but it never decides whether
  the shared GPU is ready or busy and never hides another owner's live batch.

## Security boundaries

- RunPod API keys remain on the local device credential vault and are sent only
  to RunPod over TLS.
- Worker API uses per-user bearer credentials supplied as RunPod secrets.
- The worker never accepts output paths from clients.
- Queue prompts, local paths, references, run/alarm state, and power state stay
  device-local. Raw reference bytes cross only strict native commit/one-item
  dispatch commands and never enter preferences, logs, notifications, or worker
  submission identity projections.
- Filenames are server-generated and path-normalized.
- Prompt requests must be finite and non-empty; malformed input is rejected while
  practical OS, transport, storage, and GPU constraints remain explicit.
