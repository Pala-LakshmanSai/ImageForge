# Task 005 — Accept unbounded prompt-list sizes

## Problem

ImageForge was written around the original 300–450-image production target and
currently rejects a batch after 450 prompts. That target is a workflow hint,
not a product limit: users must be able to submit any finite prompt list that
their available storage, memory, time, and GPU budget can handle.

## Acceptance criteria

- AC-1: The desktop parser accepts more than 450 non-empty prompts without a
  count error and preserves source order and duplicate warnings.
- AC-2: The desktop UI never displays a maximum prompt count; it displays the
  current count and keeps the virtualized list usable for large finite lists.
- AC-3: The worker accepts any non-empty finite prompt list and receipts for
  that batch without an arbitrary 450/500-item cap. Empty prompts remain
  rejected and stable integer/index validation remains enforced.
- AC-4: Prompt text is not rejected solely because it exceeds the old 600
  character cap. The app may still reject malformed input (for example an
  unterminated CSV quote) and must preserve prompt text after normalization.
- AC-5: The one-active-batch lease, ordered manifests, resumable downloads, and
  crash-safe persistence remain unchanged.
- AC-6: Existing 450-prompt endurance coverage remains, and new tests exercise
  a list above 450 at both the desktop parser and worker request boundary.

## Non-goals

- NG-1: Do not add a second active batch or a waiting queue.
- NG-2: Do not remove practical OS, filesystem, HTTP transport, or GPU memory
  constraints; report those failures clearly if the environment cannot handle
  a requested batch.
- NG-3: Do not change model, GPU policy, output format, or RunPod lifecycle.

## Relevant files

- `src/domain/prompts.ts`: desktop prompt parsing and validation.
- `src/screens/CreateScreen.tsx`, `src/screens/ProgressScreen.tsx`,
  `src/screens/SettingsScreen.tsx`: copy and count presentation.
- `worker/src/imageforge_worker/constants.py`, `domain.py`, `app.py`: worker
  request and artifact-index validation.
- `src/domain/prompts.test.ts`, `worker/tests/`: regression coverage.
- `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/QA_LOG.md`: contract
  language and evidence.

## Automated tests

- Frontend Vitest: parse at least 451 prompts and one prompt longer than 600
  characters; expect no count/length error and stable indices.
- Worker pytest: validate a request above 500 prompts and a receipt set above
  500 items; expect successful model validation without changing lease rules.
- Full frontend, worker, Rust, lint, and build checks remain green.

## Manual verification

1. Paste or import a list larger than 450; the UI shows the exact current count
   with no “maximum” warning and remains scrollable.
2. Submit it through the fake adapter; the active batch reports the exact total
   and remains exclusively locked to its owner.
3. Inspect a worker manifest and receipt response above 500 items; indices and
   checksums remain ordered and resumable.

## Evidence required

- Test output for the new parser and worker cases.
- Screenshot or recorded observation of the large-list Create screen.
- Diff review proving no product maximum remains in the request path.
