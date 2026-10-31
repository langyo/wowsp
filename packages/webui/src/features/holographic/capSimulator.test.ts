/** Tests for the scorebar's sunk-ship points attribution: the classic
 *  kill/death tables per class in team modes, the special-map flat rates,
 *  and the operation-scenario rule that NO attribution is made (the
 *  single-team roster cannot tell an enemy bot from an ally script ship,
 *  so crediting the enemy score from friendly sinks would be invention).
 *
 * Also gates updateCapsAndScore's progressive-zone rule: operation (行动)
 * points are CREATED mid-battle (EntityCreate time) and stay invisible —
 * and scoreless — until the playhead crosses their birth instant. */
import { describe, expect, it } from "vitest";

import { sunkShipPoints, updateCapsAndScore, type SunkShipMarker } from "./capSimulator";
import type { MapInternals } from "./mapInternals";
import type { EntityKind, EntityTrajectory } from "@/api";

const mk = (role: SunkShipMarker["role"], type: string, deathTime: number | null): SunkShipMarker => ({
  role,
  type,
  deathTime,
});

describe("sunkShipPoints", () => {
  it("credits the opposite side and penalizes the sinking side in team modes", () => {
    // A sunk allied cruiser: enemy +35, ally -50.
    const pts = sunkShipPoints([mk("ally", "Cruiser", 100)], 200, false);
    expect(pts).toEqual({ ally: -50, enemy: 35 });
    // A sunk enemy battleship: ally +40, enemy -60.
    expect(sunkShipPoints([mk("enemy", "Battleship", 100)], 200, false)).toEqual({
      ally: 40,
      enemy: -60,
    });
    // The recorder's own sinking counts on the ally side too.
    expect(sunkShipPoints([mk("self", "Destroyer", 100)], 200, false)).toEqual({
      ally: -45,
      enemy: 30,
    });
  });

  it("uses the flat special-map rates (+40/-25)", () => {
    expect(sunkShipPoints([mk("enemy", "AirCarrier", 100)], 200, true)).toEqual({
      ally: 40,
      enemy: -25,
    });
  });

  it("covers the remaining class rows and the short AirCar type name", () => {
    expect(sunkShipPoints([mk("enemy", "Submarine", 100)], 200, false)).toEqual({
      ally: 25,
      enemy: -40,
    });
    expect(sunkShipPoints([mk("ally", "AirCar", 100)], 200, false)).toEqual({
      ally: -65,
      enemy: 45,
    });
  });

  it("ignores ships still afloat at t (and never-sunk ones)", () => {
    expect(sunkShipPoints([mk("enemy", "Cruiser", 300)], 200, false)).toEqual({
      ally: 0,
      enemy: 0,
    });
    expect(sunkShipPoints([mk("enemy", "Cruiser", null)], 200, false)).toEqual({
      ally: 0,
      enemy: 0,
    });
  });

  it("makes no attribution in operation scenarios", () => {
    // Same sunk ships as the first test — the operation flag zeroes both
    // sides: the enemy column must not grow from friendly sinks.
    const markers = [
      mk("ally", "Cruiser", 100),
      mk("self", "Destroyer", 120),
      mk("ally", "Battleship", 140),
    ];
    expect(sunkShipPoints(markers, 200, false, true)).toEqual({ ally: 0, enemy: 0 });
    expect(sunkShipPoints(markers, 200, true, true)).toEqual({ ally: 0, enemy: 0 });
  });
});

/** Minimal domination-point trajectory (controlPointIndex set) with only
 *  the fields the simulator reads; kind overrides come last. */
const zone = (kindOver: Partial<EntityKind> = {}): EntityTrajectory => ({
  entityId: 1,
  samples: [],
  kind: {
    entityType: 14,
    vehicleId: 0,
    initialX: 0,
    initialY: 0,
    initialZ: 0,
    // -1 = existed before the recording started (PvP domination default).
    creationTime: -1,
    controlPointIndex: 0,
    initialTeam: 1,
    ...kindOver,
  },
});

/** The subset of MapInternals updateCapsAndScore touches (no scene, no
 *  markers — ships-in-zone stays empty). */
function fakeCtx(zones: EntityTrajectory[]): MapInternals {
  return {
    capZones: { value: zones },
    scoringZones: { value: zones },
    props: { matchGroup: "pvp", mapName: "any", operation: true },
    shipMarkers: [],
    trajById: new Map(),
    selfTeam: { value: 1 },
    capSim: new Map(),
    capDisplay: { value: [] },
    _capDisplaySig: "",
    allyScore: { value: 0 },
    enemyScore: { value: 0 },
  } as unknown as MapInternals;
}

describe("updateCapsAndScore birth gating", () => {
  it("keeps an unborn op point dormant (no chip, no owner, no score)", () => {
    const ctx = fakeCtx([zone({ creationTime: 120 })]);
    updateCapsAndScore(ctx, 60);
    const d = ctx.capDisplay.value;
    expect(d).toHaveLength(1);
    expect(d[0].live).toBe(false);
    expect(d[0].owner).toBe(0);
    // No pre-birth accrual: a pre-owned point must not tick owner points
    // for the 60 s before it existed (start 300, nothing added).
    expect(ctx.allyScore.value).toBe(300);
  });

  it("wakes the point at its creation instant and accrues only from then", () => {
    const ctx = fakeCtx([zone({ creationTime: 120 })]);
    updateCapsAndScore(ctx, 130);
    const d = ctx.capDisplay.value;
    expect(d[0].live).toBe(true);
    // Pre-owned by the recorder's side (initialTeam 1 === selfTeam 1).
    expect(d[0].owner).toBe(1);
    // 300 start + one 6 s accrual window inside the 10 lived seconds.
    expect(ctx.allyScore.value).toBe(303);
  });

  it("puts the point back to sleep when scrubbed before its birth", () => {
    const ctx = fakeCtx([zone({ creationTime: 120 })]);
    updateCapsAndScore(ctx, 130);
    updateCapsAndScore(ctx, 60);
    expect(ctx.capDisplay.value[0].live).toBe(false);
  });

  it("keeps pre-recording zones (PvP domination) live from t=0", () => {
    const ctx = fakeCtx([zone({})]);
    updateCapsAndScore(ctx, 0);
    expect(ctx.capDisplay.value[0].live).toBe(true);
  });
});
