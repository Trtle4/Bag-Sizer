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
- **Disc collider = rounded cylinder (bevelled edge).** Chosen from a measured
  collider/contact study (below), not a guess.
- **Overfull** now also trips when product backs up above the jaw plane (jammed
  in the throat), not only when the counted fill line crosses it.

### Disc-stacking study — how the collider was chosen

Thin rigid discs (⌀30×4, 7.5:1 aspect) are the hard case for a real-time solver.
An early fix modelled the disc as an N-gon **prism** and spawned it **near-flat**
so it stacked. That worked only because of the flat constraint — it hid an engine
weakness rather than fixing it. A matrix (thin discs, random / funnel-fed
orientation so edge/corner contacts are actually exercised) measured settled
**packing = solid ÷ (bag cross-section × pile height)**; > 1 means the pile is
shorter than the product volume allows → interpenetration:

| collider | orientation | packing | notes |
| --- | --- | --- | --- |
| N-gon prism | near-flat | ~0.8 | only stacks when forced flat; **towers**/creeps otherwise |
| N-gon prism | random | **2.9** | collapses — product 3× the pile it should make |
| analytic cylinder | random | 1.13 | coplanar-face contact is a single point |
| **rounded cylinder** | random | **1.03–1.09** | stable, spreads, no creep, no flat crutch |

The **rounded-cylinder** edge fattens exactly the edge/corner contact manifold
that was sinking, so angled discs settle at ~physical packing with a *random*
(funnel-reoriented) drop — no artificial flat spawn. It holds across thin and
thick discs (packing 0.96–1.09) with zero escapes and no creep. Shipped with a
scaled `lengthUnit` (tolerances tuned to cm-scale parts), a widened predictive-
contact distance, a small per-collider contact skin, and raised solver + CCD
iterations. The rounded convex hull was also tested and, like the sharp prism,
sank under random orientation — the *rounded analytic cylinder* was clearly best
on the data. Reported fill height / headspace / packing are now trustworthy from
the sim directly rather than needing a bulk-packing fallback.

### Bottom-layer penetration — diagnosis and fix

A follow-up review flagged localized interpenetration at the *bottom* of the
pile that the bulk `packing` metric averaged away. Read the real per-contact
depths from Rapier's narrow phase (`contactDist < 0` = penetration) and isolated
the cause before touching anything:

