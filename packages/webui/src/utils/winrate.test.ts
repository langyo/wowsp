import { describe, expect, it } from "vitest";

import { careerStamp, compositionStamps, prTier } from "./winrate";

describe("prTier", () => {
  it("falls back to unknown for missing PR", () => {
    expect(prTier(null).key).toBe("unknown");
    expect(prTier(undefined).key).toBe("unknown");
  });

  it("puts each band boundary on the ApeRadar-aligned scale", () => {
    expect(prTier(0).key).toBe("tierBad");
    expect(prTier(749).key).toBe("tierBad");
    expect(prTier(750).key).toBe("tierBelowAvg");
    expect(prTier(1349).key).toBe("tierBelowAvg");
    expect(prTier(1350).key).toBe("tierAvg");
    expect(prTier(1749).key).toBe("tierAvg");
    expect(prTier(1750).key).toBe("tierGood");
    expect(prTier(2099).key).toBe("tierGood");
    expect(prTier(2100).key).toBe("tierGreat");
    expect(prTier(2449).key).toBe("tierGreat");
    expect(prTier(2450).key).toBe("tierUnicum");
  });

  it("renders only the top band as the rainbow 彩表", () => {
    expect(prTier(2450).rainbow).toBe(true);
    expect(prTier(3000).rainbow).toBe(true);
    for (const pr of [0, 800, 1400, 1800, 2200]) {
      expect(prTier(pr).rainbow).toBeUndefined();
      expect(prTier(pr).color).toBeTruthy();
    }
  });
});

describe("careerStamp", () => {
  it("stamps 海猴 on red-tier careers with a 40%+ winrate", () => {
    expect(careerStamp(400, 30, 45)).toBe("ape");
    expect(careerStamp(749, null, 40)).toBe("ape");
  });

  it("stamps 蛆 instead when the red-tier winrate is sub-40%", () => {
    expect(careerStamp(400, 30, 39.9)).toBe("maggot");
    expect(careerStamp(749, 3000, 20)).toBe("maggot");
    // An unknown winrate falls back to 海猴 rather than assuming the worst.
    expect(careerStamp(749, null, null)).toBe("ape");
  });

  it("stamps 过街老鼠 on hidden profiles regardless of anything else", () => {
    expect(careerStamp(null, null, null, true)).toBe("rat");
    expect(careerStamp(2600, 3000, 60, true)).toBe("rat");
    expect(careerStamp(400, 30, 39.9, true)).toBe("rat");
  });

  it("stamps 神了 only on sustained purple-tier+ careers", () => {
    expect(careerStamp(2100, 500, 55)).toBe("miracle");
    expect(careerStamp(2600, 3000, 60)).toBe("miracle");
    // Short purple careers are not 长期 yet.
    expect(careerStamp(2300, 200, 55)).toBeNull();
    expect(careerStamp(2300, null, 55)).toBeNull();
  });

  it("leaves mid bands and unknown careers unstamped", () => {
    expect(careerStamp(750, 10000, 30)).toBeNull();
    expect(careerStamp(2099, 10000, 55)).toBeNull();
    expect(careerStamp(null, 10000, 50)).toBeNull();
  });
});

describe("compositionStamps", () => {
  const typeOf = new Map<number, string>([
    [1, "AirCarrier"],
    [2, "Submarine"],
    [3, "Cruiser"],
  ]);
  const type = (id: number) => typeOf.get(id);

  function rows(...pairs: [number, number][]) {
    return pairs.map(([shipId, battles]) => ({ shipId, battles }));
  }

  it("marks a CV-dominant career above the 200-battle gate", () => {
    // 350 total battles, 100 in CVs (>20%), no subs.
    const st = compositionStamps(rows([1, 100], [3, 250]), type);
    expect(st.air).toBe(true);
    expect(st.sub).toBe(false);
  });

  it("marks sub mains independently", () => {
    const st = compositionStamps(rows([2, 150], [3, 100]), type);
    expect(st.air).toBe(false);
    expect(st.sub).toBe(true);
  });

  it("requires strictly more than the 20% share", () => {
    // 100/500 = exactly 20% → not over the line.
    const st = compositionStamps(rows([1, 100], [3, 400]), type);
    expect(st.air).toBe(false);
  });

  it("never marks careers at or below the 200-battle gate", () => {
    expect(compositionStamps(rows([1, 150], [3, 50]), type)).toEqual({ air: false, sub: false });
    expect(compositionStamps(rows([1, 200]), type).air).toBe(false);
  });

  it("handles empty rosters and unknown ship types", () => {
    expect(compositionStamps([], type)).toEqual({ air: false, sub: false });
    // A career of only untyped ships can never earn the marks.
    const st = compositionStamps(rows([9, 500]), () => undefined);
    expect(st).toEqual({ air: false, sub: false });
  });
});
