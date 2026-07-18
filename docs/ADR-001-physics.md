# ADR-001 — Fill physics engine

Status: **accepted** (supersedes the Phase 1 matter-js model for Phase 3)
Date: 2026-07-18

## Context

Phase 1 shipped a first-order **2-D front-view** fill sim on matter-js. It reads
well for headspace/fill visualization but is a flat slice — real product packs
in 3-D, so 2-D over/under-estimates packing depending on shape. This is a
scoping/prototyping tool; we want physically honest packing without sacrificing
interactivity.

## Decision

Migrate the fill sim to **Rapier3D (`@dimforge/rapier3d`) + Three.js** in Phase 3.

- **Product = 3-D rigid bodies.** Primitive colliders only:
  - Round → **cylinder**
  - Square → **box**
  - STEP → **convex hull ≤ 16 vertices** (the silhouette hull built in Phase 2)
  - No mesh colliders, no compound shapes.
- **Film = quasi-static parametric shell**, not simulated cloth. Billow, edge
  tuck and floor sag are computed from **stiffness + resting load** — the same
  philosophy as Phase 1's analytic floor, extended to the full 3-D bag surface.
  Stiffness also maps to **contact restitution/damping** on the shell so the
  "catch/absorb vs. bounce" feel survives.
- **Determinism preserved** — seeded RNG for spawn jitter; fixed timestep;
  Rapier is deterministic given identical inputs and build.
- **Camera:** ¾ perspective default, plus **orthographic front/side presets** so
  the dimension callouts still read like an engineering drawing.

## Performance policy (accuracy ⟂ performance ⇒ performance wins)

- Piece cap **200**.
- Aggressive **sleep thresholds** once pieces settle.
- **Fixed-timestep budget with substep clamping** — a heavy frame degrades
  smoothly (drop substeps) instead of spiraling.
- Target **60 fps** on a mid laptop at 200 pieces.
- If missed: reduce **solver iterations** and **contact precision** first.
  **Never** break determinism; **never** drop below **30 fps**.
- Headspace/fill measured **after settle**; a "quick estimate" is acceptable
  mid-fill.

## Consequences

- New deps in Phase 3: `@dimforge/rapier3d` (WASM), `three`. matter-js retained
  only until the migration lands, then removed.
- `src/geometry` (pure math), `src/bagstyles` (dieline generators + the
  cross-section/shell profile hook), `src/export`, and `src/state` are
  physics-agnostic and carry over unchanged. Only `src/physics` and
  `src/render/sim` are rewritten; `render/dieline` and all exporters are
  untouched.
- The `BagStyle.simProfile()` contract generalizes from a 2-D cross-section to a
  3-D shell profile; the pillow implementation is updated, stubs stay additive.

## Re-sequencing

- **Phase 2** (exports: PDF/DXF/CSV, STEP silhouette, `05 Limits`) is
  physics-independent and proceeds first, unchanged.
- **Phase 3** = this migration, with the original polish pass (perf, mobile,
  determinism toggle, README) folded in.
