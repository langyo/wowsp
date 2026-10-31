/** Tests for the 装备选择 (equipment progression) panel's pure row builder.
 *
 *  Real ships/ids are pinned from the bundled datasets:
 *   - Minsk (PRSD207, 4077794768): a plain stock -> top chain with two
 *     next-ship edges (top hull -> Pr.48, top torpedoes -> Pr.30).
 *   - Shimakaze_1943 (PJSD012, 4282267344): a three-step torpedo chain whose
 *     predecessor is Yugumo (PJSD209, 4075697872).
 *   - Akatsuki_Romulans (PXSD027, 4266538256): the parallel-variant fixture —
 *     its hull slot holds THREE research chains (depths 0/1/2, 0/1, 0/1)
 *     with steps in (depth, table) order.
 *   - Shimakaze variants (PJSD912, 3338548944): a real three-deep torpedo
 *     chain (depths 0/1/2).
 *   - Kiev (PRSD109, 4180555216): a cross-slot prerequisite — the top
 *     torpedoes upgrade from hull B ("PRUH802_KIEV_B", depth 1), which is not
 *     a module of the torpedo slot.
 *
 *  Numeric economy values are asserted RELATIONALLY (the next card's xpShip
 *  is the target ship's own research xp) so a future rebalance keeps the
 *  tests valid; only the structure is pinned.
 */
import { describe, expect, it } from "vitest";

import { invalidInput } from "@/test-utils/invalid";
import { researchOf, shipUpgradeChain } from "@/utils/shipUpgradeChain";
import { techTreeNode, type TechTreeNode } from "@/utils/techTreeData";
import {
  buildUpgradeChainRows,
  chainRole,
  mountedComponents,
  pickPreviousShip,
  researchNextShipIds,
  resolvePreviousShip,
  slotOrderOf,
  variantLetter,
  variantMarkerOf,
  type UpgradeChainInput,
  type UpgradeRow,
} from "./upgradeChainRows";

/** Minsk — WG tier-VII USSR destroyer (PRSD207). */
const MINSK = 4077794768;
/** Pr.48 (PRSD308) — unlocked by Minsk's top hull. */
const PR_48 = 3971888592;
/** Pr.30 (PRSD208) — unlocked by Minsk's top torpedoes. */
const PR_30 = 4076746192;
/** Shimakaze_1943 (PJSD012) — a WG/Lesta shared T10 destroyer. */
const SHIMAKAZE_1943 = 4282267344;
/** Yugumo (PJSD209) — its tier-IX predecessor. */
const YUGUMO = 4075697872;
/** Akatsuki_Romulans (PXSD027) — the 3-parallel-hull-chain fixture. */
const ALT_HULLS = 4266538256;
/** Shimakaze (PJSD912) — the three-deep torpedo-chain fixture. */
const SHIMAKAZE_912 = 3338548944;
/** Kiev (PRSD109) — the cross-slot torpedo prerequisite fixture. */
const KIEV = 4180555216;
/** PISS106 — a WG-tree ship the Lesta tree does not carry. */
const WG_ONLY = 4183209712;
/** New Jersey (PASB310) — a Lesta-only ship the WG tree does not carry. */
const LESTA_ONLY = 3969857520;
/** Its Lesta-tree predecessor (PASB309). */
const LESTA_PARENT = 3970906096;
/** PZSC101 — a tier-I cruiser root (no predecessor in either tree). */
const ROOT_SHIP = 4188976336;

/** Accessor chain as the panel input (structural subset). */
function chainOf(shipId: number, realm: "wg" | "lesta" = "wg"): UpgradeChainInput {
  const chain = shipUpgradeChain(shipId, realm);
  if (!chain) throw new Error(`Missing chain fixture for ship ${shipId} (${realm})`);
  return chain;
}

function panelOf(chain: UpgradeChainInput, realm: "wg" | "lesta" = "wg") {
  const panel = buildUpgradeChainRows(chain, realm);
  if (!panel) throw new Error("expected a panel model");
  return panel;
}

function rowOf(chain: UpgradeChainInput, role: string, realm: "wg" | "lesta" = "wg"): UpgradeRow {
  const row = panelOf(chain, realm).rows.find((candidate) => candidate.role === role);
  if (!row) throw new Error(`missing row for ${role}`);
  return row;
}

/** Strip the per-step topology of one slot to exercise the defensive
 *  sequential fallback for a partial snapshot. */
function withoutTopology(chain: UpgradeChainInput, role: string): UpgradeChainInput {
  return {
    ...chain,
    slots: chain.slots.map((slot) =>
      chainRole(slot.ucType) !== role
        ? slot
        : {
            ...slot,
            steps: slot.steps.map((step) => ({
              ...step,
              prev: null,
              depth: invalidInput<number>(undefined),
            })),
          },
    ),
  };
}

