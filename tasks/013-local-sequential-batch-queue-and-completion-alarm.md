# Task 013 — Local sequential batch queue and completion alarm

Task 014 adds one native `QUEUE_RESERVATION` interaction only: an explicit
Switch atomically parks/releases an authorized queue before old-Pod deletion,
and every queue admission observes that reservation. All Task 013 persistence,
lookup-first Resume, local-only privacy, alarm, keep-awake, one-remote-batch,
and no automatic Pod Start/Stop rules remain binding; Switch never completes,
alarms, or auto-resumes the queue.

## Problem

Lakshman and Sujal need to prepare several independent image batches before an
overnight run, then let one configured macOS or Windows client submit them one
after another while the already-started GPU remains available. Today ImageForge
accepts one foreground batch draft and requires another explicit Generate click
after that batch finishes. It also provides no completion alarm, so an editor
can leave a billed Pod running after all local downloads finish.

The existing no-queue rules protect the worker's single shared generation
lease. This task supersedes `tasks/005-unbounded-prompt-batches.md` NG-1,
`tasks/012-authoritative-studio-sync-and-coordinated-stop.md` NG-2, and the
matching first-release product non-goal **only for a persisted, device-local
staging queue**. The worker still admits exactly one active batch and never
stores, reserves, advertises, or advances a waiting remote batch queue.

## Binding terminology and state machines

- A **queue item ID** and a **client submission ID** are distinct, canonical,
  lowercase UUIDv4 strings. They are generated from cryptographically secure
  randomness. Names, timestamps, prompt counts, and array positions are never
  identifiers.
- A **run revision** is a canonical UUIDv4 created by a foreground **Run queue**
  click. It freezes the ordered cohort of currently unassigned staged item IDs.
  An item staged later is labelled **Next run** and cannot join that authorized
  cohort without a later **Run queue** click. Removing an undispatched cohort
  item marks it `cancelled` for that revision; editing one atomically replaces
  it with new queue-item and submission IDs in the next run.
- The store has exactly one current run. **Run queue** is disabled, and the
  domain/native mutation fails `queue_run_active` without changing any item,
  while its runner is `running`, `pause_after_current`, `paused`, or
  `needs_attention`. After runner `completed`, the user must first **Dismiss
  alarm** or **Acknowledge completion** (the quiet `disarmed` equivalent), which
  persists the old event as `acknowledged`; only then may a Run click replace
  the singular current-run/alarm slot with a new revision for the ordered
  **Next run** items. This preserves prior immutable row/run IDs and native
  alert outbox history, so events cannot be overwritten, reordered, or doubled.
- Item states are `staged -> dispatching -> active -> saving -> completed` or
  `completed_with_failures`. `needs_attention`, `interrupted`, and `cancelled`
  are authored side/terminal states. Terminal cohort rows cannot become
  `historical` before the whole run reaches its local fixed point and its one
  completion event record exists. Only a separate **Clear completed from
  queue** action, available after runner `completed`, atomically moves that
  run's terminal rows to read-only `historical`; **Dismiss alarm** does not.
  `historical` is terminal-equivalent in every defensive cohort calculation and
  can only be removed through explicit **Clear history**. `active` includes a
  remotely paused batch; it does not imply that inference is advancing.
- Runner states are `idle`, `running`, `pause_after_current`, `paused`,
  `needs_attention`, and `completed`. Only `running` may select a successor.
  `pause_after_current` lets an accepted item reach its local fixed point and
  then becomes `paused`. Every transition is persisted before a corresponding
  remote mutation or user-visible completion claim.
- **Run authorization** is an in-memory authorization epoch held by the open
  app process together with one native runner lease. It remains valid while the
  same process is foreground, background, or minimized. OS suspend stops all
  work; after wake, the same epoch may continue only after exact-submission
  lookup, authoritative Pod/worker status, and destination preflight complete.
  Any changed Pod identity, unresolved admission, interrupted batch, or failed
  preflight parks it. Process exit/relaunch always discards the authorization
  epoch, loads the durable run as `paused`, and requires **Resume queue** before
  any new create or resume call.
- **Resume queue** is a foreground click. It acquires the native runner lease,
  creates a fresh in-memory authorization epoch for the same run revision, and
  performs exact-submission lookup before status/preflight. It reuses the same
  client submission ID. It never means blind POST retry, timer retry, Pod start,
  Pod replacement, or attachment by owner/name/progress.

### Deterministic transition policy

| Observation or action | Item result | Runner result | Next remote action |
| --- | --- | --- | --- |
| Successful first create or exact replay | `active` | `running` | Poll exact batch |
| Terminal manifest with unsettled successful artifacts | `saving` | unchanged | Reconcile/download only |
| All successful receipts settled, no failures | `completed` | advance or complete | Status/preflight before successor |
| All successful receipts settled, exhausted image failures | `completed_with_failures` | advance or complete | Status/preflight before successor |
| User requests queue pause before create | `staged` | `paused` | None |
| User requests queue pause after acceptance | unchanged | `pause_after_current` | Finish/reconcile current only |
| Worker batch is paused | `active` | unchanged | Existing foreground Resume batch only |
| Worker batch is interrupted/resumable | `interrupted` | `needs_attention` | Exact foreground Resume queue/batch |
| User cancels active batch | `cancelled` after terminal reconciliation | `paused` | None until Resume queue |
| `batch_busy` from a foreign batch | `needs_attention:batch_busy` | `needs_attention` | None until Resume queue |
| `queue_stop_pending` or `gpu_stop_pending` | matching `needs_attention` code | `needs_attention` | None until Resume queue |
| Create response is lost/ambiguous | `needs_attention:submission_uncertain` | `needs_attention` | Owner lookup on Resume; POST only after 404 + idle preflight |
| Pod is offline/replaced or worker authority changes ambiguously | matching `needs_attention` code | `needs_attention` | None until Resume queue |
| Destination, disk, checksum, manifest, reference, auth, or idempotency error | matching `needs_attention` code | `needs_attention` | Explicit local repair/replace/remove only |
| Undispatched cohort row is removed | `cancelled` | unchanged | None |
| Cohort reaches only terminal states (including defensive `historical`) after reconciliation | unchanged | `completed` | Create one alarm event; never mutate Pod |

