# API contract

All worker responses include `schema_version: 1`. Errors use a stable `code`, a
safe user `message`, and optional structured `details`.

## Worker endpoints

- `GET /v1/health` -> process, model, GPU, version, phase, phase progress.
- `GET /v1/status` -> active batch summary and requesting user's permissions.
- `PUT /v1/studio/sessions/{session_id}` -> publish an authenticated foreground
  or background heartbeat and return the authoritative studio snapshot.
- `GET /v1/studio/sessions/{session_id}` -> read the studio snapshot without
  extending that session's presence TTL.
- `POST /v1/studio/stop-requests` -> request consent to stop one exact Pod.
- `POST /v1/studio/stop-requests/{request_id}/responses` -> approve or deny as a
  required foreground user.
- `POST /v1/studio/stop-requests/{request_id}/finalize` -> acquire the short
  generation-blocking guard after exact-Pod preflight.
- `POST /v1/studio/stop-requests/{request_id}/cancel` -> release a request or an
  exact finalization guard after abort/failure.
- `POST /v1/batches` -> idempotently create/replay one batch or return a typed
  admission error. The worker never retains a waiting batch queue.
- `GET /v1/submissions/{client_submission_id}` -> owner-only exact active or
  terminal submission association; missing and foreign IDs are indistinguishable.
- `GET /v1/batches/{id}` -> durable manifest and progress.
- `POST /v1/batches/{id}/pause` -> stop after current image; keep lock.
- `POST /v1/batches/{id}/resume` -> resume owner batch.
- `POST /v1/batches/{id}/cancel` -> cancel remaining images and release lock.
- `POST /v1/batches/{id}/retry-failed` -> retry only terminal failures.
- `GET /v1/batches/{id}/artifacts/{index}` -> full JPEG with checksum headers.
- `GET /v1/batches/{id}/previews/{index}` -> WebP preview.
- `POST /v1/batches/{id}/receipts` -> acknowledge verified local downloads.

Clients use bounded polling and heartbeats. These endpoints do not create or
terminate compute; Pod lifecycle operations remain explicit desktop actions.

## Idempotent batch submission and local queue admission

`POST /v1/batches` requires `client_submission_id`, a canonical lowercase
UUIDv4, and accepts `admission_mode: "foreground" | "queue"` (default
`foreground`). The remaining request is the existing ordered prompts,
JavaScript-safe `base_seed` (`base_seed + prompt_count - 1 <=
9007199254740991`), aspect ratio, and bounded ordered references. Local batch
name, output destination, queue-item ID, and style switch never cross this API;
resolved prompts already contain any enabled Editorial Realism suffix.

While holding the controller/shared-volume lease, the worker validates the
request and computes, rather than trusts, this fingerprint:

```text
sha256("imageforge-batch-submission-v1\n" || canonical_json_utf8)
```

Canonical JSON is Python `json.dumps(value, ensure_ascii=False,
allow_nan=False, sort_keys=True, separators=(",", ":"))`, UTF-8 encoded. Its
object contains exactly `owner_user_id`, `admission_mode`, ordered exact
`prompts`, `base_seed`, `aspect_ratio`, ordered references as `{name,
mime_type, size_bytes, sha256}`, and the complete `GenerationSettings`
projection (`model`, `revision`, `precision`, width/height, steps, guidance,
JPEG quality, preview width/height). The authenticated principal `user_id`, not
an editable display name, is identity.

Replay is resolved before active-lease or Stop admission. The same submission
ID, owner, and fingerprint returns HTTP 201 with the exact original owner
manifest and batch UUID, including while another batch owns the active lease.
Any owner or fingerprint mismatch returns generic HTTP 409
`submission_conflict`, null details, and discloses no key existence. Durable
submission associations are retained for the shared-volume lifetime; future
cleanup must keep an indefinite conflict tombstone so a terminal replay can
never become a new batch.

`GET /v1/submissions/{client_submission_id}` requires the same authentication.
The owner receives HTTP 200 with the exact active or terminal manifest. Missing
and foreign IDs both return HTTP 404 `submission_not_found` with null details.
Owner manifests/native owner projections contain `client_submission_id` (or
legacy null/omission for old version-1 manifests). Foreign status, busy, Studio,
and error projections omit submission IDs, fingerprints, prompts, references,
local names, destinations, and all existence detail.