- **Flat floor vs the sagging bowl** (the review's decision test): flattening the
  floor did *not* help disc-disc penetration (bottom max 12→22 mm), ruling out
  floor *shape* as the disc-disc cause → solver convergence under stack weight.
- **Solver iterations barely helped** (mean 1.87→1.73 mm at 2× iters). The
  effective lever for disc-disc overlap was the **contact skin**: a per-collider
  solid buffer. Sweeping it, skin **1.4 mm** cut deep (>0.5 mm) disc-disc contacts
  599→374 and bottom contacts 202→70, landing the settled `packing` at a
  *physical* ~0.73 (the old 0.6 skin's `packing` = 1.11 was unphysically
  compressed — the bottom discs were sunk into each other, under-reporting fill
  height). The skin is applied to the product **and** the floor.
- A separate defect: two pieces per fill sat *below the seal plane*, poking out
  the rendered pinch. Not the sag pocket (flattening didn't move them) — they had
  **sunk into the 60 mm-thick floor slab** and, once past its midline, got
  ejected out the bottom (nearest-surface flips). Fix: a **thin floor**
  (`FLOOR_HALF_T` 30→8 mm) so the top face is always the closest surface and the
  solver always pushes product back up; CCD stops fast tunnelling. Lowest piece
  went from −20 mm to ~+1 mm. The floor is now a **flat sealed base at the seal
  plane**; the pinch is rendered as geometry below it (visual only). The
  load-driven floor **sag** was removed with it.
- Removing the sag lost its side effect of *nesting* product low, so a
  sparsely-filled (near-lay-flat) bag stacked into a tall central column and a
  few pieces backed up over the jaw; the fatter skinned discs also jammed the
  narrow forming tube of that shallow bag. Both are fixed by raising the
  collision envelope's minimum depth/width floor (`prMin`+7/+4 → +12/+6), which
  gives a lightly-filled bag room to spread and widens the forming tube. This
  floors only the *collision* envelope; the FORMED DEPTH readout still comes from
  the perimeter model.

### Real-world calibration — full-width forming tube + honest free-fall (2026-07-19)

Two calibration items against a real VFFS machine:

- **Forming tube ≈ bag width.** On a real VFFS the forming tube is sized close
  to the bag width, so product drops across the *full* width and lands spread
  across the base — it is not funnelled onto a centre column. The narrow round
  tube + cone funnel is removed. The forming tube is now the **elliptical wall
  cage extended straight up** from the jaw to the release height — i.e. the
  visible film mouth continued upward — and product is **spawned spread across
  that whole mouth** (`x = spawnHalfW·√u·cosθ, z = spawnHalfD·√u·sinθ`, a
  uniform-area disc across the elliptical section, inset a product-radius from
  the wall). Because the tube *is* the bag mouth, widening it cannot reintroduce
  escapes: every piece is released inside the collision cage and stays inside it.
  Verified — **150/150 inside** (0 escaping in x, 0 in z, 0 below the seal) on
  thin ⌀30×4 discs, **90/90** on thick ⌀30×12, and still 150/150 at drop heights
  of 300 / 800 / 1500 mm. Product now lands spread (bottom footprint ~85 mm
  across a ~104 mm formed width) instead of piling on one point, which also
  relieves the bottom-stacking contention. Front + ¾ ortho views confirm the
  wide tube, the spread landing, and clean containment.
- **Real gravity, no velocity cap.** The world runs in **metres** — every length
  is scaled mm→m at the physics boundary (`MM = 0.001`), so g = 9.81 m/s² is
  physically correct; there is no hidden scale factor on the dynamics.
  `integrationParameters.lengthUnit = 0.045` scales *only* the contact/rest
  tolerances (tuned for cm-scale parts), **not** gravity or the integrator, so
  1 world-unit = 1 m stands. The earlier anti-tunnelling trick — capping the
  launch speed at `min(5, √(2gh))` — is **removed**; pieces now **spawn at rest**
  at the release height and free-fall under gravity, with tunnelling handled the
  right way (CCD + fixed 1/120 s substeps), not by slowing the fall. A dedicated
  test (`tests/freefall.test.ts`) drops a piece and measures its speed at the jaw
  plane against √(2gh): a 2.00 m drop (which the old 5 m/s cap would have
  clipped) measured **6.19 m/s vs the 6.26 m/s prediction** (~1 % low, from the
  small 0.02 residual linear damping), and speed scales as √h across 0.5 m vs
  2.0 m. Fall speed is now real.

One honest consequence: with real free-fall and near-frictionless drop the pile
packs a little looser than the old capped/damped drop, so reported fill height
rises slightly (e.g. 150 thin discs ≈ 140 mm fill / ~70 mm headspace vs the
earlier ~102 mm). That earlier number was compressed by the very
interpenetration the prior round fixed; the higher number is the physically
honest one.

### Solver/contact hardening — trustworthy fill under settling load (2026-07-19)

A review flagged that pieces still passed into each other under the settling load
of a deep pile, and — crucially — that this was corrupting the *fill-height*
output, not just visuals. All tuning is now in one `TUNING` block in `world.ts`.
Levers were pushed in the review's order, picking on measured **disc-disc
penetration read from Rapier's narrow phase** (`penetrationReport()`,
`contactDist < 0`) at a full 150-piece fill of the hard case (⌀30×4 thin discs):

| config | fill mm | headspace | packing | dd contacts | deep >0.5 mm | max mm | steps/s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **before** (16 iters / 4 PGS, slop .001, 30 Hz) | 148 | 62 | **0.65** | 247 | 198 | 20.4 | 51 |
| **shipped** (16 / 8, slop .0005, 60 Hz) | **205** | ~2–10 | **0.47** | 60 | 40 | 13.3 | 45 |
| 20 / 8 (rejected) | 208 | ~2 | 0.46 | 55 | 36 | 7.3 | 31 |

- **The overlap was skewing the measurement.** The "before" pile read a *shorter*
  148 mm at packing **0.65** — but 0.65 is physically impossible for
  randomly-oriented thin discs; they were sunk into each other, under-reporting
  height. Removing the overlap lets the pile stand at its honest **~205 mm /
  packing 0.47** (loose random-disc packing). Disc-disc penetration dropped
  **76 %** (247 → 60 contacts, 198 → 40 deep, max 20.4 → 13.3 mm).
- **Which lever did the work.** The single most effective — and cheapest — lever
  was **inner PGS iterations 4 → 8** (`numInternalPgsIterations`); it firms the
  pile far more per unit cost than raising the outer TGS iteration count. Halving
  the allowed penetration slop (`normalizedAllowedLinearError` .001 → .0005) and
  stiffening contacts (`contact_natural_frequency` 30 → 60 Hz, stable at
  dt = 1/120) both help at ~zero cost. **Contact skin was deliberately NOT
  raised**: a larger skin *does* cut measured overlap, but it pads every disc
  larger and inflates fill height (skin 1.8 mm drove the same fill *overfull* to
  228 mm) — corrupting the very number we want trustworthy. It stays at 1.4 mm.
  The collider is already the rounded cylinder from the prior round (lever 3).
- **The output is now trustworthy, by two tests.** (a) *Convergence*: 16 vs 20
  outer iterations give the **same** fill (205 vs 208) — more solver power no
  longer moves the number, only trims the residual penetration, so the height has
  converged rather than still being solver-limited. (b) *Stability*: the live
  readout drifts **< 1 mm over 5 s** after settle, and seeds agree within ±4 mm.
- **Frame-rate budget respected.** Display fps is governed by *per-step* cost
  (dominated by outer solver iterations), which the main loop's substep clamp
  turns into slow-motion rather than dropped frames. The shipped 16/8 config costs
  only ~12 % throughput (45 vs 51 steps/s); the 20/8 variant that shaved the deep
  outliers further cost ~40 % (31 steps/s) for a marginal gain and was rejected to
  stay clear of the ~30 fps floor.

Net: 150 thin discs now correctly report a **near-full** bag (≈205 mm, ~99 %,
"Jaw risk") instead of the overlap-compressed 148 mm — the honest answer for how
loosely thin discs pack. Zero overlap on thin rigid discs under a deep pile is a
genuinely hard real-time problem; the target here was met — *visually solid + a
fill/headspace readout that holds still* — without chasing the last fraction of a
millimetre at the cost of frame rate.

### Gusseted + SUP cross-sections; stiffness perimeter conservation (2026-07-19)

- **Two more styles, one cage.** Gusseted and SUP are enabled from their stubs.
  `SimProfile` now carries a `SectionModel`: `pillow` (perimeter conservation) or
  `boxed` (a gusset defines the depth; the ellipse opens from `openFloor` toward
  `halfW × halfD` with fill). The physics resolves either to the *same* elliptical
  wall cage, so containment is style-agnostic — verified: a full fill on the
  gusset/SUP cross-sections keeps every piece inside the cage (escX = escZ = 0),
  identical to pillow. (The 3-D shell is still lofted as a pillow body; bespoke
  gusset/SUP shell geometry is future polish. Cross-section depth and containment
  are correct — gusseted reads ~40 mm formed depth, SUP ~34 mm, vs pillow ~28 mm.)

- **Stiffness no longer reshapes the empty bag.** The conserved film perimeter is
  now fixed by the bag width (`flatHalfW = bagW/2`), *independent of stiffness* —
  previously an `edgeTuck(stiffness)` term shrank it, so the empty bag visibly
  narrowed as the slider moved. It doesn't any more (verified: empty pillow is
  140 mm wide and ~1 mm deep at both stiffness 5 and 95). Stiffness acts *only*
  through the fill: `roundnessFromFill` was also corrected in direction — a **stiff
  film holds a rounder, deeper** section, a limp film collapses flatter and wider
  (the physically right way round; it was reversed). Pre-fill, `phi = 0` → roundness
  0 regardless, so the slider does nothing until product inflates the bag.

