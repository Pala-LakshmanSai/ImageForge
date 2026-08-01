# ImageForge product specification

## Problem

Two YouTube editors need 300-450 realistic 16:9 still images per video. Existing
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
3. Watch `provisioning -> loading -> warming -> ready` without using a terminal.
4. Paste or import one prompt per line (TXT or CSV), validate it, and start.
5. Download each completed image directly into the initiating machine's chosen
   folder while later images generate.
6. Review failures, retry if needed, reveal the folder, and explicitly press
   **Stop GPU**.

## Acceptance criteria

- AC-1: A nontechnical user can start a compatible available RunPod GPU and
  connect to the resulting worker without copying a Pod ID or proxy URL.
- AC-2: Start selection is fixed to EU-RO-1 Secure Cloud and the approved
  ordinary ladder: RTX 4090, RTX PRO 4500 Blackwell, RTX 5090, RTX PRO 4000
  Blackwell, L4, RTX A4500, and RTX 4000 Ada. RTX 2000 Ada is a visibly slow,
  opt-in emergency only. Current catalog availability and price are evaluated,
  and the final choice resolves at creation time through RunPod's ordered
  fallback. It chooses exactly one GPU and never silently adds B200, RTX PRO
  6000, A40/A6000, L40/L40S, or another unapproved type.
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
- AC-8: The worker loads only FLUX.2 Klein 4B BF16, uses four inference steps
  and guidance 1.0 by default, and exposes measured readiness and GPU state.
- AC-9: First-start downloads are one-time; normal starts install no packages
  and download no model weights.
- AC-10: Every operational and failure state has a deliberate UI matching or
  exceeding the attached SwipeCut reference's polish.
- AC-11: macOS and Windows installations require no development tools for use.
- AC-12: API keys and worker credentials are never stored in plaintext project
  files or included in logs.

## Non-goals for the first release

- Multiple image models, LoRAs, image editing, video generation, or an LLM.
- More than one simultaneous batch or a waiting batch queue.
- Automatic Pod termination.
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
