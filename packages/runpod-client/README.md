# `@imageforge/runpod-client`

Typed, adapter-driven RunPod lifecycle control for ImageForge. The package has
no live test stage and never makes a network call unless a caller explicitly
invokes a real adapter method.

## Safety contract

- `refresh()` always queries current catalog inventory and existing managed
  Pods. The v2 catalog is beta and advisory; a catalog failure is surfaced as
  `inventory_fallback` and normally uses the authoritative static fallback.
  A matching dynamic PRO Pod that cannot be reverified fails closed so it
  cannot disappear from discovery and cause a duplicate create.
- `startGpu()` requires `{ intent: "start_gpu", source: "foreground_user" }`.
  It sends exactly one Secure Cloud create request with `gpuCount: 1`, an
  ordered list of approved catalog IDs, and `gpuTypePriority: "custom"`.
- Existing Pods are preferred. Local double-clicks share one create operation.
  External races and ambiguous create responses are reconciled by a unique Pod
  name marker. An unresolved marker blocks every later create until discovery
  resolves it or the operator explicitly acknowledges it. Every duplicate is
  shown; none is automatically terminated.
- Proxy URLs are derived from each freshly discovered Pod ID as
  `https://<pod-id>-8000.proxy.runpod.net` and verified through worker health.
- `stopGpu()` can only call DELETE after `requestStopConfirmation()` issues a
  short-lived token bound to the exact Pod. Confirmation text states that GPU
  compute and ephemeral data are terminated while the network volume remains.
- No timer, idle event, completed batch, health failure, process exit, or
  background observer can invoke termination.
- Provider observations and confirmed termination use the validated
  `operationTimeoutMs` transport bound. A DELETE timeout remains ambiguous and
  requires a refresh; the deadline never triggers termination itself.

## Provider boundaries

`RunPodProvider` is the stable lifecycle boundary. `RunPodRestProvider` is the
Bearer-authenticated reference implementation using the v1 Pod API;
`RunPodV2InventorySource` supplies live catalog price and exact EU-RO-1 stock;
`FakeRunPodProvider` is deterministic and used by normal tests. Worker readiness
is independently replaceable through `WorkerHealthProbe`.

The API key is supplied as an async credential callback, not configuration. In
the desktop product, RunPod transport belongs behind a narrow Tauri/Rust command
and the callback must read the OS credential vault. Do not construct the real
provider in browser JavaScript. Neither errors nor serialized diagnostics retain
request headers, API response bodies, template environment values, or secrets.

```ts
const provider = new RunPodRestProvider({
  apiKeyProvider: () => credentialVault.read("imageforge.runpod"),
});

const controller = new RunPodLifecycleController({
  provider,
  config,
  workerHealthProbe: new HttpWorkerHealthProbe(),
});
const started = await controller.startGpu({
  intent: "start_gpu",
  source: "foreground_user",
  expectedImageCount: 450,
});
```

The checked-in [configuration schema](./config/imageforge-runpod.schema.json)
and [example profile](./config/imageforge-runpod.example.json) deliberately
contain no API key or worker bearer token. Template secrets must use RunPod
secret references; user credentials remain in the OS vault.

## EU-RO-1 GPU policy

The ordinary cold-start order is RTX 4090, RTX PRO 4500 Blackwell, RTX 5090,
RTX PRO 4000 Blackwell, L4, RTX A4500, RTX 4000 Ada, A100 80GB PCIe, and both
RTX PRO 6000 Blackwell editions. Unknown Blackwell IDs
are never manufactured: the live catalog display name is allowlisted and its
exact returned ID is passed to creation. Candidates must be NVIDIA, at least
16 GB, CUDA 13.0 compatible, Secure Cloud, one-GPU Pod stock in EU-RO-1.

RTX 2000 Ada is the only slow emergency candidate and requires the explicit
`allowEmergencyGpuTier` setting. An existing managed RTX 2000 Ada remains
visible and explicitly stoppable after opt-out, but is never reused. A40, RTX
A6000, L40, L40S, and B200 are not in the studio allowlist. Comparable benchmark profiles
must match the pinned model revision, BF16, 1280x720, four steps, guidance 1.0,
JPEG 95, and the exact software image.
Ranking then uses:

```text
estimated_job_cost = hourly_price * (boot_seconds + seconds_per_image * images) / 3600
```

## Verification

Keep npm caches on the removable disk:

```sh
npm install --cache /Volumes/ESD-USB/ImageForge-caches/npm
npm run typecheck
npm test
npm run build
```

All HTTP tests inject a local `fetch` double. Paid/live GPU verification is a
separate explicit stage and is not defined as an npm script here.
