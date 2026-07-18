import { describe, it, expect } from "vitest";
import {
  webWidth,
  cutoffLength,
  innerLength,
  panelBoundaries,
  edgeTuck,
  usableHalfWidth,
  headspace,
  stiff01,
  stiffLabel,
} from "../src/geometry/index.js";

describe("bag geometry — hand-checked values", () => {
  // Concept defaults: bagW 140, bagL 230, endSeal 10, finSeal 10.
  it("web width = 2W + 2F", () => {
    expect(webWidth(140, 10)).toBe(300); // 280 + 20
    expect(webWidth(100, 12.5)).toBe(225); // 200 + 25
  });

  it("cutoff length equals bag length", () => {
    expect(cutoffLength(230)).toBe(230);
  });

  it("inner fill length = L - 2·endSeal, floored at 10", () => {
    expect(innerLength(230, 10)).toBe(210);
    expect(innerLength(30, 20)).toBe(10); // -10 floored to 10
  });

  it("panel boundaries: fin | back½ | front | back½ | fin", () => {
    // W=140, F=10 → [0, 10, 80, 220, 290, 300]
    expect(panelBoundaries(140, 10)).toEqual([0, 10, 80, 220, 290, 300]);
    // Last boundary must equal the web width.
    const b = panelBoundaries(140, 10);
    expect(b[5]).toBe(webWidth(140, 10));
    // Segment widths: fin=F, back½=W/2, front=W, back½=W/2, fin=F.
    const widths = b.slice(1).map((x, i) => x - b[i]);
    expect(widths).toEqual([10, 70, 140, 70, 10]);
  });

  it("edge tuck grows from 3mm (limp) to 14mm (stiff)", () => {
    expect(edgeTuck(0)).toBeCloseTo(3, 6);
    expect(edgeTuck(1)).toBeCloseTo(14, 6);
    expect(edgeTuck(0.5)).toBeCloseTo(8.5, 6);
  });

  it("usable half width = W/2 - edgeTuck, floored at 8", () => {
    // W=140, limp: 70 - 3 = 67
    expect(usableHalfWidth(140, 0)).toBeCloseTo(67, 6);
    // W=140, stiff: 70 - 14 = 56
    expect(usableHalfWidth(140, 1)).toBeCloseTo(56, 6);
    // Narrow bag floors at 8
    expect(usableHalfWidth(20, 1)).toBe(8);
  });

  it("headspace = innerLen - fillLine (may go negative)", () => {
    expect(headspace(210, 180)).toBe(30);
    expect(headspace(210, 230)).toBe(-20); // overfull
  });
});

describe("stiffness mapping", () => {
  it("normalises 0–100 to 0–1", () => {
    expect(stiff01(0)).toBe(0);
    expect(stiff01(40)).toBeCloseTo(0.4, 6);
    expect(stiff01(100)).toBe(1);
    expect(stiff01(150)).toBe(1); // clamped
  });

  it("labels thresholds Limp / Med / Stiff", () => {
    expect(stiffLabel(0)).toBe("Limp");
    expect(stiffLabel(33)).toBe("Limp");
    expect(stiffLabel(34)).toBe("Med");
    expect(stiffLabel(66)).toBe("Med");
    expect(stiffLabel(67)).toBe("Stiff");
    expect(stiffLabel(100)).toBe("Stiff");
  });
});
