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
  pruneBuildForRealm,
  shipUpgradeSlots,
  signalsFor,
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

describe("signalsFor", () => {
  it("defaults to the WG catalog (lineup defaults stay WG)", () => {
    expect(signalsFor()).toBe(SIGNALS);
    expect(SIGNALS).toHaveLength(14);
    expect(SIGNALS.every((s) => s.index.startsWith("PCEF0"))).toBe(true);
    expect(SIGNALS.every((s) => s.group === undefined && s.tier === undefined && s.family === undefined)).toBe(true);
  });

  it("the Lesta catalog: 24 entries in 6 families × 4 tiers", () => {
    const list = signalsFor("lesta");
    expect(list).toHaveLength(24);
    const groups = new Map<string, number[]>();
    for (const s of list) {
      expect(s.group).toBeDefined();
      expect(s.tier).toBeGreaterThanOrEqual(1);
      expect(s.tier).toBeLessThanOrEqual(4);
      groups.set(s.group!, [...(groups.get(s.group!) ?? []), s.tier!]);
    }
    expect(groups.size).toBe(6);
    expect([...groups.keys()].sort()).toEqual(["charlie", "foxtrot", "india", "november", "sierra", "yankee"]);
    for (const tiers of groups.values()) {
      expect([...tiers].sort()).toEqual([1, 2, 3, 4]);
    }
    // family art stems as documented (the icon files share the stem)
    const fams = new Set(list.map((s) => s.family));
    expect([...fams].sort()).toEqual(["ATBA", "Consumable", "GM", "HPBoost", "Shift", "Speed"]);
  });

  it("Lesta indices are unique and disjoint from the WG ones", () => {
    const lesta = signalsFor("lesta").map((s) => s.index);
    expect(new Set(lesta).size).toBe(24);
    expect(lesta.filter((i) => SIGNALS.some((s) => s.index === i))).toEqual([]);
    expect(lesta.every((i) => /^PCEF1[0-5][0-9]$/.test(i))).toBe(true);
  });

  it("sortOrder is strictly ascending in both catalogs", () => {
    for (const list of [SIGNALS, signalsFor("lesta")]) {
      const orders = list.map((s) => s.sortOrder);
      for (let i = 1; i < orders.length; i++) {
        expect(orders[i]).toBeGreaterThan(orders[i - 1]);
      }
    }
  });

  it("every Lesta entry resolves its icon stem from the shipped art", () => {
    // Same glob+stem contract BuildPlanner's signalIconUrl uses.
    const stems = new Set(
      Object.keys(import.meta.glob("../../res/images/signals/*.webp")).map(
        (p) => p.split("/").pop()!.replace(/\.webp$/i, "").toLowerCase(),
      ),
    );
    expect(stems.size).toBeGreaterThanOrEqual(24);
    for (const s of signalsFor("lesta")) {
      expect(stems.has(s.name.toLowerCase()), `${s.index} (${s.name})`).toBe(true);
    }
  });

  it("Lesta flavor descs are empty today (hover card renders no flavor line)", () => {
    for (const s of signalsFor("lesta")) {
      expect(Object.keys(s.desc ?? {})).toHaveLength(0);
    }
  });
});

describe("pruneBuildForRealm", () => {
  const TREE = new Set(["GmShellReload", "TorpedoReload"]);
  const SIGS = new Set(["PCEF101", "PCEF102"]);
  const CMDS = new Set(["PAW100_Willis_Lee"]);

  it("returns null when the build already belongs to the realm", () => {
    expect(
      pruneBuildForRealm({ skills: { GmShellReload: 1 }, signals: ["PCEF101"], commander: null }, TREE, SIGS, CMDS),
    ).toBeNull();
  });

  it("drops skill codes the active realm's tree does not know", () => {
    const out = pruneBuildForRealm(
      { skills: { GmShellReload: 1, PlanesConsumablesActiveManeuveringUpgrade: 1 }, signals: [], commander: null },
      TREE, SIGS, CMDS,
    )!;
    expect(out.skills).toEqual({ GmShellReload: 1 });
    expect(out.signals).toEqual([]);
    expect(out.commander).toBeNull();
  });

  it("filters signal indices outside the active catalog (WG ⇄ Lesta are disjoint)", () => {
    const out = pruneBuildForRealm(
      { skills: {}, signals: ["PCEF101", "PCEF005", "PCEF102"], commander: null },
      TREE, SIGS, CMDS,
    )!;
    expect(out.signals).toEqual(["PCEF101", "PCEF102"]);
  });

  it("nulls a commander missing from the active roster, keeps a present one", () => {
    expect(
      pruneBuildForRealm({ skills: {}, signals: [], commander: "PASD001_Halsey" }, TREE, SIGS, CMDS)!.commander,
    ).toBeNull();
    // Willis_Lee present + everything in catalog → no patch at all.
    expect(
      pruneBuildForRealm({ skills: {}, signals: ["PCEF102"], commander: "PAW100_Willis_Lee" }, TREE, SIGS, CMDS),
    ).toBeNull();
  });

  it("one patch carries all three slices at once", () => {
    const out = pruneBuildForRealm(
      { skills: { Dead: 1 }, signals: ["PCEF005"], commander: "Gone" },
      TREE, SIGS, CMDS,
    )!;
    expect(out).toEqual({ skills: {}, signals: [], commander: null });
  });
});
