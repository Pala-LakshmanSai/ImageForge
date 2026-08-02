# Task 007 — Replace the ImageForge placeholder icon with a production mark

## Problem

The packaged application is showing a generic placeholder icon instead of a
distinctive ImageForge identity. The logo must remain legible at small desktop
icon sizes and match the dark ink, crimson/coral, cobalt/violet visual system.

## Acceptance criteria

- AC-1: The source mark is an original, vector-friendly ImageForge logo that
  communicates a forged image/aperture/spark without relying on text.
- AC-2: The React brand mark and Tauri macOS/Windows icon assets use the same
  visual mark and preserve crisp contrast at 16–32px and 128–512px.
- AC-3: Generated icon assets include transparent corners, no placeholder
  glyph, and valid PNG/ICO/ICNS outputs accepted by Tauri.
- AC-4: Existing app behavior and accessibility labels remain unchanged.
- AC-5: Frontend tests, typecheck, and a production build pass after the change.

## Non-goals

- NG-1: No change to application workflow, model, RunPod behavior, or layout.
- NG-2: No third-party brand imitation or copied logo asset.
- NG-3: No text baked into the app icon.

## Relevant files

- `assets/imageforge-app-icon.svg`: canonical vector mark.
- `src/components/BrandMark.tsx`: in-app header mark.
- `src-tauri/icons/*`: generated desktop bundle assets.

## Automated tests

- `npm test -- --run --pool=forks --maxWorkers=1`: existing frontend suite passes.
- `npm run typecheck`: TypeScript passes.
- `npm run build`: production bundle passes.
- `file src-tauri/icons/icon.png src-tauri/icons/icon.ico src-tauri/icons/icon.icns`:
  all platform assets are valid.

## Manual verification

1. Render the app header at desktop size and verify the mark is colorful,
   recognizable, and aligned with the ImageForge wordmark.
2. Inspect the generated icon at 16px, 32px, 128px, and 512px; verify no
   placeholder square, clipping, or muddy edges are visible.
3. Mount the packaged macOS app or inspect the Windows installer output and
   verify the bundle icon matches the in-app mark.

## Evidence required

- Updated canonical SVG and generated Tauri icon assets.
- Test/build output and a visual inspection screenshot or image render.
