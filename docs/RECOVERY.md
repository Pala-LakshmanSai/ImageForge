# ImageForge recovery

The source of truth is the private GitHub repository:
`https://github.com/Pala-LakshmanSai/ImageForge`

## macOS

```sh
git clone https://github.com/Pala-LakshmanSai/ImageForge.git
cd ImageForge
npm ci
python3.11 -m venv worker/.venv
worker/.venv/bin/pip install -e 'worker[test]'
npm run typecheck
npm test -- --run --pool=forks --maxWorkers=1
```

Build caches can live on an external disk by sourcing
`scripts/use-usb-toolchain.sh`; the app itself does not depend on that disk.

## Windows

```powershell
git clone https://github.com/Pala-LakshmanSai/ImageForge.git
cd ImageForge
npm ci
npm run typecheck
npm test -- --run --pool=forks --maxWorkers=1
```

Use the latest GitHub Release installer for a normal user install. The native
app stores RunPod credentials in the operating-system vault; credentials are
never committed to this repository. Re-enter the RunPod API key and worker
token on a replacement computer, then use the fixed studio profile shown in
the app's setup screen.

The worker source is mirrored into the dedicated publisher repository
`https://github.com/Pala-LakshmanSai/imageforge-worker`. Its `publish-worker`
workflow validates the Python 3.11 source, builds `linux/amd64`, publishes
provenance/SBOM plus an immutable GHCR digest, and is the only production-image
publisher. The similarly named ImageForge-repository workflow is validation
only. The RunPod network volume contains model weights and is a separate
service-side copy; it is not stored on the removable disk.

## Queue and GPU-switch recovery

The Task 013 queue and Task 014 GPU-switch journal are private native app-data
stores, not browser state. Relaunch never restores a queue runner, keep-awake,
inventory receipt, foreground grant, switch lease, quote, or provider authority.
It loads valid generations read-only, visibly marks authorization required, and
waits for an explicit **Resume queue** or **Resume switch**.

Resume switch validates the exact native journal and queue reservation, then
performs exact provider list/GET and owner-only worker lookup before any possible
mutation. It never adopts by Pod name/GPU/owner/progress. A valid journal may
reconcile `delete_uncertain` or `create_uncertain` read-only. The old logical
deletion has at most one initial and one explicit same-intent retry; a
replacement attempt has at most one POST. If identity, volume, image, marker,
runtime, peer-Pod, response fingerprint, or zero-match proof is ambiguous, the
app parks for manual attention and preserves all bytes.

The worker shared volume retains crash-atomic switch request envelopes,
terminal tombstones, `.gpu-switch-v1`, and the global GPU-control lock. A new
worker/Pod must adopt a valid marker before generation. Corruption returns the
fixed fail-closed switch-store error and does not expose paths, principals,
prompts, credentials, or raw provider/worker bodies. Repair is an operator
volume action; there is no renderer reset that can erase the remote guard.

Queue `QUEUE_RESERVATION` remains active through every nonterminal/attention
switch state. It clears only after matching worker tombstone and native terminal
history, including denial/expiry/cancel/completion or the narrowly proven
never-sent local draft. Clearing never resumes work or reacquires keep-awake.
Downloaded artifacts and completed manifests remain immutable across every
replacement/relaunch seam.

Normal Task 012 Stop is likewise a native durable transaction. Before its one
DELETE socket write, `gpu_normal_stop` stores the exact input hash, private
operation/finalization binding, lifecycle revision, and wire-attempt counter.
A crash or ambiguous response at/after that boundary becomes
`delete_uncertain`; relaunch and an exact same-request replay perform only a
fresh `gpu_pod_observe`, never a second DELETE or worker Finalize. The worker's
bounded finalization guard remains authoritative until its TTL. Native may then
settle/cancel only that exact expired worker request without provider mutation,
while retaining the uncertain local history and directing the operator to the
RunPod dashboard. A completed Stop replays byte-identically with no I/O. A
changed request under the same UUID fails `gpu_stop_request_conflict`. A Stop
is `stopped` or `already_stopped` only when a fresh non-unavailable observation
excludes the old Pod ID; any replacement/peer Pod remains visible and prevents
a false global Offline projection.
