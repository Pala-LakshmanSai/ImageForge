# ImageForge product specification

## Problem

Two YouTube editors usually need 300-450 realistic 16:9 still images per video. Existing
hosted frontier APIs are too expensive, and the previous multi-model RunPod
application took 30-60 minutes to become usable.

## Primary users

- Lakshman uses macOS and Windows.
- Sujal uses Windows and must not need terminal or development knowledge.

## Core workflow

1. Complete one-time setup with user identity, RunPod API key, worker secret,
   network volume, template, and local output folder.
2. Press **Start GPU**. ImageForge asks RunPod to deploy the best-value approved
   GPU, atomically falling back to the next type when the first is unavailable.
   The GPU chip may instead open the live selector so the editor can compare
   exact availability, observed hourly price, measured speed, and estimated
   batch cost before explicitly starting one GPU.
3. Watch `provisioning -> loading -> warming -> ready` without using a terminal.
4. Paste or import one prompt per line (TXT or CSV), validate it, and start.
5. Optionally stage several device-local batches, explicitly press **Run queue**,
   and let ImageForge submit them one at a time. A completion alarm tells the
   editor when the authorized cohort is fully saved; stopping the GPU remains
   a separate explicit action.
6. Save each completed image directly into a folder named for the user's batch
   while later images generate. Browse the full-quality local JPEG or download
   a separate copy with a friendly batch-and-frame filename.
7. Review failures, retry if needed, reveal the folder, and explicitly press
   **Stop GPU**.
8. When a Pod is already running, the same GPU chip may start one coordinated
   **Switch GPU** transaction. ImageForge finishes at most the current image,
   durably pauses the batch and local queue, obtains every required editor's
   consent, permanently deletes the exact old Pod, proves it absent, creates
   one selected replacement with the same network volume, verifies the exact
   worker/runtime identity, and leaves work paused for an explicit Resume.

## Acceptance criteria

- AC-1: A nontechnical user can start a compatible available RunPod GPU and
  connect to the resulting worker without copying a Pod ID or proxy URL.
- AC-2: Start selection is fixed to EU-RO-1 Secure Cloud and the approved
  ordinary ladder: RTX 4090, RTX PRO 4500 Blackwell, RTX 5090, RTX PRO 4000
  Blackwell, L4, RTX A4500, RTX 4000 Ada, A100 80GB PCIe, and the RTX PRO 6000
  Blackwell Server and Workstation editions. RTX 2000 Ada is a visibly slow,
  opt-in emergency only. Current catalog availability and price are evaluated,
  and the final choice resolves at creation time through RunPod's ordered
  fallback. It chooses exactly one GPU and never silently adds B200, A40/A6000,
  L40/L40S, or another unapproved type.
- AC-3: Stop terminates compute only after an explicit confirmation. No timer,
  background monitor, or completed-job event can terminate a Pod.
- AC-4: The app parses, previews, and submits any finite ordered prompt list,
  including the original 300-450 prompt production brief.
- AC-5: The server accepts one active batch. Another user sees who owns it and
  current progress and cannot submit or join a hidden queue.
- AC-6: Results are 1280x720 JPEG files in stable numeric order and are written
  to the initiating device. A CSV manifest maps indices, prompts, seeds, files,
  checksums, timings, and failures.
- AC-7: Closing/reopening the client resumes missing downloads. Recreating a
  Pod can resume an interrupted manifest at the first incomplete prompt.
- AC-7a: User-facing cards, details, folders, and exports use the batch name and
  frame number. UUIDs, seeds, checksums, and receipt mechanics stay out of the
  primary UI while remaining available internally and in the CSV manifest.
- AC-8: The worker loads only FLUX.2 Klein 4B BF16, uses four inference steps
  and guidance 1.0 by default, and exposes measured readiness and GPU state.
- AC-9: First-start downloads are one-time; normal starts install no packages
  and download no model weights.
