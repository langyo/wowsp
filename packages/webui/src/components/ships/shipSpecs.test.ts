/**
 * Unit tests for the spec-tree extraction, pinning the WG-field unit
 * conventions verified against the live encyclopedia fleet (15.5.0,
 * 1017 ships): `burn_probability` is ALREADY a percentage, `shot_delay`
 * is seconds (DPM needs the ×60), and the default_profile carries NO
 * caliber field — the caliber/HE-pen rows only appear via the raw
 * GameParams fallback.
 *
 * Submarine coverage: the sonar group reads the raw A_PingerGun block
 * (WG's `submarine_sonar` profile block answers when the slice is
 * missing), the battery / underwater-mobility rows ride the WG profile,
 * and per-type torpedo sections read the `__torpedoAmmo` entities the
 * slice materializer embeds (shape v2) — falloff tiers on the ×0.03 km
 * GameParams distance scale (466.7 → 14.0 km) and the ping-response
 * homing numbers.
 */
import { describe, expect, it } from "vitest";

import {
  buildShipSpecs,
  hasSwitchableMainBattery,
  type Profile,
  type SpecGroup,
  type SpecRow,
} from "./shipSpecs";

/** A Mogami-shaped CL profile in the real WG default_profile shape
 *  (no caliber key anywhere — that is the live-data reality). */
const PROFILE = {
  hull: { health: 40_200, artillery_barrels: 15, torpedoes_barrels: 0 },
  artillery: {
    shot_delay: 21,
    distance: 17.5,
    rotation_time: 36,
    max_dispersion: 148,
    shells: {
      HE: { damage: 3300, burn_probability: 10, bullet_speed: 925 },
      AP: { damage: 4600, bullet_speed: 920 },
    },
  },
};

/** Raw GameParams entry whose stock artillery carries 155 mm turrets
 *  (barrelDiameter is metres on the HP_* slots). */
const GAMEPARAMS = {
  A_Artillery: { HP_AGM_1: { barrelDiameter: 0.155, numBarrels: 3 } },
} as Record<string, unknown>;

function rowOf(groups: SpecGroup[], group: string, key: string): SpecRow | undefined {
  const g = groups.find((x) => x.group === group);
  if (!g) return undefined;
  return (
    g.rows.find((r) => r.key === key) ??
    (g.sections ?? [])
      .flatMap((s) => s.rows)
      .find((r) => r.key === key)
  );
}

function artilleryRow(key: string, gameparams?: Record<string, unknown> | null): SpecRow | undefined {
  return rowOf(buildShipSpecs(PROFILE, "japan", gameparams), "artillery", key);
}

/** "141,429" → 141429 (fmtNum is locale-formatted). */
function asNumber(value: string): number {
  return Number(value.replace(/[^0-9.-]/g, ""));
}

describe("buildShipSpecs main-battery units", () => {
  it("passes WG's burn_probability through as the percentage it already is", () => {
    // 10.0 in the data means 10% — never the 1000% the ×100 path produced.
    expect(artilleryRow("fireChance")?.value).toBe("10%");
  });

  it("computes DPM per minute (damage × barrels × 60 / reload)", () => {
    // 3300 × 15 barrels × 60 / 21 s = 141,428.6 HE; 4600 → 197,142.9 AP.
    expect(asNumber(artilleryRow("heDpm")?.value ?? "")).toBeCloseTo((3300 * 15 * 60) / 21, 0);
    expect(asNumber(artilleryRow("apDpm")?.value ?? "")).toBeCloseTo((4600 * 15 * 60) / 21, 0);
  });

  it("derives the caliber and HE-penetration rows from the GameParams fallback", () => {
    // Without gameparams the rows stay absent (the WG profile has no caliber).
    expect(artilleryRow("mainGunCaliber")).toBeUndefined();
    expect(artilleryRow("hePenetration")).toBeUndefined();

    // With the raw entry loaded: 0.155 m turrets → 155 mm, IJN HE pen = /6.
    expect(artilleryRow("mainGunCaliber", GAMEPARAMS)?.value).toBe("155 mm");
    expect(artilleryRow("hePenetration", GAMEPARAMS)?.value).toBe("26 mm");
  });

  it("splits the battery into one section per shell type", () => {
    const groups = buildShipSpecs(PROFILE, "japan", GAMEPARAMS);
    const art = groups.find((g) => g.group === "artillery");
    expect(art?.sections?.map((s) => s.labelKey)).toEqual(["heShell", "apShell"]);
    // Per-shell damage moved into the sections…
    expect(rowOf(groups, "artillery", "shellDamage")?.value).toBe("3,300");
    // …and the shared rows (range / reload / barrels) stay group-level.
    expect(art?.rows.map((r) => r.key)).toContain("mainGunRange");
  });
});

