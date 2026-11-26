/**
 * Tests for the build-modifier pipeline: multiplicative signal flags and the
 * HP-scaled trigger-skill curve (Adrenaline-Rush style), against a minimal
 * fake `default_profile` shaped like the real WG encyclopedia payload.
 *
 * Unit conventions verified against the live fleet data (15.5.0, 1017 ships):
 *   - `burn_probability` is ALREADY a percentage (NC 406 mm HE = 36.0);
 *   - the default_profile carries NO caliber field — the caliber-conditional
 *     fire-chance gates need the GameParams-derived `caliberMm` fallback.
 */
import { describe, expect, it, vi } from "vitest";

import { emptyBuild, recomputeStats, type PlannerBuild } from "./modifierPipeline";
import type { ModuleStats } from "@/utils/shipModuleStats";
import type { TechTreeRealm } from "@/utils/techTreeData";
import type { Profile } from "./shipSpecs";

const RAW_PROFILE = {
  hull: { health: 50_000 },
  artillery: {
    shot_delay: 20,
    distance: 20_000,
    rotation_time: 45,
    max_caliber: 380,
    shells: { HE: { burn_probability: 43 } },
  },
  mobility: { max_speed: 30, rudder_time: 15 },
  concealment: { detect_distance_by_ship: 12.5 },
  torpedoes: { torpedo_speed: 60, shot_delay: 40 },
};
const PROFILE: Profile = RAW_PROFILE;

/** The real WG shape: identical profile minus the (nonexistent) max_caliber. */
const NO_CALIBER_PROFILE = (() => {
  const artillery = { ...RAW_PROFILE.artillery } as Record<string, unknown>;
  delete artillery.max_caliber;
  return { ...RAW_PROFILE, artillery };
})();

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

  it("carries the base HE fire chance in percent without re-scaling", () => {
    // WG's burn_probability is a percentage already: 43 → 43, never 4300.
    const { base } = recomputeStats(PROFILE, "Cruiser", 8, emptyBuild(), 1);
    expect(base.fireChanceOut).toBe(43);
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
    };
    const small = recomputeStats(gunboatProfile, "Destroyer", 8, build, 1);
    expect(small.modified.fireChanceOut).toBeCloseTo(43.5, 5);
  });

  it("gates the fire-chance flags by the caliberMm fallback when the profile has no caliber", () => {
    // India X-Ray (PCEF018) again: without ANY caliber the flag must stay
    // dormant (the gate cannot guess); the GameParams-derived caliberMm
    // un-gates it exactly like a profile max_caliber would.
    const build: PlannerBuild = { ...emptyBuild(), signals: ["PCEF018"] };

    const noCaliber = recomputeStats(NO_CALIBER_PROFILE, "Battleship", 8, build, 1);
    expect(noCaliber.modified.fireChanceOut).toBeCloseTo(43, 5);

    const viaFallback = recomputeStats(NO_CALIBER_PROFILE, "Battleship", 8, build, 1, 380);
    expect(viaFallback.modified.fireChanceOut).toBeCloseTo(44, 5);

    const gunboat = recomputeStats(NO_CALIBER_PROFILE, "Destroyer", 8, build, 1, 127);
    expect(gunboat.modified.fireChanceOut).toBeCloseTo(43.5, 5);
  });
});

