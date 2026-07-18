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

## Addendum — formed cross-section, elliptical wall cage, disc stacking (2026-07-18)

Refinements after the first Phase-3 fill sim shipped, driven by ¾-view review
(product poking through the shell, resting on a flat plane beyond the bag, and
lying in a flat scattered layer instead of stacking):

- **Formed cross-section by perimeter conservation** (`src/geometry/formed.ts`).
  The lay-flat film has a fixed circumference `C = 4·flatHalfW`; as product
  fills, that fixed perimeter redistributes from flat toward round, giving a
  *bounded* formed depth (a pillow can't bulge past a fully-round section without
  its width shrinking). `roundnessFromFill(settled volume, stiffness)` drives the
  roundness; limp film rounds deeper than stiff film for the same load. This one
  model drives the collider, the rendered shell, and the FORMED DEPTH readout, so
  they match by construction.
- **Elliptical wall cage** replaces the four flat box walls. The film wall is a
  ring of thin static segments lying *on* the formed ellipse, so the collider is
  the exact twin of the visible film — no rectangular corners for a disc to sit
  in, no gap where the old billowed side walls pulled away from the front/back
  walls. Containment is exact (verified: zero escapes in x and z at a full fill).
- **Bottom seal, not a ground plane.** The old infinite reference grid read as a
  floor beyond the bag footprint; it's removed. Product rests on a bag-sized
  sagging floor and the rendered pillow pinches to a flat welded bottom seal.
- **Disc collider = thin N-gon prism, not an analytic cylinder.** Rapier's
  cylinder–cylinder contact between coplanar faces is a degenerate single point,
  so flat discs sank into each other. A convex polytope yields a stable
  multi-point face manifold, so discs pile in visible layers. Combined with a
  scaled `lengthUnit` (contact tolerances tuned to cm-scale parts, not the
  default 1 m), near-flat spawn orientation, and raised solver iterations.
- **Overfull** now also trips when product backs up above the jaw plane (jammed
  in the throat), not only when the counted fill line crosses it.

### Known limitation — thin rigid discs

Very thin rigid discs (e.g. ⌀30×4, a 7.5:1 aspect) remain a hard case for a
real-time solver: coplanar prism faces still creep together under a tall stack's
sustained load, so a fully-settled headless run can over-compress (implied
packing > 1). In the interactive app — where the fixed-timestep budget clamps
substeps under load, per the performance policy above — the pile renders as a
believable stack. Thicker discs and non-disc shapes settle cleanly. Eliminating
the residual creep would need substepping/contact-stiffness work that is out of
scope for this pass; the structural fixes (containment, formed depth, seal) are
independent of it.
