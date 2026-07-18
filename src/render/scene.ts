/**
 * Three.js renderer for the live 3-D fill view.
 *
 * Scene units are millimetres (matching the sim's app space). Product is drawn
 * with an InstancedMesh (one draw call for up to 200 pieces); the film shell is
 * a translucent box with a sagging floor and a wireframe forming tube. The
 * transparent WebGL canvas sits over the design-system drafting backdrop.
 *
 * Cameras: a ¾ perspective (orbitable) default plus orthographic front/side
 * presets so the dimension overlay reads like an engineering drawing.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { FillSim, ProductSpec, ShellState } from "../physics/world.js";
import { simplifyHull } from "../geometry/hull.js";

export type CameraMode = "iso" | "front" | "side";
const MAX_INSTANCES = 200;

// Design-system colours.
const COL_PRODUCT = 0xc89468;
const COL_FILM = 0x8fa0a8;
const COL_INK2 = 0x59656c;
const COL_GRID = 0xdbe1e6;

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
  private filmMesh: THREE.Mesh;
  private filmEdges: THREE.LineSegments;
  private floorMesh: THREE.Mesh;
  private tube: THREE.LineSegments;
  private grid: THREE.GridHelper;

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

    // Floor reference grid.
    this.grid = new THREE.GridHelper(600, 24, COL_GRID, COL_GRID);
    (this.grid.material as THREE.Material).opacity = 0.5;
    (this.grid.material as THREE.Material).transparent = true;
    this.scene.add(this.grid);

    // Product instanced mesh (geometry swapped per shape in setProduct()).
    this.productGeo = new THREE.CylinderGeometry(15, 15, 12, 20);
    const productMat = new THREE.MeshStandardMaterial({ color: COL_PRODUCT, roughness: 0.72, metalness: 0.04 });
    this.product = new THREE.InstancedMesh(this.productGeo, productMat, MAX_INSTANCES);
    this.product.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.product.count = 0;
    this.scene.add(this.product);

    // Film shell.
    this.filmMesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        color: COL_FILM,
        transparent: true,
        opacity: 0.1,
        side: THREE.DoubleSide,
        depthWrite: false,
        roughness: 1,
      }),
    );
    this.filmEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: COL_INK2, transparent: true, opacity: 0.5 }),
    );
    this.floorMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1, 16, 3),
      new THREE.MeshStandardMaterial({ color: COL_FILM, transparent: true, opacity: 0.28, side: THREE.DoubleSide, roughness: 1 }),
    );
    this.tube = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0xb7c1c7, transparent: true, opacity: 0.7 }),
    );
    this.shellGroup.add(this.filmMesh, this.filmEdges, this.floorMesh, this.tube);
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
  frame(env: { innerLen: number; usableHalfW: number; usableHalfD: number; spawnY: number }): void {
    const cy = env.innerLen * 0.42;
    this.target.set(0, cy, 0);
    const reach = Math.max(env.usableHalfW * 2, env.innerLen) * 1.5 + 120;
    this.persp.position.set(reach * 0.62, cy + env.innerLen * 0.55, reach * 0.82);
    this.controls.target.copy(this.target);
    this.grid.position.y = 0;
    this.grid.scale.setScalar(Math.max(1, (env.usableHalfW * 2 + 200) / 600));
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
    const shell = sim.shell();
    this.updateShell(shell);

    const transforms = sim.particleTransforms();
    const n = Math.min(transforms.length, MAX_INSTANCES);
    for (let i = 0; i < n; i++) {
      const t = transforms[i];
      this.dummy.position.set(t.x, t.y, t.z);
      this.dummy.quaternion.set(t.q.x, t.q.y, t.q.z, t.q.w);
      this.dummy.updateMatrix();
      this.product.setMatrixAt(i, this.dummy.matrix);
    }
    this.product.count = n;
    this.product.instanceMatrix.needsUpdate = true;

    if (this.mode === "iso") this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private updateShell(s: ShellState): void {
    // Film box + edges (walls), centred over the fill zone.
    this.filmMesh.scale.set(2 * s.halfW, s.innerLen, 2 * s.halfD);
    this.filmMesh.position.set(0, s.innerLen / 2, 0);
    this.filmEdges.scale.copy(this.filmMesh.scale);
    this.filmEdges.position.copy(this.filmMesh.position);

    // Sagging floor plane.
    const geo = this.floorMesh.geometry as THREE.PlaneGeometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const u = pos.getX(i); // -0.5..0.5
      const v = pos.getY(i);
      const x = u * 2 * s.halfW;
      const z = v * 2 * s.halfD;
      const t = Math.max(-1, Math.min(1, x / Math.max(1, s.halfW)));
      pos.setXYZ(i, x, -s.sag * Math.cos((t * Math.PI) / 2), z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    // Forming tube wireframe.
    const tubeH = s.spawnY + 20 - s.jawY;
    this.tube.scale.set(2 * s.tubeHalfW, tubeH, 2 * s.tubeHalfD);
    this.tube.position.set(0, s.jawY + tubeH / 2, 0);
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