describe("recomputeStats realm routing", () => {
  // The WG and Lesta captain datasets are disjoint where it matters: the
  // signal indices never overlap (PCEF00x vs PCEF1xx) and the CV skill the
  // two trees swap exists on one side only. Same call shape as the tests
  // above; the realm rides the trailing parameter.
  it("a WG-only signal (Sierra Mike, PCEF005) applies only in the WG realm", () => {
    const build: PlannerBuild = { ...emptyBuild(), signals: ["PCEF005"] };
    const wg = recomputeStats(PROFILE, "Cruiser", 8, build, 1, null, "wg").modified;
    expect(wg.speed).toBeCloseTo(31.5, 5);
    const lesta = recomputeStats(PROFILE, "Cruiser", 8, build, 1, null, "lesta").modified;
    expect(lesta.speed).toBe(30);
  });

  it("a Lesta-only signal (sierra tier-3, PCEF133) applies only in the Lesta realm", () => {
    const build: PlannerBuild = { ...emptyBuild(), signals: ["PCEF133"] };
    expect(recomputeStats(PROFILE, "Cruiser", 8, build, 1).modified.speed).toBe(30);
    const lesta = recomputeStats(PROFILE, "Cruiser", 8, build, 1, null, "lesta").modified;
    expect(lesta.speed).toBeCloseTo(30 * 1.07, 5);
  });

  it("the swapped CV skill code is a realm-local lookup, not a crash", () => {
    // WG-only skill: known to WG (its modifiers map to no displayed row),
    // unknown to Lesta — both realms stay at base, and the WG realm must
    // not silently treat the code as unknown either.
    const build: PlannerBuild = { ...emptyBuild(), skills: { PlanesConsumablesActiveManeuveringUpgrade: 1 } };
    const wg = recomputeStats(PROFILE, "AirCarrier", 8, build, 1, null, "wg").modified;
    const lesta = recomputeStats(PROFILE, "AirCarrier", 8, build, 1, null, "lesta").modified;
    const base = recomputeStats(PROFILE, "AirCarrier", 8, emptyBuild(), 1, null, "wg").modified;
    expect(wg).toEqual(base);
    expect(lesta).toEqual(base);
  });

  it("Lesta yankee's burnChanceBonus adds flat fire chance with no caliber gate", () => {
    // Yankee elite (PCEF114): burnChanceBonus +0.02 — unlike the WG
    // burnChanceFactor* split there is NO caliber condition.
    const build: PlannerBuild = { ...emptyBuild(), signals: ["PCEF114"] };
    const battleship = recomputeStats(PROFILE, "Battleship", 8, build, 1, null, "lesta").modified;
    expect(battleship.fireChanceOut).toBeCloseTo(45, 5); // 43% + 2pp
    const noCaliber = recomputeStats(NO_CALIBER_PROFILE, "Cruiser", 8, build, 1, null, "lesta").modified;
    expect(noCaliber.fireChanceOut).toBeCloseTo(45, 5); // still applies, ungated
  });

  it("defaults to WG when the realm is omitted", () => {
    const build: PlannerBuild = { ...emptyBuild(), signals: ["PCEF133"] };
    expect(recomputeStats(PROFILE, "Cruiser", 8, build, 1).modified.speed).toBe(30);
    const wg: PlannerBuild = { ...emptyBuild(), signals: ["PCEF005"] };
    expect(recomputeStats(PROFILE, "Cruiser", 8, wg, 1).modified.speed).toBeCloseTo(31.5, 5);
  });
});

/** Synthetic module-stats fixtures for the injected-resolver suite: the
 *  repo's tests never pin real bundle numbers, so the fake resolver answers
 *  from this table and the assertions stay self-evident. */
function fakeStats(kind: ModuleStats["kind"], over: Partial<ModuleStats> = {}): ModuleStats {
  return { gpid: null, ucType: "_Fake", kind, health: null, rangeM: null, reloadS: null, ...over };
}
/** Fake resolveModuleStats answering from a name → stats table (null
 *  default = the pack does not know the module). */
function resolverOf(
  table: Record<string, ModuleStats | null>,
): (realm: TechTreeRealm, name: string) => ModuleStats | null {
  return (_realm, name) => table[name] ?? null;
}

