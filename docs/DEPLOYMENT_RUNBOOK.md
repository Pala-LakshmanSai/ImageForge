# ImageForge studio deployment runbook

Daily use is terminal-free. This runbook is the one-time studio-owner setup
needed before Lakshman and Sujal install their desktop clients.

## 1. Durable RunPod resources

1. Create one **50 GB network volume** in **EU-RO-1**. ImageForge's provisioned
   volume is `imageforge-prod-50gb` (`ukh207b26r`). The volume holds the
   selective FLUX snapshot, durable manifests, previews, and short-lived full
   artifacts. Pod deletion must never delete this volume.
2. Build and publish the pinned ImageForge worker container from the dedicated
   `Pala-LakshmanSai/imageforge-worker` repository workflow. The matching
   workflow builds only `linux/amd64`, emits an OCI digest, and pushes the
   worker to GHCR; the ImageForge repository workflow is validation-only. Copy
   the digest printed by the publisher workflow; never use a mutable tag in a
   RunPod template. Normal Pod boot installs nothing and has all Hugging Face
   offline flags enabled.
3. Prepare the model cache once on the attached volume with the worker's
   explicitly confirmed preparation command. It downloads only the Diffusers
   folders required at runtime and excludes the redundant root single-file
   checkpoint.
4. Verify the pinned revision and required files, then perform subsequent boots
   with networking disabled for Hugging Face libraries.

The worker image uses the pinned Python 3.11 slim base plus the SHA-256-pinned
PyTorch 2.13.0 CUDA 13.0 wheel. RunPod supplies the NVIDIA driver, while the
wheel supplies the CUDA userspace runtime. One immutable image therefore
supports the approved Ada/Ampere and Blackwell fallbacks. The app filters
RunPod hosts to a compatible CUDA runtime before creation.

The GHCR package must be readable by RunPod. For a private package, create a
read-only package-pull secret in RunPod and record that it was used; for a
public package, verify the package visibility explicitly. Never put a personal
GitHub token in the repository, desktop profile, or this runbook.

Current immutable worker release evidence (published 2026-08-07):

- Repository: `Pala-LakshmanSai/imageforge-worker`
- Source commit: `26f7566033f1994e15ec1e16ef6312d009ed98fe`
- Image: `ghcr.io/pala-lakshmansai/imageforge-worker@sha256:38ed950746e98a65ae13eee35583408dc367e268d91697b49538e5a623efa5a4`
- Worker version: `0.1.7`
- Architecture: `linux/amd64`

### Bumping the worker version

The desktop rejects any `/v1/health` body whose `version` is not the exact
string it expects, as `api_response_invalid`. The lifecycle latches that into a
terminal `error` phase after a five-minute grace window, so a healthy Pod
presents as "GPU operation needs attention" and no amount of polling recovers
it. Repinning the image digest alone is **not** sufficient. When the worker
version changes, move all of these together:

1. `worker/pyproject.toml` — `version`
2. `worker/src/imageforge_worker/constants.py` — `WORKER_VERSION` (the value
   actually served by `/v1/health`; `__init__.py` derives from it)
3. `packages/runpod-client/src/health.ts` — `WORKER_VERSION` (the desktop's
   expected value)
4. `packages/runpod-client/test/health.test.ts` — the `healthPayload` fixture
5. `src/adapters/productionImageForgeAdapter.test.ts` — its `workerHealth`
   fixture
6. This runbook's "Worker version" line above

`src/adapters/workerHealthContract.test.ts` binds 2 and 3 together by reading
the worker's own constants, so `npm test` fails if they drift.

`scripts/native-two-client-smoke-server.mjs` derives the version from the
worker's constants rather than duplicating it. It previously held a literal
that was missed by this list, so the fake worker it serves was rejected by the
app under test and the installed-app coordination smoke failed on both
platforms while every unit suite stayed green. Prefer deriving over adding a
seventh line to this list.

The GHCR package is public, so the template uses **No credentials** for image
pulls. Update the ImageForge RunPod template to this exact digest before
starting a new Pod:

- Template: `imageforge-flux-worker-v1` (`q8sfgixfy2`)
- Network volume: `imageforge-prod-50gb` (`ukh207b26r`)
- Data center: `EU-RO-1`

The current digest must pass the paid smoke and EU-RO-1 shared-volume gates
below before it is treated as production-qualified. Keep the model-cache
preparation and release checks in the runbook for any future worker-image or
volume change.

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

Mage-Flow moves production onto volume `8zupqv4zrm`
(`imageforge-mageflow-50gb`), which already holds the pinned weights. Repoint
the template and the desktop profile at it, and keep `ukh207b26r` until the
first Mage-Flow batch succeeds: it still holds the FLUX weights and is the
no-download rollback.

The repository profile was wired to volume `ukh207b26r`; the template
ID remains a deliberate one-time deployment value until the immutable worker
image/template is published. Do not substitute RunPod's default ComfyUI
template.

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
6. Press **Stop GPU** and inspect the exact Pod/GPU/cost confirmation. A live
   batch vetoes termination. When idle, every other live foreground editor must
   approve; denial, timeout, or connectivity uncertainty leaves the GPU
   running. Only after unanimous approval and exact-Pod revalidation does the
   app terminate compute.

There is deliberately no idle timer or automatic termination. If both editors
press Start simultaneously, every matching Pod is shown as a duplicate-cost
warning and neither is silently deleted. The shared-volume worker lease is a
defense-in-depth control, and the selected EU-RO-1 volume/image combination has
passed the two-Pod qualification below.

Both installed clients should converge on the same Pod phase and shared batch
owner/progress within the bounded foreground observation interval. Opening a
second client must show worker status before attempting device-local receipt
reconciliation. If RunPod is offline, that state wins over late worker status
and any in-flight batch is shown as interrupted rather than ready or running.

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
again after stopping the recorded winner with `IMAGEFORGE_GATE_SURVIVOR` set to
the live role, `IMAGEFORGE_GATE_OWNER` set to the original winner role, and
`IMAGEFORGE_GATE_BATCH_ID` set to the recorded batch. Run it with roles
reversed and separately verify idle-worker presence/maintenance exclusion. A
missing, timed-out, or failed gate disqualifies that volume
configuration; no local-process test can waive it.
