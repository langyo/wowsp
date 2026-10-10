/** Tests for nation-key resolution in the tech tree: the WG encyclopedia API
 *  and the game-file extracts spell some nations differently (europe vs
 *  pan_europe), and a raw miss blanks the whole tree (AGENTS-documented bug:
 *  the Europe rail showed "no tech tree"). */
import { describe, expect, it } from "vitest";

import {
  allTechTreeNodes,
  nationCrossLinks,
  nationNodes,
  nationTree,
  techTreeNode,
  treeNextShipIds,
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
  it("yields a Lesta tree for every nation the rail can select, save Commonwealth", () => {
    // Lesta's client has no Commonwealth research line at all — the view
    // renders its empty state there — every other nation carries lines.
    for (const nation of WG_NATIONS) {
      const groups = nationTree(nation, "lesta");
      if (nation === "commonwealth") {
        expect(groups.some((g) => g.branches.length > 0), nation).toBe(false);
      } else {
        expect(groups.some((g) => g.branches.length > 0), nation).toBe(true);
      }
    }
  });

  it("keeps the realms' divergent Pan-American lines mid-ladder", () => {
    // The two clients split here: WG grows the Pan-Am battleships as a fork
    // off tier VIII, Lesta instead runs a destroyer line that only starts at
    // tier V. Both are mid-tree line starts, so the shared tier ladder must
    // anchor them on their own row, never at the top of the section.
    const wgBb = nationTree("pan_america", "wg").find((g) => g.type === "Battleship");
    expect(wgBb).toBeDefined();
    expect(wgBb!.branches.length).toBeGreaterThan(0);
    for (const b of wgBb!.branches) {
      const tiers = b.ships.map((sid) => techTreeNode(sid, "wg")!.tier);
      expect(tiers[0]).toBe(8);
      expect(tiers).toEqual([...tiers].sort((a, z) => a - z));
    }

    const lestaBb = nationTree("pan_america", "lesta").find((g) => g.type === "Battleship");
    expect(lestaBb).toBeUndefined();
    const lestaDd = nationTree("pan_america", "lesta").find((g) => g.type === "Destroyer");
    expect(lestaDd).toBeDefined();
    for (const b of lestaDd!.branches) {
      const tiers = b.ships.map((sid) => techTreeNode(sid, "lesta")!.tier);
      expect(tiers[0]).toBe(5);
      expect(tiers).toEqual([...tiers].sort((a, z) => a - z));
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

describe("nationTree section order", () => {
  it("lays sections out as BB, CA, DD, SS, CV", () => {
    // Carriers sit farthest right: their cross-type edges leave the DD
    // section at tier IV, sailing over the SS section's empty upper rows
    // (sub lines start at tier VI); submarines sit next to the DD section
    // their lines come from. Locks the swap from the DD|CV|SS order that
    // ran DD→SS runs behind the CV section's tier-VI cards.
    const full = ["Battleship", "Cruiser", "Destroyer", "Submarine", "AirCarrier"];
    const order = (nation: string, realm: TechTreeRealm = "wg"): string[] => {
      const present = new Set(nationNodes(nation, realm).map((n) => n.type));
      return nationTree(nation, realm)
        .map((g) => g.type)
        .filter((t) => present.has(t));
    };
    // Some nations have no submarine line at all (pan_asia) — the assertion
    // is on the relative order of whatever sections the nation carries.
    for (const nation of ["japan", "usa", "germany", "uk", "pan_asia"]) {
      expect(order(nation), nation).toEqual(full.filter((t) => order(nation).includes(t)));
    }
  });
});

describe("nationTree fork column order", () => {
  it("walks fork children in the game's nextShips order", () => {
    // IJN DD: 矶风 (PJSD003) forks into two destroyer lines plus the CV
    // hand-off. The first nextShips entry owns the leftmost column; the
    // old LIFO branch walk rendered the lines in the opposite order.
    const nodes = allTechTreeNodes("wg");
    const isokaze = Object.values(nodes).find((n) => n.index === "PJSD003")!;
    const firstLineId = Object.values(nodes).find((n) => n.index === "PJSD105")!.shipId;
    const secondLineId = Object.values(nodes).find((n) => n.index === "PJSD004")!.shipId;
    expect(treeNextShipIds(isokaze).indexOf(firstLineId))
      .toBeLessThan(treeNextShipIds(isokaze).indexOf(secondLineId));

    const dd = nationTree("japan").find((g) => g.type === "Destroyer")!;
    const branchOf = (sid: number): number =>
      dd.branches.findIndex((b) => b.ships.includes(sid));
    const firstIdx = branchOf(firstLineId);
    const secondIdx = branchOf(secondLineId);
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThanOrEqual(0);
    expect(firstIdx).toBeLessThan(secondIdx);
  });
});

describe("treeNextShipIds", () => {
  it("drops premium/special side leaves from the research continuation", () => {
    // Contract pin: the WG-tree pipeline (build_techtree.py second pass) CAN
    // hang premium/special leaves off a node's nextShips, and the research
    // continuations — fork counts, link hints, cross links — must never
    // count them, whichever bundled tree carries one.
    for (const realm of ["wg", "lesta"] as const) {
      for (const n of Object.values(allTechTreeNodes(realm))) {
        for (const id of treeNextShipIds(n, realm)) {
          const child = techTreeNode(id, realm)!;
          expect(child.isPremium, `${realm} ${n.index} -> ${child.index}`).toBe(false);
          expect(child.isSpecial, `${realm} ${n.index} -> ${child.index}`).toBe(false);
        }
      }
    }
  });
});

describe("nationCrossLinks", () => {
  it("surfaces the IJN cross-type hand-offs the sections need bridged", () => {
    const links = nationCrossLinks("japan");
    const byPair = (fromIdx: string, toIdx: string): boolean => {
      const from = Object.values(allTechTreeNodes("wg")).find((n) => n.index === fromIdx)!;
      const to = Object.values(allTechTreeNodes("wg")).find((n) => n.index === toIdx)!;
      return links.some((l) => l.from === from.shipId && l.to === to.shipId);
    };
    // 筑摩 (II cruiser) → 海风 (II destroyer), 天龙 (III) → 河内 (III BB),
    // 矶风 (IV DD) → 凤翔 (IV CV): the three links the tree view must draw
    // across its type-section gap.
    expect(byPair("PJSC035", "PJSD002")).toBe(true);
    expect(byPair("PJSC015", "PJSB001")).toBe(true);
    expect(byPair("PJSD003", "PJSA104")).toBe(true);
  });

  it("only links researchable ships of different types within the nation", () => {
    for (const realm of ["wg", "lesta"] as const) {
      for (const nation of WG_NATIONS) {
        for (const l of nationCrossLinks(nation, realm)) {
          const from = techTreeNode(l.from, realm)!;
          const to = techTreeNode(l.to, realm)!;
          expect(from.isPremium || from.isSpecial).toBe(false);
          expect(to.isPremium || to.isSpecial).toBe(false);
          expect(to.type, `${realm} ${from.index} -> ${to.index}`).not.toBe(from.type);
          expect(to.nation).toBe(from.nation);
        }
      }
    }
  });
});
