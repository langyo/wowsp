/** Tests for the scorebar's sunk-ship points attribution: the classic
 *  kill/death tables per class in team modes, the special-map flat rates,
 *  and the operation-scenario rule that NO attribution is made (the
 *  single-team roster cannot tell an enemy bot from an ally script ship,
 *  so crediting the enemy score from friendly sinks would be invention).
 *
 * Also gates updateCapsAndScore's progressive-zone rule: operation (行动)
 * points are CREATED mid-battle (EntityCreate time) and stay invisible —
 * and scoreless — until the playhead crosses their birth instant.
 *
 * And the domination SCORE math: the per-mode/map parameter table, the
 * area-accrual clock (which must charge the playhead's real elapsed time —
 * it used to charge a full 0.5 s sim step per rendered frame, racing every
 * score to the 1000 clamp within a minute), the contested pause, the
 * capture bonus, the co-op / ranked / clan columns and the clamp. */
import { describe, expect, it } from "vitest";

import { scoringRules, sunkShipPoints, updateCapsAndScore, type SunkShipMarker } from "./capSimulator";
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

  it("uses the flat ranked/clan tables (+40/-60, carriers +60/-90)", () => {
    // Ranked / Clan replace the Random per-class rows entirely.
    expect(sunkShipPoints([mk("enemy", "Destroyer", 100)], 200, false, false, "ranked")).toEqual({
      ally: 40,
      enemy: -60,
    });
    expect(sunkShipPoints([mk("enemy", "Destroyer", 100)], 200, false, false, "clan")).toEqual({
      ally: 40,
      enemy: -60,
    });
    expect(sunkShipPoints([mk("enemy", "AirCarrier", 100)], 200, false, false, "ranked")).toEqual({
      ally: 60,
      enemy: -90,
    });
    // Co-op shares the Random per-class table (DD +30/-45).
    expect(sunkShipPoints([mk("enemy", "Destroyer", 100)], 200, false, false, "coop")).toEqual({
      ally: 30,
      enemy: -45,
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

/** A ship trajectory that teleports between waypoints (the >4 s gaps make
 *  sampleAt FREEZE at the last waypoint instead of interpolating, so a ship
 *  "arrives" and "leaves" exactly on its sample times). */
function waypoints(steps: { time: number; x: number; z: number }[]) {
  return steps.map((s) => ({ ...s, yaw: 0 }));
}

/** The subset of MapInternals updateCapsAndScore touches (no scene).
 *  `ships` feeds the ships-in-zone scan: by default each entry is a marker
 *  that sits FAR away until `arrive`, then inside the zone (0,0); pass
 *  `samples` for a custom in/out pattern (see waypoints). */
function fakeCtx(
  zones: EntityTrajectory[],
  opts: {
    operation?: boolean;
    matchGroup?: string;
    mapName?: string;
    ships?: {
      entityId: number;
      role: string;
      arrive?: number;
      samples?: { time: number; x: number; z: number; yaw: number }[];
    }[];
  } = {},
): MapInternals {
  const trajById = new Map();
  for (const s of opts.ships ?? []) {
    trajById.set(s.entityId, {
      entityId: s.entityId,
      samples: s.samples ?? [
        { time: 0, x: 5000, z: 5000, yaw: 0 },
        { time: s.arrive, x: 0, z: 0, yaw: 0 },
      ],
    });
  }
  return {
    capZones: { value: zones },
    scoringZones: { value: zones },
    props: {
      matchGroup: opts.matchGroup ?? "pvp",
      mapName: opts.mapName ?? "any",
      operation: opts.operation ?? true,
    },
    shipMarkers: (opts.ships ?? []).map((s) => ({
      userData: { entityId: s.entityId, role: s.role },
    })),
    trajById,
    selfTeam: { value: 1 },
    capSim: new Map(),
    capDisplay: { value: [] },
    _capDisplaySig: "",
    allyScore: { value: 0 },
    enemyScore: { value: 0 },
  // Ref-shaped doubles ({ value }) are not assignable to Partial<MapInternals>
  // (ComputedRef brand symbols), so the subset the function reads is asserted once here.
  } as unknown as MapInternals; // ts-escape-ok: ref-brand double, see note above

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

  it("wakes the point at its creation instant, neutral (ops never inherit the script's team)", () => {
    const ctx = fakeCtx([zone({ creationTime: 120 })]);
    updateCapsAndScore(ctx, 130);
    const d = ctx.capDisplay.value;
    expect(d[0].live).toBe(true);
    // initialTeam 1 (= selfTeam) is the SCRIPT's owning side in an
    // operation — story objectives start unclaimed, never pre-owned.
    expect(d[0].owner).toBe(0);
    // Neutral owners accrue nothing (300 start, no completion yet).
    expect(ctx.allyScore.value).toBe(300);
  });

  it("maps the create-state team for NON-operation zones as before", () => {
    const ctx = fakeCtx([zone({ creationTime: 120 })], { operation: false });
    updateCapsAndScore(ctx, 130);
    expect(ctx.capDisplay.value[0].owner).toBe(1);
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

describe("operation story objectives (pre-placed zones)", () => {
  it("stays hidden and neutral at the start — nothing revealed before engagement", () => {
    // The LePVE shape: every point born at t=0, initialTeam set, no
    // stream activity. The board must open empty, not six red rings.
    const ctx = fakeCtx([zone({ creationTime: 0 })]);
    updateCapsAndScore(ctx, 0);
    expect(ctx.capDisplay.value[0].live).toBe(false);
    updateCapsAndScore(ctx, 60);
    expect(ctx.capDisplay.value[0].live).toBe(false);
    expect(ctx.capDisplay.value[0].owner).toBe(0);
  });

  it("reveals once a ship enters the radius and stays revealed", () => {
    const ctx = fakeCtx(
      [zone({ creationTime: 0 })],
      { ships: [{ entityId: 7, role: "ally", arrive: 30 }] },
    );
    updateCapsAndScore(ctx, 20);
    expect(ctx.capDisplay.value[0].live).toBe(false);
    updateCapsAndScore(ctx, 40);
    const d = ctx.capDisplay.value[0];
    expect(d.live).toBe(true);
    expect(d.capturing).toBe(true);
    // By t=100 the capture (started ≈30, 60 s for one ship) has long
    // completed — resolve beats reveal: the latch only ever ADDS
    // visibility, a resolved story objective leaves the board regardless.
    updateCapsAndScore(ctx, 100);
    expect(ctx.capDisplay.value[0].live).toBe(false);
  });

  it("vanishes once its capture completes (占领之后消失)", () => {
    const ctx = fakeCtx(
      [zone({ creationTime: 0 })],
      { ships: [{ entityId: 7, role: "ally", arrive: 30 }] },
    );
    // One ship inside for (t-30) s: 60 s completes the capture.
    updateCapsAndScore(ctx, 60);
    expect(ctx.capDisplay.value[0].live).toBe(true);
    updateCapsAndScore(ctx, 95);
    expect(ctx.capDisplay.value[0].live).toBe(false);
    // Scrubbing back before completion re-reveals it.
    updateCapsAndScore(ctx, 60);
    expect(ctx.capDisplay.value[0].live).toBe(true);
  });

  it("resolves immediately when the game's own ownership stream flips the point", () => {
    const ctx = fakeCtx([{
      ...zone({ creationTime: 0 }),
      // Off the 0.5 s sim grid, like every real packet timestamp.
      capSamples: [{ time: 100.4, value: 1 }],
    }]);
    updateCapsAndScore(ctx, 50);
    expect(ctx.capDisplay.value[0].live).toBe(false); // not engaged yet
    updateCapsAndScore(ctx, 120);
    expect(ctx.capDisplay.value[0].live).toBe(false); // captured → gone
    expect(ctx.capSim.get(1)?.owner).toBe(1);
  });
});

describe("scoringRules", () => {
  const rules = (matchGroup: string, nAreas: number, mapName = "any", operation = false) =>
    scoringRules({ matchGroup, mapName, operation }, nAreas);

  it("follows the Random / Co-op start + capture + interval table", () => {
    expect(rules("pvp", 3)).toMatchObject({
      mode: "random", special: false, startPts: 300, capCompletePts: 3,
      accrualEvery: 6, accrualPts: 3,
    });
    expect(rules("pvp", 4)).toMatchObject({
      startPts: 200, capCompletePts: 4, accrualEvery: 9, accrualPts: 4,
    });
    // Co-op starts higher than Random (400 / 300, not 300 / 200).
    expect(rules("pve", 3)).toMatchObject({
      mode: "coop", startPts: 400, capCompletePts: 3,
      accrualEvery: 6, accrualPts: 3,
    });
    expect(rules("pve", 4)).toMatchObject({
      startPts: 300, capCompletePts: 4, accrualEvery: 9, accrualPts: 4,
    });
  });

  it("keeps the interval table on the eight special maps (only start/kills/deaths change)", () => {
    expect(rules("pvp", 3, "13_OC_new_dawn")).toEqual({
      mode: "random", special: true, startPts: 150, capCompletePts: 3,
      accrualEvery: 6, accrualPts: 3,
    });
    expect(rules("pvp", 4, "54_Faroe")).toMatchObject({
      special: true, startPts: 150, capCompletePts: 4, accrualEvery: 9, accrualPts: 4,
    });
  });

  it("uses the ranked columns (2-area +9 / 10 s, 3-area +2 / 3 s, no 4-area tier)", () => {
    expect(rules("ranked", 2)).toMatchObject({
      mode: "ranked", startPts: 300, capCompletePts: 9,
      accrualEvery: 10, accrualPts: 9,
    });
    // 3-area ranked used to inherit the 2-area +9 capture award.
    expect(rules("ranked", 3)).toMatchObject({
      startPts: 300, capCompletePts: 2, accrualEvery: 3, accrualPts: 2,
    });
    expect(rules("ranked", 4)).toMatchObject({
      startPts: 300, capCompletePts: 2, accrualEvery: 0, accrualPts: 0,
    });
  });

  it("uses the clan column (+3 capture, +3 every 4 s)", () => {
    expect(rules("clan", 3)).toMatchObject({
      mode: "clan", startPts: 300, capCompletePts: 3,
      accrualEvery: 4, accrualPts: 3,
    });
  });

  it("never treats a story operation as co-op scoring", () => {
    // pve + operation → Random numbers (the score digits are hidden anyway).
    expect(rules("pve", 3, "any", true)).toMatchObject({
      mode: "random", startPts: 300, capCompletePts: 3,
    });
  });
});

/** Drive the sim from 0 to t at a fixed cadence (seconds) — the live HUD
 *  calls it once per rendered frame, the exporter once per exported frame. */
function drive(ctx: MapInternals, t: number, dt: number) {
  for (let x = dt; x < t - 1e-9; x += dt) updateCapsAndScore(ctx, x);
  updateCapsAndScore(ctx, t);
}

/** A 3-area Random domination point pre-owned by the recorder's side from
 *  t=0 (no ownership stream at all — the stream-silent home point). */
const ownedZone = () => zone({});

describe("area accrual accounting", () => {
  it("charges the playhead's real elapsed time, not one 0.5 s step per call", () => {
    // 3-area Random, one point owned from t=0: +3 every 6 s → 10 ticks in 60 s.
    const single = fakeCtx([ownedZone()], { operation: false });
    updateCapsAndScore(single, 60);
    expect(single.allyScore.value).toBe(330);

    // The same playhead reached at 4 Hz and at 60 Hz must agree. Before the
    // fix every call charged a whole 0.5 s to the accrual clock, so a 60 fps
    // playback ticked ~30x too fast and pinned the score at the 1000 clamp
    // within a minute (the reported "enemy score jumped to 1000").
    const at4hz = fakeCtx([ownedZone()], { operation: false });
    drive(at4hz, 60, 0.25);
    expect(at4hz.allyScore.value).toBe(330);

    const at60hz = fakeCtx([ownedZone()], { operation: false });
    drive(at60hz, 60, 1 / 60);
    // Float accumulation may leave the last tick pending — never more.
    expect(at60hz.allyScore.value).toBeGreaterThanOrEqual(327);
    expect(at60hz.allyScore.value).toBeLessThanOrEqual(330);
  });

  it("pauses accrual while an enemy ship sits in the owned point", () => {
    const ctx = fakeCtx([ownedZone()], {
      operation: false,
      ships: [{
        entityId: 9,
        role: "enemy",
        samples: waypoints([
          { time: 0, x: 61, z: 0 }, // just outside the 60-unit default radius
          { time: 20, x: 0, z: 0 },
          { time: 40, x: 61, z: 0 },
        ]),
      }],
    });
    drive(ctx, 60, 0.25);
    // Only 40 of the 60 s ticked → 6 whole 6 s windows (+18), not 10.
    expect(ctx.allyScore.value).toBe(318);
  });

  it("uses the 4-area start and the 9 s cadence", () => {
    const zones = [0, 1, 2, 3].map((i) => ({
      ...zone({ controlPointIndex: i }),
      entityId: i + 1,
    }));
    const ctx = fakeCtx(zones, { operation: false });
    drive(ctx, 18, 0.25);
    // 200 start + 4 points x 2 windows x 4 pts.
    expect(ctx.allyScore.value).toBe(232);
    expect(ctx.enemyScore.value).toBe(200);
  });

  it("clamps both sides at the 1000-point victory threshold", () => {
    const ctx = fakeCtx([ownedZone()], { operation: false });
    updateCapsAndScore(ctx, 3000);
    expect(ctx.allyScore.value).toBe(1000);
    expect(ctx.enemyScore.value).toBe(300);
  });

  it("awards the capture bonus once per completed capture and switches the tick side", () => {
    const ctx = fakeCtx(
      [{
        ...zone({ initialTeam: -1 }),
        capSamples: [
          { time: 30.4, value: 2 },
          { time: 60.4, value: 1 },
        ],
      }],
      { operation: false },
    );
    drive(ctx, 90, 0.25);
    // Enemy: +3 at 30.4 then 5 windows over the 30 s it held. Ally: +3 at
    // 60.4 then 4 windows over the 29.5 s it held.
    expect(ctx.enemyScore.value).toBe(318);
    expect(ctx.allyScore.value).toBe(315);
  });

  it("pays +3 (not the +40 kill value) for a capture on a special map, and still ticks", () => {
    const ctx = fakeCtx(
      [{ ...zone({ initialTeam: -1 }), capSamples: [{ time: 100.4, value: 1 }] }],
      { operation: false, mapName: "13_OC_new_dawn" },
    );
    updateCapsAndScore(ctx, 120);
    // 150 start + 3 capture + 3 windows over the 19.5 s owned (not +40).
    expect(ctx.allyScore.value).toBe(162);
  });

  it("starts co-op (pve) at 400 for a 3-area layout", () => {
    const ctx = fakeCtx([ownedZone()], { operation: false, matchGroup: "pve" });
    updateCapsAndScore(ctx, 12);
    expect(ctx.allyScore.value).toBe(406);
  });

  it("does not pay a capture bonus for the pre-placed starting owner", () => {
    const ctx = fakeCtx(
      [{ ...zone(), capSamples: [{ time: 0, value: 1 }] }],
      { operation: false },
    );
    updateCapsAndScore(ctx, 12);
    // 300 + 2 windows; the t=0 ownership sample is the starting state.
    expect(ctx.allyScore.value).toBe(306);
  });
});

describe("capture progress clock", () => {
  it("fills at the real 1/60 per second, not per rendered frame", () => {
    const ctx = fakeCtx([zone({ initialTeam: -1 })], {
      operation: false,
      ships: [{
        entityId: 7,
        role: "ally",
        samples: waypoints([{ time: 0, x: 0, z: 0 }]),
      }],
    });
    drive(ctx, 30, 1 / 60);
    // 30 s of a 60 s single-ship capture = half the ring (the old per-call
    // step filled it in ~2 s, resolving operation objectives instantly).
    expect(ctx.capDisplay.value[0].progress).toBeCloseTo(0.5, 1);
  });
});