import { describe, it, expect } from "vitest";
import { convexHull, simplifyHull, center, bounds, type V2 } from "../src/geometry/hull.js";

describe("convex hull", () => {
  it("drops interior points", () => {
    const pts: V2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 6 },
      { x: 0, y: 6 },
      { x: 5, y: 3 }, // interior
      { x: 2, y: 2 }, // interior
    ];
    const h = convexHull(pts);
    expect(h).toHaveLength(4);
    expect(bounds(h)).toEqual({ w: 10, h: 6 });
  });

  it("handles duplicate points", () => {
    const pts: V2[] = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ];
    expect(convexHull(pts)).toHaveLength(4);
  });

  it("simplifies a polygon down to the vertex cap", () => {
    // A 32-gon approximating a circle.
    const poly: V2[] = Array.from({ length: 32 }, (_, i) => {
      const a = (i / 32) * Math.PI * 2;
      return { x: Math.cos(a) * 10, y: Math.sin(a) * 10 };
    });
    const simplified = simplifyHull(poly, 16);
    expect(simplified.length).toBe(16);
    // Still roughly circular (bounds preserved within a vertex-drop tolerance).
    const b = bounds(simplified);
    expect(b.w).toBeGreaterThan(18);
    expect(b.h).toBeGreaterThan(18);
  });

  it("centres a polygon on its centroid", () => {
    const centred = center([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 6 },
      { x: 0, y: 6 },
    ]);
    const cx = centred.reduce((s, p) => s + p.x, 0) / centred.length;
    const cy = centred.reduce((s, p) => s + p.y, 0) / centred.length;
    expect(cx).toBeCloseTo(0, 6);
    expect(cy).toBeCloseTo(0, 6);
  });
});
