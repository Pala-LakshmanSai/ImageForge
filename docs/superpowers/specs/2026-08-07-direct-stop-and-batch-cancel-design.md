# Direct GPU Stop and always-available batch Cancel

## Problem

Two controls are unusable in the shipped build.

**Stop GPU never terminates.** The button creates a *coordinated stop request*
on the worker and waits for every other live session to approve it before
native finalizes and terminates. Two editors share one Pod and coordinate on
Discord, so the approval step buys nothing and blocks the action outright: a
session that is no longer really there still appears in `waiting_for` until its
presence TTL expires, and the request waits on a peer who will never answer.

**Cancel and Pause disappear during the saving tail.** Both controls share one
gate:

```
hasGenerationWork = prompts.some(status in {pending, generating, retrying})
isControllable    = canManage && (phase == paused || (phase == running && hasGenerationWork))
```

Once the worker has generated every image, the remaining prompts are `ready` or
`downloading`, so `hasGenerationWork` is false while `batchPhase` still reports
`running` for the artifact-saving tail. On a 262-image batch this removed both
controls for the entire tail, observed live at 256 saved / 1 ready / 6 waiting.
The user had no way to stop the batch and no way to start another.

## Goals

- Either editor can terminate the Pod immediately, with no approval from the
  other and no dependence on peer session presence.
- Cancel is available for as long as a batch is running or paused, including
  the saving tail, and stops only the batch.
- The worker image is not rebuilt, repinned, or redeployed.

## Non-goals

- NG-1: GPU **Switch** consent is a separate subsystem and is left intact.
- NG-2: No change to generation, download, receipts, or queue behavior.
- NG-3: No removal of the worker's `/v1/studio/*` routes. The desktop stops
  using them for stop; the worker keeps serving them.

## Decisions

**Terminate, not suspend.** Stop GPU calls RunPod terminate, ending compute and
ephemeral container data. The network volume and model weights survive. This is
the existing semantic and is unchanged.

**Native, not renderer.** Termination cannot be made consent-free in the React
layer. Native calls the worker's finalize endpoint
(`WorkerOperation::StudioFinalizeStop`) before terminating, so the worker gates
termination on an approved request. A new native command is required.

**Worker untouched.** Removing coordination worker-side would mean a new image,
a new pin, and a redeploy. A stale pin against a mismatched contract already
cost this project two separate outages (the 39% boot stall and a totally
blocked Generate). The desktop simply stops calling the stop handshake.

**One guard survives: an active batch.** Stop is refused while the worker
reports an active batch, whoever owns it, and the refusal names the owner and
progress. This is not permission from a person; it prevents destroying
in-flight work, and the worker enforces it independently
(`stop_blocked_by_active_batch`).

## Design

### 1. Batch controls

Split the two controls, which are currently gated identically.

| Control | Gate | Reason |
|---|---|---|
| Cancel | `canManage && phase in {running, paused}` | Must stay available through the saving tail |
| Pause  | `canManage && phase == running && hasGenerationWork` | Pausing "after frame" is meaningless with no frames left |

Cancel dispatches `REQUEST_CANCEL_BATCH`, which routes to
`runtime.controlBatch('cancel')`. It never touches the Pod. The Pod stays
running and billing after a cancel; that is intended and separate.

### 2. Stop GPU

Flow becomes:

1. Read worker status. If an active batch exists, emit a blocked event naming
   owner and progress. Stop here.
2. Call the new native terminate command with the exact Pod ID.
3. Native terminates through RunPod, reusing the existing idempotency journal
   and provider-ambiguity handling.

Retained from the current implementation, because they guard against real
faults rather than against a missing conversation:

- Exact-Pod-ID confirmation, so a changed Pod is never terminated by a stale click.
- The native operation journal, so a retry cannot double-terminate.
- Ambiguous-provider handling: when RunPod does not confirm, ImageForge does not
  claim the GPU stopped.

Removed from the desktop flow: `BEGIN_STUDIO_STOP`, `studioCreateStopRequest`,
the waiting/approval dialogs, and the "Request coordinated stop" label, which
becomes **Stop GPU**.

### 3. Error handling

| Condition | Behavior |
|---|---|
| Active batch on worker | Refuse; toast names owner and progress |
| Pod ID changed since dialog opened | Refuse; ask to refresh |
| RunPod confirms termination | Emit stop-complete |
| RunPod response ambiguous | Do not claim stopped; surface refresh guidance |
| Worker unreachable for the status pre-check | Refuse; the guard must fail closed |

The last row matters: if worker status cannot be read, the desktop cannot know
whether a batch is in flight, so it must refuse rather than terminate blindly.

## Testing

Reducer and adapter tests:

- Cancel renders at 256 saved / 1 ready / 6 waiting — the exact state that
  failed live — and through `phase == paused`.
- Pause is hidden in that same state, and shown while generation work remains.
- Cancel stops the batch and issues no Pod mutation.
- Stop terminates with no stop request created and no approval awaited.
- Stop refuses when the worker reports an active batch, and when worker status
  cannot be read.
- Stop refuses when the confirmed Pod ID no longer matches.

Native tests:

- Terminate is idempotent across a repeated call with the same Pod.
- An ambiguous provider response is not reported as a successful stop.

## Risks

Terminating without peer approval means one editor can destroy a Pod the other
is about to use. This is accepted: the editors coordinate on Discord, and the
active-batch guard still prevents destroying work that is actually running.

The live verification of this feature requires a running Pod, which costs GPU
time. Automated coverage carries the correctness burden; the live check
confirms only that terminate reaches RunPod and the Pod disappears.
