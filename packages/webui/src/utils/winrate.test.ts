import { beforeAll, describe, expect, it } from "vitest";

import { initLocaleMessages } from "@/i18n";
import { statsPrefsState } from "@/stores/statsPrefs";

import {
  PR_TIER_STANDARD_LABELS,
  RAT_CLAN_WINRATE_MAX,
  careerStamp,
  compositionStamps,
  isMergedStamp,
  prTier,
  prTierLabel,
  resolveStamps,
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
  it("stamps 猴 on red-tier careers with a 40%+ winrate", () => {
    expect(careerStamp(400, 30, 45)).toBe("ape");
    expect(careerStamp(749, null, 40)).toBe("ape");
  });

  it("stamps 蛆 instead when the red-tier winrate is sub-40%", () => {
    expect(careerStamp(400, 30, 39.9)).toBe("maggot");
    expect(careerStamp(749, 3000, 20)).toBe("maggot");
    // An unknown winrate falls back to 猴 rather than assuming the worst.
    expect(careerStamp(749, null, null)).toBe("ape");
  });

  it("stamps 过街老鼠 on hidden profiles unless 神了 qualifies", () => {
    expect(careerStamp(null, null, null, true)).toBe("rat");
    expect(careerStamp(400, 30, 39.9, true)).toBe("rat");
    // One stamp, priority: a sustained purple career outranks 过街老鼠 —
    // the PR evidence stands on its own even behind a hidden profile.
    expect(careerStamp(2600, 3000, 60, true)).toBe("miracle");
    // Short purple + hidden: 神了 doesn't qualify, the hidden verdict applies.
    expect(careerStamp(2300, 200, 55, true)).toBe("rat");
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
    expect(st.airVeteran).toBe(false);
    expect(st.subVeteran).toBe(false);
  });

  it("marks sub mains independently", () => {
    // 250 total battles, 150 in subs (60% — already the veteran tier), no CVs.
    const st = compositionStamps(rows([2, 150], [3, 100]), type);
    expect(st.air).toBe(false);
    expect(st.sub).toBe(true);
    expect(st.airVeteran).toBe(false);
    expect(st.subVeteran).toBe(true);
  });

  it("requires strictly more than the 20% share", () => {
    // 100/500 = exactly 20% → not over the line.
    const st = compositionStamps(rows([1, 100], [3, 400]), type);
    expect(st.air).toBe(false);
  });

  it("upgrades to the veteran seal past 50% share, strictly", () => {
    // 500/1000 = exactly 50% → the minor tag, NOT the veteran tier.
    const st = compositionStamps(rows([1, 500], [3, 500]), type);
    expect(st.air).toBe(true);
    expect(st.airVeteran).toBe(false);
    // 501/1000 crosses the line; the veteran tier implies the base flag.
    const up = compositionStamps(rows([1, 501], [3, 499]), type);
    expect(up.air).toBe(true);
    expect(up.airVeteran).toBe(true);
    // Same bound on the submarine side, judged independently.
    const subUp = compositionStamps(rows([2, 501], [3, 499]), type);
    expect(subUp.sub).toBe(true);
    expect(subUp.subVeteran).toBe(true);
    expect(subUp.air).toBe(false);
    expect(subUp.airVeteran).toBe(false);
  });

  it("never marks careers at or below the 200-battle gate", () => {
    expect(compositionStamps(rows([1, 150], [3, 50]), type)).toEqual({
      air: false,
      sub: false,
      airVeteran: false,
      subVeteran: false,
    });
    expect(compositionStamps(rows([1, 200]), type).air).toBe(false);
    expect(compositionStamps(rows([1, 200]), type).airVeteran).toBe(false);
  });

  it("handles empty rosters and unknown ship types", () => {
    expect(compositionStamps([], type)).toEqual({
      air: false,
      sub: false,
      airVeteran: false,
      subVeteran: false,
    });
    // A career of only untyped ships can never earn the marks.
    const st = compositionStamps(rows([9, 500]), () => undefined);
    expect(st).toEqual({ air: false, sub: false, airVeteran: false, subVeteran: false });
  });
});

