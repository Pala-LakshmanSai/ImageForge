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

## Pending gates

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

### Still-required external gates

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

The cross-Pod shared-volume lease gate, Windows installer smoke, and final
packaged-app keyboard/folder-reveal checks remain separate release gates.

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
