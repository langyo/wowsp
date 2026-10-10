/**
 * Tests for ship part role resolution (shipParts) and weapon grouping
 * (shipWeapons) — the fleet audit in scripts/check_weapons.py mirrors
 * these rules, so both sides must stay in lockstep:
 *  - role blocks resolve from ShipUpgradeInfo (top = chain end, stock =
 *    chain head) for ships whose components keep historical codes
 *    (A1_610 torpedoes, AB_127_50 guns — Shimakaze style);
 *  - ships with canonical component names resolve identically
 *    (X Worcester style);
 *  - AirArmament is aircraft catapults and NEVER surfaces as torpedoes
 *    (the Worcester "鱼雷 2×1" bug);
 *  - entries without a parsable ShipUpgradeInfo fall back to canonical
 *    literal keys;
 *  - dual-purpose mounts (same gun id in ATBA + AirDefense) collapse into
 *    one DP group.
 */

import { describe, expect, it } from "vitest";

import { resolveShipParts } from "./shipParts";
import { summarizeWeapons } from "./shipWeapons";

/** A gun/torpedo mount HP slot. */
function mount(barrels: number, cal = 0, extra: Record<string, unknown> = {}) {
  return { numBarrels: barrels, ...(cal ? { barrelDiameter: cal / 1000 } : {}), ...extra };
}

/** Mount slots keyed HP_S_x_1..n inside a component block. */
function blockWithMounts(prefix: string, count: number, barrels: number, cal = 0) {
  const block: Record<string, unknown> = {};
  for (let i = 1; i <= count; i++) block[`HP_${prefix}_${i}`] = mount(barrels, cal);
  return block;
}

/** Shimakaze-style entry: every component carries a historical code. */
function shimakazeLike() {
  const guns = blockWithMounts("SG", 2, 2, 127); // AB_127_50: 2 twin 127mm mounts
  const torpStock = blockWithMounts("JGT", 2, 4); // A1_610: 2×4 tubes
  const torpTop = blockWithMounts("JGT", 3, 5); // A3_610: 3×5 tubes
  const aa = {
    HP_JGA_1: mount(1),
    Near_1: { type: "near", areaDamage: 20, maxDistance: 2000, guns: ["HP_JGA_1"] },
  };
  const hull = { health: 17900, maxSpeed: 33, draft: 3.9, armor: { bow: 12 } };
  const gp: Record<string, unknown> = {
    name: "PJSD012_Shimakaze_1944",
    A1_610: torpStock,
    A3_610: torpTop,
    AB_127_50: guns,
    B_AirDefense: aa,
    B_Hull: hull,
    ShipUpgradeInfo: {
      PJUH802_Shimakaze_1944: {
        ucType: "_Hull",
        prev: "",
        components: {
          hull: ["B_Hull"],
          artillery: ["AB_127_50"],
          torpedoes: ["A1_610", "A2_610", "A3_610"],
          airDefense: ["B_AirDefense"],
          airArmament: [],
          atba: [],
        },
      },
      PJUT901_D10_TORP_STOCK: { ucType: "_Torpedoes", prev: "", components: { torpedoes: ["A1_610"] } },
      PJUT904_D10_TORP_MED: { ucType: "_Torpedoes", prev: "PJUT901_D10_TORP_STOCK", components: { torpedoes: ["A2_610"] } },
      PJUT905_D10_TORP_TOP: { ucType: "_Torpedoes", prev: "PJUT904_D10_TORP_MED", components: { torpedoes: ["A3_610"] } },
    },
  };
  gp.A2_610 = blockWithMounts("JGT", 2, 5);
  return gp;
}

