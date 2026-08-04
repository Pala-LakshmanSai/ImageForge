# Task 014 — Live approved-GPU selector and coordinated in-session switch

## Problem

ImageForge currently chooses an approved GPU only when the editor explicitly
presses **Start GPU**. Lakshman and Sujal need a compact live selector that shows
the compatible EU-RO-1 Secure inventory, price, availability, and honest
measured speed evidence. They also need to replace the current GPU without
discarding an accepted batch or letting two Pods write the shared network
volume at once.

This cannot be implemented as a cosmetic picker or as an in-place Pod update.
RunPod's Pod update API does not accept a GPU type, a Pod with a network volume
cannot be stopped and later resumed, and a network volume is attached at Pod
creation. RunPod also warns that concurrent writers to one network volume can
corrupt data. The binding provider references are:

- [Manage Pods](https://docs.runpod.io/pods/manage-pods): network-volume Pods
  are terminated rather than stopped.
- [Network volumes](https://docs.runpod.io/storage/network-volumes): a network
  volume is selected during deployment, cannot be attached or detached later,
  and simultaneous writers can corrupt data.
- [Create Pod](https://docs.runpod.io/api-reference/pods/POST/pods): creation
  accepts exact `gpuTypeIds`, one GPU, template, volume, and custom priority.
- [Update Pod](https://docs.runpod.io/api-reference/pods/POST/pods/podId/update):
  the update shape has no GPU-type replacement operation.
- [Get Pod](https://docs.runpod.io/api-reference/pods/GET/pods/podId) and
  [Delete Pod](https://docs.runpod.io/api-reference/pods/DELETE/pods/podId):
  exact-Pod reconciliation and termination boundaries.
- [GPU availability](https://docs.runpod.io/sdks/graphql/manage-pods): live
  inventory is an observation, not a capacity reservation.

The safe operation is therefore an explicit, durable, coordinated transaction:
finish and persist the current image, pause the exact batch, permanently delete
the exact old Pod, prove it absent, create one exact selected replacement on the
same profile and volume, verify the replacement, and leave both batch and local
queue paused for an explicit Resume.

This task narrowly supersedes `tasks/003-runpod-control.md` only by adding an
exact manual target beside ordinary ordered **Auto best value** Start. It
preserves `tasks/012-authoritative-studio-sync-and-coordinated-stop.md`: normal
**Stop GPU** still vetoes every active running, paused, or resumable interrupted
batch and retains its existing consent/finalization rules. Switch has a separate
worker request and guard because it preserves that batch. It narrowly
supersedes `tasks/013-local-sequential-batch-queue-and-completion-alarm.md` NG-2
only after one explicit foreground **Switch GPU** or **Resume switch** click;
queue dispatch, alarms, timers, wake, relaunch, and background observation still
cannot create or terminate a Pod.

## Binding terminology and policy

- **Policy-approved inventory** means the live RunPod catalog intersection with
  the existing ImageForge studio profile: one NVIDIA GPU, Secure Cloud,
  `EU-RO-1`, compatible with the configured network volume and CUDA/image
  contract, and one of the ordinary approved policies: RTX 4090, RTX PRO 4500
  Blackwell, RTX 5090, RTX PRO 4000 Blackwell, L4, RTX A4500, or RTX 4000 Ada.
  RTX 2000 Ada is visible only when the existing emergency opt-in is enabled and
  is labelled **Slow emergency option**. A dynamic Blackwell catalog ID is
  selectable only after the existing exact-name, memory, manufacturer, and live
  catalog policy validator approves that exact ID. No display label may be
  converted into an invented GPU ID.
- **All GPUs** in this feature means all currently returned policy-approved
  offers above, including unavailable rows for explanation. It does not mean
  the global RunPod catalog. B200, RTX PRO 6000 variants, A40/A6000, L40/L40S,
  Community Cloud, interruptible, multi-GPU, another datacenter, an unknown
  dynamic ID, and every other unapproved offer remain excluded even when cheap
  or available.
- **Auto best value** keeps the existing ordinary Start behavior: one explicit
  offline Start uses the approved ordered fallback list. **Start selected GPU**
  is an offline manual Start with a singleton `gpuTypeIds` list. **Switch GPU**
  is available only when one exact managed current Pod exists and requires a
  singleton target different from the current GPU. Auto/fallback is never a
  Switch target.
- Switch is enabled only when that one Pod has a reachable authenticated Studio
  worker and no duplicate/create ambiguity. Provisioning, booting, loading,
  warming, reconnecting, stopping, error, replaced, unverified, and duplicate-
  Pod states are read-only in the picker. A terminal manifest with unsettled
  local receipts/downloads must first reach the existing local fixed point; a
  worker-idle projection cannot interrupt device saving.
- A **switch ID**, **replacement attempt ID**, **worker principal-binding ID**,
  **finalization ID**, inventory **observation ID**, inventory **receipt ID**,
  and native process-epoch ID are distinct canonical lowercase UUIDv4 strings.
  Rust native generates switch, attempt, finalization, observation, receipt,
  process-epoch, and private mutation-grant IDs with the operating-system CSPRNG;
  the authenticated worker generates the principal-binding ID with its CSPRNG.
  Renderer input can reference an ID already returned in a safe projection but
  can never propose, replace, or generate any of them. The switch ID binds the
  old Pod, preserved worker batch, immutable authenticated principal binding,
  and entire recovery transaction. One attempt ID binds one exact POST body and
  target. Names, timestamps, GPU labels, array indices, and Pod names are never
  identities.
- A **replacement attempt revision** is a JavaScript-safe integer beginning at
  1. It increases by exactly one with a fresh attempt UUID for every later POST,
  including retrying the same target. Another attempt is allowed only after
  read-only reconciliation proves the prior POST created no matching Pod. A
  timeout, transport loss, invalid success body, or multiple matches is not such
  proof.
- `JS_SAFE_REVISION_V1` is the closed numeric-revision rule for every new IPC,
  provider marker, worker object, native generation, and event in this task.
  A revision is a finite JSON integer token with no sign, fraction, exponent,
  leading zero (except the token `0`), or binary-float coercion, and is at most
  `Number.MAX_SAFE_INTEGER` (`9_007_199_254_740_991`). `storeRevision`,
  `expectedStoreRevision`, `queueExpectedStoreRevision`, and lifecycle store
  revisions initialize to 0 and then increase by exactly one. `recordRevision`,
  `expectedRecordRevision`, replacement-attempt revisions, worker marker/
  lookup attempt revisions, and inventory `eventSequence` initialize to 1 and
  increase by exactly one. Nullable attempt revisions are either null or in the
  positive form. `create_contract_revision`/`schemaVersion` constants remain
  literal 1, not counters. Rust, TypeScript, and Python reject a skipped,
  decreased, negative, fractional, exponent, unsafe, or wrong-initial value.
  Before any `+1`, native checks the bound. Switch exhaustion returns
  non-retryable `gpu_switch_revision_exhausted`; ordinary Start exhaustion
  returns non-retryable `gpu_start_revision_exhausted`. Both preserve bytes and
  perform no worker or provider mutation. No counter wraps, saturates, parses
  through a floating point value, or resets after history cleanup/relaunch.
  The sole resettable exception is the read-only Pod-observation
  `lifecycleRevision` defined below: it is process-epoch/profile scoped, resets
  with a new process epoch or exact profile rebind, and never aliases or resets
  a durable Start/Switch/queue/worker/native-history counter.
- A **switch authorization epoch** is process-local and begins only with an
  explicit foreground Switch/Resume-switch click, a consumed exact native
  foreground grant, and the exact native switch lease. It may continue while
  that same process is minimized or backgrounded.
  OS suspend stops progress; wake requires the exact read-only recovery sequence
  below. Exit, crash, renderer replacement, native lease loss, or relaunch
  destroys authorization. Durable state is evidence, never authorization.
- **Old Pod absent** means the exact old Pod ID returns authoritative 404 and a
  fresh profile-scoped Pod list contains no same-ID record. A list omission
  alone is insufficient because RunPod discovery is eventually consistent.
- **Replacement verified** means one exact replacement Pod ID matches the
  immutable ImageForge template, image digest, volume ID/mount, Secure lane,
  EU-RO-1, one non-interruptible GPU, exact attempt target, port 8000, and
  request/attempt marker; the worker reports the same runtime Pod, volume,
  datacenter, image digest, model revision, and preserved switch marker.

### Shared GPU identity and migration

`IMAGEFORGE_GPU_IDENTITY_V1` is the single validator for provider catalog IDs,
provider and UI display names, current/replacement Pod projections, native
journals, worker requests/markers/runtime identity, benchmark evidence, and
fingerprint objects:

```text
^[A-Za-z0-9](?:[A-Za-z0-9 ._()+:-]{0,126}[A-Za-z0-9])?$
```

The UTF-8 byte length is 1–128, the accepted alphabet is ASCII only, and the
value must already be in its transmitted form. No trimming, Unicode
normalization, case folding, whitespace collapsing, truncation, slash,
backslash, tab, newline, NUL, or marketing-name-to-ID inference is permitted.
GPU IDs and display names intentionally use the same rule and cap. A checked-in
`gpu-identity/v1` schema and the same golden vectors are authoritative in Rust,
TypeScript, and Python.

On migration, an existing catalog/current-Pod/Start marker/Stop marker/Switch
record/benchmark value that already validates is retained byte-for-byte. An
invalid stored value is never repaired or reinterpreted: the enclosing record
becomes read-only `gpu_identity_invalid`, provider mutation and generation are
disabled, and explicit operator repair is required. An invalid live non-current
catalog row is excluded. An invalid or no-longer-approved current Pod is the
only unapproved row that may remain visible: it is pinned as **Current — not an
approved target**, read-only, and can only be stopped through the existing safe
Stop path or replaced by an independently valid approved target. A dynamic GPU
ID also needs an exact checked-in runtime-identity mapping before Start/Switch;
catalog-name policy approval alone is insufficient.

The implementation must replace—not layer beside—the existing validators at
`src-tauri/src/native/runpod.rs::safe_gpu_identifier`,
`src-tauri/src/native/worker.rs::validate_gpu_display_name`,
`packages/runpod-client/src/gpu-policy.ts` catalog/managed approval (and every
`real-provider.ts` raw GPU ID/display parse),
`worker/src/imageforge_worker/coordination.py::GPU_DISPLAY_PATTERN`, and
`worker/src/imageforge_worker/persistence.py::_GPU_DISPLAY_PATTERN`. Task 012
Stop request/guard display names migrate to this same rule; there is no 80-byte
legacy exception. A repository gate fails if another GPU ID/display regex or a
191/80-byte cap remains in Rust, TypeScript, or worker code.

One checked-in language-neutral vector file is consumed unchanged by Rust,
Vitest, and pytest. Required accepted vectors include `A`, `NVIDIA L4`,
`RTX PRO 4500 Blackwell:EU-RO-1`, `GPU(_)+.-:Z`, and exactly 128 bytes
`A` + 126 colons + `Z`. Required rejected vectors include empty; leading or
trailing space; colon first or last; exactly 129 bytes `A` + 127 colons + `Z`;
slash; backslash; tab; LF; NUL; non-breaking space; and any other non-ASCII
code point. Migration fixtures cover old Task 012 Stop markers, native Start
markers, managed Pod projections, and worker persistence: valid values remain
byte-identical, while invalid records all surface the same fail-closed
`gpu_identity_invalid` classification without truncation or normalization.

## Live inventory, price, and score contract

### One native observation and freshness authority

One logical refresh is owned by Rust native and consists of exactly the two GETs
already made by `RunPodV2InventorySource`, under pinned
`https://api.runpod.io/v2`: literal `/catalog/datacenters` with empty query and
literal `/catalog/gpus` with normalized query
`include=AVAILABILITY&product=POD&count=1&cloud=SECURE&minCudaVersion=13.0`.
The datacenter response must prove EU-RO-1 network-volume support; the GPU
response supplies the Secure price/count/availability. A global or Community
result cannot supply EU-RO-1 availability. Native starts both under one
observation ID, coalesces every overlapping refresh onto it, validates both
complete bodies, and publishes one terminal snapshot. It never treats one GET
as a newer observation than the other.

The profile-scoped managed-Pods GET remains the separate lifecycle authority
for zero/one/multiple current Pods and current-Pod price/profile. It is not a
third inventory-refresh GET. `currentPod` in the selector snapshot is a join of
the latest separately validated lifecycle projection, with its own timestamp/
stale flag; it never borrows the inventory observation's receipt or
`observedAt`. Every final Start/Switch command performs both a fresh two-GET
inventory observation and the separate authoritative Pod/profile preflight.

```ts
type NativeGpuInventoryStateV1 =
  | 'loading' | 'ready' | 'empty' | 'fallback' | 'error';
interface NativeGpuInventoryReceiptV1 {
  schemaVersion: 1;
  receiptId: string;
  processEpochId: string;
  receivedAt: string;       // display/evidence only
  validForMs: 60000;
  catalogSha256: string;
}
type NativeGpuInventoryIssueV1 =
  | { code: 'gpu_inventory_datacenters_unavailable'; retryable: true }
  | { code: 'gpu_inventory_gpus_unavailable'; retryable: true }
  | { code: 'gpu_inventory_response_invalid'; retryable: false }
  | { code: 'gpu_inventory_region_unsupported'; retryable: false };
interface NativeGpuInventorySnapshotV1 {
  schemaVersion: 1;
  observationId: string;
  processEpochId: string;
  includeEmergencyTier: boolean;
  state: NativeGpuInventoryStateV1;
  observedAt: string | null;
  receipt: NativeGpuInventoryReceiptV1 | null;
  offers: GpuSelectorOfferV1[];
  currentPod: NativeGpuSwitchPodV1 | null;
  currentPodObservedAt: string | null;
  currentPodStale: boolean;
  issue: NativeGpuInventoryIssueV1 | null;
}
interface NativeGpuInventoryEventV1 {
  schemaVersion: 1;
  event: 'gpu-inventory-v1';
  processEpochId: string;
  observationId: string;
  eventSequence: number;
  superseded: boolean;
  snapshot: NativeGpuInventorySnapshotV1;
}
```

`gpu_inventory_begin_refresh({ includeEmergencyTier })` immediately returns the
native-created `loading` snapshot, starts both GETs, and emits exactly one
strict `NativeGpuInventoryEventV1` terminal event with the same observation ID.
`gpu_inventory_load()` returns the last snapshot. A second begin while loading
coalesces and returns the same ID only when `includeEmergencyTier` is identical.
A begin with the other flag creates a new observation and two-GET read, marks
the older in-flight observation superseded, and becomes the only candidate for
the stored current snapshot. The older read may finish but can never replace
the newer snapshot. Opening or
focusing the sheet begins one refresh; while it is visible and foregrounded the
same action occurs every 30,000 ms. Close, background, and unmount cancel the
timer, not the already-started read. Foreground return and **Refresh GPUs** each
begin one immediate logical refresh. Ordinary 2–5 second Pod/Studio polling
does not call either inventory GET.

`ready` requires both successful validated inventory GETs and at least one
approved row; `empty` requires both successful inventory GETs and zero approved
rows. Only these states have non-null inventory `observedAt` and receipt.
`fallback` is used when either inventory GET fails but the checked-in ordinary
policy remains renderable; it contains the
checked-in ordinary ordered fallback rows, all with `source: "fallback"`,
`observedAt: null`, no receipt, unknown availability/price, and no manual
selection. `error` covers invalid inventory bodies/region and has no receipt.
The issue union is the retry authority: only the two transport-unavailable
codes are `retryable: true`; invalid response and unsupported region are always
false. Retryable means the existing explicit/visible refresh cadence may read
again, never that a timer may Start/Switch or that malformed bytes can be
accepted. Rust and TypeScript reject any code/boolean mismatch.
Separate profile-Pod failure/ambiguity leaves current Pod stale/read-only and
blocks final preflight without fabricating inventory failure. Loading, error,
empty, and fallback are first-
class authored states; fallback never fabricates `observedAt`, freshness, price,
or provider availability. The last validated current Pod may remain pinned for
Stop explanation after an error but is marked stale and cannot authorize Start
or Switch.

Snapshot relations are exact: `loading` has empty offers, null receipt/time, and
null issue; `ready` has one-or-more offers all carrying the snapshot observation/
receipt and null issue; `empty` has zero offers, a non-null receipt/time, and
null issue; `fallback` has one-or-more fallback rows, null receipt/time, and one
retryable inventory issue; `error` has zero offers, null receipt/time, and one
issue. Every snapshot process epoch equals native's current epoch. If
`currentPod` is null then its time is null and stale is false. A fresh non-null
current Pod has non-null time/stale false; a retained last-known Pod has its
original time/stale true. Inventory rows never copy that Pod time, and fallback
rows never copy a prior inventory time. Every offer's emergency inclusion and
the receipt's private catalog evidence equal the snapshot's exact
`includeEmergencyTier`; a snapshot for `false` can never contain the emergency
row.

The `gpu-inventory-v1` event is a strict unknown-field-rejecting camelCase IPC
object. `snapshot.observationId`, `snapshot.processEpochId`, and the two outer
IDs must be byte-equal, and the snapshot must be terminal (`ready`, `empty`,
`fallback`, or `error`), never `loading`. `eventSequence` is a positive
JavaScript-safe integer, begins at 1 for each native process epoch, and increases
by exactly one without wrap for every emitted terminal observation. Native emits
exactly one event for every observation that began HTTP I/O, including a
superseded one; `superseded` is true iff a newer observation began first.
Events are emitted in native completion order to the app-scoped Tauri channel
for ImageForge windows in that process only. They are not persisted or replayed.
Each window registers one listener, validates process epoch/sequence/schema,
deduplicates by `(processEpochId, observationId)`, ignores a superseded event for
state replacement, and unregisters on unmount. A listener attached after an
event calls `gpu_inventory_load`; renderer arrival order, duplicate delivery, or
an old-process event can never replace the newest non-superseded snapshot.

Native creates a new process-epoch UUID at process start and a receipt UUID only
after both bodies validate. It privately maps the receipt to
`(processEpochId, std::time::Instant receivedInstant, catalogSha256, exact
parsed offers and EU-RO-1 support)`. Freshness age is integer monotonic milliseconds
`nowInstant - receivedInstant`; a receipt is fresh iff the process epoch is
unchanged and `0 <= ageMs < 60000`. Wall-clock `receivedAt`, provider timestamps,
renderer timers, and serialized observations never authorize. Suspend may make
the monotonic age expire; process restart destroys the map, so every old receipt
is invalid even if its wall time appears recent. Final native Start/Switch
commands carry both `observationId` and `receiptId`, verify that clicked private
mapping, target, catalog digest, process epoch, and age, and then perform a new
logical refresh before any provider mutation. The final refresh necessarily has
a new observation/receipt identity. Native stores and emits its terminal
`gpu-inventory-v1` snapshot before the Start/Switch command resolves. Receipt
identity replacement alone does not invalidate the click: when the refreshed
profile, emergency policy, eligible target/order, canonical microprice, and
catalog semantics are byte-for-byte equal to the clicked projection, native may
atomically promote the refreshed receipt into the same action and continue. Any
semantic change returns the bound action error with no POST; the stored/emitted
snapshot is then the sole source for another foreground confirmation. Renderer
code never rewrites an old receipt or treats the action result as an inventory
snapshot.

`catalogSha256` is
`sha256(UTF8(JCS({schema_version:1,include_emergency_tier,eu_ro_1_volume_supported,
offers})))`, where `offers` is sorted by raw GPU ID and contains exactly GPU ID,
display name, policy key, memory GiB integer, emergency boolean, Secure lane,
EU-RO-1 availability, max-count integer, and canonical
`hourly_price_micro_usd`; no timestamp/current Pod/raw unknown field is included.
Rust/TypeScript golden vectors use RFC 8785 and exact integer encoding.

### Exact raw price and selector projection

Provider JSON is decoded from response bytes with a lossless token decoder
before ordinary JavaScript number conversion. The one accepted USD/hr decimal
lexeme grammar is:

```text
PRICE_DECIMAL_V1 = (0|[1-9][0-9]{0,15})(\.[0-9]{1,6})?
```

Sign, leading zero, exponent, more than six fractional digits, trailing decimal
point, surrounding whitespace, NaN, Infinity, and overflow are rejected.
Parsing appends zeroes to six fractional digits and computes
`whole * 1_000_000 + fraction` with checked integer arithmetic; the result must
be `<= Number.MAX_SAFE_INTEGER`. No binary floating point participates in
equality, confirmation, ranking, persistence, or fingerprints. Display is a
derived decimal division by 1,000,000.

Representation is field-specific and never coerced:

- Inventory `gpus[i].price.secure` is its documented JSON **number token** (or
  null when unavailable) and must lexically match `PRICE_DECIMAL_V1` before a
  normal JSON parser loses its spelling.
- Pod `adjustedCostPerHr` is a required JSON **number token or null**. A valid
  non-null token is the authoritative effective price.
- Pod `costPerHr` is a required JSON **string** whose entire decoded UTF-8 value
  matches `PRICE_DECIMAL_V1`. This documented currency string is the fallback
  only when `adjustedCostPerHr` is exactly null. A numeric legacy
  `costPerHr: 0.74` is explicitly rejected; Rust and TypeScript must not accept
  it as a compatibility extension.

Both Pod fields must be present and have their exact representation. Missing,
wrong-type, malformed, negative, exponent, excessive-precision, or overflowing
either field makes Pod price unknown/fail-closed; an invalid adjusted value does
not fall through, and null adjusted plus invalid/absent cost cannot fall back.
When adjusted is a valid number and the cost string is valid but differs,
adjusted wins and both lexemes/micro-USD integers remain private evidence.
When adjusted is null and cost is valid, the losslessly parsed cost string is
the authoritative micro-USD price. A malformed inventory row is unselectable
without poisoning valid sibling catalog rows; a malformed current/created Pod
price keeps that Pod visible and stoppable but blocks Start/Switch price
authority or enters the explicit actual-price-unavailable path. It never
borrows a catalog price.

The validated provider fixtures freeze these raw fields; unknown fields are
ignored only outside the allowlist, while missing/wrong-type allowlist fields
fail their enclosing record:

```ts
type JsonNumberToken = string & { readonly __losslessJsonNumberToken: unique symbol };
type DecimalStringV1 = string & { readonly __priceDecimalString: unique symbol };
interface RunPodGpuTypePriceRawV1 { secure: JsonNumberToken | null }
interface RunPodGpuDataCenterRawV1 {
  id: string;
  availability: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
}
interface RunPodGpuTypeRawV1 {
  id: string; name: string; manufacturer: string; memory: number;
  secure: boolean; price: RunPodGpuTypePriceRawV1;
  maxCount: { secure: number | null };
  dataCenters: RunPodGpuDataCenterRawV1[];
}
interface RunPodGpuCatalogResponseRawV1 { gpus: RunPodGpuTypeRawV1[] }
interface RunPodDataCenterRawV1 {
  id: string;
  networkVolumeTypes: string[];
}
interface RunPodDataCenterResponseRawV1 {
  dataCenters: RunPodDataCenterRawV1[];
}
interface RunPodPodPriceRawV1 {
  adjustedCostPerHr: JsonNumberToken | null;
  costPerHr: DecimalStringV1;
}
```

These tagged strings describe the lossless pre-conversion token/value carried
by the validator, not permission to serialize a JSON number as a string. Shared
golden vectors include adjusted `0`, `0.69`, `12.000001`, adjusted null plus
cost strings `"0"`, `"0.74"`, `"0.000001"`, and the exact safe maximum
`"9007199254.740991"`. They reject adjusted string `"0.69"`, adjusted exponent/
negative/seven-decimal/overflow tokens, numeric `costPerHr: 0.74`, and cost
strings with whitespace, sign, exponent, leading zero, trailing dot, seven
decimals, overflow, empty, null, or missing. Create, list, and exact-GET Pod
fixtures run the identical vectors in TypeScript and Rust.

`contracts/runpod-price-v1.schema.json` and
`contracts/runpod-price-v1.vectors.json` are the one checked-in source for these
representations, lexemes, precedence outcomes, and expected micro-USD/null
results. They use draft 2020-12 with `additionalProperties: false`; Rust and
TypeScript tests load the same files instead of copying cases.

The selector projection is strict and shared by Rust/TypeScript schema tests:

```ts
type GpuSelectorDisabledReasonV1 =
  | 'current_gpu' | 'unapproved_current' | 'inventory_loading'
  | 'inventory_error' | 'fallback_only' | 'inventory_stale'
  | 'unavailable' | 'price_unavailable' | 'same_as_current';
type CanonicalU128DecimalV1 = string & {
  readonly __canonicalUnsignedU128Decimal: unique symbol;
};
interface GpuSelectorOfferV1 {
  schemaVersion: 1;
  observationId: string;
  receiptId: string | null;
  gpuId: string;
  policyKey: string;
  displayName: string;
  memoryGb: number;
  emergency: boolean;
  availability: 'unknown' | 'none' | 'low' | 'medium' | 'high';
  hourlyPriceMicroUsd: number | null;
  dataCenterId: 'EU-RO-1';
  source: 'live' | 'fallback' | 'current';
  observedAt: string | null;
  stale: boolean;
  selectable: boolean;
  disabledReason: GpuSelectorDisabledReasonV1 | null;
  benchmarkState: 'measured' | 'stale' | 'unmeasured';
  benchmarkAgeMs: number | null;
  speedScore: number | null;
  benchmarkMedianDurationUs: number | null;
  benchmarkP95DurationUs: number | null;
  benchmarkMeasuredAt: string | null;
  benchmarkEvidenceSha256: string | null;
  estimatedSwitchRemainingCostMicroUsd: CanonicalU128DecimalV1 | null;
}
```

Rows sort by pinned current, Auto, fixed ordinary policy order, then emergency;
dynamic IDs within one policy sort by raw ASCII GPU ID. Exactly one disabled
reason is chosen in this precedence: current/unapproved-current, loading,
error, fallback, stale, unavailable (`none` or `unknown`), price unavailable,
same-as-current. Non-current unapproved rows are absent, not disabled. Row keys,
focus, and selection use exact GPU ID. A refresh preserves focus/selection only
when that exact ID still exists and is selectable; otherwise it clears selection,
keeps focus on the nearest stable policy row, and announces the loss once. It
never auto-selects a replacement target. Loading/result/selection announcements
deduplicate by `(observationId,state,gpuId|null)`.

Any target price change after confirmation, including one micro-USD, requires
**Confirm updated price** before Switch finalization, old DELETE, or replacement
POST. The same rule applies to offline manual Start: its native command binds
the exact GPU ID, micro-USD price, observation ID, receipt ID, profile, and one
private single-use process grant, performs the final two-GET refresh, and then
consumes that grant internally in the exact create call. No grant token crosses
IPC. If price, target, policy, or catalog semantics change, no POST occurs; the
new snapshot is shown and another explicit **Start selected GPU at …/hr** click
is required. A receipt UUID change with otherwise identical semantics is the
allowed promotion described above. Auto Start uses the same rule and preserves
Task 003 ordered fallback; if a fresh measured winner or order changes, the UI
updates and requires another Start click.
If the actual created-Pod price differs from the confirmed price, native never
auto-deletes it: generation remains disabled behind `gpu_actual_price_changed`,
the exact old/new micro-USD values are visible, and the user explicitly accepts
the new price to continue. An ordinary offline Start can use normal explicit
Stop; an in-progress Switch can use only the exact **Terminate unaccepted
replacement** path defined below.

### Checked-in benchmark evidence and deterministic score

Only version-2 evidence below is score-eligible. The fixed score contract is
BF16, 1280×720, four steps, guidance 1.0, JPEG 95, no reference image,
`black-forest-labs/FLUX.2-klein-4B`, one exact model revision, one exact
template ID, one immutable worker image digest, and the checked-in 30-prompt/
30-seed fixture. Reference-image, mixed-template, warm-cache-only, or legacy
measurements remain diagnostics and cannot score.

The authoritative checked-in files are
`contracts/gpu-benchmark-raw-v2.schema.json`,
`contracts/gpu-benchmark-profile-v2.schema.json`, and
`contracts/gpu-benchmark-v2.vectors.json`; evidence lives only at
`benchmarks/gpu-v2/<policy-key>/<raw-evidence-sha256>.raw.json` with the sibling
`.profile.json`. GPU identity/runtime files are
`contracts/gpu-identity-v1.schema.json`,
`contracts/gpu-identity-v1.vectors.json`,
`contracts/gpu-runtime-identities-v1.schema.json`, and
`contracts/gpu-runtime-identities-v1.json`. JSON Schema uses draft 2020-12,
`additionalProperties: false`, exact required fields/enums/bounds, and the same
files are loaded by Rust, TypeScript, and Python tests rather than copied.

```ts
interface GpuBenchmarkContractV2 {
  modelId: 'black-forest-labs/FLUX.2-klein-4B';
  modelRevision: string;
  workerImageDigest: string;
  templateId: string;
  precision: 'bf16';
  width: 1280; height: 720; steps: 4; guidanceMilli: 1000;
  jpegQuality: 95; referenceMode: 'none';
  promptFixtureId: 'imageforge-gpu-benchmark-30-v1';
  promptFixtureSha256: string;
  seedFixtureSha256: string;
}
interface GpuBenchmarkSampleV2 {
  ordinal: number;                 // contiguous 1..30
  promptFixtureOrdinal: number;    // equals ordinal
  seed: number;                    // non-negative JS-safe integer from exact fixture
  outcome: 'success' | 'failure';
  durationUs: number | null;
  failureCode: string | null;
}
interface GpuBenchmarkRawV2 {
  schemaVersion: 2;
  gpuId: string;
  policyKey: string;
  measuredAt: string;
  bootDurationMs: number;
  contract: GpuBenchmarkContractV2;
  samples: GpuBenchmarkSampleV2[];
}
interface GpuBenchmarkProfileV2 {
  schemaVersion: 2;
  gpuId: string;
  policyKey: string;
  measuredAt: string;
  bootDurationMs: number;
  attemptedSampleCount: 30;
  successfulSampleCount: 30;
  failedSampleCount: 0;
  medianDurationUs: number;
  p95DurationUs: number;
  contract: GpuBenchmarkContractV2;
  rawEvidenceSha256: string;
}
```

The checked-in seed fixture is a strict 30-element JSON array of decimal integer
tokens in `[0, Number.MAX_SAFE_INTEGER]`, with SHA-256 exactly
`contract.seedFixtureSha256`. Sample ordinal `i` must carry byte-for-byte numeric
value `seed_fixture[i - 1]`; no randomization, signed value, float, exponent,
unsafe integer, string coercion, truncation, or per-GPU substitution is valid.
The prompt fixture has the same 30 ordinals and hash binding, so each sample is
the one exact `(prompt[i-1], seed[i-1])` pair. Rust/TypeScript/Python fixture
tests reject reordered, duplicated, missing, negative, or out-of-range seeds.

Raw evidence has exactly 30 attempts. Success requires `durationUs` in
`1..3_600_000_000`, `failureCode: null`; failure requires `durationUs: null`
and a stable ASCII code of 1–64 bytes. Any failure, missing/duplicate ordinal,
fixture mismatch, or boot duration outside `0..1_200_000` makes the evidence
non-score-eligible; failures are never dropped or replaced invisibly. Sort the
30 success durations ascending. The even median is integer half-up
`(d[14] + d[15] + 1) // 2`; p95 is nearest-rank `d[ceil(.95*30)-1] = d[28]`.
Profile counts, boot, median, and p95 must recompute exactly from raw evidence.

`bootDurationMs` starts when native receives/validates HTTP 201 for the exact
benchmark Pod and ends on the first authenticated worker health observation that
proves the immutable image/model loaded and phase Ready; inventory, confirmation,
and benchmark prompt upload are excluded. Each `durationUs` starts immediately
before the controller invokes the one-image pipeline and ends only after JPEG
encoding, image/checksum/manifest fsync, atomic rename, and receipt commit for
that image. Both use one monotonic clock; nanoseconds are integer-floor divided
by 1,000 for durationUs and 1,000,000 for boot ms. Cache/model prewarming before
the boot start or between samples is forbidden; the fixed fixture order is never
shuffled. Boundary ambiguity or clock reset invalidates the evidence.

The raw JSON contains no self-hash. Its checked-in bytes must be UTF-8 without
BOM, exact RFC 8785/JCS of `GpuBenchmarkRawV2`, followed by one LF and no other
whitespace. `rawEvidenceSha256 = sha256(those exact bytes)`. Every hash is
lowercase 64-hex. Cross-platform golden vectors bind JCS string escaping,
integer encoding, key ordering, LF, and hash bytes; `JSON.stringify` on an
unordered record is not an implementation. A v1/legacy profile lacking raw
samples, p95, reference mode, complete contract identity, or evidence hash is
retained read-only but never upgraded by inference; its row is `Unmeasured`.
If several valid v2 profiles match, choose greatest `measuredAt`, breaking an
exact timestamp tie by lexicographically smallest raw-evidence hash.

Benchmark evidence expires for selector ranking after exactly 90 × 24 hours:
`BENCHMARK_MAX_AGE_MS_V1 = 7_776_000_000`. Native parses canonical
`measuredAt` and evaluates `ageMs = evaluationUtcMs - measuredUtcMs` with checked
integer arithmetic at each inventory projection/final preflight. `measured`
requires `0 <= ageMs < BENCHMARK_MAX_AGE_MS_V1`; `stale` requires a valid
matching profile with `ageMs >= BENCHMARK_MAX_AGE_MS_V1`; a future timestamp,
clock overflow, or malformed time is invalid evidence and `unmeasured`.
Inventory's separate 60-second monotonic receipt rule neither extends nor
shortens this 90-day evidence age.

For `measured`, age, median, p95, measured time, and evidence hash are non-null.
For `stale`, only age, measured time, and evidence hash remain projected for the
honest **Benchmark expired** label; speed, median, p95, and estimated cost are
null, and the profile is excluded from Auto quorum/ranking. For `unmeasured`,
all benchmark fields/age/hash are null. Refresh/final preflight recomputes the
state; no timer mutates provider state. Exact boundary vectors cover age
`7_775_999_999` (measured), `7_776_000_000` (stale), older, future, clock
overflow, and a newer fresh profile superseding an older stale one.

Benchmark staleness is not inventory staleness and is not a disabled reason. A
`stale` row remains manually selectable whenever its live inventory price,
availability, policy, receipt, and all other gates are valid; it shows
**Benchmark expired**, never generic `Unmeasured`, and shows no score or cost.
`unmeasured` alone shows `Unmeasured`. A stale profile cannot make Auto measured
ranking eligible, but ordinary Auto may still use Task 003's fixed fallback
order with **Benchmark quorum unavailable**. Confirmation repeats the expired
label and `—` estimate without blocking the explicit selected-GPU action.

Among matching ordinary approved profiles, `fastestMedianUs` is the lowest
positive median among `measured` rows. If there is no fresh measured ordinary
profile, every `measured` score is unavailable: rows with valid expired evidence
remain `benchmarkState: 'stale'`/**Benchmark expired**, while only rows with no
valid evidence remain `unmeasured`/`Unmeasured`. The emergency profile never
contributes the denominator; when emergency opt-in is explicit and an ordinary denominator
exists, it may receive a score against that ordinary denominator. Score uses
integer rational arithmetic and round-half-away-from-zero:
`clamp(1,100, round(100 * fastestMedianUs / medianDurationUs))`.

Auto measured best-value ranking is enabled only when every currently available
ordinary live offer has canonical price and fresh `measured` v2 evidence and there are
at least two such offers. Otherwise Auto uses the existing Task 003 fixed
ordinary fallback order and labels benchmark quorum unavailable; unknown never
means zero/infinite cost. Compare value exactly by cross-multiplying
`hourlyPriceMicroUsd * medianDurationUs`; ties use fixed policy order, then raw
ASCII GPU ID. Emergency is never an Auto candidate.

Estimated replacement cost is present only for an exact compatible fresh
`measured` profile and price. At confirmation, `remainingImages` is the manifest count that will still
need a claim after the in-flight image reaches its bounded success/final-failure
fixed point; that in-flight image and its retries run on the old GPU and are
excluded. A paused/interrupted unfinished current prompt is included. At
`ready_to_delete`, native recomputes the count; unsettled local receipts disable
Switch and cost. Offline manual Start uses the validated draft prompt count.
The integer numerator is
`hourlyPriceMicroUsd * (bootDurationMs*1000 + medianDurationUs*remainingImages)`;
divide by `3_600_000_000` with half-up rounding to micro-USD. Otherwise display
`—`, never a guess. `remainingImages` is a validated integer in `0..450`;
price, boot, median, and count inputs remain finite non-negative safe integers,
but their products are intentionally not JavaScript-number arithmetic.
Timestamps are canonical UTC RFC3339 milliseconds.

All score, Auto-ranking, and estimated-cost intermediate arithmetic uses one
`WIDE_UNSIGNED_V1` contract: TypeScript converts each already-validated safe
integer's canonical base-10 digits to `BigInt`; Rust uses checked `u128`; Python
uses `int` but explicitly rejects any intermediate above
`U128_MAX = 340282366920938463463374607431768211455`. No implementation uses a
binary `number`/`f64`, lossy JSON round-trip, saturation, wrap, logarithm, ratio,
or decimal float for a product or comparison. The Auto value product
`hourlyPriceMicroUsd * medianDurationUs` is computed and compared in that wide
domain; score numerator `100 * fastestMedianUs` and its half-away-from-zero
rounding use it too. Any invalid/overflowing ranking operand makes measured Auto
quorum unavailable and uses the fixed fallback order; it never chooses by a
lossy approximation.

Estimated cost computes checked `runtimeUs = bootDurationMs * 1000 +
medianDurationUs * remainingImages`, then checked `numerator =
hourlyPriceMicroUsd * runtimeUs`. For non-negative half-up division without an
overflowing add, compute `q = numerator / 3_600_000_000`, `r = numerator %
3_600_000_000`, and `rounded = q + (2*r >= 3_600_000_000 ? 1 : 0)` with checked
wide operations. IPC/persistence projects `rounded` only as canonical unsigned
decimal `CanonicalU128DecimalV1`: `0` or `[1-9][0-9]{0,38}`, additionally
numerically `<= U128_MAX`. UI USD formatting parses that string to BigInt and
inserts six decimal micro-USD digits; it never converts through Number. Missing,
invalid, overflowed, or unrepresentable inputs/projected values produce null and
`—` without blocking an otherwise safe explicit manual target.

`contracts/gpu-wide-arithmetic-v1.vectors.json` is consumed unchanged by Rust,
TypeScript, and Python. It includes the maximum valid Auto product
`9007199254740991 * 3600000000 = 32425917317067567600000000`; maximum valid
runtime `1200000*1000 + 3600000000*450 = 1621200000000`; maximum numerator
`14602471431786094609200000000`; quotient/remainder
`4056242064385026280`/`1200000000`; and projected result string
`"4056242064385026280"`. Half-up vectors use numerators `1799999999`,
`1800000000`, and `1800000001` and expect `"0"`, `"1"`, and `"1"`.
Additional vectors cover zero, equal Auto products/tie order, one-unit product
difference, U128_MAX `340282366920938463463374607431768211455`, U128_MAX+1
`340282366920938463463374607431768211456` rejection, wrong/leading-zero/exponent output
strings, and every checked multiply/add overflow seam.

## Switch state machines

### Native durable saga

There is at most one nonterminal switch journal in one configured ImageForge
profile. The exact phases are:

```text
planned -> consent_pending -> pausing -> ready_to_delete
ready_to_delete -> delete_intent -> old_absent
delete_intent -> delete_uncertain -> delete_intent | old_absent
old_absent -> create_intent -> replacement_identified -> provisioning
create_intent -> create_uncertain -> replacement_identified | old_absent
replacement_identified -> provisioning -> ready_paused -> completed
replacement_identified -> replacement_delete_intent  # rejected actual price only
provisioning -> replacement_failed -> provisioning | replacement_delete_intent
replacement_delete_intent -> replacement_delete_uncertain -> replacement_delete_intent | old_absent
any nonterminal pre-delete phase -> needs_attention | cancelled_pre_delete
any nonterminal at/after delete_intent -> needs_attention
needs_attention -> its persisted blockedAt phase only after explicit Resume switch
```

- `cancelled_pre_delete` is legal only before `delete_intent` has ever been
  committed. At or after `delete_intent`, recovery is forward-only and the UI
  never calls the operation a rollback.
- `delete_uncertain` can return to `delete_intent` only after an explicit Resume
  and a fresh exact old-Pod GET says it still exists. It advances to
  `old_absent` only through the exact absence rule.
- If the old Pod becomes absent or changes identity before durable worker/native
  delete intent, the saga parks non-retryably as
  `gpu_switch_old_pod_disappeared_early`; it does not reinterpret an external
  failure/peer action as consent and does not create a replacement. Recovery is
  an explicit operator/shared-volume procedure outside automatic Switch.
- `create_uncertain` advances to `replacement_identified` only when exactly one
  Pod matches the stored provider-visible attempt marker, canonical create
  identity, and full profile. One empty list is never zero-match proof. The
  earliest zero-match proof begins 180,000 monotonic ms after the persisted POST
  send boundary and consists of three successful profile-scoped Pod-list
  observations with distinct native observation IDs, each at least 30,000
  monotonic ms apart, zero exact attempt-marker matches, no unidentified managed
  profile Pod, plus exact GET validation of every Pod returned in those lists.
  All three must use one account/profile credential binding and the same
  create-intent hash. Suspend/restart invalidates an in-progress proof and starts
  its timing again; wall time cannot shorten it. Native persists the completed
  proof digest. Only then does explicit **I verified no replacement Pod exists —
  retry** return to `old_absent`; a separate explicit prepare-and-confirm action
  CSPRNG-generates attempt revision `N+1`. Zero-proof ambiguity remains
  `create_uncertain` indefinitely and never sends a second POST.
- A replacement that reaches provider `error`/`exited`, exceeds the bounded
  20-minute provisioning deadline, or fails worker identity/health before adoption enters
  `replacement_failed`. It is never auto-deleted. An explicit **Terminate failed
  replacement** confirmation may persist `replacement_delete_intent` and delete
  only the exact Pod ID recorded for that attempt. Ambiguity parks at
  `replacement_delete_uncertain`; exact absence archives that failed attempt and
  returns to `old_absent` for a fresh explicit attempt. An adopted
  `replacement_ready` worker is never eligible for this cleanup path.
  Before consuming that private cleanup authority, native refetches the exact
  Pod/worker; a
  late healthy exact replacement returns to `provisioning`/verification rather
  than being deleted from stale failure state.
- Changing target before delete intent first terminalizes the worker request and
  native record as `cancelled_pre_delete`, writes both immutable tombstones, and
  releases the reservation only after the worker guard is absent. A distinct
  foreground confirmation then CSPRNG-generates a fresh switch UUID, fresh
  initial attempt UUID, and new consent request; a target edit can never mutate
  the original switch identity. After the old Pod is absent, **Choose another
  approved GPU** is two operations within the same forward-only switch:
  **Prepare another target** obtains a new native observation/quote but creates
  no attempt, and **Confirm this replacement attempt** CSPRNG-generates exactly
  revision `N+1` and its attempt UUID. Peer consent is not repeated because the
  consented destructive old-Pod interruption already occurred; the initiating
  principal still confirms the exact new target/price. The worker adopts only
  the actual replacement recorded by the native journal.
- `completed` requires worker `replacement_ready`, replacement verification,
  no unresolved provider result, and successful worker completion of the shared
  guard. Completed/cancelled records are immutable history and do not authorize
  another provider action.
- If the created Pod's authoritative adjusted/current price differs from the
  confirmed attempt price, it remains recorded and is never auto-deleted. The
  saga parks at `replacement_identified`/`needs_attention` with
  `gpu_actual_price_changed`, exposes both safe micro-USD integers, and requires
  explicit price acknowledgement before provisioning/adoption can continue.
  Alternatively, before worker adoption, **Terminate unaccepted replacement**
  uses the same exact-Pod cleanup/absence proof with reason
  `actual_price_rejected`; it never routes through normal Stop while the Switch
  guard is active and never deletes on dialog close/denial alone.
  A null/malformed created-Pod price is `gpu_actual_price_unavailable`; it cannot
  be acknowledged as a number and uses read-only refresh or the same explicit
  unaccepted-replacement cleanup.

### Worker coordination state

The worker switch request uses:

```text
pending -> approved | denied | expired | cancelled
approved -> pausing | cancelled
pausing -> ready_to_delete | needs_attention | cancelled
ready_to_delete -> delete_intent | needs_attention | cancelled
delete_intent -> replacement_ready | needs_attention
replacement_ready -> completed | needs_attention
```

No deadline automatically releases `pausing`, `ready_to_delete`, or
`delete_intent`. Before delete intent, only the exact requester may explicitly
cancel; the preserved batch stays paused and never auto-resumes. After delete
intent, the durable guard is forward-only until verified replacement adoption
and completion or explicit shared-volume repair.

### Batch, queue, and provider observations

| Observation/action | Worker batch | Local queue | Native saga | Provider mutation |
| --- | --- | --- | --- | --- |
| Switch requested while idle | none | park if authorized | `consent_pending` | none |
| Switch requested while running | current image finishes, then `paused` | current item remains `active`; runner `paused` | `pausing` | none |
| Batch already paused | remains `paused` | item remains `active`; runner `paused` | may reach `ready_to_delete` | none |
| Batch resumably interrupted | remains `interrupted` | item `interrupted`; runner `needs_attention` | may reach `ready_to_delete` | none |
| Pause/manifest/artifact persistence ambiguous | unchanged authoritative state | runner `needs_attention` | `needs_attention` blocked at `pausing` | none |
| Peer denies/expires | unchanged; no auto-resume | stays parked until terminal release; user may explicitly Resume queue | immutable native history `denied` or `expired` after matching worker tombstone | none |
| Exact old DELETE 204 but GET not settled | paused/interrupted marker | parked | `delete_intent` | no POST |
| DELETE timeout/network/5xx | unchanged marker | parked | `delete_uncertain` | no POST |
| Exact old ID absent | recoverable manifest on volume | parked | `old_absent` | explicit create may follow |
| Exact target unavailable | recoverable manifest on volume | parked | `needs_attention`, blocked at `old_absent` | none |
| Create response missing/invalid | recoverable manifest on volume | parked | `create_uncertain` | never second POST |
| One exact replacement becomes Ready | remains paused/interrupted | parked, authorization required | `ready_paused` | none |
| Exact replacement fails before adoption | preserved marker/manifest | parked | `replacement_failed` | explicit exact cleanup only |
| Switch completed | remains paused/interrupted | parked, authorization required | `completed` | none |
| Explicit Resume batch/queue | existing owner-only rules | Task 013 lookup-first | immutable completed history | none |

`ready_paused` and `completed` never call batch Resume, queue Resume, alarm,
Stop, or another create. A changed Pod identity outside this exact journal parks
the transaction as `gpu_switch_peer_pod_present`; it is never adopted by name,
owner, GPU label, or progress.

## Worker consent, guard, and recovery contract

- Switch is authenticated Studio coordination beside, but distinct from, Stop.
  The requester needs a live foreground session. Same-principal windows are
  excluded from approval. Every other live foreground principal approves once,
  deduplicated by authenticated `user_id`. Newly foreground principals are
  added before finalization and expired non-owner peers stop blocking.
- If a foreign principal owns the active running/paused/interrupted batch, at
  least one of that principal's sessions must remain live and foreground and
  that principal must approve. Otherwise creation/finalization returns HTTP 423
  `switch_owner_unavailable` with safe owner/progress and changes nothing. A
  requester who owns the batch implicitly approves their own batch but still
  waits for other principals.
- Consent lasts 30 seconds. Denial, timeout, malformed/ambiguous response,
  requester expiry before finalization, or worker epoch change before the
  durable marker exists fails closed and sends no DELETE. Peer approval grants
  permission to finish the current image and terminate the old Pod; it does not
  authorize automatic generation or unapproved GPU selection.
- Principal binding is worker-owned and ordered exactly. Native first CSPRNG-
  generates a switch/attempt draft, canonical worker-create bytes/hash, and a
  durable `send_pending` intent without destructive authority, then performs
  the pinned authenticated Studio create. Immediately before the first socket
  write native durably changes that intent to `sent_uncertain`; only a validated
  response plus committed principal binding changes it to `bound`. The worker derives
  immutable `Principal.user_id` from the verified bearer/session—not request
  fields—CSPRNG-generates one `principal_binding_id`, and durably binds it to the
  switch before returning. Native persists that private binding before exposing
  `consent_pending`. Response loss parks as
  `gpu_switch_worker_create_uncertain` and is resolved only by owner-only exact
  lookup followed, after a generic 404, by one explicit choice: **Resume
  switch** replays the byte-identical create with the same switch ID, or
  **Cancel unresolved switch** uses the native-only settling route below to
  write a worker tombstone. It never sends a create with another ID and never
  substitutes display name, session label, batch owner, or renderer state. A
  draft with no proven worker binding cannot finalize or authorize provider I/O.
  Generic owner 404 alone is never proof that the first request cannot arrive,
  never permits reservation release, and never permits `local_draft_cancelled`.
- Before calling worker Finalize, native verifies the exact approved request,
  generates one finalization UUID, and durably records it in the local journal.
  Native then calls Finalize itself over the pinned worker transport; neither the
  UUID nor any action/grant token is returned to TypeScript. The worker receives
  only that UUID. This native-before-worker order closes the
  crash seam where the worker marker exists after relaunch but only the private
  native owner lookup can recover the finalization ID. If the requester
  session expires before any worker marker commits, the request becomes
  `cancelled_pre_delete`; a later attempt uses a new switch ID and new consent.
- Finalization executes under the same controller async lock, shared-volume
  active lease, and GPU-control linearization lock as create/resume/retry/pause/
  cancel/Stop. It binds the exact old
  runtime Pod, requester `user_id`, current batch ID/owner/state, initial target,
  attempt ID, volume, datacenter, image digest, and model revision. It first
  crash-safely writes the `pausing` switch marker, then persists
  `pause_requested` when needed. No new image claim begins after the marker.
  The in-flight image may finish; its image file, checksum, and manifest are
  fsynced before the manifest reaches `paused` and the marker reaches
  `ready_to_delete`. “Finish” includes exhausting that image's already-bounded
  retry policy and durably recording failure; it never claims the next image.
- A crash after `pausing` but before manifest pause leaves a durable generation
  veto. Startup adopts the marker under the active lease, converts an in-flight
  manifest through the existing interrupted recovery, and requires explicit
  Resume switch. A crash after the image is ready never regenerates it. The
  marker reaches `ready_to_delete` only when no inference claim is running and
  the manifest is durably paused/interrupted at an artifact-safe boundary.
  If that fixed point is not observed within 15 minutes, the UI/worker projects
  non-retryable `pause_failed`/`needs_attention` but retains the `pausing`
  generation veto. It never kills inference or authorizes DELETE; later
  explicit Resume switch may reconcile a frame that eventually settled.
- The delete-intent endpoint atomically changes the shared marker to
  `delete_intent` before returning success. Once present, create/resume/retry,
  new Stop, and new Switch are blocked across processes/Pods. The marker has no
  automatic TTL after finalization; process death cannot release it.
- A replacement worker acquires the same shared lease, reads the marker before
  generation admission, recovers the exact manifest, and exposes a synthetic
  switch view in its new `server_instance_id` epoch. It accepts adoption only
  from the stored requester `user_id` with the exact finalization ID and native
  attempt/replacement values. It verifies runtime `RUNPOD_POD_ID`,
  `RUNPOD_VOLUME_ID`, `RUNPOD_DC_ID`, GPU count/type, image digest, data root,
  model ID/revision, and marker binding. Mismatch remains `gpu_switch_pending`.
  Native's exact revision-1 create body supplies the selected catalog ID and
  attempt marker as non-secret per-Pod env overrides; native still treats the exact RunPod Pod
  projection as catalog-ID authority. The native-only runtime-identity route
  below maps that expected ID to the actual CUDA/NVML device through one
  checked-in mapping. Public health never exposes those identities.
- After a worker restart, the marker projects a collision-checked synthetic
  requester session that is never counted as live and can never approve,
  finalize, cancel, or consume authority. Public Studio state has no
  `finalization_id` field. A newly authenticated session for the stored requester
  principal can act only when Rust's private owner lookup matches the journal's
  principal-binding/finalization tuple; old-session response/finalize routes
  remain `gpu_switch_request_not_found`.
- Adoption atomically records replacement attempt/Pod/actual target and moves
  to `replacement_ready`. This worker phase corresponds to native
  `ready_paused` and still blocks generation, Stop, and another Switch.
  Completion is idempotent, exact-principal/exact-ID bound, atomically archives
  the marker/writes its tombstone/clears current marker under the GPU-control
  lock, and only then releases that switch guard. A crash after worker clear but
  before native completion is recovered from the owner tombstone and cannot
  replay completion. The recovered batch remains
  paused/interrupted and continues to own the ordinary active-batch lease until
  its owner explicitly resumes or cancels it.
- RunPod exposes no cross-client transactional create lock during the
  delete-to-create gap. Every still-live consenting client therefore projects
  the finalized Switch and disables ordinary Start. If a newly opened or racing
  client nevertheless creates a nonmatching Pod, that worker reads the shared
  marker before generation, returns `gpu_switch_pending`, and never claims an
  image or mutates a manifest. Native parks as `gpu_switch_peer_pod_present` and
  surfaces the bounded, validated `peerPodIds` projection below for manual
  cleanup, or the explicit overflow state when more than 16 exist; it never
  emits a partial list and never auto-deletes any Pod.
  The shared-volume lease remains the hard one-writer boundary even in this
  provider race.
- Pending/approved Switch and existing Stop are mutually exclusive. A pending
  or approved Stop makes a new Switch return HTTP 409
  `stop_request_in_progress`; Stop `finalizing` returns existing HTTP 423
  `gpu_stop_pending`. A pending/approved Switch makes new Stop return HTTP 409
  `gpu_switch_request_in_progress`; every post-finalization Switch state returns
  HTTP 423 `gpu_switch_pending`.

The bidirectional matrix is closed; “no write” means no request envelope,
marker, tombstone, queue release, provider intent, or provider I/O is authored
by the losing action:

| Authoritative state under controller/GPU-control lock | Attempt | Linearization and exact result | Switch permission block |
| --- | --- | --- | --- |
| no Stop and no Switch; Stop-create acquires controller lock first | racing Switch-create | Stop request commits; Switch rereads and returns HTTP 409 `stop_request_in_progress`, no Switch envelope | `stop_request_in_progress` |
| no Stop and no Switch; Switch-create acquires controller lock first | racing Stop-create | Switch envelope commits; Stop rereads and returns HTTP 409 `gpu_switch_request_in_progress`, no Stop request | `gpu_switch_request_in_progress` |
| Stop `pending` or `approved` | create/begin Switch | controller lock observes Stop first; HTTP 409 `stop_request_in_progress`, no Switch envelope | `stop_request_in_progress` |
| Stop `finalizing` or durable Stop marker | create or finalize Switch | `.gpu-control-v1.lock` observes Stop marker; HTTP 423 `gpu_stop_pending`, no Switch marker/provider intent | `gpu_stop_pending` |
| Switch `pending` or `approved` | create/begin Stop | controller lock observes Switch first; HTTP 409 `gpu_switch_request_in_progress`, no Stop request | `gpu_switch_request_in_progress` |
| Switch `pausing`, `ready_to_delete`, `delete_intent`, or `replacement_ready` | create or finalize Stop | `.gpu-control-v1.lock` observes Switch marker; HTTP 423 `gpu_switch_pending`, no Stop marker/provider mutation | `gpu_switch_pending` |
| terminal Stop only | begin Switch | terminal tombstone is evidence, not a guard; ordinary fresh preflight applies | another live block or null |
| terminal Switch only | begin Stop | terminal tombstone is evidence, not a guard; Task 012 active-batch rules apply | null for the terminal Switch |
| both nonterminal requests/markers found at startup or locked reread | any Stop/Switch/generation mutation | HTTP 503 `gpu_control_guard_conflict`; preserve both, no winner inferred | `gpu_control_guard_conflict` |

Request creation and finalization each reread both namespaces inside the named
lock; a status preflight is never the race barrier. Legitimate pending Stop and
Switch requests therefore cannot coexist or both reach approval. If historical,
corrupt, or crash-recovered bytes imply they do, neither finalization “wins” by
timestamp—the conflict row applies. Each action error and permission block is
stable until the authoritative state changes; no client cancels the peer action
implicitly, and resolving a terminal action never auto-starts the other.
- Before switch finalization, a valid foreground create/resume/retry atomically
  cancels the pending/approved Switch with `generation_started` and proceeds
  through existing one-batch/Stop rules. A queue-mode create instead returns
  HTTP 423 `queue_switch_pending` and does not cancel peer consent. At or after
  `pausing`, every create/resume/retry returns `gpu_switch_pending`. Batch Cancel
  before finalization cancels Switch as `batch_changed`; at or after `pausing`,
  batch Cancel is blocked until Switch cancel/completion. Pause remains
  idempotent. Cancelling Switch during `pausing` does not clear its generation
  veto immediately: the current image still reaches the same durable paused or
  interrupted fixed point, then the marker is archived as cancelled. No
  cancellation response can let another image claim start.
- Task 013 owner lookup and exact same-owner/same-fingerprint submission replay
  remain read-only/idempotent and are resolved before the Switch guard; they
  neither cancel Switch nor return a false new-admission error. Only a genuinely
  new foreground create cancels pending/approved consent. A genuinely new
  queue-mode create returns `queue_switch_pending`; foreign/mismatched submission
  IDs retain their existing generic 404/409 privacy behavior.

### Shared Stop/Switch linearization and exact guard lifetime

`<IMAGEFORGE_DATA_ROOT>/.gpu-control-v1.lock` is the one shared-volume
linearization lock for Task 012 Stop finalization marker/tombstone mutation,
Task 014 Switch marker/tombstone mutation, and the final guard read used by
generation admission. Every worker process takes locks in this order only:
controller async lock, active-volume process lease, `.gpu-control-v1.lock`, then
manifest and operation-specific temp/rename writes. It never waits for network
I/O while holding the GPU-control lock. Stop finalization and Switch finalization
each reread both request and marker namespaces under this lock immediately
before committing their own marker. The controller-lock request matrix ensures
only one legitimate request can be finalizable. A stale/racing action that
began preflight earlier observes the winner and returns its exact 423 code
without writing. If both nonterminal namespaces already exist, neither is
chosen: the locked read returns `gpu_control_guard_conflict`. There is no
timestamp tie, last-writer win, implicit peer cancellation, or remove-and-retry
path.

A Switch generation/Stop/new-Switch guard exists only for a durable current
marker in `pausing`, `ready_to_delete`, `delete_intent`, or
`replacement_ready`. Pending/approved consent has no shared marker and follows
the atomic cancellation rules above. Pre-delete cancellation from `pausing`
retains the guard until the current claim reaches the same durable paused/
interrupted fixed point, then writes a cancelled tombstone and clears the marker
in one locked commit. Completion from `replacement_ready` does the analogous
completed tombstone/archive/clear commit. Only after that clear may a later
normal Stop or new Switch be evaluated; normal Stop still obeys Task 012's
active-batch veto/consent. Native `ready_paused` alone never releases the worker
guard.

Startup or any locked read that finds both nonterminal markers, an orphan temp
whose committed generation cannot be decided, or marker/tombstone disagreement
returns `gpu_control_guard_conflict`, keeps both bytes, and blocks generation and
provider mutation. Repair is explicit and shared-volume-scoped. Crash tests
cover before/after each file fsync, rename, directory fsync, and marker clear,
including simultaneous Stop/Switch writers.

### Native-only worker runtime identity

The authenticated route
`GET /v1/internal/gpu-switches/{switch_id}/runtime-identity?session_id=...`
is callable only by the Rust worker client over the pinned exact worker origin;
Tauri capabilities expose no arbitrary HTTP/URL call and the response is never
forwarded to renderer state. It requires the stored principal binding and
returns this strict owner-only projection:

```ts
interface WorkerCudaDeviceIdentityV1 {
  deviceIndex: 0;
  nvmlUuid: string;
  pciDeviceId: string;
  cudaName: string;
  totalMemoryBytes: number;
  computeCapabilityMajor: number;
  computeCapabilityMinor: number;
}
interface WorkerGpuSwitchRuntimeIdentityV1 {
  schema_version: 1;
  switch_id: string;
  principal_binding_id: string;
  server_instance_id: string;
  runtime_pod_id: string;
  runtime_volume_id: string;
  runtime_data_center_id: 'EU-RO-1';
  data_root_binding_sha256: string;
  expected_provider_gpu_id: string;
  device_count: 1;
  cuda_device: WorkerCudaDeviceIdentityV1;
  image_digest: string;
  model_id: 'black-forest-labs/FLUX.2-klein-4B';
  model_revision: string;
  create_contract_revision: 1;
  create_marker_sha256: string;
  replacement_attempt_id: string;
  replacement_attempt_revision: number;
}
```

NVML is the authority for UUID/name/PCI device/memory and CUDA is the authority
for count/compute capability; disagreement or unavailable NVML is
`gpu_switch_runtime_identity_unavailable`. `nvmlUuid` is strict
`^GPU-[0-9A-Fa-f-]{36}$`; PCI ID is lowercase `^0x[0-9a-f]{4}$`; CUDA name uses
`IMAGEFORGE_GPU_IDENTITY_V1`; memory/count/capability are bounded safe integers.
`data_root_binding_sha256` is
`sha256("imageforge-data-root-binding-v1\n" + runtime_volume_id + "\n" +
canonical-private-data-root)` and reveals no path.

A checked-in strict `gpu-runtime-identities/v1` table maps each exact approved
provider GPU ID to an allowlist of exact CUDA names, PCI device IDs, minimum
memory bytes, and minimum compute capability. Native first proves the provider
Pod projection's exact GPU ID, then requires the worker expected ID to equal it,
then validates the actual device against that table. Dynamic IDs without a table
entry are non-runnable even if catalog policy approves their name. The expected
ID/env value by itself is not proof. The public `/v1/health` remains its existing
redacted readiness/model phase only and must omit Pod/volume/data-root/image
digest, principal binding, device UUID/PCI/name, switch/attempt IDs, create
hashes, and runtime mapping details; foreign Studio views omit the same fields.

### Crash-atomic worker request envelope

Pending approval state is not process memory. Before returning from Switch
create, the worker commits one strict unknown-field-rejecting envelope at
`<IMAGEFORGE_DATA_ROOT>/.gpu-switch-requests-v1/<sha256-of-switch-id>.json`:

```ts
interface SharedGpuSwitchRequestEnvelopeV1 {
  schema_version: 1;
  envelope_revision: number;
  switch_id: string;
  request_fingerprint_sha256: string;
  requester_user_id: string;
  requester_session_id: string;
  principal_binding_id: string;
  active_request: GpuSwitchRequestViewV1 | null;
  terminal_tombstone: SharedGpuSwitchTombstoneV1 | null;
  created_at: string;
  updated_at: string;
}
```

Exactly one of `active_request` and `terminal_tombstone` is non-null. Revision 1
is either the admitted active request or a direct terminal cancellation; later
revisions increase by exactly one under `JS_SAFE_REVISION_V1`, and the only
forward transition is active to terminal. The worker-computed fingerprint is
`sha256(UTF8(JCS({schema_version:1,requester_user_id,request:
CreateGpuSwitchRequestV1})))`; `requester_user_id` comes only from the verified
principal and `request` includes the exact requester session. The client cannot
supply or override the fingerprint or principal binding.

The controller async lock, active-volume lease, and `.gpu-control-v1.lock`
serialize envelope admission and terminalization. One file generation is
written, file-fsynced, atomically renamed, and parent-directory-fsynced before
HTTP response. Worker startup validates/reconciles every envelope before its
health phase accepts coordination. A crash can therefore expose only no
envelope, an exact active request, or its exact terminal tombstone—never an
unbound request whose late replay can create a second identity. Same switch ID,
principal, session, and fingerprint replays the exact envelope; any mismatch
uses the generic identity/not-found policy without disclosing which field or
whether a tombstone exists. Envelopes/tombstones persist for the shared-volume
lifetime.

Native privately stores the canonical create bytes/hash and
`workerCreateState: 'send_pending' | 'sent_uncertain' | 'bound'` in its own
generation. `send_pending` is the only crash-safe proof that the first socket
write has not begun. If the state is `sent_uncertain`, Resume first performs
the exact private owner lookup. Exact 200 binds the active/terminal envelope.
Generic 404 changes no state: explicit Resume may replay only the identical
bytes with the same UUID, relying on the envelope fingerprint; it may not mint
a new UUID. Explicit **Cancel unresolved switch** calls the internal settling
route with the exact original request. Under the same locks, that route either
terminalizes the matching pending/approved request or creates a direct
`requester_cancelled` terminal envelope when none exists. A late original
create then collides with that durable tombstone and cannot become active.
Only after native reads that exact tombstone, persists matching local history,
and validates its hash may it clear the reservation. A 404, timer, relaunch,
transport error, or renderer assertion never releases it.

### Shared worker marker

The strict unknown-field-rejecting file is
`<IMAGEFORGE_DATA_ROOT>/.gpu-switch-v1.json`, maximum 8 KiB. It contains exactly:

```ts
interface SharedGpuSwitchMarkerV1 {
  schema_version: 1;
  switch_id: string;
  finalization_id: string;
  principal_binding_id: string;
  requester_user_id: string;
  requester_display_name: string;
  old_pod_id: string;
  old_gpu_id: string;
  initial_target_gpu_id: string;
  initial_replacement_attempt_id: string;
  batch_id: string | null;
  batch_owner_user_id: string | null;
  batch_state_at_finalization: 'running' | 'paused' | 'interrupted' | null;
  phase: 'pausing' | 'ready_to_delete' | 'delete_intent' | 'replacement_ready';
  replacement_attempt_id: string | null;
  replacement_attempt_revision: number | null;
  replacement_pod_id: string | null;
  actual_target_gpu_id: string | null;
  create_contract_revision: 1;
  create_marker_sha256: string | null;
  create_intent_sha256: string | null;
  create_wire_body_sha256: string | null;
  expected_volume_id: string;
  expected_data_center_id: 'EU-RO-1';
  expected_image_digest: string;
  expected_model_id: 'black-forest-labs/FLUX.2-klein-4B';
  expected_model_revision: string;
  requested_at: string;
  updated_at: string;
}
interface SharedGpuSwitchTombstoneV1 {
  schema_version: 1;
  switch_id: string;
  principal_binding_id: string;
  requester_user_id: string;
  finalization_id: string | null;
  terminal_state: 'completed' | 'cancelled' | 'denied' | 'expired';
  terminal_reason:
    | 'replacement_completed' | 'requester_cancelled' | 'peer_denied'
    | 'response_timeout' | 'requester_expired' | 'generation_started'
    | 'batch_changed' | 'stop_started' | 'target_changed_pre_delete';
  replacement_attempt_id: string | null;
  replacement_attempt_revision: number | null;
  replacement_pod_id: string | null;
  actual_target_gpu_id: string | null;
  terminal_at: string;
}
```

It is written only while holding the active-volume lease and
`.gpu-control-v1.lock` using temp file, file fsync, atomic rename, and
parent-directory fsync. Marker transition and
manifest writes follow the ordered recovery rule above; neither is deleted
until completion is durable. A completed marker is atomically archived under a
private bounded history directory before the current marker is cleared.
Malformed, oversized, conflicting, or identity-mismatched marker state is
public HTTP 503 `gpu_switch_store_corrupt` with fixed message `Worker GPU switch
history is unavailable. Repair the shared volume before changing compute.`,
null details, and no path/principal/Pod/exception disclosure. It makes
`/v1/status.permissions.can_create` false and blocks generation, Stop, and
Switch mutation. Valid owner manifest reads remain available. Desktop treats
the code as non-retryable and never performs a timer retry.
Startup finding both a nonterminal Switch marker and a Task 012 Stop
finalization marker is never resolved by timestamp or deletion. It fails closed
as HTTP 503 `gpu_control_guard_conflict` with fixed message `Worker GPU control
history conflicts. Repair the shared volume before changing compute.`, null
details, `can_create: false`, and no provider mutation.
Every terminal request, including denial/expiry/cancellation while only
pending/approved and therefore before a current marker exists, writes the exact
compact tombstone above under
`<IMAGEFORGE_DATA_ROOT>/.gpu-switch-tombstones-v1/<sha256-of-switch-id>.json`
with the same atomic/lease rules. Completion also archives the full safe marker
in bounded history. Tombstones remain for the shared-volume lifetime, so a
completed, cancelled, denied, or expired switch UUID can never become a fresh
destructive request after process restart or history cleanup.

Worker-to-native terminal mapping is fixed: `peer_denied -> denied`,
`response_timeout|requester_expired -> expired`, every explicit or atomic
pre-delete cancellation reason -> `cancelled`, and guard completion ->
`completed`. The worker tombstone commits first. Native exact owner lookup then
writes its immutable local history with the same switch ID, terminal state,
reason, principal-binding ID digest, and worker tombstone SHA-256 before clearing
the current local record/reservation. This ordering applies to every terminal
native outcome—`denied`, `expired`, `cancelled_pre_delete`, and `completed`—not
only switches that reached a worker guard. If native crashes between those stores,
Resume performs lookup and finishes only that history mapping; it never recreates
consent or provider intent. Except for a proven never-sent local draft as defined
in the native history schema, a native terminal record without the matching
worker tombstone is corruption, not authority. Replayed terminal UUIDs return generic
not-found/conflict without revealing state; native CSPRNG always supplies a new
UUID for the next Switch. Terminal writes and lookups are idempotent only for
the exact field tuple, and their commit order is covered at every crash seam.

## Exact worker HTTP wire contract

Every new HTTP object uses snake_case, `schema_version: 1`, strict Pydantic
unknown-field rejection, canonical lowercase UUIDv4, safe Pod/GPU strings,
RFC3339-millisecond timestamps, and the existing strict error envelope. Python,
Rust native projection, and TypeScript interfaces are field-for-field equal.
Display name is never authorization; authenticated `Principal.user_id` is.
Canonical UUIDv4 means
`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`.
Pod IDs use the existing
`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,56}[A-Za-z0-9])?$`; every GPU ID and GPU display
name uses the exact shared 1–128-byte `IMAGEFORGE_GPU_IDENTITY_V1` rule above;
authenticated user IDs retain
`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. Image identities are the configured
lowercase registry path plus `@sha256:` and 64 lowercase hex characters.
Participant arrays contain at most the existing 16 Studio sessions, contain one
entry per principal, and sort by `display_name` then `session_id` for stable
wire equality. Waiting projection uses that principal's lexicographically
lowest live foreground session ID; any of their sessions may submit the one
principal decision, after which approved/denied projection retains the exact
responding session ID. `StudioStateResponse.gpu_switch_can_respond` is one
required safe boolean personalized to `current_session`: it is true only while
that authenticated session is foreground, its principal is a still-waiting
non-requester participant, and the Switch is pending. It exposes no user ID,
principal binding, or authority; the worker still revalidates the principal and
session on POST. This bit is how a non-representative session of the same peer
receives an honest live control without using display name as identity. No
non-finite JSON number is valid.

```ts
type GpuSwitchDecisionV1 = 'approve' | 'deny';
type GpuSwitchWorkerStateV1 =
  | 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled'
  | 'pausing' | 'ready_to_delete' | 'delete_intent'
  | 'replacement_ready' | 'completed' | 'needs_attention';
type GpuSwitchReasonV1 =
  | 'peer_denied' | 'response_timeout' | 'requester_cancelled'
  | 'requester_expired' | 'generation_started' | 'batch_changed'
  | 'stop_started' | 'target_changed_pre_delete' | 'pause_failed' | 'replacement_mismatch'
  | 'completion_failed';

interface CreateGpuSwitchRequestV1 {
  schema_version: 1;
  switch_id: string;
  session_id: string;
  old_pod_id: string;
  old_gpu_id: string;
  old_gpu_display_name: string;
  initial_target_gpu_id: string;
  initial_target_gpu_display_name: string;
  initial_replacement_attempt_id: string;
  expected_batch_id: string | null;
  inventory_observed_at: string;
}
interface GpuSwitchResponseRequestV1 {
  schema_version: 1;
  session_id: string;
  decision: GpuSwitchDecisionV1;
}
interface FinalizeGpuSwitchRequestV1 {
  schema_version: 1;
  session_id: string;
  finalization_id: string;
}
interface DeleteIntentGpuSwitchRequestV1 {
  schema_version: 1;
  session_id: string;
  finalization_id: string;
}
interface AdoptGpuSwitchRequestV1 {
  schema_version: 1;
  session_id: string;
  finalization_id: string;
  replacement_attempt_id: string;
  replacement_attempt_revision: number;
  replacement_pod_id: string;
  target_gpu_id: string;
  create_contract_revision: 1;
  create_marker_sha256: string;
  create_intent_sha256: string;
  create_wire_body_sha256: string;
}
interface CompleteGpuSwitchRequestV1 {
  schema_version: 1;
  session_id: string;
  finalization_id: string;
  replacement_attempt_id: string;
  replacement_attempt_revision: number;
  replacement_pod_id: string;
}
interface CancelGpuSwitchRequestV1 {
  schema_version: 1;
  session_id: string;
  finalization_id: string | null;
}
interface SettleGpuSwitchCreateRequestV1 {
  schema_version: 1;
  action: 'cancel';
  create_request: CreateGpuSwitchRequestV1;
}
interface GpuSwitchParticipantV1 {
  session_id: string;
  display_name: string;
}
interface GpuSwitchBatchOwnerV1 {
  display_name: string;
}
interface GpuSwitchRequestViewV1 {
  schema_version: 1;
  switch_id: string;
  old_pod_id: string;
  old_gpu_id: string;
  old_gpu_display_name: string;
  initial_target_gpu_id: string;
  initial_target_gpu_display_name: string;
  initial_replacement_attempt_id: string;
  requester: GpuSwitchParticipantV1;
  state: GpuSwitchWorkerStateV1;
  reason: GpuSwitchReasonV1 | null;
  requested_at: string;
  response_deadline: string;
  ready_to_delete_at: string | null;
  waiting_for: GpuSwitchParticipantV1[];
  approved_by: GpuSwitchParticipantV1[];
  denied_by: GpuSwitchParticipantV1[];
  batch_id: string | null;
  batch_owner: GpuSwitchBatchOwnerV1 | null;
  batch_state_at_finalization: 'running' | 'paused' | 'interrupted' | null;
  replacement_attempt_id: string | null;
  replacement_attempt_revision: number | null;
  replacement_pod_id: string | null;
  actual_target_gpu_id: string | null;
}
interface GpuSwitchLookupResponseV1 {
  schema_version: 1;
  switch_id: string;
  state: GpuSwitchWorkerStateV1;
  replacement_attempt_id: string | null;
  replacement_attempt_revision: number | null;
  replacement_pod_id: string | null;
  actual_target_gpu_id: string | null;
}
interface NativeWorkerGpuSwitchCreateResponseV1 {
  schema_version: 1;
  request: GpuSwitchRequestViewV1;
  requester_user_id: string;
  principal_binding_id: string;
}
interface NativeWorkerGpuSwitchOwnerLookupV1 {
  schema_version: 1;
  switch_id: string;
  state: GpuSwitchWorkerStateV1;
  requester_user_id: string;
  principal_binding_id: string;
  finalization_id: string | null;
  terminal_tombstone_sha256: string | null;
  replacement_attempt_id: string | null;
  replacement_attempt_revision: number | null;
  replacement_pod_id: string | null;
  actual_target_gpu_id: string | null;
}
```

`requester_user_id`, `principal_binding_id`, `finalization_id`, and tombstone
hash exist only on the native-only create/owner-lookup transport. The worker
derives `requester_user_id` only from the authenticated principal and returns it
on both create and owner lookup so native can bind response-loss recovery; it is
never accepted from the renderer or inferred from a bearer/session token. All
four private fields are stripped before any Studio, status, reducer, component,
log, notification, or diagnostic projection. The
owner lookup has non-null `finalization_id` only after native/worker durable
finalization and non-null tombstone hash only in a terminal state. The shared
marker retains both private IDs so the native journal can recover after a worker
epoch change.
Cancel request `finalization_id` is null only in `pending`/`approved`; it must
equal the durable native/worker value in `pausing`/`ready_to_delete` and is
always rejected in `delete_intent` or later. Finalize is idempotent only for the
same switch/session/finalization tuple.
Adopt and Complete are likewise idempotent only for the exact stored principal,
finalization, attempt revision/ID, replacement Pod, and target tuple. A replay
after marker archival resolves from the tombstone; any mismatch returns the
generic adoption/finalization conflict without mutating the tombstone.

Routes and exact responses are:

An exact repeated create from the same authenticated principal and requester
session with identical immutable fields returns HTTP 201 and the existing view;
it never creates another request/marker. Same principal with different fields
returns `gpu_switch_identity_mismatch`. A foreign principal or a different
session attempting to reuse a pre-finalization ID receives generic
`gpu_switch_request_not_found`; no existence detail is disclosed. After a
durable marker exists, only the stored principal plus native finalization proof
may use the recovery routes.

| Method and route | Request | Success |
| --- | --- | --- |
| `GET /v1/studio/gpu-switches/{switch_id}?session_id={session_id}` | no body; canonical live session query | HTTP 200 safe `GpuSwitchLookupResponseV1` |
| `GET /v1/internal/gpu-switches/{switch_id}/owner?session_id={session_id}` | native-only pinned authenticated query | HTTP 200 private `NativeWorkerGpuSwitchOwnerLookupV1` |
| `POST /v1/studio/gpu-switches` | native-only `CreateGpuSwitchRequestV1` | HTTP 201 private `NativeWorkerGpuSwitchCreateResponseV1` |
| `POST /v1/internal/gpu-switches/{switch_id}/settle-create` | native-only `SettleGpuSwitchCreateRequestV1`; path/body IDs equal | HTTP 200 private terminal `NativeWorkerGpuSwitchOwnerLookupV1` |
| `POST /v1/studio/gpu-switches/{switch_id}/responses` | `GpuSwitchResponseRequestV1` | HTTP 200 `StudioStateResponse` |
| `POST /v1/studio/gpu-switches/{switch_id}/finalize` | `FinalizeGpuSwitchRequestV1` | HTTP 200 `StudioStateResponse` |
| `POST /v1/studio/gpu-switches/{switch_id}/delete-intent` | `DeleteIntentGpuSwitchRequestV1` | HTTP 200 `StudioStateResponse` |
| `POST /v1/studio/gpu-switches/{switch_id}/adopt` | `AdoptGpuSwitchRequestV1` | HTTP 200 `StudioStateResponse` |
| `POST /v1/studio/gpu-switches/{switch_id}/complete` | `CompleteGpuSwitchRequestV1` | HTTP 200 `StudioStateResponse` |
| `POST /v1/studio/gpu-switches/{switch_id}/cancel` | `CancelGpuSwitchRequestV1` | HTTP 200 `StudioStateResponse` |

`StudioStateResponse` adds required
`gpu_switch_request: GpuSwitchRequestViewV1 | null` and required personalized
`gpu_switch_can_respond: boolean`; every existing field and `stop_request`
remains unchanged. Public/foreign status, busy, errors, and
Studio lookup omit all private IDs/marker fields. Both lookup routes are
missing/foreign-generic 404. Before a durable marker the private owner route is
limited to the exact requester session; afterward, the stored authenticated
principal may recover from a new live session and Rust must compare the exact
principal-binding ID to its private journal before action. Completed owner
lookup remains available from the tombstone, closing a crash after worker
completion but before native history completion.

The internal settle-create route is accepted only from Rust over the pinned
worker origin after an explicit foreground **Cancel unresolved switch**. The
authenticated principal/session and every immutable field are recomputed into
the worker fingerprint; the route never trusts a supplied hash. Under the
controller/volume/GPU-control locks it terminalizes the exact pending/approved
envelope, idempotently replays the same terminal envelope, or writes a direct
terminal envelope when none exists. It never cancels a finalized marker and
never returns a generic 404 as success. Mismatch is the same non-disclosing
identity conflict, and only its returned tombstone hash can authorize native
history/reservation release.

`StatusResponse.permissions` adds exactly:

```ts
type GpuSwitchBlockCodeV1 =
  | 'requester_not_foreground' | 'runtime_identity_unavailable'
  | 'current_pod_unverified' | 'local_receipts_pending'
  | 'queue_dispatch_uncertain' | 'foreign_batch_owner_unavailable'
  | 'stop_request_in_progress' | 'gpu_stop_pending'
  | 'gpu_switch_request_in_progress' | 'gpu_switch_pending'
  | 'gpu_control_guard_conflict' | 'gpu_switch_store_corrupt';
interface GpuSwitchPermissionV1 {
  can_switch: boolean;
  switch_block_code: GpuSwitchBlockCodeV1 | null;
}
```

`can_switch` is true iff `switch_block_code` is null. It describes worker
coordination only; native inventory/queue/provider/profile gates may still
disable the UI. If several worker blocks exist, choose exactly this precedence:
store/guard corruption, durable Stop, durable Switch, pending Stop, pending
Switch, local receipts, queue ambiguity, current Pod/runtime identity, foreign
owner, requester foreground. Safe owner display/progress/waiting participant
data remains only in the authenticated Studio state objects with the existing
bounds; it is never copied into an error `details` object.

The block/action mapping is exact and exhaustive. If an action is attempted
while `can_switch` is false, the worker returns only the mapped action code and
status; no implementation may return the shorter projection code as an error or
choose a different alias:

| `GpuSwitchBlockCodeV1` | Action error code | HTTP |
| --- | --- | --- |
| `requester_not_foreground` | `gpu_switch_requester_not_foreground` | 423 |
| `runtime_identity_unavailable` | `gpu_switch_runtime_identity_unavailable` | 503 |
| `current_pod_unverified` | `gpu_switch_current_pod_unverified` | 409 |
| `local_receipts_pending` | `gpu_switch_local_receipts_pending` | 409 |
| `queue_dispatch_uncertain` | `gpu_switch_queue_dispatch_uncertain` | 423 |
| `foreign_batch_owner_unavailable` | `switch_owner_unavailable` | 423 |
| `stop_request_in_progress` | `stop_request_in_progress` | 409 |
| `gpu_stop_pending` | `gpu_stop_pending` | 423 |
| `gpu_switch_request_in_progress` | `gpu_switch_request_in_progress` | 409 |
| `gpu_switch_pending` | `gpu_switch_pending` | 423 |
| `gpu_control_guard_conflict` | `gpu_control_guard_conflict` | 503 |
| `gpu_switch_store_corrupt` | `gpu_switch_store_corrupt` | 503 |

Conversely, each action code in this table maps back to exactly its one block
whenever that condition remains observable. Codes outside the table are
operation/result errors and never populate `switch_block_code`. The checked-in
code registry contains these rows literally and schema/drift tests compare the
TypeScript union, Pydantic enum, Rust enum, HTTP table, and precedence list.

Normative worker errors are:

`gpu_switch_runtime_identity_unavailable` has fixed message `Worker runtime
identity is unavailable. Repair the ImageForge template before changing
compute.`, null details, and the same non-retryable parking behavior as marker
corruption. Every other message is authored from its stable code and the safe
meaning column below; **every new Task 014 error has `details: null` exactly**.
Owner/progress/requester/state/waiting data is read only from the bounded
authenticated Studio projection, never an error envelope. Raw exception,
provider text, path, principal ID, private UUID, body, or header is never
forwarded. Error messages are fixed checked-in strings of at most 160 UTF-8
bytes; no dynamic interpolation is allowed.

| HTTP | Code | Retryable by timer | Safe meaning |
| --- | --- | --- | --- |
| 404 | `gpu_switch_request_not_found` | no | Missing/foreign/stale switch; null details |
| 409 | `gpu_switch_request_in_progress` | no | Another pending/active switch; inspect authenticated Studio state |
| 409 | `gpu_switch_identity_mismatch` | no | Same UUID with different immutable inputs; null details |
| 409 | `gpu_switch_response_conflict` | no | Principal already gave another decision |
| 409 | `gpu_switch_response_not_allowed` | no | Principal/state cannot respond |
| 409 | `gpu_switch_approval_pending` | no | Approval unresolved; inspect authenticated Studio state |
| 409 | `gpu_switch_not_approved` | no | Request is not finalizable |
| 409 | `gpu_switch_finalization_mismatch` | no | Finalization/attempt identity differs; null details |
| 409 | `gpu_switch_cancel_not_allowed` | no | Delete intent already committed |
| 409 | `gpu_switch_adoption_mismatch` | no | Runtime/attempt/replacement identity differs; null details |
| 409 | `gpu_switch_batch_changed` | no | Active batch no longer matches the bound preflight |
| 409 | `gpu_switch_completion_not_ready` | no | Replacement/worker verification is not at its fixed point |
| 409 | `gpu_switch_current_pod_unverified` | no | Exact current runtime Pod binding is not authoritative |
| 409 | `gpu_switch_local_receipts_pending` | no | Device receipt fixed point must settle before interruption |
| 409 | `stop_request_in_progress` | no | Pending/approved Stop must resolve first |
| 423 | `gpu_switch_requester_not_foreground` | no | Exact requester session is not live and foreground |
| 423 | `switch_owner_unavailable` | no | Foreign active owner is not live/foreground |
| 423 | `gpu_switch_queue_dispatch_uncertain` | no | Local queue submission identity must reconcile first |
| 423 | `gpu_stop_pending` | no | Durable Stop finalization blocks Switch |
| 423 | `gpu_switch_pending` | no | Durable finalized switch blocks generation/Stop/new Switch |
| 423 | `queue_switch_pending` | no | Queue admission parked without cancelling consent |
| 503 | `gpu_switch_store_corrupt` | no | Fixed message and null details above |
| 503 | `gpu_switch_runtime_identity_unavailable` | no | Required Pod/volume/image runtime binding is absent; null details |
| 503 | `gpu_control_guard_conflict` | no | Switch and Stop durable guards conflict; fixed message/null details |
| 422 | `validation_error` | no | Existing strict safe validation envelope |

Transport retryability never authorizes automatic mutation retry. All
coordination and provider mutations require the same live authorization epoch
or a new explicit Resume-switch click.

## Canonical provider create, Pod projection, and fingerprints

The one logical old-Pod deletion is bound before its first wire attempt by:

```ts
interface RunPodOldDeleteIntentV1 {
  schema_version: 1;
  switch_id: string;
  finalization_id: string;
  old_pod_id: string;
  request_method: 'DELETE';
  request_path: string;
  request_query: '';
  worker_marker_sha256: string;
}
```

`request_path` is the pinned `/pods/<percent-encoded-stored-id>` path below and
the marker hash is the exact durable worker `delete_intent` bytes. Native
persists `deleteIntentSha256 = sha256(UTF8(JCS(RunPodOldDeleteIntentV1)))`
before attempt 1. Attempt 2 must reuse that exact hash/object; wire-attempt count
and transport response evidence are deliberately outside it. The object and its
private IDs/hash never cross IPC or logs.

Attempt revision 1 uses Pod name
`<configured-pod-prefix>-<replacement-attempt-uuid>`; every later revision uses
its own UUID suffix. That exact suffix is the provider-visible attempt marker.
The marker is necessary but never sufficient for adoption. The exact RunPod
create body is schema revision 1 with these keys and no others; optional
constraint keys are omitted, not null:

```ts
interface RunPodSwitchCreateBodyV1 {
  name: string;
  templateId: string;
  imageName: string;                 // immutable registry@sha256 digest
  networkVolumeId: string;
  volumeMountPath: string;
  ports: ['8000/http'];
  computeType: 'GPU';
  cloudType: 'SECURE';
  gpuTypeIds: [string];
  gpuTypePriority: 'custom';
  gpuCount: 1;
  interruptible: false;
  dataCenterIds: ['EU-RO-1'];
  env: {
    IMAGEFORGE_EXPECTED_GPU_TYPE_ID: string;
    IMAGEFORGE_GPU_SWITCH_ID: string;
    IMAGEFORGE_REPLACEMENT_ATTEMPT_ID: string;
    IMAGEFORGE_REPLACEMENT_ATTEMPT_REVISION: string;
    IMAGEFORGE_CREATE_CONTRACT_REVISION: '1';
    IMAGEFORGE_CREATE_MARKER_SHA256: string;
  };
  allowedCudaVersions?: ['13.0'];
  minRAMPerGPU?: number;
  minDiskBandwidthMBps?: number;
  minDownloadMbps?: number;
  minUploadMbps?: number;
}
interface RunPodNormalStartCreateBodyV1 {
  name: string;                      // configured prefix + operation UUID
  templateId: string;
  imageName: string;                 // immutable registry@sha256 digest
  networkVolumeId: string;
  volumeMountPath: string;
  ports: ['8000/http'];
  computeType: 'GPU';
  cloudType: 'SECURE';
  gpuTypeIds: string[];              // 1-20 unique receipt-derived IDs in order
  gpuTypePriority: 'custom';
  gpuCount: 1;
  interruptible: false;
  dataCenterIds: ['EU-RO-1'];
  allowedCudaVersions?: ['13.0'];
  minRAMPerGPU?: number;
  minDiskBandwidthMBps?: number;
  minDownloadMbps?: number;
  minUploadMbps?: number;
}
interface RunPodCreateIntentIdentityV1 {
  schema_version: 1;
  create_contract_revision: 1;
  switch_id: string;
  replacement_attempt_id: string;
  replacement_attempt_revision: number;
  request_body: RunPodSwitchCreateBodyV1;
}
interface RunPodCreateMarkerV1 {
  schema_version: 1;
  switch_id: string;
  replacement_attempt_id: string;
  replacement_attempt_revision: number;
  target_gpu_id: string;
}
```

Native first computes `create_marker_sha256 =
sha256(UTF8(JCS(RunPodCreateMarkerV1)))`, renders attempt revision as canonical
base-10 digits without sign/leading zero in env, and then constructs the body
from the locked profile/target; renderer input cannot provide arbitrary JSON or
env. The actual POST bytes are exactly UTF-8 RFC 8785
JCS of `RunPodSwitchCreateBodyV1` with no BOM or trailing LF. The private
`create_intent_sha256` is SHA-256 of UTF-8 JCS of
`RunPodCreateIntentIdentityV1`; `create_wire_body_sha256` is SHA-256 of the exact
POST bytes. Integers are decimal JSON integers, price is never in this body,
strings are JCS escaped without Unicode normalization, and missing optional
keys remain absent. The URL is the pinned configured HTTPS provider origin plus
literal `/pods` and an empty query; fragments, redirects across origin, userinfo,
and renderer URLs are forbidden. Cross-language checked-in golden vectors bind
the exact bytes/hashes; unordered `Record`/map serialization is invalid.

Native accepts HTTP 201 only. It retains the exact raw response-body byte hash
and a deterministic response fingerprint:

```ts
interface RunPodCreateResponseFingerprintV1 {
  schema_version: 1;
  request_method: 'POST';
  request_path: '/pods';
  request_query: '';
  request_body_sha256: string;
  response_status: 201;
  response_content_type: 'application/json';
  response_request_id: string | null;
  raw_response_body_sha256: string;
  pod: RunPodImmutablePodIdentityV1;
  observed_hourly_price_micro_usd: number | null;
  observed_created_at: string | null;
}
interface RunPodImmutablePodIdentityV1 {
  pod_id: string;
  pod_name: string;
  attempt_marker: string;
  template_id: string;
  image_identity: string;
  network_volume_id: string;
  volume_mount_path: string;
  worker_port: 8000;
  cloud: 'secure';
  data_center_id: 'EU-RO-1';
  gpu_id: string;
  gpu_display_name: string;
  gpu_count: 1;
  interruptible: false;
}
```

Header names are lowercased and OWS-trimmed. `Content-Type` must parse exactly
to media type `application/json`; parameters are discarded after strict parse.
The optional provider request ID is accepted only from lowercased
`x-request-id` and 1–128 visible ASCII bytes; duplicate selected headers invalidate the
response. Authorization, date, server, set-cookie, URL origin, proxy URL,
mutable desired/status, machine occupancy, and raw unknown fields are excluded.
The fingerprint is
`sha256(UTF8(JCS(RunPodCreateResponseFingerprintV1)))`. Body objects must expose
every immutable allowlist field, including `image_identity`; missing/null/
wrong-type fields make the 2xx result ambiguous. Price uses the canonical raw
parser above. Raw bytes are never stored in renderer/logs/fixtures with secrets;
only their hash and the validated safe allowlist persist privately.

Before POST, native commits `create_intent`, request bytes hash, intent hash, and
`post_send_pending`, then fsync/rename/directory-fsyncs. Immediately before the
socket write it commits `post_sent` and monotonic proof origin. After a valid 201
it commits Pod ID, transport/body/fingerprint hashes, immutable Pod identity,
and actual price before returning any safe snapshot. Crash/timeout after
`post_sent` but before that commit is `create_uncertain` and can use only the
settling proof/reconciliation path; it never repeats the POST.

Every later exact Pod GET/list projection is converted to
`RunPodImmutablePodIdentityV1` and fingerprinted with JCS. Immutable mismatch,
missing image identity, changed attempt marker, or a create response whose
validated identity differs from GET is non-retryable
`gpu_switch_provider_response_mismatch`; native does not adopt, delete, accept a
new attempt, or overwrite stored evidence. Mutable status/price is not an
identity mismatch. An actual price mismatch follows the explicit acknowledgement
rule and is visible as exact old/new micro-USD values. The corresponding DELETE
URL is constructed only as pinned origin + `/pods/` + percent-encoded stored Pod
ID with empty query; redirects or any other URL are rejected before I/O.

The only reconciliation reads are exact GET
`/pods/<percent-encoded-id>?includeMachine=true&includeNetworkVolume=true` and
profile list GET `/pods` with normalized query order
`computeType=GPU&includeMachine=true&includeNetworkVolume=true&templateId=<encoded>&networkVolumeId=<encoded>&dataCenterId=EU-RO-1`.
The parsed Pod projection must carry template ID, immutable `imageName`, network
volume ID/data center/mount, machine Secure/data center/GPU type, GPU count,
ports, interruptible, name/attempt marker, status, created time, and both raw
price fields. Unknown response fields never enter a fingerprint. Any redirect,
origin/path/query drift, omitted immutable image field, duplicate candidate, or
unvalidated percent encoding is an invalid/ambiguous read, never absence.

## Native journal, commands, and capability boundary

The native switch store is schema version 1 at the fixed private Tauri app-data
root `gpu-switch/v1`:

```text
gpu-switch/v1/
  CURRENT
  generations/<store-revision>.json
  history/<sha256-of-switch-id>.json
  QUEUE_RESERVATION
  QUEUE_RESERVATION.prev
  reservation-history/<sha256-of-switch-id>.json
  switch.lock
profile-control.lock
```

The current and previous two complete generations are retained. Every commit
validates expected revision and the entire prior/candidate transition, writes a
new immutable generation, file-fsyncs, atomically replaces `CURRENT`, and
fsyncs its parent. One OS/file lease excludes another process. Startup selects
the highest valid retained generation if `CURRENT` is damaged and reports
`gpu_switch_store_recovered`; it clears authorization and performs no provider
mutation. If no generation validates, it reports blocking
`gpu_switch_store_unrecoverable`, preserves/quarantines every byte, and exposes
read-only inventory/Pod status only. There is no destructive reset: losing an
old Pod/attempt identity cannot be made safe by clearing evidence. Recovery then
requires explicit operator/shared-volume/provider repair.
`QUEUE_RESERVATION` and its previous copy are each maximum 4 KiB and use this
strict unknown-field-rejecting private envelope; they are never sent to the
renderer:

```ts
type PrivateGpuSwitchQueueReservationPhaseV1 =
  | 'prepared' | 'active' | 'releasing';
interface PrivateGpuSwitchQueueReservationV1 {
  schemaVersion: 1;
  reservationRevision: number;
  switchId: string;
  phase: PrivateGpuSwitchQueueReservationPhaseV1;
  queueStoreRevision: number;
  queueRunRevision: string | null;
  nativeStoreRevision: number | null;
  nativeRecordRevision: number | null;
  terminalState:
    | 'completed' | 'cancelled_pre_delete' | 'denied' | 'expired' | null;
  workerTombstoneSha256: string | null;
  nativeHistorySha256: string | null;
  createdAt: string;
  updatedAt: string;
}
```

The switch ID and non-null queue run revision are canonical UUIDv4; revisions
obey their zero/positive `JS_SAFE_REVISION_V1` forms. `prepared` is revision 1,
has null native/terminal/hash fields, and is the first durable blocker before
the queue lease is released. `active` increments exactly once, binds the exact
committed native store/record revisions and Task 013 queue store/run revisions,
and has null terminal/hash fields. Its `queueStoreRevision` is the exact queue
generation committed by the park operation; it is not rewritten to a later
queue store revision created solely by an allowed `runRevision: null` Next-run
edit. `releasing` increments exactly once, retains
those immutable bindings, and is legal only after terminal worker lookup and
native history are durable; its terminal state and hashes equal that history.
For exact `local_draft_cancelled` only, the worker hash is null under the
never-sent proof, while the native history hash remains required. Every phase
still blocks queue Run/Resume/acquire/dispatch.

Writes preserve the previous validated file, temp-write/file-fsync/rename and
directory-fsync under `profile-control.lock`, and store the reservation SHA-256
in the corresponding private native generation. Queue pause/release and native
record transitions compare this envelope and the Task 013 store under the same
lock. Release commits in this order: worker tombstone when required, native
history, `releasing` envelope, current native-record clear, reservation-history
archive, then current reservation removal; the queue remains paused. A crash at
any seam leaves `prepared`, `active`, or `releasing` as a blocker and read-only
recovery completes only the exact transaction. Startup may use `.prev` only when
its switch/queue revisions match the Task 013 store and, for `active` or
`releasing`, its native revisions/hash match a retained native generation; a
`prepared` previous copy additionally requires the exact retained native draft
or proven-never-sent cancel evidence. Recovery reports
`gpu_switch_store_recovered`. Malformed, oversized, unknown-field, mismatched,
or unrecoverable reservation bytes return non-retryable
`gpu_switch_queue_reservation_corrupt`, preserve/quarantine both copies, and
block queue, Start, Stop, Switch, and provider mutation. Renderer state can
project only `{ active: true, queueRunRevision }`; it cannot author, clear, or
repair this envelope.

`history/<sha256-of-switch-id>.json` is this strict private terminal record,
written before current state/reservation clear and retained for the configured
profile's app-data lifetime:

```ts
type NativeGpuSwitchTerminalReasonV1 =
  | 'replacement_completed' | 'requester_cancelled' | 'peer_denied'
  | 'response_timeout' | 'requester_expired' | 'generation_started'
  | 'batch_changed' | 'stop_started' | 'target_changed_pre_delete'
  | 'local_draft_cancelled';
interface NativeGpuSwitchHistoryV1 {
  schemaVersion: 1;
  switchId: string;
  terminalState: 'completed' | 'cancelled_pre_delete' | 'denied' | 'expired';
  terminalReason: NativeGpuSwitchTerminalReasonV1;
  terminalAt: string;
  oldPodId: string;
  replacementPodId: string | null;
  finalAttemptId: string;
  principalBindingSha256: string | null;
  workerTombstoneSha256: string | null;
}
```

The principal-binding hash is
`sha256("imageforge-principal-binding-history-v1\n" + principalBindingId)`;
the raw binding stays only in active private generations. The hash and worker
tombstone hash may be null only for `terminalReason: 'local_draft_cancelled'`
when the prior native generation is durably `workerCreateState: 'send_pending'`,
contains no response/principal binding, and native proves the socket-write
boundary was never entered. The explicit foreground cancel commits this local
history and enters the `releasing` protocol under `profile-control.lock`; it cannot
be used once `sent_uncertain` was committed. In that state, even owner-lookup
404 requires the worker settle-create tombstone above. Otherwise both hashes
are required. Fields and hashes are
immutable and exactly match the worker tombstone mapping. Begin uses native-
generated UUIDs and rejects any collision present in current state or history;
history cleanup cannot make a destructive UUID reusable.

Private generations additionally bind the exact configured template, volume
ID/mount, datacenter, image digest, worker port, cloud lane, interruptibility,
GPU count, old/replacement provider response fingerprint, requester principal,
and native monotonic inventory receipt. Those fields never cross to the
renderer, logs, screenshots, notifications, or diagnostics.
Profile, network-volume, template, image-digest, and requester-credential
changes are disabled while a nonterminal switch exists. If external state no
longer matches, the journal parks as `gpu_switch_profile_locked`; it never
rebinds the transaction to another profile or principal.

The exact renderer projection contains no principal, finalization UUID, provider
grant/token, provider URL/body, raw response, runtime identity, or credential:

```ts
type NativeGpuSwitchPhaseV1 =
  | 'planned' | 'consent_pending' | 'pausing' | 'ready_to_delete'
  | 'delete_intent' | 'delete_uncertain' | 'old_absent'
  | 'create_intent' | 'create_uncertain' | 'replacement_identified'
  | 'provisioning' | 'replacement_failed'
  | 'replacement_delete_intent' | 'replacement_delete_uncertain'
  | 'ready_paused' | 'completed'
  | 'needs_attention' | 'cancelled_pre_delete';
type NativeGpuSwitchBlockedPhaseV1 = Exclude<
  NativeGpuSwitchPhaseV1,
  'needs_attention' | 'completed' | 'cancelled_pre_delete'
>;
type NativeGpuSwitchIssueCodeV1 =
  | 'gpu_switch_store_recovered' | 'gpu_switch_store_unrecoverable'
  | 'gpu_switch_active' | 'gpu_switch_not_found'
  | 'gpu_switch_revision_conflict' | 'gpu_switch_revision_exhausted'
  | 'gpu_switch_lease_busy' | 'gpu_switch_lease_required'
  | 'gpu_switch_transition_invalid'
  | 'gpu_switch_foreground_grant_required'
  | 'gpu_switch_foreground_grant_invalid'
  | 'gpu_switch_foreground_grant_expired'
  | 'gpu_switch_foreground_grant_consumed'
  | 'queue_gpu_switch_pending' | 'gpu_switch_queue_reservation_conflict'
  | 'gpu_switch_queue_reservation_corrupt'
  | 'gpu_switch_queue_dispatch_uncertain'
  | 'gpu_switch_local_receipts_pending'
  | 'gpu_switch_inventory_unavailable' | 'gpu_switch_inventory_stale'
  | 'gpu_switch_inventory_receipt_invalid' | 'gpu_switch_price_changed'
  | 'gpu_actual_price_changed' | 'gpu_actual_price_unavailable'
  | 'gpu_identity_invalid' | 'gpu_switch_target_unapproved'
  | 'gpu_switch_target_unavailable' | 'gpu_switch_current_pod_unverified'
  | 'gpu_switch_requester_not_foreground'
  | 'gpu_switch_old_pod_changed'
  | 'gpu_switch_old_pod_disappeared_early' | 'gpu_switch_profile_locked'
  | 'gpu_switch_worker_create_uncertain'
  | 'gpu_switch_worker_response_invalid'
  | 'gpu_switch_worker_guard_missing' | 'gpu_switch_delete_uncertain'
  | 'gpu_switch_create_uncertain' | 'gpu_switch_replacement_ambiguous'
  | 'gpu_switch_replacement_mismatch'
  | 'gpu_switch_provider_response_mismatch'
  | 'gpu_switch_zero_match_unproven'
  | 'gpu_switch_replacement_cleanup_required'
  | 'gpu_switch_replacement_delete_uncertain'
  | 'gpu_switch_peer_pod_present' | 'gpu_switch_peer_pod_overflow'
  | 'gpu_switch_quote_invalid' | 'gpu_switch_quote_expired'
  | 'gpu_switch_quote_consumed' | 'gpu_switch_pause_failed'
  | 'gpu_switch_completion_failed' | 'gpu_switch_cancel_not_allowed'
  | 'stop_request_in_progress' | 'gpu_stop_pending'
  | 'gpu_switch_request_in_progress' | 'gpu_switch_pending'
  | 'gpu_control_guard_conflict' | 'gpu_switch_store_corrupt'
  | 'gpu_switch_runtime_identity_unavailable';
type NativeGpuSwitchAttentionCodeV1 =
  | 'gpu_switch_revision_exhausted'
  | 'gpu_actual_price_changed' | 'gpu_actual_price_unavailable'
  | 'gpu_switch_target_unavailable' | 'gpu_switch_old_pod_changed'
  | 'gpu_switch_old_pod_disappeared_early' | 'gpu_switch_profile_locked'
  | 'gpu_switch_worker_create_uncertain'
  | 'gpu_switch_worker_response_invalid'
  | 'gpu_switch_worker_guard_missing' | 'gpu_switch_replacement_ambiguous'
  | 'gpu_switch_replacement_mismatch'
  | 'gpu_switch_provider_response_mismatch'
  | 'gpu_switch_zero_match_unproven'
  | 'gpu_switch_peer_pod_present' | 'gpu_switch_peer_pod_overflow'
  | 'gpu_switch_pause_failed' | 'gpu_switch_completion_failed'
  | 'gpu_switch_runtime_identity_unavailable';
interface NativeGpuSwitchIssueV1 {
  code: NativeGpuSwitchIssueCodeV1;
  retryable: boolean;
}
interface NativeGpuSwitchPodV1 {
  podId: string;
  gpuId: string;
  gpuDisplayName: string;
  hourlyPriceMicroUsd: number | null;
}
type NativeGpuObservedPodStatusV1 =
  | 'provisioning' | 'starting' | 'running' | 'exited'
  | 'error' | 'terminated' | 'unknown';
interface NativeGpuObservedPodV1 extends NativeGpuSwitchPodV1 {
  status: NativeGpuObservedPodStatusV1;
}
type NativeGpuPodObservationIssueV1 =
  | { code: 'gpu_pod_observation_unavailable'; retryable: true }
  | { code: 'gpu_pod_observation_invalid'; retryable: false };
interface NativeGpuPodObservationV1 {
  schemaVersion: 1;
  processEpochId: string;
  lifecycleRevision: number;
  state: 'offline' | 'single' | 'multiple' | 'unavailable';
  observedAt: string | null;
  stale: boolean;
  pods: NativeGpuObservedPodV1[];
  overflow: boolean;
  issue: NativeGpuPodObservationIssueV1 | null;
}
interface NativeGpuNormalStopV1 {
  podId: string;
  stopRequestId: string;
  sessionId: string;
  expectedServerInstanceId: string;
  expectedCoordinationRevision: number;
  expectedLifecycleRevision: number;
}
interface NativeGpuNormalStopResultV1 {
  schemaVersion: 1;
  operationId: string;
  podId: string;
  disposition: 'stopped' | 'already_stopped' | 'delete_uncertain';
  observation: NativeGpuPodObservationV1;
  issue:
    | { code: 'gpu_stop_delete_uncertain'; retryable: false }
    | null;
}
interface NativeGpuSwitchTargetV1 {
  replacementAttemptId: string;
  attemptRevision: number;
  gpuId: string;
  gpuDisplayName: string;
  hourlyPriceMicroUsd: number;
  observationId: string;
  receiptId: string;
  inventoryObservedAt: string;
  priceConfirmedAt: string;
}
interface NativeGpuSwitchPreparedTargetV1 {
  quoteId: string;
  preparedFromRecordRevision: number;
  gpuId: string;
  gpuDisplayName: string;
  hourlyPriceMicroUsd: number;
  observationId: string;
  receiptId: string;
  preparedAt: string;
  expiresAt: string;
}
interface NativeGpuSwitchPriorAttemptV1 extends NativeGpuSwitchTargetV1 {
  replacementPodId: string | null;
  outcome: 'not_created' | 'failed_replacement_deleted';
  settledAt: string;
}
interface NativeGpuSwitchQueueReservationV1 {
  active: boolean;
  queueRunRevision: string | null;
}
interface NativeGpuSwitchRecordV1 {
  schemaVersion: 1;
  switchId: string;
  recordRevision: number;
  phase: NativeGpuSwitchPhaseV1;
  blockedAt: NativeGpuSwitchBlockedPhaseV1 | null;
  attentionCode: NativeGpuSwitchAttentionCodeV1 | null;
  authorizationRequired: boolean;
  targetConfirmation: 'required' | 'confirmed';
  oldPod: NativeGpuSwitchPodV1;
  initialTarget: NativeGpuSwitchTargetV1;
  currentTarget: NativeGpuSwitchTargetV1;
  preparedTarget: NativeGpuSwitchPreparedTargetV1 | null;
  priorAttempts: NativeGpuSwitchPriorAttemptV1[];
  queueReservation: NativeGpuSwitchQueueReservationV1;
  expectedBatchId: string | null;
  oldDeleteWireAttempts: 0 | 1 | 2;
  replacementPodId: string | null;
  peerPodIds: string[];
  peerPodOverflow: boolean;
  actualHourlyPriceMicroUsd: number | null;
  confirmedActualPrice: boolean;
  createdAt: string;
  updatedAt: string;
}
interface NativeGpuSwitchSnapshotV1 {
  schemaVersion: 1;
  storeRevision: number;
  record: NativeGpuSwitchRecordV1 | null;
  issues: NativeGpuSwitchIssueV1[];
}
interface NativeGpuObservationChoiceV1 {
  observationId: string;
  receiptId: string;
  targetGpuId: string;
  confirmedHourlyPriceMicroUsd: number;
}
type NativeGpuSwitchForegroundActionV1 = 'begin' | 'resume';
type NativeGpuSwitchForegroundGrantRequestV1 =
  | { action: 'begin'; switchId: null;
      observationId: string; targetGpuId: string }
  | { action: 'resume'; switchId: string;
      observationId: null; targetGpuId: null };
interface NativeGpuSwitchForegroundGrantV1 {
  schemaVersion: 1;
  grantId: string;
  processEpochId: string;
  action: NativeGpuSwitchForegroundActionV1;
  expiresAt: string;
}
interface NativeGpuSwitchBeginV1 extends NativeGpuObservationChoiceV1 {
  expectedStoreRevision: number;
  sessionId: string;
  queueExpectedStoreRevision: number;
  queueRunRevision: string | null;
  foregroundGrantId: string;
}
interface NativeGpuSwitchKeyV1 { switchId: string }
interface NativeGpuSwitchAcquireV1 extends NativeGpuSwitchKeyV1 {
  foregroundGrantId: string;
}
interface NativeGpuSwitchRevisionKeyV1 extends NativeGpuSwitchKeyV1 {
  expectedRecordRevision: number;
}
interface NativeGpuSwitchWorkerSyncV1 extends NativeGpuSwitchRevisionKeyV1 {
  sessionId: string;
}
interface NativeGpuSwitchFreshWorkerV1
  extends NativeGpuSwitchWorkerSyncV1, NativeGpuObservationChoiceV1 {}
interface NativeGpuSwitchPrepareTargetV1
  extends NativeGpuSwitchRevisionKeyV1, NativeGpuObservationChoiceV1 {}
interface NativeGpuSwitchConfirmAttemptV1
  extends NativeGpuSwitchPrepareTargetV1 { quoteId: string }
interface NativeGpuSwitchProviderReconcileV1
  extends NativeGpuSwitchRevisionKeyV1 {
  reason:
    | 'resume' | 'after_delete' | 'after_create' | 'provisioning'
    | 'zero_match_proof' | 'after_replacement_delete';
}
interface NativeGpuSwitchReplacementDeleteV1
  extends NativeGpuSwitchRevisionKeyV1 {
  replacementPodId: string;
  reason: 'replacement_failed' | 'actual_price_rejected';
  confirmation:
    | 'TERMINATE FAILED REPLACEMENT'
    | 'TERMINATE UNACCEPTED REPLACEMENT';
}
interface NativeGpuSwitchActualPriceV1 extends NativeGpuSwitchRevisionKeyV1 {
  confirmedActualHourlyPriceMicroUsd: number;
}
interface NativeGpuSwitchLeaseV1 { switchId: string; held: boolean }
interface NativeManualGpuStartV1 extends NativeGpuObservationChoiceV1 {
  sessionId: string;
  expectedLifecycleRevision: number;
}
interface NativeAutoGpuStartV1 {
  observationId: string;
  receiptId: string;
  sessionId: string;
  expectedLifecycleRevision: number;
}
type NativeGpuStartIssueCodeV1 =
  | 'gpu_start_create_uncertain'
  | 'gpu_actual_price_changed'
  | 'gpu_actual_price_unavailable';
interface NativeGpuStartIssueV1 {
  code: NativeGpuStartIssueCodeV1;
  retryable: false;
}
interface NativeManualGpuStartResultV1 {
  schemaVersion: 1;
  operationId: string;
  lifecycleRevision: number;
  state: 'create_intent' | 'create_uncertain' | 'provisioning' | 'ready'
    | 'price_attention';
  pod: NativeGpuSwitchPodV1 | null;
  confirmedHourlyPriceMicroUsd: number;
  actualHourlyPriceMicroUsd: number | null;
  issue: NativeGpuStartIssueV1 | null;
}
interface NativeManualGpuActualPriceV1 {
  operationId: string;
  expectedLifecycleRevision: number;
  confirmedActualHourlyPriceMicroUsd: number;
}
```

The corresponding private native generation contains all safe fields plus exact
`requesterUserId`, `principalBindingId`, `workerFinalizationId`, profile and
credential-binding digests, current native process epoch/receipt evidence,
queue reservation generation, provider request/response fingerprints, zero-
match proof, runtime identity, and private grant-consumption ledger. Those
private fields are strict, durable where meaningful, immutable after binding,
and compared on every action. Process-local receipts/grants never become valid
merely because their IDs are persisted.

`recordRevision` starts at 1 and every non-no-op record mutation increments it
by exactly one; `storeRevision` likewise increments by exactly one per committed
generation. `blockedAt` and `attentionCode` are non-null if and only if `phase`
is `needs_attention`. In that phase, `blockedAt` is the immediately preceding
legal nonterminal phase, `attentionCode` is one exact
`NativeGpuSwitchAttentionCodeV1`, and the snapshot issues contain exactly one
matching primary issue plus at most the independent
`gpu_switch_store_recovered` startup notice. Worker-create uncertainty maps only
to `blockedAt: 'planned'`; pause failure only to `pausing`; actual-price issues
only to `replacement_identified` or `provisioning`; peer-Pod and provider-
identity issues only to a provider phase at or after `old_absent`; and worker
completion/runtime issues only to `provisioning` or `ready_paused`. Rust rejects
every other code/blocked-phase tuple. Outside `needs_attention`, both fields are
null; dedicated phases such as `delete_uncertain`, `create_uncertain`, and
`replacement_delete_uncertain` carry their state in `phase`, not a duplicate
attention code. Snapshot `issues` then contains only a store recovery/
unrecoverable issue; action errors are returned in the command envelope and are
not persisted as invented record attention. `authorizationRequired` is true whenever the exact lease/
epoch is absent and cannot become false from a persisted candidate. Initial
target confirmation is a separate safe durable projection: a new `planned`
record is `required`; `consent_pending` is `required` until the exact
`gpu_switch_confirm_target` revalidation commits it to `confirmed`; and every
later nonterminal provider/worker phase is `confirmed`. Native finalization
rejects `required`. This one-way field lets a reloaded renderer show exactly
**Confirm target** or **Finalize switch** without relying on memory or issuing
a duplicate confirmation. A cancelled pre-delete history may retain either
value, because it can terminalize from either pre-delete boundary. Initial
target, old Pod, switch ID, created time, principal binding, and expected batch
ID are immutable;
current target changes only through the explicit post-absence attempt rule.
`oldDeleteWireAttempts` is 0 before the initial old-Pod socket write, becomes 1
in the durable authority-consumption generation before that write, and may
become 2 only for the one explicit bounded Resume retry below. It never
decreases, skips, exceeds 2, or counts exact GET/list reconciliation reads.
Every phase before `delete_intent` requires 0; `delete_uncertain` requires 1 or
2; `old_absent` and every later phase retain 1 or 2 as immutable history. A
`delete_intent` generation may have 0 before a send or the current 1/2 after its
response, but a socket write is impossible until the increment is durable.
`priorAttempts` is append-only, sorted by contiguous attempt revision, and
finite; `currentTarget.attemptRevision` is exactly
`priorAttempts.length + 1`. `replacementPodId` is null before
`replacement_identified`; it may return to null only after the exact current
failed replacement is explicitly deleted, proven absent, and atomically moved
to `priorAttempts`. A prior `not_created` record has a null Pod ID; a
`failed_replacement_deleted` record has the exact non-null deleted Pod ID.
`actualHourlyPriceMicroUsd` is null before a replacement response and may remain
null only in price-unavailable attention. `confirmedActualPrice` is false until
the actual canonical price equals the attempt confirmation or the exact
`gpu_switch_confirm_actual_price` command confirms that same integer; a changed
value resets it false. Otherwise IDs are immutable. Rust enforces these relations
against the prior generation rather than
only validating candidate shape.

`contracts/gpu-switch-codes-v1.json` is the one authoritative registry for
every code above, its scope (`native_issue`, `native_attention`, `worker_block`,
or `worker_action`), retryability, HTTP status when applicable, permitted
blocked phases, and worker-block/action mapping. Rust, TypeScript, and Python
generate/validate against that same file. An unknown persisted native code makes
the store unrecoverable; an unknown native IPC code makes TypeScript reject the
whole object and show a static local **GPU switch state unavailable** fallback;
an unknown worker code becomes non-retryable
`gpu_switch_worker_response_invalid` without retaining the raw value. Unknown,
misspelled, or forward-version strings are never passed through, logged,
classified retryable, or used to authorize a transition.

`peerPodIds` is privacy-safe but bounded: it contains 1–16 unique, strictly
lexicographically sorted, validated Pod IDs exactly when a fully paginated fresh
profile list finds that many nonmatching managed Pods. It excludes the bound old
Pod and the exact current replacement. In that case `peerPodOverflow` is false
and `attentionCode` is `gpu_switch_peer_pod_present`. If a seventeenth
nonmatching Pod is observed, native stops collecting IDs, returns an empty
`peerPodIds`, sets `peerPodOverflow: true`, and uses
`gpu_switch_peer_pod_overflow`; the UI directs the user to the RunPod dashboard
and never displays a misleading partial list. All other states require an empty
array and false. Neither form authorizes deletion or adoption, and foreign
worker/status projections omit this native profile evidence.

The renderer may call only these new narrow commands, using the existing
`{ code, message, retryable }` native error envelope and camelCase objects over
snake_case `invoke` names. Provider and finalization transport helpers are not
registered with Tauri IPC:

```text
gpu_inventory_load() -> NativeGpuInventorySnapshotV1
gpu_inventory_begin_refresh({ includeEmergencyTier: boolean }) -> NativeGpuInventorySnapshotV1
gpu_start_load() -> NativeManualGpuStartResultV1 | null
gpu_start_auto({ input: NativeAutoGpuStartV1 }) -> NativeManualGpuStartResultV1
gpu_start_selected({ input: NativeManualGpuStartV1 }) -> NativeManualGpuStartResultV1
gpu_start_confirm_actual_price({ input: NativeManualGpuActualPriceV1 }) -> NativeManualGpuStartResultV1
gpu_pod_observe() -> NativeGpuPodObservationV1
gpu_normal_stop_load() -> NativeGpuNormalStopV1 | null
gpu_normal_stop({ input: NativeGpuNormalStopV1 }) -> NativeGpuNormalStopResultV1
gpu_switch_load() -> NativeGpuSwitchSnapshotV1
gpu_switch_authorize_foreground({ input: NativeGpuSwitchForegroundGrantRequestV1 }) -> NativeGpuSwitchForegroundGrantV1
gpu_switch_begin({ input: NativeGpuSwitchBeginV1 }) -> NativeGpuSwitchSnapshotV1
gpu_switch_acquire({ input: NativeGpuSwitchAcquireV1 }) -> NativeGpuSwitchLeaseV1
gpu_switch_release({ input: NativeGpuSwitchKeyV1 }) -> NativeGpuSwitchLeaseV1
gpu_switch_sync_worker({ input: NativeGpuSwitchWorkerSyncV1 }) -> NativeGpuSwitchSnapshotV1
gpu_switch_finalize({ input: NativeGpuSwitchFreshWorkerV1 }) -> NativeGpuSwitchSnapshotV1
gpu_switch_confirm_target({ input: NativeGpuSwitchPrepareTargetV1 }) -> NativeGpuSwitchSnapshotV1
gpu_switch_delete_old({ input: NativeGpuSwitchFreshWorkerV1 }) -> NativeGpuSwitchSnapshotV1
gpu_switch_prepare_attempt({ input: NativeGpuSwitchPrepareTargetV1 }) -> NativeGpuSwitchSnapshotV1
gpu_switch_confirm_attempt({ input: NativeGpuSwitchConfirmAttemptV1 }) -> NativeGpuSwitchSnapshotV1
gpu_switch_create_replacement({ input: NativeGpuSwitchFreshWorkerV1 }) -> NativeGpuSwitchSnapshotV1
gpu_switch_confirm_actual_price({ input: NativeGpuSwitchActualPriceV1 }) -> NativeGpuSwitchSnapshotV1
gpu_switch_delete_replacement({ input: NativeGpuSwitchReplacementDeleteV1 }) -> NativeGpuSwitchSnapshotV1
gpu_switch_reconcile_provider({ input: NativeGpuSwitchProviderReconcileV1 }) -> NativeGpuSwitchSnapshotV1
gpu_switch_verify_replacement({ input: NativeGpuSwitchWorkerSyncV1 }) -> NativeGpuSwitchSnapshotV1
gpu_switch_complete({ input: NativeGpuSwitchWorkerSyncV1 }) -> NativeGpuSwitchSnapshotV1
gpu_switch_cancel({ input: NativeGpuSwitchWorkerSyncV1 }) -> NativeGpuSwitchSnapshotV1
```

- `gpu_pod_observe` is the only production renderer command for ordinary
  current-Pod discovery. At the bound RunPod REST revision, `/pods` exposes no
  cursor/page request fields and a successful response is one complete
  top-level JSON array; exactly one profile-scoped GET is therefore the complete
  page set. Native never performs a catalog GET, coalesces overlapping
  2–5-second calls, and updates both the selector
  `currentPod` join and native verified-Pod registry. A successful projection
  has 0, 1, or 2–16 unique Pod IDs in strict lexicographic order and maps to
  `offline`, `single`, or `multiple` respectively, with non-null `observedAt`,
  `stale:false`, `overflow:false`, and null issue. More than 16 otherwise-valid
  managed Pods returns `state:'multiple'`, an empty Pod list,
  `overflow:true`, and `gpu_pod_observation_invalid`; no partial list crosses
  IPC. A provider/transport failure retains only the prior validated display
  projection, marks it `state:'unavailable'` and `stale:true`, and carries
  `gpu_pod_observation_unavailable`; without prior evidence its Pod list is
  empty and `observedAt` is null. Any object/cursor/continuation envelope is
  unknown/partial pagination. That shape, malformed fields,
  duplicate Pod identity, wrong profile/image/volume, unsafe price/GPU/status,
  or an illegal relation uses non-retryable `gpu_pod_observation_invalid` and
  never replaces the verified-Pod registry. The command is read-only: it mints
  no receipt/grant/provider authority and performs no provider mutation.
- `gpu_normal_stop` is the sole ordinary Task 012 provider-deletion owner. Its
  strict input contains no finalization ID, provider URL/path/query/body, or
  renderer operation ID. Under the shared profile-control lock, native rereads
  the exact Stop/Switch/queue guard state, performs a fresh profile-scoped Pod
  observation plus exact-Pod revalidation, verifies the approved Task 012
  request against the expected server instance, coordination revision,
  requester session, Pod, and lifecycle revision, then CSPRNG-generates the
  private finalization and operation IDs. Native calls the pinned worker
  Finalize endpoint, validates the exact finalizing projection, privately
  consumes one `{kind:'normal_stop',operationId,podId}` authority, and sends one
  exact DELETE. A pre-send validation/worker/guard failure sends zero DELETEs
  and preserves the existing Task 012/014 typed veto. `stopped` requires the
  successful DELETE plus a fresh post-delete observation. `already_stopped`
  is permitted only when the exact Pod passed preflight, DELETE returned exact
  404, and a successful fresh profile observation proves that same ID absent.
  Timeout, connection loss, 5xx/429, malformed response, or any ambiguous
  outcome returns `delete_uncertain` with exactly
  `gpu_stop_delete_uncertain`, preserves the worker finalization guard and
  current visible Pod evidence, performs no automatic retry, and never claims
  Offline. Only `delete_uncertain` has a non-null issue; the other dispositions
  require null. No finalization/private authority value crosses IPC.
- `gpu_normal_stop_load` is the only renderer recovery projection for an
  interrupted ordinary Stop. It returns the byte-identical persisted
  `NativeGpuNormalStopV1` only when the private journal is already at or beyond
  the durable DELETE ambiguity boundary and exact replay is therefore
  observation-only; otherwise it returns null. It exposes no operation ID,
  finalization ID, provider request, deletion grant, or raw worker evidence,
  performs zero provider/worker calls, and never turns a preflight-only crash
  into a DELETE. The production runtime calls it on relaunch before creating a
  new Stop request and may pass its result only to `gpu_normal_stop`; a freshly
  generated Studio session or recomputed lifecycle revision must not replace
  any field in that recovery input.
- Both projections are exact unknown-field-rejecting schemas. Pod IDs, GPU
  identities, UUIDs, times, microprices, status values, JS-safe revisions, and
  result relations use the same validators above. `processEpochId`,
  `operationId`, `stopRequestId`, `sessionId`, and `expectedServerInstanceId`
  are canonical lowercase UUIDv4 values; lifecycle/coordination revisions use
  `JS_SAFE_REVISION_V1`. Every command is main-window-only and participates in
  the shared command-list/schema parity tests.
- `contracts/gpu-pod-control-v1.schema.json` is the authoritative structural
  schema for `NativeGpuPodObservationV1`, `NativeGpuNormalStopV1`, and
  `NativeGpuNormalStopResultV1`. The mandatory semantic relation validator and
  `contracts/gpu-pod-control-v1.vectors.json` enforce sorted/unique Pod IDs,
  observation state/cardinality, stale/overflow/issue relations, result Pod-ID
  equality with the input, success/404 absence proof, uncertainty, raw
  canonical bytes, revision transitions, replay, and relaunch. Rust and
  TypeScript consume both files; CI rejects schema/vector/command-list drift.
- Pod-observation `lifecycleRevision` is process-epoch and bound-profile scoped.
  It starts at 0 before the first terminal observation and resets to 0 only on
  process relaunch or an exact profile rebind, which also invalidates the prior
  projection. Every distinct terminal profile-list attempt commits exactly
  `prior + 1`: success, transport-unavailable, malformed/invalid, and overflow
  are all new observable generations. Overlapping coalesced callers share one
  provider GET, one revision, and byte-identical output. On transport failure,
  the new generation is `unavailable`, stale, non-overflow, carries the retryable
  unavailable issue, and retains the prior validated Pods/observed time (or
  empty/null without prior evidence). A malformed/foreign/duplicate response
  has the same retained unavailable relation but the non-retryable invalid
  issue. The overflow generation is the sole exception: it is `multiple`,
  non-stale, has the current observed time, empty Pods, overflow true, and the
  invalid issue. At `Number.MAX_SAFE_INTEGER`, observation returns exact
  non-retryable `gpu_pod_revision_exhausted` — **GPU Pod history
  reached its safe revision limit. Export recovery evidence before
  continuing.** — before provider/worker/journal I/O and do not change bytes.
- A new `gpu_normal_stop` input must match the exact current observation
  revision and is admitted only when `R <= Number.MAX_SAFE_INTEGER - 2`.
  `R == MAX - 1` or `R == MAX` returns `gpu_pod_revision_exhausted` before
  provider, worker, or journal I/O and preserves all bytes. While holding the
  profile-control lock, an admitted Stop's fresh preflight commits
  revision `R + 1`; after the one DELETE response or ambiguity boundary it
  performs exactly one fresh profile observation and returns that generation
  at `R + 2`. No concurrent heartbeat can interleave. `stopped` and
  `already_stopped` require a successful fresh result observation:
  `stale:false`, `overflow:false`, null issue, state offline/single/multiple,
  and the old Pod ID absent. An overflow/invalid/retained projection is never
  absence proof. Another valid replacement/peer Pod remains in that projection
  and the state is not globally `offline`. `delete_uncertain` may carry a stale
  unavailable projection but still has the exact `R + 2` revision and always
  retains the old Pod ID as visible Stop-safety evidence. If the post-send read
  omits that ID, native retains the exact preflight Pod as stale/unavailable;
  an ambiguous DELETE can never publish `offline` or erase the target.
- Native persists normal Stop in the private GPU-control store before any
  socket write. Its strict current/previous generation binds the input SHA-256,
  private operation/finalization IDs, expected revisions/worker identity, phase
  (`preflight`, `delete_intent`, `delete_uncertain`, or `completed`), and
  `deleteWireAttempts: 0 | 1`. The counter becomes 1 atomically before the sole
  DELETE and never decreases or exceeds 1. A crash at/after that generation
  resumes as `delete_uncertain`; it never resends DELETE. Exact replay of a
  completed `stopped`/`already_stopped` input returns byte-identical durable
  result with zero provider/worker calls, but that embedded historical
  observation is receipt/history only (`replaceCurrentProjection:false`). It
  never replaces the new process epoch's Pod registry, clears a worker session,
  or authorizes lifecycle/generation; a current `gpu_pod_observe` is mandatory
  before those decisions. Exact replay/relaunch of `delete_uncertain` performs
  observation only, keeps the same durable operation ID, returns the current
  process epoch at exactly current revision + 1 with the old Pod retained, and
  replaces the live projection (`replaceCurrentProjection:true`); it sends zero
  DELETE/finalize calls. The worker
  finalization guard remains until its bounded TTL; after expiry native may
  settle/cancel that exact worker request only, without provider mutation, while
  retaining local uncertain history for manual RunPod-dashboard recovery. A
  reused request UUID/input hash mismatch returns exact non-retryable
  `gpu_stop_request_conflict` — **This GPU Stop request belongs to different
  immutable inputs. Refresh shared status before continuing.** — with zero I/O.
  `gpu_normal_stop_load` is how the production renderer reconstructs that exact
  uncertain input after a full app relaunch; it returns null for a missing,
  completed, conflicting, or preflight-only record. Completed history remains
  directly replayable when the exact caller input is already available, while
  ordinary startup establishes current lifecycle truth with `gpu_pod_observe`.

- `gpu_start_auto` owns the final inventory/profile refresh and private
  `normal_auto_start` authority. Renderer input contains no GPU list, price,
  provider URL/body, or grant: native recomputes the exact measured-value or
  fixed-policy order from the bound receipt and checked-in benchmark evidence,
  verifies the exact observation/receipt binding from the still-current Auto
  projection, and hashes that private order into the authority. The final
  refresh is stored and emitted through `gpu-inventory-v1`; it is never embedded
  in the Start result. An identical-semantic refresh promotes its new receipt
  and may continue. A changed winner, order, profile, policy, or price returns
  the bound action error before POST and requires another explicit **Start Auto
  best value** click against the newly emitted snapshot.
- `gpu_start_selected` owns the same final inventory/profile refresh and private
  `normal_manual_start` authority for one exact target and price. A changed
  quote returns before POST. After either Auto or manual creation,
  `gpu_start_confirm_actual_price` accepts only the exact stored operation ID,
  lifecycle revision, and latest canonical actual microprice; it never sends a
  create/delete and merely unlocks generation for that managed Pod.
- `gpu_start_auto`, `gpu_start_selected`, and
  `gpu_start_confirm_actual_price` each require an operating-system-native modal
  confirmation owned by the `main` window; no Start grant token crosses IPC.
  Native first rejects a caller whose window is not `main`, visible, focused,
  and not minimized. It may then read only the clicked receipt/journal fields
  needed to render the exact fixed prompt: action kind, Auto/manual target,
  canonical price when known, and the statement that one billed RunPod GPU may
  be created (or that the actual price will be accepted). Before acceptance it
  performs no inventory/profile/provider I/O and no journal mutation. The
  existing cross-platform native dialog implementation (`rfd` on macOS and
  Windows) supplies only **Cancel** and an exact affirmative label: **Start Auto
  GPU**, **Start selected GPU**, or **Accept actual price**. Cancel, close,
  background/focus loss while open, wrong window, or dialog failure returns
  `gpu_start_foreground_required` and consumes no authority. Acceptance mints a
  private one-use process authority bound to the exact command kind, caller
  window, input hash, process epoch, and a 5,000-monotonic-ms expiry; final
  preflight atomically consumes it before provider POST or price acceptance.
  Replay, another command, renderer replacement, suspend, focus loss, expiry,
  or relaunch invalidates it. Crafted renderer IPC can at most display the
  native prompt and cannot accept it. Tests inject a native dialog seam and
  assert cancel/wrong-window/focus-loss/replay perform zero provider calls and
  zero journal writes; installed macOS/Windows smoke clicks the real modal.
- `NativeAutoGpuStartV1` is an exact unknown-field-rejecting four-key object.
  `observationId`, `receiptId`, and `sessionId` are canonical lowercase UUIDv4;
  `expectedLifecycleRevision` obeys the zero-form `JS_SAFE_REVISION_V1` rule.
  Manual Start uses the same UUID/revision rules plus the exact observation
  choice relations above. `gpu_start_load` is the only read projection for an
  interrupted ordinary Start. A missing journal returns null; otherwise it
  returns the same strict result shape and never performs provider I/O.
  `lifecycleRevision` begins at 1 for a persisted intent, advances exactly one
  per non-no-op transition, and an exact replay returns the existing bytes. A
  command presented at `Number.MAX_SAFE_INTEGER` returns
  `gpu_start_revision_exhausted` without changing the journal or contacting the
  provider.
  The result issue is null except that `create_uncertain` requires
  `gpu_start_create_uncertain`, while `price_attention` requires exactly one of
  `gpu_actual_price_changed` or `gpu_actual_price_unavailable`. `create_intent`
  and `create_uncertain` require `pod:null`; `provisioning`, `ready`, and
  `price_attention` require the exact non-null managed Pod. `provisioning` and
  `ready` require `pod.hourlyPriceMicroUsd == confirmedHourlyPriceMicroUsd ==
  actualHourlyPriceMicroUsd` and null issue. Changed-price attention requires
  non-null actual/pod prices equal to each other and unequal to confirmed;
  unavailable-price attention requires both actual and Pod price null. Rust and
  TypeScript reject every other state/Pod/price/issue/revision tuple.

The ordinary native Start action-error registry is exhaustive and has no HTTP
status because these are local Tauri command failures. Every envelope is exactly
`{code,message,retryable}` with no details or raw provider data:

| Code | Retryable | Fixed safe message |
|---|---:|---|
| `gpu_start_revision_conflict` | yes | GPU start state changed. Reload and choose again. |
| `gpu_start_revision_exhausted` | no | GPU start history reached its safe revision limit. Export recovery evidence before continuing. |
| `gpu_start_foreground_required` | no | Use the focused ImageForge Start control to authorize this GPU action. |
| `gpu_start_inventory_stale` | yes | Live GPU inventory expired. Refresh GPUs and choose again. |
| `gpu_start_inventory_receipt_invalid` | no | The GPU inventory receipt is invalid for this app process. |
| `gpu_start_profile_locked` | no | The ImageForge GPU profile changed before Start. |
| `gpu_start_target_changed` | yes | The selected GPU changed. Review the refreshed choice. |
| `gpu_start_price_changed` | yes | The selected GPU price changed. Review and confirm the new price. |
| `gpu_start_existing_pod` | no | An ImageForge Pod already exists. Refresh before starting another. |
| `gpu_start_operation_in_progress` | yes | Another ImageForge GPU operation is already in progress. |
| `gpu_start_create_uncertain` | no | RunPod may have created the GPU. Resolve this Start before trying again. |
| `gpu_start_provider_response_invalid` | no | RunPod returned an invalid GPU response. |
| `gpu_start_store_unavailable` | yes | ImageForge could not access the GPU Start recovery journal. |
| `gpu_start_datacenters_unavailable` | yes | RunPod datacenters are unavailable. Refresh GPUs and try again. |
| `gpu_start_gpus_unavailable` | yes | RunPod GPU inventory is unavailable. Refresh GPUs and try again. |
| `gpu_start_inventory_response_invalid` | no | RunPod returned invalid live GPU inventory. |
| `gpu_start_region_unsupported` | no | Secure GPU inventory is unavailable in EU-RO-1. |
| `gpu_start_no_eligible_gpu` | yes | No eligible live ImageForge GPU is currently available. |
| `gpu_start_provider_auth_failed` | no | RunPod rejected the saved API credential. Replace it before starting a GPU. |
| `gpu_start_provider_timeout` | yes | RunPod did not answer the final GPU check. Try Start again. |
| `gpu_start_provider_unavailable` | yes | RunPod is unavailable for the final GPU check. Try Start again. |
| `gpu_start_provider_rate_limited` | yes | RunPod rate-limited the final GPU check. Wait, then try Start again. |

The final preflight mapping is closed. A datacenter GET failure, GPU GET
failure, malformed inventory, or missing `EU-RO-1` maps respectively from the
four `NativeGpuInventoryIssueV1` codes to
`gpu_start_datacenters_unavailable`, `gpu_start_gpus_unavailable`,
`gpu_start_inventory_response_invalid`, or `gpu_start_region_unsupported`.
A valid two-GET observation with no eligible receipt-bearing row maps to
`gpu_start_no_eligible_gpu`. Provider HTTP 401/403 maps to
`gpu_start_provider_auth_failed`; an elapsed native request deadline maps to
`gpu_start_provider_timeout`; connection/DNS/TLS or exact HTTP 5xx maps to
`gpu_start_provider_unavailable`; exact HTTP 429 maps to
`gpu_start_provider_rate_limited`. HTTP 3xx and every other complete non-auth,
non-429 4xx response during either inventory GET or the profile-scoped Pod-list
GET map to `gpu_start_provider_response_invalid`. A malformed profile response,
unknown/partial pagination, duplicate Pod identity, or ambiguous managed-Pod
projection also maps to `gpu_start_provider_response_invalid`; one or more
strictly valid managed profile Pods maps to `gpu_start_existing_pod`. These
pre-intent branches return before provider POST, preserve lifecycle bytes, and
store/emit the final terminal inventory snapshot when one was produced. They
never fabricate a `NativeManualGpuStartResultV1`.

After the create intent and socket-send boundary are durable, timeout,
connection loss, HTTP 5xx/429, truncated response, invalid JSON, or any invalid
HTTP 2xx body commits and returns strict `create_uncertain`, because the Pod may
exist. A complete HTTP 3xx or non-auth 4xx is a definitive non-creation only
when the pinned RunPod endpoint returns a fully received response before its
deadline; it maps to `gpu_start_provider_response_invalid` (401/403 map to
`gpu_start_provider_auth_failed`) and retains the intent as terminal rejected
evidence without permitting automatic replay. No retryable flag triggers a
provider mutation.

`contracts/gpu-start-auto-v1.schema.json` is the checked-in strict structural
JSON Schema for the Auto input/result union. Equality/inequality between prices
and JSON numeric-token spelling cannot be expressed portably by draft 2020-12;
the companion `validateNativeGpuStartRelationsV1` semantic validator is
mandatory in Rust and TypeScript and is exercised by the raw-byte and relation
vectors below. JSON decoding for this boundary first rejects exponent,
fractional, signed, leading-zero, unsafe, duplicate-key, BOM, and trailing-byte
revision/price tokens before schema validation. `contracts/gpu-start-auto-v1.vectors.json`
contains canonical accepted input/result bytes plus rejection vectors for every
unknown/missing field, malformed UUID, unsafe/skip revision, wrong-process or
expired receipt, emergency-policy mismatch, changed winner/order/price,
existing Pod, provider-response mismatch, create-response loss, replay, and
U128/request-body hash seam. It also contains concrete raw bytes for numeric
lexeme rejection, relation-invalid result objects, and one reproducible no-POST
fixture for every final-preflight mapping above. The top-level semantic fixture
binds input, process epoch, monotonic clock, receipt, catalog/profile snapshot,
benchmark evidence, provider script, and expected journal/provider counters.
Each semantic case supplies an exact `IMAGEFORGE_DEEP_OVERRIDE_V1` patch over
that base: recursively merge object members, replace arrays and scalar values
as a whole, preserve unmentioned members, and treat JSON `null` as a literal
replacement value. It has no implicit deletion operation. Rust and TypeScript
must implement those exact rules and reject any vector runner that substitutes
RFC 7396 merge-patch semantics. Thus `{"providerScript":null}` asserts that no
provider operation is available or performed; it never ambiguously inherits or
deletes the base script. Each accepted vector binds the input receipt to the
exact native-derived ordered GPU IDs, JCS create body,
request-body SHA-256, and
`normal_auto_start.orderedGpuIdsSha256`; renderer bytes never supply those
private fields. Rust and TypeScript load the same vectors, and CI rejects schema
or byte drift. For normal Auto/manual Start, native renders exactly
`RunPodNormalStartCreateBodyV1`; the ordered-ID hash is
`sha256(UTF8(JCS(gpuTypeIds)))` and the request-body hash is SHA-256 of the exact
UTF-8 JCS POST body, both with no BOM or trailing LF.

The production plugin capability is exactly
`src-tauri/capabilities/default.json`, identifier `main-capability`, window list
`["main"]`, and the two notification permission identifiers recorded in
`gpu-start-auto-v1.vectors.json`. Tauri app-owned commands do not have plugin
permission identifiers: their authoritative allowlist is the production
`tauri::generate_handler!` registration plus a mandatory native caller-window
check. Every Task 014 production command listed in the vector accepts the
calling `WebviewWindow`/label and rejects any label other than `main` before
reading a receipt or journal. The vector's `task014MainWindowCommands` array
must equal the Task 014 subset of `generate_handler!` exactly. The dedicated
`src-tauri/capabilities/qa-gpu-selector-perf-v1.json`, identifier
`qa-gpu-selector-perf-v1`, contains only the two QA permissions below and is
activated only by the installed release harness. Generic renderer
`runpod_inventory_http`, `runpod_list_pods_http`,
`runpod_create_pod_http`, `runpod_get_pod_http`, and
`runpod_terminate_pod_http` are the vector's explicit forbidden commands: after
migration they are absent from `generate_handler!`, from both capability files,
and from TypeScript invoke strings. Rust contract tests compare all three lists
and fail on an extra, missing, wrong-window, or legacy command. No unlisted
provider or finalization helper is registered.
- `gpu_switch_authorize_foreground` is the only way to mint Switch authority at
  IPC. Rust requires the calling ImageForge window to be visible, focused, not
  minimized, and the app foreground; the command is called synchronously from
  the labelled button's trusted primary-click or Enter/Space handler. A native
  per-window WebView input hook advances a private activation serial only for
  trusted primary pointer-up or keyboard activation; the renderer cannot read
  or supply that serial. Authorization requires its unconsumed age to be under
  1,000 monotonic ms and consumes it when minting the grant. Native
  CSPRNG-generates a canonical lowercase UUIDv4 `grantId`, binds it privately to
  the calling window, process epoch, action, exact switch ID for `resume` or
  exact observation/target for `begin`, and a 5,000-monotonic-ms expiry. The
  request is the strict unknown-field-rejecting discriminated union above;
  begin/resume nullability or field-shape mismatch is validation failure before
  a serial or grant is consumed. The
  returned object is only a safe opaque handle; its display `expiresAt` is not
  authority. Begin/acquire recheck focus and every binding, atomically consume
  the grant before changing state, and reject wrong kind/window/process/fields,
  expiry, or replay. One trusted activation can mint at most one grant. Crash,
  relaunch, OS suspend, focus loss before consumption, renderer replacement,
  or lease loss destroys it. Resume always needs a fresh `resume` grant; a
  durable record, renderer `isTrusted` assertion by itself, or a grant used for
  begin cannot satisfy Resume.
- `gpu_switch_begin` holds the global native profile-control lock through its
  local admission/queue transaction, requires one
  exact verified old Pod, a fresh mapped observation/receipt/price, no unresolved
  ordinary Start marker, no active Switch, no unsettled local receipts, and no
  queue dispatch/submission ambiguity. It derives old Pod/profile/batch fields,
  CSPRNG-generates switch and attempt IDs, and performs the atomic queue
  reservation protocol below; renderer inputs choose none of those identities.
  It consumes the exact `begin` foreground grant and acquires the switch lease in
  the same admission operation. After `planned` plus the active reservation are
  durable it releases the profile lock as bound below. Before the worker-create
  socket, it reacquires that lock, rereads the exact generation/reservation,
  durably commits `send_pending` then `sent_uncertain`, releases the lock again,
  and only then creates the worker request through pinned native transport. The
  active reservation is the cross-process blocker during the socket and owner
  reconciliation. After the response or owner lookup, native reacquires the
  lock, rereads the exact generation/reservation/revision, and only then binds
  the worker principal or parks the same transaction for attention. Native
  stores the worker-generated principal binding before returning safe
  `consent_pending`. Every CSPRNG ID is checked against current/native and worker
  terminal history; a collision regenerates the draft before consent or any
  provider/destructive action (read-only/private worker lookup is allowed).
- `gpu_switch_sync_worker` performs a pinned authenticated Studio GET itself and
  uses the owner-only exact switch lookup when current Studio projection is
  absent. It advances only when the exact worker projection/tombstone matches.
  Renderer-authored worker state cannot authorize deletion or completion.
- `gpu_switch_finalize` requires exact approved worker state and the exact fresh
  observation/receipt/target/price, CSPRNG-generates and privately persists one
  finalization UUID plus `pausing` intent, then calls worker Finalize itself.
  Response ambiguity is resolved only with the private owner lookup. No UUID or
  transport action crosses IPC, and idempotence uses only the stored value.
- `gpu_switch_confirm_target` performs its own live inventory read and accepts
  only the exact current target and exact micro-USD price returned by that
  read. It persists the new observation/confirmation; renderer price text is
  not authoritative. Before delete intent a different target requires worker
  cancellation, both terminal histories, reservation release, a fresh native
  switch ID, and new consent.
- `gpu_switch_delete_old` repeats exact worker/receipt/old-Pod/profile checks,
  calls worker delete-intent, persists native `delete_intent`, creates and
  consumes a private one-use `switch_delete_old` authority with wire attempt 1,
  and sends the bound initial DELETE itself. Under the bounded Resume rule it may
  consume one new authority for attempt 2 with the same delete-intent hash,
  exact Pod/path/query, and no other changed field. `gpu_switch_create_replacement` analogously requires
  old absence/fresh exact target, persists canonical body hashes and
  `create_intent`, privately consumes `switch_create`, and sends exactly one
  POST. Neither command returns before response/evidence commit or an
  uncertainty commit. Renderer never calls a generic HTTP primitive.
- `gpu_switch_prepare_attempt` stores only a native quote. Only
  `gpu_switch_confirm_attempt`, with the same unexpired observation/receipt and
  exact price, CSPRNG-generates the next contiguous attempt ID/revision. It is
  unavailable before old absence or without completed zero-match/cleanup proof.
  `quoteId` is a native-generated canonical lowercase UUIDv4, never a renderer
  UUID. Its private ledger binds the switch ID, held lease/process epoch,
  prepared-from record revision, exact next attempt revision, target GPU,
  observation/receipt/catalog digest, canonical microprice, profile digest, and
  a 60,000-monotonic-ms expiry. `preparedAt`/`expiresAt` are display-only UTC
  times. Confirmation requires
  `expectedRecordRevision == preparedFromRecordRevision`
  and every binding unchanged, then atomically marks the quote consumed in the
  same generation that creates the attempt. A successful commit makes replay
  `gpu_switch_quote_consumed`; expiry is `gpu_switch_quote_expired`; unknown,
  wrong-process, wrong-record, wrong-target, or collision is
  `gpu_switch_quote_invalid`. No failure consumes a new attempt revision. Crash
  before the atomic commit destroys the process-local quote and requires a new
  explicit prepare; crash after it recovers the already-created attempt from
  the journal and can never consume the quote twice.
- `gpu_switch_delete_replacement` requires the exact current response Pod,
  either pre-adoption failure or rejected actual-price attention, the matching
  literal confirmation, fresh provider identity, and no mismatch. It commits
  and consumes private
  `switch_delete_replacement` authority before one exact DELETE. Absence is
  reconciled read-only; timeout/5xx is `replacement_delete_uncertain`.
- `gpu_switch_reconcile_provider` is read-only. It owns exact GET/list/inventory
  evidence and is the only path from uncertain to absent/identified. Pod name
  alone, first list result, GPU label, or same owner is never a match.
- `gpu_switch_verify_replacement` performs exact RunPod and pinned worker
  verification and requires the worker `replacement_ready` projection. Complete
  calls the exact worker completion endpoint internally before journal
  completion; Cancel calls the exact worker cancellation endpoint, or the
  internal settle-create route only for the exact `sent_uncertain` draft, and is
  rejected at/after delete intent. Release is idempotent and cannot clear the
  durable journal.
- A second process can load safe display state but cannot acquire, authorize,
  reconcile a mutation outcome, cancel, or complete the active switch. Every
  non-read mutation requires the exact held switch lease and process-local
  authorization epoch.

The private provider authority is one strict discriminated union:

```ts
type PrivateNativeProviderAuthorityV1 =
  | { kind: 'normal_manual_start'; operationId: string; observationId: string;
      receiptId: string; gpuId: string; confirmedHourlyPriceMicroUsd: number;
      requestBodySha256: string }
  | { kind: 'normal_auto_start'; operationId: string; observationId: string;
      receiptId: string; orderedGpuIdsSha256: string;
      requestBodySha256: string }
  | { kind: 'normal_stop'; operationId: string; podId: string }
  | { kind: 'switch_delete_old'; switchId: string; recordRevision: number;
      podId: string; wireAttempt: 1 | 2; deleteIntentSha256: string;
      method: 'DELETE'; path: string; query: '' }
  | { kind: 'switch_create'; switchId: string; recordRevision: number;
      attemptId: string; attemptRevision: number; method: 'POST'; path: '/pods';
      query: ''; requestBodySha256: string }
  | { kind: 'switch_delete_replacement'; switchId: string;
      recordRevision: number; attemptId: string; podId: string;
      method: 'DELETE'; path: string; query: '' };
```

`normal_auto_start.receiptId` is always non-null. Auto provider creation requires
the same fresh process-epoch-mapped, under-60-second authoritative inventory
receipt and final two-GET/profile preflight as manual Start/Switch; its ordered
GPU IDs and request hash are derived from that receipt. `fallback`/`error`/
`loading`/`empty`, a checked-in order rendered without a receipt, or an expired/
wrong-process receipt is read-only explanatory policy and cannot mint
`normal_auto_start` authority or call POST. When measured quorum is unavailable
but live receipt-bearing inventory is valid, Auto may use Task 003's fixed order
intersected with that exact live inventory; “fixed fallback order” never means
provider creation from a no-receipt fallback snapshot.

Native generates an unguessable grant nonce, binds it privately to exactly one
union value, the pinned provider origin/credential binding, current process
epoch, held lifecycle/switch lease, and 30,000 monotonic-ms expiry, and consumes
it in the same native command immediately before network write. It is never
serialized or returned. Kind confusion, body/path/query/Pod/revision mismatch,
redirect, expiry, reuse, or lost lease fails before I/O. Existing generic RunPod
create/delete commands become private helpers; there is no optional
`switchContext` or renderer-supplied authority.

All ordinary Auto/manual Start, normal Stop, queue Run/Resume/dispatch, and
Switch commands take the same native profile-control lock and reread both the
native Switch record/reservation and worker marker before final I/O. Normal Pod
Start and Stop return `gpu_switch_request_in_progress` for `planned` or
`consent_pending`; they never cancel a draft or infer the old Pod absent. The
separate explicit **Cancel switch** action may terminalize a never-sent planned
draft as `local_draft_cancelled`, clear reservation under the same lock, and
leave the queue paused through the `releasing` protocol. A `sent_uncertain`
draft instead requires **Cancel unresolved switch** and the worker terminal
envelope; the ordinary local-draft action rejects it. An explicit foreground **Generate** on the existing
worker may cancel `consent_pending` only through the worker's
`generation_started` tombstone rule, after which native maps local history/
reservation before another provider action. At `pausing` or later, Start, Stop,
and generation all return `gpu_switch_pending`. Thus native pre-worker state and
shared worker state cannot disagree into an unguarded mutation.

The native retry rule is normative and exhaustive: every
`NativeGpuSwitchIssueCodeV1` has `retryable: false` except exactly
`gpu_switch_revision_conflict`, `gpu_switch_lease_busy`, and
`gpu_switch_inventory_unavailable`, which have `retryable: true`. The checked-in
registry generates the Rust/TypeScript enums and retry table. The following is
a non-normative human-readable index of the principal action meanings; omission
from this index never creates another code or changes the exhaustive retry rule:

| Code | Retryable | Meaning |
| --- | --- | --- |
| `gpu_switch_store_recovered` | no | Last-known-good generation loaded; authorization required |
| `gpu_switch_store_unrecoverable` | no | No safe provider mutation until manual repair |
| `gpu_switch_active` | no | Another nonterminal switch owns the profile |
| `gpu_switch_not_found` | no | Exact switch is absent/stale |
| `gpu_switch_revision_conflict` | yes | Reload then require explicit action again |
| `gpu_switch_lease_busy` | yes | Another local process owns the transaction |
| `gpu_switch_lease_required` | no | Current process lacks exact authorization |
| `gpu_switch_transition_invalid` | no | Candidate/event violates the frozen table |
| `queue_gpu_switch_pending` | no | Durable Switch reservation blocks queue admission |
| `gpu_switch_queue_reservation_conflict` | no | Queue revision/runner changed before atomic reservation |
| `gpu_switch_local_receipts_pending` | no | Finish current device saving before Switch |
| `gpu_switch_inventory_unavailable` | yes | Read-only refresh may be retried manually |
| `gpu_switch_inventory_stale` | no | Refresh before selection |
| `gpu_switch_inventory_receipt_invalid` | no | Observation/receipt/process epoch/digest does not match |
| `gpu_switch_price_changed` | no | Explicitly confirm the fresh exact USD/hour value |
| `gpu_actual_price_changed` | no | Created Pod price needs exact acknowledgement; no auto-delete |
| `gpu_actual_price_unavailable` | no | Created Pod price cannot be confirmed; refresh or explicit cleanup |
| `gpu_identity_invalid` | no | GPU ID/name violates shared v1 identity; explicit repair |
| `gpu_switch_target_unapproved` | no | Exact catalog ID violates policy |
| `gpu_switch_target_unavailable` | no | Explicit same/new target action required |
| `gpu_switch_old_pod_changed` | no | Exact old identity/profile changed; no DELETE |
| `gpu_switch_old_pod_disappeared_early` | no | External pre-intent loss requires operator recovery |
| `gpu_switch_profile_locked` | no | Bound profile/principal changed; no rebind or mutation |
| `gpu_switch_worker_guard_missing` | no | Worker is not durably ready to delete |
| `gpu_switch_delete_uncertain` | no | Reconcile exact old ID; no POST |
| `gpu_switch_create_uncertain` | no | Reconcile exact attempt; no second POST |
| `gpu_switch_replacement_ambiguous` | no | Zero/multiple safe matches; manual attention |
| `gpu_switch_replacement_mismatch` | no | Pod/worker/profile/volume/attempt mismatch |
| `gpu_switch_provider_response_mismatch` | no | Immutable create/GET identity fingerprint differs |
| `gpu_switch_zero_match_unproven` | no | Settling observations do not yet permit attempt N+1 |
| `gpu_switch_replacement_cleanup_required` | no | Explicit exact failed-Pod confirmation is required |
| `gpu_switch_replacement_delete_uncertain` | no | Reconcile exact failed Pod; no new POST |
| `gpu_switch_peer_pod_present` | no | Nonmatching profile Pod blocks mutation |
| `gpu_switch_cancel_not_allowed` | no | Delete intent made the saga forward-only |

`retryable: true` permits an explicit reload/retry control; it never schedules a
timer mutation.

## Exact provider mutation and recovery ordering

1. The user opens the picker; ImageForge observes live policy-approved inventory
   without changing the current lifecycle phase.
2. The user chooses one exact non-current target and confirms the current/target
   GPU, observed prices, current-frame pause, permanent old-Pod termination,
   possible target loss, same-volume recovery, downtime, and manual Resume.
3. One `gpu_switch_begin` command holds `profile-control.lock`, writes the queue
   reservation, durably parks the queue, releases its runner/keep-awake, commits
   native `planned`, and acquires the exact switch lease. It then releases the
   lock because the active reservation is durable, prepares the pinned worker
   request, reacquires the lock for the exact disk/revision read plus durable
   `send_pending`/`sent_uncertain` boundary, releases it before the socket, and
   binds the worker-generated principal ID from the response/owner proof. The
   lock/order is the queue protocol above; there is no release-to-planned or
   unguarded worker-send gap.
4. Required principals approve. Finalization persists the worker marker and
   pauses at the exact artifact-safe boundary. Native independently observes
   `ready_to_delete`.
5. Native calls worker delete-intent, persists native `delete_intent`, creates
   and immediately consumes one private exact authority, then itself sends
   DELETE for only the stored old Pod ID. No grant or URL crosses IPC.
6. No create is authorized until exact old absence is proven. DELETE ambiguity
   remains `delete_uncertain`. This is one logical deletion with at most two
   wire calls: the initial attempt plus exactly one explicit **Resume switch**
   retry. Retry requires `oldDeleteWireAttempts == 1`, fresh foreground grant/
   lease, the same worker delete-intent and hash, an exact GET 200 that revalidates
   the stored old Pod identity, and a fresh profile list containing that same ID
   without an ambiguous peer/replacement. Native durably increments the counter
   to 2 and consumes a new one-use authority before the second socket write; it
   cannot change method/path/query/Pod or create a new logical intent. If attempt
   2 is also ambiguous, every later Resume is read-only reconciliation and the
   UI requires manual provider attention—there is never a third DELETE. A
   DELETE 404 (or later exact GET 404) satisfies only the exact-ID leg: native retains `delete_intent`/
   `delete_uncertain` and must also complete a fresh fully validated profile-
   scoped Pod list containing no same-ID record before `old_absent` or any POST.
   DELETE 404 alone is never idempotent transaction success and can never
   authorize create.
7. Native refetches one logical inventory observation/list, validates the exact
   receipt/target/profile and zero conflicting Pods, persists `create_intent`
   plus canonical hashes, then privately sends one singleton-target POST.
   Provider unavailability leaves `old_absent`; no fallback occurs.
8. Response loss/invalidity becomes `create_uncertain`. Resume performs only
   exact attempt reconciliation. Zero proven matches permits a new explicit
   attempt; one exact match is adopted; multiple/foreign/profile-mismatched
   matches park for manual attention. No automatic Pod is deleted.
9. The exact replacement progresses through provisioning/loading/warming. A
   pre-adoption provider/health failure parks at `replacement_failed`; only the
   explicit exact-Pod cleanup flow may terminate it, prove it absent, archive
   the attempt, and enable a new requester-authorized attempt. A provisioning
   timeout alone never sends DELETE.
10. A
   changed/late old heartbeat cannot restore old authority. Native and worker
   verify all identities, the new worker adopts the shared marker, and the
   transaction reaches `ready_paused` then `completed`.
11. The UI presents **GPU ready — batch and queue are paused** with separate
    existing **Resume batch** or **Resume queue** controls. It never resumes or
    stops compute automatically.

On wake/relaunch, ImageForge loads the journal, marks
`authorizationRequired: true`, performs no mutation, and shows one **Resume
switch** action. That click acquires the lease and performs, in order: exact
journal validation, exact provider list/get reconciliation, pinned worker
Studio/status when a worker exists, queue park verification, then the next
state-specific action. No name-based adoption, blind DELETE/POST, or detached
service is permitted.

## Queue, alarm, and power interaction

- `profile-control.lock` is held by queue runner acquire/release, Run/Resume,
  `queue_prepare_dispatch`, ordinary Start/Stop, and every Switch command. Under
  that one lock, `gpu_switch_begin` validates no dispatch/submission uncertainty,
  CSPRNG-generates switch/attempt IDs, and atomically reserves the profile in
  this crash order: (1) write/fsync/rename/directory-fsync
  `QUEUE_RESERVATION` with switch ID, queue store revision, optional current run
  revision, and phase `prepared`; (2) commit the Task 013 runner to `paused`
  while the accepted item stays `active` or truthfully `interrupted`; (3) release
  that exact runner lease and its keep-awake assertion; (4) commit native
  `planned` plus reservation phase `active`; then release the profile lock. If
  no run exists, the reservation records null run revision but still blocks a
  new runner. No instant exists in which the queue lease is released and a peer
  can acquire before Switch reservation is durable.
  Worker-create preparation occurs only after that active reservation exists.
  Immediately before its only socket write, begin reacquires this same lock,
  rejects any disk generation/reservation mismatch, durably crosses
  `send_pending` to `sent_uncertain`, and releases the lock; it never holds the
  profile lock across the worker network request.
  The response/owner-lookup path likewise reacquires the lock for its exact
  disk/revision reread and principal-binding or attention commit; it does not
  mutate the journal directly from a stale pre-network projection.
- Every queue acquire/Run/Resume/dispatch checks `QUEUE_RESERVATION` while
  holding `profile-control.lock`. `prepared`, `active`, or `releasing` returns HTTP/native
  `queue_gpu_switch_pending`; it cannot be cancelled by a peer queue action.
  A crash at any reservation step leaves a durable blocker; read-only recovery
  either finishes the exact planned record or, only with durable `send_pending`
  proof before any socket write, writes `local_draft_cancelled` history after an
  explicit foreground action. `sent_uncertain` must use worker lookup/settling
  and matching tombstone first.
  Staging/editing a `runRevision: null` Next-run item remains allowed, but no
  current-cohort mutation or admission is allowed. Such a commit may advance the
  Task 013 store after the park generation—even between park completion and the
  active native commit—without changing the reservation's immutable
  `queueStoreRevision`; restart/recovery treats that value as the park proof, not
  as a requirement that it equal the latest unrelated Next-run-only generation.
- Reservation stays active through every nonterminal state, `needs_attention`,
  native `ready_paused`, worker-create uncertainty, and an owner-lookup 404. It
  clears only after exact worker terminal tombstone and matching native terminal
  history are durable for each terminal outcome: `denied`, `expired`,
  `cancelled_pre_delete`, or `completed`. The sole no-worker-tombstone exception
  is exact `local_draft_cancelled` under the proven-never-sent rule above; its
  local history and clear are one profile-locked commit. Clearing never occurs
  from a renderer projection, timeout, or retryable issue. It does not reacquire
  the runner, restore keep-awake, Resume a batch/queue, dispatch an item, or
  create/acknowledge an alarm; the queue remains durably paused for the existing
  explicit Resume after denial, expiry, cancellation, or completion.
  Switch itself never acquires keep-awake. The display/system follows ordinary
  OS power behavior.
- Dispatching/submission-uncertain state blocks reservation until Task 013 exact
  lookup resolves it. Queue item/run IDs never enter worker/provider requests;
  only the private local reservation carries the queue run revision.
- Switch does not create, arm, ring, snooze, dismiss, or acknowledge a queue
  alarm. A pre-existing completion alarm remains independent. A nonterminal
  queue cannot reach its completion fixed point merely because the batch was
  paused, Pod deleted, replacement became Ready, or switch completed.
- After replacement, **Resume queue** follows Task 013 exactly: acquire its
  runner, perform owner-only lookup by the existing client submission ID before
  status/local preflight, verify the changed Pod and exact recovered manifest,
  then use the existing explicit owner Resume. It never attaches by batch name,
  owner summary, or progress.
- Switch denial/cancellation never auto-resumes a queue. The user explicitly
  resumes it because the pre-switch park was durable. Stop GPU remains a
  separate confirmation/consent flow and is never called by switch failure,
  completion, alarm, or queue code.

## Minimal UI and accessibility contract

- The existing top status bar's current GPU chip is the sole entry point. When
  offline it opens **Choose a GPU**; with one current Pod it opens **Current GPU
  / Switch GPU**. There is no new navigation destination, dashboard card,
  decorative utilization gauge, or searchable catalog for eight policy rows.
- The compact sheet pins the current GPU, then shows **Auto best value** only in
  offline Start mode, followed by ordinary approved rows and the opt-in
  emergency row. Each row has exact name, VRAM, availability, observed price/hr,
  Speed score, `Benchmark expired`, or `Unmeasured`; estimated cost or `—`; and observation age.
  Current/unavailable/inventory-stale/unknown-price/unapproved rows are disabled
  with one reason. Benchmark-stale rows remain manually selectable under the
  separate rule above. Selecting a row does nothing until the explicit primary
  button.
- Confirmation names old and target GPUs and observed hourly prices and says:
  the current image will finish; the batch and local queue will stay paused;
  the old Pod will be permanently terminated; the target may become unavailable;
  the same network volume is preserved; there may be downtime; the GPU keeps
  billing after readiness; and Resume/Stop remain explicit.
- The offline manual-Start and initial Switch confirmations are true modal
  dialogs: initial focus is the non-destructive **Cancel / Keep current GPU**
  button, Tab/Shift+Tab are trapped, background content is inert, Escape closes
  with zero state/worker/provider mutation, and close restores focus to the
  exact GPU chip/row that opened it. The explicit destructive primary button is
  never default-focused. Once a Switch is durable, Escape only closes the
  progress presentation and cannot cancel the saga; cancellation has its own
  labelled button and native guard.
- A peer approval banner/dialog says who requested replacement, the old GPU,
  initial target, current batch owner/progress, and deadline. Controls are
  **Keep current GPU** and **Approve switch after this image**. Approval copy
  explains that a later recovery attempt may choose another policy-approved GPU
  only after the old Pod is already gone.
- A peer-approval dialog initially focuses **Keep current GPU**, traps focus,
  and restores focus to the banner trigger. Escape closes without recording a
  decision; the persistent banner/deadline remains, and only the labelled
  buttons send approve/deny. Deadline expiry is worker-authored, not a UI timer
  click. Each participant/state transition is announced once per switch ID and
  worker revision.
- Authored states cover inventory loading/stale/error/empty, benchmark expired,
  benchmark unmeasured, consent waiting,
  owner unavailable, denied/expired, finishing current image, ready to delete,
  deleting, delete uncertain, target unavailable, creating, create uncertain,
  duplicate/peer Pod, actual-price changed, preparing/confirming another target,
  zero-match settling proof, provisioning/loading/warming, replacement mismatch,
  ready-paused, authorization required, completed, journal/worker corruption,
  and offline recovery. No state claims `Switched` before worker completion.
- Semantic list/radio/button/dialog elements, visible focus, keyboard row
  movement/selection, Escape without mutation, focus return, polite progress
  announcements, assertive destructive/attention announcements, non-color
  availability, reduced motion, contrast, and screen-reader labels are binding.
  At 1280×720, 1440×900, and 1920×1080 the sheet has no horizontal overflow or
  clipped primary action. At most 20 GPU-row elements are mounted.

### Installed selector interaction performance gate

The production macOS Apple-silicon and Windows-x64 installed artifacts run the
same deterministic 10-row fixture: pinned current, Auto, seven ordinary policy
rows, and opted-in emergency. The provider/worker are local deterministic
servers, reduced motion is on, and no network completion time is measured. Each
platform runs at 1280×720 and 1440×900. After three unrecorded warm-ups where
applicable, it records exactly 30 valid samples for each action:

- `cold_open`: a newly launched process whose selector has never mounted; click
  the GPU chip and end at the first painted sheet with all loading/skeleton
  semantics and stable focus. Each sample uses a new process; there is no warm-up.
- `warm_open`: close a previously rendered sheet, click the chip, and end at the
  first painted stable 10-row sheet with restored focus rules.
- `refresh_loading`: click **Refresh GPUs** and end at the first painted loading
  state with the stale receipt disabled; provider response completion is not in
  this input-feedback metric.
- `keyboard_move`: with an exact selectable row focused, alternate ArrowDown and
  ArrowUp and end when the next row's visible focus and active-descendant state
  have painted.
- `keyboard_select`: alternate Space selection/clear on an exact selectable row
  and end when row selection and primary-action enabled state have painted.

The native trusted-input hook starts a private sample with its monotonic clock
at pointer-up/keydown. After React commits the required observable state, a
double `requestAnimationFrame` calls the narrow QA measurement bridge; native
timestamps receipt with the same monotonic clock, so the conservative duration
includes the post-paint IPC and no cross-clock subtraction. The bridge accepts
only a native-issued sample UUID, exact action/viewport/build binding, once, in
the installed deterministic QA capability; it exposes no general timer or
authority to production renderer state. Backgrounded, resized, wrong-focus,
provider-error, dropped-frame-instrumentation, duplicate, or mismatched samples
are invalid rather than discarded/retried silently.

```ts
type GpuSelectorPerfActionV1 =
  | 'cold_open' | 'warm_open' | 'refresh_loading'
  | 'keyboard_move' | 'keyboard_select';
interface GpuSelectorPerfSampleV1 {
  schemaVersion: 1;
  sampleId: string;
  platform: 'macos-arm64' | 'windows-x64';
  appVersion: string;
  commitSha: string;
  artifactSha256: string;
  viewportWidth: 1280 | 1440;
  viewportHeight: 720 | 900;
  action: GpuSelectorPerfActionV1;
  ordinal: number;
  durationUs: number;
  mountedGpuRows: 10;
  mountedRowIdsSha256:
    '83d20e051a50c2f0fbb16a459af0d67662acf81feaeddf9af0cab82b6cc3c71c';
}
interface GpuSelectorPerfGroupV1 {
  platform: 'macos-arm64' | 'windows-x64';
  appVersion: string;
  commitSha: string;
  artifactSha256: string;
  viewportWidth: 1280 | 1440;
  viewportHeight: 720 | 900;
  action: GpuSelectorPerfActionV1;
  p95Us: number;
}
interface GpuSelectorPerfEvidenceV1 {
  schemaVersion: 1;
  platform: 'macos-arm64' | 'windows-x64';
  appVersion: string;
  commitSha: string;
  artifactSha256: string;
  fixtureId: 'gpu-selector-perf-10-v1';
  fixtureSha256:
    '102cfe7267c269a1344d3758ef1deea4cfbe5d469d2de9b996f5c06499eacf68';
  thresholdUs: 100000;
  samplesPerActionViewport: 30;
  samples: GpuSelectorPerfSampleV1[];
  groups: GpuSelectorPerfGroupV1[];
  evidenceSha256: string;
}
interface GpuSelectorPerfArmV1 {
  fixtureSha256:
    '102cfe7267c269a1344d3758ef1deea4cfbe5d469d2de9b996f5c06499eacf68';
  action: GpuSelectorPerfActionV1;
  ordinal: number;
  viewportWidth: 1280 | 1440;
  viewportHeight: 720 | 900;
}
interface GpuSelectorPerfArmResultV1 {
  schemaVersion: 1;
  armed: true;
  qaSessionId: string;
}
interface GpuSelectorPerfStartedEventV1 {
  schemaVersion: 1;
  event: 'gpu-selector-perf-started-v1';
  qaSessionId: string;
  sampleId: string;
  action: GpuSelectorPerfActionV1;
  ordinal: number;
  viewportWidth: 1280 | 1440;
  viewportHeight: 720 | 900;
}
interface GpuSelectorPerfCommitV1 {
  qaSessionId: string;
  sampleId: string;
  mountedRowIds: string[];
}
```

`contracts/gpu-selector-perf-10-v1.json` is authoritative and its complete JCS
content plus one LF is exactly:

```json
{"includeEmergencyTier":true,"rowIds":["current","auto","ordinary:rtx-4090","ordinary:rtx-pro-4500-blackwell","ordinary:rtx-5090","ordinary:rtx-pro-4000-blackwell","ordinary:l4","ordinary:rtx-a4500","ordinary:rtx-4000-ada","emergency:rtx-2000-ada"],"schemaVersion":1}
```

Its SHA-256 is the literal `fixtureSha256` above. The ordered `rowIds` array
alone, encoded as JCS plus one LF, hashes to the literal
`mountedRowIdsSha256`. The harness reads the mounted semantic row IDs after
paint and requires exact array equality—not only a count—on every sample.

The instrumentation boundary is exactly two test-only Tauri commands and one
event:

```text
gpu_selector_perf_arm({ input: GpuSelectorPerfArmV1 }) -> GpuSelectorPerfArmResultV1
gpu-selector-perf-started-v1 -> GpuSelectorPerfStartedEventV1
gpu_selector_perf_commit({ input: GpuSelectorPerfCommitV1 }) -> GpuSelectorPerfSampleV1
```

They use permissions `gpu-selector-perf:allow-arm` and
`gpu-selector-perf:allow-commit` in the dedicated
`qa-gpu-selector-perf-v1` capability and are absent from every other capability.
The production binary registers the handlers, but they return fixed
`gpu_selector_perf_qa_disabled` unless an installed-test runner establishes one
native QA session through the release harness before window creation. That
out-of-band session binds the re-hashed installed artifact, platform, version,
commit, fixture hash, exact main window, and allowed two viewports; no renderer
field can replace those values.

Arm validates the fixture/ordinal/viewport, permits one outstanding action, and
expires after 5,000 monotonic ms without starting a duration. The next matching
trusted native input hook CSPRNG-generates canonical UUIDv4 `sampleId`, records
the private monotonic start, consumes the arm, and emits the strict event once
to that window. Commit accepts that ID once after the double-rAF callback,
requires exact ordered fixture row IDs and unchanged viewport/focus/build, takes
the private end timestamp, and returns the completed sample. Wrong action,
viewport, ID, session, order, reuse, background, timeout, or unknown fields fail
without a sample. Neither command exposes timestamps, accepts durations, reads
arbitrary paths, or acts as a general renderer timer.

UUID/hash/commit fields use the strict existing grammars; ordinals are exactly
1..30 per platform/viewport/action, durations are safe integers in
`1..10_000_000`, and every sample mounts exactly those 10 rows while the general
component DOM cap remains 20. For each exact group, sort the 30 durations and
compute nearest-rank p95 as `d[28]`. Each per-platform evidence file contains
exactly the 10 unique valid viewport-pair × action combinations, sorted by
viewport width then action ASCII; 1280 pairs only with 720
and 1440 only with 900. Every group must have
`p95 < 100_000` microseconds and every sample must mount at most 20 GPU rows.
The artifact is UTF-8 RFC 8785/JCS plus one LF; `evidenceSha256` hashes an
otherwise identical object with that field omitted. Target-native release CI
uploads the raw evidence and fails the release gate on missing/invalid samples,
threshold/DOM violation, wrong fixture/build, or hash drift. Manual QA records
the same artifact path/hash. One evidence file binds exactly one installed
platform artifact: its top-level platform/version/commit/artifact SHA-256 must
match every sample/group and the actual re-hashed installer/app under test.
Mixing platforms, commits, versions, or artifacts in one file is invalid. This
supplements, and does not weaken, Task 013's
separate 450-row queue benchmark.

The release harness writes exactly one evidence file per platform at
`release-evidence/gpu-selector-perf-v1/<commitSha>/<appVersion>/<platform>/<artifactSha256>/gpu-selector-perf-10-v1__1280x720__1440x900.json`.
Every segment is derived from the validated top-level fields (lowercase 40-hex
commit, SemVer app version, fixed platform enum, lowercase 64-hex artifact hash),
never renderer input. CI rejects another path/name, symlink, mixed evidence,
missing counterpart platform, or a file whose re-hash/top-level binding differs.

## Acceptance criteria

- AC-1: The compact selector exposes every and only live policy-approved offer,
  current Pod truth, ordinary Auto Start, exact manual Start, and exact manual
  Switch according to the policy terminology. It never presents the global
  catalog or silently opts into emergency/unapproved hardware.
- AC-2: Inventory timing, coalescing, freshness, fallback, price, and final
  preflight follow the exact 30-second/60-second contract. Ordinary Studio/Pod
  observation no longer refetches GPU inventory every few seconds. One native
  observation spans the exact two catalog GETs; receipt monotonic-ms/process-
  epoch rules, fallback null timestamps, canonical decimal-to-micro-USD parsing,
  current-Pod price precedence, emergency-tier-keyed coalescing, strict terminal
  event ordering/supersession, and relational state invariants are exact.
  Inventory secure price and Pod adjusted price accept only JSON number tokens;
  Pod base cost accepts only the documented decimal string, numeric legacy cost
  is rejected, and null-adjusted fallback/fail-closed behavior matches the exact
  field contract above in Rust and TypeScript.
- AC-2/9/10/11: Ordinary 2–5-second Pod convergence uses only
  `gpu_pod_observe`; coordinated Task 012 deletion uses only
  `gpu_normal_stop`. Observation never reads catalog inventory or mutates a
  provider. Stop performs exact native profile/worker/guard revalidation,
  exposes no provider/finalization authority, sends at most one DELETE, and
  maps 404/absence versus ambiguity exactly as bound above. The five generic
  renderer RunPod transport commands have no production call site.
- AC-3: Speed score, benchmark provenance, and estimated cost use only the exact
  v2 raw/profile schemas, 30-sample fixture, JCS+LF evidence hash, recomputed
  median/p95, 90-day freshness boundary, compatibility, quorum, and checked
  `WIDE_UNSIGNED_V1` formulas/string projection above. Missing or incompatible evidence displays
  `Unmeasured`/`—`; valid stale evidence displays `Benchmark expired`/`—` and
  remains manually selectable. No heuristic or decorative score ships.
- AC-4: Offline **Start selected GPU** sends one singleton exact target under the
  existing durable create-ambiguity protection. Offline **Auto best value**
  preserves Task 003 ordered fallback only within a fresh receipt-bearing live
  inventory; fallback/no-receipt rows are explanatory and cannot create. An
  existing Pod is never silently reused
  as a successful manual Switch. Manual Start is bound to the native observation,
  receipt, exact microprice, private authority, final refresh, changed-price
  reconfirmation, and actual-created-price attention flow.
- AC-5: Switch begins only from one explicit foreground confirmation, the
  native trusted-input/focus grant, and process-local authorization/lease. The
  grant is exact-kind, five-second, and one-use; Resume mints a fresh one.
  Minimize/background may continue after consumption; sleep,
  crash, lease loss, or relaunch performs no mutation and requires **Resume
  switch** with the exact recovery ordering.
- AC-6: Worker consent, foreign active-owner approval, same-principal
  deduplication, deadlines, restart behavior, and requester-only finalization
  match the exact protocol. Worker request envelopes are crash-atomic and
  fingerprint-idempotent; create response loss uses lookup-first exact replay or
  tombstone-producing settle-cancel, and 404 alone releases nothing. Owner
  absence, denial, timeout, ambiguity, or epoch loss before durable finalization
  sends no DELETE.
- AC-7: Finalization finishes and persists at most the current image, pauses or
  retains interruption of the exact batch, and reaches `ready_to_delete` only at
  the artifact-safe fixed point. Ready artifacts/checksums/manifests survive
  every crash seam and are never regenerated.
- AC-8: The shared marker is strict, crash-safe, lease-protected, adopted before
  generation by every worker process/Pod, and blocks create/resume/retry/Stop/
  new Switch after finalization. Corruption uses the exact fail-closed public
  mapping and never leaks private fields.
- AC-9: Stop, foreground generation, queue admission, pause/cancel, simultaneous
  Switch, and worker-process races follow the atomic interaction rules and
  typed errors, bidirectional phase matrix, closed permission/action mapping,
  and global-lock linearization above. Task 012 Stop behavior outside Switch is unchanged.
- AC-10: Native persistence, last-known-good recovery, lease, revisions,
  immutable identities, native-only grant consumption, global profile lock,
  strict queue-reservation envelope, one-use quote/foreground grants, atomic
  terminal release, and frozen phase transitions match
  the exact schema. A raw/crafted renderer cannot skip pause, delete/create
  intent, old absence, attempt revision, replacement verification, or worker
  completion.
- AC-11: The provider sequence is exactly one logical old-Pod deletion, with one
  initial DELETE wire call and at most one explicitly authorized same-intent
  Resume retry, before at most one POST per replacement attempt. No POST follows uncertain DELETE; no second POST follows
  uncertain Create; no create-before-delete, silent fallback, name-only match,
  peer-Pod deletion, or false rollback is possible. Canonical request bytes,
  create/response/Pod fingerprints, response headers/body hash, settling proof,
  and crash commit order are exact and reject mismatch without mutation. A
  DELETE/exact-GET 404 still requires the fresh no-same-ID profile list. Create,
  list, and exact-GET response fingerprints derive observed microprice through
  the same mixed-representation Pod parser and never hash a binary float.
- AC-12: Replacement creation preserves exact template, immutable image digest,
  network volume/mount, EU-RO-1 Secure, one GPU, non-interruptible mode, port,
  secrets, and model contract while using exactly the selected GPU ID. Native
  and worker both verify replacement/runtime identity before completion. The
  native-only runtime route and checked provider-GPU-to-CUDA/NVML mapping prove
  the actual device while public health/foreign views remain redacted.
- AC-13: Target loss, provider 404/409/429/5xx, timeout, malformed success,
  eventual consistency, zero/one/multiple matches, duplicate/foreign Pod,
  wrong volume/GPU/image/runtime, old Pod replacement, and app/worker crashes
  reach the exact actionable state without an automatic destructive retry.
- AC-14: The local queue is durably parked and runner/power released before
  Switch through one crash-safe no-gap reservation under the profile lock.
  Denied, expired, cancelled-pre-delete, and completed each release only after
  exact terminal history/tombstone ordering (with the proven-never-sent local
  exception); none auto-resumes. Switch never advances the queue or alarm. Replacement completion
  leaves batch/queue paused and Task 013 lookup-first explicit Resume remains
  authoritative.
- AC-15: The minimal sheet, confirmation, peer consent, progress/attention,
  compact layouts, keyboard/screen-reader/reduced-motion behavior, and honest
  labels implement every authored state without dead controls or fake metrics.
  Both installed target artifacts pass every exact 30-sample interaction group
  at p95 under 100 ms and the 20-row DOM cap with hashed evidence above.
- AC-16: Python/Rust/TypeScript implement the exact HTTP/native schemas, routes,
  enums, strict unknown-field rejection, UUID/time/hash bounds, privacy
  projection, `JS_SAFE_REVISION_V1`, inventory event, closed code/mapping
  registry, statuses, fixed messages, retry classifications, shared 128-byte
  GPU identity migration, and language-neutral vectors above. Checked-in
  contract tests reject field, validator, or state-table drift.
- AC-17: Deterministic tests cover inventory/score, both Start modes, every
  worker/native transition, all crash and network ambiguity seams, concurrency,
  cross-client consent, queue/alarm/power interaction, and zero automatic Pod
  mutation. Existing RunPod, Task 012, Task 013, worker lease, receipt, and
  450-row suites remain green.
- AC-18: Installed macOS Apple-silicon and Windows-x64 artifacts pass the exact
  two-client fake-provider switch smoke: active foreign-owner approval, one
  finished frame, one normal-path DELETE before one POST, same volume/profile, replacement
  Ready, preserved checksum, batch/queue still paused, explicit Resume, no
  duplicate/unintended Pod, and journal recovery after process relaunch. The
  installed smoke uses two real app processes/native windows, production Rust
  Tauri commands, the real app-data generation/journal/file leases, monotonic
  inventory receipts, queue reservation, and private authority consumption.
  Only outbound RunPod/worker I/O is substituted by deterministic servers; a
  JavaScript/memory journal, lease, grant, or direct lifecycle fake is forbidden.
- AC-19: A real RunPod switch is a separate supervised paid gate requiring a
  fresh explicit budget authorization. If run, it proves no simultaneous Pod/
  volume writer, exact old absence, exact target/volume/image/runtime,
  first-frame checksum preservation, remaining-frame resume, and a final active-
  Pod/cost audit. It is never inferred from fakes and never run in routine CI.
- AC-20: The implementation change updates `docs/PRODUCT_SPEC.md`,
  `docs/ARCHITECTURE.md`, `docs/API_CONTRACT.md`, `docs/RUNPOD_OPERATIONS.md`,
  `docs/RECOVERY.md`, `docs/BENCHMARK_PLAN.md`, release requirements, QA log,
  checked-in schemas, and Task 003/012/013 cross-references. Every older
  no-automatic-mutation, active-batch Stop veto, local-queue, approved-GPU, and
  one-Pod statement remains binding except the narrow explicit supersessions in
  this task. `docs/API_CONTRACT.md` and checked-in raw-provider schemas must state
  `adjustedCostPerHr: JSON number|null`, `costPerHr: decimal string`, numeric
  legacy rejection, exact fallback precedence, and the shared micro-USD vectors.

## Non-goals

- NG-1: Do not add in-place GPU update, multiple active Pods/GPUs, simultaneous
  network-volume writers, multi-GPU inference, another model, another region,
  Community Cloud, spot/interruptible bidding, or a worker-side queue.
- NG-2: Do not expose the global RunPod catalog, automatically approve a new
  catalog ID, add a silent high-cost fallback, or use an unmeasured/marketing
  speed score.
- NG-3: Do not switch because of price, availability, completion, idle time,
  error, queue/alarm state, app close, timer, remote heartbeat, or background
  policy. Every destructive transaction begins or resumes with an explicit
  foreground click.
- NG-4: Do not auto-resume a batch or queue, auto-acknowledge an alarm, auto-stop
  the replacement, or claim that replacement readiness stopped billing.
- NG-5: Do not create before proving old-Pod absence, retry ambiguous POST/
  DELETE automatically, attach by Pod name/owner/GPU/progress, auto-delete a
  duplicate/peer Pod, or describe forward recovery after DELETE as rollback.
- NG-6: Do not weaken Task 012 normal Stop veto/consent, Task 013 lookup-first
  queue recovery/local-only privacy, one active worker lease, artifact checksum/
  atomic persistence, credential isolation, or explicit Start/Stop controls.
- NG-7: Do not run a detached switch service after ImageForge exits, let a
  durable journal grant authority, keep the system awake automatically, or
  require the app to survive OS suspend.
- NG-8: Do not expose bearer tokens, RunPod keys, chooser grants, prompt text,
  references, local paths, private principal IDs, raw provider/worker bodies, or
  marker exceptions in renderer storage, URLs, logs, notifications, screenshots,
  diagnostics, foreign Studio views, or committed fixtures.
- NG-9: Do not add automatic duplicate-Pod cleanup or a normal-CI paid provider
  mutation. Paid tests remain explicit, supervised, budget-bounded, and audited.

## Relevant files

- `packages/runpod-client/src/types.ts`, `gpu-policy.ts`, `ranking.ts`,
  `config.ts`, `real-provider.ts`, `fake-provider.ts`, `lifecycle.ts`,
  `errors.ts`, `health.ts`: live selector projection, separated inventory
  observation, exact-target create, switch-aware provider reconciliation, and
  deterministic fakes.
- `src/adapters/gpuLifecycleCoordinator.ts`,
  `productionImageForgeAdapter.ts`, `studioContracts.ts`,
  `runtimeProjection.ts`: orchestration, worker consent/guard, stale epoch,
  queue park, and exact post-replacement binding.
- `src/domain/types.ts`, `reducer.ts`: selector/switch/UI states and immutable
  transition guards.
- `src/App.tsx`, `src/components/AppChrome.tsx`, a focused GPU picker/switch
  component, `src/styles.css`: minimal selector, confirmations, peer requests,
  attention/recovery, and accessibility.
- `src/native/tauriBridge.ts`, `productionPort.ts`,
  `twoClientSmokePort.ts`: exact native/worker/provider projections without
  secrets or arbitrary transport.
- `src-tauri/src/native/runpod.rs`, `worker.rs`, `session.rs`, `smoke.rs`, a
  focused `gpu_switch.rs`, `src-tauri/src/lib.rs`, Tauri capabilities/config:
  crash-safe journal/lease, strict commands, exact grants, pinned transport,
  and native fake smoke.
- `worker/src/imageforge_worker/domain.py`, `coordination.py`, `persistence.py`,
  `controller.py`, `app.py`, `config.py`, `health.py`: exact HTTP schemas,
  consent, pause fixed point, shared marker/adoption, and generation guard.
- Adjacent TypeScript/Vitest, RunPod-client Vitest, Rust tests, worker pytest,
  crash fixtures, two-client/native-smoke fixtures, and benchmark evidence.
- `contracts/gpu-identity-v1.*`, `contracts/gpu-runtime-identities-v1.*`,
  `contracts/runpod-price-v1.*`, `contracts/gpu-switch-codes-v1.json`,
  `contracts/gpu-start-auto-v1.schema.json`,
  `contracts/gpu-start-auto-v1.vectors.json`,
  `contracts/gpu-pod-control-v1.schema.json`,
  `contracts/gpu-pod-control-v1.vectors.json`,
  `contracts/gpu-selector-perf-10-v1.json`,
  `contracts/gpu-wide-arithmetic-v1.vectors.json`,
  `contracts/gpu-benchmark-*-v2.*`, and
  `benchmarks/gpu-v2/**`: single-source
  strict schemas/vectors/runtime map/raw evidence/profiles consumed by all three
  languages.
- `docs/PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `API_CONTRACT.md`,
  `RUNPOD_OPERATIONS.md`, `RECOVERY.md`, `BENCHMARK_PLAN.md`,
  `RELEASE_REQUIREMENTS.md`, `QA_LOG.md`: exact policy, protocol, recovery,
  measurement, and release evidence.
- `.github/workflows/build-desktop.yml`, worker publication workflow, version/
  release metadata, and `scripts/native-two-client-smoke-server.mjs`: target-
  native verification and artifact provenance.

## Automated tests

- AC-1/2/3/4: RunPod-client tests use a fake clock/catalog to prove picker-open
  immediate refresh, 30-second visible cadence, close/background cleanup,
  60-second stale gate, emergency-flag-keyed coalescing, strict event exactly-
  once/order/supersession/dedup, issue-code/retry-boolean parity, fallback non-selection,
  exact two-GET observation IDs, process-epoch receipt expiry/restart, fallback
  null observed time, lossless decimal grammar/precedence, inventory/adjusted
  number-token versus cost-string representations, null-adjusted fallback,
  numeric-cost rejection, absent/invalid fail-closed behavior, exact policy filtering,
  emergency opt-in, v2 raw/JCS+LF/hash/median/p95/failure/migration vectors,
  benchmark age boundary/future/overflow vectors, stale manual selection,
  expired-versus-Unmeasured copy, and stale Auto/cost exclusion,
  shared wide-integer Auto/score/estimate max/half-up/overflow vectors,
  strict Auto Start input/result/error-registry vectors, native-derived order
  and request hashes, load/replay/revision recovery, and no-POST rejection for
  every invalid/stale/mismatched receipt or profile,
  no-ordinary-profile `Unmeasured`, Auto quorum/ties/unknown fallback,
  non-null fresh Auto receipt/no-receipt rejection, and observation+microprice-
  bound singleton manual create/reconfirmation.
- AC-2/11/16: one checked-in raw-price vector fixture is consumed by
  `packages/runpod-client` Vitest and `src-tauri` Rust tests for create-201,
  profile-list, and exact-Pod GET bodies. It proves every accepted/rejected
  lexeme above, identical micro-USD integers, adjusted-over-cost precedence,
  fallback only on exact null, null fingerprint price on invalid/absent fallback,
  no binary-float round trip, and field-for-field schema drift failure.
- AC-3/16: Rust, TypeScript, and Python consume the same wide-arithmetic vectors
  and prove exact Auto/score products, ordering/ties, maximum cost numerator,
  quotient/remainder half-up cases, canonical decimal-string projection,
  U128_MAX boundaries, checked overflow rejection, and null/`—` fallback without
  any Number/f64 intermediate.
- AC-5/10/11/12/13: lifecycle/native tests inject crash or transport loss before
  and after every journal fsync/rename, worker marker transition, DELETE send/
  response, old-ID 404, POST send/response, marker record, discovery, health,
  adoption, and completion. Assert exact revision/phase recovery, mutation
  counts/order, old-delete wire counter 0→1→2 with fresh proof and no third
  call, DELETE/GET 404 plus required profile-list absence, one POST per attempt,
  zero POST under delete uncertainty, and no
  wrong-Pod/volume/profile mutation.
- AC-6/7/8/9/16: worker pytest covers requester/peer/foreign active owner,
  absent owner, dedup/new/expired peer, approve/deny/timeout, epoch restart,
  current-image pause, already-paused/interrupted/idle, manifest/marker crash
  order, new-process/new-Pod adoption, marker corruption, generation/Stop/queue/
  cancel races, crash-atomic request-envelope create/replay/response-loss/
  settle-cancel tombstones, the complete Stop↔Switch matrix and block/action
  registry, requester-only IDs, privacy omission, strict routes/errors, and
  completed-artifact non-regeneration.
- AC-10/16: Rust/native contract tests reject unknown fields, wrong UUID/time/
  hash/number bounds, revision skips, illegal transitions, no-lease mutation,
  stale/wrong-process inventory receipts, arbitrary GPU/profile/body/URL,
  trusted foreground and quote grant reuse/expiry/kind/record confusion,
  JS-safe initialization/increment/exhaustion, create-before-delete, ambiguous
  reconciliation, secret reflection, strict reservation-envelope corruption/
  previous-copy/releasing seams, normal Start/Stop races, and cross-
  process contention. Rust, TS, and Python consume the exact shared GPU identity
  vectors and schema/state fixtures.
- AC-2/8/9/10/11/16: Rust/TypeScript tests exercise `gpu_pod_observe` with
  zero/one/multiple/overflow Pods, coalescing, retained stale projection,
  malformed/duplicate/foreign response rejection, strict ordering, and no
  catalog or mutation call. Normal-Stop tests cover every pre-send veto,
  request/server/revision/session mismatch, Stop-vs-Switch winner, exact DELETE
  success, DELETE 404 plus required absence proof, timeout/5xx ambiguity,
  zero/one DELETE counts, no automatic retry, no finalization-ID disclosure,
  and relaunch/replay under the durable worker guard.
- [AC-14] Queue tests prove runner/power release before begin, dispatching/
  uncertain admission blocks Switch, active item preservation, no completion
  fixed point/alarm, denial/expiry/cancel/completion release only after matching
  terminal history, owner-404 non-release, no auto Resume, relaunch authorization loss, and exact
  Task 013 lookup-first Resume after replacement.
- [AC-15] Reducer/component tests render and keyboard-operate every selector,
  confirmation, consent, progress, recovery, empty/error, and minimized state;
  assert honest copy, focus/live regions, reduced motion, no overflow, and the
  20-row DOM bound at all required viewports. The installed macOS/Windows
  harness additionally validates the strict performance artifact, 30 samples
  per action/viewport, nearest-rank p95, native one-use timestamps, fixture/build
  and ordered row-ID binding, test-only command/capability isolation, QA-disabled
  production behavior, invalid-sample/replay rejection, canonical output path,
  and every `<100000us` group.
- AC-17/18: run targeted suites, then root Vitest, RunPod-client Vitest,
  TypeScript typecheck/build, Python 3.11 pytest/ruff/compile, Rust fmt/clippy/
  test, `git diff --check`, native macOS/Windows package/install/launch, and the
  two-client fixture. Existing Task 012/013 and 450-row gates must pass without
  weakened assertions.
- AC-18's target-native fixture launches both installed processes against one
  temporary real app-data root, records every production Tauri command and
  outbound fake-server request, kills the lease holder after each durable seam,
  relaunches from disk, and asserts exact command/mutation counts. It must prove
  native UUID/receipt generation, queue reservation exclusion, a second-process
  lease failure, private grant non-visibility/single consumption, one worker
  Finalize, one normal-path old DELETE, one replacement POST, terminal marker clear/history,
  and zero JS calls to generic provider create/delete helpers.
- [AC-19] The paid provider test is opt-in and records explicit authorization,
  maximum budget, provider request IDs, Pod timeline, GPU/volume/image/runtime,
  artifact hashes, billing estimate, and final active-Pod audit. A skip is
  expected in ordinary automation and is reported, never converted to a pass.

## Manual verification

1. [AC-1/2/3/15] Open the selector offline on macOS and Windows. Verify one
   immediate inventory call, all and only approved rows, current observation
   ages/prices, exact `Benchmark expired` versus `Unmeasured` behavior,
   stale manual selection, emergency warning, keyboard/focus/
   screen-reader/reduced-motion behavior, and 30-second updates only while the
   foreground sheet is open.
2. [AC-4] Start once with **Auto best value** and once with an exact selected GPU
   in the deterministic fixture. Verify ordered versus singleton request bodies,
   one Pod, one GPU, exact profile, and ambiguity reconciliation without a
   second POST.
3. [AC-5/6/9] With clients A and B foreground and the worker idle, request Switch
   from A. Approve, deny, time out, introduce a new peer, expire a peer, race
   Stop, and start foreground/queue generation. Verify exact consent/errors,
   no mutation on every failed branch, and unchanged normal Stop behavior.
4. [AC-6/7] Generate at least three fake images on A, let B request a Switch,
   approve as active owner, and verify only the in-flight image finishes,
   manifest/checksum persist, batch becomes paused, and DELETE remains zero
   until `ready_to_delete`.
5. [AC-10/11/13] Inject DELETE timeout, delayed 404, target loss, POST timeout,
   malformed response, zero/one/multiple attempt matches, peer/duplicate Pod,
   wrong GPU/volume/image/runtime, and late old-worker heartbeat. Verify the
   exact phase/code, one explicitly proven old-DELETE retry at most, no third
   wire call or automatic fallback/retry/deletion, and truthful billing/offline
   copy.
6. [AC-5/8/10/13] Quit, crash, suspend/wake, and relaunch at every phase on both
   operating systems. Verify journal/marker recovery is read-only,
   authorization-required is visible, **Resume switch** reconciles before any
   mutation, completed artifacts are not regenerated, and corrupt state fails
   closed without reset.
7. [AC-14] Run a three-batch local queue, start Switch during its active batch,
   and verify queue runner/keep-awake release, no alarm/event, active row
   preservation, replacement ready-paused, and explicit lookup-first Resume
   continuing the exact item before any successor.
8. [AC-15] Verify every state at 1280×720, 1440×900, and 1920×1080 using mouse,
   keyboard, VoiceOver, Narrator/high contrast, and reduced motion. Capture
   focus order, announcements, overflow dimensions, and mounted row count. On
   each installed target also run the exact 30-sample cold/warm/refresh/move/
   select benchmark at 1280×720 and 1440×900; verify every p95 is under 100 ms
   and record the canonical evidence path/SHA-256.
9. [AC-18] Install clean macOS and Windows artifacts and run two independent app
   processes/native windows against the deterministic authority. Capture one
   exact DELETE before one POST, preserved profile/volume/artifact checksum,
   replacement worker adoption, paused batch/queue, explicit Resume, relaunch
   recovery, and zero unintended Pods. Capture the temporary production app-data
   generations/locks/reservation before and after forced process death, native
   command counters, and fake external HTTP counters; verify only external I/O
   was mocked and no renderer grant/finalization ID exists.
10. [AC-19] Only after fresh written budget approval, switch one real RunPod
    batch between two exact approved GPUs. Record provider request timeline,
    prove no simultaneous volume writer, verify artifact hashes and remaining
    resume, explicitly Stop when finished, and audit active Pods/cost. Otherwise
    record the paid stage as skipped.

## Evidence required

- File/line-linked independent review against every AC/non-goal, both repair
  rounds, and exact Task 003/012/013 supersession boundaries.
- Official RunPod links above plus captured validated inventory/create/get/delete
  fixture bodies with secrets removed; raw benchmark JSON, sample count,
  contract fields, evidence SHA-256, formula vectors, and UI provenance.
- Targeted/full commands and pass counts for TypeScript, RunPod-client, Python,
  Rust, build, schema/state drift, crash seams, accessibility, viewports, and
  mutation-count/order tests; every skip and paid stage is explicit.
- Canonical `GpuSelectorPerfEvidenceV1` from installed macOS and Windows,
  including all 20 cross-platform groups as defined above, fixture/build
  identity, raw p95/DOM results, artifact path, and verified SHA-256.
- macOS/Windows installed-app screenshots/state logs and distinct two-process
  smoke results proving consent, one normal-path DELETE-before-POST sequence, same volume,
  preserved checksum, ready-paused behavior, relaunch recovery, and zero
  unintended Pods.
- Release commit/tag/workflow, immutable worker image digest, artifact names and
  SHA-256, install/launch results, signing/notarization or unsigned disclosure,
  public re-download hashes, and final RunPod active-Pod/cost audit. If native
  runners, worker digest, billing, publication, or paid authorization block a
  gate, source may be pushed with the blocker recorded, but Task 014/release is
  not claimed complete.
