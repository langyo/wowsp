/** Tests for the bundled per-ship upgrade chains: ship-level economy, the
 *  per-ship-pair research XP (next.*.xpShip) the tech-tree connector tooltips
 *  read, the stock -> top module chains, and the WG/Lesta realm split.
 *
 *  Real ids are pinned from the regenerated bundles (WG build 13357625 /
 *  Lesta build 8867689): Minsk (PRSD207) for the WG chain, PASB310 for a
 *  Lesta-only line the WG snapshot does not carry. Numeric economy values are
 *  asserted RELATIONALLY (xpShip === the target ship's own research xp) so a
 *  future rebalance does not invalidate the accessor contract — only the
 *  extraction's structure is pinned. */
import { describe, expect, it } from "vitest";

import {
  allUpgradeChains,
  nextResearch,
  researchOf,
  shipUpgradeChain,
  upgradeChainGameVersion,
} from "./shipUpgradeChain";
import { allTechTreeNodes, techTreeNode } from "./techTreeData";

/** Minsk — WG tier-VII USSR destroyer (PRSD207). */
const MINSK = 4077794768;
/** Pr.48 (PRSD308) — unlocked by Minsk's top hull. */
const PR_48 = 3971888592;
/** Pr.30 (PRSD208) — unlocked by Minsk's top torpedoes. */
const PR_30 = 4076746192;
/** New Jersey (PASB310) — a Lesta-only line; the WG snapshot lacks the id. */
const LESTA_ONLY = 3969857520;
/** Its Lesta successor (PASB211). */
const LESTA_NEXT = 4073666544;
/** Italy PISS106 — a WG-only researchable line. */
const WG_ONLY = 4183209712;

describe("shipUpgradeChain", () => {
  it("resolves a known ship chain with its ship-level research economy", () => {
    const chain = shipUpgradeChain(MINSK);
    expect(chain).not.toBeNull();
    expect(chain!.index).toBe("PRSD207");
    expect(chain!.research.xp).toBeGreaterThan(0);
    expect(chain!.research.credits).toBeGreaterThan(0);
    expect(chain!.research.gold).toBe(0);
    expect(chain!.slots.length).toBeGreaterThan(0);
  });

  it("defaults to the WG realm and misses cleanly", () => {
    expect(shipUpgradeChain(MINSK)).toEqual(shipUpgradeChain(MINSK, "wg"));
    expect(shipUpgradeChain(-1)).toBeNull();
    expect(shipUpgradeChain(LESTA_ONLY)).toBeNull();
    expect(researchOf(-1)).toBeNull();
  });

  it("resolves the next-ship research XP as the NEXT ship's own costXP", () => {
    const pr48 = nextResearch(MINSK, PR_48);
    expect(pr48).not.toBeNull();
    expect(pr48!.index).toBe("PRSD308");
    // The semantics: xpShip is the unlocked ship's own ShipUpgradeInfo costXP,
    // not Minsk's (the tech-tree tooltip's minimal case).
    expect(pr48!.xpShip).not.toBeNull();
    expect(pr48!.xpShip).toBe(researchOf(PR_48)!.xp);
    expect(nextResearch(MINSK, PR_30)!.index).toBe("PRSD208");
    expect(nextResearch(MINSK, PR_30)!.xpShip).toBe(researchOf(PR_30)!.xp);
    // "with minimal equipment" has no source yet — the null contract is pinned.
    expect(pr48!.xpWithModules).toBeNull();
    expect(pr48!.requiredModules).toBeNull();
    // Minsk is a shared ship: the same edge resolves through the Lesta bundle.
    expect(nextResearch(MINSK, PR_48, "lesta")).not.toBeNull();
    // A non-edge misses cleanly.
    expect(nextResearch(MINSK, 123456789)).toBeNull();
  });

  it("keeps both of Minsk's unlock edges, keyed by shipId", () => {
    const next = shipUpgradeChain(MINSK)!.next;
    expect(Object.keys(next).sort()).toEqual([String(PR_48), String(PR_30)].sort());
    for (const [shipId, entry] of Object.entries(next)) {
      expect(entry.index, shipId).toMatch(/^PRSD\d{3}$/);
    }
  });
});

