/**
 * Fill physics — matter-js soft-body model of a VFFS pillow bag.
 *
 * Coordinate frames
 * -----------------
 * App space (what the sim reports and the renderer draws): x right from the
 * centreline, y UP from the inner floor (y = 0) to the jaw plane (y = innerLen),
 * millimetres. matter-js is y-down, so we mirror: matterY = -appY.
 *
 * Model
 * -----
 * - Product: circle bodies (round) or rounded-rectangle bodies (square/STEP) —
 *   true box collisions, not circle approximations.
 * - Film walls: two chains of small node bodies linked by stiffness-mapped
 *   constraints, hard-anchored at the bottom seal and the jaw plane, with a
 *   return spring to their rest line. The stiffness slider maps to constraint
 *   stiffness/damping, wall restitution, edge tuck (usable width, via the
 *   BagStyle profile) and floor-sag gain — limp absorbs and conforms, stiff
 *   bounces and stays planar.
 * - Floor: a node chain across the bottom, edge-anchored, sagging under load.
 * - Forming tube: two static rails above the jaw plane guiding product in.
 *
 * The engine is advanced by a fixed 240 Hz substep from the caller's
 * accumulator; spawn jitter comes from a seeded RNG, so a fill replays exactly.
 */

import {
  Engine,
  Composite,
  Bodies,
  Body,
  Constraint,
  type Body as MBody,
  type Composite as MComposite,
} from "matter-js";
import { Rng } from "./rng.js";
import { usableBagVolume, headspace as headspaceOf } from "../geometry/index.js";
import type { BagParams, BagStyle } from "../bagstyles/types.js";

export interface ProductSpec {
  /** Front-view width (mm). */
  w: number;
  /** Front-view height (mm). */
  h: number;
  /** true → circle body of radius w/2; false → rounded rectangle. */
  round: boolean;
  /**
   * Optional centred convex silhouette (mm) for STEP parts — used as the
   * collision body and rendered shape in place of the bounding rectangle.
   */
  hull?: { x: number; y: number }[];
}

export interface FillParams {
  style: BagStyle;
  bag: BagParams;
  product: ProductSpec;
  /** Per-piece weight (g). */
  unitWeight: number;
  /** Pieces to drop. */
  count: number;
  /** Drop height above the open top (mm). */
  dropH: number;
  /** Film stiffness 0–100. */
  stiff: number;
  /** RNG seed for deterministic replay. */
  seed: number;
}

export type SimStatus = "ready" | "filling" | "settled" | "overfull";

export interface WallSample {
  x: number;
  y: number;
}

export interface ParticleSample {
  x: number;
  y: number;
  angle: number;
  round: boolean;
  w: number;
  h: number;
  r: number;
  /** Centred silhouette polygon (mm) for STEP parts, else undefined. */
  hull?: { x: number; y: number }[];
}

export interface Measurements {
  fillLine: number;
  headspace: number;
  status: SimStatus;
  restingCount: number;
  /** Settled pile fill volume estimate (mm³). */
  fillVolume: number;
  /** Effective bulk density from the settled pile (g/mm³). */
  bulkDensity: number;
  /** % of usable bag volume occupied. */
  pctUsable: number;
}

const WALL_NODES = 24;
const FLOOR_NODES = 15;

/**
 * Fixed substep fed to matter-js, in its native millisecond time base. The app
 * accumulator ticks at 240 Hz, so one sim-second is 240 substeps = 1000 ms of
 * matter time — sim time tracks wall time at real speed. Gravity is tuned
 * against this delta (see constructor); body velocities below are therefore in
 * matter's px(=mm)/step units, not mm/s.
 */
const SUBSTEP_MS = 1000 / 240;

/** Speed (mm/step) below which a piece counts as at rest. */
const REST_SPEED = 4;

/** Number of constant-spacing points sampled along a wall for rendering. */
export const WALL_SAMPLES = WALL_NODES;

interface Node {
  body: MBody;
  restApp: { x: number; y: number };
  anchored: boolean;
}