- AC-10: Every operational and failure state has a deliberate UI matching or
  exceeding the attached SwipeCut reference's polish.
- AC-11: macOS and Windows installations require no development tools for use.
- AC-12: API keys and worker credentials are never stored in plaintext project
  files or included in logs.
- AC-13: The Task 013 queue is persisted only on the initiating device, freezes
  one explicitly authorized cohort, and submits its batches sequentially through
  the existing single worker lease. It never creates a worker-side or cross-device
  waiting queue, never starts or stops a Pod, and never restores run authorization
  after the app relaunches.
- AC-14: Queue completion is reached only after every cohort row is terminal and
  local receipt/download reconciliation is settled. ImageForge then creates one
  durable completion event, raises a native notification plus in-app alarm, and
  offers Dismiss or one 15-minute Snooze without implying that compute stopped.
- AC-15: Keep awake is an explicit per-run choice. It prevents system idle sleep
  only while the authorized foreground queue runner owns its native lease, allows
  the display to sleep, and is released on pause, completion, reset, or process exit.
- AC-16: The GPU chip opens the Task 014 compact live selector. It exposes only
  policy-approved EU-RO-1 Secure one-GPU offers, refreshes while the foreground
  sheet is open, distinguishes fresh, inventory-stale, benchmark-expired, and
  unmeasured data, and never presents a heuristic speed score.
- AC-17: Manual Start and coordinated Switch are explicit foreground actions
  backed by a native monotonic inventory receipt and exact micro-USD price.
  Renderer state, a persisted journal, a stale catalog, or a timer is never
  provider authority.
- AC-18: A Switch preserves exactly one active Pod/volume writer. It uses
  cross-client worker consent, finishes at most the current image, proves the
  exact old Pod absent before one replacement POST, verifies the same volume,
  image, GPU and runtime, and leaves the batch and queue paused. No failure,
  completion, alarm, or recovery path starts, switches, resumes, or stops a Pod
  automatically.

## Non-goals for the first release

- Multiple image models, LoRAs, video generation, or an LLM. Optional FLUX.2
  Klein reference images are supported as a batch-level input; this does not
  add another model or a prompt-rewriting step.
- More than one simultaneous worker batch, a worker-side waiting queue, or a
  cross-device queue. The device-local sequential staging queue defined by
  [Task 013](../tasks/013-local-sequential-batch-queue-and-completion-alarm.md)
  is the narrow exception; it still holds only one remote batch lease at a time.
- Automatic Pod termination.
- In-place GPU mutation, simultaneous Pods sharing the production volume,
  automatic price-driven switching, automatic switch fallback, or automatic
  batch/queue resume. The narrow explicit replacement saga is defined by
  [Task 014](../tasks/014-live-gpu-selector-and-coordinated-switch.md).
- Accounts, billing, subscriptions, public SaaS hosting, or team administration.
- Mobile or browser-only versions.
- Automatic prompt rewriting. The visible Editorial Realism suffix is allowed.

## Default generation contract

- Model: `black-forest-labs/FLUX.2-klein-4B`
- Precision: BF16
- Size: 1280x720
- Steps: 4
- Guidance: 1.0
- Output: JPEG quality 95 plus 320px WebP preview
- Retries: two automatic attempts after the initial failure
- Retention: until acknowledged downloaded, then eligible for cleanup; hard
  safety retention target 24 hours

## Success measurements

- A 450-prompt fake-inference endurance test completes with correct ordering,
  ownership, pause/resume/cancel, and resumable downloads.
- Real GPU benchmark records boot phases, seconds/image, peak VRAM, transfer
  rate, failure count, and cost/image for every available approved GPU.
- User taste review approves the major screens at desktop sizes on both OSes.
- A three-batch device-local queue survives an app restart without resuming
  automatically, preserves exact order and references, reconciles every local
  receipt before advancing, and produces one completion event plus at most one
  explicit snooze re-alert.
