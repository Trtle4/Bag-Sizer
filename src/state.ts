/**
 * Single application store — plain TypeScript, framework-free.
 *
 * Holds all user inputs plus view flags. Consumers subscribe for change
 * notifications; the main loop and renderers read derived geometry through the
 * pure helpers here (which delegate to src/geometry).
 */

import { resolveFillCount, weightForPieces, stiffLabel, fmt } from "./geometry/index.js";
import type { BagStyleId } from "./bagstyles/index.js";
import type { ProductSpec } from "./physics/world.js";

export type ShapeId = "round" | "square" | "step";
export type FillMode = "count" | "weight";
export type ViewId = "fill" | "dieline";

export interface AppState {
  shape: ShapeId;
  pDia: number;
  pThk: number;
  pL: number;
  pW: number;
  pH: number;
  stepDims: { l: number; w: number; h: number } | null;
  stepName: string | null;
  /** Centred XZ silhouette polygon (mm) from the STEP point cloud. */
  stepHull: { x: number; y: number }[] | null;
  pWt: number;

  mode: FillMode;
  nCount: number;
  nWt: number;
  dropH: number;

  style: BagStyleId;
  bagW: number;
  bagL: number;
  endSeal: number;
  finSeal: number;
  /** Gusset depth (mm) for gusseted (side) / SUP (bottom) styles; ignored by pillow. */
  gusset: number;

  stiff: number;

  /** Advisory: minimum acceptable settled headspace (mm). */
  minHeadspace: number;
  /** Safety: fill must stay at least this far below the seal-jaw plane (mm). */
  jawClearance: number;

  view: ViewId;
  camera: "iso" | "front" | "side";
  showDims: boolean;

  seed: number;
  deterministic: boolean;
}

export const initialState: AppState = {
  shape: "round",
  pDia: 30,
  pThk: 12,
  pL: 30,
  pW: 22,
  pH: 14,
  stepDims: null,
  stepName: null,
  stepHull: null,
  pWt: 8.0,

  mode: "count",
  nCount: 18,
  nWt: 150,
  dropH: 250,

  style: "pillow",
  bagW: 140,
  bagL: 230,
  endSeal: 10,
  finSeal: 10,
  gusset: 55,

  stiff: 40,

  minHeadspace: 30,
  jawClearance: 30,

  view: "fill",
  camera: "iso",
  showDims: true,

  seed: 1,
  deterministic: true,
};

type Listener = (s: AppState) => void;

export class Store {
  private state: AppState;
  private listeners = new Set<Listener>();

  constructor(init: AppState = initialState) {
    this.state = { ...init };
  }

  get(): Readonly<AppState> {
    return this.state;
  }

  set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

// ---- derived selectors (pure) ----

export interface ProdDims extends ProductSpec {
  label: string;
}

/** Front-view product dimensions + label for the current shape. */
export function prodDims(s: AppState): ProdDims {
  if (s.shape === "round") {
    // Disc: width = depth = diameter, height = thickness.
    return { w: s.pDia, h: s.pThk, depth: s.pDia, round: true, label: `⌀${fmt(s.pDia)} × ${fmt(s.pThk)}` };
  }
  const d = s.shape === "step" && s.stepDims ? s.stepDims : { l: s.pL, w: s.pW, h: s.pH };
  const hull = s.shape === "step" && s.stepHull ? s.stepHull : undefined;
  return {
    w: d.l,
    h: d.h,
    depth: d.w,
    round: false,
    hull,
    label: `${fmt(d.l)} × ${fmt(d.w)} × ${fmt(d.h)}`,
  };
}

export function fillCount(s: AppState): number {
  return resolveFillCount({
    mode: s.mode,
    count: s.nCount,
    targetWeight: s.nWt,
    unitWeight: s.pWt,
  });
}

export function fillWeight(s: AppState): number {
  return weightForPieces(fillCount(s), s.pWt);
}

export function filmLabel(s: AppState): string {
  return `${s.stiff} · ${stiffLabel(s.stiff)}`;
}
