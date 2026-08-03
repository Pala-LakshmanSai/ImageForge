# ImageForge QA log

This file records evidence from each build-review-repair loop. A passing unit
suite alone is not a release gate.

## Desktop shell baseline — `caec891`

Root visual/interaction pass used the in-app browser against the Vite build at
1440x900 and 1280x720.

### Evidence that passed

- The production-console visual direction matches the supplied SwipeCut
  reference without copying its product content: dark cobalt/crimson ambience,
  glass instrument bar, large editorial headings, restrained mono metadata,
  radial and linear progress, live preview, ordered pipeline, and floating nav.
- No horizontal overflow at 1280x720.
- A 450-line endurance brief parsed and rendered in about 320 ms in the browser
  check. The active progress screen rendered 15 virtual rows and 354 total DOM
  nodes rather than mounting 450 full rows.
- The second-user scenario names the owner, shows progress, disables Generate,
  and exposes no queue or join action.
- Explicit Stop GPU copy explains that the selected compute Pod is terminated
  while the network volume and durable artifacts remain. No automatic-stop
  control is present.

### Release blockers sent to repair

- Setup rendered inside a transformed screen, making its fixed backdrop relative
  to page content. At 1280x720 the dialog top measured -229 px and the sticky
  top bar/fixed nav overlaid it.
- React reused the step-one uncontrolled input for the step-two password input;
  the display name appeared inside the masked RunPod field.
- Setup did not trap/restore focus, lock background interaction, or validate
  credentials/folder connection before claiming success.
- The real fake-adapter lifecycle cancelled after its first asynchronous phase
  update and stalled at provisioning.
- Explicit termination during generation left an interrupted batch with no
  resume/cancel recovery path.
- Several settings controls were promises without behavior, and GPU fallback
  copy predated the final EU-RO-1 policy.

Independent source/accessibility review also blocked integration until these
items, dialog keyboard behavior, prompt parser errors, realistic fake download
states/retries, full receipt hashes, contrast, and cross-platform paths are
covered by tests.

## Initial review gates (superseded by the production completion loop below)

The checklist in this historical section was captured before the repair and
paid qualification passes recorded later in this file.

- Desktop visual/keyboard QA has a direct browser interaction pass after the
  repair: onboarding renders as a centered modal, a sample 24-prompt brief
  reaches Ready, the production-shaped progress screen renders live preview
  state, and Pause after frame holds the manifest lock. A final packaged-app
  keyboard pass is still pending.
- Native Tauri command checks are green: 36 Rust tests pass, including bounded
  authenticated WebP preview validation and macOS canonical-path coverage.
- The rebuilt macOS debug bundle was launched from the external build volume;
  its bundled `tauri://localhost` page rendered the first-run assistant and
  advancing step 1 placed focus in the step-2 RunPod key field. The packaged
  navigation/CSP boundary now allows same-origin asset paths while retaining
  external-origin rejection.
- Run the integrated 450-item restart/download endurance scenario.
- Run Windows CI and installer smoke test on a Windows runner.
- Run explicitly authorized real-GPU smoke benchmarks before enabling measured
  cost ranking.

## Current automated evidence — `77d5c8d` + preview hardening

- Frontend: 12 Vitest files, 70 tests passed; `npm run typecheck` and
  `npm run build` passed. The production preview path now renders authenticated
  WebP bytes through native Rust, with a session-local object URL cache and a
  safe decoder-error fallback. Setup navigation now returns keyboard focus to
  the first control on every step (including the read-only profile), with a
  regression test covering the complete four-step path. Scope/speed segmented
  controls expose pressed state and group labels to assistive technology.
- Worker: 33 offline tests passed, 1 explicitly paid real-GPU test deselected;
  Ruff passed for `worker/src` and `worker/tests`.
- External RunPod setup: the durable `imageforge-prod-50gb` volume exists as
  `ukh207b26r` in EU-RO-1. The immutable ImageForge worker image/template,
  runtime secret, and template are now published/configured; paid GPU smoke,
  model-cache preparation, two-Pod volume gate, and installers remain pending.
  The unrelated default ComfyUI template must not be used.

## Production completion loop — `fb765a0` + worker `4ee11c09`

### Evidence that passed

