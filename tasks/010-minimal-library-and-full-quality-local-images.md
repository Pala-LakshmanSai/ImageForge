# Task 010 — Minimal library and full-quality local images

## Problem

The Library stretches a tiny worker preview across large cards and the detail view, making otherwise sharp 1024-pixel JPEGs look soft. The current batch also has a visible `cartoon style` suffix, so the model correctly generated cartoons even though the user expected a photographic result. Library cards expose internal UUID paths, seeds, checksums, receipt terminology, and repeated verification badges instead of presenting the images simply. The apparent per-image download control is not a real image download.

## Acceptance criteria

### AC-1 — Display the verified local JPEG at useful quality

- Production Library cards and the image detail view load the verified local JPEG, not the 180-pixel worker polling preview.
- Native code resolves the artifact through the batch receipt ledger, validates batch/index/checksum, confines the path, rejects links, and bounds bytes before returning image data.
- The renderer accepts only validated JPEG responses and retains bounded session-local object-URL caching.
- A 1024×1024 source remains visibly sharp in both a card and the large detail view on macOS and Windows.

### AC-2 — Use the user-facing batch name

- The current batch is presented as `Atlas of Quiet Work`.
- Cards show a compact frame label such as `Atlas of Quiet Work · 013`, never an internal UUID path.
- The actual named local folder and numbered JPEG remain available through Show in folder and export actions.

### AC-3 — Make the Library minimal and professional

- Replace `Your visual ledger` and technical receipt copy with direct, concise Library language.
- Remove seed, checksum, receipt-health, SHA-256, atomic-rename, and repeated `verified` badges from the primary Library UI.
- Keep seed and checksum internally for reproducibility and integrity; retain them in exported manifest data rather than deleting domain or worker fields.
- Keep only useful summary information and strong image/prompt hierarchy.

### AC-4 — Provide a real per-image download

- Every image card has an accessible Download action that saves or exports that exact verified JPEG.
- The detail view has Download and Show in folder actions; no control claims to download only a receipt.
- Card selection and Download are separate valid interactive targets with keyboard and screen-reader labels.
- Export uses a friendly filename derived from the batch name and zero-padded frame index, sanitizes it natively, and never overwrites silently.

### AC-5 — Make style behavior predictable

- New installs do not silently alter user prompts: the optional style suffix is off by default.
- Create keeps the optional style instruction visible and editable before submission.
- The installed test profile is reset away from `cartoon style` before the photographic quality smoke test.
- No prompt-rewriting model or second image model is introduced.

### AC-6 — Preserve parity and scale

- macOS and Windows use the same React layout and semantics.
- The Library remains smooth with a 450-image dataset and keeps incremental rendering.
- Empty, loading, image-load failure, search, card, detail, and download-success/error states remain explicit.

## Binding non-goals

- Do not replace FLUX.2 Klein 4B, BF16, the approved four-step inference profile, or GPU policy.
- Do not remove internal seeds, checksums, receipts, or manifest integrity fields.
- Do not expose arbitrary filesystem reads or paths to the renderer.
- Do not redesign unrelated setup or GPU safety confirmations.

## Relevant files

- `src/screens/LibraryScreen.tsx`
- `src/components/PreviewImage.tsx`
- `src/screens/ProgressScreen.tsx`
- `src/components/AppChrome.tsx`
- `src/styles.css`
- `src/domain/reducer.ts`
- `src/adapters/imageForgeAdapter.ts`
- `src/adapters/productionImageForgeAdapter.ts`
- `src/native/tauriBridge.ts`
- `src/native/productionPort.ts`
- `src-tauri/src/native/download.rs`
- `src-tauri/src/lib.rs`
- Adjacent desktop and native tests

## Automated verification

- UI tests assert concise headings, friendly frame labels, absence of seed/checksum/receipt jargon, separate card/detail Download actions, keyboard operation, and 450-item incremental rendering.
- Renderer tests reject wrong content type, size mismatch, oversized payload, and stale cache identity.
- Native tests reject a wrong batch/index/checksum, traversal, symlinks/reparse points, oversized files, and export collisions.
- Run desktop Vitest, typecheck, Rust tests, production build, and `git diff --check`.

## Manual verification

- Compare the original 1024×1024 JPEG with its card and detail rendering at normal and Retina scale.
- Download one card image and one detail image, open both, and confirm byte/checksum identity with the verified local source.
- Show the exact named folder in Finder and confirm `Atlas of Quiet Work/000013.jpg`.
- Disable the old cartoon suffix, run a photographic one-image fake/offline smoke where applicable, and confirm the submitted prompt preview contains no hidden cartoon instruction.
- Repeat packaged smoke on macOS and Windows with matching layout evidence.

## Evidence required

- Before/after screenshots of Library card and detail views.
- Source/display dimensions and exported-file SHA-256 comparison.
- Test logs for renderer, native, desktop, and packaged smoke.
