# Task 008 — Make the macOS bundle Gatekeeper-valid

## Problem

The beta DMG contained an invalid ad-hoc app signature. macOS reported the
downloaded app as “damaged” because the bundle signature did not seal its
resources.

## Acceptance criteria

- AC-1: The Tauri macOS bundle is signed with an explicit ad-hoc identity when
  no Apple Developer identity is configured.
- AC-2: `codesign --verify --deep --strict` passes for the generated `.app` and
  for the `.app` mounted from the generated DMG.
- AC-3: Release evidence clearly labels the artifact ad-hoc/unsigned and does
  not claim notarization.
- AC-4: Windows packaging and frontend behavior remain unchanged.

## Non-goals

- NG-1: Apple Developer signing or notarization without the user's certificate
  and Apple account credentials.
- NG-2: Changes to generation, RunPod, authentication, or UI behavior.

## Relevant files

- `src-tauri/tauri.conf.json`: macOS signing configuration.
- `docs/QA_LOG.md`: exact verification evidence and signing disclosure.

## Automated tests

- `npm test -- --run --pool=forks --maxWorkers=1` — all frontend tests pass.
- `npm run typecheck` — no TypeScript errors.
- `npm run build` — production frontend build passes.

## Manual verification

1. Build the macOS `.app` and `.dmg` on macOS.
2. Run deep strict code-sign verification on the app and mounted DMG app.
3. Confirm the mounted app contains the ImageForge icon and launches after
   the normal unsigned-app confirmation.

## Evidence required

- Build output paths, SHA-256, `codesign --verify` output, mounted-DMG result,
  and explicit ad-hoc/notarization status.
