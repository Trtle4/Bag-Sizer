import { describe, it, expect } from "vitest";
import { gusseted, sup, getBagStyle } from "../src/bagstyles/index.js";
import type { BagParams } from "../src/bagstyles/types.js";

const P: BagParams = { bagW: 140, bagL: 230, endSeal: 10, finSeal: 10, gusset: 55 };

describe("gusseted style", () => {
  it("is enabled and registry-reachable", () => {
    expect(getBagStyle("gusseted")).toBe(gusseted);
    expect(gusseted.enabled).toBe(true);
  });

  it("simProfile is a boxed section: full-ish width × gusset half-depth", () => {
    const prof = gusseted.simProfile(P, { stiffNorm: 0.4 });
    expect(prof.innerLen).toBe(210);
    expect(prof.section.kind).toBe("boxed");
    if (prof.section.kind === "boxed") {
      // halfW ≈ bagW/2 - small margin; halfD = gusset/2.
      expect(prof.section.halfW).toBeCloseTo(67, 6); // 70 - 3
      expect(prof.section.halfD).toBeCloseTo(27.5, 6); // 55 / 2
      expect(prof.section.openFloor).toBeGreaterThan(0);
      expect(prof.section.openFloor).toBeLessThan(1);
    }
  });

  it("dieline web = 2F + 2W + 2G and cut = L, single perimeter", () => {
    const m = gusseted.dieline(P);
    expect(m.web).toBe(2 * 10 + 2 * 140 + 2 * 55); // 410
    expect(m.cut).toBe(230);
    expect(m.entities.filter((e) => e.kind === "perimeter")).toHaveLength(1);
  });

  it("labels seven panels: FIN / GUSSET / FRONT / GUSSET / BACK / GUSSET / FIN", () => {
    const m = gusseted.dieline(P);
    const texts = m.entities
      .filter((e) => e.kind === "label" && (e.role === "panel" || e.role === "panelBig"))
      .map((p) => (p as { text: string }).text);
    expect(texts).toEqual(["FIN", "GUSSET", "FRONT PANEL", "GUSSET", "BACK PANEL", "GUSSET", "FIN"]);
  });

  it("all entities carry a valid layer", () => {
    for (const e of gusseted.dieline(P).entities) expect(["CUT", "CREASE", "ANNO"]).toContain(e.layer);
  });

  it("defaults gusset depth from width when unset", () => {
    const noG: BagParams = { bagW: 100, bagL: 200, endSeal: 8, finSeal: 8 };
    const prof = gusseted.simProfile(noG, { stiffNorm: 0.4 });
    expect(prof.section.kind).toBe("boxed");
    if (prof.section.kind === "boxed") expect(prof.section.halfD).toBeGreaterThan(0);
  });
});

describe("sup style", () => {
  it("is enabled and registry-reachable", () => {
    expect(getBagStyle("sup")).toBe(sup);
    expect(sup.enabled).toBe(true);
  });

  it("simProfile is a boxed section with a lower open-floor (base needs product)", () => {
    const prof = sup.simProfile(P, { stiffNorm: 0.4 });
    expect(prof.section.kind).toBe("boxed");
    if (prof.section.kind === "boxed") {
      expect(prof.section.halfW).toBeCloseTo(65, 6); // 70 - 5
      expect(prof.section.openFloor).toBeLessThan(0.5);
    }
  });

  it("dieline web = 2W + 2F, includes a bottom-gusset band + D-seal mark", () => {
    const m = sup.dieline(P);
    expect(m.web).toBe(300);
    const labels = m.entities.filter((e) => e.kind === "label").map((l) => (l as { text: string }).text);
    expect(labels).toContain("BOTTOM GUSSET");
    const marks = m.entities.filter((e) => e.kind === "mark").map((mk) => (mk as { label?: string }).label);
    expect(marks).toContain("D-SEAL");
  });

  it("dimensions the gusset depth", () => {
    const texts = sup.dieline(P).entities
      .filter((e) => e.kind === "dimension")
      .map((d) => (d as { text: string }).text);
    expect(texts.some((t) => t.startsWith("GUSSET"))).toBe(true);
  });

  it("all entities carry a valid layer", () => {
    for (const e of sup.dieline(P).entities) expect(["CUT", "CREASE", "ANNO"]).toContain(e.layer);
  });
});
