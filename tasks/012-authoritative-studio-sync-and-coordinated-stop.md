# Task 012 — Authoritative studio synchronization and coordinated GPU stop

Task 014 adds a distinct explicit Switch consent/finalization protocol and a
shared Stop/Switch GPU-control lock. Normal Task 012 Stop behavior remains
binding outside a Switch. Pending/approved/finalized Switch interactions follow
Task 014's bidirectional phase matrix; neither protocol may cancel or bypass the
other implicitly.

## Problem

Two configured ImageForge desktop clients can observe different GPU and batch
states. In particular, a device-local recovered-batch pointer currently runs
receipt acknowledgement before the worker's authoritative status request. On a
second computer this owner-only/local-filesystem operation can fail and project
`reconnecting` or a provisioning-style "recovered local receipts are not ready"
message even while the shared Pod is Ready and another user is generating.

The explicit Stop GPU path also has no shared presence or consent protocol. A
locally confirmed RunPod DELETE can race another user's active or newly starting
batch, or terminate an idle warm GPU while another active editor intends to use
it. ImageForge needs one authoritative, race-safe studio control plane without
adding automatic termination, a second batch, or a queue.

## Acceptance criteria

- AC-1: Every production client projects authoritative RunPod lifecycle and
  worker `/v1/status` before attempting any device-local receipt recovery.
  A missing, invalid, inaccessible, foreign-owner, or stale local receipt ledger
  never demotes a Ready Pod, hides an active remote batch, or blocks status
  polling. Receipt recovery remains device-local and is attempted only for a
  worker-confirmed owned batch; its failures are separately actionable. A
  read-only offline Library index may independently read already-verified local
  receipt metadata, but it must emit only Library assets and may never project,
  acknowledge, reconcile, or otherwise mutate shared Pod or batch state.
- AC-2: Open macOS and Windows clients perform bounded, coalesced read-only
  observation and converge on the same current Pod ID, GPU, lifecycle/health
  phase, active-batch owner, and progress. Transitioning or foreground clients
  refresh within five seconds; observation never creates or terminates compute,
  never flickers through a fake transient phase, and never overwrites a newer
  snapshot with an older response.
- AC-3: The worker's durable process/shared-volume batch lease is the only
  generation-busy authority. A non-owner is locked only while a running,
  paused, or resumable interrupted batch owns that lease. Terminal completion,
  cancellation, or resolved failure releases the other client immediately.
  Presence, receipt recovery, and an approval-pending stop request never create
  a hidden generation queue or a false busy state.
- AC-4: While the worker is reachable, each desktop publishes an authenticated,
  ephemeral session heartbeat containing only a random client-session ID,
  foreground/background availability, and safe identity derived from the bearer
  principal. Heartbeats and stop requests contain no prompt, path, receipt,
  credential, or secret. Expired sessions disappear after a bounded TTL; worker
  restart invalidates every old session, approval, and deletion grant safely.
- AC-5: A Stop GPU request is bound to the exact freshly observed Pod ID. Any
  active batch lease is an unconditional typed `stop_blocked_by_active_batch`
  veto with owner and progress; no RunPod DELETE is attempted, even when the
  requester owns the batch or its client is disconnected.
- AC-6: With no active batch, a stop request is immediately eligible when no
  other foreground editor is live. If one or more other foreground users are
  live, every such user must explicitly approve. Any denial or bounded response
  timeout leaves the GPU running and informs the requester who kept it running.
  A peer whose heartbeat expires is no longer awaited; a newly live peer is
  included before final authorization.
- AC-7: Generation admission and final GPU-stop authorization are atomic at the
  worker boundary. Starting or resuming generation while approval is merely
  pending cancels/denies that stop request and proceeds under the one-batch
  rules. After unanimous approval, a short single-use finalization guard blocks
  new generation with typed `gpu_stop_pending` until RunPod DELETE succeeds,
  is cancelled after a definite failure, or expires safely. Network ambiguity
  always fails closed: compute remains running and no client claims it stopped.
