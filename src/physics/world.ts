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
 * - Film: a quasi-static parametric shell. Four kinematic wall colliders plus a
 *   kinematic sagging floor, whose billow/sag are driven analytically from the
 *   film stiffness and the resting load — not simulated cloth. Stiffness also
 *   maps to contact restitution/damping so the catch feel survives.
 * - A static forming tube guides product in; static outer walls + a catch floor
 *   contain overflow.
 * - Fixed timestep with substep clamping; seeded RNG spawn jitter → deterministic.
 */

import RAPIER from "@dimforge/rapier3d-compat";
import { Rng } from "./rng.js";
import { simplifyHull } from "../geometry/hull.js";
import { headspace as headspaceOf } from "../geometry/index.js";
import type { BagParams, BagStyle } from "../bagstyles/types.js";

const MM = 0.001; // mm → m
const M = 1000; // m → mm
export const FIXED_DT = 1 / 120; // fixed physics substep (s)
const REST_SPEED = 0.06; // m/s below which a piece is "at rest"
const SETTLE_AVG = 0.04; // m/s mean speed for settle detection
const HULL_VERTS = 8; // silhouette verts before extrusion → ≤16 in 3-D

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
  sag: number;
  jawY: number;
  spawnY: number;
  tubeHalfW: number;
  tubeHalfD: number;
}

export interface Measurements {
  fillLine: number;
  headspace: number;
  status: SimStatus;
  restingCount: number;
  fillVolume: number;
  bulkDensity: number;
  pctUsable: number;
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
  private walls: { left: Kinematic; right: Kinematic; front: Kinematic; back: Kinematic } | null =
    null;
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
  private tubeHalfW = 0;
  private tubeHalfD = 0;
  private productRadius = 6;

  private sag = 0;
  private billow = 0;
  private sagGain = 1;
  private billowGain = 0.3;

  private static readonly WALL_T = 3; // wall thickness (mm)
  private static readonly N_FLOOR = 6;

  build(params: FillParams): void {
    this.params = params;
    this.rng.reset(params.seed >>> 0);
    if (this.world) this.world.free();
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_DT;

    const st = clamp01(params.stiff / 100);
    const prof = params.style.simProfile(params.bag, { stiffNorm: st });
    this.innerLen = prof.innerLen;
    this.usableHalfW = prof.usableHalfW;
    this.usableHalfD = prof.usableHalfD;
    this.sagGain = prof.floorSagGain;
    this.billowGain = prof.billowGain;
    this.jawY = prof.innerLen;
    this.tubeHalfW = prof.usableHalfW * 0.78;
    this.tubeHalfD = prof.usableHalfD * 0.78;
    const topFilm = this.jawY + params.bag.endSeal;
    this.spawnY = topFilm + Math.max(0, params.dropH);
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
      .setRestitution(0.04 + 0.28 * st)
      .setFriction(0.6);
    this.world.createCollider(desc, body);
    return { body, restX };
  }

  private buildShell(): void {
    const t = FillSim.WALL_T;
    const halfLen = this.innerLen / 2;
    // Side walls (±x): thin in x, tall in y, deep in z.
    const left = this.kinematicBox(t, halfLen, this.usableHalfD + t);
    const right = this.kinematicBox(t, halfLen, this.usableHalfD + t);
    // Front/back walls (±z): wide in x, tall in y, thin in z.
    const front = this.kinematicBox(this.usableHalfW + t, halfLen, t);
    const back = this.kinematicBox(this.usableHalfW + t, halfLen, t);
    this.walls = { left, right, front, back };

    // Floor: a row of tiles across x (the sag direction), full depth in z.
    const floorHalf = this.usableHalfW + 12;
    const tileHalf = floorHalf / FillSim.N_FLOOR;
    for (let i = 0; i < FillSim.N_FLOOR; i++) {
      const cx = -floorHalf + tileHalf * (2 * i + 1);
      this.floorTiles.push(this.kinematicBox(tileHalf, t, this.usableHalfD + 12, cx));
    }
    this.positionShell();
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
    // Forming tube (4 static walls) from jaw → above spawn.
    const tubeBot = this.jawY;
    const tubeTop = this.spawnY + 20;
    const tubeH = (tubeTop - tubeBot) / 2;
    const tubeCY = (tubeBot + tubeTop) / 2;
    box(2, tubeH, this.tubeHalfD, -this.tubeHalfW, tubeCY, 0);
    box(2, tubeH, this.tubeHalfD, this.tubeHalfW, tubeCY, 0);
    box(this.tubeHalfW, tubeH, 2, 0, tubeCY, -this.tubeHalfD);
    box(this.tubeHalfW, tubeH, 2, 0, tubeCY, this.tubeHalfD);

    // Outer containment (catch overflow) + catch floor below the seal.
    const outerX = this.params.bag.bagW / 2 + 25;
    const outerZ = this.usableHalfD + 25;
    const bot = -Math.max(40, this.params.bag.endSeal + 30);
    const top = this.spawnY + 60;
    const oh = (top - bot) / 2;
    const ocy = (top + bot) / 2;
    box(2, oh, outerZ, -outerX, ocy, 0);
    box(2, oh, outerZ, outerX, ocy, 0);
    box(outerX, oh, 2, 0, ocy, -outerZ);
    box(outerX, oh, 2, 0, ocy, outerZ);
    box(outerX + 5, 4, outerZ + 5, 0, bot, 0); // catch floor
  }

