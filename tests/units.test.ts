import { describe, it, expect } from "vitest";
import {
  piecesForWeight,
  weightForPieces,
  resolveFillCount,
  MAX_PIECES,
} from "../src/geometry/units.js";

describe("count ↔ weight conversion", () => {
  it("ceils pieces to reach a target weight", () => {
    // 150 g target at 8 g/piece → 18.75 → 19 pieces
    expect(piecesForWeight(150, 8)).toBe(19);
    // Exact multiple stays exact: 160 / 8 = 20
    expect(piecesForWeight(160, 8)).toBe(20);
    // Any remainder rounds up: 161 / 8 = 20.125 → 21
    expect(piecesForWeight(161, 8)).toBe(21);
  });

  it("always yields at least one piece", () => {
    expect(piecesForWeight(0, 8)).toBe(1);
    expect(piecesForWeight(-5, 8)).toBe(1);
  });

  it("guards against a zero or negative unit weight", () => {
    expect(Number.isFinite(piecesForWeight(100, 0))).toBe(true);
    expect(piecesForWeight(100, 0)).toBeGreaterThan(0);
  });

  it("computes total weight for a piece count", () => {
    expect(weightForPieces(18, 8)).toBe(144);
    expect(weightForPieces(0, 8)).toBe(0);
    expect(weightForPieces(19, 8.5)).toBeCloseTo(161.5, 6);
  });

  it("round-trips weight → count → weight monotonically", () => {
    const unit = 8;
    const target = 150;
    const n = piecesForWeight(target, unit);
    expect(weightForPieces(n, unit)).toBeGreaterThanOrEqual(target);
  });
});

describe("resolveFillCount", () => {
  it("uses the entered count in count mode", () => {
    expect(
      resolveFillCount({ mode: "count", count: 18, targetWeight: 999, unitWeight: 8 }),
    ).toBe(18);
  });

  it("derives count from weight in weight mode", () => {
    expect(
      resolveFillCount({ mode: "weight", count: 5, targetWeight: 150, unitWeight: 8 }),
    ).toBe(19);
  });

  it("clamps to [1, MAX_PIECES]", () => {
    expect(
      resolveFillCount({ mode: "count", count: 5000, targetWeight: 0, unitWeight: 8 }),
    ).toBe(MAX_PIECES);
    expect(
      resolveFillCount({ mode: "count", count: 0, targetWeight: 0, unitWeight: 8 }),
    ).toBe(1);
  });

  it("rounds a fractional count entry", () => {
    expect(
      resolveFillCount({ mode: "count", count: 18.6, targetWeight: 0, unitWeight: 8 }),
    ).toBe(19);
  });
});
