/** Tests for the commander-skill point math: each skill costs as many
 *  points as its tier row (1–4), the 21-pt budget is tracked against that
 *  weighted sum, and the tier-row unlock gates compare points (not skill
 *  counts) spent in lower tiers. */
import { describe, expect, it } from "vitest";

import {
  classSkills,
  recommendedSkills,
  SKILL_BUDGET,
  skillAffordable,
  skillCost,
  skillPointsBelow,
  skillPointsSpent,
  skillTierGaps,
  TIER_UNLOCK,
  type Skill,
} from "./skillTree";

const TREE: Skill[] = [
  { code: "One", tier: 1, column: 0, name: {}, desc: {} },
  { code: "OneB", tier: 1, column: 1, name: {}, desc: {} },
  { code: "OneC", tier: 1, column: 2, name: {}, desc: {} },
  { code: "Two", tier: 2, column: 0, name: {}, desc: {} },
  { code: "TwoB", tier: 2, column: 1, name: {}, desc: {} },
  { code: "Three", tier: 3, column: 0, name: {}, desc: {} },
  { code: "ThreeB", tier: 3, column: 1, name: {}, desc: {} },
  { code: "Four", tier: 4, column: 0, name: {}, desc: {} },
  { code: "FourB", tier: 4, column: 1, name: {}, desc: {} },
];

const pick = (...codes: string[]) => Object.fromEntries(codes.map((c) => [c, 1 as const]));

describe("skillCost", () => {
  it("charges each skill its tier row", () => {
    expect([1, 2, 3, 4].map(skillCost)).toEqual([1, 2, 3, 4]);
  });
});

describe("skillAffordable", () => {
  it("greys exactly the rows the remaining points can no longer buy", () => {
    // Remaining 3/2/1/0 pts makes tiers 4/3/2/1 the newest unaffordable row,
    // and everything dearer stays greyed too (cumulative, like the game).
    const row = (remaining: number) => [1, 2, 3, 4].map((tier) => skillAffordable(tier, remaining));
    expect(row(21)).toEqual([true, true, true, true]);
    expect(row(3)).toEqual([true, true, true, false]);
    expect(row(2)).toEqual([true, true, false, false]);
    expect(row(1)).toEqual([true, false, false, false]);
    expect(row(0)).toEqual([false, false, false, false]);
    expect(row(-1)).toEqual([false, false, false, false]);
  });
});

describe("skillPointsSpent", () => {
  it("counts nothing on an empty selection", () => {
    expect(skillPointsSpent({}, TREE)).toBe(0);
  });

  it("weights each picked skill by its tier row", () => {
    expect(skillPointsSpent(pick("One", "Two", "Three", "Four"), TREE)).toBe(10);
  });

  it("matches the in-game 19-pt flagship build (1×T1, 2×T2, 2×T3, 2×T4)", () => {
    const picked = pick("One", "Two", "TwoB", "Three", "ThreeB", "Four", "FourB");
    expect(Object.keys(picked).length).toBe(7);
    expect(skillPointsSpent(picked, TREE)).toBe(19);
    expect(skillPointsSpent(picked, TREE)).toBeLessThanOrEqual(SKILL_BUDGET);
  });

  it("charges unknown codes 1 pt (builds restored onto another class)", () => {
    expect(skillPointsSpent(pick("FromAnotherClass"), TREE)).toBe(1);
    expect(skillPointsSpent(pick("FromAnotherClass", "One"), TREE)).toBe(2);
  });
});

describe("skillPointsBelow", () => {
  it("only sums tiers strictly below the queried row", () => {
    expect(skillPointsBelow(pick("One", "Two", "Three"), TREE, 3)).toBe(3);
    expect(skillPointsBelow(pick("One", "Two", "Three"), TREE, 4)).toBe(6);
  });

  it("feeds the TIER_UNLOCK gates with points, not skill counts", () => {
    // A single tier-2 skill (2 pts) unlocks tier 3, two tier-1 skills do too,
    // but one tier-1 skill does not.
    expect(skillPointsBelow(pick("Two"), TREE, 3)).toBeGreaterThanOrEqual(TIER_UNLOCK[3]);
    expect(skillPointsBelow(pick("One", "OneB"), TREE, 3)).toBeGreaterThanOrEqual(TIER_UNLOCK[3]);
    expect(skillPointsBelow(pick("One"), TREE, 3)).toBeLessThan(TIER_UNLOCK[3]);
    // A single tier-3 skill (3 pts) unlocks tier 4.
    expect(skillPointsBelow(pick("Three"), TREE, 4)).toBeGreaterThanOrEqual(TIER_UNLOCK[4]);
    expect(skillPointsBelow(pick("One", "Two"), TREE, 4)).toBeGreaterThanOrEqual(TIER_UNLOCK[4]);
    expect(skillPointsBelow(pick("One", "OneB"), TREE, 4)).toBeLessThan(TIER_UNLOCK[4]);
  });
});

