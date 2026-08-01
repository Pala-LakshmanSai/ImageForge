---
name: imageforge-frontend
description: Build or refine ImageForge React/Tauri user interfaces, visual states, prompt workflows, progress dashboards, libraries, settings, responsive layouts, accessibility, and UI tests. Use for any change under the desktop frontend or any task whose outcome is visible to Lakshman or Sujal.
---

# Build the ImageForge frontend

1. Read `docs/DESIGN_SYSTEM.md`, `docs/PRODUCT_SPEC.md`, and the task contract.
2. Inspect the current rendered state before editing an established screen.
3. Model behavior as typed domain state; do not scatter booleans for Pod/batch
   phases or hardcode presentation data inside components.
4. Build the complete interaction with the fake adapters first.
5. Use CSS variables for the visual system and reusable primitives for panels,
   badges, metrics, progress, buttons, and empty/error states.
6. Keep every control functional. Remove placeholders before review.
7. Test reducers, parsing, disabled/locked states, and the critical user flow.
8. Render 1280x720, 1440x900, and 1920x1080. Compare hierarchy, density,
   alignment, glow restraint, typography, and state clarity against the design
   reference; iterate before handing off.
9. Verify keyboard focus, contrast, reduced motion, overflow, and 450-item use.

Use `references/visual-checklist.md` for the taste pass. Preserve an original
ImageForge identity; do not copy another product's name or exact assets.
