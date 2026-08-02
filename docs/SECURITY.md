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

- Keep the worker batch UUID as hidden API and receipt identity. Save full
  artifacts under a sanitized user-facing batch folder and numeric indices,
  backed by a durable UUID-to-folder mapping.
- Verify content type, declared size, dimensions, and SHA-256 on the desktop.
  Library display and per-image export must resolve through that verified
  receipt; the renderer never receives an arbitrary local path.
- Write downloads to `.part` within the destination filesystem and atomically
  rename. Reject traversal, symbolic links, and Windows reparse points.
- Never overwrite an unrelated existing download. Named batch folders receive
  a deterministic conflict suffix; image export replacement occurs only after
  the native save dialog confirms the destination.

## Tauri permissions

- Allow only the exact file-dialog, destination-write, credential, HTTP, and
  shell-free commands needed by ImageForge.
- Do not expose arbitrary command execution, arbitrary URL navigation, broad
  filesystem roots, or a generic request proxy to the webview.
- Use a restrictive content security policy compatible with local assets and
  the configured RunPod HTTPS endpoint.
