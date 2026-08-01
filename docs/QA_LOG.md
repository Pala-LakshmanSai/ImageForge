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
- A maximum 450-line brief parsed and rendered in about 320 ms in the browser
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
  A final bundled-app launch check remains pending.
- Run the integrated 450-item restart/download endurance scenario.
- Run Windows CI and installer smoke test on a Windows runner.
- Run explicitly authorized real-GPU smoke benchmarks before enabling measured
  cost ranking.

## Current automated evidence — `77d5c8d` + preview hardening

- Frontend: 12 Vitest files, 69 tests passed; `npm run typecheck` and
  `npm run build` passed. The production preview path now renders authenticated
  WebP bytes through native Rust, with a session-local object URL cache and a
  safe decoder-error fallback.
- Worker: 33 offline tests passed, 1 explicitly paid real-GPU test deselected;
  Ruff passed for `worker/src` and `worker/tests`.
- External RunPod setup: the durable `imageforge-prod-50gb` volume exists as
  `ukh207b26r` in EU-RO-1. The immutable ImageForge worker image/template,
  runtime secrets, paid GPU smoke, two-Pod volume gate, and installers are not
  yet published, so the unrelated default ComfyUI template must not be used.
