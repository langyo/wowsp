/**
 * Tests for the build-modifier pipeline: multiplicative signal flags and the
 * HP-scaled trigger-skill curve (Adrenaline-Rush style), against a minimal
 * fake `default_profile`.
 */
import { describe, expect, it } from "vitest";

import { emptyBuild, recomputeStats, type PlannerBuild } from "./modifierPipeline";
import type { Profile } from "./shipSpecs";

const RAW_PROFILE = {
  hull: { health: 50_000 },
  artillery: {
    shot_delay: 20,
    distance: 20_000,
    rotation_time: 45,
    max_caliber: 380,
    shells: { HE: { burn_chance: 0.43 } },
  },
  mobility: { max_speed: 30, rudder_time: 15 },
  concealment: { detect_distance_by_ship: 12.5 },
  torpedoes: { torpedo_speed: 60, shot_delay: 40 },
};
const PROFILE = RAW_PROFILE as unknown as Profile;

describe("recomputeStats", () => {
  it("applies a signal flag's speed coefficient multiplicatively", () => {
    // Sierra Mike (PCEF005): speedCoef 1.05
    const build: PlannerBuild = { ...emptyBuild(), signals: ["PCEF005"] };
    const { base, modified } = recomputeStats(PROFILE, "Cruiser", 8, build, 1);

    expect(base.speed).toBe(30);
    expect(modified.speed).toBeCloseTo(31.5, 5);
    // Untouched stats stay at base.
    expect(modified.reload).toBe(20);
    expect(modified.hp).toBe(50_000);
  });

  it("scales a trigger skill's full effect by the current HP fraction", () => {
    // Adrenaline Rush (TriggerGmReload): GMShotDelay 0.9 at full strength.
    const build: PlannerBuild = { ...emptyBuild(), skills: { TriggerGmReload: 1 } };

    // Dormant at full HP.
    const full = recomputeStats(PROFILE, "Cruiser", 8, build, 1);
    expect(full.modified.reload).toBeCloseTo(20, 5);

    // Half HP: applied = 1 - (1 - 0.9) * (1 - 0.5) = 0.95 → 20 × 0.95.
    const half = recomputeStats(PROFILE, "Cruiser", 8, build, 0.5);
    expect(half.modified.reload).toBeCloseTo(19, 5);

    // Minimum HP reaches the full stored coefficient.
    const empty = recomputeStats(PROFILE, "Cruiser", 8, build, 0);
    expect(empty.modified.reload).toBeCloseTo(18, 5);
  });

  it("adds fire-chance flag percentage points and gates them by caliber", () => {
    // India X-Ray (PCEF018): burnChanceFactorBig +0.01, Small +0.005.
    // 380mm guns use the Big fraction: 43% + 1pp = 44%.
    const build: PlannerBuild = { ...emptyBuild(), signals: ["PCEF018"] };
    const big = recomputeStats(PROFILE, "Battleship", 8, build, 1);
    expect(big.modified.fireChanceOut).toBeCloseTo(44, 5);

    // Sub-160mm guns use the Small fraction: 43% + 0.5pp = 43.5%.
    const gunboatProfile = {
      ...RAW_PROFILE,
      artillery: { ...RAW_PROFILE.artillery, max_caliber: 127 },
    } as unknown as Profile;
    const small = recomputeStats(gunboatProfile, "Destroyer", 8, build, 1);
    expect(small.modified.fireChanceOut).toBeCloseTo(43.5, 5);
  });
});
