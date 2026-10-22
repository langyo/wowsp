/**
 * buildDefaults unit tests — the lineup's "maxed but standard" default
 * loadout over the real baked planner data (skilltree / crew presets /
 * modernizations / signals are imported by the module itself).
 */
import { describe, expect, it } from "vitest";
import {
  budgetedRecommendedSkills,
  defaultBuildFor,
  MODERNIZATIONS,
  shipUpgradeSlots,
  SIGNALS,
  upgradeMountable,
} from "./buildDefaults";
import { classSkills, skillClassFor, skillCost, SKILL_BUDGET } from "./skillTree";

/** Yamato's tech-tree identity (tech_tree.json): index, class, tier. */
const YAMATO = { shipId: 4_276_041_424, type: "Battleship", nation: "japan", tier: 10 };
const YAMATO_INDEX = "PJSB018";

function pointsSpent(skills: Record<string, 1>): number {
  const byCode = new Map(classSkills(skillClassFor(YAMATO.type)).map((s) => [s.code, s]));
  return Object.keys(skills).reduce((sum, code) => sum + (byCode.get(code)?.tier
    ? skillCost(byCode.get(code)!.tier)
    : 0), 0);
}

describe("shipUpgradeSlots", () => {
  it("unlocks slots by tier (1 @T1, +1 each at T3/T5/T6/T8/T9)", () => {
    expect(shipUpgradeSlots(1)).toEqual([0]);
    expect(shipUpgradeSlots(5)).toEqual([0, 1, 2]);
    expect(shipUpgradeSlots(8)).toHaveLength(5);
    expect(shipUpgradeSlots(10)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("budgetedRecommendedSkills", () => {
  it("returns the in-game recommended set within the 21-point budget", () => {
    const skills = budgetedRecommendedSkills(YAMATO_INDEX, YAMATO.type);
    expect(Object.keys(skills).length).toBeGreaterThan(0);
    expect(pointsSpent(skills)).toBeLessThanOrEqual(SKILL_BUDGET);
  });

  it("an unknown tree index yields an empty set (graceful)", () => {
    expect(budgetedRecommendedSkills(null, "Battleship")).toEqual({});
  });
});

describe("defaultBuildFor", () => {
  it("stamps a full standard loadout: all signals, one regular mod per slot, recommended skills, standard captain", () => {
    const build = defaultBuildFor(YAMATO, YAMATO_INDEX);

    expect(build.commander).toBeNull();
    expect(build.healthPct).toBe(1);

    // Every combat signal flying.
    expect(build.signals).toEqual(SIGNALS.map((s) => s.index));

    // One mountable, non-unique modernization per unlocked slot.
    expect(Object.keys(build.upgrades).map(Number).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    for (const [slot, name] of Object.entries(build.upgrades)) {
      const mod = MODERNIZATIONS.find((m) => m.name === name);
      expect(mod, `slot ${slot} picks a catalog mod`).toBeDefined();
      expect(mod!.slot).toBe(Number(slot));
      expect(mod!.tags?.includes("unique")).toBeFalsy();
      expect(upgradeMountable(mod!, YAMATO, YAMATO_INDEX)).toBe(true);
    }

    // The recommended skill set, within budget.
    expect(pointsSpent(build.skills)).toBeLessThanOrEqual(SKILL_BUDGET);
    expect(Object.keys(build.skills).length).toBeGreaterThan(0);
  });

  it("never picks unique gear even when a slot's catalog starts with it", () => {
    const build = defaultBuildFor(YAMATO, YAMATO_INDEX);
    for (const name of Object.values(build.upgrades)) {
      const mod = MODERNIZATIONS.find((m) => m.name === name)!;
      expect(mod.tags ?? []).not.toContain("unique");
    }
  });
});
