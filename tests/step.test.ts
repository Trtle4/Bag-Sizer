import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseStepBBox } from "../src/geometry/step.js";

const cube = readFileSync(
  fileURLToPath(new URL("./fixtures/cube.step", import.meta.url)),
  "utf8",
);

describe("STEP bbox parsing", () => {
  it("reads the bounding box from a fixture point cloud", () => {
    const r = parseStepBBox(cube);
    expect(r.ok).toBe(true);
    expect(r.pointCount).toBe(9);
    // Extents: x 0..20, y 0..10, z 0..6 → sorted desc l≥w≥h
    expect(r.dims.l).toBeCloseTo(20, 6);
    expect(r.dims.w).toBeCloseTo(10, 6);
    expect(r.dims.h).toBeCloseTo(6, 6);
  });

  it("parses scientific notation coordinates", () => {
    // Fixture point #9 uses 1.0E1 (=10) for x — must not break the scan.
    const r = parseStepBBox(cube);
    expect(r.bounds.max[0]).toBeCloseTo(20, 6);
  });

  it("fails gracefully on non-STEP text", () => {
    const r = parseStepBBox("this is not a step file");
    expect(r.ok).toBe(false);
    expect(r.pointCount).toBe(0);
    expect(r.error).toMatch(/CARTESIAN_POINT/);
  });

  it("is stateless across repeated calls (regex lastIndex reset)", () => {
    const a = parseStepBBox(cube);
    const b = parseStepBBox(cube);
    expect(a.pointCount).toBe(b.pointCount);
    expect(a.dims).toEqual(b.dims);
  });
});