/** U-2501-shaped submarine GameParams entry: a canonical A_PingerGun and
 *  the shape-v2 __torpedoAmmo embedding (one homing + one straight type,
 *  the real PGPT021/PGPT043 values). */
function subGameparams() {
  return {
    name: "PGSS110_U_2501",
    A_PingerGun: {
      waveDistance: 14000,
      waveReloadTime: 6,
      maxWaveHits: 2,
      waveParams: [{ waveSpeed: [500, 500, 500, 500, 500], visibility: 14 }],
      sectorParams: [
        { width: 15, lifetime: 25, alertTime: 11.6 },
        { width: 15, lifetime: 65, alertTime: 11.6 },
      ],
    },
    A_Torpedoes: {
      HP_GGT_1: { ammoList: ["PGPT021_G7E_T4_Sub", "PGPT043_G7E_T4_Sub_Magnetic"] },
    },
    __torpedoAmmo: {
      PGPT021_G7E_T4_Sub: {
        name: "PGPT021_G7E_T4_Sub",
        typeinfo: { type: "Projectile", species: "Torpedo" },
        alphaDamage: 23200,
        speed: 82,
        maxDist: 466.7,
        visibilityFactor: 2.2,
        uwCritical: 0.35,
        damageCoeffMaxPing: 2,
        distanceOfDamage: [
          [83.33, 0.1],
          [86.66, 1],
        ],
        SubmarineTorpedoParams: {
          yawChangeSpeed: [1.5, 2.5, 2.5],
          dropTargetAtDistance: {
            Battleship: [2100, 1600, 1600],
            Cruiser: [1440, 720, 360],
            Destroyer: [480, 240, 120],
            Submarine: [240, 120, 120],
          },
        },
      },
      PGPT043_G7E_T4_Sub_Magnetic: {
        name: "PGPT043_G7E_T4_Sub_Magnetic",
        typeinfo: { type: "Projectile", species: "Torpedo" },
        alphaDamage: 39300,
        speed: 62,
        maxDist: 266.66,
        visibilityFactor: 1.9,
        uwCritical: 0.85,
        distanceOfDamage: [
          [83.33, 0.1],
          [86.66, 1],
        ],
      },
      // A researchable alternate the top launchers do NOT mount: embedded by
      // the materializer (some launcher block references it) but never shown.
      PGPT999_Unmounted: {
        name: "PGPT999_Unmounted",
        typeinfo: { type: "Projectile", species: "Torpedo" },
        alphaDamage: 30000,
        speed: 70,
        maxDist: 400,
      },
    },
  } as Record<string, unknown>;
}

/** U-2501-shaped WG default_profile (the real submarine_* blocks). */
const SUB_PROFILE = {
  hull: { health: 18900, torpedoes_barrels: 6, artillery_barrels: 0 },
  torpedoes: {
    distance: 14,
    max_damage: 8633,
    reload_time: 69,
    torpedo_speed: 77,
    visibility_dist: 2.1,
  },
  submarine_sonar: {
    wave_max_dist: 14,
    wave_shot_delay: 7.5,
    wave_speed_max: 500,
    wave_width: 15,
    wave_duration_0: 25,
    wave_duration_1: 65,
  },
  submarine_battery: { max_capacity: 280, consumption_rate: 1, regen_rate: 0.8 },
  submarine_mobility: { max_speed_under_water: 27, buoyancy_rudder_time: 18.4, max_buoyancy_speed: 3.4 },
  mobility: { max_speed: 27, rudder_time: 6.8, turning_radius: 420 },
  concealment: { detect_distance_by_ship: 5.6, detect_distance_by_plane: 2.1, detect_distance_by_submarine: 2.1 },
};

