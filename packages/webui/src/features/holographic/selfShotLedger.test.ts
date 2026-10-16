import { describe, expect, it } from "vitest";
import { buildSelfShotLedger, querySelfShotLedger } from "./selfShotLedger";
import type { EntityTrajectory, ShotKillEvent } from "@/api";

/** A ship trajectory with a straight 10 u/s run and a flat HP stream. */
function shipTraj(
  entityId: number,
  opts: {
    x0?: number;
    z0?: number;
    hp?: { time: number; value: number }[];
    deathTime?: number;
  } = {},
): EntityTrajectory {
  return {
    entityId,
    kind: { entityType: 2, initialX: opts.x0 ?? 0, initialZ: opts.z0 ?? 0 },
    samples: [
      { time: 0, x: opts.x0 ?? 0, z: opts.z0 ?? 0, yaw: 0 },
      { time: 10, x: (opts.x0 ?? 0) + 100, z: opts.z0 ?? 0, yaw: 0 },
    ],
    hpSamples: opts.hp,
    deathTime: opts.deathTime,
  } as unknown as EntityTrajectory;
}

function shot(
  ownerId: number,
  time: number,
  x: number,
  z: number,
): ShotKillEvent {
  return { ownerId, time, x, z, shotId: 0 } as unknown as ShotKillEvent;
}

const SELF = 1;

describe("buildSelfShotLedger + querySelfShotLedger", () => {
  const victim = shipTraj(2, {
    x0: 0,
    z0: 0,
    hp: [
      { time: 0, value: 10000 },
      { time: 5, value: 10000 },
      { time: 6, value: 9000 },
    ],
    deathTime: 6,
  });
  const distant = shipTraj(3, { x0: 5000, z0: 5000 });
  const trajectories = [victim, distant, shipTraj(SELF, { x0: -100, z0: 0 })];

  it("is empty without self shots", () => {
    const ledger = buildSelfShotLedger({
      shotKills: [shot(9, 3, 0, 0)],
      trajectories,
      selfEntityId: SELF,
    });
    expect(ledger.times).toEqual([]);
    expect(querySelfShotLedger(ledger, 100)).toEqual({ hits: 0, damage: 0, frags: 0 });
  });

  it("attributes damage and frags for impacts near a victim", () => {
    const ledger = buildSelfShotLedger({
      shotKills: [shot(SELF, 6, 50, 0)],
      trajectories,
      selfEntityId: SELF,
    });
    // Before the impact: nothing counted yet.
    expect(querySelfShotLedger(ledger, 5)).toEqual({ hits: 0, damage: 0, frags: 0 });
    // At the impact: 1 hit, 1000 damage (HP 10000 → 9000 at t=6), and the
    // victim's death at t=6 sits inside the ±1.2 s frag window.
    const at = querySelfShotLedger(ledger, 6);
    expect(at.hits).toBe(1);
    expect(at.damage).toBe(1000);
    expect(at.frags).toBe(1);
    // After: the same numbers hold.
    expect(querySelfShotLedger(ledger, 60)).toEqual(at);
  });

  it("ignores ships outside the 500 m impact window", () => {
    const ledger = buildSelfShotLedger({
      shotKills: [shot(SELF, 6, 4000, 4000)],
      trajectories,
      selfEntityId: SELF,
    });
    // Near `distant`'s position? (5000,5000) is >500 m from the impact.
    expect(querySelfShotLedger(ledger, 10).damage).toBe(0);
  });

  it("excludes inferred (dark) sinks from frag credit", () => {
    const ledger = buildSelfShotLedger({
      shotKills: [shot(SELF, 6, 50, 0)],
      trajectories,
      selfEntityId: SELF,
      inferredDeaths: new Set([2]),
    });
    expect(querySelfShotLedger(ledger, 6).frags).toBe(0);
    // Damage attribution is unaffected by the frag filter.
    expect(querySelfShotLedger(ledger, 6).damage).toBe(1000);
  });

  it("never credits the recorder's own HP drops as self damage", () => {
    const bleedingSelf = shipTraj(SELF, {
      hp: [
        { time: 0, value: 20000 },
        { time: 6, value: 18000 },
      ],
    });
    const ledger = buildSelfShotLedger({
      shotKills: [shot(SELF, 6, 0, 0)],
      trajectories: [bleedingSelf],
      selfEntityId: SELF,
    });
    expect(querySelfShotLedger(ledger, 6).damage).toBe(0);
  });

  it("prefix sums stay correct when events arrive out of order", () => {
    const ledger = buildSelfShotLedger({
      shotKills: [
        shot(SELF, 8, 50, 0),
        shot(SELF, 3, 50, 0),
      ],
      trajectories: [victim, shipTraj(4, { x0: 0, z0: 0, deathTime: 3 })],
      selfEntityId: SELF,
    });
    expect(ledger.times).toEqual([3, 8]);
    expect(querySelfShotLedger(ledger, 5).hits).toBe(1);
    expect(querySelfShotLedger(ledger, 9).hits).toBe(2);
  });
});
