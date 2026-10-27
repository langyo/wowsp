/**
 * Unit tests for the decode-time spawn-symmetry probe (spawnSymmetry.ts).
 *
 * Synthetic `EntityTrajectory` arrays only — real-replay validation is done
 * separately (see the task report; the archived app-data replays are
 * read-only and never copied into the repo).
 */
import { describe, expect, it } from "vitest";

import type { EntityTrajectory } from "@/api";
import {
  DEFAULT_SPAWN_TOLERANCE_M,
  analyzeSpawnSymmetry,
  type EntitySide,
} from "./spawnSymmetry";

/** One ship trajectory at a spawn point (EntityCreate header included). */
function ship(entityId: number, x: number, z: number): EntityTrajectory {
  return {
    entityId,
    kind: {
      entityType: 2,
      vehicleId: 0,
      initialX: x,
      initialY: 0,
      initialZ: z,
      creationTime: 0,
    },
    samples: [{ time: 0, entityId, vehicleId: 0, x, y: 0, z, yaw: 0 }],
  };
}

/** Entity with no EntityCreate (kind missing) — spawn falls back to samples. */
function sampleOnly(entityId: number, x: number, z: number): EntityTrajectory {
  return {
    entityId,
    samples: [{ time: 5, entityId, vehicleId: 0, x, y: 0, z, yaw: 0 }],
  };
}

/** sideOf backed by an explicit id -> side map. */
function sideLookup(sides: Record<number, EntitySide>): (entityId: number) => EntitySide | null {
  return (entityId) => sides[entityId] ?? null;
}

/** Build both fleets as a point-mirrored pair about an arbitrary centre. */
function mirroredFleets(centre: { x: number; z: number }) {
  const ally = [
    { x: centre.x - 20, z: centre.z - 10 },
    { x: centre.x + 20, z: centre.z - 10 },
    { x: centre.x - 20, z: centre.z + 10 },
    { x: centre.x + 20, z: centre.z + 10 },
  ];
  const enemy = ally.map((p) => ({ x: 2 * centre.x - p.x, z: 2 * centre.z - p.z }));
  return { ally, enemy };
}