- Frontend: 13 Vitest files, 80 tests passed; `npm run typecheck`, `npm run
  build`, and the focused RunPod recovery regression passed.
- RunPod client: 91 lifecycle/configuration/provider tests passed, including
  live `gpuCount` plus `machine.gpuTypeId` Pod responses and ambiguous-create
  reconciliation.
- Worker: 39 offline tests passed, 1 explicitly authorized real-GPU test
  skipped; Ruff checks passed.
- Rust native core: 38 tests passed with the removable-disk toolchain.
- The ambiguous RunPod-start banner no longer reports a failed start as 100%
  complete; it shows that confirmation is required and keeps the progress track
  empty.
- Worker published from `4ee11c09f3c18610920454b70b472695714afe15` as
  `ghcr.io/pala-lakshmansai/imageforge-worker@sha256:78af99a918c9baafdb9a7246e73c054cd89448edce0f3b6fd7496074128800b6`.
- Rebuilt removable-disk macOS Apple-silicon DMG:
  `/Volumes/ImageForgeBuild/cargo-target/release/bundle/dmg/ImageForge_0.1.0_aarch64.dmg`
  SHA-256 `89d713b3beb74e6615bcbab702dfff96aaada5e52ba0eb2ec488ee7af066ca10`.

### Historical external gates (superseded by the evidence below)

- Verify the configured RunPod template boots the new public GHCR digest and
  prepare the pinned model cache on the EU-RO-1 network volume.
- Run the explicitly authorized real-GPU smoke and EU-RO-1 two-Pod volume gate.
- Build and smoke-test the Windows x64 NSIS installer on a Windows runner.
- Perform the final packaged-app keyboard/folder-reveal pass on the target OSes.

## RunPod create-payload repair — `0da1cb0`

The first live EU-RO-1 create attempt returned a RunPod validation error because
the v1 create body did not include the immutable worker image, even though the
template ID was present. The lifecycle request now carries the exact
`benchmarkContract.softwareImage` digest as `imageName`; the provider validates
it and sends it on every create. The provider and lifecycle regression suites
assert the field, and the RunPod client suite passes 91/91.

The first real 4090 warmup also exposed a worker-image defect: Triton could not
find a C compiler after all model weights and pipeline components loaded. The
worker image now installs `gcc` at build time (`647c1e6`); normal Pod boot still
performs no package installation. A fresh immutable image must pass the paid
warmup/generation smoke before the template is considered production-ready.

## Paid EU-RO-1 smoke — worker `860badb`

- The first repaired image exposed a second missing build dependency: Triton's
  CUDA helper could find `gcc` but not the standard C header `stdlib.h`.
- The worker image now installs `libc6-dev` at build time. The published
  immutable image is
  `ghcr.io/pala-lakshmansai/imageforge-worker@sha256:084f8494c901a21e52c0c2c1025ae0c972efe87f458cfdb339743341d6ef99e0`.
- The configured `imageforge-flux-worker-v1` template (`q8sfgixfy2`) points to
  that exact digest in EU-RO-1, with the public GHCR package using no registry
  credentials.
- Paid smoke Pod `0ps6ojvgqcmg79` rented an RTX 4090 at `$0.69/hr`, reached
  `phase=ready` with FLUX.2 Klein 4B BF16 revision `e7b7dc27f91deacad38e78976d1f2b499d76a294`, generated one authenticated prompt,
  and returned a valid 1280x720 JPEG. Artifact SHA-256 was
  `30303ebacafc94ffa6d1ff0dafe610e945a59b67d4e3146328e4bdff2cef0978`.
- The smoke Pod was explicitly terminated and the live Pod list returned zero
  active Pods.

The cross-Pod shared-volume lease gate and Windows installer evidence are
recorded below; the final native install/launch/uninstall smoke is now closed
on `windows-latest`.

## EU-RO-1 shared-volume qualification — `d611d99`

The paid two-Pod qualification was exercised against network volume
`ukh207b26r` in `EU-RO-1`, with both Pods using the immutable worker image
`ghcr.io/pala-lakshmansai/imageforge-worker@sha256:084f8494c901a21e52c0c2c1025ae0c972efe87f458cfdb339743341d6ef99e0` and the
isolated root `/workspace/imageforge-gates/9961ca9f8a8e`.

