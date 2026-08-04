# Task 013 queue release decision record

Status: implementation and deterministic checks are present; target-native
installed evidence is produced only by the macOS and Windows release jobs and
must not be claimed before those jobs finish.

## Boundaries

ImageForge stages prompts only in a private, versioned journal on the current
device. The worker still owns one active lease and never holds a second remote
batch. A queue run never starts, replaces, or stops a Pod. The installed smoke
therefore fails before any registered native provider POST or DELETE can reach
the wire and publishes a zero-mutation ledger.

The release smoke uses three distinct installed application processes:

1. The first process owns a running queue, acquires the OS keep-awake assertion,
   writes and verifies the first JPEG plus its native download receipt, and is
   terminated with its lease and assertion live.
2. The second process must observe native startup recovery as
   `paused`/authorization-required for at least one second with no successor
   dispatch. It explicitly reacquires the runner, verifies each predecessor's
   files and receipts before the successor, completes all three batches, rings
   Web Audio from a trusted focused **Ring now** gesture, exercises the visible
   notification-denied fallback and one snooze, then releases keep-awake and
   the runner.
3. The third process proves the completed/snoozed journal remains stable and
   performs no automatic dispatch or provider mutation before native writes the
   final attestation.

The strict attestation also binds the three PIDs, native JPEG/receipt hashes and
dimensions, 450-row DOM caps, 30 trusted move samples, the canonical
1280×720/1440×900/1920×1080 viewports, semantic alarm/list facts, and the
evidence/result hashes. The Node validator independently rereads every retained
JPEG and receipt before CI removes the isolated output directory.

## Alarm and power decisions

Keep-awake is explicit per queue run and prevents only automatic system idle
sleep; it does not force the display awake and cannot defeat lid-close or manual
sleep. macOS uses an IOKit power assertion and Windows uses a power request. The
native runner owns cleanup, including process exit.

OS notifications are privacy-safe fixed-copy fallback signals, not proof of
audible volume. Browser autoplay rules mean audio cannot reliably restart after
a process relaunch, so ImageForge keeps a visible alert and requires the user to
activate **Ring now**. Snooze is persisted once for 15 minutes; neither alarm
delivery nor dismissal calls Stop GPU.

Primary platform and browser references:

- [Apple IOPMAssertionCreateWithDescription](https://developer.apple.com/documentation/iokit/1557078-iopmassertioncreatewithdescripti)
- [Microsoft PowerCreateRequest](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powercreaterequest)
- [Tauri notification API](https://v2.tauri.app/reference/javascript/notification/)
- [MDN autoplay guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)
- [MDN AudioContext.resume](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/resume)

## Evidence limit

Passing unit tests, typecheck, Rust tests, or validator self-tests proves only
the deterministic contract. Target-native behavior, installer identity,
signing status, public re-download hashes, and the final RunPod inventory audit
remain release blockers until their recorded jobs and artifacts exist.