describe("analyzeSpawnSymmetry", () => {
  it("flags a mirrored fleet pair as symmetric", () => {
    const { ally, enemy } = mirroredFleets({ x: 50, z: -25 });
    const trajectories: EntityTrajectory[] = [];
    const sides: Record<number, EntitySide> = {};
    ally.forEach((p, i) => {
      trajectories.push(ship(100 + i, p.x, p.z));
      sides[100 + i] = "ally";
    });
    enemy.forEach((p, i) => {
      trajectories.push(ship(200 + i, p.x, p.z));
      sides[200 + i] = "enemy";
    });

    const result = analyzeSpawnSymmetry(trajectories, sideLookup(sides));

    expect(result.symmetric).toBe(true);
    expect(result.reason).toBe("symmetric");
    expect(result.matchFraction).toBe(1);
    expect(result.tolerance).toBe(DEFAULT_SPAWN_TOLERANCE_M);
    expect(result.centre).not.toBeNull();
    expect(result.centre!.x).toBeCloseTo(50, 6);
    expect(result.centre!.z).toBeCloseTo(-25, 6);
    expect(result.allySpawns).toHaveLength(4);
    expect(result.enemySpawns).toHaveLength(4);
    expect(result.matches).toHaveLength(4);
    expect(result.matches.every((m) => m.distance === 0)).toBe(true);
  });

  it("flags scattered wave spawns as asymmetric", () => {
    // Ally fleet in one compact blob; the enemy "waves" are strung out over
    // the whole map (the scripted-operation shape) — no mirrored cluster.
    const trajectories: EntityTrajectory[] = [
      ship(1, -300, -200),
      ship(2, -250, -150),
      ship(3, -350, -150),
      ship(4, -300, -250),
      ship(11, 400, 500),
      ship(12, 500, 600),
      ship(13, -500, 600),
      ship(14, 600, -400),
      ship(15, -600, -450),
      ship(16, 0, 700),
    ];
    const sides: Record<number, EntitySide> = {
      1: "ally",
      2: "ally",
      3: "ally",
      4: "ally",
      11: "enemy",
      12: "enemy",
      13: "enemy",
      14: "enemy",
      15: "enemy",
      16: "enemy",
    };

    const result = analyzeSpawnSymmetry(trajectories, sideLookup(sides));

    expect(result.symmetric).toBe(false);
    expect(result.reason).toBe("asymmetric");
    expect(result.matchFraction).toBe(0);
  });

  it("returns null when the enemy side never resolves (unspotted enemies)", () => {
    const trajectories: EntityTrajectory[] = [
      ship(1, -300, -200),
      ship(2, -250, -150),
      ship(3, -350, -150),
      ship(11, 400, 500),
      ship(12, 500, 600),
    ];
    const sides: Record<number, EntitySide> = { 1: "ally", 2: "ally", 3: "ally" };

    const result = analyzeSpawnSymmetry(trajectories, sideLookup(sides));

    expect(result.symmetric).toBeNull();
    expect(result.reason).toBe("no-spawns");
    expect(result.enemySpawns).toHaveLength(0);
    expect(result.matchFraction).toBeNull();
  });

  it("returns null for an empty input and for a one-sided battle", () => {
    const empty = analyzeSpawnSymmetry([], () => null);
    expect(empty.symmetric).toBeNull();
    expect(empty.reason).toBe("no-spawns");

    const oneSide = analyzeSpawnSymmetry(
      [ship(1, 0, 0), ship(2, 10, 0), ship(3, 20, 0)],
      sideLookup({ 1: "ally", 2: "ally", 3: "ally" }),
    );
    expect(oneSide.symmetric).toBeNull();
    expect(oneSide.reason).toBe("no-spawns");
  });

  it("returns null (insufficient data) with fewer than two spawns per side", () => {
    const trajectories: EntityTrajectory[] = [
      ship(1, -300, 0),
      ship(11, 300, 0),
      ship(12, 320, 10),
    ];
    const result = analyzeSpawnSymmetry(
      trajectories,
      sideLookup({ 1: "ally", 11: "enemy", 12: "enemy" }),
    );

    expect(result.symmetric).toBeNull();
    expect(result.reason).toBe("insufficient-data");
    // Diagnostics are still reported — only the verdict needs the data.
    expect(result.matchFraction).toBe(1);
    expect(result.allySpawns).toHaveLength(1);
  });

  it("treats matchFraction 0.6 as symmetric (>= boundary)", () => {
    // 3 ally spawns mirrored exactly by 3 of 5 enemy spawns; the remaining two
    // enemy spawns are placed so the enemy centroid stays the mirror of the
    // ally centroid (both far from any mirrored ally point).
    const trajectories: EntityTrajectory[] = [
      ship(1, -300, 0),
      ship(2, -300, 100),
      ship(3, -300, 200),
      ship(11, 300, 0),
      ship(12, 300, -100),
      ship(13, 300, -200),
      ship(14, 1000, -50),
      ship(15, -400, -150),
    ];
    const sides: Record<number, EntitySide> = {
      1: "ally",
      2: "ally",
      3: "ally",
      11: "enemy",
      12: "enemy",
      13: "enemy",
      14: "enemy",
      15: "enemy",
    };

    const result = analyzeSpawnSymmetry(trajectories, sideLookup(sides));

    expect(result.matchFraction).toBeCloseTo(0.6, 10);
    expect(result.symmetric).toBe(true);
    expect(result.reason).toBe("symmetric");
  });

  it("treats matchFraction 0.5 as asymmetric (<= boundary)", () => {
    // 2 exact mirror pairs + 2 enemies that are each other's mirror-offset, so
    // the centroid stays aligned; with the default 9 km tolerance the stray
    // pair is far from every mirrored ally spawn.
    const trajectories: EntityTrajectory[] = [
      ship(1, -300, 0),
      ship(2, -300, 100),
      ship(11, 300, 0),
      ship(12, 300, -100),
      ship(13, 1000, 0),
      ship(14, -400, -100),
    ];
    const sides: Record<number, EntitySide> = {
      1: "ally",
      2: "ally",
      11: "enemy",
      12: "enemy",
      13: "enemy",
      14: "enemy",
    };

    const result = analyzeSpawnSymmetry(trajectories, sideLookup(sides));

    expect(result.matchFraction).toBeCloseTo(0.5, 10);
    expect(result.symmetric).toBe(false);
    expect(result.reason).toBe("asymmetric");
  });

  it("returns null (ambiguous) inside the widened false-cut band", () => {
    // Same half-matched shape as above, but a narrowed false-cut makes it
    // ambiguous — callers must leave the classification alone here.
    const trajectories: EntityTrajectory[] = [
      ship(1, -300, 0),
      ship(2, -300, 100),
      ship(11, 300, 0),
      ship(12, 300, -100),
      ship(13, 1000, 0),
      ship(14, -400, -100),
    ];
    const sides: Record<number, EntitySide> = {
      1: "ally",
      2: "ally",
      11: "enemy",
      12: "enemy",
      13: "enemy",
      14: "enemy",
    };

    const result = analyzeSpawnSymmetry(trajectories, sideLookup(sides), {
      asymmetricAt: 0.2,
    });

    expect(result.matchFraction).toBeCloseTo(0.5, 10);
    expect(result.symmetric).toBeNull();
    expect(result.reason).toBe("ambiguous");
  });

  it("honours an explicit tolerance override", () => {
    // Mirrored fleets, but each enemy spawn sits 50 world units (1.5 km) off
    // its mirrored point (the pair is spread apart, so the centroid-derived
    // centre cannot absorb the offset): symmetric under the 9 km default,
    // asymmetric under a tight 300 m tolerance.
    const trajectories: EntityTrajectory[] = [
      ship(1, -300, 0),
      ship(2, -300, 100),
      ship(11, 300, 50),
      ship(12, 300, -150),
    ];
    const sides: Record<number, EntitySide> = {
      1: "ally",
      2: "ally",
      11: "enemy",
      12: "enemy",
    };

    const loose = analyzeSpawnSymmetry(trajectories, sideLookup(sides));
    expect(loose.symmetric).toBe(true);

    const tight = analyzeSpawnSymmetry(trajectories, sideLookup(sides), { tolerance: 300 });
    expect(tight.tolerance).toBe(300);
    expect(tight.symmetric).toBe(false);
    expect(tight.matchFraction).toBe(0);
  });

  it("falls back to the first sample when EntityCreate metadata is missing", () => {
    const trajectories: EntityTrajectory[] = [
      sampleOnly(1, -300, 0),
      sampleOnly(2, -300, 100),
      sampleOnly(11, 300, 0),
      sampleOnly(12, 300, -100),
    ];
    const result = analyzeSpawnSymmetry(
      trajectories,
      sideLookup({ 1: "ally", 2: "ally", 11: "enemy", 12: "enemy" }),
    );

    expect(result.allySpawns[0]).toMatchObject({ x: -300, z: 0, time: 5 });
    expect(result.symmetric).toBe(true);
  });

  it("skips entities with no usable spawn point and unknown sides", () => {
    const trajectories: EntityTrajectory[] = [
      ship(1, -300, 0),
      ship(2, -300, 100),
      ship(11, 300, 0),
      ship(12, 300, -100),
      // No kind and no samples: nothing to measure.
      { entityId: 90, samples: [] },
      // Usable position, but the caller cannot assign a side.
      ship(91, 5000, 5000),
    ];
    const result = analyzeSpawnSymmetry(
      trajectories,
      sideLookup({ 1: "ally", 2: "ally", 11: "enemy", 12: "enemy" }),
    );

    expect(result.allySpawns.map((s) => s.entityId)).toEqual([1, 2]);
    expect(result.enemySpawns.map((s) => s.entityId)).toEqual([11, 12]);
    expect(result.symmetric).toBe(true);
  });

  it("grows the default tolerance with very scattered fleets", () => {
    const trajectories: EntityTrajectory[] = [];
    const sides: Record<number, EntitySide> = {};
    for (let i = 0; i < 4; i++) {
      trajectories.push(ship(100 + i, -3000 + i * 1200, -3000 + i * 1200));
      sides[100 + i] = "ally";
      trajectories.push(ship(200 + i, 3000 - i * 1200, 3000 - i * 1200 + 400));
      sides[200 + i] = "enemy";
    }

    const result = analyzeSpawnSymmetry(trajectories, sideLookup(sides));

    // Mean cluster radius is ~1800 world units, so 0.25 * 1800 * 30 m
    // (13.5 km) beats the 9 km floor.
    expect(result.tolerance).toBeGreaterThan(DEFAULT_SPAWN_TOLERANCE_M);
  });
});