## Normative local persistence contract

The queue store is schema version 1 under the Tauri application-data directory
at the private relative root `queue/v1`; neither JavaScript nor a command input
may choose another root. It contains no credential, bearer token, Pod ID,
worker receipt body, reference source path, or raw diagnostic. It uses:

```
queue/v1/
  CURRENT                         # decimal generation + newline
  generations/<generation>.json # immutable ordered index and safe row summaries
  items/<queue-item-id>/<record-revision>.json
  references/<sha256>.<jpg|png|webp>
  alerts/<sha256-of-event-id>.json # immutable/durable notification outbox state
```

- `CURRENT`, generation records, and item records are strict UTF-8 JSON with
  unknown-field rejection. A generation has `schema_version: 1`, monotonically
  increasing JavaScript-safe-integer `store_revision`, its ordered item-record
  pointers, safe summaries, current run revision/cohort/runner state, and alarm state.
  Each item record has `schema_version: 1`, queue/submission UUIDs, state,
  trimmed local display name, ordered resolved prompts, `base_seed`, destination
  path plus native-only root identity, aspect ratio, exact `style_suffix` (`null`
  means off), and ordered reference name/MIME/size/SHA-256 metadata. It never
  embeds raw bytes or a chooser grant.
- A commit validates the entire next generation and its expected prior
  `store_revision`. It writes and fsyncs validated reference blobs first, then
  immutable item revisions, then the immutable generation, then atomically
  replaces and fsyncs `CURRENT`. A stale expected revision fails with
  `queue_revision_conflict`; mutations are serialized in Rust. The current and
  previous two valid generations are retained. Unreferenced records/blobs are
  garbage-collected only after a later successful commit, never during startup
  repair.
- Startup validates `CURRENT`; if invalid, it selects the highest valid retained
  generation and reports `queue_store_recovered` without silently dispatching.
  If no generation validates it reports blocking `queue_store_unrecoverable`
  and preserves every file until an explicit destructive **Reset local queue**
  confirmation. Reset uses the narrow native command below: it is allowed only
  while the store is unrecoverable, first atomically moves the existing
  `queue/v1` tree into a private sibling recovery quarantine, then creates an
  empty revision-zero store. It releases runner/power state and never starts,
  stops, resumes, dispatches, alerts, or deletes a Pod. If one item revision is invalid, its index summary remains as
  a placeholder with `queue_item_corrupt`, while all other valid rows load.
  Missing or mismatched copied reference blobs affect only their item with
  `queue_reference_missing` or `queue_reference_mismatch`. No startup path
  deletes, moves, or silently edits an invalid record.
  The foreground rail exposes **Remove damaged item** only for those two codes
  and `queue_destination_unavailable`: an unassigned item is removed, while an
  assigned item becomes `cancelled` under the exact native runner lease. This
  recovery never contacts the worker or mutates a Pod. Ambiguous
  `submission_uncertain` and other attention rows remain locked to their
  explicit Resume/reconciliation path.
- Queue items reuse the current reference contract exactly: at most 8 ordered
  JPEG/PNG/WebP references, at most 8 MiB each and 32 MiB total, filenames at
  most 255 UTF-8 bytes without separators/NUL, valid image decode, and at most
  64,000,000 pixels. Staging copies validated bytes into the content-addressed
  private store; removal of the user's original file therefore does not break
  the item. Every dispatch revalidates the copied SHA-256 and the destination's
  existing native chooser grant. Reference bytes never enter localStorage,
  `safePreferences`, logs, receipts, notifications, or queue JSON.
- Stable local error codes are `queue_store_recovered`,
  `queue_store_unrecoverable`, `queue_item_corrupt`,
  `queue_reference_missing`, `queue_reference_mismatch`,
  `queue_destination_unavailable`, `queue_revision_conflict`,
  `queue_runner_busy`, `queue_run_active`, `submission_uncertain`, and
  `submission_conflict`; reset additionally uses non-retryable
  `queue_reset_not_allowed` when the store is not unrecoverable. A malformed
  alert outbox projects non-retryable `queue_alert_outbox_invalid`, preserves
  the queue generation, and exposes a visible failed-notification fallback
  instead of silently discarding alert history. A corrupt worker envelope projects the public code
  `submission_store_corrupt` defined below.
  Worker admission errors retain `batch_busy`, `queue_stop_pending`, and
  `gpu_stop_pending`. UI messages are authored from codes and safe fields, not
  raw paths or server exception text.