- Contention pass (120 prompts): Pod `x4wut3ge1kkd7l` returned HTTP 201;
  Pod `p6fau3p6qfw7kq` returned HTTP 423 with `batch_busy`. The observer's
  status read returned HTTP 200 for the same batch, and its pause mutation
  returned HTTP 423.
- Owner-stop recovery: Pod `x4wut3ge1kkd7l` was explicitly terminated with
  DELETE HTTP 204. Pod `p6fau3p6qfw7kq` recovered the shared manifest as
  `interrupted` at 17/120.
- Reversed contention pass: the roles were reversed with replacement Pod
  `xg8bysj479efjy`; the winner returned HTTP 201, the observer returned HTTP
  423 `batch_busy`, observer status returned HTTP 200, and observer mutation
  returned HTTP 423. After an explicit DELETE HTTP 204 of the winner, the
  survivor completed the 120-item manifest (`completed`, 120/120).
- Presence/maintenance checks: an idle worker observed
  `worker_presence_acquired=true` and `maintenance_presence_acquired=false`;
  after all workers were absent, an explicit maintenance probe acquired the
  maintenance lock (`true`).
- Every paid test Pod was explicitly terminated; the final RunPod Pod list
  contained zero active Pods.

The gate harness now persists the exact HTTP statuses and accepts a bounded
operator-selected prompt count only for keeping the owner alive through the
recovery handoff. It also handles a survivor that finishes the manifest before
the recovery poll observes it.

## Removable-disk release evidence — `81d0faa`

- Fresh macOS Apple-silicon DMG built from the production worktree:
  `/Volumes/ImageForgeBuild/cargo-target/release/bundle/dmg/ImageForge_0.1.0_aarch64.dmg`
  SHA-256 `706b6fc895f32730ae725220a2a2f16316b67219f11e2f6af3c515bd37154229`.
- The DMG was mounted, its embedded ImageForge app launched from the mounted
  volume, the process was observed, and the volume was detached afterward.
  The artifact is ad-hoc/unsigned for beta distribution; it is not presented
  as Apple-signed.
- A private GitHub repository now contains the source and a native
  `windows-latest` NSIS workflow at `.github/workflows/build-desktop.yml`.
  The first Windows run exposed the macOS-authored TypeScript 7 optional
  package omission; the workflow now installs the Windows compiler companion
  explicitly before tests and packaging.
- Direct macOS Windows cross-build remains intentionally unsupported: the
  target fails in `aws-lc-sys` without `windows.h`, `stdlib.h`, and an MSVC/Windows
  SDK. The native Windows workflow is the authoritative installer path.

## Windows native portability repair — `83e3d4d`

- The first native Windows run also exposed use of Rust's unstable
  `std::os::windows::fs::MetadataExt` identity methods. ImageForge now uses the
  stable Win32 `CreateFileW`/`GetFileInformationByHandle` contract with explicit
  handle closure, and enables the required `Win32_Security` feature in
  `windows-sys`.
- macOS native Rust tests remain green (38/38). A minimal removable-disk
  Windows-target compile of the exact Win32 API usage passed. The authoritative
  `windows-latest` NSIS workflow builds the full Tauri Windows target directly;
  the complete Rust suite remains covered by the removable-disk macOS run.
  This keeps the native packaging path focused and avoids a runner-hosted
  credential/UI test holding the installer job indefinitely.

## Windows NSIS artifact — run `30717838047` (superseded)

- Native `windows-latest` build completed successfully in 15m44s after the
  frontend tests and TypeScript checks passed.
- Downloaded installer:
  `/Volumes/ImageForgeBuild/windows-artifact/ImageForge_0.1.0_x64-setup.exe`
- SHA-256: `a8267713c57e7d27041e1df4499adde81fbf2654a80112df90142b28209218fa`
- Artifact inspection identifies a PE32 GUI NSIS self-extracting installer.
  The native install execution was added and is recorded in the final run
  below.

## Windows native install/launch/uninstall smoke — run `30719056249`

- The final `main` commit `913496e` passed the native `windows-latest` job in
  16m32s: frontend tests, TypeScript checks, Windows NSIS packaging, silent
  install to a disposable directory, installed executable discovery,
  `uninstall.exe` discovery, launch with the process alive after five seconds,
  silent uninstall, and temporary-directory cleanup.
