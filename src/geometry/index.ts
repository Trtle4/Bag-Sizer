/**
 * Bag geometry — pure functions shared by the simulator, the dieline generator,
 * and the exporters. Everything is in millimetres unless noted. No DOM, no state.
 *
 * Coordinate convention for the pillow cross-section (front view):
 *   - x = 0 is the bag centreline, +x to the right.
 *   - y = 0 is the inner bottom seal (bag floor), +y upward toward the jaw plane.
 *
 * These formulas are the contract that the Vitest suite pins against
 * hand-checked values; they are lifted verbatim from the approved concept.
 */

export { piecesForWeight, weightForPieces, resolveFillCount, MAX_PIECES } from "./units.js";
export { parseStepBBox, type StepParseResult } from "./step.js";

/** Normalised film stiffness in [0, 1] from the 0–100 slider. */
export function stiff01(stiff: number): number {
  return clamp(stiff, 0, 100) / 100;
}

/** Human label for a stiffness value, matching the concept's thresholds. */
export function stiffLabel(stiff: number): "Limp" | "Med" | "Stiff" {
  return stiff < 34 ? "Limp" : stiff < 67 ? "Med" : "Stiff";
}

/**
 * Flat web width for a fin-seal pillow bag: two full bag faces plus two fin
 * strips (one per edge of the fin). web = 2·W + 2·F.
 */
export function webWidth(bagW: number, finSeal: number): number {
  return 2 * bagW + 2 * finSeal;
}

/** Cutoff (flat blank length along the web) equals the bag length. */
export function cutoffLength(bagL: number): number {
  return bagL;
}

/**
 * Open-top fill zone: the bag length minus the two end seals. Floored at 10 mm
 * so degenerate inputs never produce a zero/negative envelope.
 */
export function innerLength(bagL: number, endSeal: number): number {
  return Math.max(10, bagL - 2 * endSeal);
}

/**
 * Panel fold boundaries across the flat web, left → right:
 *   fin | back ½ | FRONT | back ½ | fin
 * Returns the six x-positions [0, F, F+W/2, F+3W/2, F+2W, 2F+2W].
 */
export function panelBoundaries(bagW: number, finSeal: number): number[] {
  const W = bagW;
  const F = finSeal;
  return [0, F, F + W / 2, F + (3 * W) / 2, F + 2 * W, 2 * F + 2 * W];
}

/**
 * Edge tuck (mm): how much of each side is lost to the film folding in at the
 * gusset-free edges. First-order model from the concept — grows with stiffness.
 */
export function edgeTuck(stiffNorm: number): number {
  return 3 + 11 * clamp(stiffNorm, 0, 1);
}

/**
 * Usable half-width of the fill channel (mm), centreline to effective wall,
 * after edge tuck. Floored at 8 mm so the channel never collapses.
 */
export function usableHalfWidth(bagW: number, stiffNorm: number): number {
  return Math.max(8, bagW / 2 - edgeTuck(stiffNorm));
}

/** Headspace (mm) = open fill zone above the settled fill line. May go negative (overfull). */
export function headspace(innerLen: number, fillLine: number): number {
  return innerLen - fillLine;
}

/**
 * Effective usable interior volume of the bag (mm³), modelled as a flat pillow:
 * a channel of width 2·usableHalfWidth and depth ≈ bag width/π (the collapsed
 * pillow's mean thickness) over the inner fill length. Used for the % usable
 * volume readout; a coarse but stable estimator.
 */
export function usableBagVolume(bagW: number, bagL: number, endSeal: number, stiffNorm: number): number {
  const width = 2 * usableHalfWidth(bagW, stiffNorm);
  const depth = bagW / Math.PI;
  return width * depth * innerLength(bagL, endSeal);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Format a number to at most one decimal, dropping a trailing ".0". */
export function fmt(v: number, digits = 1): string {
  return (+v).toFixed(digits).replace(/\.0$/, "");
}

/** Always one decimal place. */
export function fmt1(v: number): string {
  return (+v).toFixed(1);
}
