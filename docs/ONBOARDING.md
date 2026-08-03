# Onboarding and everyday use

ImageForge must feel like a finished product to a non-technical editor. Neither
user should need a terminal, Docker, Python, a RunPod console, a Pod ID, or a
proxy URL during normal operation.

## First launch

The first-run assistant has four short screens:

1. **Your name** — identifies the owner of an active batch as Lakshman or Sujal.
2. **Connect RunPod** — paste the RunPod API key. Store it in the operating
   system credential vault and never render the complete value again.
3. **Import studio connection** — import or paste the non-secret ImageForge
   connection profile containing the template ID, `EU-RO-1` network-volume ID,
   approved GPU policy, worker port, and model preset. Enter the user's token into
   a separate masked field and store it in the credential vault.
4. **Choose downloads folder** — use the native folder picker, run a write test,
   and explain that images are saved directly to this computer.

The assistant ends with a read-only connection test. It must not create a Pod.
Advanced identifiers remain collapsed unless troubleshooting is requested.

## Everyday happy path

1. Open ImageForge and press **Start GPU**.
2. Watch the explicit phases: finding GPU, provisioning, booting, loading FLUX,
   warming up, ready. The changing Pod ID and proxy address are resolved by the
   app and are not user inputs.
3. Paste one prompt per line or import a TXT file. Invalid or blank entries are
   explained before submission.
4. Press **Generate images**. Only one user may own a batch. The other user sees
   who is working and their progress; no second request is submitted or queued.
5. Images are written in prompt order to the selected local folder as they
   become available. Interrupted downloads resume from `.part` files and become
   final only after checksum verification.
6. When generation and downloads are complete, press **Stop GPU**. An active
   batch always vetoes termination. If another editor is foreground and the
   worker is idle, they receive a named **Keep GPU running** / **Approve stop**
   request. Any denial, timeout, or uncertain connection keeps the GPU running.
   After unanimous approval, the confirmation says that compute is terminated
   while ImageForge files and model weights remain on the volume.

## Recovery promises

- Closing or sleeping the laptop does not cancel server-side generation.
- Reopening the app discovers the current Pod and active batch.
- Shared worker status appears before device-local receipt recovery, so a stale
  or inaccessible folder on one computer never hides the other editor's live
  batch or demotes a Ready GPU.
- A replacement Pod gets a new ID; the app discovers it and reconciles the
  durable manifest from the network volume.
- Ready images are never regenerated when their artifact and checksum match.
- Download receipts are local per computer, so each user receives only the
  images requested by that user's batch.
- Ambiguous duplicate Pods are shown for manual choice. ImageForge never
  silently terminates one.

## Settings hierarchy

The default Settings page contains identity, download folder, connection health,
GPU preference (`Best value` or `Fastest`), and masked credential replacement.
Template, volume, port, API base URL, model path, timeout, and diagnostic logs
live under **Advanced**. Developer and fake-backend switches are available only
in development builds.