- Queue item and placeholder names are trimmed, control-character-free strings
  of at most 120 UTF-8 bytes. `attentionCode` is a non-empty,
  control-character-free string of at most 80 UTF-8 bytes. Reference filenames
  retain their separate 255-byte limit above. Rust, TypeScript, recovered
  placeholders, and strict fixtures use these same byte limits.

## Normative worker idempotency and admission contract

- `POST /v1/batches` adds required canonical lowercase UUIDv4
  `client_submission_id` and optional `admission_mode`, whose strict values are
  `foreground` (default, preserving existing Generate behavior) and `queue`.
  First admission and an idempotent replay both return HTTP 201 with the exact
  original owner manifest and batch UUID. The durable manifest adds
  `client_submission_id`; the durable worker-only idempotency record also stores
  `owner_user_id` and `request_fingerprint`.
- `GET /v1/submissions/{client_submission_id}` is authenticated and owner-only.
  It returns HTTP 200 with the exact active or terminal manifest for its owner.
  Missing and foreign IDs both return HTTP 404 `submission_not_found` with null
  details. Owner manifests and the native owner projection include
  `client_submission_id` but never the fingerprint. Foreign `/v1/status`, busy,
  Studio, and error projections omit the ID, fingerprint, prompts, references,
  local name/destination, and any existence detail.
- Under the controller/shared-volume lease, the worker first validates the
  request and computes its fingerprint, then resolves its durable submission
  record **before** busy or Stop admission. Same ID + same authenticated
  `user_id` + same fingerprint replays the original manifest even when another
  batch currently owns the active lease. Same ID with a different owner or
  fingerprint returns generic HTTP 409 `submission_conflict`, null details, and
  creates nothing. Display name is never identity. Submission records/manifests
  are not removed by 24-hour artifact cleanup. Version 1 retains them for the
  shared-volume lifetime; any future GC must retain an indefinite conflict
  tombstone so a terminal replay can never become a new batch.
- The worker, never the client, computes
  `sha256("imageforge-batch-submission-v1\n" || canonical_json_utf8)`. Canonical
  JSON is Python `json.dumps(value, ensure_ascii=False, allow_nan=False,
  sort_keys=True, separators=(",", ":"))` encoded as UTF-8. The value contains
  exactly `owner_user_id`, `admission_mode`, ordered exact resolved `prompts`,
  `base_seed`, `aspect_ratio`, ordered references as `{name, mime_type,
  size_bytes, sha256}`, and the complete `GenerationSettings` projection
  (`model`, `revision`, `precision`, width/height, steps, guidance, JPEG quality,
  preview width/height). Reference SHA-256 values are computed from decoded
  request bytes; raw bytes and the local batch name/destination/style switch are
  excluded because their generation effect is represented by hashes/resolved
  prompts or is local-only.
- Creation uses one crash-atomic durable commit while holding the shared active
  lease. Version-2 storage writes one `manifest.json` envelope containing both
  the public manifest and private `{client_submission_id, owner_user_id,
  request_fingerprint}` record; there is no independently committed
  idempotency index. Reference blobs/directories are fsynced first, then the
  complete envelope is temp-written, file-fsynced, atomically renamed, and its
  batch/root directories fsynced. That rename is the sole admission commit
  point. The controller cannot publish `_active_batch_id`, launch inference, or
  return HTTP before it. Lookup/replay under the lease scans/validates these
  envelopes (an in-memory index is only a rebuildable cache). A crash before
  rename leaves no admitted batch and retry may safely complete a fresh
  admission; a crash after rename replays the same batch, and startup recovers
  its running manifest as `interrupted` before any new create. Incomplete dirs
  without a valid envelope are ignored but retained for maintenance. A corrupt
  version-2 envelope fails create/lookup closed as `submission_store_corrupt`
  rather than allowing a possibly duplicate admission. Legacy version-1
  manifests remain readable but have no submission association. Tests inject a
  crash after every reference/envelope fsync, rename, active-memory assignment,
  runner launch, and response boundary.
- Public `submission_store_corrupt` is HTTP 503 with fixed message `Worker
  submission history is unavailable. Repair the shared volume before starting
  generation.`, null details, and no owner/key/path/exception disclosure. While
  any version-2 envelope is corrupt, `/v1/status.permissions.can_create` is
  false and the strict `permissions.create_block_reason` is
  `submission_store_corrupt` (a shared Stop finalization instead uses
  `gpu_stop_pending`); every new POST or submission lookup returns that same envelope;
  valid owner batch reads remain available. Despite its transport status, the
  desktop classifies this code as non-retryable, parks the item/runner in
  `needs_attention`, and never retries on a timer. Only explicit shared-volume
  repair plus foreground **Resume queue** may reattempt. The strict error shape,
  HTTP mapping, and client retry override are binding in
  `docs/API_CONTRACT.md`, Python, Rust, and TypeScript schemas.
  All worker errors use exact top-level keys `schema_version,error` and exact
  nested keys `code,message,details`; `details` is always present and is either
  a bounded object or null, and unknown/omitted fields fail native validation.
- For `admission_mode: foreground`, a valid new Generate keeps the binding Task
  012 behavior: pending/approved Stop consent is atomically cancelled with
  `generation_started`; `finalizing` returns `gpu_stop_pending`. For
  `admission_mode: queue`, the same controller lock first replays any valid
  existing submission, but a new admission encountering any pending or approved
  Stop returns HTTP 423 `queue_stop_pending` with safe request ID, requester,
  state, and expiry and does not cancel it. `finalizing` still returns
  `gpu_stop_pending`. This atomic rule covers a Stop created after desktop
  preflight but before POST.

