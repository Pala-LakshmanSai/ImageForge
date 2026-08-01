# ImageForge agent contract

ImageForge is a Tauri 2 desktop application for macOS and Windows. It controls
one RunPod GPU worker and turns 300-450 prompts into ordered, locally downloaded
images using `black-forest-labs/FLUX.2-klein-4B` in BF16.

## Read before editing

Read the relevant files in `docs/` and invoke the matching project skill under
`.agents/skills/`. Acceptance criteria in `tasks/` are binding. Do not expand a
task through opportunistic refactors.

## Product invariants

- Use the product name **ImageForge**.
- Use one image model and one GPU at a time.
- Keep the official BF16 FLUX.2 Klein 4B checkpoint as the portable default.
- Never run Gemma, Ollama, Z-Image, ComfyUI, or a prompt-rewriting LLM.
- Permit exactly one active generation batch across both users. Do not queue a
  second batch; return a typed `busy` response with owner and progress.
- Start or stop RunPod only after an explicit user click. Never add idle or
  automatic termination.
- Discover live GPU inventory on every start. Prefer the lowest measured
  cost-per-image among the approved NVIDIA 16-32 GB pool, with RTX 4090 as the
  cold default. Professional 48 GB GPUs are an explicit emergency tier, never
  a silent high-cost fallback.
- Stream/pull completed images to the requesting device while generation
  continues. Persist manifests so downloads and interrupted jobs can resume.
- Store secrets in the OS credential store or runtime secrets, never source,
  logs, URLs, screenshots, or committed configuration.
- Preserve the existing project at `/Volumes/ESD-USB/video production software`.

## UI invariants

- Treat `docs/DESIGN_SYSTEM.md` and the supplied SwipeCut screenshot as the
  visual floor, not loose inspiration.
- Use a dark ink/navy surface, controlled crimson/coral and cobalt/violet glow,
  large editorial typography, restrained glass panels, and dense operational
  information with generous spacing.
- Implement every state: offline, provisioning, loading, warming, ready,
  running, paused, locked, reconnecting, partial failure, complete, and error.
- Keep 450-row prompt lists and thumbnail grids virtualized or otherwise smooth.
- Do not ship placeholder gradients, generic dashboard cards, fake controls,
  decorative metrics, or dead navigation.

## Engineering rules

- Frontend: React, TypeScript, Vite, semantic HTML, CSS variables, Vitest.
- Desktop: Tauri 2. Keep privileged filesystem, credential, and RunPod calls in
  Rust commands where practical; expose narrow typed interfaces to React.
- Worker: Python 3.11, FastAPI, Pydantic, PyTorch/Diffusers, JSON manifests with
  atomic replacement, and one process-level generation controller.
- Share API types through checked-in schemas. Validate every external response.
- Use deterministic fake adapters for client and worker tests; real paid GPU
  tests are a separate explicit test stage.
- Make writes crash-safe: temporary file, fsync when material, atomic rename.
- Download to `.part`, validate size and SHA-256, then rename.
- Keep source and build caches on the removable disk. Do not download model
  weights or Docker layers to the Mac internal disk.

## Verification

Run the narrowest relevant tests first, then the full checks before integration.
Reviewers must test observable behavior against the task contract and report
must-fix findings with evidence. Builders get at most two repair rounds before
the main agent investigates.

Until Rust is bootstrapped on the removable disk, the web shell and backend may
be tested independently. Do not claim native packaging until it has run on the
target OS.
