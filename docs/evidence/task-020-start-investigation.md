# GPU Start investigation — 2026-09-13

## Reproduction and observed boundaries

- Installed `/Applications/ImageForge.app`: bundle v0.2.8.
- Source base: `c3133fe`, isolated at `ImageForge-worktrees/gpu-start-trace`.
- First selector opening displayed `Existing ImageForge Pods could not be
  observed`. This transient failure was not reproduced after restarting with
  the existing `IMAGEFORGE_DIAGNOSTICS=1` channel; its specific native cause
  remains unproven.
- Selected L4 at 490000 micro-USD/hour using computer use. Confirmed both the
  renderer confirmation and native Start confirmation. The app returned
  `No capacity for the selected GPU right now`.
- Native stack reached `GpuInventoryService::create_with_order`; the private
  journal settled as `create_failed`, lifecycle revision 12, `postState=settled`.
  No pending create marker remained. Request SHA-256:
  `3e145b76f21ec569736cbda8705b3d726eb5485ae9d571cc9bc3a33981b446b4`.
- A subsequent authenticated read-only curl probe returned HTTP 200 for the GPU
  catalog and HTTP 200 with zero Pods for the account Pod list. Python urllib
  received HTTP 403 on both endpoints; that transport-specific probe failure
  is not evidence that the application's credentials or requests fail.

## Request path from installed-source equivalent

1. Read native inventory journal and observe existing profile Pods.
2. GET catalog datacenters and GPU catalog concurrently. GPU query uses
   `include=AVAILABILITY&product=POD&count=1&cloud=SECURE&minCudaVersion=13.0`.
   These are GET requests with no JSON request body.
3. Display exact selection/price; obtain explicit renderer and native consent.
4. Recheck catalog and exact price, then GET profile Pods to exclude duplicates.
5. Persist create intent and marker, then send one `POST /v1/pods`.
6. For a definitive refusal, GET profile Pods again before clearing the marker.
7. `ProductionImageForgeRuntime.#projectNativeStartResult` shows the capacity
   toast for `create_failed`, then calls `gpu.refresh()`. This is the observed
   post-failure inventory refresh; it occurs after the provider create failure.

The native create body contains one `NVIDIA L4`, `gpuTypePriority=custom`,
`gpuCount=1`, `computeType=GPU`, `cloudType=SECURE`, `interruptible=false`,
`dataCenterIds=[EU-RO-1]`, `allowedCudaVersions=[13.0]`, `minRAMPerGPU=16`,
`volumeMountPath=/workspace`, `ports=[8000/http]`, and the unchanged pinned
ImageForge template, worker image, shared network volume and attempt name.
No API key is included in this body; authentication uses a private header.

## Proven implementation defect

`native_create_selected_pod` previously converted all definitive HTTP 400/422
responses into `gpu_start_no_capacity`, regardless of response meaning. Thus
the original toast alone cannot establish the provider's exact refusal reason.
The repair distinguishes request rejection from the provider's established
no-instances message. It retains the empty-Pod proof before marker retirement
and the uncertain-outcome no-replay behavior.

Opt-in diagnostics now record fixed operation names, HTTP status, elapsed
milliseconds and a fixed refusal code. They never record raw provider bodies,
URLs, credentials, headers, or private response fields.

## Verification status

- Focused native regression: 1 passed.
- Full native suite: 275 passed, 0 failed, 2 explicitly ignored paid tests;
  test execution 201.95 seconds. No paid test was enabled.
- `git diff --check`: passed.
- Full Rust formatting check exposes pre-existing formatting differences in
  the v0.2.8 base. The new diagnostic formatting was corrected; unrelated
  formatting was not rewritten.
- Build requires the cached Rust 1.98.1 toolchain at
  `/Volumes/ImageForgeBuild/rustup`, Cargo home
  `/Volumes/ImageForgeBuild/cargo-home`, target directory
  `/Volumes/ImageForgeBuild/target-task017`. The repository helper points at
  older Rust 1.97.1 and triggers a dependency rebuild instead of reusing this
  cache. Remove generated `._` AppleDouble files from a new removable-disk
  worktree before Tauri parses permission files.
- Instrumented macOS app built with custom-protocol, ad-hoc signed and verified.
- Live computer-use Start selected L4 at $0.49/hour and confirmed the native
  billing dialog. Catalog responses were HTTP 200; `create_pod_POST` returned
  HTTP 201 in 1493 ms; the subsequent profile Pods GET returned HTTP 200.
  The app displayed BOOTING and exposed Stop GPU. No request payload changes
  were required for successful creation. The original refusal reason remains
  unproven because v0.2.8 did not preserve a specific rejection classification.
- Initial worker health HTTP 404 responses occurred during boot, after the
  successful create. Worker readiness is tracked separately from allocation.
- User explicitly authorized production push and DMG/EXE release as v0.2.9.
  Existing CI provides native packaging and installed artifact smoke checks.
- One live L4 is billed at $0.49/hour. No automatic stop was added or performed.