## Normative prompt snapshot rules

- Staging uses the existing parser exactly: strip one BOM, parse the supported
  first CSV prompt/description/image-prompt/scene column, trim each non-empty
  row, collapse its Unicode/ASCII whitespace runs to one ASCII space, preserve
  order and duplicates, and reject the existing validation errors.
- If the style switch is on, its trimmed non-empty text is stored verbatim as
  `style_suffix` and one ASCII space plus that suffix is appended to every
  normalized prompt. If off or trimmed empty, `style_suffix` is null and the
  normalized prompt is unchanged. The persisted resolved prompts are exactly
  what the worker receives.
- `base_seed` is the first parsed draft prompt's existing deterministic seed.
  Worker/image seed at zero-based index `i` is `base_seed + i`; all values must
  be JavaScript-safe integers in `0..=9,007,199,254,740,991`, and
  `base_seed + prompts.length - 1` cannot exceed that same bound in TypeScript,
  Rust, Python, persistence, or fingerprint vectors. Aspect ratio is exactly
  one of `16:9`, `1:1`, `9:16`, `4:3`, or `3:4`. Editing/restoring/re-adding
  never reuses either UUID.

## Normative alarm event contract

- Each run revision stores one alarm record with states `disarmed`, `armed`,
  `ringing`, `snoozed`, or `acknowledged`. Its event ID is
  `queue-complete:<run-revision>`. Arming requires a foreground user gesture,
  a successfully started Web Audio test tone, and an explicit **I heard it —
  arm alarm** confirmation. The UI separately reports OS notification
  permission and never infers audible system volume. A failed/blocked test stays
  `disarmed` and shows how to retry.
- The scheduler reaches one completion fixed point only after every cohort item
  is `completed`, `completed_with_failures`, explicitly `cancelled`, or
  defensively `historical`, and all successful local artifacts/receipts are
  settled. It creates the event record exactly once. If `armed`, it atomically
  changes to `ringing`; if `disarmed`, it stays quiet and shows the persistent
  completion card. Empty cohorts, worker idle, intermediate saving, or
  unassigned **Next run** rows do not qualify. `kind` is `complete` only when no
  item failed/cancelled; otherwise it is `attention`.
- The in-app alarm repeats while the open Web Audio context is usable until
  snoozed or dismissed. After relaunch an unacknowledged event remains visibly
  `ringing`, but audio never auto-starts; **Ring now** is the required user
  gesture. The native notification uses one stable signed-31-bit ID derived
  from the first four bytes of SHA-256(event ID), with zero mapped to one, so a
  retry replaces the same OS notification. It uses only fixed privacy-safe copy:
  `ImageForge queue complete` / `All staged batches finished. The GPU is still
  running.` or `ImageForge queue finished with attention needed` / `All staged
  batches finished, but some images need review. The GPU is still running.`
- Notification delivery is a native durable outbox keyed by event ID. Relaunch
  after completion but before a recorded delivery retries the same stable ID;
  a recorded delivery is not sent again. Permission denial records a visible
  fallback, not a false delivery. The same rule applies to the one snooze
  reminder with a second stable ID derived from `<event-id>:snooze`.
- `failed` is not a delivery receipt. The open process attempts each pending or
  failed primary/snooze key at most once, so there is no timer retry loop; a
  relaunch may retry the same stable key once, and explicit **Ring now** may
  retry a failed or permission-denied key after a user gesture. A later success
  may advance `failed`/`permission_denied` to `delivered`; `delivered` is
  terminal. Native delivery is valid only while the matching alarm is
  `ringing`; acknowledged, disarmed, armed, and not-yet-due snoozed events are
  rejected before outbox mutation, notification, or sound.
- **Snooze 15 minutes** is available once. It stops/cleans audio and timers,
  persists one RFC3339-millisecond due time, then reuses the same event at/after
  due. If the app is closed, relaunch processes the due outbox once and shows
  **Ring now**. After this one re-alert it remains `ringing` until dismissed and
  offers no second snooze. **Dismiss alarm** persists `acknowledged` and cleans
  every audio node/timer. For a quiet disarmed run, **Acknowledge completion**
  makes the same persisted transition without implying that sound fired.
  **Stop GPU…** only opens the existing exact-Pod
  confirmation/peer-consent flow; no alarm state calls DELETE or changes a
  worker batch. A later run has a new revision/event and cannot replay an old
  acknowledged event.

## Native command and capability boundary

The renderer may call only these strict queue-specific commands (camelCase on
the TypeScript side, snake_case over `invoke`):

```text
queue_load() -> NativeQueueSnapshotV1
queue_reset({ input: NativeQueueResetV1 }) -> NativeQueueSnapshotV1
queue_commit({ input: NativeQueueCommitV1 }) -> NativeQueueSnapshotV1
queue_prepare_dispatch({ input: NativeQueueItemKey }) -> NativeQueueDispatchPayloadV1
queue_acquire_runner({ input: NativeRunKey }) -> NativeRunnerLease
queue_release_runner({ input: NativeRunKey }) -> NativeRunnerLease
queue_set_sleep_prevention({ input: NativePowerInput }) -> NativePowerState
queue_signal_alert({ input: NativeAlertInput }) -> NativeAlertResult
```

