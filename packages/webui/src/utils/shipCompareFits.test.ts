import { describe, expect, it } from "vitest";

import { shipCompareFits } from "./shipCompareFits";

/**
 * Tests for the compare table's weapon-fit enumeration: the alternate
 * firing mode fit (Vyazma-style switchable battery), the stock-hull fit
 * (a two-hull tech-tree ship whose stock guns differ), and the researchable
 * torpedo alternates (Shimakaze A1/A2/A3 embedding). A hull without gameparams
 * (slice still loading / unavailable) must yield no fits at all.
 */

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

/** Shimakaze-shaped torpedo embedding: three researchable alternates (A1/
 *  A2/A3) + the mounted top type, every launcher block referencing them. */
function torpedoAlternatesGameparams(): Record<string, unknown> {
  return {
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
}

describe("shipCompareFits", () => {
  it("returns no fits without a gameparams slice", () => {
    expect(shipCompareFits(altFireProfile, "russia", null)).toEqual([]);
    expect(shipCompareFits(altFireProfile, "russia", undefined)).toEqual([]);
    expect(shipCompareFits(null, "russia", altFireGameparams())).toEqual([]);
  });

  it("emits the alternate firing mode fit with the mode's values", () => {
    const fits = shipCompareFits(altFireProfile, "russia", altFireGameparams());
    const alt = fits.find((f) => f.key === "altFire");
    expect(alt).toBeDefined();
    expect(alt!.labelKey).toBe("ships.spec.altFire");
    expect(alt!.groupKeys).toEqual(["artillery"]);
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

  it("emits a stock fit when the stock hull's artillery differs", () => {
    const fits = shipCompareFits(
      { hull: { health: 55_000 }, artillery: { shot_delay: 30, distance: 21.5 } },
      "japan",
      stockArtilleryGameparams(),
    );
    const stock = fits.find((f) => f.key === "stock");
    expect(stock).toBeDefined();
    expect(stock!.groupKeys).toContain("artillery");
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
    );
    expect(fits.map((f) => f.key)).toEqual(["stock"]);
  });

  it("skips the stock fit when stock and top modules are identical", () => {
    const gp = stockArtilleryGameparams();
    // Point both chain ends at the same module: no difference, no fit.
    gp.ShipUpgradeInfo = {
      PJSC108_Hull_A: { ucType: "_Hull", prev: "", components: { hull: ["B_Hull"], artillery: ["PJSB106_Artillery"], torpedoes: [] } },
      PJSC109_Artillery_B: { ucType: "_Artillery", prev: "", components: { artillery: ["PJSB106_Artillery"] } },
    };
    const fits = shipCompareFits({ hull: { health: 55_000 }, artillery: {} }, "japan", gp);
    expect(fits.find((f) => f.key === "stock")).toBeUndefined();
  });

  it("enumerates every embedded torpedo type as its own fit", () => {
    const fits = shipCompareFits(null, "japan", torpedoAlternatesGameparams());
    const torpFits = fits.filter((f) => f.key.startsWith("torp:"));
    expect(torpFits).toHaveLength(3);
    const ranges = torpFits.map((f) => f.values.torpRange);
    expect(ranges).toEqual(["14.0 km", "17.0 km", "20.0 km"]);
    expect(torpFits[0]!.values.torpDamage).toBe("21,700");
    expect(torpFits[0]!.values.torpSpeed).toBe("67 kn");
    expect(torpFits[0]!.labelKey).toBe("ships.spec.torpStraightSection");
    expect(torpFits[0]!.suffix).toContain("14.0 km");
    expect(torpFits.every((f) => f.groupKeys.includes("torpedoes"))).toBe(true);
  });

  it("skips torpedo variant fits when the slice embeds a single type", () => {
    const gp = torpedoAlternatesGameparams();
    gp.__torpedoAmmo = {
      PJSD018_Torpedo_A1: { alphaDamage: 21_700, speed: 67, maxDist: 466.7, visibilityFactor: 1.6 },
    };
    const fits = shipCompareFits(null, "japan", gp);
    expect(fits.filter((f) => f.key.startsWith("torp:"))).toHaveLength(0);
  });
});

function fmtDpm(dmg: number, barrels: number, reload: number): string {
  return (dmg * barrels * 60 / reload).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