/** Worcester-style entry: canonical names, catapults, NO torpedo role. */
function worcesterLike() {
  return {
    name: "PASC210_Worcester_1944",
    A_Artillery: blockWithMounts("AGM", 6, 2, 152),
    A_AirArmament: blockWithMounts("AC", 2, 1), // 2 catapult slots — not torpedoes
    A_AirDefense: {
      HP_AGA_1: mount(1),
      Medium_1: { type: "medium", areaDamage: 124, maxDistance: 4000, guns: ["HP_AGA_1"] },
    },
    A_Hull: { health: 45400, maxSpeed: 33, draft: 6.1 },
    A_DepthCharge: blockWithMounts("DCA", 2, 1),
    ShipUpgradeInfo: {
      PASC210_1944: {
        ucType: "_Hull",
        prev: "",
        components: {
          hull: ["A_Hull"],
          artillery: ["A_Artillery"],
          torpedoes: [],
          airDefense: ["A_AirDefense"],
          airArmament: ["A_AirArmament"],
          depthCharges: ["A_DepthCharge"],
          atba: [],
        },
      },
    },
  };
}

describe("resolveShipParts", () => {
  it("resolves historical component codes via ShipUpgradeInfo (Shimakaze style)", () => {
    const gp = shimakazeLike();
    const top = resolveShipParts(gp, "top");
    expect(top.artillery).toHaveLength(1);
    expect(top.artillery[0]).toBe(gp.AB_127_50);
    // Torpedo chain end = the top variant (3×5), not the stock (2×4).
    expect(top.torpedoes).toHaveLength(1);
    expect(top.torpedoes[0]).toBe(gp.A3_610);
    expect(top.airDefense[0]).toBe(gp.B_AirDefense);
    expect(top.airArmament).toHaveLength(0);
    expect(top.hull).toBe(gp.B_Hull);

    const stock = resolveShipParts(gp, "stock");
    expect(stock.torpedoes[0]).toBe(gp.A1_610);
  });

  it("resolves canonical component names equally (Worcester style)", () => {
    const gp = worcesterLike();
    const parts = resolveShipParts(gp, "top");
    expect(parts.artillery).toHaveLength(1);
    expect(parts.torpedoes).toHaveLength(0); // no torpedo role → no blocks
    expect(parts.airArmament).toHaveLength(1);
    expect(parts.depthCharges).toHaveLength(1);
    expect(parts.hull).toBe(gp.A_Hull);
  });

  it("picks the chain-end hull of a multi-hull ship", () => {
    const stockArt = blockWithMounts("AGM", 3, 3, 152);
    const topArt = blockWithMounts("AGM", 4, 3, 152);
    const stockHull = { health: 30000, armor: {} };
    const topHull = { health: 35400, armor: {} };
    const gp: Record<string, unknown> = {
      PVU_A_Artillery: stockArt,
      PVU_B_Artillery: topArt,
      PVU_A_Hull: stockHull,
      PVU_B_Hull: topHull,
      ShipUpgradeInfo: {
        "PVU_A_HULL_STOCK": {
          ucType: "_Hull", prev: "",
          components: { hull: ["PVU_A_Hull"], artillery: ["PVU_A_Artillery"], torpedoes: [] },
        },
        "PVU_B_HULL_TOP": {
          ucType: "_Hull", prev: "PVU_A_HULL_STOCK",
          components: { hull: ["PVU_B_Hull"], artillery: ["PVU_B_Artillery"], torpedoes: [] },
        },
      },
    };
    const top = resolveShipParts(gp, "top");
    const stock = resolveShipParts(gp, "stock");
    expect(top.hull).toBe(topHull);
    expect(top.artillery[0]).toBe(topArt);
    expect(stock.hull).toBe(stockHull);
    expect(stock.artillery[0]).toBe(stockArt);
  });

  it("does not double-count when an upgrade co-lists every hull's blocks", () => {
    // North Carolina style: ONE stock artillery upgrade names BOTH hull
    // variants' blocks; each hull entry names exactly the one it mounts.
    const artA = blockWithMounts("AGM", 3, 3, 406);
    const artB = blockWithMounts("AGM", 3, 3, 406);
    const hullA = { health: 30000 };
    const hullB = { health: 35400 };
    const gp: Record<string, unknown> = {
      A_Artillery: artA,
      B_Artillery: artB,
      A_Hull: hullA,
      B_Hull: hullB,
      ShipUpgradeInfo: {
        "PAUA741_B8_ART_STOCK": {
          ucType: "_Artillery", prev: "",
          components: { artillery: ["A_Artillery", "B_Artillery"] },
        },
        "PAUH732_NC_1942": {
          ucType: "_Hull", prev: "",
          components: { hull: ["A_Hull"], artillery: ["A_Artillery"], torpedoes: [] },
        },
        "PAUH733_NC_1945": {
          ucType: "_Hull", prev: "PAUH732_NC_1942",
          components: { hull: ["B_Hull"], artillery: ["B_Artillery"], torpedoes: [] },
        },
      },
    };
    const main = summarizeWeapons(gp).filter((g) => g.kind === "mainGun");
    expect(main).toEqual([{ kind: "mainGun", count: 3, barrels: 3, cal: 406 }]);
    expect(resolveShipParts(gp, "stock").artillery).toEqual([artA]);
    expect(resolveShipParts(gp, "top").artillery).toEqual([artB]);
  });

  it("dedupes slot keys shared by co-listed blocks of one role", () => {
    // Residual event-ship shape: after hull intersection two blocks of one
    // role still carry the same hardpoint — it mounts once.
    const blockA = { HP_T_1: mount(4), HP_T_2: mount(4) };
    const blockB = { HP_T_2: mount(4), HP_T_3: mount(4) };
    const gp: Record<string, unknown> = {
      A_Torpedoes: blockA,
      B_Torpedoes: blockB,
      A_Hull: { health: 1000 },
      ShipUpgradeInfo: {
        hull: {
          ucType: "_Hull", prev: "",
          components: { hull: ["A_Hull"], torpedoes: ["A_Torpedoes", "B_Torpedoes"] },
        },
      },
    };
    const torp = summarizeWeapons(gp).filter((g) => g.kind === "torpedo");
    expect(torp).toEqual([{ kind: "torpedo", count: 3, barrels: 4, cal: 0 }]);
  });

  it("falls back to the canonical literal block when the hull omits a role", () => {
    // Midway legacy hull: no ATBA chain, hull components without atba — the
    // secondaries (and their far AA aura) live in a literal A_ATBA.
    const atba = { HP_SGP_1: mount(2, 127), Far_1: { type: "far", areaDamage: 64 } };
    const gp: Record<string, unknown> = {
      A_ATBA: atba,
      A_Hull: { health: 60000 },
      ShipUpgradeInfo: {
        hull: {
          ucType: "_Hull", prev: "",
          components: { hull: ["A_Hull"], artillery: [], torpedoes: [], atba: [] },
        },
      },
    };
    expect(resolveShipParts(gp, "top").atba).toEqual([atba]);
    expect(resolveShipParts(gp, "stock").atba).toEqual([atba]);
  });

  it("falls back to canonical literal keys without ShipUpgradeInfo", () => {
    const gp = {
      A_Artillery: blockWithMounts("AGM", 2, 3, 127),
      A_Torpedoes: blockWithMounts("JGT", 1, 4),
      A_AirArmament: blockWithMounts("AC", 1, 1),
      A_Hull: { health: 10000 },
    };
    const parts = resolveShipParts(gp, "top");
    expect(parts.artillery).toHaveLength(1);
    expect(parts.torpedoes).toHaveLength(1);
    expect(parts.airArmament).toHaveLength(1);
    expect(parts.hull).toBe(gp.A_Hull);
  });

  it("tolerates garbage input", () => {
    expect(resolveShipParts(null)).toEqual(resolveShipParts(undefined));
    expect(resolveShipParts(null).artillery).toHaveLength(0);
    expect(resolveShipParts({ ShipUpgradeInfo: 42 }).torpedoes).toHaveLength(0);
  });
});