All wire objects use the camelCase keys below, reject unknown fields, and use
the existing strict native error envelope `{ code: string, message: string,
retryable: boolean }`. `storeRevision`, `recordRevision`, prompt seeds, byte
sizes, counts, and notification IDs are non-negative JavaScript-safe integers;
UUID and timestamp fields use canonical lowercase UUIDv4 and RFC3339
milliseconds respectively.

```ts
type QueueItemState =
  | 'staged' | 'dispatching' | 'active' | 'saving'
  | 'completed' | 'completed_with_failures' | 'needs_attention'
  | 'interrupted' | 'cancelled' | 'historical';
type QueueRunnerState =
  | 'idle' | 'running' | 'pause_after_current'
  | 'paused' | 'needs_attention' | 'completed';
type QueueAlarmState = 'disarmed' | 'armed' | 'ringing' | 'snoozed' | 'acknowledged';
type QueueAlertKind = 'complete' | 'attention' | 'snooze';

interface NativeQueueIssue {
  code: string;                    // one stable AC-3 code
  queueItemId: string | null;
  retryable: boolean;
}
interface NativeQueueResetV1 {
  confirmation: 'RESET LOCAL QUEUE';
}
interface NativeQueueReferenceV1 {
  id: string;                      // canonical UUIDv4
  name: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  sizeBytes: number;
  sha256: string;                  // lowercase 64-hex
}
interface NativeQueueItemV1 {
  schemaVersion: 1;
  queueItemId: string;
  clientSubmissionId: string;
  recordRevision: number;
  runRevision: string | null;
  remoteBatchId: string | null;
  state: QueueItemState;
  attentionCode: string | null;
  name: string;
  prompts: string[];               // exact resolved worker prompts
  baseSeed: number;
  destination: string;             // native-owned identity remains private
  aspectRatio: '16:9' | '1:1' | '9:16' | '4:3' | '3:4';
  styleSuffix: string | null;
  references: NativeQueueReferenceV1[];
  createdAt: string;
  updatedAt: string;
}
interface NativeQueueItemPlaceholderV1 {
  schemaVersion: 1;
  queueItemId: string;
  recordRevision: number;
  state: 'needs_attention';
  attentionCode: 'queue_item_corrupt';
  name: string;
  promptCount: number;
  referenceCount: number;
  createdAt: string;
  updatedAt: string;
}
interface NativeQueueRunV1 {
  runRevision: string;
  cohortItemIds: string[];
  runnerState: QueueRunnerState;
  authorizationRequired: boolean;
  keepAwake: boolean;
}
interface NativeQueueAlarmV1 {
  eventId: string;
  runRevision: string;
  state: QueueAlarmState;
  kind: 'complete' | 'attention' | null;
  snoozeUsed: boolean;
  snoozeDueAt: string | null;
  notificationDisposition:
    | 'pending' | 'delivered' | 'permission_denied' | 'failed' | null;
  snoozeNotificationDisposition:
    | 'pending' | 'delivered' | 'permission_denied' | 'failed' | null;
}
interface NativeQueueDocumentV1 {
  schemaVersion: 1;
  items: Array<NativeQueueItemV1 | NativeQueueItemPlaceholderV1>;
  run: NativeQueueRunV1 | null;
  alarm: NativeQueueAlarmV1 | null;
}
interface NativeQueueSnapshotV1 {
  schemaVersion: 1;
  storeRevision: number;
  document: NativeQueueDocumentV1;
  issues: NativeQueueIssue[];
}
interface NativeReferenceBlobV1 {
  sha256: string;
  mimeType: NativeQueueReferenceV1['mimeType'];
  sizeBytes: number;
  bytes: number[];
}
interface NativeQueueCommitV1 {
  expectedRevision: number;
  document: NativeQueueDocumentV1;
  referenceBlobs: NativeReferenceBlobV1[];
}
interface NativeQueueItemKey {
  queueItemId: string;
  clientSubmissionId: string;
  purpose: 'edit' | 'dispatch';
}
interface NativeQueueDispatchPayloadV1 {
  queueItemId: string;
  clientSubmissionId: string;
  name: string;
  prompts: string[];
  baseSeed: number;
  destination: string;
  aspectRatio: NativeQueueItemV1['aspectRatio'];
  references: Array<NativeQueueReferenceV1 & { bytes: number[] }>;
}
interface NativeRunKey { runRevision: string }
interface NativeRunnerLease { runRevision: string; held: boolean }
interface NativePowerInput extends NativeRunKey { enabled: boolean }
interface NativePowerState {
  runRevision: string | null;
  active: boolean;
  platform: 'macos' | 'windows';
  displaySleepAllowed: true;
}
interface NativeAlertInput { eventId: string; kind: QueueAlertKind }
interface NativeAlertResult {
  eventId: string;
  notificationId: number;
  disposition: 'delivered' | 'already_delivered' | 'permission_denied' | 'failed';
}
```

