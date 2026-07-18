import { describe, it, expect } from "vitest";
import { FillSim, type FillParams } from "../src/physics/world.js";
import { pillow } from "../src/bagstyles/pillow.js";

function makeParams(seed: number, over = false): FillParams {
  return {
    style: pillow,
    bag: { bagW: 140, bagL: 230, endSeal: 10, finSeal: 10 },
    product: { w: 30, h: 12, round: true },
    unitWeight: 8,
    count: over ? 90 : 16,
    dropH: 250,
    stiff: 40,
    seed,
  };
}

/** Run a full fill to rest and return the final measurements. */
function runToRest(sim: FillSim, seconds = 5): ReturnType<FillSim["measurements"]> {
  const h = 1 / 240;
  const steps = Math.round(seconds / h);
  for (let i = 0; i < steps; i++) sim.fixedStep(h);
  return sim.measurements();
}

describe("fill physics", () => {
  it("pieces fall, land inside the bag, and settle without exploding", () => {
    const sim = new FillSim();
    sim.build(makeParams(1234));
    sim.start();
    const m = runToRest(sim);

    expect(Number.isFinite(m.fillLine)).toBe(true);
    // Something accumulated on the floor.
    expect(m.fillLine).toBeGreaterThan(5);
    // Nothing launched out of the envelope.
    const env = sim.envelope;
    expect(m.fillLine).toBeLessThan(env.innerLen * 1.2);
    // 16 light pieces in a 140×230 bag settle below the jaw.
    expect(m.status).toBe("settled");

    for (const p of sim.particles()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      // Contained laterally within a sane margin of the bag half-width.
      expect(Math.abs(p.x)).toBeLessThan(140);
      // Not below the seal or far above the jaw.
      expect(p.y).toBeGreaterThan(-40);
      expect(p.y).toBeLessThan(env.spawnY + 40);
    }
  });

  it("is deterministic: same seed → identical fill line", () => {
    const a = new FillSim();
    a.build(makeParams(999));
    a.start();
    const ma = runToRest(a);

    const b = new FillSim();
    b.build(makeParams(999));
    b.start();
    const mb = runToRest(b);

    expect(mb.fillLine).toBeCloseTo(ma.fillLine, 6);
    expect(mb.pctUsable).toBeCloseTo(ma.pctUsable, 6);
  });

  it("different seeds diverge (jitter is actually applied)", () => {
    const a = new FillSim();
    a.build(makeParams(1));
    a.start();
    runToRest(a);
    const pa = a.particles().map((p) => p.x);

    const b = new FillSim();
    b.build(makeParams(2));
    b.start();
    runToRest(b);
    const pb = b.particles().map((p) => p.x);

    // Settled pile heights are nearly seed-independent, but the individual
    // resting positions must differ — otherwise the RNG isn't wired.
    const diff = pa.reduce((s, x, i) => s + Math.abs(x - (pb[i] ?? 0)), 0);
    expect(diff).toBeGreaterThan(1);
  });

  it("reports measurements: volume, bulk density, % usable", () => {
    const sim = new FillSim();
    sim.build(makeParams(7));
    sim.start();
    const m = runToRest(sim);
    expect(m.fillVolume).toBeGreaterThan(0);
    expect(m.bulkDensity).toBeGreaterThan(0);
    expect(m.pctUsable).toBeGreaterThan(0);
  });

  it("flags overfull when fill crosses the jaw plane", () => {
    const sim = new FillSim();
    sim.build(makeParams(3, true));
    sim.start();
    const m = runToRest(sim, 14); // 90 pieces spawn over ~9 s
    // 90 pieces of ⌀30 in a 140×230 bag overruns the jaw plane.
    expect(m.fillLine).toBeGreaterThan(sim.envelope.innerLen * 0.7);
    expect(m.status).toBe("overfull");
    // Overflow stays contained (no lateral spray).
    for (const p of sim.particles()) expect(Math.abs(p.x)).toBeLessThan(140);
  });
});
