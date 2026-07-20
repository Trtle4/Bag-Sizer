import { describe, it, expect, beforeAll } from "vitest";
import { FillSim, initPhysics, FIXED_DT, type FillParams } from "../src/physics/world.js";
import { pillow } from "../src/bagstyles/pillow.js";

beforeAll(async () => {
  await initPhysics();
});

function batchParams(count: number): FillParams {
  return {
    style: pillow,
    bag: { bagW: 140, bagL: 230, endSeal: 10, finSeal: 10 },
    product: { w: 30, h: 4, depth: 30, round: true },
    unitWeight: 8,
    count,
    dropH: 120,
    stiff: 40,
    seed: 7,
    release: "batch",
  };
}

/**
 * Batch release drops the whole charge at once from a pre-spaced, overlap-free
 * cloud above the mouth. It must (a) stay contained — the tall cage catches every
 * piece on the way down — and (b) come fully to rest, like the trickle feed.
 */
describe("batch (bulk-dump) release", () => {
  it("spawns the whole charge at once, contained and overlap-free", () => {
    const sim = new FillSim();
    sim.build(batchParams(120));
    sim.start();
    // Everything is instantiated on start() — no trickle queue.
    expect(sim.particleCount).toBe(120);
    // The pre-spaced cloud starts overlap-free: no deep disc-disc penetration.
    expect(sim.penetrationReport().dd.filter((d) => d > 0.5).length).toBe(0);
  });

  it("settles fully and stays inside the cage", () => {
    const sim = new FillSim();
    sim.build(batchParams(120));
    sim.start();
    const env = sim.envelope;
    let settledStep = -1;
    for (let i = 0; i < Math.round(12 / FIXED_DT); i++) {
      sim.fixedStep();
      if (settledStep < 0 && sim.measurements().status === "settled") settledStep = i;
      if (settledStep >= 0 && i > settledStep + Math.round(1 / FIXED_DT)) break;
    }
    expect(settledStep).toBeGreaterThan(0);

    // Fully at rest.
    const r = sim.restDebug();
    expect(r.sleeping).toBe(r.n);
    expect(r.avg).toBeLessThan(1e-6);

    // Contained: nothing escapes the wall cage or drops below the base.
    for (const t of sim.particleTransforms()) {
      expect(Math.abs(t.x)).toBeLessThan(env.usableHalfW + 20);
      expect(Math.abs(t.z)).toBeLessThan(env.usableHalfD + 20);
      expect(t.y).toBeGreaterThan(-20);
    }
  }, 60000);
});
