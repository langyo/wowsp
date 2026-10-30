/** Tests for the bundled per-ship upgrade chains: ship-level economy, the
 *  per-ship-pair research XP (next.*.xpShip) the tech-tree connector tooltips
 *  read, the stock -> top module chains with their prev/depth topology, and
 *  the WG/Lesta realm split.
 *
 *  Real ids are pinned from the regenerated bundles (WG build 13357625 /
 *  Lesta build 8867689): Minsk (PRSD207) for a plain vertical chain;
 *  4266538256 (AKATSUKI_ROMULANS) for three parallel hull variant chains;
 *  PJSD912 (Shimakaze 1943) for a three-step torpedo chain; 4180555216
 *  (Kiev) for a hull-locked module whose prev points into the hull bracket;
 *  PASB310 for a Lesta-only line the WG snapshot does not carry. Numeric
 *  economy values are asserted RELATIONALLY (xpShip === the target ship's own
 *  research xp) so a future rebalance does not invalidate the accessor
 *  contract — only the extraction's structure is pinned. */
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
/** Akatsuki (Romulans event hull) — three parallel hull chains. */
const ROMULANS = 4266538256;
/** Shimakaze 1943 — a three-step torpedo chain (client-dump-only entry). */
const SHIMAKAZE_1943 = 3338548944;
/** Kiev — top torpedoes upgrade FROM a hull module (cross-slot prev). */
const KIEV = 4180555216;
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
    // "with minimal equipment" is filled from the client's server-synced
    // price catalog when a capture is applied — so the contract is
    // STATE-AWARE, not permanently null: either the field is absent (the
    // bundled capture has not run yet) or it is a positive whole number
    // (>= the ship XP) with the required-module list alongside it.
    if (pr48!.xpWithModules === null) {
      expect(pr48!.requiredModules).toBeNull();
    } else {
      expect(Number.isInteger(pr48!.xpWithModules)).toBe(true);
      expect(pr48!.xpWithModules).toBeGreaterThanOrEqual(pr48!.xpShip!);
      expect(Array.isArray(pr48!.requiredModules)).toBe(true);
      expect(pr48!.requiredModules!.length).toBeGreaterThan(0);
      for (const module of pr48!.requiredModules!) {
        expect(typeof module, module).toBe("string");
        expect(module.length).toBeGreaterThan(0);
      }
    }
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
  it("orders every slot by upgrade depth, stock first", () => {
    // Minsk hull: one plain vertical chain, depth 0 -> 1.
    const hull = shipUpgradeChain(MINSK)!.slots[0];
    expect(hull.ucType).toBe("_Hull");
    expect(hull.steps.map((s) => s.name)).toEqual([
      "PRUH603_D7_HULL_STOCK_2",
      "PRUH604_D7_HULL_TOP_2",
    ]);
    expect(hull.steps.map((s) => s.depth)).toEqual([0, 1]);
    expect(hull.steps.map((s) => s.prev)).toEqual([null, "PRUH603_D7_HULL_STOCK_2"]);
    expect(hull.steps.map((s) => s.isStock)).toEqual([true, false]);
    // Every module carries its numeric GameParams id: the client's synced
    // price catalog keys its items by it, so a capture joins onto the step.
    for (const realm of ["wg", "lesta"] as const) {
      for (const [shipId, chain] of Object.entries(allUpgradeChains(realm))) {
        for (const slot of chain.slots) {
          for (const step of slot.steps) {
            // Null only on slice/bundle-fallback generations; the committed
            // bundles are built from the full dumps and carry every id.
            if (step.gpid !== null) {
              expect(Number.isInteger(step.gpid), shipId + " " + step.name).toBe(true);
              expect(step.gpid, shipId + " " + step.name).toBeGreaterThan(0);
            }
          }
        }
      }
    }

    // Global contract: depth-ascending order, one stock head.
    for (const realm of ["wg", "lesta"] as const) {
      for (const [shipId, chain] of Object.entries(allUpgradeChains(realm))) {
        for (const slot of chain.slots) {
          expect(slot.steps.length, shipId + " " + slot.ucType).toBeGreaterThan(0);
          expect(slot.steps[0].isStock, shipId + " " + slot.ucType).toBe(true);
          expect(slot.steps[0].depth, shipId + " " + slot.ucType).toBe(0);
          let lastDepth = -1;
          for (const step of slot.steps) {
            expect(step.depth, shipId + " " + slot.ucType + " " + step.name)
              .toBeGreaterThanOrEqual(lastDepth);
            lastDepth = step.depth;
            expect(step.isStock, step.name).toBe(step === slot.steps[0]);
            // Per-module economy: null until a server price-catalog capture is
            // applied, then a positive amount (never zero, never a string).
            if (step.xp !== null) {
              expect(Number.isInteger(step.xp), step.name).toBe(true);
              expect(step.xp, step.name).toBeGreaterThan(0);
            }
            if (step.credits !== null) {
              expect(Number.isInteger(step.credits), step.name).toBe(true);
              expect(step.credits, step.name).toBeGreaterThan(0);
            }
          }
        }
      }
    }
  });

  it("keeps the hull stock components and top components distinct", () => {
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

describe("upgrade-step topology (prev / depth)", () => {
  it("walks a three-step torpedo chain (PJSD912 Shimakaze 1943)", () => {
    // Raw GameParams: PJUT975 prev "" -> PJUT976 prev PJUT975 -> PJUT977
    // prev PJUT976 — a chain of three upgrade levels, NOT alternative
    // modules, so the depths must be 0/1/2.
    const chain = shipUpgradeChain(SHIMAKAZE_1943);
    expect(chain).not.toBeNull();
    expect(chain!.index).toBe("PJSD912");
    const slot = chain!.slots.find((s) => s.ucType === "_Torpedoes")!;
    expect(slot.steps.map((s) => s.name)).toEqual([
      "PJUT975_TORP1_SHIM",
      "PJUT976_TORP2_SHIM",
      "PJUT977_TORP3_SHIM",
    ]);
    expect(slot.steps.map((s) => s.depth)).toEqual([0, 1, 2]);
    expect(slot.steps.map((s) => s.prev)).toEqual([
      null,
      "PJUT975_TORP1_SHIM",
      "PJUT976_TORP2_SHIM",
    ]);
  });

  it("groups parallel hull variants by depth with alternatives adjacent", () => {
    // 4266538256 (Akatsuki, Romulans event hull) mounts three hull chains:
    // 021 -> 022 -> 023, 024 -> 025 and 026 -> 027. Depth groups them by
    // upgrade level (0,0,0 / 1,1,1 / 2) instead of flattening the chains.
    const slot = shipUpgradeChain(ROMULANS)!.slots.find((s) => s.ucType === "_Hull")!;
    expect(slot.steps.map((s) => s.name)).toEqual([
      "PXUH021_HULL_AKATSUKI_ROMULANS",
      "PXUH024_HULL_AKATSUKI_ROMULANS",
      "PXUH026_HULL_AKATSUKI_ROMULANS",
      "PXUH022_HULL_AKATSUKI_ROMULANS",
      "PXUH025_HULL_AKATSUKI_ROMULANS",
      "PXUH027_HULL_AKATSUKI_ROMULANS",
      "PXUH023_HULL_AKATSUKI_ROMULANS",
    ]);
    expect(slot.steps.map((s) => s.depth)).toEqual([0, 0, 0, 1, 1, 1, 2]);
    expect(slot.steps.map((s) => s.prev)).toEqual([
      null,
      null,
      null,
      "PXUH021_HULL_AKATSUKI_ROMULANS",
      "PXUH024_HULL_AKATSUKI_ROMULANS",
      "PXUH026_HULL_AKATSUKI_ROMULANS",
      "PXUH022_HULL_AKATSUKI_ROMULANS",
    ]);
    // Only the first stock variant is the slot's stock step; its siblings are
    // same-depth alternatives.
    expect(slot.steps.slice(0, 3).map((s) => s.isStock)).toEqual([true, false, false]);
  });

  it("lifts a hull-locked module one level above the slot's stock", () => {
    // Kiev's top torpedoes upgrade FROM hull B (prev points into the hull
    // bracket), so they sit at depth 1 above the stock torpedo module.
    const slot = shipUpgradeChain(KIEV)!.slots.find((s) => s.ucType === "_Torpedoes")!;
    expect(slot.steps.map((s) => s.name)).toEqual([
      "PRUT601_D7_TORP_STOCK",
      "PRUT602_D7_TORP_TOP",
    ]);
    expect(slot.steps.map((s) => s.depth)).toEqual([0, 1]);
    expect(slot.steps[0].prev).toBeNull();
    expect(slot.steps[1].prev).toBe("PRUH802_KIEV_B");
  });

  it("keeps prev/depth internally consistent in both realms", () => {
    for (const realm of ["wg", "lesta"] as const) {
      for (const [shipId, chain] of Object.entries(allUpgradeChains(realm))) {
        for (const slot of chain.slots) {
          const byName = new Map(slot.steps.map((s) => [s.name, s]));
          for (const step of slot.steps) {
            const where = realm + " " + shipId + " " + slot.ucType + " " + step.name;
            if (step.prev === null) {
              expect(step.depth, where).toBe(0);
              continue;
            }
            const parent = byName.get(step.prev);
            if (parent) {
              // Same-slot chain: exactly one level below its prerequisite.
              expect(step.depth, where).toBe(parent.depth + 1);
            } else {
              // Cross-slot prerequisite: one level above the slot's stock.
              expect(step.depth, where).toBe(1);
            }
          }
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
