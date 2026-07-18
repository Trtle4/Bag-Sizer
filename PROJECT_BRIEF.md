# Claude Code Prompt — VFFS Bag Fill Simulator (production build)

Copy everything below into Claude Code. Place `parametric_design_system.md` and
`vffs_fill_simulator.html` (the approved concept) in the repo root first.

---

## Context

I'm a packaging engineer building a family of parametric packaging tools. The first was a
Cookie Tray Sizer. This project productionizes the second: a **VFFS bag fill simulator**
for pillow bags (gusseted and stand-up pouch to follow).

Two reference files are in the repo root — read both before writing any code:

1. `parametric_design_system.md` — the shared design system. Apply its tokens, fonts, and
   component patterns **verbatim**. The "keep identical" list in §6 is non-negotiable.
2. `vffs_fill_simulator.html` — an approved single-file concept. It defines the layout,
   control groups, toolbar, title block, dieline composition, and interaction model. Match
   its structure and behavior; you are upgrading the internals, not redesigning it.

One revision already applied to the concept: dieline panel labels (FIN / BACK ½ /
FRONT PANEL) run **horizontal**, parallel to the top seal — keep that.

## Stack

- Vite + TypeScript, no UI framework (the app is one screen; keep it lean).
- Rendering: Canvas 2D for the fill sim, inline SVG for the dieline.
- Physics: **matter-js** with a fixed timestep. Replace the concept's hand-rolled solver —
  it demos the idea but stacking stability and box collisions need a real engine.
- Tests: Vitest for all pure math (geometry, dieline, unit conversions, STEP parsing).

## Feature parity (from the concept)

- Product geometry: Round (⌀ × thickness), Square (L × W × H), STEP upload; unit weight.
- Fill target: by Count or by Weight (weight → ceil(target / unit weight)); drop height.
- Bag: pillow style; width, length, end seal, fin seal; Gusseted/SUP visible but disabled.
- Film stiffness slider (0–100) driving how the bag catches product and deforms.
- Live fill view: forming tube, open-top bag, deformable walls, floor sag, fill line,
  dimension callouts (bag W/L, drop, fill height, **headspace in accent teal**).
- Status flow Ready → Filling → Settled; amber advisory when settled headspace < 30 mm;
  red/blocked when fill crosses the seal-jaw plane.
- Dieline view: fin | back ½ | front | back ½ | fin, dash-dot fold lines, hatched seal
  zones, eye mark, full dimensioning. Engineering title block + mobile spec panel.

## Upgrades beyond the concept

### 1. Physics (matter-js)

- Fixed 240 Hz substep accumulator; deterministic option via seeded RNG so a fill can be
  replayed exactly.
- Round product → circle bodies; square/STEP → rounded-rectangle bodies (true box
  collisions, not circle approximations).
- Film walls: chains of small bodies linked by stiffness-mapped constraints, anchored at
  the bottom seal and jaw plane. Slider maps to constraint stiffness/damping, wall
  restitution, edge tuck (usable width), and floor-sag gain — keep the concept's feel:
  limp absorbs and conforms, stiff bounces and stays planar.
- Perf target: 200 pieces at 60 fps on a mid laptop.

### 2. STEP import

- Keep the fast path: parse ASCII STEP `CARTESIAN_POINT`s → bounding box + point count.
- Add a projected 2D silhouette (convex hull of the XZ projection of the point cloud,
  simplified to ≤ 16 vertices) used as the collision body and rendered shape, so an oddly
  shaped part fills more honestly than its bbox.
- Graceful failure states per the design system's advisory patterns.

### 3. Dieline exports

- **SVG** and **PNG** (raster at user-selectable DPI, 150/300/600, white background,
  fonts embedded or outlined so DM Mono survives rasterization) and **PDF**
  (print-scale, 1:1 mm).
- **DXF (R12, polylines)** with layer conventions for a cutting table: `CUT` (perimeter),
  `CREASE` (fold lines), `ANNO` (dims/labels, strippable). I run these on a Kongsberg —
  entities must be closed polylines in mm, no splines.
- Spec sheet export: keep the text version, add CSV.

### 4. Measurements

- Headspace and fill height as in the concept, plus: estimated fill volume, effective bulk
  density from the settled pile, and % of usable bag volume.
- Advisory thresholds (min headspace, jaw clearance) user-editable in a small `05 Limits`
  group, defaulting to 30 mm.

### 5. Architecture for the roadmap

- `src/geometry/` — pure functions: web width, cutoff, panel boundaries, usable width,
  headspace math. Fully unit-tested.
- `src/bagstyles/` — a `BagStyle` interface with two responsibilities: (a) sim cross-
  section profile (wall anchors, floor shape), (b) dieline generator. Implement `pillow`;
  commit typed stubs for `gusseted` and `sup` so enabling them later is additive.
- `src/physics/`, `src/render/`, `src/export/`, `src/state.ts` (single store, plain TS).

## Quality floor

- Responsive to 390 px per the design system (controls stack, title block drops below).
- `prefers-reduced-motion` respected; visible keyboard focus; 44 px touch targets.
- No console errors/warnings; all inputs validated with the danger state for blockers.
- Tests: dieline math vs. hand-checked values, count↔weight conversion, STEP bbox on a
  fixture file, DXF output parses as valid R12.

## Process

Work in three phases, pausing after each for my review:
1. Scaffold + parity with the concept on the new stack (matter-js physics, tests green).
2. Exports (PDF, DXF, CSV) + STEP silhouette + limits group.
3. Polish pass: perf, mobile, determinism toggle, and a short README with the physics
   model's assumptions stated plainly.

Bump the part tag to `VF-101 · REV B`.