- The uploaded installer is
  `/Volumes/ImageForgeBuild/windows-artifact-30719056249/ImageForge_0.1.0_x64-setup.exe`.
  SHA-256: `05408a278e95b69f6407553d367acb1e79606f104db4a517c845319a40d770d9`.
  Artifact inspection identifies a PE32 GUI NSIS self-extracting installer.
- The runner emitted only the known GitHub Actions Node 20 deprecation
  annotation; all build, smoke, and cleanup steps passed.

## Final source/release verification — commit `913496e`

- Frontend: 13 Vitest files, 83 tests passed; `npm run typecheck` and
  `npm run build` passed. The new regressions cover immutable production
  template/image binding, error progress staying at zero, and re-acknowledging
  a durable local receipt when the worker still reports `ready`.
- The production profile now uses template `q8sfgixfy2` and the exact worker
  image digest recorded above. A lifecycle error/ambiguous start is rendered
  as an action-needed, empty progress state rather than `100%`.
- Fresh removable-disk macOS DMG built from this commit:
  `/Volumes/ImageForgeBuild/cargo-target/release/bundle/dmg/ImageForge_0.1.0_aarch64.dmg`.
  SHA-256: `8da2420bf4d593ac979ec2296bdec49080eb7e94acc73b8869a766247249261f`.
  It was mounted, launched, and detached successfully. The beta artifact is
  ad-hoc/unsigned; no signing is claimed.

## Fresh final audit — current repair loop

- Frontend: 13 Vitest files, 84 tests passed; typecheck and production build
  passed after adding safe manifest render-settings projection. The regression
  now preserves a submitted 9:16 selection after worker manifest rehydration.
- Worker: 40 offline tests passed and Ruff passed; the one real-GPU test remains
  explicitly opt-in.
- Worker source commit `dbb6b712317b824b113132f1128ee91b11a46c27` was rebuilt
  by workflow `30732102432` and published as
  `ghcr.io/pala-lakshmansai/imageforge-worker@sha256:f862e1ea8ece9f35101e7c47be55a5042c17e0eb3cf8414dd709ed73a59e33ed`.
- The RunPod template `q8sfgixfy2` is now repinned to that exact digest. A paid
  RTX 4090 EU-RO-1 smoke then passed health/model identity, 1:1 reference
  generation (1024x1024), 9:16 generation (720x1280), checksum verification,
  and the two-user HTTP-423 lock/cancel path.

## Exact-image shared-volume qualification — run `gate-1785645894`

- Two fresh EU-RO-1 Secure Pods on network volume `ukh207b26r` ran the exact
  worker digest above. The first contention phase produced one HTTP 201 winner,
  one HTTP 423 `batch_busy` observer, an authoritative shared status, and an
  HTTP 423 observer mutation rejection. After the winner was explicitly
  terminated, the survivor recovered the batch from the shared volume.
- A second contention/recovery phase with the roles reversed passed the same
  checks. All three paid gate Pods were explicitly terminated afterward; the
  final RunPod list contained no active ImageForge Pod.
- Evidence is captured locally in the operator workspace as
  `imageforge-volume-gate-gate-1785645894*.json`; it contains no bearer tokens.

## Logo and desktop bundle repair — commit `a9fd340`

- Replaced the placeholder mark with the original ImageForge forged-aperture
  logo: coral-to-violet lens ring, six bright aperture blades, cyan spark, and
  transparent corners. The React header mark and generated Tauri PNG/ICO/ICNS
  assets use the same identity.
- The mounted macOS DMG initially exposed a packaging defect: the Tauri bundle
  did not declare an icon list, so `ImageForge.app` omitted `icon.icns` and
  macOS fell back to its generic placeholder. The bundle configuration now
  declares the generated icon assets explicitly.
- Final mounted-app verification found
  `Contents/Resources/icon.icns` with the same SHA-256 as
  `src-tauri/icons/icon.icns`: `60d1f6e138d4ed927542f779ebb7efb9ffed34341f849b59d3a27812953d3dc5`.
  The corrected DMG SHA-256 is
  `52de27e64e7a2bf0896504a9e6b4ee96dc5e2341f2ae4ea482278063e869601e`.