Each new batch uses one crash-atomic version-2 `manifest.json` envelope that
contains the public manifest plus private `{client_submission_id,
owner_user_id, request_fingerprint}`. Reference blobs/directories are fsynced
first; the complete envelope is temp-written, file-fsynced, atomically renamed,
and its batch/root directories fsynced. That rename is the only admission
commit point and occurs before active-memory publication, inference, or the
HTTP response. Startup and lookup rebuild from envelopes. A crash before rename
may admit fresh work; a crash after rename must replay that same batch and
startup recovers unfinished work as interrupted. Legacy version-1 manifests
remain readable but have no submission association.

A corrupt version-2 envelope fails every new create and submission lookup
closed as HTTP 503 `submission_store_corrupt` with the fixed message `Worker
submission history is unavailable. Repair the shared volume before starting
generation.`, null details, and no path/owner/key/exception disclosure.
`GET /v1/status.permissions.can_create` is false and the strict nullable
`permissions.create_block_reason` is `submission_store_corrupt` (the only
other value, `gpu_stop_pending`, identifies the shared Stop finalization
guard), while valid owner batch reads remain available. Desktop clients classify this exact code as non-retryable,
park the local item/run in `needs_attention`, and require shared-volume repair
plus an explicit foreground **Resume queue**; no timer retry is permitted.
Every worker error response is the exact strict envelope
`{"schema_version":1,"error":{"code":string,"message":string,"details":object|null}}`;
unknown or omitted fields are rejected at the native boundary before the safe
renderer projection.

Admission modes preserve the explicit Stop contract without a race:

- `foreground`: pending/approved consent is atomically cancelled as
  `generation_started`; finalizing returns HTTP 423 `gpu_stop_pending`.
- `queue`: an idempotent replay still wins, but a new submission encountering
  pending/approved consent returns HTTP 423 `queue_stop_pending` and does not
  cancel peer consent; finalizing returns `gpu_stop_pending`.

`batch_busy` still reports the one active owner/progress and stores no waiting
request. A desktop's persisted queue is device-local staging only. Recovery
performs owner lookup first, exact Pod/worker preflight, then local
destination/reference validation before any new POST.

For a projected `queue_reference_missing`, `queue_reference_mismatch`, or
`queue_destination_unavailable` item, the only direct destructive recovery is
the explicit **Remove damaged item** action: native removes an unassigned row or
cancels an assigned row while the caller holds its exact runner lease. It does
not contact the worker or RunPod, and it never applies to
`submission_uncertain`.

## Native device-queue command schema

Queue commands use camelCase renderer objects, snake_case Rust command names,
deny unknown fields, and return the existing strict native error envelope
`{code:string,message:string,retryable:boolean}`. Counts, seeds, revisions,
sizes, and notification IDs are non-negative JavaScript-safe integers. IDs are
canonical lowercase UUIDv4; timestamps are RFC3339 milliseconds.

```text
queue_load() -> NativeQueueSnapshotV1
queue_reset({input:{confirmation:"RESET LOCAL QUEUE"}}) -> NativeQueueSnapshotV1
queue_commit({input:NativeQueueCommitV1}) -> NativeQueueSnapshotV1
queue_prepare_dispatch({input:{queueItemId,clientSubmissionId,purpose:"edit"|"dispatch"}}) -> NativeQueueDispatchPayloadV1
queue_acquire_runner({input:{runRevision}}) -> {runRevision,held}
queue_release_runner({input:{runRevision}}) -> {runRevision,held}
queue_set_sleep_prevention({input:{runRevision,enabled}}) -> NativePowerState
queue_signal_alert({input:{eventId,kind}}) -> NativeAlertResult
```

`NativeQueueSnapshotV1` is exactly `{schemaVersion:1, storeRevision,
document:{schemaVersion:1,items,run,alarm}, issues}`. Every issue is `{code,
queueItemId:null|UUID,retryable}`. A valid item is exactly:

```text
{schemaVersion:1, queueItemId, clientSubmissionId, recordRevision,
 runRevision:null|UUID, remoteBatchId:null|UUID,
 state:"staged"|"dispatching"|"active"|"saving"|"completed"|
       "completed_with_failures"|"needs_attention"|"interrupted"|
       "cancelled"|"historical",
 attentionCode:null|string, name, prompts:string[], baseSeed, destination,
 aspectRatio:"16:9"|"1:1"|"9:16"|"4:3"|"3:4",
 styleSuffix:null|string, references, createdAt, updatedAt}
```

A queue item or placeholder `name` is trimmed, control-character-free, and at
most 120 UTF-8 bytes. A non-null `attentionCode` is non-empty,
control-character-free, and at most 80 UTF-8 bytes. Reference filenames retain
their separate 255-byte cap. Native and renderer validators reject rather than
truncate values outside these bounds.

A reference is exactly `{id,name,mimeType:"image/jpeg"|"image/png"|
"image/webp",sizeBytes,sha256}`. A corrupt record projects only the strict
placeholder `{schemaVersion:1,queueItemId,recordRevision,
state:"needs_attention",attentionCode:"queue_item_corrupt",name,promptCount,
referenceCount,createdAt,updatedAt}`. It can be retained byte-for-byte or
explicitly removed, never synthesized by the renderer.

`run` is null or `{runRevision,cohortItemIds,runnerState,
authorizationRequired,keepAwake}` where runner state is `idle`, `running`,
`pause_after_current`, `paused`, `needs_attention`, or `completed`. `alarm` is
null or `{eventId,runRevision,state,kind,snoozeUsed,snoozeDueAt,
notificationDisposition,snoozeNotificationDisposition}`. Alarm states are
`disarmed`, `armed`, `ringing`, `snoozed`, `acknowledged`; kind is null,
`complete`, or `attention`; dispositions are null, `pending`, `delivered`,
`permission_denied`, or `failed`. `delivered` is terminal. A `failed` key is
retried at most once per open process/relaunch and by explicit Ring now; a
later explicit attempt may advance `failed` or `permission_denied` to a final
result. Alert delivery requires the matching current alarm to be `ringing`.
Malformed outbox state projects non-retryable `queue_alert_outbox_invalid`
with a failed visible fallback and never silently replays an acknowledged event.

`NativeQueueCommitV1` is exactly `{expectedRevision,document,referenceBlobs}`;
a reference blob is `{sha256,mimeType,sizeBytes,bytes:number[]}` and is accepted
only under the bounded reference contract. The payload read is staged-only and
revalidates destination/blob identity. Purpose `dispatch` requires the exact
current running run and held runner lease. Purpose `edit` permits an unassigned
staged row; an assigned cohort row still requires its exact held runner lease.
This explicit purpose prevents an edit read from weakening dispatch admission.
The command returns exactly `{queueItemId,clientSubmissionId,name,prompts,baseSeed,
destination,aspectRatio,references:[reference fields plus bytes]}`. Raw bytes
never appear in load/commit responses. The renderer can call notification
permission check/request only; generic notify and arbitrary filesystem,
power, sound, title, body, or path inputs are not exposed.

Reset accepts only the literal confirmation above, only when the store is
`queue_store_unrecoverable`; it quarantines the old private tree and returns an
empty revision-zero snapshot. Healthy/recoverable stores return non-retryable
`queue_reset_not_allowed`. It never mutates a Pod or worker batch.

## Studio presence and coordinated Stop

Every studio route requires the same bearer authentication as batch routes. IDs
are canonical lowercase UUIDv4 strings. `pod_id` is 1-58 ASCII alphanumeric or
hyphen characters with no edge hyphen. `gpu_display_name` uses the exact
untrimmed `IMAGEFORGE_GPU_IDENTITY_V1` grammar and 1-128 UTF-8 byte cap shared
with Task 014. Credential display names remain separately trimmed, printable,
and 1-80 characters. Requests and responses never contain bearer
tokens, prompts, local paths, references, or receipt data.

