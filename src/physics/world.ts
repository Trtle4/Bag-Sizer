/**
 * Fill physics — Rapier3D rigid-body model of a VFFS pillow bag (Phase 3).
 *
 * Coordinate frames
 * -----------------
 * App space (reported to renderer/measurements): x = width (±, across the bag
 * face), y = up (0 = inner floor → innerLen = jaw plane), z = depth (±, pillow
 * thickness), millimetres. Rapier runs in metres (its solver thresholds are
 * tuned for a ~1 m world), so we scale mm ⇄ m at the boundary.
 *
 * Model (see docs/ADR-001-physics.md)
 * -----
 * - Product: 3-D rigid bodies with primitive colliders — cylinder (round),
 *   cuboid (square), convex hull ≤16 verts (STEP silhouette, extruded).
 * - Film: a quasi-static parametric shell. A static elliptical wall cage lying on
 *   the formed cross-section (perimeter conservation) plus a kinematic sagging
 *   floor — not simulated cloth. The cage is the exact collider twin of the
 *   rendered film, so the wall matches the visible profile with no gaps. Stiffness
 *   sets the formed depth and maps to contact restitution/damping.
 * - A static forming tube guides product in; static outer walls + a catch floor
 *   contain overflow.
 * - Fixed timestep with substep clamping; seeded RNG spawn jitter → deterministic.
 */

import RAPIER from "@dimforge/rapier3d-compat";
import { Rng } from "./rng.js";
import { simplifyHull } from "../geometry/hull.js";
import { headspace as headspaceOf } from "../geometry/index.js";
import { formedSection, roundnessFromFill } from "../geometry/formed.js";
import type { BagParams, BagStyle, SectionModel } from "../bagstyles/types.js";

const MM = 0.001; // mm → m
const M = 1000; // m → mm
export const FIXED_DT = 1 / 120; // fixed physics substep (s)
const REST_SPEED = 0.07; // m/s below which a piece is "at rest"
const SETTLE_AVG = 0.06; // m/s mean speed for settle detection (tolerant of slow prism creep)
const CALM_SPEED = 0.2; // m/s mean speed under which the pile is "calm" (not free-falling) → timeout-settle
const HULL_VERTS = 8; // silhouette verts before extrusion → ≤16 in 3-D
const PACKING = 0.6; // bulk packing fraction of a settled pile (void-corrected)
const LENGTH_UNIT = 0.045; // Rapier length scale → contact tolerances match cm-scale product

/**
 * Solver / contact tuning — the levers that make a deep pile of thin rigid discs
 * act solid under settling load, in the order they were pushed (see the ADR
 * addendum for the measured before/after sweep):
 *   1. Solver work: `solverIters` (TGS substeps) + `pgsIters` (inner PGS).
 *   2. Contact handling: `allowedLinError` (penetration slop the solver leaves
 *      uncorrected — smaller = tighter), `contactHz` (contact stiffness), and
 *      `contactSkin` (a solid buffer that resolves before visible faces touch).
 *   3. Collider shape: `discBorder` (rounded-cylinder bevel).
 * Held to a frame-rate budget: nothing here may drop the sim below ~30 fps at
 * 150 pieces.
 */
export const TUNING = {
  solverIters: 16, // TGS outer iterations. This is the dominant per-step COST → the main
  // frame-rate lever; substep-clamping turns extra cost into slow-motion, not dropped
  // frames, so it is kept at 16 to hold the fps floor rather than chased higher.
  pgsIters: 8, // ↑ from 4: inner PGS iterations — firms up the pile at far less fps cost than outer iterations
  frictionIters: 4, // additional friction iterations (Rapier default)
  predictionDist: 0.02, // predictive-contact distance so edge contacts are caught early
  allowedLinError: 0.0005, // ↓ from 0.001: half the penetration slop the solver leaves uncorrected (free)
  contactHz: 60, // ↑ from 30: stiffer contacts (stable at dt = 1/120); pushes overlapping discs apart (free)
  ccdSubsteps: 4, // CCD substeps against tunnelling on fast drops
  contactSkin: 1.4, // product contact skin (mm). A LARGER skin cuts measured overlap but pads the
  // pile taller (an honest fill height reads high / overfull), so it is held here, not increased.
  discBorder: 1.2, // rounded-cylinder bevel (mm): fattens disc edge contacts
};