describe("recomputeStats module overrides", () => {
  it("a mounted hull module rebases base HP", () => {
    const table = { FAKE_HULL_TOP: fakeStats("hull", { health: 61_300 }) };
    const build: PlannerBuild = { ...emptyBuild(), modules: { hull: "FAKE_HULL_TOP" } };
    const { base, modified } = recomputeStats(PROFILE, "Cruiser", 8, build, 1, null, "wg", resolverOf(table));
    expect(base.hp).toBe(61_300);
    expect(modified.hp).toBe(61_300);
  });

  it("a mounted artillery module overrides range (meters → km) and reload", () => {
    const table = { FAKE_ART_TOP: fakeStats("artillery", { rangeM: 21_300, reloadS: 18 }) };
    const build: PlannerBuild = { ...emptyBuild(), modules: { artillery: "FAKE_ART_TOP" } };
    const { base } = recomputeStats(PROFILE, "Cruiser", 8, build, 1, null, "wg", resolverOf(table));
    expect(base.range).toBeCloseTo(21.3, 5); // the pipeline's unit is km
    expect(base.reload).toBe(18);
  });

  it("a mounted torpedo module overrides the torpedo reload", () => {
    const table = { FAKE_TORP_TOP: fakeStats("torpedoes", { reloadS: 150 }) };
    const build: PlannerBuild = { ...emptyBuild(), modules: { torpedoes: "FAKE_TORP_TOP" } };
    const { base } = recomputeStats(PROFILE, "Destroyer", 8, build, 1, null, "wg", resolverOf(table));
    expect(base.torpedoReload).toBe(150);
  });

  it("null stats fields never fabricate: the profile value survives", () => {
    // The pack lists the module but knows none of the artillery numbers.
    const table = { FAKE_ART_TOP: fakeStats("artillery") };
    const build: PlannerBuild = { ...emptyBuild(), modules: { artillery: "FAKE_ART_TOP" } };
    const { base } = recomputeStats(PROFILE, "Cruiser", 8, build, 1, null, "wg", resolverOf(table));
    expect(base.range).toBe(20_000); // the profile's raw passthrough
    expect(base.reload).toBe(20);
  });

  it("unknown module names leave the profile values alone", () => {
    const build: PlannerBuild = { ...emptyBuild(), modules: { hull: "GONE_Module" } };
    const { base } = recomputeStats(PROFILE, "Cruiser", 8, build, 1, null, "wg", resolverOf({}));
    expect(base.hp).toBe(50_000);
  });

  it("roles without extracted stats (suo/engine) stay on the profile numbers", () => {
    const spy = vi.fn((_realm: TechTreeRealm, _name: string) => null);
    const build: PlannerBuild = { ...emptyBuild(), modules: { suo: "FAKE_SUO", engine: "FAKE_ENGINE" } };
    const { base } = recomputeStats(PROFILE, "Cruiser", 8, build, 1, null, "wg", spy);
    expect(base).toEqual(recomputeStats(PROFILE, "Cruiser", 8, emptyBuild(), 1, null, "wg", spy).base);
    // The pipeline never even asks: only hull/artillery/torpedoes resolve.
    expect(spy).not.toHaveBeenCalled();
  });

  it("empty/absent modules behave exactly as without the override pass", () => {
    const resolver = resolverOf({ FAKE_HULL_TOP: fakeStats("hull", { health: 61_300 }) });
    const empty: PlannerBuild = { ...emptyBuild() };
    expect(recomputeStats(PROFILE, "Cruiser", 8, empty, 1, null, "wg", resolver).base).toEqual(
      recomputeStats(PROFILE, "Cruiser", 8, emptyBuild(), 1, null, "wg", resolverOf({})).base,
    );
    const absent: PlannerBuild = { ...emptyBuild(), modules: undefined };
    expect(recomputeStats(PROFILE, "Cruiser", 8, absent, 1, null, "wg", resolver).base.hp).toBe(50_000);
  });

  it("the overridden base feeds the multiplier pass, not the profile number", () => {
    // Hull: base HP overridden to 61_300, then Charlie Kilo (PCEF030,
    // healthHullCoeff 1.05) multiplies THE OVERRIDE → 64_365 (the profile
    // number would land at 52_500).
    const table = { FAKE_HULL_TOP: fakeStats("hull", { health: 61_300 }) };
    const build: PlannerBuild = {
      ...emptyBuild(),
      signals: ["PCEF030"],
      modules: { hull: "FAKE_HULL_TOP" },
    };
    const { modified } = recomputeStats(PROFILE, "Cruiser", 8, build, 1, null, "wg", resolverOf(table));
    expect(modified.hp).toBeCloseTo(61_300 * 1.05, 5);
    expect(modified.hp).not.toBeCloseTo(50_000 * 1.05, 5);

    // Artillery reload: base overridden to 18 s, then Adrenaline Rush at 0
    // HP multiplies it to 16.2 s (profile 20 s would give 18 s — ambiguous
    // with the override itself — and 16.2 s disambiguates).
    const art = { ...table, FAKE_ART_TOP: fakeStats("artillery", { reloadS: 18 }) };
    const trigger: PlannerBuild = {
      ...emptyBuild(),
      skills: { TriggerGmReload: 1 },
      modules: { artillery: "FAKE_ART_TOP" },
    };
    const low = recomputeStats(PROFILE, "Cruiser", 8, trigger, 0, null, "wg", resolverOf(art));
    expect(low.base.reload).toBe(18);
    expect(low.modified.reload).toBeCloseTo(16.2, 5);
  });
});
