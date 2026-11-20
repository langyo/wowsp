/** Tests for the spec panel's module-variant enumeration (shipVariantSpecs.ts).
 *
 *  Synthetic slices pin the pure model: prev-chain ordering (stock → top,
 *  parallel same-depth options keeping table order), the ordered variant
 *  letters, default = chain end, non-default selection resolution, and the
 *  hardpoint aggregation the spec groups' recompute reads (barrels summed,
 *  first shotDelay, widest caliber). A real-slice spot check rides the
 *  bundled Shimakaze fixture for the torpedo chain topology.
 */
import { describe, expect, it } from "vitest";

import {
  buildShipVariantOptions,
  defaultVariantOf,
  findVariantOf,
  mountStatsOf,
  selectedVariantOf,
  variantLetter,
  variantMountStats,
  variantStageOf,
} from "./shipVariantSpecs";

/** A minimal slice with a three-hull chain and a stock→mid→top torpedo chain. */
function slice(): Record<string, unknown> {
  return {
    ShipUpgradeInfo: {
      costCR: 100,
      HULL_A: { ucType: "_Hull", prev: "", components: { hull: ["B_Hull_A"] } },
      HULL_B: { ucType: "_Hull", prev: "HULL_A", components: { hull: ["B_Hull_B"] } },
      HULL_C: { ucType: "_Hull", prev: "HULL_B", components: { hull: ["B_Hull_C"] } },
      TORP_STOCK: { ucType: "_Torpedoes", prev: "", components: { torpedoes: ["A1_610"] } },
      TORP_MED: { ucType: "_Torpedoes", prev: "TORP_STOCK", components: { torpedoes: ["A2_610"] } },
      ART_STOCK: { ucType: "_Artillery", prev: "", components: { artillery: ["AB_127"] } },
    },
    B_Hull_A: { health: 15000, visibilityFactor: 7.2, visibilityFactorByPlane: 3.6 },
    B_Hull_B: { health: 17900, visibilityFactor: 6.9, visibilityFactorByPlane: 3.38 },
    B_Hull_C: { health: 19900, visibilityFactor: 6.6, visibilityFactorByPlane: 3.2 },
    A1_610: {
      HP_JGT_1: { numBarrels: 5, shotDelay: 150 },
      HP_JGT_2: { numBarrels: 5, shotDelay: 150 },
    },
    A2_610: { HP_JGT_1: { numBarrels: 3, shotDelay: 153 } },
    AB_127: {
      maxDist: 11370,
      HP_JGM_1: { numBarrels: 2, shotDelay: 5.74, barrelDiameter: 0.127 },
      HP_JGM_2: { numBarrels: 2, shotDelay: 5.74, barrelDiameter: 0.127 },
    },
  };
}

describe("variantLetter", () => {
  it("walks A…Z then AA, AB", () => {
    expect(variantLetter(0)).toBe("A");
    expect(variantLetter(25)).toBe("Z");
    expect(variantLetter(26)).toBe("AA");
    expect(variantLetter(27)).toBe("AB");
  });
});

describe("buildShipVariantOptions", () => {
  it("orders each chain stock → top and letters it in position order", () => {
    const opts = buildShipVariantOptions(slice());
    expect(opts.survivability?.map((o) => o.name)).toEqual(["HULL_A", "HULL_B", "HULL_C"]);
    expect(opts.survivability?.map((o) => o.variant)).toEqual(["A", "B", "C"]);
    expect(opts.survivability?.map((o) => o.depth)).toEqual([0, 1, 2]);
    expect(opts.torpedoes?.map((o) => o.name)).toEqual(["TORP_STOCK", "TORP_MED"]);
    // AA follows the hull chain when the slice has no dedicated chain.
    expect(opts.antiAir?.map((o) => o.name)).toEqual(["HULL_A", "HULL_B", "HULL_C"]);
    expect(opts.concealment?.map((o) => o.name)).toEqual(["HULL_A", "HULL_B", "HULL_C"]);
  });

  it("returns no options for loose dumps without ShipUpgradeInfo", () => {
    expect(buildShipVariantOptions({})).toEqual({});
    expect(buildShipVariantOptions(null)).toEqual({});
    expect(buildShipVariantOptions({ ShipUpgradeInfo: {} })).toEqual({});
  });
});

