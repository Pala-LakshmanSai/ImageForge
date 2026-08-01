# ImageForge studio deployment runbook

Daily use is terminal-free. This runbook is the one-time studio-owner setup
needed before Lakshman and Sujal install their desktop clients.

## 1. Durable RunPod resources

1. Create one **50 GB network volume** in **EU-RO-1**. The volume holds the
   selective FLUX snapshot, durable manifests, previews, and short-lived full
   artifacts. Pod deletion must never delete this volume.
2. Build and publish the pinned ImageForge worker container. Normal Pod boot
   installs nothing and has all Hugging Face offline flags enabled.
3. Prepare the model cache once on the attached volume with the worker's
   explicitly confirmed preparation command. It downloads only the Diffusers
   folders required at runtime and excludes the redundant root single-file
   checkpoint.
4. Verify the pinned revision and required files, then perform subsequent boots
   with networking disabled for Hugging Face libraries.

The worker image uses the official PyTorch CUDA 13.0 runtime so one immutable
image supports the approved Ada/Ampere and Blackwell fallbacks. The app filters
RunPod hosts to a compatible CUDA runtime before creation.

## 2. Worker authentication

Generate two independent, high-entropy ASCII bearer tokens: one for Lakshman
and one for Sujal. Put their user IDs, display names, and tokens into the
`IMAGEFORGE_AUTH_TOKENS_JSON` RunPod runtime secret. Do not put tokens into the
template export, connection profile, source tree, shell history, screenshots,
or chat.

Each editor stores only their own token in their operating-system credential
vault during desktop onboarding. The public health endpoint contains process
and GPU readiness only; every production/batch/artifact route requires a token.

## 3. Pod template

Create one ImageForge template with:

- the pinned worker image digest;
- the EU-RO-1 network volume mounted at `/workspace`;
- exactly one GPU;
- HTTP port `8000` exposed;
- the worker-auth runtime secret;
- normal offline-cache environment settings;
- no SSH/bootstrap/install command in the daily path.

The template does not pin a physical GPU. The desktop supplies the live ordered
GPU list when it explicitly creates each disposable Pod.

## 4. Desktop connection profile

Create a non-secret profile containing the schema version, template ID, network
volume ID, `EU-RO-1`, `/workspace`, worker port `8000`, and pinned generation
contract. Import the same profile on each computer. Store the RunPod API key and
that editor's worker token through the setup assistant; only redacted status is
shown afterward.

The native desktop validates the profile again. It rejects another data center,
Community Cloud, multiple GPUs, a different model preset, or an unapproved GPU
even if a hand-edited profile asks for one.

## 5. Daily operation

1. Open ImageForge and press **Start GPU**.
2. The app attaches to a healthy matching Pod or creates exactly one new Pod
   using current EU-RO-1 Secure inventory and the approved fallback order.
3. Wait for process, storage, weights, GPU load, and warm-up to reach Ready.
4. Paste/import prompts, choose a local folder, and start the one shared batch.
5. Keep ImageForge open while it verifies and renames each downloaded image.
   Reopening the app resumes missing `.part` files and receipts.
6. Press **Stop GPU**, inspect the exact Pod/GPU/cost confirmation, and confirm.

There is deliberately no idle timer or automatic termination. If both editors
press Start simultaneously, every matching Pod is shown as a duplicate-cost
warning and neither is silently deleted. The shared-volume worker lease is a
defense-in-depth control, not a deployment guarantee, until the exact
EU-RO-1 two-Pod gate below has passed for the selected volume and image.

## 6. Release-only paid checks

Paid checks run only after explicit authorization. For each currently available
approved GPU, record actual hourly price, container pull/boot, model load,
warm-up, 1280x720 seconds per image, peak VRAM, transfer rate, failures, and
whole-batch cost. Only comparable measurements for the exact software/model
contract may reorder the default ladder.

Before any production batch, run the isolated cross-Pod volume qualification:

```sh
IMAGEFORGE_REAL_VOLUME_TEST=1 \
IMAGEFORGE_GATE_ROOT=/workspace/imageforge-gates/<run-id> \
python worker/scripts/run_volume_gate.py
```

Provision two identical EU-RO-1 Secure Pods on the same 50 GB network volume,
set the Pod endpoints/tokens and exact image digest variables documented by the
script, and record its JSON evidence. The gate must prove one HTTP-201 winner,
one immediate HTTP-423 observer, read-only observer mutations, isolated gate
paths, and survivor recovery after the explicitly confirmed owner stop. Run it
again with roles reversed and separately verify idle-worker presence/maintenance
exclusion. A missing, timed-out, or failed gate disqualifies that volume
configuration; no local-process test can waive it.