`queue_commit` accepts raw bytes only in bounded validated `referenceBlobs` and
never returns them. `queue_prepare_dispatch` is the sole read path for copied
reference bytes; it returns one exact staged item only after revalidating its
item and submission IDs, blob hashes/images, and native destination identity.
`purpose: 'dispatch'` additionally requires the exact current running run and
held native runner lease. `purpose: 'edit'` permits an unassigned staged item;
an assigned cohort item still requires its exact held runner lease. Unknown
purposes and every non-staged row fail closed. This purpose field is the narrow
contract repair that preserves staged-row editing without weakening dispatch
authorization. The command never accepts a path as input. `destination` is the
native-normalized local
path already visible in Create; it is returned only in the queue snapshot and
one-item dispatch payload for local UI/receipt projection, and is never sent to
the worker, notification, log, or diagnostic. No chooser grant or filesystem
root identity crosses the wire. When a new item is committed, `destination`
must equal the currently native-bound, chooser-authorized path, and Rust copies
that root's filesystem identity into the private item record; later commits
preserve it and dispatch rechecks it. A corrupt placeholder may only be carried
forward byte-for-byte or removed by explicit repair/reset; the renderer cannot
synthesize one.
`queue_acquire_runner` holds one process/OS file lease until a
matching release or process exit; a second process receives
`queue_runner_busy`. Power acquire is valid only for that lease/revision.
`queue_signal_alert` selects fixed copy/IDs itself and exposes no arbitrary
title/body/sound/path. The `snooze` fixed copy is `ImageForge queue reminder` /
`Your completed queue is still waiting. The GPU may still be running.` Its
`eventId` must match `queue-complete:<canonical-lowercase-UUIDv4>` exactly;
every other shape is rejected as `queue_alert_event_invalid`.
The Tauri notification plugin is initialized in Rust; renderer capabilities are
limited to `notification:allow-is-permission-granted` and
`notification:allow-request-permission`. `notification:allow-notify`, generic
filesystem, shell, arbitrary URL, arbitrary sound, and generic power control are
not granted. These are the only non-queue command exceptions: the first returns
`Promise<boolean>` and the second returns exactly `Promise<'granted' | 'denied'
| 'prompt' | 'prompt-with-rationale'>`; only `queue_signal_alert` may send.

## Acceptance criteria

- AC-1: ImageForge exposes the ordered device-local queue and exact state
  machines above. Every undispatched row is visibly labelled **Staged on this
  device — not reserved on the GPU**. **Run queue** and **Resume queue** follow
  the bounded authorization lifetime above; neither starts or reserves a Pod.
- AC-2: A valid draft can be staged while the Pod is offline, ready, or occupied
  by a batch. The immutable snapshot and its edit/move/remove locks follow the
  normative prompt/run rules. Dispatching, active, saving, and historical rows
  cannot be reordered, edited, or individually removed.
- AC-3: Queue/reference state follows the exact version-1 native store, atomic
  commit order, last-known-good repair, limits, validation, isolation, and
  stable error codes above. Valid rows survive another row's corruption.
- AC-4: Desktop, Rust, Python, and `docs/API_CONTRACT.md` implement the exact
  idempotency request/response/lookup/fingerprint/projection/retention contract
  and crash-atomic commit/recovery rule above. No ambiguous create can produce
  or attach to a second remote batch.
- AC-5: Queue admission is serialized through one production coordinator.
  Before the first item and every successor, ImageForge completes an
  authoritative exact-Pod/worker preflight. A successor is not submitted until
  the prior manifest is terminal and every successful artifact reaches the
  existing receipt/download fixed point. `RUNTIME_BATCH_IDLE` alone is never an
  advancement signal.
- AC-6: Startup, relaunch, wake, reconnect, and response-loss behavior follows
  the exact authorization lifetime, lookup-first recovery, native runner lease,
  and transition table above. `SYNC_RUNTIME_BUSY` cannot overwrite or discard
  local queue/run state. Relaunch never begins new billed work by itself.
- AC-7: `batch_busy`, both Stop guards, simultaneous clicks, overlapping
  polls/control, two processes, and two clients obey the exact admission modes
  and transition table. A queue runner never cancels peer Stop consent, attaches
  by safe summary, retries on a timer, or creates twice.
- AC-8: Exhausted per-image retries become `completed_with_failures` only after
  successful artifacts settle, then the authorized runner continues. Every
  structural failure parks with one actionable code. No unsafe case is skipped
  and no unbounded retry loop is added.
- AC-9: **Pause after current batch** is distinct from existing **Pause after
  frame**. Active cancel and explicit Stop GPU pre-pause follow the transition
  table. Before Stop confirmation, dispatch is durably paused and the dialog
  names remaining local staged batches. Denial, timeout, ambiguous DELETE,
  alarm actions, app exit, and completion never resume the queue or stop a Pod.
- AC-10: Queue runs offer an explicit opt-in **Keep this computer awake while
  the queue runs** control. macOS uses a scoped IOPM no-idle-system-sleep
  assertion; Windows owns one `PowerCreateRequest` handle with
  `PowerSetRequest(PowerRequestSystemRequired)` and releases it with
  `PowerClearRequest`/`CloseHandle`. The display may sleep. Manual sleep/lid/
  low-power/thermal policy wins. Visible state and cleanup occur on pause,
  completion, attention/error, disable, lease loss, failed acquire, and app/
  process exit.
- AC-11: Alarm arming, test, fixed-point event creation, durable notification
  outbox, foreground/minimized/relaunch fallback, exact fixed copy, and
  exact-once-per-run semantics match the normative alarm contract. There is no
  empty/intermediate alarm and no false **Alarm armed** claim.
- AC-12: Dismiss, one 15-minute snooze, **Ring now**, and **Stop GPU…** match the
  normative event lifecycle. Every path cleans audio/timers and only the
  separate Stop workflow may call the provider. **Clear completed from queue**
  is a distinct post-fixed-point history action and alarm Dismiss never changes
  item state.
