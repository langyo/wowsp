/** Unit tests for the plane-follow card derivation (pure functions). */
import { describe, expect, it } from "vitest";
import {
  squadronAttacking,
  squadronSamplesAt,
  squadronStrength,
  SQUADRON_ATTACK_PITCH_DEG,
} from "./planeFollow";

/** One aircraft update sample. Declared locally instead of SquadronPlane so
 *  the optional `pitch` compiles whether or not the decoder type has grown
 *  the field yet (the lead owns that change; planeFollow reads pitch
 *  structurally). */
interface Sample {
  time: number;
  planeId: number;
  index: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch?: number;
}

/** One aircraft update sample at match time `time` (pitch optional — older
 *  streams carry none). */
const sp = (time: number, planeId = 1, index = 0, pitch?: number): Sample => ({
  time,
  planeId,
  index,
  x: 0,
  y: 100,
  z: 0,
  yaw: 0,
  ...(pitch != null ? { pitch } : {}),
});

/** One formation-member trail of a squadron, one sample per given time. */
const trail = (planeId: number, times: number[], index = 0) => ({
  id: planeId * 16 + index,
  samples: times.map((t) => sp(t, planeId, index)),
});

/** No minimap remove events. */
const noRemoves = new Map<number, number>();

describe("squadronStrength", () => {
  it("counts every live formation member against the launch strength", () => {
    // Three members airborne mid-sortie: 3 / 3.
    const trails = [trail(1, [10, 20]), trail(1, [10, 20], 1), trail(1, [10, 20], 2)];
    expect(squadronStrength(trails, 1, noRemoves, 15)).toEqual({
      alive: 3,
      total: 3,
    });
  });

  it("drops shot-down wingmen from alive but keeps the launch strength", () => {
    // Member 1's stream stopped at t=12 → its grace window ends at 17;
    // the anchor and member 2 ran to 20 (expiry 25). At t=18: 2 / 3.
    const trails = [trail(1, [10, 20]), trail(1, [10, 12], 1), trail(1, [10, 20], 2)];
    expect(squadronStrength(trails, 1, noRemoves, 18)).toEqual({
      alive: 2,
      total: 3,
    });
    // After every window has passed: no live plane → null, not 0 / N.
    expect(squadronStrength(trails, 1, noRemoves, 40)).toBeNull();
  });

  it("obeys the remove event even when samples run longer", () => {
    const trails = [trail(3, [10, 100])];
    const removeAt = new Map<number, number>([[3, 50]]);
    expect(squadronStrength(trails, 3, removeAt, 20)).toEqual({
      alive: 1,
      total: 1,
    });
    expect(squadronStrength(trails, 3, removeAt, 50)).toEqual({
      alive: 1,
      total: 1,
    });
    expect(squadronStrength(trails, 3, removeAt, 50.1)).toBeNull();
  });

  it("is null before the launch and during the anchor's first gap", () => {
    const trails = [trail(1, [10, 20]), trail(1, [12, 20], 1)];
    expect(squadronStrength(trails, 1, noRemoves, 9.9)).toBeNull();
    // The anchor launched, the late member has not: 1 / 2.
    expect(squadronStrength(trails, 1, noRemoves, 11)).toEqual({
      alive: 1,
      total: 2,
    });
    // Launch timestamp itself counts (born <= t, sample at t inclusive).
    expect(squadronStrength(trails, 1, noRemoves, 12)).toEqual({
      alive: 2,
      total: 2,
    });
  });

  it("only counts the asked squadron's trails", () => {
    const trails = [trail(1, [10, 20]), trail(2, [10, 20]), trail(2, [10, 20], 1)];
    expect(squadronStrength(trails, 1, noRemoves, 15)).toEqual({
      alive: 1,
      total: 1,
    });
    expect(squadronStrength([], 1, noRemoves, 15)).toBeNull();
  });
});

describe("squadronAttacking", () => {
  it("is false without pitch data or without a dive", () => {
    expect(squadronAttacking([])).toBe(false);
    // Older streams: no pitch at all — never "attacking".
    expect(squadronAttacking([sp(10), sp(11, 1, 1)])).toBe(false);
    expect(squadronAttacking([sp(10, 1, 0, 0), sp(11, 1, 1, -10)])).toBe(false);
  });

  it("is true at or beyond the dive threshold on any member", () => {
    expect(SQUADRON_ATTACK_PITCH_DEG).toBe(-25);
    expect(squadronAttacking([sp(10, 1, 0, -25)])).toBe(true);
    expect(squadronAttacking([sp(10, 1, 0, -30)])).toBe(true);
    // One diving member is enough even among shallow climbers.
    expect(squadronAttacking([sp(10, 1, 0, 5), sp(11, 1, 1, -40)])).toBe(true);
  });
});

describe("squadronSamplesAt", () => {
  it("collects each member's last sample at or before t", () => {
    const trails = [
      { id: 1 * 16, samples: [sp(10, 1, 0, -5), sp(20, 1, 0, -30)] },
      { id: 1 * 16 + 1, samples: [sp(12, 1, 1, 0)] },
      { id: 1 * 16 + 2, samples: [sp(25, 1, 2, -10)] },
      // Another squadron's trail must not leak in.
      { id: 2 * 16, samples: [sp(15, 2, 0, -60)] },
    ];
    expect(squadronSamplesAt(trails, 1, 15)).toEqual([
      sp(10, 1, 0, -5),
      sp(12, 1, 1, 0),
    ]);
    expect(squadronSamplesAt(trails, 1, 30)).toEqual([
      sp(20, 1, 0, -30),
      sp(12, 1, 1, 0),
      sp(25, 1, 2, -10),
    ]);
    expect(squadronSamplesAt(trails, 1, 9)).toEqual([]);
  });
});