/** Minimal TechTreeNode fixture for the predecessor tie-break tests. */
function node(partial: Partial<TechTreeNode> & Pick<TechTreeNode, "shipId">): TechTreeNode {
  return {
    index: `PX${partial.shipId}`,
    name: `IDS_${partial.shipId}`,
    tier: 5,
    type: "Destroyer",
    nation: "japan",
    isPremium: false,
    isSpecial: false,
    rarity: "Common",
    archetype: "",
    nextShips: [],
    group: "upgradeable",
    ...partial,
  };
}

describe("slot ordering and the stock-first layout", () => {
  it("orders slots hull first, then the game's equipment order", () => {
    const panel = panelOf(chainOf(MINSK));
    expect(panel.rows.map((row) => row.role)).toEqual([
      "hull",
      "suo",
      "artillery",
      "engine",
      "torpedoes",
    ]);
    expect(slotOrderOf("hull")).toBe(0);
    expect(slotOrderOf("torpedoes")).toBe(4);
    expect(slotOrderOf("secondaryweapons")).toBe(100);
  });

  it("renders a plain chain as stock -> top with centred adjacent columns", () => {
    const hull = rowOf(chainOf(MINSK), "hull");
    expect(hull.columns.length).toBe(2);
    expect(hull.laneCount).toBe(1);
    const [stock] = hull.columns[0];
    const [top] = hull.columns[1];
    expect(stock.step.isStock).toBe(true);
    expect(stock.step.depth).toBe(0);
    expect(stock.column).toBe(0);
    expect(stock.lane).toBe(0);
    expect(stock.parentName).toBeNull();
    expect(stock.variant).toBe("A");
    expect(top.step.depth).toBe(1);
    expect(top.parentName).toBe(stock.step.name);
    expect(top.column).toBe(1);
    expect(top.variant).toBe("B");
    // Columns are laid out left to right: cell.column matches its column.
    for (const column of hull.columns) {
      for (const cell of column) expect(cell.column).toBe(hull.columns.indexOf(column));
    }
  });

  it("keeps the stock module in column 0 even when the accessor lists it late", () => {
    const chain = chainOf(MINSK);
    const hullSlot = chain.slots.find((slot) => chainRole(slot.ucType) === "hull")!;
    const [stock, top] = hullSlot.steps;
    const scrambled: UpgradeChainInput = {
      ...chain,
      slots: chain.slots.map((slot) =>
        chainRole(slot.ucType) === "hull" ? { ...slot, steps: [top, stock] } : slot,
      ),
    };
    const hull = rowOf(scrambled, "hull");
    expect(hull.columns[0][0].step.name).toBe(stock.name);
    expect(hull.columns[0][0].column).toBe(0);
    expect(hull.columns[1][0].step.name).toBe(top.name);
  });

  it("returns null (the empty state) for a missing or empty chain", () => {
    expect(buildUpgradeChainRows(null)).toBeNull();
    expect(buildUpgradeChainRows({ ...chainOf(MINSK), slots: [] })).toBeNull();
  });
});

