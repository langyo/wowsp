import { describe, expect, it } from "vitest";

import {
  aircraftFits,
  aswAirstrikeFit,
  hasAswAirstrike,
  hasComparePlanes,
  shipCompareFits,
} from "./shipCompareFits";

/**
 * Tests for the compare table's weapon-fit enumeration: the alternate
 * firing mode fit (Vyazma-style switchable battery), the stock fits the
 * upgrade chain's head modules produce (artillery / torpedoes / hull,
 * each tagged base), the TOP-side extras (researchable torpedo alternates
 * tagged base/top by stock mounting, the ASW airstrike the WG profile has
 * no block for) and the per-airframe aircraft rows shared with the detail
 * modal's squadron pipeline (slice planes first, the baked seed offline).
 * Fixtures follow shipParts.test.ts's synthetic GameParams shapes; the
 * seed tests pin real committed data (Hakuryu 4179605200).
 */

/** Locale-independent read of a formatted display number ("25,950" →
 *  25950), the same discipline shipSpecs.test.ts uses for DPM rows. */
function asNumber(text: string): number {
  return Number(text.replace(/[^0-9.-]/g, ""));
}

function fmtDpm(dmg: number, barrels: number, reload: number): string {
  return ((dmg * barrels * 60) / reload).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** Vyazma-shaped main battery: the alternate-firing module (2-salvo burst,
 *  45 s full reload, ×0.5727 range) + the shape-v3 __shellAmmo embedding. */
function altFireGameparams(): Record<string, unknown> {
  return {
    A_Artillery: {
      HP_RGM_1: { ammoList: ["PRPA208_HE", "PRPA209_AP"], barrelDiameter: 0.406, numBarrels: 2, shotDelay: 33 },
      HP_RGM_2: { ammoList: ["PRPA208_HE", "PRPA209_AP"] },
      SwitchableModeArtilleryModule: {
        burstReloadTime: 1.7,
        fullReloadTime: 45,
        modifiers: { GMMaxDist: 0.5727 },
        shotsCount: 2,
        secondaryAmmoList: ["PRPA210_HE_ALT", "PRPA209_AP", "PRPA211_AP_ALT"],
      },
    },
    __shellAmmo: {
      PRPA208_HE: { ammoType: "HE", alphaDamage: 5800, burnProb: 0.4, alphaPiercingHE: 68, bulletSpeed: 830 },
      PRPA209_AP: { ammoType: "AP", alphaDamage: 13_250, bulletSpeed: 830 },
      PRPA210_HE_ALT: { ammoType: "HE", alphaDamage: 5800, burnProb: 0.4, alphaPiercingHE: 68, bulletSpeed: 830 },
      PRPA211_AP_ALT: { ammoType: "AP", alphaDamage: 13_250, bulletSpeed: 900 },
    },
  };
}

const altFireProfile = {
  hull: { health: 64_200, artillery_barrels: 2 },
  artillery: {
    shot_delay: 33,
    distance: 20.9,
    max_dispersion: 266,
    shells: {
      HE: { damage: 5800, burn_probability: 40, bullet_speed: 830 },
      AP: { damage: 13_250, bullet_speed: 830 },
    },
  },
};

/** Two-hull tech-tree ship: the stock hull's artillery differs from the
 *  researched one (smaller guns, faster reload) via ShipUpgradeInfo. */
function stockArtilleryGameparams(): Record<string, unknown> {
  return {
    name: "PJSC118_Kongo_like",
    A_Hull: { health: 49_000 },
    B_Hull: { health: 55_000 },
    PJSB105_Artillery: {
      HP_SGM_1: {
        numBarrels: 2,
        barrelDiameter: 0.356,
        shotDelay: 26,
        rotationSpeed: [3.2],
        ammoList: ["PJPA005_HE", "PJPA006_AP"],
      },
    },
    PJSB106_Artillery: {
      HP_SGM_1: {
        numBarrels: 3,
        barrelDiameter: 0.41,
        shotDelay: 30,
        rotationSpeed: [2.8],
        ammoList: ["PJPA007_HE", "PJPA008_AP"],
      },
    },
    __shellAmmo: {
      PJPA005_HE: { ammoType: "HE", alphaDamage: 5800, burnProb: 0.3, alphaPiercingHE: 55, bulletSpeed: 870 },
      PJPA006_AP: { ammoType: "AP", alphaDamage: 10_300, bulletSpeed: 800 },
      PJPA007_HE: { ammoType: "HE", alphaDamage: 7300, burnProb: 0.35, alphaPiercingHE: 65, bulletSpeed: 806 },
      PJPA008_AP: { ammoType: "AP", alphaDamage: 11_600, bulletSpeed: 790 },
    },
    ShipUpgradeInfo: {
      PJSC108_Hull_A: { ucType: "_Hull", prev: "", components: { hull: ["A_Hull"], artillery: ["PJSB105_Artillery"], torpedoes: [] } },
      PJSC108_Hull_B: { ucType: "_Hull", prev: "PJSC108_Hull_A", components: { hull: ["B_Hull"], artillery: ["PJSB106_Artillery"], torpedoes: [] } },
      PJSC109_Artillery_A: { ucType: "_Artillery", prev: "", components: { artillery: ["PJSB105_Artillery"] } },
      PJSC109_Artillery_B: { ucType: "_Artillery", prev: "PJSC109_Artillery_A", components: { artillery: ["PJSB106_Artillery"] } },
    },
  };
}

/** Shimakaze-shaped two-hull torpedo ship: stock 2×4 mod-1 tubes vs top
 *  3×5 mod-3 tubes, identical artillery, plus a researchable F3 the
 *  launchers never mount (an alias of mod 3 — the dedupe drops it). */
function torpedoShip(): Record<string, unknown> {
  const gunMount = { numBarrels: 2, barrelDiameter: 0.127, shotDelay: 5, ammoList: ["S_HE"] };
  return {
    A_Artillery: { HP_AGM_1: { ...gunMount } },
    B_Artillery: { HP_AGM_1: { ...gunMount } },
    A_Torpedoes: { HP_JGT_1: { numBarrels: 4, ammoList: ["T_610_MOD1"] } },
    B_Torpedoes: { HP_JGT_1: { numBarrels: 5, ammoList: ["T_610_MOD3"] } },
    __torpedoAmmo: {
      T_610_MOD1: { alphaDamage: 17_000, speed: 67, maxDist: 466.7, visibilityFactor: 1.5 },
      T_610_MOD3: { alphaDamage: 21_300, speed: 76, maxDist: 600, visibilityFactor: 1.8 },
      T_610_F3: { alphaDamage: 21_300, speed: 76, maxDist: 600, visibilityFactor: 1.8 },
    },
    A_Hull: { health: 17_900, maxSpeed: 33, turningRadius: 550 },
    B_Hull: { health: 17_900, maxSpeed: 33, turningRadius: 550 },
    ShipUpgradeInfo: {
      PJUH801: {
        ucType: "_Hull",
        prev: "",
        components: { hull: ["A_Hull"], artillery: ["A_Artillery"], torpedoes: ["A_Torpedoes"] },
      },
      PJUH802: {
        ucType: "_Hull",
        prev: "PJUH801",
        components: { hull: ["B_Hull"], artillery: ["B_Artillery"], torpedoes: ["B_Torpedoes"] },
      },
      PJUT801: { ucType: "_Torpedoes", prev: "", components: { torpedoes: ["A_Torpedoes"] } },
      PJUT802: { ucType: "_Torpedoes", prev: "PJUT801", components: { torpedoes: ["B_Torpedoes"] } },
    },
  };
}

describe("shipCompareFits", () => {
  it("returns no fits without a gameparams slice for a hull the seed does not cover", () => {
    expect(shipCompareFits(altFireProfile, "russia", null, 12345)).toEqual([]);
    expect(shipCompareFits(altFireProfile, "russia", undefined, 12345)).toEqual([]);
  });

  it("emits the alternate firing mode fit with the mode's values", () => {
    const fits = shipCompareFits(altFireProfile, "russia", altFireGameparams(), 12345);
    const alt = fits.find((f) => f.key === "altFire");
    expect(alt).toBeDefined();
    expect(alt!.labelKey).toBe("ships.spec.altFire");
    expect(alt!.groupKeys).toEqual(["artillery"]);
    // The alt mode is a TOP-configuration capability.
    expect(alt!.variant).toBe("top");
    // Range follows the mode multiplier (20.9 × 0.5727 ≈ 12.0 km) and the
    // reload the full burst cycle (45 s).
    expect(alt!.values.mainGunRange).toBe("12.0 km");
    expect(alt!.values.mainGunReload).toBe("45.0 s");
    // Shell columns switch to the alternate shells.
    expect(alt!.values.heShell).toBe("5,800");
    expect(alt!.values.fireChance).toBe("40%");
    expect(alt!.values.hePenetration).toBe("68 mm");
    expect(alt!.values.shellSpeed).toBe("830 m/s");
    expect(alt!.values.apShell).toBe("13,250");
    // DPMs ride the burst cycle: damage × barrels × 60 / (fullReload +
    // (salvoes − 1) × burstInterval) = 5800×2×60/46.7 and 13250×2×60/46.7.
    expect(alt!.values.heDpm).toBe("29,807");
    expect(alt!.values.apDpm).toBe("68,094");
  });

  it("emits a base artillery fit when the stock hull's artillery differs", () => {
    const fits = shipCompareFits(
      { hull: { health: 55_000 }, artillery: { shot_delay: 30, distance: 21.5 } },
      "japan",
      stockArtilleryGameparams(),
      12345,
    );
    const stock = fits.find((f) => f.key === "stock-artillery");
    expect(stock).toBeDefined();
    expect(stock!.variant).toBe("base");
    expect(stock!.groupKeys).toEqual(["artillery"]);
    // Stock values come from the head module, not the researched one.
    expect(stock!.values.mainGunReload).toBe("26.0 s");
    expect(stock!.values.mainGunCaliber).toBe("356 mm");
    expect(stock!.values.mainGunBarrels).toBe("2");
    expect(stock!.values.mainGunRange).toBeNull(); // slice block carries no maxDist here
    expect(stock!.values.heShell).toBe("5,800");
    expect(stock!.values.heDpm).toBe(fmtDpm(5800, 2, 26));
    expect(stock!.values.apShell).toBe("10,300");
  });

  it("emits no altFire fit for a hull without a switchable module", () => {
    // Two-hull ship, ordinary guns: the stock fit still applies, but there
    // is no alternate firing mode to speak of (the alt build would answer
    // with normal values and duplicate the baseline row).
    const fits = shipCompareFits(
      { hull: { health: 55_000 }, artillery: { shot_delay: 30, distance: 21.5 } },
      "japan",
      stockArtilleryGameparams(),
      12345,
    );
    // The fixture's hulls differ in HP too — the base hull fit rides
    // along with the artillery one.
    expect(fits.map((f) => f.key)).toEqual(["stock-artillery", "stock-hull"]);
  });

  it("skips the stock fit when stock and top modules are identical", () => {
    const gp = stockArtilleryGameparams();
    // Point both chain ends at the same module: no difference, no fit.
    gp.ShipUpgradeInfo = {
      PJSC108_Hull_A: { ucType: "_Hull", prev: "", components: { hull: ["B_Hull"], artillery: ["PJSB106_Artillery"], torpedoes: [] } },
      PJSC109_Artillery_B: { ucType: "_Artillery", prev: "", components: { artillery: ["PJSB106_Artillery"] } },
    };
    const fits = shipCompareFits({ hull: { health: 55_000 }, artillery: {} }, "japan", gp, 12345);
    expect(fits.find((f) => f.key === "stock-artillery")).toBeUndefined();
    expect(fits.find((f) => f.key === "stock-hull")).toBeUndefined();
  });

  it("emits a stock torpedo fit for a tube-count-only re-arm with the same ammo", () => {
    const gp = {
      A_Torpedoes: { HP_JGT_1: { numBarrels: 4, ammoList: ["T_610_MOD1"] } },
      B_Torpedoes: { HP_JGT_1: { numBarrels: 5, ammoList: ["T_610_MOD1"] } },
      __torpedoAmmo: {
        T_610_MOD1: { alphaDamage: 17_000, speed: 67, maxDist: 466.7, visibilityFactor: 1.5 },
      },
      ShipUpgradeInfo: {
        PJUH801: { ucType: "_Hull", prev: "", components: { hull: [], torpedoes: ["A_Torpedoes"] } },
        PJUH802: { ucType: "_Hull", prev: "PJUH801", components: { hull: [], torpedoes: ["B_Torpedoes"] } },
        PJUT801: { ucType: "_Torpedoes", prev: "", components: { torpedoes: ["A_Torpedoes"] } },
        PJUT802: { ucType: "_Torpedoes", prev: "PJUT801", components: { torpedoes: ["B_Torpedoes"] } },
      },
    };
    const fits = shipCompareFits(null, "japan", gp, 12345);
    const stockTorp = fits.find((f) => f.key === "stock-torpedoes");
    expect(stockTorp).toBeDefined();
    expect(stockTorp!.variant).toBe("base");
    expect(stockTorp!.values.torpDamage).toBe("17,000");
  });

  it("emits a base torpedo fit from the stock launchers and skips the identical artillery", () => {
    const fits = shipCompareFits(
      {
        hull: { health: 17_900 },
        mobility: { max_speed: 33 },
        torpedoes: { distance: 14, torpedo_speed: 67, max_damage: 21_300 },
      },
      "japan",
      torpedoShip(),
      12345,
    );
    const stockTorp = fits.find((f) => f.key === "stock-torpedoes");
    expect(stockTorp).toBeDefined();
    expect(stockTorp!.variant).toBe("base");
    expect(stockTorp!.groupKeys).toEqual(["torpedoes"]);
    // The stock launcher's mounted type speaks for the row.
    expect(stockTorp!.values.torpDamage).toBe("17,000");
    expect(stockTorp!.values.torpRange).toBe("14.0 km");
    expect(fits.find((f) => f.key === "stock-artillery")).toBeUndefined();
  });

  it("emits a base hull fit with stock HP and the ratio-scaled top speed", () => {
    const gp = torpedoShip() as Record<string, unknown>;
    gp.A_Hull = { health: 25_950, maxSpeed: 28, turningRadius: 600 };
    gp.B_Hull = { health: 31_400, maxSpeed: 28, turningRadius: 640 };
    const fits = shipCompareFits(
      { hull: { health: 31_400 }, mobility: { max_speed: 28 } },
      "japan",
      gp,
      12345,
    );
    const hull = fits.find((f) => f.key === "stock-hull");
    expect(hull).toBeDefined();
    expect(hull!.variant).toBe("base");
    expect(hull!.groupKeys).toEqual(["hull"]);
    expect(asNumber(hull!.values.hp ?? "")).toBe(25_950);
    // Hull maxSpeed ratio is 1 — the stock hull cruises the same 28 kn
    // (the engine module, not the hull, carries the WG display multiplier).
    expect(hull!.values.maxSpeed).toBe("28.0 kn");
    expect(hull!.values.turningRadius).toBe("600 m");
  });

  it("derives the stock speed when the hull blocks disagree", () => {
    const gp = {
      A_Hull: { health: 44_600, maxSpeed: 35, turningRadius: 1043 },
      B_Hull: { health: 44_600, maxSpeed: 40, turningRadius: 1043 },
      ShipUpgradeInfo: {
        PJUH801: { ucType: "_Hull", prev: "", components: { hull: ["A_Hull"] } },
        PJUH802: { ucType: "_Hull", prev: "PJUH801", components: { hull: ["B_Hull"] } },
      },
    };
    const fits = shipCompareFits(
      { hull: { health: 44_600 }, mobility: { max_speed: 40 } },
      "usa",
      gp,
      12345,
    );
    const hull = fits.find((f) => f.key === "stock-hull")!;
    expect(hull).toBeDefined();
    expect(hull.values.maxSpeed).toBe("35.0 kn"); // 40 × 35/40
    expect(hull.values.hp).toBe("44,600");
    // Plain integer formatting — the baseline turning-radius column's
    // convention (no thousands separator, unlike the HP column).
    expect(hull.values.turningRadius).toBe("1043 m");
  });

  it("classifies torpedo alternates by stock mounting and dedupes aliases", () => {
    const fits = shipCompareFits(null, "japan", torpedoShip(), 12345);
    const mod1 = fits.find((f) => f.key === "torp:T_610_MOD1");
    const mod3 = fits.find((f) => f.key === "torp:T_610_MOD3");
    const f3 = fits.find((f) => f.key === "torp:T_610_F3");
    // mod 1 is mounted by the STOCK launchers; mod 3 is the researched one.
    expect(mod1?.variant).toBe("base");
    expect(mod3?.variant).toBe("top");
    expect(mod1?.chip).toBe(true);
    // The F3 alias carries mod 3's numbers — the suffix is the identity,
    // so the duplicate row folds away.
    expect(f3).toBeUndefined();
  });

  it("enumerates every embedded torpedo type as its own fit", () => {
    const gp = {
      A1_610: { HP_JGT_1: { numBarrels: 4, ammoList: ["PJSD018_Torpedo_A1"] } },
      A2_610: { HP_JGT_1: { numBarrels: 5, ammoList: ["PJSD019_Torpedo_A2"] } },
      A3_610: { HP_JGT_1: { numBarrels: 5, ammoList: ["PJSD020_Torpedo_A3"] } },
      __torpedoAmmo: {
        PJSD018_Torpedo_A1: { alphaDamage: 21_700, speed: 67, maxDist: 466.7, visibilityFactor: 1.6 },
        PJSD019_Torpedo_A2: { alphaDamage: 23_000, speed: 61, maxDist: 566.7, visibilityFactor: 1.7 },
        PJSD020_Torpedo_A3: { alphaDamage: 24_000, speed: 57, maxDist: 666.7, visibilityFactor: 1.8 },
      },
      ShipUpgradeInfo: {
        PJUH802_Hull: { ucType: "_Hull", prev: "", components: { hull: [], artillery: [], torpedoes: ["A1_610", "A2_610", "A3_610"] } },
        PJUT901_TORP_STOCK: { ucType: "_Torpedoes", prev: "", components: { torpedoes: ["A1_610"] } },
        PJUT904_TORP_MED: { ucType: "_Torpedoes", prev: "PJUT901_TORP_STOCK", components: { torpedoes: ["A2_610"] } },
        PJUT905_TORP_TOP: { ucType: "_Torpedoes", prev: "PJUT904_TORP_MED", components: { torpedoes: ["A3_610"] } },
      },
    };
    const fits = shipCompareFits(null, "japan", gp, 12345);
    const torpFits = fits.filter((f) => f.key.startsWith("torp:"));
    expect(torpFits).toHaveLength(3);
    const ranges = torpFits.map((f) => f.values.torpRange);
    expect(ranges).toEqual(["14.0 km", "17.0 km", "20.0 km"]);
    expect(torpFits[0]!.values.torpDamage).toBe("21,700");
    expect(torpFits[0]!.values.torpSpeed).toBe("67 kn");
    expect(torpFits[0]!.labelKey).toBe("ships.spec.torpStraightSection");
    expect(torpFits[0]!.suffix).toContain("14.0 km");
    expect(torpFits.every((f) => f.groupKeys.includes("torpedoes"))).toBe(true);
    // The Shimakaze chain head (stock) mounts A1 only — A2/A3 read top.
    expect(torpFits.map((f) => f.variant)).toEqual(["base", "top", "top"]);
  });

  it("skips torpedo variant fits when the slice embeds a single type", () => {
    const gp = {
      A1_610: { HP_JGT_1: { numBarrels: 4, ammoList: ["PJSD018_Torpedo_A1"] } },
      __torpedoAmmo: {
        PJSD018_Torpedo_A1: { alphaDamage: 21_700, speed: 67, maxDist: 466.7, visibilityFactor: 1.6 },
      },
    };
    const fits = shipCompareFits(null, "japan", gp, 12345);
    expect(fits.filter((f) => f.key.startsWith("torp:"))).toHaveLength(0);
  });
});

describe("ASW airstrike fit", () => {
  it("surfaces the A_AirSupport charges the WG profile cannot carry", () => {
    const gp = { A_AirSupport: { chargesNum: 2, maxDist: 11_000, reloadTime: 30 } };
    const fit = aswAirstrikeFit(gp);
    expect(fit).toBeDefined();
    // "both": stock and top carry the identical strike block, so the stock
    // view still reports it (stepped into the identity cells).
    expect(fit!.variant).toBe("both");
    expect(fit!.kind).toBe("asw-airstrike");
    expect(fit!.groupKeys).toEqual(["asw"]);
    expect(fit!.labelKey).toBe("ships.compare.fit.aswAirstrike");
    expect(fit!.values.aswRange).toBe("11.0 km");
    expect(fit!.values.depthChargePacks).toBe("2");
    expect(fit!.values.depthChargeReload).toBe("30.0 s");
    expect(hasAswAirstrike(gp)).toBe(true);
    // The enumeration carries it too, keyed alongside the other fits.
    expect(shipCompareFits(null, "usa", gp, 12345).find((f) => f.key === "asw-airstrike")).toBeDefined();
  });

  it("stays absent without a strike block", () => {
    expect(aswAirstrikeFit({})).toBeNull();
    expect(hasAswAirstrike(null)).toBe(false);
    // An airstrike without charges or range is dead data, not a weapon.
    expect(aswAirstrikeFit({ A_AirSupport: { chargesNum: 0, maxDist: 0 } })).toBeNull();
  });
});

describe("aircraft fits", () => {
  it("enumerate one row per slice airframe with the baked plane_specs stats", () => {
    const gp = {
      PJSA110_Hakuryu: { planes: ["PJAB110_Hakuryu_stock", "PJAB210_Hakuryu_top"] },
    };
    const fits = aircraftFits(12345, gp);
    expect(fits).toHaveLength(2);
    const stock = fits[0]!;
    expect(stock.variant).toBe("base");
    expect(stock.kind).toBe("aircraft");
    expect(stock.chip).toBe(true);
    expect(stock.labelKey).toBe("ships.plane.torpedo");
    expect(stock.groupKeys).toEqual(["aircraft"]);
    expect(asNumber(stock.values.planeHp ?? "")).toBe(1750);
    expect(stock.values.planeSquadron).toBe("10");
    expect(stock.values.planeTorpSpeed).toBe("50 kn");
    expect(stock.values.planeTorpRange).toBe("6.0 km");
    expect(stock.values.planeFlood).toBe("40%");
    // Torpedo rows read their damage plain (no ammo-kind prefix).
    expect(stock.values.planeDamage).toBe("9,333");
    const top = fits[1]!;
    expect(top.variant).toBe("top");
    expect(asNumber(top.values.planeHp ?? "")).toBe(1820);
    expect(top.values.planeSquadron).toBe("12");
  });

  it("falls back to the baked squadron seed when no slice is loaded", () => {
    // Hakuryu's committed seed: 3 roles × stock/top airframes.
    const fits = shipCompareFits(null, "japan", null, 4179605200);
    expect(fits).toHaveLength(6);
    expect(fits.filter((f) => f.variant === "base")).toHaveLength(3);
    expect(fits.filter((f) => f.variant === "top")).toHaveLength(3);
    expect(fits.every((f) => f.kind === "aircraft")).toBe(true);
    expect(hasComparePlanes(4179605200, null)).toBe(true);
    // A hull the seed does not cover (and no slice) embarks nothing.
    expect(hasComparePlanes(12345, null)).toBe(false);
    expect(shipCompareFits(null, "usa", null, 12345)).toEqual([]);
  });

  it("prefers the live slice planes over the seed", () => {
    const gp = { SQUADRON: { planes: ["PJAD903_ASW_T10"] } };
    const fits = aircraftFits(4179605200, gp);
    expect(fits).toHaveLength(1);
    expect(fits[0]!.labelKey).toBe("ships.plane.asw");
    // The ASW plane's damage is not baked (its strike fit carries none) —
    // the cell stays blank instead of showing a wrong number.
    expect(fits[0]!.values.planeDamage).toBeNull();
  });
});
