import { describe, expect, it } from "vitest";

import { careerStamp, prTier } from "./winrate";

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
  it("stamps 海猴 on red-tier careers regardless of battles", () => {
    expect(careerStamp(400, 30)).toBe("ape");
    expect(careerStamp(749, null)).toBe("ape");
  });

  it("stamps 神了 only on sustained purple-tier+ careers", () => {
    expect(careerStamp(2100, 500)).toBe("miracle");
    expect(careerStamp(2600, 3000)).toBe("miracle");
    // Short purple careers are not 长期 yet.
    expect(careerStamp(2300, 200)).toBeNull();
    expect(careerStamp(2300, null)).toBeNull();
  });

  it("leaves mid bands and unknown careers unstamped", () => {
    expect(careerStamp(750, 10000)).toBeNull();
    expect(careerStamp(2099, 10000)).toBeNull();
    expect(careerStamp(null, 10000)).toBeNull();
  });
});
