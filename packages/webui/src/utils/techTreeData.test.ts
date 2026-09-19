/** Tests for nation-key resolution in the tech tree: the WG encyclopedia API
 *  and the game-file extracts spell some nations differently (europe vs
 *  pan_europe), and a raw miss blanks the whole tree (AGENTS-documented bug:
 *  the Europe rail showed "no tech tree"). */
import { describe, expect, it } from "vitest";

import { nationNodes, nationTree } from "./techTreeData";

/** The 13 nation codes the encyclopedia rail passes down (WG API spelling). */
const WG_NATIONS = [
  "japan",
  "usa",
  "ussr",
  "germany",
  "uk",
  "france",
  "pan_asia",
  "italy",
  "netherlands",
  "commonwealth",
  "pan_america",
  "spain",
  "europe",
];

describe("nationNodes", () => {
  it("resolves the WG API Europe spelling to the pan_europe slot", () => {
    expect(nationNodes("europe").length).toBeGreaterThan(0);
    expect(nationNodes("europe")).toEqual(nationNodes("pan_europe"));
  });

  it("resolves the game-file spellings of the UK and the USSR", () => {
    expect(nationNodes("united_kingdom")).toEqual(nationNodes("uk"));
    expect(nationNodes("russia")).toEqual(nationNodes("ussr"));
  });

  it("keeps the stored keys reachable and misses cleanly", () => {
    expect(nationNodes("uk").length).toBeGreaterThan(0);
    expect(nationNodes("pan_europe").length).toBeGreaterThan(0);
    expect(nationNodes("unknown_nation")).toEqual([]);
  });
});

describe("nationTree", () => {
  it("yields a non-empty tree for every nation the rail can select", () => {
    for (const nation of WG_NATIONS) {
      const groups = nationTree(nation);
      expect(groups.some((g) => g.branches.length > 0), nation).toBe(true);
    }
  });
});
