/**
 * Unit conversions for fill targeting.
 *
 * Pure functions — fully unit tested. No DOM, no state.
 * All masses in grams. Counts are whole pieces.
 */

/** Hard ceiling on the live simulation's piece count (perf + parity with concept). */
export const MAX_PIECES = 200;

/**
 * Pieces required to reach a target weight, given the per-piece unit weight.
 *
 * ceil(target / unitWeight) — you cannot drop a fraction of a piece, so any
 * remainder rounds up to the next whole piece. Guards against a zero/negative
 * unit weight (which would divide by zero) by clamping to a tiny positive value.
 */
export function piecesForWeight(targetWeight: number, unitWeight: number): number {
  const w = Math.max(0.01, unitWeight);
  return Math.max(1, Math.ceil(targetWeight / w));
}

/** Total weight (g) of a whole number of pieces at a given unit weight. */
export function weightForPieces(count: number, unitWeight: number): number {
  return Math.max(0, Math.round(count)) * unitWeight;
}

/**
 * Resolve the fill target to a concrete, simulation-ready piece count.
 *
 * - mode "count": use the entered count directly.
 * - mode "weight": ceil(targetWeight / unitWeight).
 *
 * Always clamped to [1, MAX_PIECES] and coerced to a whole number so the
 * physics loop and readouts agree exactly.
 */
export function resolveFillCount(opts: {
  mode: "count" | "weight";
  count: number;
  targetWeight: number;
  unitWeight: number;
}): number {
  const raw =
    opts.mode === "count"
      ? Math.round(opts.count)
      : piecesForWeight(opts.targetWeight, opts.unitWeight);
  const n = Number.isFinite(raw) ? raw : 1;
  return Math.max(1, Math.min(MAX_PIECES, n || 1));
}
