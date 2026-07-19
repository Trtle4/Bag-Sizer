/**
 * Three.js renderer for the live 3-D fill view.
 *
 * Scene units are millimetres (matching the sim's app space). Product is drawn
 * with an InstancedMesh (one draw call for up to 200 pieces); the film shell is
 * a lofted pillow body (pinched sealed bottom, rounded belly, open mouth) with a
 * round forming tube + hopper funnel above. The transparent WebGL canvas sits
 * over the design-system drafting backdrop.
 *
 * Cameras: a ¾ perspective (orbitable) default plus orthographic front/side
 * presets so the dimension overlay reads like an engineering drawing.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { FillSim, ProductSpec, LiveShell } from "../physics/world.js";
import { simplifyHull } from "../geometry/hull.js";

export type CameraMode = "iso" | "front" | "side";
const MAX_INSTANCES = 200;

// Design-system colours.
const COL_PRODUCT = 0xc89468;
const COL_FILM = 0x8fa0a8;
const COL_INK2 = 0x59656c;

export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private persp: THREE.PerspectiveCamera;
  private ortho: THREE.OrthographicCamera;
  private controls: OrbitControls;
  private mode: CameraMode = "iso";

  private product: THREE.InstancedMesh;
  private productGeo: THREE.BufferGeometry;
  private dummy = new THREE.Object3D();

  private shellGroup = new THREE.Group();
  private pillow: THREE.Mesh; // lofted pillow film body (rebuilt per bag)
  private pillowEdges: THREE.LineSegments;
  private seal: THREE.Mesh; // pinched, hatched bottom end seal
  private tube: THREE.Mesh;
  private tubeEdges: THREE.LineSegments;
  private funnel: THREE.Mesh;
  private funnelEdges: THREE.LineSegments;

  // Cache so the (per-frame) formed shell only rebuilds when it moves materially.
  private shellKey = "";

  private target = new THREE.Vector3(0, 100, 0);

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    Object.assign(this.renderer.domElement.style, { position: "absolute", inset: "0", width: "100%", height: "100%" });

    const { clientWidth: w, clientHeight: h } = container;
    this.persp = new THREE.PerspectiveCamera(38, w / Math.max(1, h), 1, 20000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 20000);

    this.controls = new OrbitControls(this.persp, this.renderer.domElement);
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.controls.enableDamping = !reduceMotion;
    this.controls.dampingFactor = 0.12;

    // Lights — restrained, no ambient glow.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xc7ced3, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(0.4, 1, 0.7);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-0.6, 0.4, -0.5);
    this.scene.add(fill);

    // No floor grid: the product rests on the bag's own pinched bottom seal, not
    // an infinite ground plane. A reference grid read as a large flat surface
    // extending past the bag footprint, so it is intentionally omitted.

    // Product instanced mesh (geometry swapped per shape in setProduct()).
    this.productGeo = new THREE.CylinderGeometry(15, 15, 12, 20);
    const productMat = new THREE.MeshStandardMaterial({ color: COL_PRODUCT, roughness: 0.72, metalness: 0.04 });
    this.product = new THREE.InstancedMesh(this.productGeo, productMat, MAX_INSTANCES);
    this.product.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.product.count = 0;
    this.scene.add(this.product);

    // Pillow film body — a lofted pillow profile (pinched sealed bottom, rounded
    // belly, open mouth), geometry rebuilt per bag in setShell().
    this.pillow = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({
        color: COL_FILM,
        transparent: true,
        opacity: 0.2,
        side: THREE.DoubleSide,
        depthWrite: false,
        roughness: 1,
      }),
    );
    this.pillowEdges = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: COL_INK2, transparent: true, opacity: 0.55 }),
    );
    // Bottom end seal — a flat, pinched, hatched strip at the base.
    this.seal = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: COL_INK2, transparent: true, opacity: 0.28, side: THREE.DoubleSide }),
    );
    // Round forming tube — open-ended translucent cylinder, scaled per build.
    this.tube = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 40, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0xb7c1c7,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
        roughness: 0.9,
        metalness: 0,
      }),
    );
    this.tubeEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.CylinderGeometry(1, 1, 1, 40, 1, true)),
      new THREE.LineBasicMaterial({ color: 0x9aa6ad, transparent: true, opacity: 0.5 }),
    );
    // Hopper funnel — geometry rebuilt per bag in setFormer().
    this.funnel = new THREE.Mesh(
      new THREE.CylinderGeometry(2, 1, 1, 40, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0xb7c1c7,
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
        roughness: 0.9,
        metalness: 0,
      }),
    );
    this.funnelEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.CylinderGeometry(2, 1, 1, 40, 1, true)),
      new THREE.LineBasicMaterial({ color: 0x9aa6ad, transparent: true, opacity: 0.45 }),
    );
    this.shellGroup.add(
      this.pillow,
      this.pillowEdges,
      this.seal,
      this.tube,
      this.tubeEdges,
      this.funnel,
      this.funnelEdges,
    );
    this.scene.add(this.shellGroup);

    this.resize();
  }

  /** Swap the instanced product geometry for the current shape/dims. */
  setProduct(spec: ProductSpec): void {
    this.productGeo.dispose();
    this.productGeo = buildProductGeometry(spec);
    this.product.geometry = this.productGeo;
  }

  /** Frame the camera for a new bag envelope. */
  frame(env: {
    innerLen: number;
    usableHalfW: number;
    usableHalfD: number;
    flatHalfW: number;
    endSeal: number;
    jawY: number;
    tubeLen: number;
  }): void {
    this.setFormer(env);
    // Start from the empty (near lay-flat) formed shell; draw() bulges it live.
    this.buildShell({
      innerLen: env.innerLen,
      endSeal: env.endSeal,
      jawY: env.jawY,
      flatHalfW: env.flatHalfW,
      bellyHalfW: env.flatHalfW,
      bellyHalfD: 0.5,
      fillLine: 0,
      roundness: 0,
      tubeLen: env.tubeLen,
    }, 0, 0, 0);
    // Aim at the bag body (not the tall former) and keep the camera fairly level
    // so we look INTO the bag — a steep top-down angle makes product resting at
    // the back-bottom read as if it were below the transparent front film.
    const cy = env.innerLen * 0.45;
    this.target.set(0, cy, 0);
    const reach = Math.max(env.usableHalfW * 2, env.innerLen) * 1.5 + 160;
    this.persp.position.set(reach * 0.7, cy + env.innerLen * 0.28, reach * 0.72);
    this.controls.target.copy(this.target);
    this.setCamera(this.mode, env);
  }

  setCamera(mode: CameraMode, env?: { innerLen: number; usableHalfW: number; usableHalfD: number }): void {
    this.mode = mode;
    if (mode === "iso") {
      this.controls.enabled = true;
      return;
    }
    this.controls.enabled = false;
    if (!env) return;
    const cy = env.innerLen * 0.5;
    this.target.set(0, cy, 0);
    const dist = 6000;
    if (mode === "front") this.ortho.position.set(0, cy, dist);
    else this.ortho.position.set(dist, cy, 0);
    this.ortho.up.set(0, 1, 0);
    this.ortho.lookAt(this.target);
    this.fitOrtho(env);
  }

  private fitOrtho(env: { innerLen: number; usableHalfW: number; usableHalfD: number }): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    const halfAcross = (this.mode === "front" ? env.usableHalfW : env.usableHalfD) + 70;
    const halfUp = env.innerLen * 0.62 + 40;
    const aspect = w / Math.max(1, h);
    let vx = halfAcross;
    let vy = halfUp;
    if (vx / vy > aspect) vy = vx / aspect;
    else vx = vy * aspect;
    this.ortho.left = -vx;
    this.ortho.right = vx;
    this.ortho.top = vy;
    this.ortho.bottom = -vy;
    this.ortho.updateProjectionMatrix();
  }

  get camera(): THREE.Camera {
    return this.mode === "iso" ? this.persp : this.ortho;
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / Math.max(1, h);
    this.persp.updateProjectionMatrix();
  }

  /** Update all dynamic geometry from the sim and render one frame. */
  draw(sim: FillSim): void {
    const transforms = sim.particleTransforms();
    const n = Math.min(transforms.length, MAX_INSTANCES);
    let maxAbsX = 0;
    let maxAbsZ = 0;
    let maxY = 0;
    for (let i = 0; i < n; i++) {
      const t = transforms[i];
      this.dummy.position.set(t.x, t.y, t.z);
      this.dummy.quaternion.set(t.q.x, t.q.y, t.q.z, t.q.w);
      this.dummy.updateMatrix();
      this.product.setMatrixAt(i, this.dummy.matrix);
      maxAbsX = Math.max(maxAbsX, Math.abs(t.x));
      maxAbsZ = Math.max(maxAbsZ, Math.abs(t.z));
      maxY = Math.max(maxY, t.y);
    }
    this.product.count = n;
    this.product.instanceMatrix.needsUpdate = true;

    // Bulge the film to the live formed section, but never inside the actual
    // product extent — the belly is clamped to enclose every piece so nothing
    // can poke through the visible shell.
    this.buildShell(sim.liveShell(), maxAbsX, maxAbsZ, maxY);

    if (this.mode === "iso") this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * (Re)build the pillow film body to the live FORMED cross-section: pinched flat
   * at the sealed bottom, bulging to the perimeter-conserved belly where product
   * sits, tapering back toward the open mouth. The belly is clamped to enclose the
   * actual product extent (maxAbsX/Z, maxY) so nothing pokes through the film.
   * Rebuilds only when the profile moves materially (per-frame-cheap).
   */
  private buildShell(shell: LiveShell, maxAbsX: number, maxAbsZ: number, maxY: number): void {
    const MARG = 3; // film clearance outside the product (mm)
    const bellyHalfW = Math.max(shell.bellyHalfW, maxAbsX + MARG);
    const bellyHalfD = Math.max(shell.bellyHalfD, maxAbsZ + MARG, 0.5);
    const bellyTop = Math.max(shell.fillLine, maxY + MARG, 0);

    const q = (v: number) => Math.round(v * 2) / 2; // 0.5 mm quantum
    const key = [
      q(shell.flatHalfW), q(bellyHalfW), q(bellyHalfD), q(bellyTop),
      q(shell.innerLen), q(shell.endSeal),
    ].join(":");
    if (key === this.shellKey) return;
    this.shellKey = key;

    const { geometry, edges } = buildPillowGeometry({
      flatHalfW: shell.flatHalfW,
      bellyHalfW,
      bellyHalfD,
      innerLen: shell.innerLen,
      endSeal: shell.endSeal,
      bellyTop,
    });
    this.pillow.geometry.dispose();
    this.pillow.geometry = geometry;
    (this.pillowEdges.geometry as THREE.BufferGeometry).dispose();
    this.pillowEdges.geometry = edges;

    // Bottom end seal: a flat, pinched strip at the full-width sealed base.
    this.seal.geometry.dispose();
    this.seal.geometry = new THREE.PlaneGeometry(shell.flatHalfW * 1.2, Math.max(4, shell.endSeal));
    this.seal.position.set(0, -shell.endSeal / 2, 0);
  }

  /**
   * The forming tube is the bag-mouth ellipse extended straight up above the jaw
   * to the release height — sized to the bag, not a narrow throat — so product is
   * shown dropping across the full width. Rendered by scaling the unit cylinder
   * to (usableHalfW × tubeLen × usableHalfD). No hopper funnel.
   */
  private setFormer(cfg: {
    jawY: number;
    tubeLen: number;
    usableHalfW: number;
    usableHalfD: number;
  }): void {
    this.tube.scale.set(cfg.usableHalfW, cfg.tubeLen, cfg.usableHalfD);
    this.tube.position.set(0, cfg.jawY + cfg.tubeLen / 2, 0);
    this.tubeEdges.scale.copy(this.tube.scale);
    this.tubeEdges.position.copy(this.tube.position);
    this.funnel.visible = false;
    this.funnelEdges.visible = false;
  }

  dispose(): void {
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/** Build product geometry matching the collider for a shape. Centred at origin. */
function buildProductGeometry(spec: ProductSpec): THREE.BufferGeometry {
  if (spec.round) {
    return new THREE.CylinderGeometry(spec.w / 2, spec.w / 2, spec.h, 24);
  }
  if (spec.hull && spec.hull.length >= 3) {
    const sil = simplifyHull(spec.hull, 8);
    const shape = new THREE.Shape();
    sil.forEach((v, i) => (i === 0 ? shape.moveTo(v.x, v.y) : shape.lineTo(v.x, v.y)));
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: spec.h, bevelEnabled: false });
    geo.translate(0, 0, -spec.h / 2);
    geo.rotateX(-Math.PI / 2); // shape XY (=XZ silhouette) extruded Z → up Y
    geo.center();
    return geo;
  }
  return new THREE.BoxGeometry(spec.w, spec.h, spec.depth);
}