describe("buildShipSpecs submarine sonar", () => {
  it("reads the sonar group from the raw A_PingerGun block (top config)", () => {
    const groups = buildShipSpecs(SUB_PROFILE, "germany", subGameparams());
    expect(rowOf(groups, "sonar", "sonarRange")?.value).toBe("14.0 km");
    expect(rowOf(groups, "sonar", "sonarReload")?.value).toBe("6.0 s");
    expect(rowOf(groups, "sonar", "sonarWaveSpeed")?.value).toBe("500 m/s");
    expect(rowOf(groups, "sonar", "sonarWidth")?.value).toBe("15°");
    // The two ping tiers are separate rows — a first ping marks the target
    // for the shorter duration, the double ping for the longer one.
    expect(rowOf(groups, "sonar", "sonarPing1")?.value).toBe("25 s");
    expect(rowOf(groups, "sonar", "sonarPing2")?.value).toBe("65 s");
    expect(rowOf(groups, "sonar", "sonarMarkTime")).toBeUndefined();
  });

  it("falls back to WG's submarine_sonar profile block without the slice", () => {
    const groups = buildShipSpecs(SUB_PROFILE, "germany", null);
    expect(rowOf(groups, "sonar", "sonarRange")?.value).toBe("14.0 km");
    // Stock profile numbers, not the top-config ones (7.5 s reload).
    expect(rowOf(groups, "sonar", "sonarReload")?.value).toBe("7.5 s");
    expect(rowOf(groups, "sonar", "sonarPing1")?.value).toBe("25 s");
    expect(rowOf(groups, "sonar", "sonarPing2")?.value).toBe("65 s");
  });

  it("shows no sonar group for surface ships", () => {
    const groups = buildShipSpecs(PROFILE, "japan", GAMEPARAMS);
    expect(groups.find((g) => g.group === "sonar")).toBeUndefined();
  });

  it("reads the researched pinger module when A1/A2 variants are co-listed", () => {
    // Tech-tree hulls list both sonar modules: A1 stock (9 km / 7.5 s) and
    // A2 researched (10 km / 6.0 s). The panel's top-configuration
    // convention means the A2 numbers must render.
    const gp = {
      name: "PGSS210_U_2501",
      A1_PingerGun: { waveDistance: 9000, waveReloadTime: 7.5, maxWaveHits: 2 },
      A2_PingerGun: {
        waveDistance: 10000,
        waveReloadTime: 6.0,
        maxWaveHits: 2,
        waveParams: [{ waveSpeed: [500, 500, 500, 500, 500] }],
        sectorParams: [
          { width: 15, lifetime: 25 },
          { width: 15, lifetime: 65 },
        ],
      },
      A_Hull: { health: 18900 },
      ShipUpgradeInfo: {
        PGUH910_TOP: {
          ucType: "_Hull",
          prev: "",
          components: {
            hull: ["A_Hull"],
            artillery: [],
            airDefense: [],
            airArmament: [],
            atba: [],
            torpedoes: [],
            pinger: ["A1_PingerGun", "A2_PingerGun"],
          },
        },
      },
    } as Record<string, unknown>;
    const groups = buildShipSpecs(SUB_PROFILE, "germany", gp);
    expect(rowOf(groups, "sonar", "sonarRange")?.value).toBe("10.0 km");
    expect(rowOf(groups, "sonar", "sonarReload")?.value).toBe("6.0 s");
    expect(rowOf(groups, "sonar", "sonarPing2")?.value).toBe("65 s");
  });

  it("reads the Lesta client's single sectorLifetime as one mark-duration row", () => {
    // Lesta GameParams has no per-tier sectorParams: one sectorLifetime
    // covers both ping tiers, and there is no width field either.
    const gp = {
      name: "PJSS520_I2",
      A_PingerGun: {
        waveDistance: 13500,
        waveReloadTime: 6,
        maxWaveHits: 2,
        waveParams: [{ waveSpeed: [800, 800, 800, 800, 800] }],
        sectorLifetime: 20,
      },
    } as Record<string, unknown>;
    const groups = buildShipSpecs(SUB_PROFILE, "germany", gp);
    expect(rowOf(groups, "sonar", "sonarRange")?.value).toBe("13.5 km");
    expect(rowOf(groups, "sonar", "sonarReload")?.value).toBe("6.0 s");
    expect(rowOf(groups, "sonar", "sonarWaveSpeed")?.value).toBe("800 m/s");
    expect(rowOf(groups, "sonar", "sonarMarkTime")?.value).toBe("20 s");
    // No tier split in that schema — the WG-style rows stay absent.
    expect(rowOf(groups, "sonar", "sonarPing1")).toBeUndefined();
    expect(rowOf(groups, "sonar", "sonarPing2")).toBeUndefined();
    expect(rowOf(groups, "sonar", "sonarWidth")).toBeUndefined();
  });
});