- AC-8: Before DELETE, the desktop revalidates the exact confirmed Pod and then
  consumes the worker finalization guard between that preflight and termination.
  A changed/replaced Pod, stale request, expired approval, duplicate request,
  worker restart, already-absent Pod, timeout, authentication failure, and
  provider 5xx response cannot delete a different Pod or report false success.
  Simultaneous stop requests deterministically coalesce or return a typed safe
  conflict; they never issue two DELETEs.
- AC-9: Both clients render authored, accessible coordination UI. The requester
  sees checking, blocked-by-batch, waiting-for-named-users, denied/expired,
  approved/finalizing, failure, and stopped states. An approver receives a
  high-visibility request naming the requester and exact GPU, with functional
  **Keep GPU running** and **Approve stop** actions. Focus, keyboard operation,
  reduced motion, contrast, live-region announcements, countdown/expiry copy,
  and compact layouts meet the design system.
- AC-10: A remote Pod stop moves owned running/paused/validating work to truthful
  interrupted recovery and moves a non-owner locked projection to an
  unmanageable interrupted/offline explanation. Generate is disabled whenever
  authoritative lifecycle is not Ready, and no stale worker/proxy error may
  supersede RunPod-proven Offline.
- AC-11: The native boundary exposes only narrow, versioned worker operations for
  heartbeat, stop request, response, finalization, and cancellation. It pins the
  current worker host/Pod session, validates strict response envelopes and UUIDs,
  rejects secret reflection, and exposes no arbitrary authenticated URL or
  renderer-visible bearer token.
- AC-12: Deterministic two-client tests cover macOS/Windows-equivalent startup,
  lifecycle convergence, status-first recovery, busy release, every approval
  branch, generation/stop races, timeouts, stale epochs, disconnect/restart,
  duplicate clients/requests, and remote Stop in both directions. Existing
  450-prompt, receipt fixed-point, explicit lifecycle, and duplicate-Pod safety
  tests remain green.
- AC-13: The final beta is versioned once, independently reviewed, built on
  native macOS Apple silicon and Windows x64 runners, installed/launched, and
  smoked with two deterministic clients. Published GitHub assets are re-downloaded
  and SHA-256 verified; commit, tag, workflow, hashes, signing/notarization or
  unsigned status, worker-image digest, and zero-unintended-Pod audit are recorded.

## Non-goals

- NG-1: Do not add automatic, idle, completion-triggered, app-exit, timer, or
  background GPU termination. Every stop begins with an explicit foreground
  user click and local confirmation.
- NG-2: Do not add a second active generation batch, a waiting batch queue, a
  second model/GPU, or weaken the shared-volume/process lease.
- NG-3: Do not treat device-local files, receipts, settings names, client clocks,
  proxy failures, or renderer state as authoritative shared control state.
- NG-4: Do not add a public SaaS/account service, WebSocket requirement, prompt
  rewriting, model/GPU policy change, or paid GPU test to the deterministic gate.
- NG-5: Do not auto-terminate duplicate Pods, delete user artifacts, weaken
  `.part`/checksum/atomic-rename rules, or expose secrets in source, logs, URLs,
  screenshots, diagnostics, or API responses.

## Relevant files

- `worker/src/imageforge_worker/`: authenticated presence, stop-intent state,
  atomic generation/finalization admission, strict models, routes, and tests.
- `src-tauri/src/native/worker.rs`, `src-tauri/src/lib.rs`: narrow pinned worker
  transport and strict native projections for the coordination API.
- `src/native/tauriBridge.ts`, `src/native/productionPort.ts`: typed renderer to
  native composition without credential exposure.
- `src/adapters/productionImageForgeAdapter.ts`: status-first recovery,
  collaboration heartbeat, stop orchestration, and stale-epoch handling.
- `src/adapters/gpuLifecycleCoordinator.ts`: exact-Pod preflight with a guarded
  pre-delete hook; existing RunPod identity rules remain authoritative.
- `src/adapters/workerBatchCoordinator.ts`: worker status must precede owned
  receipt reconciliation and preserve typed busy/idle behavior.
