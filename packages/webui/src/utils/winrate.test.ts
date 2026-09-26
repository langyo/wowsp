import { beforeAll, describe, expect, it } from "vitest";

import { initLocaleMessages } from "@/i18n";
import { statsPrefsState } from "@/stores/statsPrefs";

import {
  PR_TIER_STANDARD_LABELS,
  RAT_CLAN_WINRATE_MAX,
  careerStamp,
  compositionStamps,
  prTier,
  prTierLabel,
} from "./winrate";

// prTierLabel resolves through vue-i18n; locale messages load lazily now,
// so the wording cases need the bundle in place before they assert.
beforeAll(async () => {
  await initLocaleMessages();
});

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

describe("prTierLabel", () => {
  // The prefs knob is module state — snapshot and restore around each case
  // so the suite stays order-independent.
  const initial = { ...statsPrefsState.value };

  it("renders the localized wording while localizedTiers is on", () => {
    statsPrefsState.value.localizedTiers = true;
    // Any installed locale resolves to real message text, never the raw
    // "stats.<key>" path.
    expect(prTierLabel("tierBad")).not.toBe("stats.tierBad");
  });

  it("renders the unknown dash under both wordings", () => {
    statsPrefsState.value.localizedTiers = true;
    expect(prTierLabel("unknown")).toBe("—");
    statsPrefsState.value.localizedTiers = false;
    expect(prTierLabel("unknown")).toBe("—");
  });

  it("switches to the standard English bands when localizedTiers is off", () => {
    statsPrefsState.value.localizedTiers = false;
    for (const [key, label] of Object.entries(PR_TIER_STANDARD_LABELS)) {
      if (key === "unknown") continue;
      expect(prTierLabel(key)).toBe(label);
    }
    // An unrecognized key degrades to the unknown dash, never a raw path.
    expect(prTierLabel("tierWhat")).toBe("—");
  });

  it("reads the live prefs state (a settings toggle flips the wording)", () => {
    statsPrefsState.value.localizedTiers = false;
    expect(prTierLabel("tierUnicum")).toBe("Unicum");
    statsPrefsState.value.localizedTiers = true;
    expect(prTierLabel("tierUnicum")).not.toBe("Unicum");
  });

  it("restores the prefs state it mutated", () => {
    statsPrefsState.value.localizedTiers = initial.localizedTiers;
    expect(typeof statsPrefsState.value.localizedTiers).toBe("boolean");
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

  it("excuses a hidden profile whose clan beats the winrate gate", () => {
    expect(careerStamp(null, null, null, true, 53.4)).toBeNull();
    expect(careerStamp(null, null, null, true, 60)).toBeNull();
    // The gate keys on the clan alone — even a red-tier career is excused.
    expect(careerStamp(400, 30, 39.9, true, 55)).toBeNull();
    expect(careerStamp(null, null, null, true, RAT_CLAN_WINRATE_MAX + 0.1)).toBeNull();
  });

  it("keeps the rat stamp at or below the clan gate threshold", () => {
    expect(careerStamp(null, null, null, true, 51)).toBe("rat");
    // Exactly 53.0 is not ABOVE the threshold — still stamped.
    expect(careerStamp(null, null, null, true, 53)).toBe("rat");
    expect(careerStamp(null, null, null, true, 0)).toBe("rat");
    expect(careerStamp(null, null, null, true, RAT_CLAN_WINRATE_MAX)).toBe("rat");
  });

  it("stamps fail-open when the clan verdict is missing or failed", () => {
    expect(careerStamp(null, null, null, true, null)).toBe("rat");
    expect(careerStamp(null, null, null, true, undefined)).toBe("rat");
  });

  it("ignores the clan verdict for visible profiles", () => {
    // A strong-clan verdict must not change any non-hidden verdict.
    expect(careerStamp(2600, 3000, 60, false, 90)).toBe("miracle");
    expect(careerStamp(400, 30, 39.9, false, 90)).toBe("maggot");
    expect(careerStamp(750, 10000, 30, false, 90)).toBeNull();
    expect(careerStamp(null, null, null, false, 90)).toBeNull();
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
