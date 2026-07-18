import { describe, it, expect } from "vitest";
import DxfParser from "dxf-parser";
import { buildDxf } from "../src/export/dxf.js";
import { pillow } from "../src/bagstyles/index.js";
import type { BagParams } from "../src/bagstyles/types.js";

const P: BagParams = { bagW: 140, bagL: 230, endSeal: 10, finSeal: 10 };

describe("DXF R12 export", () => {
  const dxf = buildDxf(pillow.dieline(P));

  it("declares AC1009 (R12) and millimetre units", () => {
    expect(dxf).toContain("AC1009");
    expect(dxf).toMatch(/\$INSUNITS/);
  });

  it("parses without error as a valid DXF", () => {
    const parser = new DxfParser();
    const parsed = parser.parseSync(dxf);
    expect(parsed).toBeTruthy();
    expect(parsed!.entities.length).toBeGreaterThan(0);
  });

  it("defines the CUT / CREASE / ANNO layers", () => {
    const parsed = new DxfParser().parseSync(dxf)!;
    const layers = Object.keys(parsed.tables.layer.layers);
    expect(layers).toContain("CUT");
    expect(layers).toContain("CREASE");
    expect(layers).toContain("ANNO");
  });

  it("emits the cut perimeter as a closed polyline on CUT", () => {
    const parsed = new DxfParser().parseSync(dxf)!;
    const polys = parsed.entities.filter((e) => e.type === "POLYLINE" && e.layer === "CUT");
    expect(polys.length).toBeGreaterThanOrEqual(1);
    const perim = polys[0] as unknown as { shape?: boolean; vertices: { x: number; y: number }[] };
    // dxf-parser flags a closed polyline via `shape: true`.
    expect(perim.shape).toBe(true);
    expect(perim.vertices.length).toBe(4);
  });

  it("contains no SPLINE entities", () => {
    expect(dxf).not.toContain("SPLINE");
  });

  it("uses only ASCII text (no ½, ⌀, ×)", () => {
    // Extract TEXT string values (group 1) and assert ASCII-only.
    const lines = dxf.split(/\r\n/);
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i] === "1") {
        // eslint-disable-next-line no-control-regex
        expect(lines[i + 1]).toMatch(/^[\x00-\x7F]*$/);
      }
    }
  });

  it("places geometry in the positive quadrant (y flipped to y-up)", () => {
    const parsed = new DxfParser().parseSync(dxf)!;
    const cutPoly = parsed.entities.find(
      (e) => e.type === "POLYLINE" && e.layer === "CUT",
    ) as unknown as { vertices: { x: number; y: number }[] };
    const ys = cutPoly.vertices.map((v) => v.y);
    const xs = cutPoly.vertices.map((v) => v.x);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeCloseTo(230, 3);
    expect(Math.max(...xs)).toBeCloseTo(300, 3);
  });
});