- The USB checkout also received an explicit `@types/node` dev dependency so
  its test harness does not depend on an incidental transitive installation.

## macOS Gatekeeper bundle repair — task `008`

- Root cause: the prior DMG app had an ad-hoc linker signature that did not
  seal bundle resources; `codesign --verify --deep --strict` reported
  `code has no resources but signature indicates they must be present`.
- `src-tauri/tauri.conf.json` now declares the explicit ad-hoc identity `-`
  and disables hardened runtime when no Apple Developer identity is present.
- Fresh build:
  `/Volumes/ImageForgeBuild/final-cargo-target/release/bundle/dmg/ImageForge_0.1.0_aarch64.dmg`
- DMG SHA-256:
  `6b5fd0b719eeaa8016a921f3f6a524bd7ca81637f41efc3d90c23c9276b04f0a`.
- Both the generated app and the app mounted from the DMG pass deep strict
  code-sign verification. `spctl` still rejects the ad-hoc build because it
  is not notarized; distribution remains explicitly ad-hoc/unsigned.
- Frontend verification: 13 Vitest files, 84 tests passed; typecheck and
  production build passed.

## Final working-tree audit — 2026-08-02

- Frontend: 13 Vitest files, 88 tests passed; typecheck and production build
  passed. RunPod client: 93 tests passed. Worker: 42 offline tests passed,
  one paid-GPU test explicitly skipped, and Ruff passed.
- Windows worker persistence now uses bounded byte-range leases: workers take
  one presence slot, maintenance reserves the full presence range, and the
  active-batch lease remains exclusive.
- Native Rust: 41 library tests passed after adding actual in-memory image
  decoding for JPEG/PNG/WebP references, all five render dimensions, and
  corrupt existing-receipt coverage. `cargo check --lib`, formatting, and
  `git diff --check` passed.
- Human-style web-shell pass covered first-run setup, folder write test and
  connection test, 9:16 selection, fake generation, pause, cancel, stale
  in-flight-row regression, and a 451-prompt paste with no maximum warning.
- Fresh macOS Apple-silicon release artifact from the target-specific output:
  `/Volumes/ImageForgeBuild/final-cargo-target/aarch64-apple-darwin/release/bundle/dmg/ImageForge_0.1.0_aarch64.dmg`
  SHA-256 `9f171efb89ee1cb38f629b67e2181b1ed173937c6572e3aa558483a7ba52386b`.
  The generated app and the app mounted from this DMG both pass
  `codesign --verify --deep --strict`; the artifact is explicitly ad-hoc and
  not notarized. The fresh mounted binary launched and remained alive on
  macOS; the interactive screen read was unavailable because the Mac locked.
- Windows workflow hardening now checks WebView2 presence and requires a
  native application window after launch, in addition to install/launch/
  uninstall cleanup. A Windows runner remains required for the final artifact
  execution; the Mac host cannot cross-build MSVC dependencies without the
  Windows SDK headers.

## Windows pass audit — 2026-08-02 working tree

- Audited `tasks/004-integration-release.md`, `docs/RELEASE_REQUIREMENTS.md`,
  `src-tauri/tauri.conf.json`, the Windows NSIS workflow, and all native
  Windows credential, destination, and download paths. The Tauri window is
  created in the native `setup` hook; the bundle includes `icon.ico`, uses the
  default silent WebView2 bootstrapper mode, and stores non-secret state under
  `%LOCALAPPDATA%\com.imageforge.desktop`. Credentials remain behind the
  `windows-native` keyring backend.
- Concrete Windows fixes in the current working tree: download requests now
  carry manifest render dimensions and native verification accepts and matches
  all five approved sizes (`1280x720`, `1024x1024`, `720x1280`, `1152x864`,
  `864x1152`); folder reveal resolves the absolute system `explorer.exe`
  path instead of searching `PATH`; the Windows workflow now verifies a
  WebView2 runtime and a real application window after launch.
- Focused frontend contract tests: 22/22 passed; full frontend suite: 13 test
  files, 88 tests passed; typecheck and production build passed. Rust formatting
  and `git diff --check` passed.
