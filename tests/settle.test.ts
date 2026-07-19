import { describe, it, expect, beforeAll } from "vitest";
import { FillSim, initPhysics, FIXED_DT, type FillParams } from "../src/physics/world.js";
import { pillow } from "../src/bagstyles/pillow.js";

beforeAll(async () => {
  await initPhysics();
});

function params(count: number, thk: number): FillParams {
  return {
    style: pillow,
    bag: { bagW: 140, bagL: 230, endSeal: 10, finSeal: 10 },
    product: { w: 30, h: thk, depth: 30, round: true },
    unitWeight: 8,
    count,
    dropH: 120,
    stiff: 40,
    seed: 7,
  };
}

/**
 * After a drop the pile must come fully to rest — Rapier's auto-sleep threshold is
 * unreachable at our scaled lengthUnit, so the sim forces the pile to sleep once
 * settled. This asserts the pile actually stops (every body asleep, zero velocity)
 * and that the fill height then holds still, for both a light-jitter (thin disc)
 * and a stubborn (thick disc) pile.
 */
describe("a dropped pile comes fully to rest and stays put", () => {
  for (const [count, thk] of [[50, 4], [24, 12]] as const) {
    it(`settles to zero velocity with a stable fill (${count} × ⌀30×${thk})`, () => {
      const sim = new FillSim();
      sim.build(params(count, thk));
      sim.start();
      // Spawn (count × 0.13 s) + a couple of seconds to settle, capped.
      const budget = Math.round((count * 0.13 + 5) / FIXED_DT);
      let settledStep = -1;
      for (let i = 0; i < budget; i++) {
        sim.fixedStep();
        if (settledStep < 0 && sim.measurements().status === "settled") settledStep = i;
      }
      expect(settledStep).toBeGreaterThan(0);

      // Fully at rest: every body asleep, mean + max speed zero.
      const r = sim.restDebug();
      expect(r.sleeping).toBe(r.n);
      expect(r.avg).toBeLessThan(1e-6);
      expect(r.max).toBeLessThan(1e-6);

      // Fill height holds still: step another 2 s, it must not drift.
      const fill0 = sim.measurements().fillLine;
      for (let i = 0; i < Math.round(2 / FIXED_DT); i++) sim.fixedStep();
      expect(Math.abs(sim.measurements().fillLine - fill0)).toBeLessThan(0.5);
    }, 60000);
  }
});