describe("parallel research options and per-step topology", () => {
  it("stacks same-depth options in one column and orders the columns by depth", () => {
    const hull = rowOf(chainOf(ALT_HULLS), "hull");
    expect(hull.columns.map((column) => column.map((cell) => cell.lane))).toEqual([
      [0, 1, 2],
      [0, 1, 2],
      [0],
    ]);
    expect(hull.laneCount).toBe(3);
    // Column letters are depth positions, shared by the stacked options.
    expect(hull.columns[0].map((cell) => cell.variant)).toEqual(["A", "A", "A"]);
    expect(hull.columns[1].map((cell) => cell.variant)).toEqual(["B", "B", "B"]);
    expect(hull.columns[2].map((cell) => cell.variant)).toEqual(["C"]);
    // The stock flag marks the first head only; the other depth-0 heads are
    // still alternatives inside the stock column.
    expect(hull.columns[0].filter((cell) => cell.step.isStock)).toHaveLength(1);
  });

  it("follows prev edges inside the column layout", () => {
    const hull = rowOf(chainOf(ALT_HULLS), "hull");
    const byName = new Map(hull.cells.map((cell) => [cell.step.name, cell]));
    expect(byName.get("PXUH022_HULL_AKATSUKI_ROMULANS")!.parentName).toBe(
      "PXUH021_HULL_AKATSUKI_ROMULANS",
    );
    expect(byName.get("PXUH023_HULL_AKATSUKI_ROMULANS")!.parentName).toBe(
      "PXUH022_HULL_AKATSUKI_ROMULANS",
    );
    expect(byName.get("PXUH025_HULL_AKATSUKI_ROMULANS")!.parentName).toBe(
      "PXUH024_HULL_AKATSUKI_ROMULANS",
    );
    expect(byName.get("PXUH027_HULL_AKATSUKI_ROMULANS")!.parentName).toBe(
      "PXUH026_HULL_AKATSUKI_ROMULANS",
    );
    // The extra depth-0 heads are chain starts: they have no connector.
    expect(byName.get("PXUH024_HULL_AKATSUKI_ROMULANS")!.parentName).toBeNull();
    expect(byName.get("PXUH026_HULL_AKATSUKI_ROMULANS")!.parentName).toBeNull();
  });

  it("renders a real three-deep chain as three ordered columns", () => {
    const torpedoes = rowOf(chainOf(SHIMAKAZE_912), "torpedoes");
    expect(torpedoes.columns.length).toBe(3);
    expect(torpedoes.laneCount).toBe(1);
    expect(torpedoes.columns.map((column) => column[0].step.depth)).toEqual([0, 1, 2]);
    expect(torpedoes.columns.map((column) => column[0].variant)).toEqual(["A", "B", "C"]);
    // Each column connects to the previous one through the real prev key.
    for (let index = 1; index < torpedoes.columns.length; index++) {
      const cell = torpedoes.columns[index][0];
      expect(cell.parentName).toBe(torpedoes.columns[index - 1][0].step.name);
      expect(cell.step.prev).toBe(cell.parentName);
    }
  });

  it("connects a cross-slot prerequisite from its own slot's previous column", () => {
    // Kiev's top torpedoes upgrade from hull B ("PRUH802_KIEV_B", depth 1):
    // the module is not part of the torpedo slot, so the connector stays in
    // the row (documented fallback) and the hover card names the required
    // module via cell.step.prev.
    const torpedoes = rowOf(chainOf(KIEV), "torpedoes");
    expect(torpedoes.columns.length).toBe(2);
    const [stock] = torpedoes.columns[0];
    const [top] = torpedoes.columns[1];
    expect(top.step.depth).toBe(1);
    expect(top.step.prev).toBe("PRUH802_KIEV_B");
    expect(top.parentName).toBe(stock.step.name);
  });

  it("falls back to sequential columns when a snapshot lacks the topology", () => {
    // Defensive default only: never collapse a row because a partial bundle
    // has no depth/prev values.
    const hull = rowOf(withoutTopology(chainOf(ALT_HULLS), "hull"), "hull");
    expect(hull.columns.length).toBe(7);
    expect(hull.laneCount).toBe(1);
  });
});

describe("unlocks and next-ship cards", () => {
  it("filters unlock targets to researchable ships of the realm", () => {
    expect(researchNextShipIds([PR_48, 999_999_999])).toEqual([PR_48]);
    expect(researchNextShipIds(undefined)).toEqual([]);
    expect(researchNextShipIds([])).toEqual([]);
    // Realm-aware: PISS106 is in the WG tree but not in the Lesta one.
    expect(researchNextShipIds([WG_ONLY], "wg")).toEqual([WG_ONLY]);
    expect(researchNextShipIds([WG_ONLY], "lesta")).toEqual([]);
  });

  it("turns the last module's unlocks into next-ship cards with xpShip", () => {
    const panel = panelOf(chainOf(MINSK));
    expect(panel.researchXp).toBe(researchOf(MINSK)!.xp);
    const hull = panel.rows.find((row) => row.role === "hull")!;
    expect(hull.nextShips.map((link) => link.shipId)).toEqual([PR_48]);
    expect(hull.nextShips[0].index).toBe("PRSD308");
    // The extension-line tooltip value: the NEXT ship's own research XP.
    expect(hull.nextShips[0].xpShip).toBe(researchOf(PR_48)!.xp);
    const torpedoes = panel.rows.find((row) => row.role === "torpedoes")!;
    expect(torpedoes.nextShips.map((link) => link.shipId)).toEqual([PR_30]);
    expect(torpedoes.nextShips[0].xpShip).toBe(researchOf(PR_30)!.xp);
  });

  it("groups multiple unlocks of one module into deduped cards", () => {
    const chain = chainOf(MINSK);
    const withLinks: UpgradeChainInput = {
      ...chain,
      slots: chain.slots.map((slot) =>
        chainRole(slot.ucType) === "hull"
          ? {
              ...slot,
              steps: slot.steps.map((step, index) =>
                index === slot.steps.length - 1
                  ? { ...step, unlocks: [PR_48, PR_30, PR_30] }
                  : step,
              ),
            }
          : slot,
      ),
    };
    const hull = rowOf(withLinks, "hull");
    expect(hull.nextShips.map((link) => link.shipId)).toEqual([PR_48, PR_30]);
  });

  it("only the row's LAST module extends toward the next ship", () => {
    const chain = chainOf(MINSK);
    const withStockUnlock: UpgradeChainInput = {
      ...chain,
      slots: chain.slots.map((slot) =>
        chainRole(slot.ucType) === "hull"
          ? {
              ...slot,
              steps: slot.steps.map((step, index) => ({
                ...step,
                unlocks: index === 0 ? [PR_48] : undefined,
              })),
            }
          : slot,
      ),
    };
    expect(rowOf(withStockUnlock, "hull").nextShips).toEqual([]);
  });
});