- The Mac host has the `x86_64-pc-windows-msvc` Rust target installed, but a
  direct Windows-target `cargo check` cannot run here because `aws-lc-sys`
  requires the Windows SDK/MSVC headers (`windows.h`, `stdlib.h`). This was
  closed by the authoritative native `windows-latest` run `30744984576` for
  commit `c5964ac`: frontend tests, typecheck, NSIS build, WebView2 detection,
  silent install, native launch with a nonzero window handle, cleanup, and
  artifact upload all passed.

## Published beta artifacts — commit `c5964ac`

- GitHub prerelease: `https://github.com/Pala-LakshmanSai/ImageForge/releases/tag/v0.1.0-final-platform-audit`
- Apple-silicon DMG: `ImageForge_0.1.0_aarch64.dmg`, SHA-256
  `9f171efb89ee1cb38f629b67e2181b1ed173937c6572e3aa558483a7ba52386b`.
  The app is ad-hoc signed, not notarized; deep/strict verification passed
  for the generated and mounted app.
- Windows x64 NSIS installer: `ImageForge_0.1.0_x64-setup.exe`, SHA-256
  `0592889a20404a03734f73232f8f1f108c037b964335f61b8a0324c8c12b9626`.
  The release assets were downloaded back from GitHub and matched these
  hashes byte-for-byte.
- The explicitly marked deterministic endurance gate
  `worker/tests/test_endurance.py` passed separately in 8.56s: 450 ordered
  prompts, pause, second-client `batch_busy`, process restart, resume, and
  final artifact checksum/order validation.
- Clean browser interaction pass after stopping concurrent build writers:
  first-run setup, two local PNG references, preview metadata and removal,
  re-add, fake RTX 4090 start, 24-prompt launch, streamed verified downloads,
  cancellation with completed files retained, and explicit GPU termination
  all passed; browser console warnings/errors were empty. A prior attempted
  pass was reset by Vite full-page reloads caused by concurrent TypeScript
  build output under `packages/runpod-client/dist`, not by the application;
  the clean rerun had no reloads.

## Recovery fix rebuild — commit `b5df0bb`

- Added typed `authentication_required` propagation and a screenshot-safe
  worker-credential replacement flow. Replacement is available while an idle
  GPU is attached and disabled during an active batch. Focused recovery tests,
  the full frontend suite (90 tests), typecheck, and production build passed.
- Current Apple-silicon DMG: `/Volumes/ImageForgeBuild/final-cargo-target/aarch64-apple-darwin/release/bundle/dmg/ImageForge_0.1.0_aarch64.dmg`, SHA-256
  `d0fb57a70ff66fd5e7c4a3b2fd4948227f00fa1b172ac36bea9a58fcc00baf58`.
  Generated and mounted app deep/strict codesign verification passed;
  `hdiutil verify` passed; the app launched successfully. It is ad-hoc signed
  and not notarized.
- Native Windows run `30746218655` passed for `b5df0bb`: frontend tests,
  typecheck, Windows NSIS packaging, WebView2 detection, install, real-window
  launch, cleanup, and artifact upload. Current Windows installer SHA-256:
  `3282b966e7f2fe9944a0415a8254cdeb88c0894e7b8702dc3d02398a1a6af28f`.
- The existing GitHub prerelease remains tied to `c5964ac` and its previously
  published hashes; the newer `b5df0bb` artifacts have not been silently
  substituted.

## Cross-platform hardening — pending native workflow run

- Fixed idle-Pod RunPod API-key recovery: replacing the API key is now allowed
  while an attached Pod is idle and remains blocked during an active batch.
  Worker-token validation now matches the worker's 16–512-character bearer
  contract. The worker Docker healthcheck now requires both `phase=ready` and
  `model.status=ready`, so a process in a boot-error phase cannot appear
  healthy.
- Read-only RunPod inventory refresh now says `checking inventory` /
  `Refreshing`; it no longer implies that a billed GPU start occurred.
- Added an explicit `IMAGEFORGE_NATIVE_SMOKE=1` test-only mode. The bundled
  Tauri webview exercises first-run onboarding, fake GPU readiness, fake batch
  launch, reference-image add/remove/re-add, and folder reveal, and reports a
  pass marker through a narrow native command. Production startup never enables
  this mode or selects the fake adapter.