/**
 * Loft a pillow film body to the FORMED cross-section. Width/depth vary by height:
 * a full-width flat weld at the sealed bottom, rising to the perimeter-conserved
 * belly (bellyHalfW × bellyHalfD) where product rests, then tapering back toward a
 * flatter, wider open mouth above the fill line. Returns surface + edge wireframe.
 *
 * The belly dims already enclose the real product extent (clamped by the caller),
 * so the film never clips a piece.
 */
function buildPillowGeometry(p: {
  flatHalfW: number;
  bellyHalfW: number;
  bellyHalfD: number;
  innerLen: number;
  endSeal: number;
  bellyTop: number; // top of the filled belly region (mm)
}): { geometry: THREE.BufferGeometry; edges: THREE.BufferGeometry } {
  const LEVELS = 30;
  const SEG = 32;
  const smooth = (x: number) => {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
  };
  const { flatHalfW, bellyHalfW, bellyHalfD, innerLen, endSeal } = p;
  const bellyTop = Math.min(p.bellyTop, innerLen);
  const y0 = -endSeal;
  const y1 = innerLen;
  const SEAL_D = 0.4; // near-zero depth of the flat bottom weld (mm)
  // Absolute half-width/half-depth of the film at height y.
  const scaleAt = (y: number): { w: number; d: number } => {
    if (y <= 0) {
      // Sealed strip: flat full-width weld (y0) rounding up to the belly (y=0).
      const f = smooth((y - y0) / Math.max(1, endSeal));
      return { w: flatHalfW + (bellyHalfW - flatHalfW) * f, d: SEAL_D + (bellyHalfD - SEAL_D) * f };
    }
    if (y <= bellyTop || bellyTop <= 0) {
      // Belly: full formed section where product rests.
      return { w: bellyHalfW, d: bellyHalfD };
    }
    // Above the fill line the film is unloaded: it relaxes back toward a flatter,
    // wider open mouth (depth thins, width opens toward the lay-flat width).
    const f = smooth((y - bellyTop) / Math.max(1, innerLen - bellyTop));
    const w = bellyHalfW + (Math.max(flatHalfW * 0.92, bellyHalfW) - bellyHalfW) * f;
    const d = bellyHalfD + (Math.max(0.6, bellyHalfD * 0.3) - bellyHalfD) * f;
    return { w, d };
  };

  const rings: THREE.Vector3[][] = [];
  for (let i = 0; i <= LEVELS; i++) {
    const y = y0 + (i / LEVELS) * (y1 - y0);
    const s = scaleAt(y);
    const hw = s.w;
    const hd = s.d;
    const ring: THREE.Vector3[] = [];
    for (let j = 0; j < SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      ring.push(new THREE.Vector3(hw * Math.cos(a), y, hd * Math.sin(a)));
    }
    rings.push(ring);
  }

  const verts: number[] = [];
  for (const ring of rings) for (const p of ring) verts.push(p.x, p.y, p.z);
  const vid = (i: number, j: number) => i * SEG + (j % SEG);
  const idx: number[] = [];
  for (let i = 0; i < LEVELS; i++) {
    for (let j = 0; j < SEG; j++) {
      idx.push(vid(i, j), vid(i + 1, j), vid(i, j + 1));
      idx.push(vid(i, j + 1), vid(i + 1, j), vid(i + 1, j + 1));
    }
  }
  // Pinched bottom cap (fan to the seal line) → looks sealed/closed.
  const centre = verts.length / 3;
  verts.push(0, y0, 0);
  for (let j = 0; j < SEG; j++) idx.push(vid(0, j + 1), centre, vid(0, j));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geometry.setIndex(idx);
  geometry.computeVertexNormals();

  // Edge wireframe: a few horizontal rings + vertical seams.
  const ep: number[] = [];
  const seg = (p: THREE.Vector3, q: THREE.Vector3) => ep.push(p.x, p.y, p.z, q.x, q.y, q.z);
  for (const lvl of [0, Math.round(LEVELS * 0.4), Math.round(LEVELS * 0.7), LEVELS]) {
    for (let j = 0; j < SEG; j++) seg(rings[lvl][j], rings[lvl][(j + 1) % SEG]);
  }
  for (const j of [0, SEG / 4, SEG / 2, (3 * SEG) / 4]) {
    for (let i = 0; i < LEVELS; i++) seg(rings[i][j], rings[i + 1][j]);
  }
  const edges = new THREE.BufferGeometry();
  edges.setAttribute("position", new THREE.Float32BufferAttribute(ep, 3));

  return { geometry, edges };
}