describe("buildShipSpecs submarine battery and mobility", () => {
  it("adds the battery group and underwater-mobility rows from the WG profile", () => {
    const groups = buildShipSpecs(SUB_PROFILE, "germany", subGameparams());
    expect(rowOf(groups, "battery", "batteryCapacity")?.value).toBe("280");
    expect(rowOf(groups, "battery", "batteryDrain")?.value).toBe("1.0/s");
    expect(rowOf(groups, "battery", "batteryRegen")?.value).toBe("0.8/s");
    expect(rowOf(groups, "mobility", "underwaterSpeed")?.value).toBe("27.0 kn");
    expect(rowOf(groups, "mobility", "buoyancyRudder")?.value).toBe("18.4 s");
    // WG documents max_buoyancy_speed as the vertical dive rate, m/s.
    expect(rowOf(groups, "mobility", "buoyancySpeed")?.value).toBe("3.4 m/s");
  });
});

describe("buildShipSpecs per-type torpedo sections", () => {
  it("splits homing and straight-running torpedoes into labelled sections", () => {
    const groups = buildShipSpecs(SUB_PROFILE, "germany", subGameparams());
    const torp = groups.find((g) => g.group === "torpedoes");
    expect(torp?.sections?.map((s) => s.labelKey)).toEqual([
      "torpHomingSection",
      "torpStraightSection",
    ]);
    // Group-level rows keep the launcher-level facts (reload / launchers).
    expect(torp?.rows.map((r) => r.key)).toEqual(["torpReload", "torpLaunchers"]);
  });

  it("hides torpedo types the top-configuration launchers do not mount", () => {
    const groups = buildShipSpecs(SUB_PROFILE, "germany", subGameparams());
    const torp = groups.find((g) => g.group === "torpedoes");
    // The embedded PGPT999_Unmounted alternate (researchable variant) never
    // renders — the panel shows the mounted fit only.
    expect(torp?.sections?.length).toBe(2);
    const values = (torp?.sections ?? []).flatMap((s) => s.rows.map((r) => r.value));
    expect(values).not.toContain("30,000");
  });

  it("formats the ×0.03 km distance scale and the falloff tiers", () => {
    const groups = buildShipSpecs(SUB_PROFILE, "germany", subGameparams());
    // 466.7 → 14.0 km (the encyclopedia's 14 km torpedo range).
    expect(rowOf(groups, "torpedoes", "torpRange")?.value).toBe("14.0 km");
    // Most subs: ×10% inside ~2.5 km, full damage beyond ~2.6 km.
    expect(rowOf(groups, "torpedoes", "torpFalloff")?.value).toBe(
      "2.5 km → 10% · 2.6 km → 100%",
    );
  });

  it("reads the ping-response homing numbers on homing sections", () => {
    const groups = buildShipSpecs(SUB_PROFILE, "germany", subGameparams());
    const homing = groups.find((g) => g.group === "torpedoes")?.sections?.[0];
    expect(homing?.rows.find((r) => r.key === "torpDoublePing")?.value).toBe("×2");
    expect(homing?.rows.find((r) => r.key === "torpHomingYaw")?.value).toBe("1.5°/s / 2.5°/s");
    // Double-ping cut-offs per class, BB / CA / DD / SS order.
    expect(homing?.rows.find((r) => r.key === "torpHomingCutoff")?.value).toBe(
      "1.6 / 0.72 / 0.24 / 0.12 km",
    );
  });

  it("keeps the WG single-torpedo rows when the slice predates the embedding", () => {
    const groups = buildShipSpecs(SUB_PROFILE, "germany", { name: "PGSS110_U_2501" });
    const torp = groups.find((g) => g.group === "torpedoes");
    expect(torp?.sections).toBeUndefined();
    expect(torp?.rows.map((r) => r.key)).toContain("torpDamage");
    expect(rowOf(groups, "torpedoes", "torpRange")?.value).toBe("14.0 km");
  });
});