- Desktop CI now builds and verifies both macOS Apple-silicon and Windows x64
  artifacts and emits per-artifact SHA-256, version, commit, architecture, and
  signing/notarization metadata. The native workflow smoke runs on unlocked
  platform runners; this locked Mac could verify the rebuilt DMG's strict
  signature and `hdiutil` checksum but could not complete its WebKit UI smoke.
- Pre-version-alignment Apple-silicon DMG SHA-256:
  `357e74ffc29dd1c858028c2d8bd32a4a65a6fbadeefc211a2144d6f629336847`.
  It is ad-hoc signed and not notarized. Desktop release identity is now aligned
  at `0.1.4`; the final versioned hashes are recorded after the native workflow.

## v0.1.5 named folders and minimal full-quality Library — 2026-08-02

- The existing `Atlas of Quiet Work` recovery was migrated from its internal
  UUID directory to `batches/Atlas of Quiet Work` through the durable native
  batch-folder mapping. Read-only verification found 21 numbered JPEGs, 21
  matching receipts, identical size/SHA-256 pairs, and no `.part` file. The
  three unfinished images were not generated because the GPU remains
  explicitly off; ImageForge did not start or stop paid compute automatically.
- Production Library cards and the detail view now read the receipt-bound local
  JPEG rather than stretching the small polling preview. Native reads are
  confined to the validated destination, reject links/reparse points, verify
  the already-open file bytes, and enforce JPEG and byte limits. Sampled local
  sources were 1024 x 1024. The current batch appears as compact labels such as
  `Atlas of Quiet Work · 001`; UUID paths, seeds, checksums, receipt language,
  and repeated verification badges are absent from the primary Library UI.
- Each card and detail view has a separate accessible Download action. Native
  export uses a friendly batch-and-frame filename and an atomic no-overwrite
  move. Show in folder resolves the actual named local path. Receipt-only
  offline restoration shows only real local metadata and does not invent a
  completed batch, placeholder prompt, or render duration. Progress now passes
  the first real saved filename to the reveal command, with destination-root
  fallback only before the batch has any local image; its repair test and
  independent re-review passed.
- The optional style instruction is off by default for new installs. The local
  test profile was reset from `cartoon style` to a neutral editorial instruction
  while remaining off, so prompts are sent exactly as entered unless a user
  explicitly enables it.
- Final local checks: desktop Vitest 125/125, RunPod client 95/95, Rust release
  tests 57/57, root typecheck, production build, Rust formatting, and
  `git diff --check` passed. Independent review reported no remaining must-fix
  finding. The packaged app launched and the pre-polish candidate was inspected
  interactively with 21 sharp local cards, exact batch naming, and per-card
  Download controls. The packaged smoke now also checks a fast completed fake
  batch, named minimal Library, Download, image detail, and folder reveal on
  both native CI runners. Its complete deterministic renderer flow passes in
  Vitest. The exact local smoke could not advance while this Mac was locked and
  timed out without a pass/fail marker, so unlocked native CI is authoritative.
- Final local Apple-silicon candidate:
  `/Volumes/ImageForgeBuild/cargo-target/release/bundle/dmg/ImageForge_0.1.5_aarch64.dmg`,
  SHA-256 `07cea6fec3320b17e26d6cd3c191d0ac7f7045ffab89c15437d7a32201422113`.
  `codesign --verify --deep --strict` and `hdiutil verify` passed. This beta is
  ad-hoc signed and not notarized; no production signing claim is made.

## v0.1.9 authoritative studio synchronization candidate — 2026-08-03

- Task contract: `tasks/012-authoritative-studio-sync-and-coordinated-stop.md`.
  Desktop candidate commit `67b80b7fdd085afa764a16250b2913d86e4f7767`
  is pushed on `codex/final-platform-audit`. It fixes status-first local receipt
  recovery, bounded authoritative cross-client observation, exact shared batch
  ownership/progress, fail-closed peer-coordinated Stop GPU, remote-stop
  interruption truth, exact-Pod deletion guards, and the accessible requester /
  approver UI. The release is versioned consistently as `0.1.9`.
- Local and independent gates passed: frontend Vitest 193/193, RunPod client
  106/106, worker Python 67 passed with one explicitly paid `real_gpu` test
  deselected, worker Ruff and compile checks, TypeScript, production Vite build,
  Rust formatting, release Clippy with warnings denied, and Rust 72/72. The
  supported local Rust path sourced `scripts/use-usb-toolchain.sh`, which keeps
  Cargo output on the APFS removable-disk cache and disables AppleDouble copies;
  a raw Cargo target on the FAT project volume is unsupported because generated
  `._*` metadata can be parsed as dependency input.