describe("previous-tier ship resolution", () => {
  it("finds the tech-tree node whose nextShips lists the ship", () => {
    const previous = resolvePreviousShip(SHIMAKAZE_1943);
    expect(previous).not.toBeNull();
    expect(previous!.shipId).toBe(YUGUMO);
    expect(previous!.tier).toBe(9);
    expect(previous!.type).toBe("Destroyer");
    expect(previous!.nextShips).toContain(SHIMAKAZE_1943);
    expect(techTreeNode(YUGUMO)).not.toBeNull();
  });

  it("is realm-aware and misses cleanly", () => {
    // Lesta-only hull: no WG predecessor, resolves in the Lesta tree.
    expect(resolvePreviousShip(LESTA_ONLY, "wg")).toBeNull();
    expect(resolvePreviousShip(LESTA_ONLY, "lesta")?.shipId).toBe(LESTA_PARENT);
    // Tier-I roots have no predecessor in either tree.
    expect(resolvePreviousShip(ROOT_SHIP, "wg")).toBeNull();
    expect(resolvePreviousShip(-1)).toBeNull();
  });

  it("prefers the same ship type, then the lowest tier, when several qualify", () => {
    const target = node({ shipId: 1, type: "Destroyer", tier: 8 });
    const picked = pickPreviousShip(target, [
      node({ shipId: 2, type: "Cruiser", tier: 6 }),
      node({ shipId: 3, type: "Destroyer", tier: 7 }),
      node({ shipId: 4, type: "Destroyer", tier: 6 }),
    ]);
    expect(picked?.shipId).toBe(4);
    // Premium side leaves never win over a researchable parent.
    expect(
      pickPreviousShip(target, [
        node({ shipId: 5, type: "Destroyer", tier: 6, isPremium: true }),
        node({ shipId: 6, type: "Battleship", tier: 8 }),
      ])?.shipId,
    ).toBe(6);
    expect(pickPreviousShip(target, [])).toBeNull();
  });
});

describe("tile/role presentation helpers", () => {
  it("normalizes role keys for the i18n table", () => {
    expect(chainRole("_Hull")).toBe("hull");
    expect(chainRole("Hull")).toBe("hull");
    expect(chainRole("_PrimaryWeapons")).toBe("primaryweapons");
    expect(chainRole("airArmament")).toBe("airarmament");
  });

  it("letters the columns A, B, ... Z, AA ...", () => {
    expect(variantLetter(0)).toBe("A");
    expect(variantLetter(1)).toBe("B");
    expect(variantLetter(25)).toBe("Z");
    expect(variantLetter(26)).toBe("AA");
  });

  it("parses the stock/med/top marker out of the opaque module name", () => {
    expect(variantMarkerOf("PJUH841_D9_HULL_STOCK_2")).toBe("stock");
    expect(variantMarkerOf("PJUT815_D9_TORP_MED_4")).toBe("med");
    expect(variantMarkerOf("PJUT908_D10_TORP_TOP_2")).toBe("top");
    expect(variantMarkerOf("PRUH975_GROZ")).toBeNull();
  });

  it("lists the mounted component roles in canonical order", () => {
    const hull = rowOf(chainOf(MINSK), "hull");
    const mounted = mountedComponents(hull.columns[0][0].step.components);
    expect(mounted.map((entry) => entry.role)).toEqual([
      "hull",
      "artillery",
      "torpedoes",
      "depthcharges",
      "airdefense",
      "radars",
      "directors",
      "finders",
    ]);
    // Component NAMES are reported verbatim, empty roles are dropped.
    expect(mounted[0].names).toEqual(["A_Hull"]);
    expect(mountedComponents(null)).toEqual([]);
    expect(mountedComponents({ hull: [], engine: ["AB_Engine"] })).toEqual([
      { role: "engine", names: ["AB_Engine"] },
    ]);
  });
});
