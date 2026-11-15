/** Tests for the 装备槽位 hover-card helpers (upgradeEffects.ts).
 *
 *  The semantics pinned here are the ones the card's coloring/formatting
 *  depends on: which modernizations are Research-Bureau items (the 19,200 RP
 *  purchase row rides ONLY those), how each modifier-value grammar renders,
 *  and which direction reads as a perk vs. a trade — all Vue-free pure
 *  functions, so a data refresh cannot silently flip a green into a red.
 */
import { describe, expect, it } from "vitest";

import {
  isResearchBureauUpgrade,
  RB_UNIQUE_UPGRADE_RP,
  upgradeEffectRows,
  upgradeEffectValue,
} from "./upgradeEffects";

/** Stand-in catalog probe: the flags catalog covers a fixed set, the
 *  upgrades catalog one key (to exercise the fallback preference). */
const hasMsg = (key: string) => {
  const covered = new Set([
    "ships.flags.effect.GSMaxDist",
    "ships.flags.effect.planeHealthCoeff",
    "ships.upgrades.effect.GMMaxDist",
  ]);
  return covered.has(key);
};

describe("isResearchBureauUpgrade", () => {
  it("flags the unique slot-5/6 legendary upgrades", () => {
    expect(isResearchBureauUpgrade({ slot: 5, tags: ["unique"] })).toBe(true);
    expect(isResearchBureauUpgrade({ slot: 4, tags: ["unique"] })).toBe(true);
  });

  it("excludes event/uniqueness outside the legendary slots", () => {
    // The Siegfried-event PXM* set and the modern-ship PCM107-118 sets are
    // unique-tagged but not Research-Bureau purchases.
    expect(isResearchBureauUpgrade({ slot: 0, tags: ["unique"] })).toBe(false);
    expect(isResearchBureauUpgrade({ slot: 2, tags: ["unique"] })).toBe(false);
    expect(isResearchBureauUpgrade({ slot: 5, tags: [] })).toBe(false);
    expect(isResearchBureauUpgrade({ slot: 5 })).toBe(false);
  });

  it("pins the Research-Bureau price constant", () => {
    expect(RB_UNIQUE_UPGRADE_RP).toBe(19200);
  });
});

describe("upgradeEffectValue", () => {
  it("resolves per-class dicts for the ship's own class", () => {
    const dict = { Battleship: 1.5, Destroyer: 2 };
    expect(upgradeEffectValue(dict, "Destroyer")).toBe(2);
  });

  it("drops a dict that does not list the ship's class", () => {
    expect(upgradeEffectValue({ Battleship: 1.5 }, "Destroyer")).toBeNull();
  });

  it("ignores non-finite numbers", () => {
    expect(upgradeEffectValue(Number.NaN, "Destroyer")).toBeNull();
    expect(upgradeEffectValue("0.8", "Destroyer")).toBeNull();
  });
});

describe("upgradeEffectRows", () => {
  it("formats multiplier rows as signed percentages", () => {
    const rows = upgradeEffectRows(
      { GMShotDelay: 0.75, GMMaxDist: 1.1 },
      "Destroyer",
      hasMsg,
    );
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("GMShotDelay")).toMatchObject({ text: "−25%", good: true });
    expect(byKey.get("GMMaxDist")).toMatchObject({ text: "+10%", good: true });
  });

  it("marks a traverse-speed cut as the trade it is", () => {
    const rows = upgradeEffectRows({ GTRotationSpeed: 0.3 }, "Destroyer", hasMsg);
    expect(rows[0]).toMatchObject({ key: "GTRotationSpeed", text: "−70%", good: false });
  });

  it("marks a vulnerability increase as a regression", () => {
    const rows = upgradeEffectRows({ vulnerabilityAll: 1.25 }, "Destroyer", hasMsg);
    expect(rows[0]).toMatchObject({ text: "+25%", good: false });
  });

  it("renders additive counts for charge keys (negative trades included)", () => {
    const rows = upgradeEffectRows(
      { additionalConsumables: 1, smokeGeneratorAdditionalConsumables: -2 },
      "Destroyer",
      hasMsg,
    );
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("additionalConsumables")).toMatchObject({ text: "+1", good: true });
    expect(byKey.get("smokeGeneratorAdditionalConsumables")).toMatchObject({
      text: "−2",
      good: false,
    });
  });

  it("renders aiming penalties in seconds and raw-meter distances in metres", () => {
    const rows = upgradeEffectRows(
      { torpedoBomberAimingTime: 5, visionXRayTorpedoDist: 1800 },
      "Destroyer",
      hasMsg,
    );
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("torpedoBomberAimingTime")).toMatchObject({ text: "+5 s", good: false });
    expect(byKey.get("visionXRayTorpedoDist")).toMatchObject({ text: "+1800 m", good: true });
  });

  it("renders fraction-of-1 regeneration and boost keys as plain percents", () => {
    const rows = upgradeEffectRows(
      { healthRegenPercent: 0.15, boostCoeffForsage: 0.12 },
      "Destroyer",
      hasMsg,
    );
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("healthRegenPercent")).toMatchObject({ text: "+15%", good: true });
    expect(byKey.get("boostCoeffForsage")).toMatchObject({ text: "+12%", good: true });
  });

  it("prefers the flags label catalog, then the upgrades catalog, else the raw key", () => {
    const rows = upgradeEffectRows(
      { GSMaxDist: 1.05, GMMaxDist: 1.1, oddUnmappedKey: 0.9 },
      "Destroyer",
      hasMsg,
    );
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("GSMaxDist")?.labelKey).toBe("ships.flags.effect.GSMaxDist");
    // Not in the flags catalog → the upgrades catalog wins when it has it...
    expect(byKey.get("GMMaxDist")?.labelKey).toBe("ships.upgrades.effect.GMMaxDist");
    expect(byKey.get("oddUnmappedKey")?.labelKey).toBeNull();
  });

  it("shows ±0% as neutral (no good/bad tint) and drops inapplicable dicts", () => {
    const rows = upgradeEffectRows(
      { hydrophoneWaveSpeedCoeff: 1, AAMaxHP: { Battleship: 2 } },
      "Destroyer",
      hasMsg,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "hydrophoneWaveSpeedCoeff", text: "±0%", good: true });
  });
});
