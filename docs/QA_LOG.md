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