Production TTLs are 15 seconds for presence, 30 seconds for a Stop response,
and 60 seconds for finalization. A `PUT` heartbeat renews presence; `GET` does
not. Presence is capped at 16 sessions globally and 8 sessions per authenticated
principal. Multiple windows for one principal are visible sessions but count as
one Stop participant. While a response is pending, `waiting_for` contains every
live foreground session for each required principal so every eligible window
can render working controls. Either window may respond, but approval/denial is
still counted once per principal; `approved_by` and `denied_by` use that
principal's lexicographically lowest foreground session as their deterministic
representative. The requester's entire principal is excluded from
`waiting_for`.

The exact response envelope is:

```json
{
  "schema_version": 1,
  "server_instance_id": "00000000-0000-4000-8000-000000000001",
  "coordination_revision": 12,
  "server_time": "2026-08-03T12:00:00.000Z",
  "presence_ttl_seconds": 15,
  "response_ttl_seconds": 30,
  "finalization_ttl_seconds": 60,
  "current_session": {
    "session_id": "00000000-0000-4000-8000-000000000002",
    "display_name": "Lakshman",
    "availability": "foreground",
    "expires_at": "2026-08-03T12:00:15.000Z"
  },
  "sessions": [],
  "active_batch": null,
  "stop_request": null
}
```

`sessions` contains the same session shape as `current_session`. `active_batch`
is either `null` or the existing `BatchSummary` shape. When present,
`stop_request` has:

```json
{
  "request_id": "10000000-0000-4000-8000-000000000001",
  "pod_id": "pod-123",
  "gpu_display_name": "NVIDIA RTX 4090",
  "requester": {
    "session_id": "00000000-0000-4000-8000-000000000002",
    "display_name": "Lakshman"
  },
  "state": "pending",
  "reason": null,
  "requested_at": "2026-08-03T12:00:00.000Z",
  "response_deadline": "2026-08-03T12:00:30.000Z",
  "finalization_expires_at": null,
  "waiting_for": [],
  "approved_by": [],
  "denied_by": [],
  "finalization_id": null
}
```

Stop states are `pending`, `approved`, `denied`, `expired`, `cancelled`, and
`finalizing`. Terminal reasons are `peer_denied`, `response_timeout`,
`requester_cancelled`, `requester_expired`, `generation_started`, and
`finalization_expired`. A newly foreground principal joins a pending/approved
request before finalization. A background or expired peer stops being required.
Any denial terminates consent. The requester session must remain live and only
that exact session can finalize or cancel. `finalization_id` is returned only to
that exact requester session. Once granted, the guard survives requester
presence loss until its own TTL so an in-flight or ambiguous DELETE cannot
release generation early.

An active running, paused, or resumable interrupted batch is an unconditional
HTTP 423 `stop_blocked_by_active_batch` veto. With no active batch, zero peers
means immediate `approved`; otherwise every other foreground principal must
approve. Pending or approved consent never blocks foreground generation. A
valid foreground create/resume/retry atomically changes it to `cancelled` with
reason `generation_started`; a new `admission_mode: queue` create instead fails
`queue_stop_pending` without changing consent. Only `finalizing` blocks all new
admissions, with HTTP 423 `gpu_stop_pending`, until exact cancellation or
bounded expiry. All stop and
generation admissions share the worker controller's async lock. Finalization
also owns the shared-volume active lease and publishes a strict, atomically
replaced `.gpu-stop-finalization.json` marker. A second worker process or Pod
therefore returns the same typed `gpu_stop_pending` response for create, resume,
and retry attempts; it cannot bypass finalization with another process-local
controller. `/v1/status.permissions.can_create` is false for the same bounded
interval and `permissions.create_block_reason` is `gpu_stop_pending`.

