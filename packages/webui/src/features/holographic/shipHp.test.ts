/** Tests for the replay HP resolution: the total-HP priority chain (arena
 *  build health first — the ship's base information — stream peak only as
 *  the fallback for replays without arena state) and the dark-death
 *  inference that stops un-spotted kills from sailing at full HP forever. */
import { describe, expect, it } from "vitest";

import type { ArenaPlayer, EntityTrajectory, VehicleEntry } from "@/api";
import type { PostBattleData, PostBattlePlayer } from "@/features/replay/postBattle";
import {
  applyDarkDeathInference,
  encyclopediaHullHealth,
  inferDarkDeaths,
  peakHpOf,
  resolveMaxHp,
} from "./shipHp";

const hp = (time: number, value: number) => ({ time, value });

describe("peakHpOf", () => {
  it("returns the largest sample", () => {
    expect(peakHpOf([hp(0, 46400), hp(10, 31200), hp(20, 40100)])).toBe(46400);
  });

  it("returns null for missing or empty streams", () => {
    expect(peakHpOf(undefined)).toBeNull();
    expect(peakHpOf([])).toBeNull();
  });
});

describe("encyclopediaHullHealth", () => {
  it("reads defaultProfile.hull.health when numeric", () => {
    expect(
      encyclopediaHullHealth({
        defaultProfile: { hull: { health: 40100 } },
      } as never),
    ).toBe(40100);
  });

  it("returns null when the entry or the hull health is missing", () => {
    expect(encyclopediaHullHealth(null)).toBeNull();
    expect(encyclopediaHullHealth({} as never)).toBeNull();
    expect(
      encyclopediaHullHealth({ defaultProfile: {} } as never),
    ).toBeNull();
  });
});

describe("resolveMaxHp", () => {
  it("prefers the arena build health over every other source", () => {
    // A late-spotted enemy's stream peaks at a damaged, non-round value —
    // the arena number is the ship's true base total.
    expect(resolveMaxHp(46400, [hp(0, 31237), hp(5, 28010)], 40100, 39500)).toBe(46400);
  });

  it("falls back to the stream peak when the arena state is missing", () => {
    expect(resolveMaxHp(null, [hp(0, 31237), hp(5, 28010)], 40100, 39500)).toBe(31237);
  });

  it("falls back to the encyclopedia hull, then the offline DB", () => {
    expect(resolveMaxHp(null, [], 40100, 39500)).toBe(40100);
    expect(resolveMaxHp(null, [], null, 39500)).toBe(39500);
    expect(resolveMaxHp(null, [], null, null)).toBeNull();
  });

  it("ignores zero/negative sources and rounds fractional ones", () => {
    expect(resolveMaxHp(0, [hp(0, 40100.6)], null, null)).toBe(40101);
    expect(resolveMaxHp(null, [hp(0, 40100.4)], null, null)).toBe(40100);
    expect(resolveMaxHp(-5, [], 0, -1)).toBeNull();
  });
});

// ── Dark-death inference ────────────────────────────────────────────────

/** Minimal type-2 ship trajectory with a position stream ending at `endT`. */
const shipTraj = (
  entityId: number,
  shipId: number,
  endT: number,
  extra: Partial<EntityTrajectory> = {},
): EntityTrajectory => ({
  entityId,
  kind: {
    entityType: 2,
    vehicleId: 0,
    initialX: 0,
    initialY: 0,
    initialZ: 0,
    creationTime: 0,
    shipId,
  },
  samples: [
    { time: 0, entityId, vehicleId: 0, x: 0, y: 0, z: 0, yaw: 0 },
    { time: endT, entityId, vehicleId: 0, x: 10, y: 0, z: 10, yaw: 0 },
  ],
  deathTime: null,
  hpSamples: [hp(0, 46400), hp(endT, 46400)],
  ...extra,
});

const veh = (id: number, name: string, shipId: number): VehicleEntry => ({
  id,
  name,
  relation: 2,
  shipId,
});

