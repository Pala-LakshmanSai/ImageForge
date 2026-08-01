---
name: imageforge-release
description: Prepare, build, package, and verify ImageForge beta releases for macOS and Windows, including removable-disk toolchains, Tauri configuration, native installers, versioning, artifacts, clean-machine smoke tests, and signing-status disclosure.
---

# Release ImageForge

1. Read `AGENTS.md`, the release task, and `references/release-matrix.md`.
2. Keep package stores, Rust homes/targets, temporary output, and artifacts on
   the removable disk. Detect free space before large builds.
3. Run lint, typecheck, unit, integration, and production frontend build first.
4. Build macOS on macOS and Windows on a Windows runner unless a documented
   cross-build is being evaluated separately.
5. Install the artifact on a clean user profile and run the offline/fake-worker
   smoke flow before marking it usable.
6. Record version, commit, OS, architecture, hashes, signing/notarization state,
   warnings, and exact smoke results.
7. Never describe an unsigned build as warning-free or production-signed.

Do not upload or publish artifacts without explicit user authorization.
