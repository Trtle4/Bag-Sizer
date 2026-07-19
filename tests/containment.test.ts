import { describe, it, expect, beforeAll } from "vitest";
import { FillSim, initPhysics, FIXED_DT, type FillParams } from "../src/physics/world.js";
import { gusseted } from "../src/bagstyles/gusseted.js";
import { sup } from "../src/bagstyles/sup.js";

beforeAll(async () => {
  await initPhysics();
});

/**
 * The fill sim contains product with one elliptical wall cage built from the
 * style's cross-section (halfW × halfD). Enabling the gusset/SUP cross-sections
 * must not let product escape that cage — the containment fix is style-agnostic
 * by construction. This drives a full-ish fill on each non-pillow cross-section
 * and asserts nothing leaves the walls in x or z.
 */
function fillAndScan(style: FillParams["style"]) {
  const p: FillParams = {
    style,
    bag: { bagW: 140, bagL: 230, endSeal: 10, finSeal: 10, gusset: 55 },
    product: { w: 30, h: 4, depth: 30, round: true },
    unitWeight: 8,
    count: 40,
    dropH: 150,
    stiff: 40,
    seed: 7,
  };
  const sim = new FillSim();
  sim.build(p);
  sim.start();
  const env = sim.envelope;
  // The wall cage is an impermeable static collider, so containment holds
  // throughout the drop — a shorter horizon than full settle suffices.
  let escX = 0, escZ = 0;
  for (let i = 0; i < Math.round(14 / FIXED_DT); i++) {
    sim.fixedStep();
    for (const t of sim.particleTransforms()) {
      if (Math.abs(t.x) > env.usableHalfW + 20) escX++;
      if (Math.abs(t.z) > env.usableHalfD + 20) escZ++;
    }
  }
  return { escX, escZ, n: sim.particleCount };
}

describe("fill containment generalizes to gusset/SUP cross-sections", () => {
  for (const [name, style] of [["gusseted", gusseted], ["sup", sup]] as const) {
    it(`${name}: no product escapes the elliptical wall cage`, () => {
      const r = fillAndScan(style);
      expect(r.n).toBe(40);
      expect(r.escX).toBe(0);
      expect(r.escZ).toBe(0);
    }, 30000);
  }
});