describe("summarizeWeapons", () => {
  it("gives a catapult-only cruiser NO torpedo group and an aircraft one", () => {
    const groups = summarizeWeapons(worcesterLike());
    const kinds = groups.map((g) => g.kind);
    expect(kinds).not.toContain("torpedo");
    expect(kinds).toContain("aircraft");
    expect(kinds).toContain("mainGun");
    expect(kinds).toContain("asw");
    const main = groups.find((g) => g.kind === "mainGun")!;
    expect(main).toMatchObject({ count: 6, barrels: 2, cal: 152 });
    const aircraft = groups.find((g) => g.kind === "aircraft")!;
    expect(aircraft.count).toBe(2);
  });

  it("summarizes the top torpedo configuration for historical codes", () => {
    const groups = summarizeWeapons(shimakazeLike());
    const torp = groups.filter((g) => g.kind === "torpedo");
    expect(torp).toHaveLength(1);
    expect(torp[0]).toMatchObject({ count: 3, barrels: 5 }); // 3 mounts × 5 tubes
    const main = groups.find((g) => g.kind === "mainGun")!;
    expect(main).toMatchObject({ count: 2, barrels: 2, cal: 127 });
  });

  it("collapses dual-purpose mounts into one DP group", () => {
    const dpMount = mount(2, 127, { name: "USA_DP_127" });
    const gp = {
      A_ATBA: { HP_SGP_1: dpMount, HP_SGP_2: { ...dpMount, name: "USA_SEC_127" } },
      A_AirDefense: {
        HP_AGA_1: dpMount,
        Medium_1: { type: "medium", areaDamage: 10, maxDistance: 4000, guns: ["HP_AGA_1"] },
      },
      ShipUpgradeInfo: {
        hull: {
          ucType: "_Hull", prev: "",
          components: { hull: [], artillery: [], atba: ["A_ATBA"], airDefense: ["A_AirDefense"], torpedoes: [] },
        },
      },
    };
    const groups = summarizeWeapons(gp);
    // GUNLESS hull: the whole same-caliber ATBA group is promoted to main
    // battery (both mounts — the promotion takes the largest caliber group);
    // USA_DP_127 still collapses into one DP group of 2 and no AA group.
    expect(groups.filter((g) => g.kind === "dp")).toHaveLength(1);
    expect(groups.filter((g) => g.kind === "mainGun")).toEqual([
      { kind: "mainGun", count: 2, barrels: 2, cal: 127 },
    ]);
    expect(groups.filter((g) => g.kind === "secondary")).toHaveLength(0);
    expect(groups.filter((g) => g.kind === "aa")).toHaveLength(0);
  });

  it("keeps torpedo mounts out of ships whose torps live only in AirArmament", () => {
    // Loose-dump shape without ShipUpgradeInfo: canonical fallback must not
    // read A_AirArmament as torpedoes either.
    const groups = summarizeWeapons({
      A_Artillery: blockWithMounts("AGM", 1, 2, 127),
      A_AirArmament: blockWithMounts("AC", 3, 1),
    });
    expect(groups.map((g) => g.kind)).toEqual(["mainGun", "aircraft"]);
  });

  it("falls back to the ASW airstrike when the hull has no depth-charge racks", () => {
    // Yamato/Des Moines-class: the only ASW is the A_AirSupport airstrike.
    const groups = summarizeWeapons({
      A_Artillery: blockWithMounts("AGM", 3, 3, 460),
      A_AirSupport: { chargesNum: 2, maxDist: 11000, reloadTime: 30 },
      ShipUpgradeInfo: {
        hull: {
          ucType: "_Hull", prev: "",
          components: {
            hull: [], artillery: ["A_Artillery"], torpedoes: [],
            atba: [], airDefense: [], airArmament: [],
            depthCharges: [], airSupport: ["A_AirSupport"],
          },
        },
      },
    });
    const asw = groups.filter((g) => g.kind === "asw");
    expect(asw).toEqual([{ kind: "asw", count: 2, barrels: 0, cal: 0 }]);
  });

  it("returns no groups for garbage input", () => {
    expect(summarizeWeapons(null)).toEqual([]);
    expect(summarizeWeapons(undefined)).toEqual([]);
    expect(summarizeWeapons({})).toEqual([]);
  });
});