describe("upgrade slots", () => {
  it("leads with the hull slot and orders every slot stock -> top", () => {
    const chain = shipUpgradeChain(MINSK)!;
    expect(chain.slots[0].ucType).toBe("_Hull");
    const hull = chain.slots[0];
    expect(hull.steps.map((s) => s.name)).toEqual([
      "PRUH603_D7_HULL_STOCK_2",
      "PRUH604_D7_HULL_TOP_2",
    ]);
    expect(hull.steps.map((s) => s.isStock)).toEqual([true, false]);
    for (const slot of chain.slots) {
      expect(slot.steps.length, slot.ucType).toBeGreaterThan(0);
      expect(slot.steps[0].isStock, slot.ucType).toBe(true);
      for (const step of slot.steps.slice(1)) {
        expect(step.isStock, step.name).toBe(false);
      }
      // Per-module economy is absent from GameParams — null until extracted.
      for (const step of slot.steps) {
        expect(step.xp).toBeNull();
        expect(step.credits).toBeNull();
      }
    }
  });

  it("keeps the hull stock component stock and top components distinct", () => {
    const [stock, top] = shipUpgradeChain(MINSK)!.slots[0].steps;
    expect(stock.components.hull).toEqual(["A_Hull"]);
    expect(top.components.hull).toEqual(["B_Hull"]);
  });

  it("maps module unlocks to numeric shipIds that resolve in-realm", () => {
    const hullTop = shipUpgradeChain(MINSK)!.slots[0].steps.slice(-1)[0];
    expect(hullTop.unlocks).toEqual([PR_48]);
    const torpSlot = shipUpgradeChain(MINSK)!.slots.find((s) => s.ucType === "_Torpedoes")!;
    expect(torpSlot.steps.slice(-1)[0].unlocks).toEqual([PR_30]);
    for (const realm of ["wg", "lesta"] as const) {
      for (const [shipId, chain] of Object.entries(allUpgradeChains(realm))) {
        for (const slot of chain.slots) {
          for (const step of slot.steps) {
            for (const id of step.unlocks ?? []) {
              expect(shipUpgradeChain(id, realm), shipId + " -> " + id).not.toBeNull();
            }
          }
        }
      }
    }
  });

  it("carries every research-line node and tree edge of both realms", () => {
    for (const realm of ["wg", "lesta"] as const) {
      const tree = allTechTreeNodes(realm);
      const chains = allUpgradeChains(realm);
      expect(Object.keys(chains).length).toBeGreaterThan(0);
      for (const [shipId, node] of Object.entries(tree)) {
        const chain = chains[shipId];
        expect(chain, realm + " " + node.index).toBeDefined();
        expect(chain!.research, node.index).toBeDefined();
        for (const nextId of node.nextShips) {
          if (!tree[String(nextId)]) continue;
          expect(
            chain!.next[String(nextId)],
            realm + " " + node.index + " -> " + tree[String(nextId)].index,
          ).toBeDefined();
        }
      }
    }
  });
});

describe("realm selection", () => {
  it("selects the Lesta bundle for lesta and keeps WG the default", () => {
    // PASB310 is a Lesta-only line: WG has neither a tree node nor a chain.
    expect(techTreeNode(LESTA_ONLY, "lesta")).not.toBeNull();
    expect(techTreeNode(LESTA_ONLY, "wg")).toBeNull();

    const lesta = shipUpgradeChain(LESTA_ONLY, "lesta");
    expect(lesta).not.toBeNull();
    expect(lesta!.index).toBe("PASB310");
    expect(lesta!.research.xp).toBeGreaterThan(0);
    expect(nextResearch(LESTA_ONLY, LESTA_NEXT, "lesta")!.xpShip).toBe(
      researchOf(LESTA_NEXT, "lesta")!.xp,
    );
    expect(researchOf(LESTA_ONLY, "lesta")).toEqual(lesta!.research);
    // The default realm stays WG.
    expect(researchOf(LESTA_ONLY)).toBeNull();

    // A WG-only line resolves only on the WG side.
    expect(techTreeNode(WG_ONLY, "wg")).not.toBeNull();
    expect(shipUpgradeChain(WG_ONLY, "wg")).not.toBeNull();
    expect(shipUpgradeChain(WG_ONLY, "lesta")).toBeNull();
  });

  it("stamps each bundle with its realm build and differentiates shared ships", () => {
    expect(upgradeChainGameVersion("wg")).toMatch(/^wg-\d+$/);
    expect(upgradeChainGameVersion("lesta")).toMatch(/^lesta-\d+$/);
    // Minsk is a shared ship, but the two clients research it differently:
    // the Lesta bundle's own economy for the same edge is the Lesta one.
    expect(nextResearch(MINSK, PR_48, "lesta")).not.toBeNull();
    expect(nextResearch(MINSK, PR_48, "lesta")!.xpShip).toBe(researchOf(PR_48, "lesta")!.xp);
  });
});