Coordination is intentionally ephemeral. A worker restart changes
`server_instance_id` and invalidates every session, request, approval, and
client-visible finalization authorization. Clients must heartbeat anew and must
never carry a grant across an instance change. The consumed safety guard is the
one exception: an unexpired shared marker is adopted by the next process while
holding the active lease and continues to block generation for the remaining
TTL, because the prior exact-Pod DELETE may already be in flight. Graceful
shutdown and crashes leave that marker intact. Only the lease owner may clear an
expired or invalid marker, and exact cancellation clears only its matching
marker. Heartbeats in the new epoch expose the marker as a synthetic
`finalizing` Stop view with the exact Pod, GPU, requester display name, and
expiry, but with empty decision arrays and a null `finalization_id`. Its
collision-checked synthetic requester session is never a live session, so no
new-epoch client becomes the requester or approver. Respond, cancel, and
finalize actions against the old request remain `stop_request_not_found`; the
view cannot revive or consume the old deletion grant. At bounded expiry the
synthetic view disappears and idle `/v1/status` becomes create-capable again.
The desktop still revalidates the exact Pod immediately before finalization and
performs the explicit RunPod termination itself.

Primary coordination errors are:

- HTTP 404 `studio_session_not_found`, `stop_request_not_found`.
- HTTP 409 `stop_request_in_progress`, `stop_response_not_allowed`,
  `stop_response_conflict`, `stop_request_identity_mismatch`,
  `stop_request_not_approved`, `stop_approval_pending`, and
  `finalization_mismatch`.
- HTTP 423 `stop_blocked_by_active_batch` with safe owner/progress, and
  `gpu_stop_pending` or `queue_stop_pending` with request ID, requester, and
  expiry.
- HTTP 429 `studio_session_limit`.
- HTTP 422 `validation_error`, using the existing safe validation envelope.

## RunPod client operations

- List approved GPU inventory and current prices through one native observation
  containing exactly the policy catalog GET and EU-RO-1 Secure availability GET.
- List Pods tagged `imageforge`.
- Create one Pod from configured template, GPU type and network volume.
- Read runtime/provisioning state and derive the HTTPS proxy endpoint.
- Terminate a selected Pod only from a confirmed user action.

Task 014 supersedes the old renderer-owned price/ranking boundary. Provider
responses are strict and unknown fields fail closed. Inventory `securePrice`
and Pod `adjustedCostPerHr` are JSON number tokens or null; Pod `costPerHr` is a
canonical decimal string. Numeric legacy `costPerHr`, exponent ambiguity, more
than six fractional digits, negative/non-finite values, and overflow are
rejected. Accepted values become non-negative JavaScript-safe integer
`hourlyPriceMicroUsd`; binary floating point never participates in equality,
ranking, persistence, confirmation, request/response fingerprints, or provider
authority. `contracts/runpod-price-v1.*` is the shared Rust/TypeScript vector.

The native inventory boundary is:

```text
gpu_inventory_load() -> NativeGpuInventorySnapshotV1
gpu_inventory_begin_refresh({includeEmergencyTier:boolean}) -> NativeGpuInventorySnapshotV1
gpu-inventory-v1 -> NativeGpuInventoryEventV1
gpu_start_load() -> NativeManualGpuStartResultV1|null
gpu_start_auto({input:NativeAutoGpuStartV1}) -> NativeManualGpuStartResultV1
gpu_start_selected({input:NativeManualGpuStartV1}) -> NativeManualGpuStartResultV1
gpu_start_confirm_actual_price({input:NativeManualGpuActualPriceV1}) -> NativeManualGpuStartResultV1
gpu_pod_observe() -> NativeGpuPodObservationV1
gpu_normal_stop_load() -> NativeGpuNormalStopV1|null
gpu_normal_stop({input:NativeGpuNormalStopV1}) -> NativeGpuNormalStopResultV1
```

