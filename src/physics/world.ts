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
import type { BagParams, BagStyle } from "../bagstyles/types.js";

const MM = 0.001; // mm → m
const M = 1000; // m → mm
export const FIXED_DT = 1 / 120; // fixed physics substep (s)
const REST_SPEED = 0.07; // m/s below which a piece is "at rest"
const SETTLE_AVG = 0.06; // m/s mean speed for settle detection (tolerant of slow prism creep)
const HULL_VERTS = 8; // silhouette verts before extrusion → ≤16 in 3-D
const PACKING = 0.6; // bulk packing fraction of a settled pile (void-corrected)
const SOLVER_ITERS = 16; // ↑ from Rapier's default 4 so angled discs resolve, not interpenetrate
const LENGTH_UNIT = 0.045; // Rapier length scale → contact tolerances match cm-scale product
const PREDICTION_DIST = 0.02; // ↑ predictive-contact distance so edge contacts are caught early
const DISC_BORDER = 1.2; // rounded-cylinder bevel (mm): fattens disc edge contacts
const CONTACT_SKIN = 1.4; // product contact skin (mm): a solid buffer that resists penetration

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
  /** Round forming-tube radius (mm). */
  tubeR: number;
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
  tubeR: number;
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
  private settleT = 0;
  private fillLine = 0;
  private status: SimStatus = "ready";

  // geometry cache (mm)
  private innerLen = 0;
  private usableHalfW = 0;
  private usableHalfD = 0;
  private jawY = 0;
  private spawnY = 0;
  private tubeR = 20; // round former radius (mm)
  private tubeLen = 120; // straight tube length above the jaw (mm)
  private funnelR = 40; // hopper funnel mouth radius (mm)
  private funnelH = 40; // hopper funnel height (mm)
  private spawnRadius = 0; // radius of the spawn disc above the funnel mouth (mm)
  private dropSpeed = 1; // downward launch speed from drop height (m/s)
  private wallBot = 0; // wall foot (mm, below the floor sag)
  private productRadius = 6;

  // Formed cross-section (perimeter conservation) — the film is cut flat, so its
  // cross-section circumference is fixed; as product fills, that perimeter
  // redistributes flat → round, giving a bounded formed depth.
  private flatHalfW = 0; // conserved lay-flat half-width (mm), C = 4·flatHalfW
  private pieceVolume = 0; // solid volume of one product piece (mm³)
  private formedRoundnessTgt = 0; // roundness at the full target fill (0 flat … 1 round)


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
    this.world.numSolverIterations = SOLVER_ITERS;
    ip.numInternalPgsIterations = 4;
    ip.normalizedPredictionDistance = PREDICTION_DIST;
    ip.maxCcdSubsteps = 4;

    const st = clamp01(params.stiff / 100);
    const prof = params.style.simProfile(params.bag, { stiffNorm: st });
    this.innerLen = prof.innerLen;

    // Formed cross-section by perimeter conservation. The lay-flat film width is
    // fixed (usableHalfW is half of it); the settled product volume drives how
    // much of that fixed perimeter rounds out into depth. Empty → lay-flat,
    // packed toward the fully-round capacity → round. Limp film bulges more.
    this.flatHalfW = prof.usableHalfW;
    this.pieceVolume = pieceVolumeOf(params.product);
    const targetVolume = Math.max(0, params.count) * this.pieceVolume;
    this.formedRoundnessTgt = roundnessFromFill({
      productVolume: targetVolume,
      flatHalfW: this.flatHalfW,
      innerLen: this.innerLen,
      stiffNorm: st,
      packing: PACKING,
    });
    const sec = formedSection(this.flatHalfW, this.formedRoundnessTgt);

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

    // Former stack: hopper funnel → round tube → bag mouth, all concentric with
    // the bag opening. The round tube is sized wide enough to pass the product
    // (guide, don't meter — no deliberate bridging/jamming); the funnel catches
    // the drop spread and centres every piece into the tube.
    const minHalf = Math.min(this.usableHalfW, this.usableHalfD);
    const pr = 0.5 * Math.max(params.product.w, params.product.depth); // footprint radius
    // Wide enough to pass the product freely (guide, don't meter/bridge).
    this.tubeR = clamp(Math.max(0.9 * minHalf, pr + 8), pr + 6, Math.max(pr + 6, minHalf - 2));
    this.tubeLen = clamp(params.dropH * 0.08, 50, 140);
    this.funnelR = Math.max(1.9 * this.tubeR, this.usableHalfW * 1.0);
    this.funnelH = this.funnelR * 0.9;
    const funnelTop = this.jawY + this.tubeLen + this.funnelH;
    // Spawn ABOVE the funnel mouth, well inside the rim; the walls centre pieces.
    this.spawnRadius = this.funnelR * 0.5;
    this.spawnY = funnelTop + 40;
    // Drop height becomes downward launch speed (capped); CCD stops tunnelling.
    this.dropSpeed = Math.min(5.0, Math.sqrt(2 * 9.81 * Math.max(0, params.dropH) * MM));
    this.productRadius = Math.max(3, 0.5 * Math.max(params.product.w, params.product.h, params.product.depth));

    this.product = [];
    this.floorTiles = [];
    this.buildShell();
    this.buildStatic();
    this.resetRun();
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
      .setContactSkin(this.m(CONTACT_SKIN)); // firm buffer so the bottom layer can't sink in
    this.world.createCollider(desc, body);
    return { body, restX };
  }

  private buildShell(): void {
    // Walls run from below the deepest floor sag up to the jaw plane, so product
    // settling into the sagged belly can't slip out under the wall foot.
    this.wallBot = -(this.innerLen * 0.1 + 25);
    // Elliptical film wall: a ring of thin static segments lying ON the formed
    // cross-section, so the collider MATCHES the visible pillow profile at every
    // height with no corner gaps. Product settles inside the same ellipse the film
    // renders, so containment and the volume reconciliation are exact.
    this.buildEllipseCage(this.usableHalfW, this.usableHalfD, this.wallBot, this.innerLen);

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
    // Round forming tube / containment guide: a ring of static wall segments
    // forming a cylinder from the bag mouth (outlet, y=jawY) up to jawY+tubeLen.
    // It sits concentric inside the bag opening and funnels every dropped piece
    // straight into the throat, whatever the drop height.
    const N = 22;
    const RAD_T = 4; // radial wall half-thickness (mm) — thin product can't tunnel
    const tubeBot = this.jawY - 4; // start just inside the mouth
    const tubeTop = this.jawY + this.tubeLen;
    {
      const hy = (tubeTop - tubeBot) / 2;
      const cy = (tubeBot + tubeTop) / 2;
      // Overlap segments generously so there are no gaps for thin discs to slip.
      const segHalf = ((Math.PI * this.tubeR) / N) * 1.6;
      for (let i = 0; i < N; i++) {
        const ang = (i / N) * Math.PI * 2;
        const b = fixed();
        const phi = Math.PI / 2 - ang; // orient local +z radially outward
        b.setTranslation({ x: this.m(Math.cos(ang) * this.tubeR), y: this.m(cy), z: this.m(Math.sin(ang) * this.tubeR) }, false);
        b.setRotation({ x: 0, y: Math.sin(phi / 2), z: 0, w: Math.cos(phi / 2) }, false);
        this.world.createCollider(
          RAPIER.ColliderDesc.cuboid(this.m(segHalf), this.m(hy), this.m(RAD_T)).setFriction(0.4),
          b,
        );
      }
    }

    // Hopper funnel: a cone of tilted wall segments, tubeR (bottom) → funnelR
    // (top), catching the drop spread and guiding pieces down into the tube.
    {
      const funBot = tubeTop;
      const funTop = tubeTop + this.funnelH;
      const rm = (this.tubeR + this.funnelR) / 2;
      const cy = (funBot + funTop) / 2;
      const slant = Math.hypot(this.funnelR - this.tubeR, this.funnelH);
      const beta = Math.atan2(this.funnelR - this.tubeR, this.funnelH); // tilt from vertical
      const cb = Math.cos(beta);
      const sb = Math.sin(beta);
      // Segment width based on the WIDEST radius (+ overlap) so the top can't gap.
      const segHalf = ((Math.PI * this.funnelR) / N) * 1.6;
      for (let i = 0; i < N; i++) {
        const ang = (i / N) * Math.PI * 2;
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        // Local axes in world: x = tangential, y = slant (up+out), z = radial normal.
        const X = { x: sa, y: 0, z: -ca }; // -tangential (keeps right-handed)
        const Y = { x: ca * sb, y: cb, z: sa * sb };
        const Z = { x: ca * cb, y: -sb, z: sa * cb };
        const b = fixed();
        b.setTranslation({ x: this.m(ca * rm), y: this.m(cy), z: this.m(sa * rm) }, false);
        b.setRotation(basisToQuat(X, Y, Z), false);
        this.world.createCollider(
          RAPIER.ColliderDesc.cuboid(this.m(segHalf), this.m(slant / 2), this.m(RAD_T)).setFriction(0.3).setRestitution(0.02),
          b,
        );
      }
    }

    // Outer containment (backstop) + catch floor below the seal.
    const outerX = Math.max(this.params.bag.bagW / 2, this.funnelR) + 25;
    const outerZ = Math.max(this.usableHalfD, this.funnelR) + 25;
    const bot = -Math.max(40, this.params.bag.endSeal + 30);
    const top = this.spawnY + 40;
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
    this.queue = this.params.count;
    this.running = true;
    this.status = "filling";
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
    const p = this.params.product;
    const st = clamp01(this.params.stiff / 100);
    // Uniform point in the outlet disc (inside the tube throat).
    const rr = this.spawnRadius * Math.sqrt(this.rng.next());
    const th = this.rng.next() * Math.PI * 2;
    const x = rr * Math.cos(th);
    const z = rr * Math.sin(th);
    // Product enters with a random orientation and is reoriented only by the
    // funnel + tube on the way down — no artificial flat spawn. The rounded-
    // cylinder collider settles the resulting angled contacts cleanly.
    const orient = this.randomQuat();
    const rbDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(this.m(x), this.m(this.spawnY), this.m(z))
      .setRotation(orient)
      // Launch downward at the drop-height velocity, with a little lateral scatter.
      .setLinvel(this.rng.spread(0.2), -this.dropSpeed, this.rng.spread(0.2))
      .setLinearDamping(0.05 + 0.5 * (1 - st))
      .setAngularDamping(0.3 + 0.6 * (1 - st))
      // Continuous collision so a fast piece can't tunnel the thin floor/walls.
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
      .setContactSkin(this.m(CONTACT_SKIN)); // solid buffer that resists penetration
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
      const border = Math.min(DISC_BORDER, hHalf - 0.5, r - 0.5);
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
    // backs up — pieces come to rest above the jaw (jammed in the throat/tube).
    let backedUp = 0;
    for (const b of this.product) {
      if (this.speed(b) < REST_SPEED && this.appY(b) > this.jawY + this.productRadius) backedUp++;
    }
    const overfull = n > 0 && (this.fillLine > this.innerLen || backedUp >= 3);
    if (overfull) this.status = "overfull";
    else if (this.running) this.status = "filling";
    else if (this.settled) this.status = "settled";
    else this.status = "ready";

    if (this.running && this.queue === 0 && n > 0 && avg < SETTLE_AVG) {
      this.settleT += FIXED_DT;
      if (this.settleT > 0.6) {
        this.running = false;
        this.settled = true;
        this.status = overfull ? "overfull" : "settled";
      }
    } else {
      this.settleT = 0;
    }
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
      tubeR: this.tubeR,
      tubeLen: this.tubeLen,
    };
  }

  /**
   * Live formed cross-section from the *settled* product volume. Empty → lay-flat;
   * as the pile grows, the fixed film perimeter rounds out into depth. This is what
   * the renderer bulges to, and what FORMED DEPTH reports.
   */
  private liveFormed(restingCount: number): { halfW: number; halfD: number; roundness: number } {
    const st = clamp01(this.params.stiff / 100);
    const settledVol = restingCount * this.pieceVolume;
    const roundness = roundnessFromFill({
      productVolume: settledVol,
      flatHalfW: this.flatHalfW,
      innerLen: this.innerLen,
      stiffNorm: st,
      packing: PACKING,
    });
    const sec = formedSection(this.flatHalfW, roundness);
    return { halfW: sec.halfW, halfD: sec.halfD, roundness };
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
      tubeR: this.tubeR,
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
      tubeR: this.tubeR,
      tubeLen: this.tubeLen,
      funnelR: this.funnelR,
      funnelH: this.funnelH,
      productRadius: this.productRadius,
    };
  }

  get product_(): ProductSpec {
    return this.params.product;
  }

  get isActive(): boolean {
    return this.running || this.product.some((b) => this.speed(b) > 0.02);
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
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
type V3 = { x: number; y: number; z: number };
type Quat = { x: number; y: number; z: number; w: number };
/** Rotation quaternion from an orthonormal basis given as world-space columns X,Y,Z. */
function basisToQuat(X: V3, Y: V3, Z: V3): Quat {
  const m00 = X.x, m10 = X.y, m20 = X.z;
  const m01 = Y.x, m11 = Y.y, m21 = Y.z;
  const m02 = Z.x, m12 = Z.y, m22 = Z.z;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return { w: 0.25 * s, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s };
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s };
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s };
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s };
}
