/**
 * Formed pillow cross-section by perimeter conservation.
 *
 * A pillow bag is cut flat: the film's cross-section circumference is fixed once
 * cut (from the bag width / web) and cannot change. As product fills, that fixed
 * perimeter redistributes from flat (lay-flat, ~zero depth) toward rounded — so
 * the formed depth is physically BOUNDED: a pillow can't bulge past a fully
 * round cross-section, and rounding trades width for depth.
 *
 * We model the cross-section as an ellipse of half-width a and half-depth b with
 * a fixed circumference C = 2·(flat film width). roundness ∈ [0,1] maps b from 0
 * (flat) to a=b (fully round); a is solved to keep C constant.
 *
 * Pure + unit-tested. mm throughout.
 */

/** Ramanujan II approximation of an ellipse circumference. Exact for a=b (circle) and ~4a for b=0. */
export function ellipseCircumference(a: number, b: number): number {
  if (a <= 0 && b <= 0) return 0;
  const s = a + b;
  if (s === 0) return 0;
  const h = ((a - b) / s) ** 2;
  return Math.PI * s * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

export interface FormedSection {
  halfW: number; // formed half-width (mm)
  halfD: number; // formed half-depth (mm)
  roundness: number; // 0 flat … 1 round
}

/**
 * Formed cross-section for a given flat film half-width and roundness.
 * `flatHalfW` is half the usable flat film width (per face); the conserved
 * circumference is C = 4·flatHalfW (front + back of the lay-flat film).
 */
export function formedSection(flatHalfW: number, roundness: number): FormedSection {
  const t = Math.max(0, Math.min(1, roundness));
  const C = 4 * flatHalfW; // conserved film circumference
  const aRound = C / (2 * Math.PI); // circle radius (a = b)
  const aFlat = C / 4; // lay-flat half-width (= flatHalfW)
  const b = t * aRound; // half-depth grows with roundness
  // Solve a ∈ [aRound, aFlat] with ellipseCircumference(a, b) = C (monotonic in a).
  let lo = aRound;
  let hi = aFlat;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (ellipseCircumference(mid, b) > C) hi = mid;
    else lo = mid;
  }
  const a = (lo + hi) / 2;
  return { halfW: a, halfD: Math.max(b, 0.5), roundness: t };
}

/** Cross-section area (mm²) of the formed ellipse. */
export function formedArea(sec: { halfW: number; halfD: number }): number {
  return Math.PI * sec.halfW * sec.halfD;
}

/**
 * Roundness the bag forms to, from the settled product volume and film stiffness.
 * Empty → near lay-flat; a bag packed toward its fully-round capacity → round.
 * Limp film bulges more for the same fill; stiff film resists.
 */
export function roundnessFromFill(opts: {
  productVolume: number; // mm³
  flatHalfW: number;
  innerLen: number;
  stiffNorm: number;
  packing?: number; // bulk packing fraction of the pile
}): number {
  const packing = opts.packing ?? 0.6;
  const C = 4 * opts.flatHalfW;
  const aRound = C / (2 * Math.PI);
  const roundCapacity = Math.PI * aRound * aRound * opts.innerLen; // fully-round volume
  if (roundCapacity <= 0) return 0;
  const phi = opts.productVolume / (packing * roundCapacity); // 0…~1+
  const bulge = 1.2 - 0.6 * Math.max(0, Math.min(1, opts.stiffNorm)); // limp bulges more
  return Math.max(0, Math.min(1, phi * bulge));
}