An observation is native CSPRNG identity plus private monotonic receipt. It
coalesces only the same emergency-tier policy, publishes exactly one terminal
event, and is fresh only while age is `< 60000` monotonic milliseconds in the
same process epoch. `loading`, `fallback`, `error`, an expired receipt, a
checked-in order without a receipt, or renderer `observedAt` never authorizes
POST. `NativeAutoGpuStartV1` contains only the exact observation/receipt,
requester session, and expected lifecycle revision; native privately recomputes
and hashes the measured-value or fixed-policy order from that receipt. Final
manual/Auto Start performs a new native two-GET/profile preflight. Native stores
and emits that new terminal inventory snapshot before the command resolves. A
new receipt ID may be promoted into the same action only when profile, policy,
target/order, catalog semantics, and canonical price are identical; any
semantic change returns before POST and requires another click. The command
consumes a private one-use authority and sends a singleton manual target or
live-inventory-intersected Auto order. No generic renderer provider mutation exists.
`gpu_start_load` is read-only recovery for the exact persisted ordinary Start.
The strict Auto schema/vectors live in `contracts/gpu-start-auto-v1.*`; the
fixed local error codes/messages/retryability are the exhaustive Task 014 table.
The JSON Schema is structural; the mandatory Rust/TypeScript relation validator
and raw-byte numeric-token rejection vectors enforce price equality, lifecycle
relations, and non-exponent integer spelling. Each Auto/manual/actual-price
command requires an OS-native modal confirmation owned by the visible, focused,
non-minimized main window. Before acceptance native performs no provider I/O or
journal mutation; cancel/focus loss/wrong-window returns
`gpu_start_foreground_required`. Accepted confirmation mints and consumes a
private one-use command/input authority, so crafted renderer IPC cannot approve
the paid action. After a durable create socket
write, an invalid/truncated HTTP 2xx body is `create_uncertain`, never a
definitive provider-response error.
Every final-preflight inventory/HTTP failure maps to that table before provider
POST; create-response ambiguity instead persists and returns `create_uncertain`.
The production plugin capability is `main-capability` in
`src-tauri/capabilities/default.json`. App-owned Task 014 commands are gated by
the exact `generate_handler!`/main-window list in the shared vectors; generic
renderer `runpod_*_http` inventory/list/get/create/delete commands are absent
after migration. Selector performance commands exist only in the dedicated
`qa-gpu-selector-perf-v1` installed-test capability.

Ordinary production Pod polling uses only `gpu_pod_observe`: one coalesced,
profile-scoped Pod-list GET with no catalog read, receipt, grant, or mutation.
The bound RunPod REST revision exposes no cursor/page request fields and its
successful `/pods` response is one complete top-level JSON array, so that one
GET is the complete page set. Any object/cursor/continuation envelope is an
invalid partial observation and never replaces verified Pod state.
Its strict observation projects offline/single/multiple/unavailable, bounded
sorted managed Pods, stale retention, overflow, and fixed safe issues.
Coordinated Task 012 deletion uses only `gpu_normal_stop`. Native owns the fresh
exact-Pod/profile/worker/Stop-Switch guard revalidation, private finalization
and provider authority, single DELETE, 404-plus-absence proof, and
delete-uncertain outcome. Renderer input contains no provider URL/body,
finalization ID, or deletion grant. The five generic `runpod_*_http` commands
have no registered handler or TypeScript invoke string after this migration.
The authoritative structural schema and semantic/relaunch vectors are
`contracts/gpu-pod-control-v1.schema.json` and
`contracts/gpu-pod-control-v1.vectors.json`. Observation revisions start at 0
per process epoch/profile and advance once for every terminal profile-list
attempt; coalesced callers share one revision. A new normal Stop commits its
preflight at `R+1` and its post-delete/ambiguity observation at `R+2` under the
profile lock, and is rejected before I/O when `R > MAX_SAFE_INTEGER-2`.
Completed replay is byte-identical/no-I/O; uncertain replay is
observation-only and never resends DELETE. The completed replay's embedded
observation is historical evidence and never replaces the new process's live
projection; `gpu_pod_observe` must establish current truth first. Uncertain
replay returns the same operation ID with a current-process observation that
retains the old Pod and does replace the live projection.
`gpu_normal_stop_load` supplies the byte-identical persisted input only for an
active Stop already at the durable mutation/ambiguity boundary. It performs no
network I/O, exposes no native operation/finalization/provider authority, never
returns a preflight-only record, and is the sole production relaunch bridge into
the observation-only uncertain replay path.

## Coordinated GPU switch worker API