- Native workflow
  `https://github.com/Pala-LakshmanSai/ImageForge/actions/runs/30815852852`
  passed at the exact candidate commit on both `macos-14` Apple silicon and
  `windows-latest` x64. Both jobs built the production application, installed
  and launched it, observed distinct native client PIDs/windows with isolated
  webview stores, ran the one-client UI smoke plus the installed two-client
  production-runtime smoke, cleaned up, wrote metadata, and uploaded artifacts.
- The re-downloaded macOS Actions artifact verified byte-for-byte:
  `ImageForge_0.1.9_aarch64.dmg`
  (`72cbd60877db833e43d62c37cab48857ce87f4ec0616fab14cc06a0855c80c60`),
  coordination audit
  (`2468644e17fab0205b54057d95e41ae2f488d00b2c849121359a67ac7452b6b6`),
  client A result
  (`d27908b18b83c81d1220cb154dd14a2d75d55ce774f8fa44a8d014b4e6ab0200`),
  client B result
  (`dd4e57bc5460a10c5999084ccafb28b5b3d2083171d44cd33316181b0cda7f54`),
  and metadata file
  (`55b2527d5e8deef817eb55441a6fa8cb7858a1917c8e4f62d586f6fb464ed570`).
  `hdiutil verify` also passed. The beta is ad-hoc signed and not notarized.
- The re-downloaded Windows Actions artifact verified byte-for-byte:
  `ImageForge_0.1.9_x64-setup.exe`
  (`0ca7822db565595c711e3726ca78397bbef5da8bfbf21d157b05527d862109c5`),
  coordination audit
  (`aadf78ea0c8a1df5d56b2460ae9404f855fe82ddce250ad39a2752429fa4af82`),
  client A result
  (`08831d37195f816abf3c0bd50ea37b9f26c83e6693d3590cabd81816f71f051c`),
  client B result
  (`081845f6e93a8a108767af9f75366076ab61e06fe4f8cdd31bfa29fa616ddc4f`),
  and metadata file
  (`ac68376660038f20d06d4b1d4ba43a74a1d78c5761190e7c4ad81c01f41b6103`).
  The installer is an unsigned NSIS beta.
- Each OS audit passed 25 checkpoints and 16/16 assertions: both clients
  converged through loading, warming, and Ready; observed the same 450-image
  batch and exact `137 / 450` progress; streamed 137 owner artifacts; released
  busy truth; vetoed Stop during active work; covered peer approve, deny,
  timeout, and generation-versus-pending-stop; stopped replacement Pods in both
  directions; issued exactly two expected fixture deletes; and recorded zero
  unexpected creates/deletes. The fixture was loopback-only, required random
  authorization, and retained no request bodies.
- A credential-safe, GET-only RunPod audit at `2026-08-03T13:00:10.700Z`
  returned zero active Pods. One historical Pod was present only in `EXITED`
  state; no RunPod mutation or paid GPU test was performed.
- Independent final desktop review reported no must-fix finding. The only CI
  maintenance note is the non-blocking GitHub Actions Node 20 deprecation
  annotation for pinned v4 actions.

### Publication gate still open

- This candidate is **not** a published v0.1.9 beta yet. GitHub Releases still
  ends at v0.1.8; therefore no public-release asset re-download claim, v0.1.9
  tag, or final release URL is recorded here.
- The matching worker source is pushed at dedicated repository commit
  `f4970f24248e8348dc0ea0cdacd677435d8751f0`; its separately recorded local
  worker tests pass, but there is no green publisher evidence for that commit.
  Publisher runs `30808822551` and `30809119392` were rejected before their jobs
  started because the private repository's GitHub Actions billing/spending limit
  is unavailable. The latest published worker digest is for older source and is
  intentionally not reused. Until the repository owner either restores private
  Actions billing or explicitly authorizes a reviewed visibility/publisher
  authority change, there is no supportable Task 012 immutable worker digest to
  pin in the desktop, RunPod template, runbook, tag, or release.