- AC-13: The minimal queue UI appears only when useful. Create retains its
  two-column hierarchy and gains a compact full-width queue rail with run total,
  active/staged/attention rows, prompt/reference counts, order controls, and one
  primary runner action. Progress retains the single active batch and adds
  `Batch N of M` plus the next item summary. No decorative metric, fake
  reservation, dead drag handle, or expanded prompt list per staged row ships.
- AC-14: Queue/alarm controls are keyboard operable with semantic buttons/list,
  native progress, focus-managed dialogs, non-audio status, polite live regions,
  assertive attention only, strong contrast, and reduced motion. At 1280×720,
  1440×900, and 1920×1080 there is no page horizontal overflow or clipped
  action. With 450 queue rows, at most 40 queue-row elements are mounted; with
  450 active prompts, at most 30 prompt-row elements are mounted. A production
  installed-app benchmark over 30 keyboard move/select operations records p95
  input-to-next-paint under 100 ms on each release runner.
- AC-15: macOS and Windows share React scheduler semantics and expose only the
  exact native commands/capabilities above. Rust/TS schemas reject unknown
  fields and unsupported platform operations; every acquire has bounded,
  idempotent cleanup. Reset rejects any other confirmation, rejects a healthy
  or recoverable store as `queue_reset_not_allowed`, and returns an empty
  revision-zero snapshot only after the prior tree is quarantined.
- AC-16: Deterministic tests cover distinct UUIDs; canonical prompts/seeds/style;
  locks/replacement/cohorts; every transition; atomic persistence and all crash
  seams; per-entry corruption; missing/tampered references; response loss,
  idempotent replay/conflict/foreign lookup/restart; receipt gating; partial
  continuation; Stop/create/process races; alarm/outbox/relaunch/snooze/audio;
  keep-awake cleanup; DOM bounds; and zero automatic Pod mutation.
- AC-17: Before publication the final beta is independently reviewed and
  versioned once. Immutable worker image build/push and recorded digest are a
  hard gate, as are native macOS Apple-silicon and Windows-x64 build,
  install/launch, foreground/minimized three-batch fake smoke, and public asset
  re-download/SHA-256 verification. If Actions billing or any digest/asset gate
  blocks, source may be pushed with the blocker recorded but the task/release is
  not claimed complete. Record commit, tag, workflows, hashes, signing/
  notarization or unsigned state, and zero-unintended-Pod audit.
- AC-18: In the same implementation change, `docs/API_CONTRACT.md` carries the
  exact submission lookup/fingerprint/admission-mode/error/projection protocol;
  `docs/ARCHITECTURE.md` carries the native journal, runner lease, local-only
  scheduler, and alarm/power boundaries; and `docs/PRODUCT_SPEC.md` explicitly
  records this task's narrow supersession. Every older statement that forbids a
  waiting queue remains binding for the worker/remote lease and is rewritten or
  cross-referenced so it cannot be read as forbidding this local staging queue.
  The checked-in Rust and TypeScript types above must remain field-for-field
  identical; a contract test rejects schema drift.

## Non-goals

- NG-1: Do not add a worker-side waiting queue, second active batch, parallel
  generation, another GPU/model, or a shared cross-device local-queue service.
- NG-2: Do not start, recreate, or terminate a Pod from staging, scheduling,
  completion, alarms, timers, notifications, relaunch, or power events. Start
  GPU and Stop GPU remain explicit foreground actions.
- NG-3: Do not run a detached background service after ImageForge exits. The UI
  explains that the app must stay open; a cloud batch may continue while the
  client is closed/asleep, but downloads, successor dispatch, and audio wait for
  status-first foreground recovery.
- NG-4: Do not add per-prompt queues, prompt rewriting, new model controls,
  automatic retries beyond bounded worker policy, or unrelated redesigns of
  Library, Usage, setup, GPU ranking, or Studio consent.
- NG-5: Do not expose queue contents or alert details on another user's client,
  notification lock screen, logs, diagnostics, URLs, screenshots, worker busy
  responses, or public API status.

## Relevant files

- `src/domain/types.ts`, `src/domain/reducer.ts`, `src/domain/queue.ts`: typed
  queue/run/alarm states, immutable snapshots, selectors, and transitions.
- `src/adapters/queueStore.ts`, `src/adapters/queueScheduler.ts`,
  `src/adapters/queueAlarm.ts`: validated native facade, serialized dispatcher,
  Web Audio lifecycle, and deterministic fakes.
- `src/adapters/workerBatchCoordinator.ts`, `workerContracts.ts`,
  `productionImageForgeAdapter.ts`: admission mode, exact-submission lookup,
  receipt fixed point, and control ordering.
- `src/App.tsx`, `src/screens/CreateScreen.tsx`,
  `src/screens/ProgressScreen.tsx`, `src/components/QueueRail.tsx`,
  `src/components/QueueAlarm.tsx`, `src/styles.css`: orchestration and authored
  queue/alarm UI.
- `src/native/tauriBridge.ts`, `src/native/productionPort.ts`,
  `src-tauri/src/native/queue.rs`, `src-tauri/src/native/power.rs`,
  `src-tauri/src/lib.rs`, Cargo/config/capability files: narrow native store,
  runner/power lease, fixed notification outbox, and renderer projections.
- `worker/src/imageforge_worker/domain.py`, `controller.py`, `persistence.py`,
  `coordination.py`, `app.py`: durable submission idempotency and queue-specific
  Stop admission without a waiting queue.