  private floorAt(xMM: number): number {
    const t = Math.max(-1, Math.min(1, xMM / Math.max(1, this.usableHalfW)));
    return -this.sag * Math.cos((t * Math.PI) / 2);
  }

  private positionShell(): void {
    if (!this.walls) return;
    const halfLen = this.innerLen / 2;
    const hw = this.usableHalfW + this.billow + FillSim.WALL_T;
    const hd = this.usableHalfD + FillSim.WALL_T;
    const set = (k: Kinematic, x: number, y: number, z: number) =>
      k.body.setNextKinematicTranslation({ x: this.m(x), y: this.m(y), z: this.m(z) });
    set(this.walls.left, -hw, halfLen, 0);
    set(this.walls.right, hw, halfLen, 0);
    set(this.walls.front, 0, halfLen, hd);
    set(this.walls.back, 0, halfLen, -hd);
    for (const tile of this.floorTiles) set(tile, tile.restX, this.floorAt(tile.restX), 0);
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
    this.sag = 0;
    this.billow = 0;
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
    const spreadX = Math.min(this.usableHalfW * 0.4, this.tubeHalfW * 0.6);
    const spreadZ = Math.min(this.usableHalfD * 0.4, this.tubeHalfD * 0.6);
    const rbDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(this.m(this.rng.spread(spreadX)), this.m(this.spawnY + this.rng.range(0, 8)), this.m(this.rng.spread(spreadZ)))
      .setRotation(this.randomQuat())
      .setLinvel(this.m(this.rng.spread(40)), 0, this.m(this.rng.spread(40)))
      .setLinearDamping(0.05 + 0.5 * (1 - st))
      .setAngularDamping(0.3 + 0.6 * (1 - st));
    const rb = this.world.createRigidBody(rbDesc);

    const mass = Math.max(1e-4, this.params.unitWeight / 1000); // kg
    const restitution = 0.05 + 0.25 * st;
    const collide = this.productCollider(p).setRestitution(restitution).setFriction(0.5).setMass(mass);
    this.world.createCollider(collide, rb);
    this.product.push(rb);
  }

  private productCollider(p: ProductSpec): RAPIER.ColliderDesc {
    if (p.round) {
      return RAPIER.ColliderDesc.cylinder(this.m(p.h / 2), this.m(p.w / 2));
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
        this.spawnTimer = 0.1;
        this.queue--;
        this.spawn();
      }
    }
    this.updateShell();
    this.world.step();
    this.updateFillLine();
    this.updateStatus();
  }

  private updateShell(): void {
    let resting = 0;
    for (const b of this.product) {
      if (this.speed(b) < REST_SPEED && this.appY(b) < this.jawY) resting++;
    }
    const load = (resting * this.params.unitWeight) / 50;
    const sagTarget = Math.min(this.innerLen * 0.1, load * this.sagGain * 1.6);
    const billowTarget = Math.min(this.usableHalfW * 0.25, load * this.billowGain);
    this.sag += (sagTarget - this.sag) * Math.min(1, 3 * FIXED_DT);
    this.billow += (billowTarget - this.billow) * Math.min(1, 3 * FIXED_DT);
    this.positionShell();
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
    const overfull = n > 0 && this.fillLine > this.innerLen;
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
      halfW: this.usableHalfW + this.billow,
      halfD: this.usableHalfD,
      sag: this.sag,
      jawY: this.jawY,
      spawnY: this.spawnY,
      tubeHalfW: this.tubeHalfW,
      tubeHalfD: this.tubeHalfD,
    };
  }

  measurements(): Measurements {
    const n = this.product.length;
    let resting = 0;
    for (const b of this.product) if (this.speed(b) < REST_SPEED && this.appY(b) < this.jawY) resting++;
    const hs = headspaceOf(this.innerLen, this.fillLine);
    const crossW = 2 * this.usableHalfW;
    const crossD = 2 * this.usableHalfD;
    const fillVolume = n > 0 ? crossW * crossD * Math.max(0, this.fillLine) : 0;
    const mass = n * this.params.unitWeight;
    const bulkDensity = fillVolume > 0 ? mass / fillVolume : 0;
    const usable = crossW * crossD * this.innerLen;
    const pctUsable = usable > 0 ? (fillVolume / usable) * 100 : 0;
    return {
      fillLine: this.fillLine,
      headspace: hs,
      status: this.status,
      restingCount: resting,
      fillVolume,
      bulkDensity,
      pctUsable,
    };
  }

  get envelope() {
    return {
      innerLen: this.innerLen,
      usableHalfW: this.usableHalfW,
      usableHalfD: this.usableHalfD,
      jawY: this.jawY,
      spawnY: this.spawnY,
      tubeHalfW: this.tubeHalfW,
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

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
