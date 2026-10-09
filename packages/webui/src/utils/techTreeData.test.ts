/** Tests for nation-key resolution in the tech tree: the WG encyclopedia API
 *  and the game-file extracts spell some nations differently (europe vs
 *  pan_europe), and a raw miss blanks the whole tree (AGENTS-documented bug:
 *  the Europe rail showed "no tech tree"). */
import { describe, expect, it } from "vitest";

import {
  allTechTreeNodes,
  nationNodes,
  nationTree,
  techTreeNode,
  type TechTreeRealm,
} from "./techTreeData";

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

describe("nationTree per realm (wg bridge vs lesta gameparams)", () => {
  it("yields a non-empty Lesta tree for every nation the rail can select", () => {
    for (const nation of WG_NATIONS) {
      const groups = nationTree(nation, "lesta");
      expect(groups.some((g) => g.branches.length > 0), nation).toBe(true);
    }
  });

  it("anchors the Pan-American battleship fork at tier VIII on both realms", () => {
    for (const realm of ["wg", "lesta"] as const satisfies readonly TechTreeRealm[]) {
      const bb = nationTree("pan_america", realm).find((g) => g.type === "Battleship");
      expect(bb, realm).toBeDefined();
      expect(bb!.branches.length, realm).toBeGreaterThan(0);
      for (const b of bb!.branches) {
        const tiers = b.ships.map((sid) => techTreeNode(sid, realm)!.tier);
        // The fork starts mid-tree (VIII), never at the top of the ladder.
        expect(tiers[0], `${realm} branch start`).toBe(8);
        expect(tiers, realm).toEqual([...tiers].sort((a, z) => a - z));
      }
    }
  });

  it("keeps supership continuations on the Lesta tree", () => {
    // gameparams mode must retain group "superShip" — the ★ tier-11 rows
    // continue the tier-10 research chains on both realms.
    const nodes = Object.values(allTechTreeNodes("lesta"));
    const supers = nodes.filter((n) => n.tier >= 11);
    expect(supers.length).toBeGreaterThan(0);
    for (const s of supers) {
      expect(
        nodes.some((n) => n.nextShips.includes(s.shipId)),
        `${s.index} has no research parent`,
      ).toBe(true);
    }
  });

  it("keeps the unknown realm on the WG default", () => {
    expect(techTreeNode(4276041040, "wg")).toEqual(techTreeNode(4276041040));
  });
});
