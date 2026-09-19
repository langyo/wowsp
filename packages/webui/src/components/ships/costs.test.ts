/** Tests for the build-cost math: the skill-point CXP curve matches the
 *  official wiki table (685,500 CXP buys all 21 points), out-of-range and
 *  zero inputs clamp safely, and the price lookup accepts both full entity
 *  names and bare indexes. */
import { describe, expect, it } from "vitest";

import { cxpForPoints, priceOf, retrainCredits } from "./costs";

describe("cxpForPoints", () => {
  it("follows the wiki cumulative table", () => {
    expect(cxpForPoints(1)).toBe(1_500);
    expect(cxpForPoints(10)).toBe(46_500);
    expect(cxpForPoints(21)).toBe(685_500);
  });

  it("clamps below one and beyond the table", () => {
    expect(cxpForPoints(0)).toBe(0);
    expect(cxpForPoints(-3)).toBe(0);
    expect(cxpForPoints(25)).toBe(685_500);
  });
});

describe("retrainCredits", () => {
  it("scales linearly per point", () => {
    expect(retrainCredits(0)).toBe(0);
    expect(retrainCredits(21)).toBe(2_100_000);
  });
});

describe("priceOf", () => {
  const prices = {
    PCM027: { name: "PCM027_ConcealmentMeasures_Mod_I", cost: 1_450_000 },
    PCM020_DamageControlSystem_Mod_I: { name: "PCM020_DamageControlSystem_Mod_I", cost: 1_250_000 },
  };
  it("resolves full entity names and bare indexes", () => {
    expect(priceOf(prices, "PCM027_ConcealmentMeasures_Mod_I")).toBe(1_450_000);
    expect(priceOf(prices, "PCM020_DamageControlSystem_Mod_I")).toBe(1_250_000);
  });
  it("resolves bare indexes via the index key", () => {
    expect(priceOf(prices, "PCM027")).toBe(1_450_000);
  });

  it("returns null for unknown items or no data", () => {
    expect(priceOf(prices, "PCM999_Unknown_Mod")).toBeNull();
    expect(priceOf(null, "PCM027")).toBeNull();
  });
});