/** Vyazma-shaped main battery: 2×3 406 mm turrets, the alternate-firing
 *  module (2-salvo burst, 45 s full reload, ×0.5727 range) and the shape-v3
 *  __shellAmmo embedding (real WG 15.5.0 values, the ALT AP shell has the
 *  longer 900 m/s muzzle velocity and the wider ricochet/normalization
 *  angles). */
function altFireProfile(): Profile {
  return {
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
}

function altFireGameparams(withAltShells: boolean): Record<string, unknown> {
  const ammo: Record<string, unknown> = {
    PRPA208_HE: {
      ammoType: "HE",
      alphaDamage: 5800,
      burnProb: 0.4,
      alphaPiercingHE: 68,
      bulletSpeed: 830,
    },
    PRPA209_AP: {
      ammoType: "AP",
      alphaDamage: 13_250,
      bulletSpeed: 830,
      bulletRicochetAt: 45,
      bulletAlwaysRicochetAt: 60,
      bulletCapNormalizeMaxAngle: 6,
    },
  };
  if (withAltShells) {
    ammo.PRPA210_HE_ALT = {
      ammoType: "HE",
      alphaDamage: 5800,
      burnProb: 0.4,
      alphaPiercingHE: 68,
      bulletSpeed: 830,
    };
    ammo.PRPA211_AP_ALT = {
      ammoType: "AP",
      alphaDamage: 13_250,
      bulletSpeed: 900,
      bulletRicochetAt: 55,
      bulletAlwaysRicochetAt: 65,
      bulletCapNormalizeMaxAngle: 12,
    };
  }
  return {
    A_Artillery: {
      HP_RGM_1: { ammoList: ["PRPA208_HE", "PRPA209_AP"], barrelDiameter: 0.406 },
      HP_RGM_2: { ammoList: ["PRPA208_HE", "PRPA209_AP"] },
      SwitchableModeArtilleryModule: {
        burstReloadTime: 1.7,
        fullReloadTime: 45,
        modifiers: { GMMaxDist: 0.5727 },
        shotsCount: 2,
        secondaryAmmoList: withAltShells
          ? ["PRPA210_HE_ALT", "PRPA209_AP", "PRPA211_AP_ALT"]
          : [],
      },
    },
    __shellAmmo: ammo,
  } as Record<string, unknown>;
}

describe("buildShipSpecs alternate firing mode", () => {
  it("is only offered when the main battery carries a switchable module", () => {
    expect(hasSwitchableMainBattery(altFireGameparams(true))).toBe(true);
    expect(hasSwitchableMainBattery(GAMEPARAMS)).toBe(false);
    expect(hasSwitchableMainBattery(null)).toBe(false);
    const off = buildShipSpecs(PROFILE, "japan", GAMEPARAMS);
    expect(off.find((g) => g.group === "artillery")?.sections?.every((s) => !s.altFire)).toBe(true);
  });

  it("keeps the normal rows when the toggle is off", () => {
    const groups = buildShipSpecs(altFireProfile(), "ussr", altFireGameparams(true));
    expect(rowOf(groups, "artillery", "mainGunReload")?.value).toBe("33.0 s");
    expect(rowOf(groups, "artillery", "mainGunReload")?.delta).toBeUndefined();
    expect(rowOf(groups, "artillery", "mainGunRange")?.value).toBe("20.9 km");
    expect(rowOf(groups, "artillery", "burstCount")).toBeUndefined();
    // Even with the mode available, the stock shell values show when off.
    expect(rowOf(groups, "artillery", "shellSpeed")?.value).toBe("830 m/s");
    expect(rowOf(groups, "artillery", "shellSpeed")?.delta).toBeUndefined();
  });

  it("switches reload / range / burst rows to the mode with deltas", () => {
    const groups = buildShipSpecs(altFireProfile(), "ussr", altFireGameparams(true), {
      altFire: true,
    });
    const reload = rowOf(groups, "artillery", "mainGunReload");
    expect(reload?.value).toBe("45.0 s");
    expect(reload?.delta).toEqual({ text: "+12.0 s", better: false });
    const range = rowOf(groups, "artillery", "mainGunRange");
    expect(range?.value).toBe("12.0 km");
    expect(range?.delta).toEqual({ text: "-8.9 km", better: false });
    const burst = rowOf(groups, "artillery", "burstCount");
    expect(burst?.value).toBe("2");
    expect(burst?.delta).toEqual({ text: "+1", better: true });
    expect(rowOf(groups, "artillery", "burstInterval")?.value).toBe("1.7 s");
  });

  it("swaps to the alternate shells and annotates every changed shell stat", () => {
    const groups = buildShipSpecs(altFireProfile(), "ussr", altFireGameparams(true), {
      altFire: true,
    });
    const sections = groups.find((g) => g.group === "artillery")?.sections ?? [];
    const ap = sections.find((s) => s.labelKey === "apShell");
    const speed = ap?.rows.find((r) => r.key === "shellSpeed");
    expect(speed?.value).toBe("900 m/s");
    expect(speed?.delta).toEqual({ text: "+70 m/s", better: true });
    const ricochet = ap?.rows.find((r) => r.key === "apRicochetAngle");
    expect(ricochet?.value).toBe("55°");
    expect(ricochet?.delta).toEqual({ text: "+10°", better: true });
    expect(ap?.rows.find((r) => r.key === "apAlwaysRicochetAngle")?.value).toBe("65°");
    const normalization = ap?.rows.find((r) => r.key === "apNormalization");
    expect(normalization?.value).toBe("12°");
    expect(normalization?.delta).toEqual({ text: "+6°", better: true });
    // The ALT AP shell keeps the same damage: no delta chip appears.
    expect(ap?.rows.find((r) => r.key === "shellDamage")?.delta).toBeUndefined();
    // DPM follows the 2-salvo burst over one full cycle — the 45 s reload
    // PLUS the 1.7 s burst tail (the time the second salvo takes).
    const dpm = ap?.rows.find((r) => r.key === "apDpm");
    expect(dpm?.delta?.better).toBe(true);
    expect(asNumber(dpm?.value ?? "")).toBeCloseTo((13_250 * 2 * 2 * 60) / (45 + 1.7), 0);
    // The ALT HE shell is statistically identical to the stock HE shell.
    const he = sections.find((s) => s.labelKey === "heShell");
    expect(he?.rows.find((r) => r.key === "shellDamage")?.delta).toBeUndefined();
    expect(he?.rows.find((r) => r.key === "hePenetration")?.value).toBe("68 mm");
  });

  it("hides the burst rows for single-shot alternate-ammo modes", () => {
    // Hawaii / Togasa / Aragon-style modes switch shells/accuracy only:
    // shotsCount 1 means there is no burst to report.
    const gp = altFireGameparams(true);
    const artillery = gp.A_Artillery as Record<string, unknown>;
    artillery.SwitchableModeArtilleryModule = {
      ...(artillery.SwitchableModeArtilleryModule as Record<string, unknown>),
      shotsCount: 1,
      burstReloadTime: 1,
    };
    const groups = buildShipSpecs(altFireProfile(), "ussr", gp, { altFire: true });
    expect(rowOf(groups, "artillery", "burstCount")).toBeUndefined();
    expect(rowOf(groups, "artillery", "burstInterval")).toBeUndefined();
    expect(rowOf(groups, "artillery", "mainGunReload")?.value).toBe("45.0 s");
  });

  it("scales dispersion by the mode's GMIdealRadius", () => {
    const gp = altFireGameparams(true);
    const artillery = gp.A_Artillery as Record<string, unknown>;
    artillery.SwitchableModeArtilleryModule = {
      ...(artillery.SwitchableModeArtilleryModule as Record<string, unknown>),
      modifiers: { GMMaxDist: 0.5727, GMIdealRadius: 0.8 },
    };
    const groups = buildShipSpecs(altFireProfile(), "ussr", gp, { altFire: true });
    const dispersion = rowOf(groups, "artillery", "maxDispersion");
    expect(dispersion?.value).toBe("213 m");
    expect(dispersion?.delta).toEqual({ text: "-53 m", better: true });
  });

  it("stacks the mode's multipliers over an _ALT shell entity", () => {
    // No live ship pairs an alternate projectile with damage/penetration
    // coefficients today; pin the toolkit's order so a future data pairing
    // cannot silently drop the multiplier (or double-count it).
    const gp = altFireGameparams(true);
    const artillery = gp.A_Artillery as Record<string, unknown>;
    artillery.SwitchableModeArtilleryModule = {
      ...(artillery.SwitchableModeArtilleryModule as Record<string, unknown>),
      modifiers: { GMDamageCoeff: 1.5, GMAPDamageCoeff: 1.2, GMPenetrationCoeffHE: 1.5 },
    };
    // Give the _ALT shells distinct damage so the assertions prove the ALT
    // entity (not the stock fallback) fed the multiplier pipeline.
    const ammo = gp.__shellAmmo as Record<string, Record<string, unknown>>;
    ammo.PRPA210_HE_ALT.alphaDamage = 6000;
    ammo.PRPA211_AP_ALT.alphaDamage = 14_000;
    const groups = buildShipSpecs(altFireProfile(), "ussr", gp, { altFire: true });
    const sections = groups.find((g) => g.group === "artillery")?.sections ?? [];
    const he = sections.find((s) => s.labelKey === "heShell");
    const ap = sections.find((s) => s.labelKey === "apShell");
    // 6000 × 1.5; floor(68 × 1.5); 14000 × 1.5 × 1.2.
    expect(asNumber(he?.rows.find((r) => r.key === "shellDamage")?.value ?? "")).toBe(9000);
    expect(he?.rows.find((r) => r.key === "hePenetration")?.value).toBe("102 mm");
    expect(asNumber(ap?.rows.find((r) => r.key === "shellDamage")?.value ?? "")).toBe(25200);
  });

  it("keeps burst-only modes (no alternate shells) changing reload / DPM only", () => {
    const groups = buildShipSpecs(altFireProfile(), "ussr", altFireGameparams(false), {
      altFire: true,
    });
    expect(rowOf(groups, "artillery", "shellSpeed")?.value).toBe("830 m/s");
    expect(rowOf(groups, "artillery", "shellSpeed")?.delta).toBeUndefined();
    const reload = rowOf(groups, "artillery", "mainGunReload");
    expect(reload?.value).toBe("45.0 s");
    expect(reload?.delta?.better).toBe(false);
    expect(rowOf(groups, "artillery", "heDpm")?.delta?.better).toBe(true);
  });
});
