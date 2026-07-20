import { describe, it, expect, beforeAll } from "vitest";
import { FillSim, initPhysics, FIXED_DT, type FillParams } from "../src/physics/world.js";
import { pillow } from "../src/bagstyles/pillow.js";

beforeAll(async () => {
  await initPhysics();
});

const MIN_HS = 30; // 05-Limits min-headspace (the seal clearance threshold)

function settleAndCheck(release: "trickle" | "batch", count: number, bagL: number) {
  const p: FillParams = {
    style: pillow,
    bag: { bagW: 140, bagL, endSeal: 10, finSeal: 10 },
    product: { w: 30, h: 4, depth: 30, round: true },
    unitWeight: 8, count, dropH: 120, stiff: 40, seed: 7, release,
  };
  const sim = new FillSim();
  sim.build(p);
  sim.start();
  let settled = -1;
  const maxSteps = Math.round((release === "batch" ? 10 : count * 0.13 + 6) / FIXED_DT);
  for (let i = 0; i < maxSteps; i++) {
    sim.fixedStep();
    if (settled < 0 && sim.measurements().status === "settled") settled = i;
    if (settled >= 0 && i > settled + Math.round(0.8 / FIXED_DT)) break;
  }
  return sim.sealCheck(MIN_HS);
}

/**
 * The top-seal fit check must PASS when settled product clears the jaw plane by
 * the 05-Limits min-headspace, and REJECT when product reaches into the seal
 * zone. It ties to that user-adjustable threshold, and holds on both fill modes
 * (a batch dump's looser pack sits a touch higher but must not flip a clear pass).
 */
describe("top-seal jaw fit check", () => {
  for (const release of ["trickle", "batch"] as const) {
    it(`${release}: a roomy fill seals clean (clearance ≥ min-headspace)`, () => {
      const r = settleAndCheck(release, 15, 230);
      expect(r.clean).toBe(true);
      expect(r.caught).toBe(0);
      expect(r.clearance).toBeGreaterThanOrEqual(MIN_HS);
    }, 40000);

    it(`${release}: a near-full fill is rejected (product in the seal zone)`, () => {
      const r = settleAndCheck(release, 60, 130);
      expect(r.clean).toBe(false);
      expect(r.caught).toBeGreaterThan(0);
      expect(r.clearance).toBeLessThan(MIN_HS);
    }, 40000);
  }

  it("threshold is the clearance argument: the same fill flips on the limit", () => {
    // A ~40 mm-clearance fill passes at a 30 mm minimum but rejects at 60 mm.
    const p: FillParams = {
      style: pillow,
      bag: { bagW: 140, bagL: 230, endSeal: 10, finSeal: 10 },
      product: { w: 30, h: 4, depth: 30, round: true },
      unitWeight: 8, count: 120, dropH: 120, stiff: 40, seed: 7, release: "batch",
    };
    const sim = new FillSim();
    sim.build(p);
    sim.start();
    for (let i = 0; i < Math.round(9 / FIXED_DT); i++) {
      sim.fixedStep();
      if (sim.measurements().status === "settled") break;
    }
    const c = sim.sealCheck(0).clearance; // measured clearance, threshold-independent
    expect(sim.sealCheck(Math.max(1, c - 10)).clean).toBe(true);
    expect(sim.sealCheck(c + 10).clean).toBe(false);
  }, 40000);
});
