# Task 004 — Integration, endurance, polish, and packaging

## Acceptance criteria

- Connect the desktop to RunPod and worker adapters with resumable downloads.
- Verify the other user receives a blocking state and no request is queued.
- Run a 450-prompt fake endurance test and real smoke benchmarks for every
  available approved GPU type when credentials and capacity are available.
- Complete independent functional, security, visual, and accessibility review.
- Produce tested macOS and Windows beta installers.

## Native desktop boundary

- The React renderer never receives a saved secret. An uncontrolled password
  field may hand a new value directly to a narrow Tauri command, after which it
  is cleared. Secrets must never enter reducer state, browser storage, files,
  logs, diagnostics, crash metadata, URLs, or command responses.
- Tauri stores the RunPod API key and the per-user worker bearer token in macOS
  Keychain or Windows Credential Manager. It returns configured/redacted
  metadata only.
- RunPod requests execute through operation-specific native commands pinned to
  the official RunPod hosts. There is no generic arbitrary-URL authenticated
  proxy, shell command, or unrestricted filesystem command.
- Worker requests are restricted to the discovered current Pod proxy host and
  the versioned ImageForge endpoint set. Bearer credentials are headers only.
- Folder selection, writability checks, downloads, hashing, atomic renames, and
  the local receipt ledger execute natively.

## Production integration behavior

- Normal first launch starts unconfigured and opens the four-step assistant.
  The deterministic state lab is an explicitly labelled demo/development mode,
  never the production default.
- Explicit **Start GPU** performs live EU-RO-1 Secure inventory discovery and
  one ordered custom-priority create for exactly one approved GPU. It then
  discovers the new Pod ID/proxy, observes boot/load/warm phases, and reaches
  ready only after the worker health probe does.
- Explicit **Stop GPU** requires a fresh Pod-bound confirmation and terminates
  only that verified ImageForge Pod. No timer, batch event, app exit, polling
  error, or background task can call termination.
- The desktop polls status while connected. A `423 batch_busy` response becomes
  a blocking owner/progress view and is never retained as a queued request.
- Ready images download immediately while later images generate. A download is
  written to a server-generated numbered `.part` file, resumes with `Range`
  when supported, verifies byte count and SHA-256, then renames atomically to
  `.jpg`. Only then is a durable local receipt written and acknowledged to the
  worker.
- Reconnect compares the server manifest and local receipt ledger, then fetches
  only missing or mismatched artifacts. The initiating computer receives the
  files; another computer does not silently mirror them.
- Duplicate Pods are surfaced as a high-visibility cost warning. They are never
  auto-terminated. The worker's shared-volume lease prevents duplicate workers
  from mutating or generating the same active batch.

## Integration test gates

- Native command tests prove host/path allowlists, exact Pod identity checks,
  secret redaction, path confinement, checksum failure recovery, and `.part`
  resume behavior.
- A two-client fake test proves one accepted batch and one immediate blocked
  response with owner/progress and no queue.
- A 450-prompt fake end-to-end test covers interruption, process restart,
  download resume, one injected generation failure, automatic retry, receipt
  reconciliation, and final ordered filenames.
- Production mode is exercised with fake HTTP fixtures shaped like the official
  RunPod and worker APIs; tests never require a real API key or paid GPU.
- Paid smoke tests are opt-in only and must record the exact GPU, hourly price,
  boot/load/warm timings, seconds per image, peak VRAM, and software/model
  revisions before that GPU can influence value ranking.
- The paid release gate is incomplete until the exact two-Pod EU-RO-1 network-volume
  qualification passes. Run `worker/scripts/run_volume_gate.py` with two identical
  Pods and the same 50 GB volume; prove one 201/one 423, observer mutation denial,
  isolated gate paths, owner-stop survivor recovery, and separately verify idle
  worker presence and maintenance exclusion. A local fake test cannot waive this
  gate.

## Non-goals

- Public store submission or paid code-signing enrollment.
