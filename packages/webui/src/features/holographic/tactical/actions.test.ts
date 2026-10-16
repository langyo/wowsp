import { describe, expect, it } from "vitest";
import type { EntityTrajectory, PositionSample } from "@/api/client";
import { extractActions, type ActionSource } from "./actions";

function traj(
  entityId: number,
  samples: [number, number, number][],
  entityType = 2,
): EntityTrajectory {
  return {
    entityId,
    kind: { entityType } as EntityTrajectory["kind"],
    samples: samples.map(([time, x, z]): PositionSample => ({ time, entityId, vehicleId: 0, x, y: 0, z, yaw: 0 })),
  };
}

/** Straight run: 60 s at 2 u/s, then decelerate to 0.4 u/s over 20 s, then
 *  stopped 20 s, then re-accelerate to 2 u/s over 20 s. */
function runTrajectory(entityId: number): EntityTrajectory {
  const pts: [number, number, number][] = [];
  let x = 0;
  for (let t = 0; t <= 60; t += 1) pts.push([t, x, 0]);
  for (let t = 61; t <= 80; t += 1) {
    x += 0.4 + ((80 - t) / 20) * 1.6;
    pts.push([t, x, 0]);
  }
  for (let t = 81; t <= 100; t += 1) pts.push([t, x, 0]);
  for (let t = 101; t <= 120; t += 1) {
    x += (t - 100) / 20 * 2;
    pts.push([t, x, 0]);
  }
  return traj(entityId, pts);
}

const base: ActionSource = { trajectories: [] };

describe("extractActions — speed changes", () => {
  it("emits slow-down, stop and speed-up from a run/decel/stop/accel script", () => {
    const acts = extractActions({ ...base, trajectories: [runTrajectory(7)] });
    const kinds = acts.map((a) => a.kind);
    expect(kinds).toContain("speedDown");
    expect(kinds).toContain("stop");
    expect(kinds).toContain("speedUp");
    // ordered, all attached to the ship
    for (const a of acts) expect(a.entityId).toBe(7);
    expect(acts.map((a) => a.time)).toEqual([...acts.map((a) => a.time)].sort((p, q) => p - q));
  });

  it("ignores non-ship entities and short sample runs", () => {
    const acts = extractActions({
      ...base,
      trajectories: [runTrajectory(3), traj(4, [[0, 0, 0], [1, 1, 0]], 14)],
    });
    expect(acts.filter((a) => a.entityId === 4)).toHaveLength(0);
  });

  it("debounces repeated bumpy-speed noise", () => {
    // Alternating fast/slow within the same stretch should not spam events.
    const pts: [number, number, number][] = [];
    let x = 0;
    for (let t = 0; t <= 200; t += 1) {
      x += t % 2 === 0 ? 2 : 1.7;
      pts.push([t, x, 0]);
    }
    const acts = extractActions({ ...base, trajectories: [traj(9, pts)] });
    const speedEvents = acts.filter((a) => a.kind !== "stop");
    expect(speedEvents.length).toBeLessThanOrEqual(4);
  });
});

describe("extractActions — gunfire & torpedoes", () => {
  it("groups a salvo burst into one shell marker with its ammo family", () => {
    const acts = extractActions({
      ...base,
      shellLaunches: [
        { time: 30, ownerId: 5, paramsId: 1, salvoId: 1, shotId: 1, x: 0, y: 0, z: 0, targetX: 0, targetY: 0, targetZ: 0, serverTimeLeft: 0, speed: 0, gunBarrelId: 0 },
        { time: 30.4, ownerId: 5, paramsId: 1, salvoId: 1, shotId: 2, x: 0, y: 0, z: 0, targetX: 0, targetY: 0, targetZ: 0, serverTimeLeft: 0, speed: 0, gunBarrelId: 1 },
        { time: 30.8, ownerId: 5, paramsId: 1, salvoId: 1, shotId: 3, x: 0, y: 0, z: 0, targetX: 0, targetY: 0, targetZ: 0, serverTimeLeft: 0, speed: 0, gunBarrelId: 2 },
      ],
    });
    const shells = acts.filter((a) => a.kind === "shell");
    expect(shells).toHaveLength(1);
    expect(shells[0].entityId).toBe(5);
  });

  it("keeps ship-tube and air-dropped torpedoes apart", () => {
    const acts = extractActions({
      ...base,
      trajectories: [traj(5, [[0, 0, 0], [5, 1, 0], [10, 2, 0]])],
      torpedoes: [
        { time: 10, ownerId: 5, paramsId: 1, salvoId: 1, shotId: 1, x: 0, y: 0, z: 0, dirX: 1, dirY: 0, dirZ: 0, armed: true },
        { time: 20, ownerId: 999, paramsId: 1, salvoId: 2, shotId: 9, x: 0, y: 0, z: 0, dirX: 1, dirY: 0, dirZ: 0, armed: true },
      ],
    });
    const shipFish = acts.find((a) => a.kind === "torpedo");
    const airFish = acts.find((a) => a.kind === "planeDrop" && a.dropKind === "torpedo");
    expect(shipFish?.entityId).toBe(5);
    expect(airFish?.entityId).toBe(999);
  });
});

describe("extractActions — planes", () => {
  const adds = [
    { time: 100, planeId: 1, ownerId: 42, teamId: 1, paramsId: 11, x: 0, z: 0 },
    { time: 104, planeId: 1, ownerId: 42, teamId: 1, paramsId: 11, x: 5, z: 5 }, // refresh, not a sortie
    { time: 200, planeId: 1, ownerId: 42, teamId: 1, paramsId: 11, x: 9, z: 9 }, // after landing → new sortie
  ];
  const removes = [{ time: 150, planeId: 1 }];
  const moves = [
    { time: 120, planeId: 1, x: 100, z: 0 },
  ];

  it("marks the first squadron add as takeoff and skips refreshes", () => {
    const acts = extractActions({ ...base, minimapSquadronAdds: adds, minimapSquadronRemoves: removes });
    const takeoffs = acts.filter((a) => a.kind === "planeTakeoff");
    expect(takeoffs).toHaveLength(2);
    expect(takeoffs[0].time).toBe(100);
    expect(takeoffs[1].time).toBe(200);
  });

  it("counts an explosion near the squadron track as a bomb drop", () => {
    const acts = extractActions({
      // carrier trajectory present → shipIds non-empty (regression guard:
      // carrier-owned squadrons must still produce drop markers)
      trajectories: [traj(42, [[0, 0, 0], [60, 4, 0], [130, 8, 0]])],
      minimapSquadronAdds: adds,
      minimapSquadronRemoves: removes,
      minimapSquadronMoves: moves,
      explosions: [{ time: 120, x: 105, y: 0, z: 3, paramsId: 4292854768 }],
    });
    const drops = acts.filter((a) => a.kind === "planeDrop" && a.dropKind === "bomb");
    expect(drops).toHaveLength(1);
    expect(drops[0].entityId).toBe(42);
    expect(drops[0].ammo).toBeTruthy();
  });

  it("ignores distant explosions", () => {
    const acts = extractActions({
      ...base,
      minimapSquadronAdds: adds,
      minimapSquadronRemoves: removes,
      minimapSquadronMoves: moves,
      explosions: [{ time: 120, x: 900, y: 0, z: 900, paramsId: 4292854768 }],
    });
    expect(acts.filter((a) => a.kind === "planeDrop" && a.dropKind === "bomb")).toHaveLength(0);
  });
});
