# VFFS Fill Simulator — `VF-101 · REV B`

A parametric packaging tool that simulates dropping product into a **VFFS pillow
bag** and generates its dieline. Second in a family of tools (after the Cookie
Tray Sizer). Gusseted and stand-up-pouch styles are stubbed for the roadmap.

Built on the shared parametric design system; the UI, control groups, toolbar,
title block and dieline composition match the approved concept
(`vffs_fill_simulator.html`) — this build upgrades the internals.

## Stack

- **Vite + TypeScript**, no UI framework (one screen).
- **Rapier3D** (`@dimforge/rapier3d-compat`, WASM) rigid-body physics +
  **Three.js** for the live 3-D fill view; **inline SVG** for the dieline and
  the dimension callouts.
- Seeded RNG + fixed timestep for deterministic replay.
- **Vitest** for all pure math and physics (geometry, dieline, unit conversions,
  STEP parse/hull, DXF/PDF, 3-D physics determinism).

## Commands

```bash
npm install
npm run dev        # dev server
npm test           # vitest (pure math + physics)
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production bundle
```

## Architecture

```
src/
  geometry/    pure functions: web/cutoff/panels, usable width, headspace,
               count↔weight, STEP bbox + convex hull. Fully unit-tested.
  bagstyles/   BagStyle interface (3-D sim shell profile + dieline generator).
               pillow implemented; gusseted/sup typed stubs.
  physics/     Rapier3D rigid-body world (mm↔m boundary) + seeded RNG.
  render/      Three.js scene renderer + SVG dieline + SVG dimension overlay.
  export/      SVG / PNG (150-600 dpi) / PDF (1:1 mm) / DXF (R12) / TXT / CSV.
  state.ts     single plain-TS store + derived selectors.
  main.ts      DOM wiring + async boot + fixed-timestep loop.
```

## Physics model — assumptions

This is a **3-D rigid-body** scoping/prototyping model on Rapier3D — physically
honest for packing, but not a validated granular simulation. When accuracy and
performance conflict, performance wins (piece cap 200). Stated plainly (full
rationale + guardrails in [`docs/ADR-001-physics.md`](docs/ADR-001-physics.md)):

- **Axes** (app space, mm): x = width, y = up (0 = inner floor → innerLen = jaw
  plane), z = depth (pillow thickness). Rapier runs in **metres** (its solver
  thresholds are tuned for a ~1 m world); we scale mm ⇄ m at the boundary.
- **Product** = rigid bodies with **primitive colliders only**: cylinder
  (round), cuboid (square), convex hull ≤16 verts (the STEP silhouette,
  extruded). No mesh/compound colliders. Mass is the unit weight.
- **Film is a quasi-static parametric shell**, not simulated cloth. Four
  kinematic wall colliders plus a sagging kinematic floor are positioned each
  step from the **film stiffness and the resting load** — a spring-held cloth
  bag collapses under real gravity, so the shape is analytic while support stays
  robust. Stiffness (0–100) also maps to usable width (edge tuck), pillow depth,
  floor-sag/billow gain, and **contact restitution/damping** — limp film absorbs
  and conforms (deeper, sags more, bounces less); stiff film stays planar.
- A static **forming tube** guides product in; static outer walls + a catch
  floor contain overflow.
- **Fixed timestep (1/120 s) with substep clamping**: a heavy frame drops its
  backlog rather than spiralling. With a fixed step and seeded spawn RNG the
  fill is **deterministic** (bit-identical replay); a "Seed" toggle switches to
  a fresh seed per drop.
- **Cameras**: ¾ perspective (orbitable) default; orthographic front/side
  presets where the dimension callouts read like a drawing.
- Fill height, headspace, fill volume, bulk density and % usable are read from
  the settled pile (a quick estimate mid-fill); count capped at 200.

## Roadmap (phased)

1. **Scaffold + parity** on the new stack — done.
2. Exports (PDF 1:1 mm, DXF R12, CSV) + STEP silhouette + editable `05 Limits`
   group. Physics-independent — done.
3. **Rapier3D + Three.js** 3-D physics migration (ADR-001), polish folded in —
   done. Next: enable the gusseted / SUP bag styles.