- Adjacent Vitest, pytest, Rust, native-smoke, two-client, performance fixtures;
  `docs/API_CONTRACT.md`, `ARCHITECTURE.md`, `PRODUCT_SPEC.md`, design, onboarding,
  operations, QA, release documentation, and version metadata.

## Automated tests

- AC-1/2/13/14: reducer/component tests stage, replace, move, remove, lock,
  cohort, render, announce, keyboard-operate, and enforce 40/30 DOM caps.
- AC-3/15: Rust/native tests reject unknown fields, traversal, links, size/image
  limits, corrupt pointers/items, hash mismatch, stale revisions, unsafe alert
  payloads, runner contention, and power misuse; each crash seam retains the
  prior or complete next generation.
- AC-4: worker pytest plus Rust/TypeScript contract tests prove canonical-ID
  validation, fingerprint vectors, first/replay 201 equality, mismatch/foreign
  conflict, owner-only 404 lookup, restart persistence, retention, and strict
  foreign omission while the one active lease remains unchanged.
- AC-5/6/7: scheduler/runtime tests defer through receipts, serialize poll/
  create/control, recover each persisted state, and cover response loss,
  `batch_busy`, pending/approved/finalizing Stop races, Pod replacement, worker
  epoch changes, relaunch authorization loss, and simultaneous local runners.
- AC-8/9: tests cover partial-success continuation and every structural pause,
  active cancel, queue/active pause, Stop pre-pause, denial, timeout, ambiguous
  provider response, and explicit-only lifecycle mutation counts.
- AC-10: macOS/Windows backend unit tests and installed smoke prove one scoped
  no-idle-sleep assertion, display sleep allowed, repeated acquire/release
  idempotency, OS override, and cleanup on every terminal/error/exit path.
- AC-11/12: fake clock/audio/outbox tests prove gesture/test/confirmation,
  fixed-point event creation, stable IDs and retry, permission denial, no empty
  alert, relaunch fallback, one snooze, dismiss cleanup, old-event isolation,
  and Stop action routing only to existing confirmation.
- AC-16/17: run targeted suites first, then root Vitest, RunPod-client Vitest,
  Python 3.11 pytest/ruff/compile, Rust fmt/clippy/test, typecheck, production
  build, diff check, installed native smokes, publication, and asset hash check.

## Manual verification

1. [AC-1/2/13] Stage five batches, including duplicate names, references, and
   different aspect ratios; verify IDs, exact snapshots, local/not-reserved and
   Next-run labels, edit replacement, keyboard order/removal, locks, and minimal
   empty/non-empty layouts.
2. [AC-3/6/15] Quit/relaunch between every state; corrupt CURRENT, one retained
   generation, one item, and one copied reference in fixtures; revoke/replace a
   destination. Verify deterministic recovery/codes, valid-row survival, no
   pre-reconciliation create, and no raw path/secret output.
3. [AC-4/5] Lose a create response after admission, restart worker/client, and
   Resume. Verify lookup finds the original UUID/manifest, no duplicate exists,
   wrong owner/fingerprint stays generic, and a successor waits for all prior
   successful JPEG receipts.
4. [AC-7/9] Race two clients, pending/approved/finalizing Stop, foreground
   Generate, queue pause/cancel, and two local processes. Verify foreground
   Generate preserves Task 012, queue admission returns `queue_stop_pending`,
   one create/DELETE occurs at most, and staged rows remain.
5. [AC-8] Inject exhausted image retries, auth, disk-full/checksum, offline,
   interruption, busy, and Stop guard. Verify only settled image failures
   advance; all structural failures park with one code and no timer retry.
6. [AC-10] Run keep-awake on/off on macOS and Windows; let the display sleep,
   minimize, exercise manual sleep/lid/wake, then pause, fail, complete, disable,
   and exit. Verify visible native assertion state, cleanup, and status-first
   wake recovery without Pod mutation.
7. [AC-11/12] Test/confirm/arm, run complete and attention fake cohorts in
   foreground/minimized states, deny notifications, mute audio, relaunch before
   and after outbox delivery, dismiss, and snooze across relaunch. Verify fixed
   copy, one event/one snooze, visible Ring-now fallback, cleanup, and separate
   confirmed Stop flow.
8. [AC-14/16] Use keyboard, VoiceOver, Narrator/high contrast, reduced motion,
   450 queue rows, 450 active prompts, and all three viewports. Capture mounted
   row counts, p95 next-paint measurements, focus/labels/live-region behavior,
   contrast, and overflow dimensions.
9. [AC-17] Install clean macOS/Windows artifacts, complete a three-batch fake
   minimized smoke with saved folders/alarm, re-download public assets, compare
   hashes, and record signing plus zero unintended live Pods.

## Evidence required

- File/line-linked independent review against every criterion and non-goal,
  including both repair rounds and dispositions.
- Primary research links and a short decision record for local-only semantics,
  worker-computed idempotency, journaled native persistence, alarm/audio/
  notification fallbacks, and explicit keep-awake scope.
- Targeted/full output, test counts, corruption/crash/fingerprint fixtures,
  POST/DELETE counts, rendered screenshots at each viewport, accessibility,
  minimized/background and p95 observations, and explicit skipped/paid stages.
- Release commit/tag/workflow URL, worker digest, artifact names/SHA-256,
  install/launch smoke, signing/notarization or unsigned disclosure, public
  re-download hashes, and final RunPod active-Pod audit.
