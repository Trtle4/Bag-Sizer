/**
 * 2-D convex hull utilities. Pure, DOM-free, unit tested.
 * Used to reduce a STEP point cloud's projection to a simple collision/render
 * silhouette (≤ N vertices), and reusable for the Phase 3 Rapier convex hull.
 */

export interface V2 {
  x: number;
  y: number;
}

function cross(o: V2, a: V2, b: V2): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Andrew's monotone chain. Returns CCW hull without the duplicated last point. */
export function convexHull(points: V2[]): V2[] {
  // Dedup (CAD clouds have many coincident points) and sort.
  const key = (p: V2) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`;
  const seen = new Set<string>();
  const pts: V2[] = [];
  for (const p of points) {
    const k = key(p);
    if (!seen.has(k)) {
      seen.add(k);
      pts.push(p);
    }
  }
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;

  const lower: V2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: V2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Reduce a hull to at most `max` vertices by repeatedly dropping the vertex
 * whose removal changes the area least (smallest ear triangle). Keeps overall
 * shape; guarantees a simple convex polygon out.
 */
export function simplifyHull(hull: V2[], max: number): V2[] {
  const out = hull.slice();
  while (out.length > max) {
    let bestI = 0;
    let bestArea = Infinity;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const area = Math.abs(cross(a, b, c)) / 2;
      if (area < bestArea) {
        bestArea = area;
        bestI = i;
      }
    }
    out.splice(bestI, 1);
  }
  return out;
}

export function centroid(poly: V2[]): V2 {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

/** Translate a polygon so its centroid is at the origin. */
export function center(poly: V2[]): V2[] {
  const c = centroid(poly);
  return poly.map((p) => ({ x: p.x - c.x, y: p.y - c.y }));
}

/** Axis-aligned extent of a polygon. */
export function bounds(poly: V2[]): { w: number; h: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { w: maxX - minX, h: maxY - minY };
}
