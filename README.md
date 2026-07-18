# VFFS Fill Simulator — `VF-101 · REV B`

A parametric packaging tool that simulates dropping product into a **VFFS pillow
bag** and generates its dieline. Second in a family of tools (after the Cookie
Tray Sizer). Gusseted and stand-up-pouch styles are stubbed for the roadmap.

Built on the shared parametric design system; the UI, control groups, toolbar,
title block and dieline composition match the approved concept
(`vffs_fill_simulator.html`) — this build upgrades the internals.

## Stack

- **Vite + TypeScript**, no UI framework (one screen).
- **Canvas 2D** for the live fill view, **inline SVG** for the dieline.
- **matter-js** physics with a fixed 240 Hz substep and seeded RNG for
  deterministic replay.
- **Vitest** for all pure math (geometry, dieline, unit conversions, STEP parse,
  physics determinism).

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
               count↔weight, STEP bbox. Fully unit-tested.
  bagstyles/   BagStyle interface (sim cross-section profile + dieline
               generator). pillow implemented; gusseted/sup typed stubs.
  physics/     matter-js soft-body world + seeded RNG.
  render/      canvas fill renderer + SVG dieline renderer.
  export/      SVG / PNG / spec-sheet (DXF / PDF / CSV land in phase 2).
  state.ts     single plain-TS store + derived selectors.
  main.ts      DOM wiring + fixed-timestep loop.
```

## Physics model — assumptions

> **Phase 1–2: 2-D.** The current fill sim is a **first-order 2-D front-view**
> model on matter-js — a flat slice, not full 3-D packing. **Phase 3 migrates
> to a 3-D engine (Rapier3D + Three.js)** with 3-D rigid product and a
> quasi-static parametric film shell — see
> [`docs/ADR-001-physics.md`](docs/ADR-001-physics.md).

Stated plainly, the current model:

- The world is millimetres, front view only. Product is modelled as **circles**
  (round) or **rounded rectangles** (square/STEP) — true box collisions.
- **Film walls** are chains of small node bodies linked by stiffness-mapped
  constraints, hard-anchored at the bottom seal and the jaw plane, with a return
  spring to their rest line. The stiffness slider (0–100) maps to constraint
  stiffness/damping, wall restitution, edge tuck (usable width) and floor-sag
  gain — limp film absorbs the drop and conforms; stiff film bounces product and
  stays planar.
- The **floor** sags along an analytic curve driven by the resting load and the
  film's sag gain, rather than free-simulating — a spring-held floor collapses
  under real gravity, so this keeps support robust while still deforming.
- Gravity/timestep are tuned together for a brisk-but-stable fall in a
  millimetre world; the fill is **deterministic** given a seed and the fixed
  substep.
- Fill height, headspace and derived measurements are read from the settled
  pile; the count is capped at 200 pieces for the live sim.

## Roadmap (phased)

1. **Scaffold + parity** on the new stack — done.
2. Exports (PDF 1:1 mm, DXF R12, CSV) + STEP silhouette + editable `05 Limits`
   group. Physics-independent.
3. **Rapier3D + Three.js** 3-D physics migration (ADR-001), with the polish pass
   (perf, mobile, determinism toggle) folded in.
