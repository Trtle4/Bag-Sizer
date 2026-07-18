/**
 * Seeded, deterministic RNG (mulberry32). Used for all spawn jitter so a fill
 * can be replayed exactly given the same seed and fixed timestep.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Coerce to a 32-bit unsigned integer.
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Next float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Next float in [-mag, +mag). */
  spread(mag: number): number {
    return (this.next() * 2 - 1) * mag;
  }

  reset(seed: number): void {
    this.state = seed >>> 0;
  }
}
