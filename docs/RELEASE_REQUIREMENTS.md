# Desktop release requirements

## Supported applications

- macOS universal or Apple-silicon signed-or-ad-hoc beta DMG.
- Windows 10/11 x64 NSIS installer.
- One shared React product and Rust native core; no separate product forks.

The repository and development caches stay on the removable USB drive. End-user
installers place only the packaged application on the target computer. Model
weights never download to either editor's computer.

## Native responsibilities

- OS credential-vault storage for the RunPod key and worker bearer token.
- Native download-directory selection and persisted permission-safe path.
- Authenticated RunPod and worker transport without exposing secrets to logs.
- Resumable Range downloads to `.part`, SHA-256 verification, atomic rename, and
  collision-safe ordered filenames inside a durable user-named batch folder.
- Receipt-bound full-quality Library reads and native per-image export with a
  friendly filename, a native save dialog, and collision refusal.
- A versioned, private device-local queue journal with per-item immutable
  records, copied reference blobs, atomic generation pointers, corruption
  quarantine, optimistic revisions, and one process/file runner lease.
- Scoped queue keep-awake ownership that prevents system idle sleep without
  forcing the display awake, plus deterministic release on pause, completion,
  attention, reset, lease loss, and process exit.
- A durable queue-completion notification outbox. Native notification delivery
  is exact-event keyed; Web Audio and the visible Ring now action are fallbacks,
  and no alert path may call RunPod Stop.
- Local settings, receipt ledger, diagnostics export, and install updates.

## Beta gate

- Typecheck, unit, reducer, HTTP-contract, and Python tests pass.
- A deterministic 450-prompt fake run completes in order and survives restart.
- A three-batch device-local queue smoke completes in order while the installed
  app is foregrounded and minimized, verifies saved receipts before successor
  admission, and produces one completion event without starting or stopping a
  Pod. Relaunch leaves the queue paused and authorization-required.
- Queue persistence tests cover CURRENT/index/item corruption, missing or
  tampered references, journal crash seams, exact runner contention, explicit
  unrecoverable-store reset/quarantine, and native/TypeScript schema parity.
- On each installed-app release runner, 450 queue rows mount at most 40 row
  elements and 30 keyboard move/select samples record p95 input-to-next-paint
  below 100 ms. The result file and raw samples ship with the build evidence.
- Native queue notification, one 15-minute snooze, permission-denied fallback,
  and keep-awake acquire/release cleanup are exercised on both operating systems.
- Both-user lock and coordinated Stop behavior is exercised from two distinct
  installed app processes and native windows on each OS runner, with separate
  webview profiles and one deterministic loopback authority. The gate covers
  status-first stale recovery, lifecycle/progress convergence, busy release,
  active-batch veto, approval, denial/timeout, generation-versus-stop, exact
  DELETE counts, and remote Stop in both directions.
- The Task 014 selector is exercised from installed macOS Apple-silicon and
  Windows-x64 artifacts against the same strict 10-row deterministic fixture.
  Each viewport/action group contains exactly 30 valid trusted-input samples,
  mounts the exact hashed row IDs, and has nearest-rank p95 below 100 ms. The
  canonical evidence path binds platform, version, commit and installer hash.
- A two-process target-native switch smoke uses production Rust journals,
  leases, monotonic inventory receipts, queue reservation and private authority
  consumption with only outbound provider/worker I/O replaced by loopback
  deterministic servers. It proves active-owner consent, one finished frame,
  queue/keep-awake park, one normal-path old DELETE before one replacement POST,
  same volume/profile/image, replacement adoption, ready-paused, explicit
  Resume, process-death recovery, and zero unintended provider mutations.
- Crash/network fixtures prove the one logical old-Pod deletion counter
  `0 -> 1 -> 2` (initial plus at most one explicit same-intent retry), no third
  DELETE, no POST under delete uncertainty, one POST per replacement attempt,
  required exact-ID plus profile-list absence, and no name/peer adoption.
- Rust, TypeScript and Python consume the same GPU identity, raw price,
  benchmark-v2, wide-integer, runtime identity and switch-code fixtures. No
  legacy 80/120/191-byte GPU validator, binary-float price authority, unknown
  code, or renderer provider/finalization grant remains.
- UI is visually reviewed at 1440×900, 1280×720, and a narrow Settings window.
- Keyboard navigation, visible focus, reduced motion, contrast, and screen-reader
  labels pass an accessibility review.
- Secrets are absent from source maps, browser storage, logs, error text, and
  exported diagnostics.
- The macOS app is copied from the mounted DMG and launched on Apple silicon;
  the Windows NSIS artifact is installed, launched, and uninstalled on a real
  Windows runner. Both runners retain the two-client fixture audit and distinct
  process result files as release evidence.

Task 013 queue evidence is strict JSON, not a prose-only pass marker. Each
native job must validate it with
`node scripts/validate-queue-release-smoke.mjs <evidence.json> <attestation.json>
<output-directory>`, include the raw 30 timing samples, and retain the result,
evidence, and attestation beside the installer. The proof boundary and primary
platform research are recorded in
[the Task 013 queue release decision record](TASK_013_QUEUE_RELEASE_DECISION_RECORD.md).

- `ImageForge-macos-queue-release-smoke.json`,
  `ImageForge-macos-queue-release-attestation.json`, and
  `ImageForge-macos-queue-release-result.txt`.
- `ImageForge-windows-queue-release-smoke.json`,
  `ImageForge-windows-queue-release-attestation.json`, and
  `ImageForge-windows-queue-release-result.txt`.

Release metadata records the SHA-256 of all three files. A workflow artifact upload
is build evidence only: the beta remains unpublished until the final public
release assets are re-downloaded and their installer, queue evidence, result,
and metadata hashes match the recorded values.

Real GPU benchmarks are a separate paid gate and run only after explicit user
authorization and credentials are available.

Task 014 selector performance evidence is written separately per platform at
`release-evidence/gpu-selector-perf-v1/<commit>/<version>/<platform>/<artifact-sha256>/gpu-selector-perf-10-v1__1280x720__1440x900.json`.
The release validator requires the fixed fixture/hash, 30 samples for every
action and viewport, exact build identity, all p95 values `< 100000us`, and the
actual installed artifact SHA-256. Missing counterpart-platform evidence,
mixed builds, symlinks, path drift, or renderer-authored duration fails the
gate. A normal workflow skip of the separately supervised paid real-RunPod
switch is recorded as skipped, never passed.