export class FillSim {
  private engine = Engine.create();
  private rng = new Rng(1);
  private params!: FillParams;

  private product: MBody[] = [];
  private leftWall: Node[] = [];
  private rightWall: Node[] = [];
  private floorNodes: Node[] = [];
  private staticBodies: MBody[] = [];

  // Fill-run state.
  private queue = 0;
  private spawnTimer = 0;
  private running = false;
  private settled = false;
  private settleT = 0;
  private fillLine = 0;
  private status: SimStatus = "ready";

  // Cached geometry (app space, mm).
  private innerLen = 0;
  private usableHalfW = 0;
  private jawY = 0;
  private spawnY = 0;
  private tubeHalfW = 0;
  private productRadius = 6;

  // Analytic floor sag (mm, downward). The floor is a kinematic static chain
  // whose curve we drive from the resting load and the film's sag gain — this
  // gives robust support (a soft, spring-held floor collapses under real
  // gravity) while still deforming, matching the concept's feel.
  private sag = 0;
  private sagGain = 1;

  constructor() {
    this.engine.gravity.x = 0;
    // gravity.y/scale are tuned against SUBSTEP_MS for a brisk-but-stable fall
    // in a millimetre world (empirically: pieces rest without tunnelling, peak
    // impact ≈ 12 mm/step << product radius).
    this.engine.gravity.y = 1;
    this.engine.gravity.scale = 0.0015;
    (this.engine as unknown as { enableSleeping: boolean }).enableSleeping = false;
    // Extra solver iterations for stacking stability at 200 pieces.
    this.engine.positionIterations = 8;
    this.engine.velocityIterations = 6;
    this.engine.constraintIterations = 3;
  }

  // ---- app ⇄ matter space (mirror in y) ----
  private toM(app: { x: number; y: number }) {
    return { x: app.x, y: -app.y };
  }
  private appY(matterY: number) {
    return -matterY;
  }

