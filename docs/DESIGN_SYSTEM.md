# ImageForge design system

## Direction

Match the attached SwipeCut progress dashboard's confidence and finish while
remaining an original ImageForge interface. The composition should feel like a
premium production console: editorial scale, instrument-like status, calm
density, and unmistakable operational hierarchy.

## Tokens

- Canvas: `#070916`
- Raised ink: `#0d1126`
- Panel: translucent `#171a31` over the canvas
- Panel border: `rgba(180, 190, 255, .16)`
- Primary text: `#f7f4ef`
- Secondary text: `#9b9eb2`
- Crimson: `#ff3f57`
- Coral: `#ff5969`
- Cobalt: `#2f6fff`
- Violet: `#8d5cff`
- Success: `#4bd99f`
- Warning: `#f0b45d`
- Radius: 18px controls, 28-34px major panels
- Motion: 180ms standard, 280ms emphasized; transform/opacity only

Use an off-white geometric sans for display text, a neutral sans for controls,
and a compact mono for labels, IDs, timings, and prices. Prefer locally bundled
or system fonts; the product must not depend on a live font CDN.

## Required composition

- Floating top command/status bar with brand, Pod phase, GPU, progress, ETA,
  health, refresh, and theme controls.
- Large page eyebrow, batch name, metadata, and right-aligned primary actions.
- Hero progress panel with radial progress, three metric cards, and linear bar.
- Lower split: prompt pipeline/list on the left and live preview/details on the
  right.
- Floating bottom navigation with Create, Progress, Library, Usage, Settings.

## Quality rules

- Use meaningful labels and live data; avoid decoration masquerading as status.
- Keep glow behind content, never across text.
- Preserve sharp text and strong contrast despite translucent panels.
- Show a deliberate skeleton during loading and an authored empty state.
- Provide focus rings, keyboard navigation, reduced motion, and descriptive
  control labels.
- Validate at 1280x720, 1440x900, and 1920x1080. Provide a compact layout below
  1180px without turning the desktop application into a phone UI.
