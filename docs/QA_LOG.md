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
  requires the Windows SDK/MSVC headers (`windows.h`, `stdlib.h`). The
  authoritative native `windows-latest` evidence remains run `30719056249`
  (install, launch, uninstall) for commit `913496e`; that artifact predates
  this working-tree audit and must be regenerated on Windows before release.