  /** Rebuild the bag envelope for new params. Clears any in-flight fill. */
  build(params: FillParams): void {
    this.params = params;
    this.rng.reset(params.seed >>> 0);
    Composite.clear(this.engine.world, false, true);
    this.product = [];
    this.leftWall = [];
    this.rightWall = [];
    this.floorNodes = [];
    this.staticBodies = [];

    const st = clamp01(params.stiff / 100);
    const prof = params.style.simProfile(params.bag, {
      stiffNorm: st,
      wallNodes: WALL_NODES,
      floorNodes: FLOOR_NODES,
    });
    this.innerLen = prof.innerLen;
    this.usableHalfW = prof.usableHalfW;
    this.jawY = prof.innerLen;
    this.tubeHalfW = prof.usableHalfW * 0.78;
    const topFilm = this.jawY + params.bag.endSeal;
    this.spawnY = topFilm + Math.max(0, params.dropH);

    this.productRadius = Math.max(3, params.product.round ? params.product.w / 2 : Math.hypot(params.product.w, params.product.h) / 2 * 0.72);

    // Wall/floor node sizing so product cannot slip between nodes.
    const wallSpacing = prof.innerLen / (WALL_NODES - 1);
    const wallR = Math.max(2.5, wallSpacing * 0.62);
    const floorSpacing = (2 * prof.usableHalfW) / (FLOOR_NODES - 1);
    const floorR = Math.max(2.5, floorSpacing * 0.62);

    const restitution = 0.04 + 0.28 * st;

    const mkNode = (restApp: { x: number; y: number }, r: number, anchored: boolean): Node => {
      const m = this.toM(restApp);
      const body = anchored
        ? Bodies.circle(m.x, m.y, r, { isStatic: true, collisionFilter: NODE_FILTER })
        : Bodies.circle(m.x, m.y, r, {
            collisionFilter: NODE_FILTER,
            frictionAir: 0.08,
            restitution,
            friction: 0.4,
          });
      return { body, restApp, anchored };
    };

    // Build wall chains.
    const buildWall = (rest: { x: number; y: number }[], anchors: number[]): Node[] => {
      const nodes = rest.map((p, i) => mkNode(p, wallR, anchors.includes(i)));
      Composite.add(this.engine.world, nodes.map((n) => n.body));
      // Structural links between consecutive nodes.
      for (let i = 0; i < nodes.length - 1; i++) {
        this.link(nodes[i].body, nodes[i + 1].body, st, "wall");
      }
      // Return springs on free nodes toward their rest point.
      for (const n of nodes) {
        if (!n.anchored) this.returnSpring(n, st, "wall");
      }
      return nodes;
    };
    this.leftWall = buildWall(prof.leftWall, prof.anchoredWall);
    this.rightWall = buildWall(prof.rightWall, prof.anchoredWall);

    // Floor chain — all nodes static/kinematic; positions driven by updateFloor().
    const floor = prof.floor.map((p) => mkNode(p, floorR, true));
    Composite.add(this.engine.world, floor.map((n) => n.body));
    this.floorNodes = floor;
    // Sag gain: limp film sags more per unit load, stiff film stays planar.
    this.sagGain = 2.2 - 1.8 * st;

    // Catch floor well below the seal — a backstop so a rare tunnelling piece
    // is caught rather than lost to infinity. Never touched in normal fills.
    {
      const m = this.toM({ x: 0, y: -Math.max(40, params.bag.endSeal + 30) });
      const catcher = Bodies.rectangle(m.x, m.y, params.bag.bagW * 3, 8, {
        isStatic: true,
        collisionFilter: NODE_FILTER,
      });
      this.staticBodies.push(catcher);
    }

    // Forming tube: two static rails above the jaw plane.
    const tubeTop = this.spawnY + 20;
    const tubeH = tubeTop - this.jawY;
    for (const side of [-1, 1]) {
      const cxApp = side * this.tubeHalfW;
      const cyApp = this.jawY + tubeH / 2;
      const m = this.toM({ x: cxApp, y: cyApp });
      const rail = Bodies.rectangle(m.x, m.y, 4, tubeH, {
        isStatic: true,
        collisionFilter: NODE_FILTER,
        restitution: 0.2,
      });
      this.staticBodies.push(rail);
    }

    // Outer containment rails, well outside the max film billow, floor → tube
    // top. Untouched in normal fills; they keep overflow bulging on-screen
    // instead of spraying off laterally in the overfull error state.
    const outerX = params.bag.bagW / 2 + 25;
    const outerBot = -Math.max(40, params.bag.endSeal + 30);
    const outerTop = this.spawnY + 60; // above the spawn point — overflow can't climb over
    for (const side of [-1, 1]) {
      const m = this.toM({ x: side * outerX, y: (outerTop + outerBot) / 2 });
      this.staticBodies.push(
        Bodies.rectangle(m.x, m.y, 4, outerTop - outerBot, { isStatic: true, collisionFilter: NODE_FILTER }),
      );
    }
    Composite.add(this.engine.world, this.staticBodies);

    this.resetRun();
  }

  private link(a: MBody, b: MBody, st: number, kind: "wall" | "floor"): void {
    const stiffness = kind === "wall" ? 0.02 + 0.5 * st : 0.05 + 0.6 * st;
    Composite.add(
      this.engine.world,
      Constraint.create({
        bodyA: a,
        bodyB: b,
        stiffness,
        damping: 0.05 + 0.25 * st,
        length: dist(a.position, b.position),
      }),
    );
  }

  private returnSpring(n: Node, st: number, kind: "wall" | "floor"): void {
    const m = this.toM(n.restApp);
    // Floors sag more when film is limp (low gain); walls billow more when limp.
    const stiffness = kind === "wall" ? 0.008 + 0.09 * st : 0.006 + 0.05 * st;
    Composite.add(
      this.engine.world,
      Constraint.create({
        pointA: { x: m.x, y: m.y },
        bodyB: n.body,
        pointB: { x: 0, y: 0 },
        stiffness,
        damping: 0.1 + 0.2 * st,
        length: 0,
      }),
    );
  }