### Contact-skin float vs interpenetration — a measured, irreducible trade

A review flagged resting pieces floating apart (~2·skin gap) and asked to shrink
the contact skin to the minimum that kills the float *without* the overlap
returning. Measured (150 thin ⌀30×4, disc-disc penetration from `penetrationReport`):

| skin mm | fill mm | deep >0.5 mm | max mm |
| --- | --- | --- | --- |
| **1.4 (current)** | 178 | **42** | ~5–13 |
| 0.8 | 127 | 122 | 14.2 |
| 0.6 | 123 | 129 | 15.2 |
| 0.1 | 101 | 267 | 16.0 |
| 0.02 | 96 | 276 | 24.4 |

Reducing the skin monotonically **reintroduces the overlap and re-compresses the
fill** — the skin *is* the anti-interpenetration mechanism for thin rigid discs.
And the solver cannot substitute for it: at skin 0.5, doubling inner PGS (8 → 16)
or outer iterations (16 → 24) still leaves 122–155 deep overlaps vs 42 at skin 1.4.
So there is **no skin below 1.4 that removes the float without bringing back the
overlap we just fixed** — the float is the visible cost of a trustworthy fill.

**Resolution — close the gap in the render, not the physics.** The skin stays at
1.4 mm (real to the solver). The *render* draws each piece at its **effective
contact size** — the nominal shape grown by the skin (`buildProductGeometry` in
`render/scene.ts`) — so neighbours held a skin apart visually touch and the pile
reads solid. This is render-only: the physics, the fill-height/headspace
measurement, and every dimension callout and export stay at the true **nominal**
spec (they read `prodDims`/`measurements`, never the mesh). One honest caveat: a
piece is drawn ~1 skin (~1.4 mm) larger on top, so the *drawn* pile crest sits
~1.4 mm above the measured fill line — a small **constant** offset that does not
grow with fill, so it cannot make a partly-empty bag look full. Trust the
headspace number over the eye for the last millimetre or two.