- `src/domain/types.ts`, `src/domain/reducer.ts`: typed shared-stop state and
  truthful locked/offline transitions.
- `src/App.tsx`, `src/components/AppChrome.tsx`, `src/styles.css`: polling,
  requester/approver controls, banners/dialogs, and responsive accessibility.
- `docs/API_CONTRACT.md`, `docs/ARCHITECTURE.md`, `docs/RUNPOD_OPERATIONS.md`:
  authoritative protocol and failure semantics.
- `.github/workflows/build-desktop.yml`, release metadata files: native artifact
  verification and publication evidence.

## Automated tests

- Worker pytest: authenticated heartbeat isolation/TTL; no secret reflection;
  active-batch veto; no-peer approval; unanimous approve; denial; timeout;
  newly active/expired peer; simultaneous requests; restart invalidation;
  pending-request generation cancellation; atomic finalization versus
  create/resume/retry; single-use/expired guard; 450-prompt lease regression.
- Frontend Vitest: RunPod/worker status emits before any receipt call; non-owner
  never reconciles a recovered local batch; local recovery failure preserves
  Ready/busy truth; foreground observation coalesces and rejects stale epochs;
  requester/approver reducer and UI flows; locked remote batch becomes truthful
  offline/interrupted; Generate remains available for idle presence and is
  disabled for busy or a final stop guard only.
- RunPod-client/lifecycle Vitest: two controllers converge after remote start and
  stop; stale/replaced Pod IDs are never deleted; the pre-delete guard runs after
  exact-Pod preflight and a rejected/failed guard sends no DELETE.
- Rust tests: exact endpoint/method allowlist, Pod/session pinning, UUID and body
  bounds, strict response projection, secret redaction, timeout/error mapping,
  and no generic authenticated proxy.
- Full gates: root Vitest, TypeScript typecheck, production frontend build,
  RunPod-client suite, Python 3.11 pytest/ruff/compile checks, Rust fmt/clippy/test,
  `git diff --check`, native packaging workflows, installed-app smoke, and
  public-asset hash verification.

## Manual verification

1. Start the fake/fixture GPU on client A, open client B with a stale recovered
   batch pointer and unavailable local folder, and verify B reaches the same Pod
   ID/phase as A, shows A's active batch, and never displays receipt recovery as
   provisioning/reconnecting.
2. Complete A's batch and verify B becomes Ready/Create-capable without restart,
   local receipt access, or a queued request. Repeat with A/B reversed.
3. While A generates, confirm Stop on B and verify the worker veto names A and
   progress, both clients retain Ready/running truth, and RunPod DELETE count is
   zero.
4. With the worker idle and both clients foreground, request Stop on A. Approve
   on B and verify one exact-Pod DELETE occurs only after both confirmations.
5. Repeat step 4 with B denying, timing out, disconnecting, opening after the
   request, and clicking Generate during approval. Verify denial/expiry keeps the
   GPU running, expired peers stop blocking, newly live peers are included, and
   Generate atomically cancels the pending request without a queue.
6. Exercise simultaneous Stop, Pod replacement, worker restart, RunPod timeout,
   worker timeout, DELETE 404, DELETE 5xx, and app crash/relaunch. Verify no wrong
   Pod deletion, no false Offline, no stuck finalization guard, and actionable UI.
7. Install the packaged macOS and Windows artifacts and repeat the two-client
   startup/busy/approve/deny/remote-stop flows at 1280x720, 1440x900, and
   1920x1080 where available, including keyboard-only and reduced-motion checks.

## Evidence required

- File/line-linked independent review against every AC and non-goal.
- Targeted and full test commands with pass counts and explicit skipped/paid
  stages; rendered screenshots or observable-state notes for requester and
  approver states on both OSes.
- Release commit/tag/workflow URL, native artifact names and SHA-256 hashes,
  installed smoke results, signing/notarization or unsigned disclosure, pinned
  worker image digest publication evidence, and final RunPod active-Pod audit.