describe("default / selected resolution", () => {
  const opts = buildShipVariantOptions(slice());

  it("treats the chain end as the default (profile rendering)", () => {
    expect(defaultVariantOf(opts.survivability)?.name).toBe("HULL_C");
    expect(selectedVariantOf(opts.survivability, "HULL_C")).toBeNull();
    expect(selectedVariantOf(opts.survivability, undefined)).toBeNull();
  });

  it("resolves an explicit non-default pick", () => {
    expect(selectedVariantOf(opts.survivability, "HULL_A")?.name).toBe("HULL_A");
    expect(findVariantOf(opts.torpedoes, "TORP_MED")?.role).toBe("torpedoes");
    expect(findVariantOf(opts.torpedoes, "nope")).toBeNull();
  });
});

describe("variantStageOf", () => {
  const opts = buildShipVariantOptions(slice());

  it("reads the chain stage from depths, not list positions", () => {
    const hulls = opts.survivability!;
    expect(hulls.map((o) => variantStageOf(hulls, o))).toEqual(["stock", "mid", "top"]);
    const torps = opts.torpedoes!;
    expect(torps.map((o) => variantStageOf(torps, o))).toEqual(["stock", "top"]);
  });

  it("classifies parallel same-depth variants alike", () => {
    // A second stock-rooted hull joins the table after the whole chain:
    // both roots are stock, only the depth-1/2 steps climb to top.
    const g = slice();
    const info = g.ShipUpgradeInfo as Record<string, Record<string, unknown>>;
    info.HULL_B2 = { ucType: "_Hull", prev: "", components: { hull: ["B_Hull_B2"] } };
    const hulls = buildShipVariantOptions(g).survivability!;
    expect(hulls.map((o) => o.name)).toEqual(["HULL_A", "HULL_B2", "HULL_B", "HULL_C"]);
    expect(hulls.map((o) => variantStageOf(hulls, o))).toEqual(["stock", "stock", "mid", "top"]);
  });

  it("keeps a cross-slot prev one level above stock (top)", () => {
    // A hull-locked top torp bank (prev into the hull slot) replaces the
    // mid step: it sits at depth 1 next to the stock root.
    const g = slice();
    const info = g.ShipUpgradeInfo as Record<string, Record<string, unknown>>;
    delete info.TORP_MED;
    info.TORP_TOP = { ucType: "_Torpedoes", prev: "HULL_B", components: { torpedoes: ["A3_610"] } };
    const torps = buildShipVariantOptions(g).torpedoes!;
    expect(torps.map((o) => o.name)).toEqual(["TORP_STOCK", "TORP_TOP"]);
    expect(torps.map((o) => variantStageOf(torps, o))).toEqual(["stock", "top"]);
  });

  it("answers stock for single-entry chains (no dropdown renders)", () => {
    const art = opts.artillery!;
    expect(art.map((o) => variantStageOf(art, o))).toEqual(["stock"]);
  });
});

describe("mountStatsOf / variantMountStats", () => {
  it("sums hardpoint barrels, keeps the first reload and the widest caliber", () => {
    const g = slice();
    expect(mountStatsOf(g.AB_127 as Record<string, unknown>)).toMatchObject({
      barrels: 4,
      reloadS: 5.74,
      caliberMm: 127,
    });
  });

  it("aggregates a variant's blocks through its component map", () => {
    const g = slice();
    const stock = findVariantOf(buildShipVariantOptions(g).torpedoes, "TORP_STOCK")!;
    expect(variantMountStats(g, stock, "torpedoes")).toMatchObject({
      barrels: 10,
      reloadS: 150,
    });
  });

  it("returns null stats for blocks without hardpoints", () => {
    expect(mountStatsOf({ maxDist: 11370 })).toEqual({
      barrels: null,
      reloadS: null,
      caliberMm: null,
    });
  });
});