### A settled pile must actually stop — forced sleep (2026-07-19)

A review flagged the pile staying "alive": pieces jitter/bounce and never fully
rest, so the fill height keeps drifting. Diagnosed by logging the velocity/sleep
timeline after a drop — the cause was **not** interpenetration at the spawn mouth
(pieces release 0.13 s apart, ~83 mm apart in free-fall, and settled disc-disc
penetration is unchanged). It was two things:

- **Sleeping never fired.** `sleeping = 0 / N` for the entire run. Rapier's
  auto-sleep linear threshold is scaled by `lengthUnit`, so at 0.045 it is
  ~0.0045 m/s — unreachable for a real pile — and the JS API exposes no setter to
  raise it. So bodies were never deactivated and the solver kept nudging the
  packed discs every step (avg ~0.03–0.07 m/s, max ~0.2 m/s **forever**; fill
  oscillating ±10 mm).
- **Damping too low** (0.02) to bleed that residual energy — a hangover from the
  free-fall round, which kept damping minimal so the drop speed stayed physical.

Fix: **force the pile to sleep once settled** (`sleepPile()` calls `body.sleep()`
on the settle transition) — velocities go to zero and positions freeze, so the
readout holds still; nothing spawns afterward, so they stay asleep. The settle
trigger is `avg < 0.06 m/s for 0.6 s` **or** a `2.5 s` timeout after the last
piece, because heavier product jitters at a higher floor than an absolute
velocity line can catch (thin ⌀30×4 settle in ~0.8 s on the velocity test; thick
⌀30×12 via the 2.5 s timeout). Linear damping is raised 0.02 → **0.1** (free-fall
still 6.12 vs 6.26 m/s = 2.2 %, well inside the 5 % assertion) and **angular**
damping raised hard (`1.5 + 1.5·(1−stiff)`) — angular is a free lever, it bleeds
the rotational rocking without touching the vertical fall speed. `settle.test.ts`
asserts a dropped pile reaches every-body-asleep / zero velocity with a fill that
then holds still, for both a thin and a thick pile. Anti-overlap and fill numbers
from the previous rounds are unchanged.

### Batch (bulk-dump) release alongside the sequential feed (2026-07-19)

Product can now enter two ways (`FillParams.release`, a UI toggle):

- **`trickle`** (default) — the sequential feed, one piece every 0.13 s.
- **`batch`** — the whole charge is released at once, as a combination-scale dump.

The batch **must not start pieces inside each other** (that would re-create the
interpenetration/jitter the prior rounds fixed). So the charge is pre-laid as an
**overlap-free cloud** above the mouth (`computeBatchCloud`): a 3-D grid inside the
release ellipse, cell = the piece's **bounding-sphere diameter + clearance**, so
*any* random orientation still clears its neighbours; rows stack upward. The
physics wall cage and outer backstop are extended up to the top of that column
(`releaseTop`) so every piece is contained on the way down — the *rendered* tube
stays a sane height, the cloud simply rains in from above it.

Measured, trickle vs batch (150 × ⌀30×4, seed 7):

| mode | time-to-settle | fill mm | deep >0.5 mm | contained |
| --- | --- | --- | --- | --- |
| trickle | ~20.7 s (17 s is the feed) | 164 | 43 | 150/150 |
| batch | **~1.9 s** | 177 | 44 | 150/150 |

Both come **fully to rest** (every body asleep, zero velocity) and stay **contained**
(escX = escZ = below = 0). Batch is ~10× faster (no 17 s feed) and shows **no
overlap regression** (deep contacts 44 vs 43). Batch packs ~8 % looser (fill 177
vs 164) — a real, expected difference: a simultaneous dump lands more chaotically
than a gentle feed, it is not an overlap artifact. The settle detector gained a
`calmT` timer that only advances once the pile is no longer free-falling
(avg < `CALM_SPEED` 0.2 m/s), so a batch cloud is never frozen mid-drop; and the
overfull back-up count now ignores pieces at/above the release plane, so a fresh
batch cloud (momentarily at rest the instant it spawns) does not read as instantly
overfull. **Default = trickle**: both settle reliably, but the gentle feed spreads
the solver load over time (more robust across extreme geometry) and packs a touch
denser, so it stays the default; batch is the opt-in bulk-dump.
