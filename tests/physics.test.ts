import { describe, it, expect, beforeAll } from "vitest";
import { FillSim, initPhysics, type FillParams } from "../src/physics/world.js";
import { pillow } from "../src/bagstyles/pillow.js";

beforeAll(async () => {
  await initPhysics();
});

function makeParams(seed: number, over = false): FillParams {
  return {
    style: pillow,
    bag: { bagW: 140, bagL: 230, endSeal: 10, finSeal: 10 },
    product: { w: 30, h: 12, depth: 30, round: true },
    unitWeight: 8,
    count: over ? 90 : 16,
    dropH: 250,
    stiff: 40,
    seed,
  };
}

function runToRest(sim: FillSim, seconds = 5): ReturnType<FillSim["measurements"]> {
  const steps = Math.round(seconds / (1 / 120));
  for (let i = 0; i < steps; i++) sim.fixedStep();
  return sim.measurements();
}

describe("fill physics (Rapier 3-D)", () => {
  it("pieces fall, land inside the bag, and settle without exploding", () => {
    const sim = new FillSim();
    sim.build(makeParams(1234));
    sim.start();
    const m = runToRest(sim);
    const env = sim.envelope;

    expect(Number.isFinite(m.fillLine)).toBe(true);
    expect(m.fillLine).toBeGreaterThan(5);
    expect(m.fillLine).toBeLessThan(env.innerLen * 1.2);
    expect(m.status).toBe("settled");

    for (const p of sim.particleTransforms()) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
      // Contained within the bag footprint (+ margin) in x and z.
      expect(Math.abs(p.x)).toBeLessThan(env.usableHalfW + 40);
      expect(Math.abs(p.z)).toBeLessThan(env.usableHalfD + 40);
      expect(p.y).toBeGreaterThan(-40);
      expect(p.y).toBeLessThan(env.spawnY + 60);
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

    expect(mb.fillLine).toBe(ma.fillLine);
    expect(mb.pctUsable).toBe(ma.pctUsable);
  });

  it("different seeds diverge (jitter applied)", () => {
    const a = new FillSim();
    a.build(makeParams(1));
    a.start();
    runToRest(a);
    const pa = a.particleTransforms().map((p) => p.x);

    const b = new FillSim();
    b.build(makeParams(2));
    b.start();
    runToRest(b);
    const pb = b.particleTransforms().map((p) => p.x);

    const diff = pa.reduce((s, x, i) => s + Math.abs(x - (pb[i] ?? 0)), 0);
    expect(diff).toBeGreaterThan(1);
  });

  it("reports 3-D measurements: volume, bulk density, % usable", () => {
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
    // A deliberately undersized bag so a modest count overruns the jaw.
    sim.build({
      style: pillow,
      bag: { bagW: 70, bagL: 120, endSeal: 10, finSeal: 10 },
      product: { w: 30, h: 12, depth: 30, round: true },
      unitWeight: 8,
      count: 60,
      dropH: 200,
      stiff: 40,
      seed: 3,
    });
    sim.start();
    const m = runToRest(sim, 12);
    expect(m.fillLine).toBeGreaterThan(sim.envelope.innerLen * 0.7);
    expect(m.status).toBe("overfull");
  });

  it("builds a convex-hull collider for a STEP silhouette without error", () => {
    const sim = new FillSim();
    const params = makeParams(5);
    params.product = {
      w: 30,
      h: 12,
      depth: 26,
      round: false,
      hull: [
        { x: 15, y: 0 },
        { x: 7.5, y: 13 },
        { x: -7.5, y: 13 },
        { x: -15, y: 0 },
        { x: -7.5, y: -13 },
        { x: 7.5, y: -13 },
      ],
    };
    params.count = 8;
    sim.build(params);
    sim.start();
    const m = runToRest(sim);
    expect(m.fillLine).toBeGreaterThan(5);
    expect(m.status).toBe("settled");
  });
});
