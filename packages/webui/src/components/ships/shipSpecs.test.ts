/**
 * Unit tests for the spec-tree extraction, pinning the WG-field unit
 * conventions verified against the live encyclopedia fleet (15.5.0,
 * 1017 ships): `burn_probability` is ALREADY a percentage, `shot_delay`
 * is seconds (DPM needs the ×60), and the default_profile carries NO
 * caliber field — the caliber/HE-pen rows only appear via the raw
 * GameParams fallback.
 */
import { describe, expect, it } from "vitest";

import { buildShipSpecs, type Profile, type SpecRow } from "./shipSpecs";

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
} as unknown as Profile;

/** Raw GameParams entry whose stock artillery carries 155 mm turrets
 *  (barrelDiameter is metres on the HP_* slots). */
const GAMEPARAMS = {
  A_Artillery: { HP_AGM_1: { barrelDiameter: 0.155, numBarrels: 3 } },
} as Record<string, unknown>;

function artilleryRow(key: string, gameparams?: Record<string, unknown> | null): SpecRow | undefined {
  const groups = buildShipSpecs(PROFILE, "japan", gameparams);
  const group = groups.find((g) => g.group === "artillery");
  return group?.rows.find((r) => r.key === key);
}

/** "141,429" → 141429 (fmtNum is locale-formatted). */
function asNumber(value: string): number {
  return Number(value.replace(/[^0-9.-]/g, ""));
}

describe("buildShipSpecs main-battery units", () => {
  it("passes WG's burn_probability through as the percentage it already is", () => {
    // 10.0 in the data means 10% — never the 1000% the ×100 path produced.
    expect(artilleryRow("heFireChance")?.value).toBe("10%");
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
});