  private resetRun(): void {
    // Remove product bodies.
    for (const p of this.product) Composite.remove(this.engine.world, p);
    this.product = [];
    this.queue = 0;
    this.spawnTimer = 0;
    this.running = false;
    this.settled = false;
    this.settleT = 0;
    this.fillLine = 0;
    this.sag = 0;
    this.status = "ready";
    this.positionFloor();
  }

  /** Analytic floor height (app y, ≤ 0) at a lateral position x. */
  private floorAt(x: number): number {
    const t = Math.max(-1, Math.min(1, x / Math.max(1, this.usableHalfW)));
    return -this.sag * Math.cos((t * Math.PI) / 2);
  }

  /** Snap the kinematic floor nodes onto the current sag curve. */
  private positionFloor(): void {
    for (const n of this.floorNodes) {
      const app = { x: n.restApp.x, y: this.floorAt(n.restApp.x) };
      Body.setPosition(n.body, this.toM(app));
    }
  }

  private updateFloor(h: number): void {
    let resting = 0;
    for (const b of this.product) {
      if (Math.hypot(b.velocity.x, b.velocity.y) < REST_SPEED && this.appY(b.position.y) < this.jawY) resting++;
    }
    const sagTarget = Math.min(
      this.innerLen * 0.1,
      ((resting * this.params.unitWeight) / 50) * this.sagGain * 1.6,
    );
    this.sag += (sagTarget - this.sag) * Math.min(1, 3 * h);
    this.positionFloor();
  }

  /** Clear the current fill, keep the bag. */
  reset(): void {
    this.rng.reset(this.params.seed >>> 0);
    this.resetRun();
  }

  /** Begin dropping `count` pieces. */
  start(): void {
    this.reset();
    this.queue = this.params.count;
    this.running = true;
    this.status = "filling";
  }

  private spawn(): void {
    const p = this.params.product;
    const spread = Math.min(this.usableHalfW * 0.45, this.params.bag.bagW * 0.22);
    const app = {
      x: this.rng.spread(spread),
      y: this.spawnY + this.rng.range(0, 8),
    };
    const m = this.toM(app);
    const density = Math.max(1e-5, this.params.unitWeight * 4e-4);
    const common = {
      collisionFilter: PRODUCT_FILTER,
      friction: 0.35,
      frictionAir: 0.01,
      restitution: 0.05 + 0.2 * clamp01(this.params.stiff / 100),
      density,
    };
    let body: MBody | null = null;
    if (p.round) {
      body = Bodies.circle(m.x, m.y, Math.max(2, p.w / 2), common);
    } else if (p.hull && p.hull.length >= 3) {
      // STEP silhouette: a single convex polygon needs no decomposition.
      body = Bodies.fromVertices(m.x, m.y, [p.hull], common);
      // fromVertices returns an empty/degenerate body on failure → fall back.
      if (!body || !body.vertices || body.vertices.length < 3) body = null;
    }
    if (!body) {
      const r = Math.min(p.w, p.h) * 0.28;
      body = Bodies.rectangle(m.x, m.y, Math.max(2, p.w), Math.max(2, p.h), {
        ...common,
        chamfer: { radius: r },
      });
    }
    Body.setAngle(body, this.rng.range(0, Math.PI));
    // Gentle scatter, in mm/step / rad/step units.
    Body.setAngularVelocity(body, this.rng.spread(0.05));
    Body.setVelocity(body, { x: this.rng.spread(1.5), y: 0 });
    Composite.add(this.engine.world, body);
    this.product.push(body);
  }

  /** Advance one fixed substep (seconds). */
  fixedStep(h: number): void {
    if (this.running && this.queue > 0) {
      this.spawnTimer -= h;
      if (this.spawnTimer <= 0) {
        this.spawnTimer = 0.1;
        this.queue--;
        this.spawn();
      }
    }

    this.updateFloor(h);
    Engine.update(this.engine, SUBSTEP_MS);

    this.updateFillLine(h);
    this.updateStatus(h);
  }

