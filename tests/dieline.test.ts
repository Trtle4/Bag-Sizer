import { describe, it, expect } from "vitest";
import { pillow, getBagStyle } from "../src/bagstyles/index.js";
import type { BagParams } from "../src/bagstyles/types.js";

const P: BagParams = { bagW: 140, bagL: 230, endSeal: 10, finSeal: 10 };

describe("pillow dieline model — hand-checked", () => {
  const m = pillow.dieline(P);

  it("web = 2W + 2F and cut = L", () => {
    expect(m.web).toBe(300);
    expect(m.cut).toBe(230);
    expect(m.bounds).toEqual({ w: 300, h: 230 });
  });

  it("has a single closed cut perimeter covering the web", () => {
    const per = m.entities.filter((e) => e.kind === "perimeter");
    expect(per).toHaveLength(1);
    const pts = (per[0] as { pts: { x: number; y: number }[] }).pts;
    expect(pts).toEqual([
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 230 },
      { x: 0, y: 230 },
    ]);
  });

  it("has exactly four crease/fold lines at the interior panel boundaries", () => {
    const folds = m.entities.filter((e) => e.kind === "fold");
    expect(folds).toHaveLength(4);
    const xs = folds.map((f) => (f as { a: { x: number } }).a.x).sort((a, b) => a - b);
    expect(xs).toEqual([10, 80, 220, 290]);
  });

  it("has four hatched seal zones (2 end seals + 2 fin strips)", () => {
    const seals = m.entities.filter((e) => e.kind === "sealZone");
    expect(seals).toHaveLength(4);
  });

  it("labels five panels horizontally: FIN / BACK ½ / FRONT PANEL / BACK ½ / FIN", () => {
    const panels = m.entities.filter(
      (e) => e.kind === "label" && (e.role === "panel" || e.role === "panelBig"),
    );
    const texts = panels.map((p) => (p as { text: string }).text);
    expect(texts).toEqual(["FIN", "BACK ½", "FRONT PANEL", "BACK ½", "FIN"]);
    // All at mid-height (horizontal, parallel to top seal) — same y, no rotation field.
    const ys = new Set(panels.map((p) => (p as { at: { y: number } }).at.y));
    expect(ys).toEqual(new Set([115]));
  });

  it("dimensions the web, front panel, fin, cutoff and end seal", () => {
    const dims = m.entities.filter((e) => e.kind === "dimension");
    const texts = dims.map((d) => (d as { text: string }).text);
    expect(texts).toContain("WEB 300.0");
    expect(texts).toContain("140.0"); // front panel width
    expect(texts).toContain("10.0"); // fin (and end seal share value here)
    expect(texts).toContain("CUT 230.0");
  });

  it("all entities carry a valid cutting-table layer", () => {
    for (const e of m.entities) {
      expect(["CUT", "CREASE", "ANNO"]).toContain(e.layer);
    }
  });

  it("is reachable through the style registry", () => {
    expect(getBagStyle("pillow")).toBe(pillow);
    expect(getBagStyle("gusseted").enabled).toBe(false);
    expect(getBagStyle("sup").enabled).toBe(false);
  });
});

describe("pillow 3-D shell profile", () => {
  it("returns inner length, usable half-width/depth and load gains", () => {
    const prof = pillow.simProfile(P, { stiffNorm: 0.4 });
    expect(prof.innerLen).toBe(210);
    // usableHalfWidth(140, 0.4) = 70 - (3 + 11*0.4) = 62.6
    expect(prof.usableHalfW).toBeCloseTo(62.6, 6);
    // depth = usableHalfW * (1.0 - 0.7*0.4)
    expect(prof.usableHalfD).toBeCloseTo(62.6 * (1.0 - 0.7 * 0.4), 6);
    expect(prof.floorSagGain).toBeCloseTo(2.6 - 2.2 * 0.4, 6);
    expect(prof.billowGain).toBeCloseTo(0.6 - 0.45 * 0.4, 6);
  });

  it("stiffer film → much flatter (shallower) pillow and less billow", () => {
    const limp = pillow.simProfile(P, { stiffNorm: 0.05 });
    const stiff = pillow.simProfile(P, { stiffNorm: 0.95 });
    // Depth ratio swings hard with stiffness (drives the fill-height response).
    expect(stiff.usableHalfD / stiff.usableHalfW).toBeLessThan(0.4);
    expect(limp.usableHalfD / limp.usableHalfW).toBeGreaterThan(0.9);
    expect(stiff.billowGain).toBeLessThan(limp.billowGain);
  });
});
