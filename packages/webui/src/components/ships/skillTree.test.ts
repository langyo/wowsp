/** Tests for the commander-skill point math: each skill costs as many
 *  points as its tier row (1–4), the 21-pt budget is tracked against that
 *  weighted sum, and the tier-row unlock gates compare points (not skill
 *  counts) spent in lower tiers. */
import { describe, expect, it } from "vitest";

import {
  SKILL_BUDGET,
  skillCost,
  skillPointsBelow,
  skillPointsSpent,
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