Every route below requires the existing bearer authentication. Canonical UUIDv4
IDs, strict `IMAGEFORGE_GPU_IDENTITY_V1` (1-128 UTF-8 bytes in the reviewed ASCII
alphabet), strict authenticated user IDs, JavaScript-safe revisions, RFC3339
millisecond times, fixed messages, null-safe details, and unknown-field rejection
are binding. Renderer views omit principal-binding/finalization IDs, raw worker
or provider bodies, prompts, references, local paths, credentials, and private
runtime fields.

| Route | Input | Result |
| --- | --- | --- |
| `GET /v1/studio/gpu-switches/{switch_id}?session_id=...` | exact live session | safe owner/peer `GpuSwitchLookupResponseV1` |
| `GET /v1/internal/gpu-switches/{switch_id}/owner?session_id=...` | pinned native-only owner query | private `NativeWorkerGpuSwitchOwnerLookupV1`, including the worker-authenticated requester user ID and principal binding for response-loss recovery |
| `GET /v1/internal/gpu-switches/{switch_id}/runtime-identity?session_id=...` | pinned native-only owner query | `WorkerGpuSwitchRuntimeIdentityV1` |
| `POST /v1/studio/gpu-switches` | native-only `CreateGpuSwitchRequestV1` | HTTP 201 private create response |
| `POST /v1/internal/gpu-switches/{switch_id}/settle-create` | native-only exact create replay | terminal owner lookup |
| `POST /v1/studio/gpu-switches/{switch_id}/responses` | peer approve/deny | `StudioStateResponse` |
| `POST /v1/studio/gpu-switches/{switch_id}/finalize` | requester-only private finalization | `StudioStateResponse` |
| `POST /v1/studio/gpu-switches/{switch_id}/delete-intent` | exact finalization/old Pod | `StudioStateResponse` |
| `POST /v1/studio/gpu-switches/{switch_id}/adopt` | exact replacement attempt/runtime | `StudioStateResponse` |
| `POST /v1/studio/gpu-switches/{switch_id}/complete` | exact verified replacement | `StudioStateResponse` |
| `POST /v1/studio/gpu-switches/{switch_id}/cancel` | pre-delete exact requester action | `StudioStateResponse` |

Every `StudioStateResponse` carries strict `gpu_switch_request` and
`gpu_switch_can_respond` fields. The latter is a privacy-safe, per-current-session
UI capability hint only; the worker still authenticates the principal/session
on every response and never exposes a principal identifier.

`NativeGpuSwitchRecordV1.targetConfirmation` is the strict durable
`required | confirmed` projection for the initial replacement target. New
`planned` and unconfirmed `consent_pending` records are `required`;
`gpu_switch_confirm_target` commits the one-way `confirmed` state, and native
finalization rejects `required`. Every later nonterminal phase is `confirmed`.
This field is native authority for choosing **Confirm target** versus
**Finalize switch** after reload; renderer memory cannot substitute for it.

The worker CSPRNG-generates the distinct principal binding and finalization IDs.
Create is fingerprint-idempotent and crash-atomic. Its native journal records
`send_pending` before the socket write and `sent_uncertain` before surfacing
response loss; owner lookup/settling, not a new UUID or blind retry, resolves
ambiguity. Terminal tombstones and UUID-conflict identity remain for the shared-
volume lifetime. Foreign/missing owner lookup is the same safe 404.

Pending/approved consent is ephemeral and includes every other live foreground
principal once. Finalization finishes at most the current image and atomically
publishes the artifact-safe `.gpu-switch-v1` shared marker while holding
`.gpu-control-v1.lock`. Every worker process/Pod adopts that marker before
generation. From finalization through replacement completion, create/resume/
retry, normal Stop, and another Switch fail `gpu_switch_pending`; the complete
Stop/Switch winner table and status block/action mapping are generated from
`contracts/gpu-switch-codes-v1.json`. Corrupt switch history maps to fixed
HTTP 503 `gpu_switch_store_corrupt` with null details and no private disclosure.

## Native coordinated GPU switch commands

Provider transport, worker Finalize, finalization IDs, profile paths, private
grants, and arbitrary URLs/bodies are not registered with Tauri IPC. The
renderer may call only these camelCase/strict commands:

