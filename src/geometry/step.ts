/**
 * ASCII STEP (ISO 10303-21) import — fast path.
 *
 * We do not attempt to evaluate the B-rep. We scan for CARTESIAN_POINT
 * entities, accumulate their coordinates into an axis-aligned bounding box,
 * and report the point count. The three box extents, sorted descending, become
 * the product envelope (l ≥ w ≥ h).
 *
 * Pure and DOM-free so it can be unit tested against a fixture file.
 * (Phase 2 adds a projected 2-D silhouette from the same point cloud.)
 */

import { convexHull, simplifyHull, center, type V2 } from "./hull.js";

/** Max vertices in the projected silhouette (also the Phase 3 Rapier hull cap). */
export const SILHOUETTE_MAX_VERTS = 16;

export interface StepParseResult {
  ok: boolean;
  /** Sorted descending: length ≥ width ≥ height, in the file's native units (assumed mm). */
  dims: { l: number; w: number; h: number };
  /** Number of CARTESIAN_POINT entities found. */
  pointCount: number;
  /** Raw min/max bounds in file axis order (x, y, z). */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /**
   * Projected 2-D silhouette: convex hull of the XZ projection, simplified to
   * ≤ SILHOUETTE_MAX_VERTS vertices, centred at the origin (mm). x = file X,
   * y = file Z. Used as the collision body and rendered shape so an oddly
   * shaped part fills more honestly than its bounding box.
   */
  silhouette: V2[];
  /** Human-readable failure reason when ok === false. */
  error?: string;
}

const CARTESIAN_POINT =
  /CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(\s*([-\d.Ee+]+)\s*,\s*([-\d.Ee+]+)\s*,\s*([-\d.Ee+]+)/g;

export function parseStepBBox(text: string): StepParseResult {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let n = 0;
  const xz: V2[] = []; // XZ projection for the silhouette

  // Reset lastIndex — the regex is module-scoped and stateful with the g flag.
  CARTESIAN_POINT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CARTESIAN_POINT.exec(text))) {
    const coords = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (coords.some((c) => !Number.isFinite(c))) continue;
    for (let i = 0; i < 3; i++) {
      if (coords[i] < min[i]) min[i] = coords[i];
      if (coords[i] > max[i]) max[i] = coords[i];
    }
    xz.push({ x: coords[0], y: coords[2] });
    n++;
  }

  if (n === 0) {
    return {
      ok: false,
      dims: { l: 0, w: 0, h: 0 },
      pointCount: 0,
      bounds: { min, max },
      silhouette: [],
      error: "No CARTESIAN_POINT entities found — is this an ASCII STEP file?",
    };
  }

  const extents = [max[0] - min[0], max[1] - min[1], max[2] - min[2]].sort((a, b) => b - a);
  return {
    ok: true,
    dims: { l: extents[0], w: extents[1], h: extents[2] },
    pointCount: n,
    bounds: { min, max },
    silhouette: buildSilhouette(xz, min, max),
  };
}

/** Convex hull of the XZ projection, simplified and centred; bbox fallback. */
function buildSilhouette(
  xz: V2[],
  min: [number, number, number],
  max: [number, number, number],
): V2[] {
  const hull = simplifyHull(convexHull(xz), SILHOUETTE_MAX_VERTS);
  if (hull.length >= 3) return center(hull);
  // Degenerate projection (collinear/too few) → fall back to the XZ bbox.
  const w = (max[0] - min[0]) / 2;
  const h = (max[2] - min[2]) / 2;
  return [
    { x: -w, y: -h },
    { x: w, y: -h },
    { x: w, y: h },
    { x: -w, y: h },
  ];
}
