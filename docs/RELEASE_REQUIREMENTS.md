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
- Local settings, receipt ledger, diagnostics export, and install updates.

## Beta gate

- Typecheck, unit, reducer, HTTP-contract, and Python tests pass.
- A deterministic 450-prompt fake run completes in order and survives restart.
- Both-user lock behavior is exercised from two independent clients.
- UI is visually reviewed at 1440×900, 1280×720, and a narrow Settings window.
- Keyboard navigation, visible focus, reduced motion, contrast, and screen-reader
  labels pass an accessibility review.
- Secrets are absent from source maps, browser storage, logs, error text, and
  exported diagnostics.
- macOS artifact is launched on macOS; Windows artifact is built and smoke-tested
  on a real Windows runner before handoff.

Real GPU benchmarks are a separate paid gate and run only after explicit user
authorization and credentials are available.