```text
gpu_switch_load() -> NativeGpuSwitchSnapshotV1
gpu_switch_authorize_foreground({input:NativeGpuSwitchForegroundGrantRequestV1}) -> NativeGpuSwitchForegroundGrantV1
gpu_switch_begin({input:NativeGpuSwitchBeginV1}) -> NativeGpuSwitchSnapshotV1
gpu_switch_acquire({input:NativeGpuSwitchAcquireV1}) -> NativeGpuSwitchLeaseV1
gpu_switch_release({input:NativeGpuSwitchKeyV1}) -> NativeGpuSwitchLeaseV1
gpu_switch_sync_worker({input:NativeGpuSwitchWorkerSyncV1}) -> NativeGpuSwitchSnapshotV1
gpu_switch_finalize({input:NativeGpuSwitchFreshWorkerV1}) -> NativeGpuSwitchSnapshotV1
gpu_switch_confirm_target({input:NativeGpuSwitchPrepareTargetV1}) -> NativeGpuSwitchSnapshotV1
gpu_switch_delete_old({input:NativeGpuSwitchFreshWorkerV1}) -> NativeGpuSwitchSnapshotV1
gpu_switch_prepare_attempt({input:NativeGpuSwitchPrepareTargetV1}) -> NativeGpuSwitchSnapshotV1
gpu_switch_confirm_attempt({input:NativeGpuSwitchConfirmAttemptV1}) -> NativeGpuSwitchSnapshotV1
gpu_switch_create_replacement({input:NativeGpuSwitchFreshWorkerV1}) -> NativeGpuSwitchSnapshotV1
gpu_switch_confirm_actual_price({input:NativeGpuSwitchActualPriceV1}) -> NativeGpuSwitchSnapshotV1
gpu_switch_delete_replacement({input:NativeGpuSwitchReplacementDeleteV1}) -> NativeGpuSwitchSnapshotV1
gpu_switch_reconcile_provider({input:NativeGpuSwitchProviderReconcileV1}) -> NativeGpuSwitchSnapshotV1
gpu_switch_verify_replacement({input:NativeGpuSwitchWorkerSyncV1}) -> NativeGpuSwitchSnapshotV1
gpu_switch_complete({input:NativeGpuSwitchWorkerSyncV1}) -> NativeGpuSwitchSnapshotV1
gpu_switch_cancel({input:NativeGpuSwitchWorkerSyncV1}) -> NativeGpuSwitchSnapshotV1
```

Native owns a versioned generation journal, cross-process lease, trusted-input
foreground grant, private provider authorities, strict `QUEUE_RESERVATION`,
one-use target quote, and canonical provider request/response fingerprints.
`recordRevision` and `storeRevision` start at 1, increment exactly once, and
never exceed JavaScript's safe integer. Relaunch is read-only and always loses
authorization. One explicit Resume reconciles exact provider/worker/journal
state before any state-specific mutation.

Old-Pod deletion is one logical intent: one initial DELETE plus at most one
explicit same-intent Resume retry after a fresh exact GET still proves the old
identity. `oldDeleteWireAttempts` is durably `0 -> 1 -> 2`; no third DELETE is
possible. DELETE or exact-GET 404 still needs a fresh profile list with no same
ID before `old_absent`. Each replacement attempt permits one POST. Ambiguous
create is read-only reconciled by attempt marker/fingerprints; no automatic
retry, fallback, adoption by name, peer-Pod deletion, or simultaneous volume
writer is allowed.

The full field-level HTTP/native types, phase tables, fixed code mapping, JCS
fingerprints, queue reservation envelope, and shared test vectors are frozen in
[Task 014](../tasks/014-live-gpu-selector-and-coordinated-switch.md) and its
checked-in `contracts/gpu-*-v1` artifacts. Implementations must reject schema
drift rather than treating this summary as a looser alternative.

## Busy response

```json
{
  "schema_version": 1,
  "error": {
    "code": "batch_busy",
    "message": "Lakshman is generating 138 of 420 images.",
    "details": {"owner":"Lakshman","completed":138,"total":420}
  }
}
```