describe("skillTierGaps", () => {
  it("flags no row on an empty selection", () => {
    expect(skillTierGaps({}, TREE)).toEqual(new Set());
  });

  it("flags rows left empty below the highest picked row", () => {
    // Two tier-1 skills open tier 3 with tier 2 untouched — the exact
    // configuration the in-game builder refuses.
    expect(skillTierGaps(pick("One", "OneB", "Three"), TREE)).toEqual(new Set([2]));
    expect(skillTierGaps(pick("One", "Four"), TREE)).toEqual(new Set([2, 3]));
  });

  it("accepts every row filled up to the highest pick, and above it", () => {
    expect(skillTierGaps(pick("One", "Two", "Three"), TREE)).toEqual(new Set());
    // Tiers above the highest pick may stay empty.
    expect(skillTierGaps(pick("One", "TwoB"), TREE)).toEqual(new Set());
  });

  it("flags every row below a lone high pick, tier 1 included", () => {
    // Reachable only via a restored cross-class build (the planner's own
    // toggle can never pass a lower row without a tier-1 pick).
    expect(skillTierGaps(pick("Four"), TREE)).toEqual(new Set([1, 2, 3]));
  });

  it("ignores codes outside the class tree", () => {
    expect(skillTierGaps(pick("FromAnotherClass", "One"), TREE)).toEqual(new Set());
  });
});

describe("classSkills data", () => {
  const CLASSES = ["BB", "CA", "DD", "CV", "SS"] as const;
  const cell = (s: Skill) => `${s.tier}:${s.column}`;

  it("fits every class in a 6-column grid — the submarine tree in 5", () => {
    for (const cls of CLASSES) {
      const width = Math.max(...classSkills(cls).map((s) => s.column)) + 1;
      expect(width === 6 || width === 5).toBe(true);
      expect(width).toBe(cls === "SS" ? 5 : 6);
    }
  });

  it("never stacks two skills in one tier cell", () => {
    for (const cls of CLASSES) {
      const cells = classSkills(cls).map(cell);
      expect(new Set(cells).size).toBe(cells.length);
    }
  });

  it("mirrors the live 20-cell submarine tree (4 tiers × 5 full columns)", () => {
    // The sub tree is the one class tree without a sixth column — a full
    // 5×4 grid, matching the in-game layout cell for cell.
    const ss = classSkills("SS");
    expect(ss).toHaveLength(20);
    expect(new Set(ss.map(cell)).size).toBe(20);
  });
});

describe("classSkills realms", () => {
  const CLASSES = ["BB", "CA", "DD", "CV", "SS"] as const;
  const REALMS = ["wg", "lesta"] as const;
  const cvCell = (realm: "wg" | "lesta") =>
    classSkills("CV", realm).find((s) => s.tier === 2 && s.column === 3)?.code;

  it("carries the full per-class counts in BOTH realms (WG's sub tree is 20 cells; the decoded Lesta one is 24)", () => {
    for (const realm of REALMS) {
      expect(classSkills("BB", realm)).toHaveLength(24);
      expect(classSkills("CA", realm)).toHaveLength(24);
      expect(classSkills("DD", realm)).toHaveLength(24);
      expect(classSkills("CV", realm)).toHaveLength(24);
      expect(classSkills("SS", realm)).toHaveLength(realm === "lesta" ? 24 : 20);
    }
  });

  it("keeps the 6-column grid in both realms (WG's SS stays 5) and no stacked cells", () => {
    for (const realm of REALMS) {
      for (const cls of CLASSES) {
        const list = classSkills(cls, realm);
        const width = Math.max(...list.map((s) => s.column)) + 1;
        expect(width).toBe(cls === "SS" && realm === "wg" ? 5 : 6);
        const cells = list.map((s) => `${s.tier}:${s.column}`);
        expect(new Set(cells).size).toBe(cells.length);
      }
    }
  });

  it("swaps exactly the CV tier-2 col-3 cell between realms", () => {
    // WG patched its hole to the Active Maneuvering skill; Lesta still
    // ships the Regenerate Health skill in that cell (see
    // skilltree_lesta.NOTES.md's override entry).
    expect(cvCell("wg")).toBe("PlanesConsumablesActiveManeuveringUpgrade");
    expect(cvCell("lesta")).toBe("PlanesConsumablesRegeneratehealthUpgrade");
  });

  it("defaults to the WG catalog", () => {
    expect(classSkills("CV")).toEqual(classSkills("CV", "wg"));
  });

  it("the two CV catalogs differ by the swapped cell plus the Lesta-only patrol skill", () => {
    const wg = classSkills("CV", "wg").map((s) => s.code).sort();
    const lesta = classSkills("CV", "lesta").map((s) => s.code).sort();
    expect(wg).not.toEqual(lesta);
    expect(wg.filter((c) => !lesta.includes(c))).toEqual([
      "PlanesConsumablesActiveManeuveringUpgrade",
      "PlanesConsumablesCallfightersUpgrade",
    ]);
    expect(lesta.filter((c) => !wg.includes(c))).toEqual([
      "ExtraCallFighters",
      "PlanesConsumablesRegeneratehealthUpgrade",
    ]);
  });
});

describe("recommendedSkills", () => {
  it("resolves the WG crew-presets cascade for a real tree index", () => {
    expect(recommendedSkills("PJSB018", "Battleship").size).toBeGreaterThan(0);
  });

  it("yields nothing in Lesta — no CrewSkillRecomendationPresets extract", () => {
    expect(recommendedSkills("PJSB018", "Battleship", "lesta")).toEqual(new Set());
    expect(recommendedSkills(null, "Battleship", "lesta")).toEqual(new Set());
  });
});
