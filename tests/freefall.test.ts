import { describe, it, expect, beforeAll } from "vitest";
import { FillSim, initPhysics, FIXED_DT, type FillParams } from "../src/physics/world.js";
import { pillow } from "../src/bagstyles/pillow.js";

beforeAll(async () => {
  await initPhysics();
});

/**
 * Product must fall under REAL gravity. The world runs in metres (all lengths are
 * scaled mm→m at the boundary), so g = 9.81 m/s² is physically correct: a piece
 * released from rest at height h reaches v = √(2·g·h). This asserts the sim
 * matches that (the old capped launch velocity is gone), across a drop big enough
 * that the former 5 m/s cap would have clipped it.
 */
describe("free-fall under real gravity", () => {
  const G = 9.81; // m/s²

  function measureAtJaw(dropHmm: number): { v: number; predicted: number; fallM: number } {
    const p: FillParams = {
      style: pillow,
      bag: { bagW: 140, bagL: 230, endSeal: 10, finSeal: 10 },
      product: { w: 30, h: 12, depth: 30, round: true },
      unitWeight: 8,
      count: 1,
      dropH: dropHmm,
      stiff: 40,
      seed: 5,
    };
    const sim = new FillSim();
    sim.build(p);
    sim.start();
    const { spawnY, jawY } = sim.envelope;
    let prevY = spawnY;
    let vAtJaw = 0;
    // Step until the piece (released at rest at spawnY) free-falls past the jaw
    // plane; record its speed there — still clean free-fall (empty bag below).
    for (let i = 0; i < Math.round(4 / FIXED_DT); i++) {
      sim.fixedStep();
      const parts = sim.particleTransforms();
      if (!parts.length) continue;
      const y = parts[0].y;
      if (y <= jawY && prevY > jawY) {
        vAtJaw = ((prevY - y) / 1000 / FIXED_DT); // mm/step → m/s
        break;
      }
      prevY = y;
    }
    const fallM = (spawnY - jawY) / 1000;
    return { v: vAtJaw, predicted: Math.sqrt(2 * G * fallM), fallM };
  }

  it("impact velocity matches √(2gh) for a big drop the old cap would clip", () => {
    const { v, predicted, fallM } = measureAtJaw(2000);
    // eslint-disable-next-line no-console
    console.log(`free-fall: fell ${fallM.toFixed(2)} m → measured ${v.toFixed(2)} m/s vs √(2gh)=${predicted.toFixed(2)} m/s`);
    expect(v).toBeGreaterThan(5.0); // proves the old 5 m/s cap is gone
    expect(Math.abs(v - predicted) / predicted).toBeLessThan(0.05); // within 5%
  });

  it("scales with drop height as √h", () => {
    const a = measureAtJaw(500);
    const b = measureAtJaw(2000);
    // 4× the height → 2× the speed.
    expect(b.v / a.v).toBeGreaterThan(1.85);
    expect(b.v / a.v).toBeLessThan(2.15);
  });
});
