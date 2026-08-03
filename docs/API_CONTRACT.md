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
- `POST /v1/batches` -> create one batch or return HTTP 423 `batch_busy`.
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

## Studio presence and coordinated Stop

Every studio route requires the same bearer authentication as batch routes. IDs
are canonical lowercase UUIDv4 strings. `pod_id` is 1-58 ASCII alphanumeric or
hyphen characters with no edge hyphen. `gpu_display_name` is a trimmed 1-80
character safe display label. Credential display names are also trimmed,
printable, and 1-80 characters. Requests and responses never contain bearer
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
approve. Pending or approved consent never blocks or queues generation. A valid
create/resume/retry atomically changes it to `cancelled` with reason
`generation_started`. Only `finalizing` blocks those admissions, with HTTP 423
`gpu_stop_pending`, until the exact cancellation or bounded expiry. All stop and
generation admissions share the worker controller's async lock. Finalization
also owns the shared-volume active lease and publishes a strict, atomically
replaced `.gpu-stop-finalization.json` marker. A second worker process or Pod
therefore returns the same typed `gpu_stop_pending` response for create, resume,
and retry attempts; it cannot bypass finalization with another process-local
controller. `/v1/status.permissions.can_create` is false for the same bounded
interval.

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
  `gpu_stop_pending` with request ID, requester, and expiry.
- HTTP 429 `studio_session_limit`.
- HTTP 422 `validation_error`, using the existing safe validation envelope.

## RunPod client operations

- List approved GPU inventory and current prices.
- List Pods tagged `imageforge`.
- Create one Pod from configured template, GPU type and network volume.
- Read runtime/provisioning state and derive the HTTPS proxy endpoint.
- Terminate a selected Pod only from a confirmed user action.

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
