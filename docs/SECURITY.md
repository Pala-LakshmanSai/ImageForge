# Security contract

## Desktop secrets

- Make RunPod calls from a narrow Tauri/Rust command, not browser JavaScript.
- Store RunPod API and worker credentials in macOS Keychain or Windows
  Credential Manager through a reviewed credential abstraction.
- Return redacted credential metadata to React (`configured`, optional suffix),
  never the secret value.
- Keep secrets out of URLs, query strings, analytics, crash reports, UI state,
  persisted web storage, Git, screenshots, and command output.
- Prefer a restricted RunPod key when the platform offers adequate scopes.

## Worker boundary

- Accept TLS traffic through the RunPod HTTPS proxy only.
- Require a per-user bearer credential on every endpoint except minimal health.
- Compare credentials in constant time and never log the Authorization header.
- Reject malformed or empty prompt entries, while allowing any finite prompt
  list size that the connected worker, disk, transport, and GPU can safely
  process. Product code must not impose an arbitrary prompt-count or
  per-prompt character ceiling.
- Generate all server paths and filenames; reject path components from clients.
- Return safe error messages and opaque internal error IDs.
- Keep prompt logging disabled by default.

## Files

- Save full artifacts under generated batch IDs and numeric indices.
- Verify content type, declared size, and SHA-256 on the desktop.
- Write to `.part` within the destination filesystem and atomically rename.
- Never overwrite an unrelated existing file; use a deterministic conflict
  suffix or require an explicit replace action.

## Tauri permissions

- Allow only the exact file-dialog, destination-write, credential, HTTP, and
  shell-free commands needed by ImageForge.
- Do not expose arbitrary command execution, arbitrary URL navigation, broad
  filesystem roots, or a generic request proxy to the webview.
- Use a restrictive content security policy compatible with local assets and
  the configured RunPod HTTPS endpoint.
