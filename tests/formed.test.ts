import { describe, it, expect } from "vitest";
import {
  ellipseCircumference,
  formedSection,
  formedArea,
  roundnessFromFill,
} from "../src/geometry/formed.js";

describe("ellipseCircumference (Ramanujan II)", () => {
  it("is exact for a circle (a = b)", () => {
    const r = 20;
    expect(ellipseCircumference(r, r)).toBeCloseTo(2 * Math.PI * r, 6);
  });

  it("degenerates to ~4a for a flat sliver (b → 0)", () => {
    // A fully collapsed ellipse traces its long axis out and back = 4a.
    // Ramanujan II is an approximation here (~0.04% low), so allow a small band.
    expect(ellipseCircumference(50, 0)).toBeGreaterThan(199);
    expect(ellipseCircumference(50, 0)).toBeLessThanOrEqual(200);
  });

  it("is zero for a degenerate point", () => {
    expect(ellipseCircumference(0, 0)).toBe(0);
  });
});

describe("formedSection — perimeter conservation", () => {
  const flatHalfW = 60;
  const C = 4 * flatHalfW; // conserved film circumference

  it("lay-flat at roundness 0 (full width, ~zero depth)", () => {
    const s = formedSection(flatHalfW, 0);
    expect(s.halfW).toBeCloseTo(flatHalfW, 1);
    expect(s.halfD).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it("fully round at roundness 1 (a = b = C/2π, width pulled in)", () => {
    const s = formedSection(flatHalfW, 1);
    const r = C / (2 * Math.PI);
    expect(s.halfW).toBeCloseTo(r, 1);
    expect(s.halfD).toBeCloseTo(r, 1);
    // Rounding trades width for depth — narrower than lay-flat.
    expect(s.halfW).toBeLessThan(flatHalfW);
  });

  it("conserves the film circumference at every roundness", () => {
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const s = formedSection(flatHalfW, t);
      expect(ellipseCircumference(s.halfW, s.halfD)).toBeCloseTo(C, 0);
    }
  });

  it("depth grows monotonically and width shrinks monotonically with roundness", () => {
    let prevD = -1;
    let prevW = Infinity;
    for (const t of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const s = formedSection(flatHalfW, t);
      expect(s.halfD).toBeGreaterThanOrEqual(prevD);
      expect(s.halfW).toBeLessThanOrEqual(prevW + 1e-6);
      prevD = s.halfD;
      prevW = s.halfW;
    }
  });

  it("can never bulge past the fully-round cross-section area", () => {
    const round = formedArea(formedSection(flatHalfW, 1));
    for (const t of [0.2, 0.5, 0.8, 1]) {
      expect(formedArea(formedSection(flatHalfW, t))).toBeLessThanOrEqual(round + 1e-6);
    }
  });
});

describe("roundnessFromFill", () => {
  const base = { flatHalfW: 60, innerLen: 200, stiffNorm: 0.5, packing: 0.6 };

  it("is zero for an empty bag", () => {
    expect(roundnessFromFill({ ...base, productVolume: 0 })).toBe(0);
  });

  it("increases monotonically with product volume", () => {
    let prev = -1;
    for (const v of [0, 1e5, 3e5, 6e5, 1e6, 2e6]) {
      const r = roundnessFromFill({ ...base, productVolume: v });
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });

  it("saturates at 1 (a pillow cannot round past fully round)", () => {
    expect(roundnessFromFill({ ...base, productVolume: 1e9 })).toBe(1);
  });

  it("stiff film holds a rounder section than limp film for the same fill", () => {
    const v = 4e5;
    const limp = roundnessFromFill({ ...base, stiffNorm: 0, productVolume: v });
    const stiff = roundnessFromFill({ ...base, stiffNorm: 1, productVolume: v });
    expect(stiff).toBeGreaterThan(limp);
  });
});