const pbPlayer = (name: string, killer: number | null): PostBattlePlayer => ({
  accountId: 0,
  name,
  realm: null,
  shipId: null,
  team: null,
  alive: killer == null,
  damage: 0,
  damageTaken: 0,
  frags: 0,
  hpRatio: null,
  killerId: killer,
  exp: null,
  ribbons: [],
});

const pbOf = (players: PostBattlePlayer[]): PostBattleData => ({
  players,
  mode: null,
  selfId: null,
  selfExp: null,
  selfCredits: null,
  raw: "",
});

describe("inferDarkDeaths", () => {
  const arena = (entityId: number, playerId: number): ArenaPlayer => ({
    entityId,
    teamId: 1,
    playerId,
    maxHealth: 46400,
  });

  it("marks a dark-killed ship dead at its last observed moment", () => {
    // Spotted until t=120 at full HP, then sank un-spotted: the stream
    // freezes at 46400 and no destroy packet exists.
    const trajs = [shipTraj(11, 400, 120)];
    const vehicles = [veh(7, "Foe", 400)];
    const inferred = inferDarkDeaths(
      trajs,
      pbOf([pbPlayer("Foe", 999)]),
      vehicles,
      [arena(11, 7)],
    );
    expect(inferred.get(11)).toBe(120);
  });

  it("never touches survivors or ships with a decoded death time", () => {
    const trajs = [
      shipTraj(11, 400, 120), // survivor: killerId null
      shipTraj(12, 401, 300, { deathTime: 300 }), // observed sink already known
    ];
    const vehicles = [veh(7, "Survivor", 400), veh(8, "SunkKnown", 401)];
    const inferred = inferDarkDeaths(
      trajs,
      pbOf([pbPlayer("Survivor", null), pbPlayer("SunkKnown", 999)]),
      vehicles,
      [arena(11, 7), arena(12, 8)],
    );
    expect(inferred.has(11)).toBe(false);
    expect(inferred.has(12)).toBe(false);
  });

  it("uses the later of the position and HP stream ends", () => {
    const trajs = [
      shipTraj(11, 400, 120, { hpSamples: [hp(0, 46400), hp(140, 46400)] }),
    ];
    const vehicles = [veh(7, "Foe", 400)];
    const inferred = inferDarkDeaths(
      trajs,
      pbOf([pbPlayer("Foe", 1)]),
      vehicles,
      [arena(11, 7)],
    );
    expect(inferred.get(11)).toBe(140);
  });

  it("joins by name first, then by account id, and skips non-ship entities", () => {
    const trajs = [shipTraj(11, 400, 100)];
    const vehicles = [veh(7, "NamedFoe", 400)];
    const byName = inferDarkDeaths(
      trajs,
      pbOf([pbPlayer("namedfoe ", 1)]),
      vehicles,
      [arena(11, 7)],
    );
    expect(byName.get(11)).toBe(100);
  });

  it("does nothing without the post-battle payload", () => {
    const trajs = [shipTraj(11, 400, 120)];
    const vehicles = [veh(7, "Foe", 400)];
    expect(
      inferDarkDeaths(trajs, null, vehicles, [arena(11, 7)]).size,
    ).toBe(0);
  });
});

describe("applyDarkDeathInference", () => {
  it("patches inferred times into the trajectories and reports their ids", () => {
    const trajs = [shipTraj(11, 400, 120), shipTraj(12, 401, 90)];
    const vehicles = [veh(7, "Foe", 400), veh(8, "Alive", 401)];
    const inferred = applyDarkDeathInference(
      trajs,
      pbOf([pbPlayer("Foe", 1), pbPlayer("Alive", null)]),
      vehicles,
      [
        { entityId: 11, teamId: 1, playerId: 7, maxHealth: 46400 },
        { entityId: 12, teamId: 1, playerId: 8, maxHealth: 40100 },
      ],
    );
    expect(inferred.size).toBe(1);
    expect(inferred.has(11)).toBe(true);
    expect(trajs[0].deathTime).toBe(120);
    expect(trajs[1].deathTime).toBeNull();
  });
});