let rapierReady: Promise<void> | null = null;
/** Initialise the Rapier WASM runtime once. Must resolve before `new FillSim()`. */
export function initPhysics(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

export interface ProductSpec {
  /** Front-view width (mm, x). */
  w: number;
  /** Height (mm, y). */
  h: number;
  /** Depth (mm, z). */
  depth: number;
  /** true → cylinder (disc); false → cuboid or hull. */
  round: boolean;
  /** Centred XZ silhouette (mm) for STEP parts → extruded convex hull. */
  hull?: { x: number; y: number }[];
}

export interface FillParams {
  style: BagStyle;
  bag: BagParams;
  product: ProductSpec;
  unitWeight: number;
  count: number;
  dropH: number;
  stiff: number;
  seed: number;
  /**
   * How product enters the bag:
   * - `trickle` (default): sequential feed through the tube, one piece every
   *   0.13 s — the current behaviour.
   * - `batch`: the whole charge is released at once from a pre-spaced,
   *   overlap-free cloud above the mouth (a combination-scale dump).
   */
  release?: "trickle" | "batch";
}

export type SimStatus = "ready" | "filling" | "settled" | "overfull";

export interface ParticleTransform {
  x: number;
  y: number;
  z: number;
  q: { x: number; y: number; z: number; w: number };
}

export interface ShellState {
  innerLen: number;
  halfW: number;
  halfD: number;
  jawY: number;
  /** Forming-tube length above the jaw plane (mm). */
  tubeLen: number;
}

export interface Measurements {
  fillLine: number;
  headspace: number;
  status: SimStatus;
  restingCount: number;
  fillVolume: number;
  bulkDensity: number;
  pctUsable: number;
  /** Live formed front-to-back depth (mm) from perimeter conservation. */
  formedDepth: number;
  /** Live formed width (mm) — rounding pulls the sides in. */
  formedWidth: number;
  /** Live roundness 0 (lay-flat) … 1 (fully round). */
  formedRoundness: number;
  /** Bag internal volume (cm³) from the formed cross-section over the fill height. */
  formedVolume: number;
  /** Reconciliation: formed internal volume ÷ (product volume + voids). ~1 = consistent. */
  reconcile: number;
}

/** Live formed shell profile for the renderer (belly cross-section + fill line). */
export interface LiveShell {
  innerLen: number;
  endSeal: number;
  jawY: number;
  flatHalfW: number;
  bellyHalfW: number;
  bellyHalfD: number;
  fillLine: number;
  roundness: number;
  tubeLen: number;
}

interface Kinematic {
  body: RAPIER.RigidBody;
  restX: number; // for floor tiles: tile centre x (mm)
}

export class FillSim {
  private world!: RAPIER.World;
  private rng = new Rng(1);
  private params!: FillParams;

  private product: RAPIER.RigidBody[] = [];
  private floorTiles: Kinematic[] = [];

  private queue = 0;
  private spawnTimer = 0;
  private running = false;
  private settled = false;
  private settleT = 0; // time the pile has been quiet (avg < SETTLE_AVG)
  private calmT = 0; // time the pile has been calm (avg < CALM_SPEED) — settle-timeout fallback
  private fillLine = 0;
  private status: SimStatus = "ready";

  // Release: sequential feed vs a one-shot batch dump from a pre-spaced cloud.
  private releaseMode: "trickle" | "batch" = "trickle";
  private batchCloud: { x: number; y: number; z: number }[] = [];
  private releaseTop = 0; // top of the release column (mm) — cage/tube reach up to here

  // geometry cache (mm)
  private innerLen = 0;
  private usableHalfW = 0;
  private usableHalfD = 0;
  private jawY = 0;
  private spawnY = 0; // release height (mm) = jawY + dropH → real free-fall
  private dropH = 0; // drop height (mm)
  private tubeLen = 120; // forming-tube length above the jaw plane (mm) = spawnY − jawY
  private spawnHalfW = 0; // half-width of the spread spawn footprint (mm)
  private spawnHalfD = 0; // half-depth of the spread spawn footprint (mm)
  private wallBot = 0; // wall foot (mm, below the floor)
  private productRadius = 6;

  // Formed cross-section (perimeter conservation) — the film is cut flat, so its
  // cross-section circumference is fixed; as product fills, that perimeter
  // redistributes flat → round, giving a bounded formed depth.
  private flatHalfW = 0; // conserved lay-flat half-width (mm), C = 4·flatHalfW
  private pieceVolume = 0; // solid volume of one product piece (mm³)
  // How the filled cross-section forms — the style decides (pillow rounds from a
  // flat film; gusset styles hold a defined depth). Same elliptical cage either way.
  private section: SectionModel = { kind: "pillow", flatHalfW: 0 };


  private static readonly WALL_T = 4; // radial wall half-thickness (mm)
  private static readonly N_WALL = 30; // ellipse cage segments — no gaps for thin discs
  private static readonly N_FLOOR = 6;
  // Thin floor: a piece pressed into a THICK slab can creep past its midline and
  // get ejected out the *bottom* (nearest surface flips), poking below the seal.
  // Thin means the top face is always closest, so the solver always pushes product
  // back UP; CCD stops fast tunnelling.
  private static readonly FLOOR_HALF_T = 8;

  build(params: FillParams): void {
    this.params = params;
    this.rng.reset(params.seed >>> 0);
    if (this.world) this.world.free();
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_DT;
    // Our world runs in metres but the product is centimetre-scale (a 4 mm disc
    // is 0.004 m). Rapier's contact tolerances are `normalized × lengthUnit`, so
    // with the default lengthUnit = 1 m the ~1 mm penetration slop is enough to
    // swallow a thin disc and the whole stack collapses. Scaling lengthUnit to the
    // product scale shrinks the slop proportionally so discs stack instead of
    // interpenetrating. Extra solver iterations firm up the pile.
    // Contact quality (a collider/contact study on the mm→m scale settled these):
    // scale tolerances to cm-scale parts, widen the prediction distance and raise
    // solver + CCD iterations so angled discs resolve their edge contacts instead
    // of sinking. See ADR-001 addendum.
    const ip = this.world.integrationParameters;
    ip.lengthUnit = LENGTH_UNIT;
    this.world.numSolverIterations = TUNING.solverIters;
    ip.numInternalPgsIterations = TUNING.pgsIters;
    ip.numAdditionalFrictionIterations = TUNING.frictionIters;
    ip.normalizedPredictionDistance = TUNING.predictionDist;
    // Tighten contact handling: leave less penetration uncorrected and stiffen the
    // contact response so overlapping discs are pushed apart, not left sunk in.
    ip.normalizedAllowedLinearError = TUNING.allowedLinError;
    ip.contact_natural_frequency = TUNING.contactHz;
    ip.maxCcdSubsteps = TUNING.ccdSubsteps;

    const st = clamp01(params.stiff / 100);
    const prof = params.style.simProfile(params.bag, { stiffNorm: st });
    this.innerLen = prof.innerLen;

    // Filled cross-section — the style decides how it forms (pillow: perimeter
    // conservation of a flat film; gusset styles: a defined depth). Either way it
    // resolves to one elliptical envelope (halfW × halfD), so the collision cage
    // and containment below are style-agnostic.
    this.section = prof.section;
    this.flatHalfW = prof.section.kind === "pillow" ? prof.section.flatHalfW : prof.usableHalfW;
    this.pieceVolume = pieceVolumeOf(params.product);
    const targetVolume = Math.max(0, params.count) * this.pieceVolume;
    const sec = this.formedFor(targetVolume);

    // Collision envelope = the formed section at the full target fill (the widest
    // the bag will bulge). Rounding trades width for depth, so both are floored at
    // the product footprint so a piece always physically fits.
    // The depth floor also gives a sparsely-filled (near-lay-flat) bag enough room
    // for product to spread across it rather than stacking into a tall central
    // column — the flat sealed base no longer nests pieces low the way the old sag
    // bowl did. It also widens the forming tube so product feeds freely.
    const prMin = 0.5 * Math.max(params.product.w, params.product.depth);
    this.usableHalfW = Math.max(sec.halfW, prMin + 6);
    this.usableHalfD = Math.max(sec.halfD, prMin + 12);
    this.jawY = prof.innerLen;

    // Forming tube = the bag-mouth ellipse extended straight up above the jaw (a
    // real VFFS forming tube is sized to the bag, not a narrow throat). Product is
    // released across the full mouth and falls spread onto the base rather than
    // funnelled onto a centre column; the same elliptical wall contains it the
    // whole way down from the release height, so nothing scatters outside.
    const pr = 0.5 * Math.max(params.product.w, params.product.depth); // footprint radius
    this.productRadius = Math.max(3, 0.5 * Math.max(params.product.w, params.product.h, params.product.depth));
    // Release AT REST at the true drop height above the mouth: free-fall then
    // gives the physically-correct impact speed √(2·g·dropH) — no capped launch
    // velocity. A minimum keeps a short tube for a near-zero drop.
    this.dropH = Math.max(0, params.dropH);
    this.spawnY = this.jawY + Math.max(this.dropH, 60);
    // Spread the release across the mouth (a small clearance inside the wall, and
    // inset by the product footprint so a piece starts fully inside the ellipse).
    this.spawnHalfW = Math.max(2, this.usableHalfW - pr - 3);
    this.spawnHalfD = Math.max(2, this.usableHalfD - pr - 3);

    // Release mode. `batch` pre-lays the whole charge as an overlap-free cloud
    // above the mouth; the cage/tube must reach up over the top of that cloud so
    // it is contained the whole way down. `trickle` releases from a single plane.
    this.releaseMode = params.release === "batch" ? "batch" : "trickle";
    this.batchCloud = this.releaseMode === "batch" ? this.computeBatchCloud(Math.max(0, params.count)) : [];
    this.releaseTop = this.batchCloud.reduce((m, p) => Math.max(m, p.y), this.spawnY);
    // The rendered forming tube stays a sane height above the jaw; a tall batch
    // cloud rains in from above it. The physics cage/backstop still reach up to
    // releaseTop (below) so the whole cloud is contained on the way down.
    this.tubeLen = this.spawnY - this.jawY;

    this.product = [];
    this.floorTiles = [];
    this.buildShell();
    this.buildStatic();
    this.resetRun();
  }

  /**
   * Lay out the whole charge as a pre-spaced cloud above the mouth so a batch
   * release starts with NO piece overlapping another. Pieces sit on a 3-D grid
   * within the release ellipse; the cell size is the piece's bounding-sphere
   * diameter plus clearance, so any random orientation still clears its
   * neighbours. Rows stack upward from the base release height. Deterministic
   * (pure grid) — orientation/jitter is applied per piece at spawn.
   */
  private computeBatchCloud(count: number): { x: number; y: number; z: number }[] {
    const p = this.params.product;
    // Bounding-sphere radius: the farthest surface point from the centre, so the
    // spacing is overlap-free at ANY orientation.
    const sr = p.round
      ? Math.hypot(p.w / 2, p.h / 2) // cylinder rim point
      : Math.hypot(p.w / 2, p.h / 2, p.depth / 2); // box corner
    const cell = 2 * sr + 5; // + clearance
    // Centre limits so a piece's sphere fits inside the wall.
    const bhw = Math.max(cell / 2, this.usableHalfW - sr);
    const bhd = Math.max(cell / 2, this.usableHalfD - sr);
    const cols: { x: number; z: number }[] = [];
    const nx = Math.max(1, Math.floor((2 * bhw) / cell) + 1);
    const nz = Math.max(1, Math.floor((2 * bhd) / cell) + 1);
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const x = (ix - (nx - 1) / 2) * cell;
        const z = (iz - (nz - 1) / 2) * cell;
        if ((x / bhw) ** 2 + (z / bhd) ** 2 <= 1.0001) cols.push({ x, z });
      }
    }
    if (cols.length === 0) cols.push({ x: 0, z: 0 });
    const out: { x: number; y: number; z: number }[] = [];
    const base = this.spawnY + sr; // first row a sphere-radius above the release plane
    for (let i = 0; i < count; i++) {
      const c = cols[i % cols.length];
      const layer = Math.floor(i / cols.length);
      out.push({ x: c.x, y: base + layer * cell, z: c.z });
    }
    return out;
  }

  // ---- mm ⇄ m ----
  private m(v: number): number {
    return v * MM;
  }

  private kinematicBox(hxMM: number, hyMM: number, hzMM: number, restX = 0): Kinematic {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    const st = clamp01(this.params.stiff / 100);
    const desc = RAPIER.ColliderDesc.cuboid(this.m(hxMM), this.m(hyMM), this.m(hzMM))
      .setRestitution(0.02 + 0.1 * st)
      .setFriction(0.6)
      .setContactSkin(this.m(TUNING.contactSkin)); // firm buffer so the bottom layer can't sink in
    this.world.createCollider(desc, body);
    return { body, restX };
  }

  private buildShell(): void {
    // Walls run from below the deepest floor sag up to the jaw plane, so product
    // settling into the sagged belly can't slip out under the wall foot.
    this.wallBot = -(this.innerLen * 0.1 + 25);
    // Elliptical film wall: a ring of thin static segments lying ON the formed
    // cross-section, so the collider MATCHES the visible pillow profile at every
    // height with no corner gaps. It extends above the jaw to the release height as
    // the FORMING TUBE, so product is contained from the drop all the way down —
    // nothing scatters outside. Product settles inside the same ellipse the film
    // renders, so containment and the volume reconciliation are exact.
    this.buildEllipseCage(this.usableHalfW, this.usableHalfD, this.wallBot, this.releaseTop + this.productRadius + 10);

    // Floor: a row of thick sagging tiles across x, covering the full ellipse
    // bounding box in both axes so nothing can rest past the bag footprint.
    const floorHalf = this.usableHalfW + 14;
    const tileHalf = floorHalf / FillSim.N_FLOOR;
    const floorHalfD = this.usableHalfD + 14;
    for (let i = 0; i < FillSim.N_FLOOR; i++) {
      const cx = -floorHalf + tileHalf * (2 * i + 1);
      this.floorTiles.push(this.kinematicBox(tileHalf, FillSim.FLOOR_HALF_T, floorHalfD, cx));
    }
    this.positionShell();
  }

  /**
   * A vertical ring of thin static wall segments lying on the ellipse
   * (x/halfW)² + (z/halfD)² = 1, from yBot to yTop. Interior clearance = the
   * ellipse itself, so this is the exact collider twin of the rendered film.
   */
  private buildEllipseCage(halfW: number, halfD: number, yBot: number, yTop: number): void {
    const st = clamp01(this.params.stiff / 100);
    const N = FillSim.N_WALL;
    const T = FillSim.WALL_T;
    const hy = (yTop - yBot) / 2;
    const cy = (yBot + yTop) / 2;
    // Generous tangential half-length so neighbours overlap even where the ellipse
    // is flattest (widest point spacing) — no gaps for a thin disc to slip.
    const segHalf = ((Math.PI * Math.max(halfW, halfD)) / N) * 1.9;
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * Math.PI * 2;
      const px = halfW * Math.cos(ang);
      const pz = halfD * Math.sin(ang);
      // Outward unit normal of the ellipse at this point.
      let nx = px / (halfW * halfW);
      let nz = pz / (halfD * halfD);
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl;
      nz /= nl;
      const psi = Math.atan2(nz, nx); // normal heading
      const phi = Math.PI / 2 - psi; // yaw so local +z aligns with the normal
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      // Place the segment just OUTSIDE the ellipse so interior clearance = halfW/halfD.
      body.setTranslation({ x: this.m(px + nx * T), y: this.m(cy), z: this.m(pz + nz * T) }, false);
      body.setRotation({ x: 0, y: Math.sin(phi / 2), z: 0, w: Math.cos(phi / 2) }, false);
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(this.m(segHalf), this.m(hy), this.m(T))
          .setRestitution(0.02 + 0.1 * st)
          .setFriction(0.6),
        body,
      );
    }
  }

  private buildStatic(): void {
    const fixed = () => this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const box = (hx: number, hy: number, hz: number, x: number, y: number, z: number) => {
      const b = fixed();
      b.setTranslation({ x: this.m(x), y: this.m(y), z: this.m(z) }, false);
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(this.m(hx), this.m(hy), this.m(hz)).setFriction(0.5),
        b,
      );
    };
    // The forming tube is the elliptical cage (buildShell), so there is no
    // separate round tube or hopper funnel here — product is released already
    // inside the mouth. A generous outer backstop + catch floor stay as a safety
    // net in case a piece is ever nudged past the wall.
    const outerX = Math.max(this.params.bag.bagW / 2, this.usableHalfW) + 25;
    const outerZ = this.usableHalfD + 25;
    const bot = -Math.max(40, this.params.bag.endSeal + 30);
    const top = this.releaseTop + 40;
    const oh = (top - bot) / 2;
    const ocy = (top + bot) / 2;
    box(2, oh, outerZ, -outerX, ocy, 0);
    box(2, oh, outerZ, outerX, ocy, 0);
    box(outerX, oh, 2, 0, ocy, -outerZ);
    box(outerX, oh, 2, 0, ocy, outerZ);
    box(outerX + 5, 4, outerZ + 5, 0, bot, 0); // catch floor
  }

  private floorAt(_xMM: number): number {
    // Flat sealed base at the seal plane (y = 0). Real product rests on the
    // flattened bottom weld, not down in a knife-edge sag pocket — a sagging bowl
    // dropped pieces below the seal plane, where the rendered film pinches, so
    // they poked out the bottom. The pinch/seal is rendered as geometry BELOW
    // this plane (visual only); nothing rests there.
    return 0;
  }

  private positionShell(): void {
    // The ellipse cage is static; only the floor tiles are placed. Flat sealed
    // base: tile top surface sits at the seal plane (centre is FLOOR_HALF_T below).
    for (const tile of this.floorTiles) {
      tile.body.setNextKinematicTranslation({
        x: this.m(tile.restX),
        y: this.m(this.floorAt(tile.restX) - FillSim.FLOOR_HALF_T),
        z: 0,
      });
    }
  }

  private resetRun(): void {
    for (const b of this.product) this.world.removeRigidBody(b);
    this.product = [];
    this.queue = 0;
    this.spawnTimer = 0;
    this.running = false;
    this.settled = false;
    this.settleT = 0;
    this.calmT = 0;
    this.fillLine = 0;
    this.status = "ready";
    this.positionShell();
  }

  reset(): void {
    this.rng.reset(this.params.seed >>> 0);
    this.resetRun();
  }

  start(): void {
    this.reset();
    this.running = true;
    this.status = "filling";
    if (this.releaseMode === "batch") {
      // Release the whole charge at once from the pre-spaced cloud — no queue.
      for (const c of this.batchCloud) this.spawnAt(c.x, c.y, c.z);
      this.queue = 0;
    } else {
      this.queue = this.params.count;
    }
  }

  private randomQuat(): { x: number; y: number; z: number; w: number } {
    // Deterministic uniform-ish quaternion from three seeded values.
    const u1 = this.rng.next();
    const u2 = this.rng.next();
    const u3 = this.rng.next();
    const s1 = Math.sqrt(1 - u1);
    const s2 = Math.sqrt(u1);
    return {
      x: s1 * Math.sin(2 * Math.PI * u2),
      y: s1 * Math.cos(2 * Math.PI * u2),
      z: s2 * Math.sin(2 * Math.PI * u3),
      w: s2 * Math.cos(2 * Math.PI * u3),
    };
  }

  private spawn(): void {
    // Trickle: release across the full bag mouth (elliptical footprint) so product
    // drops spread across the width and lands spread on the base, not on a column.
    const k = Math.sqrt(this.rng.next());
    const th = this.rng.next() * Math.PI * 2;
    this.spawnAt(this.spawnHalfW * k * Math.cos(th), this.spawnY, this.spawnHalfD * k * Math.sin(th));
  }

  /** Instantiate one piece at (x, y, z) mm, at rest with a random orientation. */
  private spawnAt(x: number, y: number, z: number): void {
    const p = this.params.product;
    const st = clamp01(this.params.stiff / 100);
    // Random orientation; the rounded-cylinder collider settles angled contacts.
    const orient = this.randomQuat();
    const rbDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(this.m(x), this.m(y), this.m(z))
      .setRotation(orient)
      // Released AT REST (vy = 0) → real free-fall under gravity, so the impact
      // speed is √(2·g·dropH), not a capped launch velocity. A little lateral
      // scatter only. Linear damping is kept LOW so the fall speed stays physical
      // (see freefall.test.ts); a settled pile is brought to rest by forced
      // sleeping (below), not by faking air drag. Angular damping is high — it
      // does not touch the vertical fall speed but bleeds the rotational rocking
      // that keeps a packed pile of thin discs alive. CCD stops tunnelling.
      .setLinvel(this.rng.spread(0.1), 0, this.rng.spread(0.1))
      .setLinearDamping(0.1)
      .setAngularDamping(1.5 + 1.5 * (1 - st))
      .setCcdEnabled(true);
    const rb = this.world.createRigidBody(rbDesc);

    const mass = Math.max(1e-4, this.params.unitWeight / 1000); // kg
    // Low restitution so pieces settle dead instead of jittering apart. Friction
    // 0.5 keeps the disc prisms from sliding apart (they need it to stack); the
    // pile is spread by the lateral spawn scatter above, not by low friction.
    const restitution = 0.02 + 0.06 * st;
    const collide = this.productCollider(p)
      .setRestitution(restitution)
      .setFriction(0.5)
      .setMass(mass)
      .setContactSkin(this.m(TUNING.contactSkin)); // solid buffer that resists penetration
    this.world.createCollider(collide, rb);
    this.product.push(rb);
  }

  private productCollider(p: ProductSpec): RAPIER.ColliderDesc {
    if (p.round) {
      // Round product = a ROUNDED cylinder (bevelled edge), not an analytic
      // cylinder or a polytope. A collider/contact study (ADR-001 addendum)
      // showed the sharp cylinder edge and the prism's coplanar faces both sink
      // under random (funnel-fed) orientation; the rounded edge fattens the
      // edge/corner contact so angled discs settle at ~physical packing without a
      // flat-spawn crutch. The overall size stays h × ⌀w (border folded in).
      const r = p.w / 2;
      const hHalf = p.h / 2;
      const border = Math.min(TUNING.discBorder, hHalf - 0.5, r - 0.5);
      return RAPIER.ColliderDesc.roundCylinder(this.m(hHalf - border), this.m(r - border), this.m(border));
    }
    if (p.hull && p.hull.length >= 3) {
      const sil = simplifyHull(p.hull, HULL_VERTS);
      const hy = this.m(p.h / 2);
      const pts = new Float32Array(sil.length * 6);
      sil.forEach((v, i) => {
        pts[i * 6] = this.m(v.x);
        pts[i * 6 + 1] = hy;
        pts[i * 6 + 2] = this.m(v.y);
        pts[i * 6 + 3] = this.m(v.x);
        pts[i * 6 + 4] = -hy;
        pts[i * 6 + 5] = this.m(v.y);
      });
      const hull = RAPIER.ColliderDesc.convexHull(pts);
      if (hull) return hull;
    }
    return RAPIER.ColliderDesc.cuboid(this.m(p.w / 2), this.m(p.h / 2), this.m(p.depth / 2));
  }

  /** Advance one fixed substep. */
  fixedStep(): void {
    if (this.running && this.queue > 0) {
      this.spawnTimer -= FIXED_DT;
      if (this.spawnTimer <= 0) {
        this.spawnTimer = 0.13; // spacing so pieces clear the throat without piling
        this.queue--;
        this.spawn();
      }
    }
    this.world.step();
    this.updateFillLine();
    this.updateStatus();
  }

  private appY(b: RAPIER.RigidBody): number {
    return b.translation().y * M;
  }
  private speed(b: RAPIER.RigidBody): number {
    const v = b.linvel();
    return Math.hypot(v.x, v.y, v.z);
  }

  private updateFillLine(): void {
    let top = 0;
    for (const b of this.product) {
      const ay = this.appY(b);
      if (ay < this.jawY + this.productRadius) top = Math.max(top, ay + this.productRadius * 0.6);
    }
    this.fillLine += (top - this.fillLine) * Math.min(1, 8 * FIXED_DT);
  }

  private updateStatus(): void {
    const n = this.product.length;
    let ke = 0;
    for (const b of this.product) {
      const s = this.speed(b);
      ke += s * s;
    }
    const avg = n ? Math.sqrt(ke / n) : 0;
    // Overfull two ways: the pile crosses the jaw plane, OR product can't fit and
    // backs up — pieces come to rest jammed in the throat, just above the jaw.
    // Count only rest pieces in the throat *band* (jaw → release plane); this
    // excludes the batch cloud (which sits at/above the release plane and is
    // momentarily at rest the instant it spawns), so a batch dump doesn't read as
    // instantly overfull.
    let backedUp = 0;
    for (const b of this.product) {
      const y = this.appY(b);
      if (this.speed(b) < REST_SPEED && y > this.jawY + this.productRadius && y < this.spawnY) backedUp++;
    }
    const overfull = n > 0 && (this.fillLine > this.innerLen || backedUp >= 3);
    if (overfull) this.status = "overfull";
    else if (this.running) this.status = "filling";
    else if (this.settled) this.status = "settled";
    else this.status = "ready";

    if (this.running && this.queue === 0 && n > 0) {
      if (avg < SETTLE_AVG) this.settleT += FIXED_DT;
      else this.settleT = 0;
      // The calm timer only advances once the pile is no longer free-falling
      // (avg < CALM_SPEED); it must NOT count while a batch cloud is still in the
      // air, or a stubborn-pile timeout would freeze pieces mid-drop.
      if (avg < CALM_SPEED) this.calmT += FIXED_DT;
      else this.calmT = 0;
      // Settle when the pile is quiet (thin discs reach this fast) OR when a calm
      // but stubborn pile has had a couple of seconds and won't cross the absolute
      // velocity line — heavier product jitters at a higher floor, so an absolute
      // threshold alone can't fit every size.
      if (this.settleT > 0.6 || this.calmT > 2.5) {
        this.running = false;
        this.settled = true;
        this.status = overfull ? "overfull" : "settled";
        // Force the whole pile to sleep. Rapier's auto-sleep threshold is scaled
        // by the small lengthUnit and is effectively unreachable at this scale, so
        // a near-settled pile would micro-jitter forever (fill height never
        // stabilises). Sleeping deactivates the bodies: velocities go to zero and
        // positions freeze, so the readout holds still. Nothing spawns after
        // settle, so they stay asleep (a contact would wake them if it did).
        this.sleepPile();
      }
    } else {
      this.settleT = 0;
      this.calmT = 0;
    }
  }

  /** Deactivate every product body so a settled pile is truly at rest. */
  private sleepPile(): void {
    for (const b of this.product) b.sleep();
  }

  // ---- accessors ----
  particleTransforms(): ParticleTransform[] {
    return this.product.map((b) => {
      const t = b.translation();
      const q = b.rotation();
      return { x: t.x * M, y: t.y * M, z: t.z * M, q: { x: q.x, y: q.y, z: q.z, w: q.w } };
    });
  }

  shell(): ShellState {
    return {
      innerLen: this.innerLen,
      halfW: this.usableHalfW,
      halfD: this.usableHalfD,
      jawY: this.jawY,
      tubeLen: this.tubeLen,
    };
  }

  /**
   * Formed cross-section (halfW × halfD, mm) for a given settled product volume,
   * per the current style. Pillow: a fixed film perimeter rounds flat → round as
   * the pile grows. Boxed (gusset/SUP): a defined depth that opens from `openFloor`
   * toward its full gusset depth as it fills. This one function drives the collision
   * cage (at target fill), the rendered belly, and the FORMED DEPTH readout, so they
   * agree by construction.
   */
  private formedFor(volume: number): { halfW: number; halfD: number; roundness: number } {
    const st = clamp01(this.params.stiff / 100);
    if (this.section.kind === "pillow") {
      const roundness = roundnessFromFill({
        productVolume: volume,
        flatHalfW: this.section.flatHalfW,
        innerLen: this.innerLen,
        stiffNorm: st,
        packing: PACKING,
      });
      const sec = formedSection(this.section.flatHalfW, roundness);
      return { halfW: sec.halfW, halfD: sec.halfD, roundness };
    }
    // Boxed gusset: width is fixed; depth opens toward the gusset depth with fill.
    const { halfW, halfD, openFloor } = this.section;
    const capacity = PACKING * Math.PI * halfW * halfD * this.innerLen;
    const frac = capacity > 0 ? clamp01(volume / capacity) : 0;
    const open = openFloor + (1 - openFloor) * frac;
    const d = Math.max(0.5, halfD * open);
    return { halfW, halfD: d, roundness: d / halfW };
  }

  /** Live formed cross-section from the current *settled* product volume. */
  private liveFormed(restingCount: number): { halfW: number; halfD: number; roundness: number } {
    return this.formedFor(restingCount * this.pieceVolume);
  }

  measurements(): Measurements {
    const n = this.product.length;
    let resting = 0;
    for (const b of this.product) if (this.speed(b) < REST_SPEED && this.appY(b) < this.jawY) resting++;
    const hs = headspaceOf(this.innerLen, this.fillLine);
    // The bag interior is the formed ELLIPSE the product actually sits in (the
    // collision film), so the internal volume up to the fill line is that ellipse
    // area × fill height. (The live section `f` below is the belly shape used for
    // the FORMED DEPTH readout, which bulges with fill.)
    const bagCrossArea = Math.PI * this.usableHalfW * this.usableHalfD;
    const f = this.liveFormed(resting);
    const fillVolume = n > 0 ? bagCrossArea * Math.max(0, this.fillLine) : 0;
    const mass = n * this.params.unitWeight;
    const bulkDensity = fillVolume > 0 ? mass / fillVolume : 0;
    const usable = bagCrossArea * this.innerLen;
    const pctUsable = usable > 0 ? (fillVolume / usable) * 100 : 0;

    // Consistency check: the bag internal volume must equal product solid + voids.
    // reconcile = solid ÷ bag internal = the settled packing fraction (≈0.9–1.0
    // for a dense disc pile; a value well over 1 would flag interpenetration).
    const solidVol = n * this.pieceVolume;
    const reconcile = fillVolume > 0 ? solidVol / fillVolume : 0;

    return {
      fillLine: this.fillLine,
      headspace: hs,
      status: this.status,
      restingCount: resting,
      fillVolume,
      bulkDensity,
      pctUsable,
      formedDepth: 2 * f.halfD,
      formedWidth: 2 * f.halfW,
      formedRoundness: f.roundness,
      formedVolume: fillVolume / 1000, // cm³
      reconcile,
    };
  }

  /** Live formed shell profile (belly cross-section + fill line) for the renderer. */
  liveShell(): LiveShell {
    let resting = 0;
    for (const b of this.product) if (this.speed(b) < REST_SPEED && this.appY(b) < this.jawY) resting++;
    const f = this.liveFormed(resting);
    return {
      innerLen: this.innerLen,
      endSeal: this.params.bag.endSeal,
      jawY: this.jawY,
      flatHalfW: this.flatHalfW,
      bellyHalfW: f.halfW,
      bellyHalfD: f.halfD,
      fillLine: this.fillLine,
      roundness: f.roundness,
      tubeLen: this.tubeLen,
    };
  }

  get envelope() {
    return {
      innerLen: this.innerLen,
      usableHalfW: this.usableHalfW,
      usableHalfD: this.usableHalfD,
      flatHalfW: this.flatHalfW,
      endSeal: this.params.bag.endSeal,
      jawY: this.jawY,
      spawnY: this.spawnY,
      tubeLen: this.tubeLen,
      productRadius: this.productRadius,
    };
  }

  /**
   * Per-contact penetration depth (mm, >0 = overlap) read from Rapier's narrow
   * phase, for solver-quality diagnostics. `all` = every product contact,
   * `dd` = disc↔disc only (the hard case). This reads the *real* solved overlap,
   * not the bulk packing average, so it exposes interpenetration the reconcile
   * fraction hides. Each pair is counted once.
   */
  penetrationReport(): { all: number[]; dd: number[] } {
    const prodHandles = new Set(this.product.map((b) => b.collider(0).handle));
    const all: number[] = [];
    const dd: number[] = [];
    const seen = new Set<number>();
    for (const b of this.product) {
      const c1 = b.collider(0);
      this.world.contactPairsWith(c1, (c2) => {
        const key = c1.handle < c2.handle ? c1.handle * 1e7 + c2.handle : c2.handle * 1e7 + c1.handle;
        if (seen.has(key)) return;
        seen.add(key);
        this.world.contactPair(c1, c2, (m) => {
          let deepest = 0;
          for (let i = 0, nc = m.numContacts(); i < nc; i++) {
            const d = m.contactDist(i); // metres; < 0 = penetration
            if (d < 0) deepest = Math.max(deepest, -d * M);
          }
          if (deepest > 0) {
            all.push(deepest);
            if (prodHandles.has(c2.handle)) dd.push(deepest);
          }
        });
      });
    }
    return { all, dd };
  }

  get product_(): ProductSpec {
    return this.params.product;
  }

  get isActive(): boolean {
    return this.running || this.product.some((b) => this.speed(b) > 0.02);
  }

  /**
   * Top-seal fit check. After the pile settles, the sealing jaws close at the jaw
   * plane (y = innerLen). A clean seal needs the settled product to sit at least
   * `clearance` mm below that plane; any piece reaching up into the seal zone
   * (jawPlane − clearance … jawPlane) would be caught in the jaws — a reject.
   *
   * `productTop` is measured per piece from its *oriented* bounding box (a
   * flat-lying disc reaches far less than an on-edge one), so this is the real
   * geometric check, not just the smoothed fill-line metric.
   */
  sealCheck(clearance: number): {
    clean: boolean;
    clearance: number; // actual mm from product top to the jaw plane
    productTop: number;
    jawPlane: number;
    caught: number; // pieces intruding into the seal zone
  } {
    const jawPlane = this.innerLen;
    const zone = jawPlane - Math.max(0, clearance);
    let productTop = 0;
    let caught = 0;
    for (const b of this.product) {
      const top = this.appY(b) + this.pieceHalfHeightY(b);
      if (top > productTop) productTop = top;
      if (top > zone) caught++;
    }
    return {
      clean: this.product.length > 0 && productTop <= zone,
      clearance: jawPlane - productTop,
      productTop,
      jawPlane,
      caught,
    };
  }

  /** World-Y half-extent of a piece's oriented bounding box (mm). */
  private pieceHalfHeightY(b: RAPIER.RigidBody): number {
    const p = this.params.product;
    const hx = p.w / 2;
    const hy = p.h / 2;
    const hz = p.round ? p.w / 2 : p.depth / 2;
    const q = b.rotation();
    // Row 1 of the local→world rotation matrix = world-Y components of each local axis.
    const r10 = Math.abs(2 * (q.x * q.y + q.w * q.z));
    const r11 = Math.abs(1 - 2 * (q.x * q.x + q.z * q.z));
    const r12 = Math.abs(2 * (q.y * q.z - q.w * q.x));
    return r10 * hx + r11 * hy + r12 * hz;
  }

  /** Settling diagnostics (m/s): mean/max speed and how many bodies are asleep. */
  restDebug(): { n: number; avg: number; max: number; sleeping: number } {
    const n = this.product.length;
    let ke = 0;
    let max = 0;
    let sleeping = 0;
    for (const b of this.product) {
      const s = this.speed(b);
      ke += s * s;
      if (s > max) max = s;
      if (b.isSleeping()) sleeping++;
    }
    return { n, avg: n ? Math.sqrt(ke / n) : 0, max, sleeping };
  }

  get particleCount(): number {
    return this.product.length;
  }
}

/** Solid volume of one product piece (mm³) — matches the collider shape. */
function pieceVolumeOf(p: ProductSpec): number {
  if (p.round) return Math.PI * (p.w / 2) ** 2 * p.h; // cylinder
  if (p.hull && p.hull.length >= 3) return polygonArea(p.hull) * p.h; // extruded silhouette
  return p.w * p.h * p.depth; // cuboid
}

/** Absolute area (mm²) of a closed polygon via the shoelace formula. */
function polygonArea(pts: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