  private updateFillLine(h: number): void {
    let top = 0;
    for (const b of this.product) {
      const ay = this.appY(b.position.y);
      if (ay < this.jawY + this.productRadius) {
        top = Math.max(top, ay + this.productRadius * 0.9);
      }
    }
    // Smooth toward the measured top.
    this.fillLine += (top - this.fillLine) * Math.min(1, 8 * h);
  }

  private updateStatus(h: number): void {
    const n = this.product.length;
    // Kinetic energy proxy for settle detection.
    let ke = 0;
    let resting = 0;
    for (const b of this.product) {
      const speed = Math.hypot(b.velocity.x, b.velocity.y);
      ke += speed * speed;
      if (speed < REST_SPEED && this.appY(b.position.y) < this.jawY) resting++;
    }
    const avg = n ? Math.sqrt(ke / n) : 0;

    const overfull = n > 0 && this.fillLine > this.innerLen;
    if (overfull) {
      this.status = "overfull";
    } else if (this.running) {
      this.status = "filling";
    } else if (this.settled) {
      this.status = "settled";
    } else {
      this.status = "ready";
    }

    if (this.running && this.queue === 0 && n > 0 && avg < 2) {
      this.settleT += h;
      if (this.settleT > 0.6) {
        this.running = false;
        this.settled = true;
        this.status = overfull ? "overfull" : "settled";
      }
    } else {
      this.settleT = 0;
    }
  }

  // ---- render/readout accessors ----

  wallPolyline(side: "left" | "right"): WallSample[] {
    const nodes = side === "left" ? this.leftWall : this.rightWall;
    return nodes.map((n) => ({ x: n.body.position.x, y: this.appY(n.body.position.y) }));
  }

  floorPolyline(): WallSample[] {
    return this.floorNodes.map((n) => ({ x: n.body.position.x, y: this.appY(n.body.position.y) }));
  }

  particles(): ParticleSample[] {
    const p = this.params.product;
    return this.product.map((b) => ({
      x: b.position.x,
      y: this.appY(b.position.y),
      angle: -b.angle,
      round: p.round,
      w: p.w,
      h: p.h,
      r: p.round ? p.w / 2 : 0,
      hull: p.hull,
    }));
  }

  measurements(): Measurements {
    const n = this.product.length;
    let resting = 0;
    for (const b of this.product) {
      if (Math.hypot(b.velocity.x, b.velocity.y) < REST_SPEED && this.appY(b.position.y) < this.jawY) resting++;
    }
    const st = clamp01(this.params.stiff / 100);
    const hs = headspaceOf(this.innerLen, this.fillLine);
    // Pile volume: usable channel cross-section over the fill height.
    const channelDepth = this.params.bag.bagW / Math.PI;
    const fillVolume = n > 0 ? 2 * this.usableHalfW * channelDepth * Math.max(0, this.fillLine) : 0;
    const mass = n * this.params.unitWeight;
    const bulkDensity = fillVolume > 0 ? mass / fillVolume : 0;
    const usable = usableBagVolume(this.params.bag.bagW, this.params.bag.bagL, this.params.bag.endSeal, st);
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
      jawY: this.jawY,
      spawnY: this.spawnY,
      tubeHalfW: this.tubeHalfW,
      productRadius: this.productRadius,
    };
  }

  get isActive(): boolean {
    return this.running || this.product.some((b) => Math.hypot(b.velocity.x, b.velocity.y) > 0.4);
  }

  get particleCount(): number {
    return this.product.length;
  }

  get world(): MComposite {
    return this.engine.world;
  }
}

// Collision filter categories.
const CAT_PRODUCT = 0x0001;
const CAT_NODE = 0x0002;
const PRODUCT_FILTER = { category: CAT_PRODUCT, mask: CAT_PRODUCT | CAT_NODE };
// Nodes collide only with product (never with each other), so overlapping node
// bodies form a continuous barrier without fighting their constraints.
const NODE_FILTER = { category: CAT_NODE, mask: CAT_PRODUCT };

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