describe("resolveStamps", () => {
  // The minor-tier composition shape, spelled out — the veteran fields ride
  // along false in every non-veteran row below.
  const comp = (air: boolean, sub: boolean) => ({
    air,
    sub,
    airVeteran: false,
    subVeteran: false,
  });

  it("merges miracle + sub into 水下神人 alone (consumes both constituents)", () => {
    expect(resolveStamps("miracle", comp(false, true))).toEqual(["subMiracle"]);
  });

  it("merges miracle + air into 空中神人 alone", () => {
    expect(resolveStamps("miracle", comp(true, false))).toEqual(["airMiracle"]);
  });

  it("renders exactly both merged seals, sub first, when everything fires", () => {
    expect(resolveStamps("miracle", comp(true, true))).toEqual([
      "subMiracle",
      "airMiracle",
    ]);
  });

  it("keeps the legacy order when no merge fires", () => {
    expect(resolveStamps("miracle", null)).toEqual(["miracle"]);
    expect(resolveStamps("miracle", comp(false, false))).toEqual(["miracle"]);
    expect(resolveStamps("miracle", undefined)).toEqual(["miracle"]);
    expect(resolveStamps(null, comp(true, false))).toEqual(["air"]);
    expect(resolveStamps(null, comp(false, true))).toEqual(["sub"]);
    expect(resolveStamps(null, comp(true, true))).toEqual(["air", "sub"]);
  });

  it("merges ape + sub into 水下小猴 alone (consumes both constituents)", () => {
    expect(resolveStamps("ape", comp(false, true))).toEqual(["subApe"]);
  });

  it("merges ape + air into 空中小猴 alone", () => {
    expect(resolveStamps("ape", comp(true, false))).toEqual(["airApe"]);
  });

  it("renders exactly both ape merges, sub first, when everything fires", () => {
    expect(resolveStamps("ape", comp(true, true))).toEqual(["subApe", "airApe"]);
  });

  it("keeps a lone ape verdict as plain 猴", () => {
    expect(resolveStamps("ape", null)).toEqual(["ape"]);
    expect(resolveStamps("ape", comp(false, false))).toEqual(["ape"]);
  });

  it("suppresses composition entirely for the maggot verdict (no merged seal)", () => {
    expect(resolveStamps("maggot", { air: true, sub: false, airVeteran: false, subVeteran: false })).toEqual(["maggot"]);
    expect(resolveStamps("maggot", { air: false, sub: true, airVeteran: false, subVeteran: false })).toEqual(["maggot"]);
    expect(resolveStamps("maggot", { air: true, sub: true, airVeteran: true, subVeteran: true })).toEqual(["maggot"]);
    expect(resolveStamps("maggot", null)).toEqual(["maggot"]);
  });

  it("suppresses composition entirely for the rat verdict too", () => {
    // A hidden profile's stats are invisible — no evaluation possible, so
    // the rat verdict stands alone at the same floor shape as 蛆.
    expect(resolveStamps("rat", { air: true, sub: false, airVeteran: false, subVeteran: false })).toEqual(["rat"]);
    expect(resolveStamps("rat", { air: false, sub: true, airVeteran: false, subVeteran: true })).toEqual(["rat"]);
    expect(resolveStamps("rat", { air: true, sub: true, airVeteran: true, subVeteran: true })).toEqual(["rat"]);
    expect(resolveStamps("rat", null)).toEqual(["rat"]);
  });

  it("emits the veteran seal in place of the minor tag per class", () => {
    // Null career: air leads, sub follows, each at its own tier.
    expect(
      resolveStamps(null, { air: true, sub: true, airVeteran: false, subVeteran: true }),
    ).toEqual(["air", "subVeteran"]);
    expect(
      resolveStamps(null, { air: true, sub: false, airVeteran: true, subVeteran: false }),
    ).toEqual(["airVeteran"]);
    expect(
      resolveStamps(null, { air: false, sub: true, airVeteran: false, subVeteran: true }),
    ).toEqual(["subVeteran"]);
    // A visible career without a merge rides the same tiered pass-through.
    expect(
      resolveStamps(null, { air: true, sub: true, airVeteran: true, subVeteran: false }),
    ).toEqual(["airVeteran", "sub"]);
  });

  it("merges veterans into the plain merged face (tier not distinguished)", () => {
    // 照常合并: the merged seal consumes the veteran tier — no 水下神人·老人
    // exists, the merge fires on the class tag alone.
    expect(
      resolveStamps("miracle", { air: false, sub: true, airVeteran: false, subVeteran: true }),
    ).toEqual(["subMiracle"]);
    expect(
      resolveStamps("miracle", { air: true, sub: true, airVeteran: true, subVeteran: true }),
    ).toEqual(["subMiracle", "airMiracle"]);
    expect(
      resolveStamps("ape", { air: true, sub: false, airVeteran: true, subVeteran: false }),
    ).toEqual(["airApe"]);
  });

  it("returns nothing for absent inputs", () => {
    expect(resolveStamps(null, null)).toEqual([]);
    expect(resolveStamps(null, undefined)).toEqual([]);
    expect(resolveStamps(null, { air: false, sub: false, airVeteran: false, subVeteran: false })).toEqual([]);
  });

  it("flags every merged kind through isMergedStamp, and only those", () => {
    for (const kind of ["airMiracle", "subMiracle", "airApe", "subApe"] as const) {
      expect(isMergedStamp(kind)).toBe(true);
    }
    for (const kind of [
      "miracle",
      "ape",
      "maggot",
      "rat",
      "air",
      "sub",
      "airVeteran",
      "subVeteran",
    ] as const) {
      expect(isMergedStamp(kind)).toBe(false);
    }
  });
});
