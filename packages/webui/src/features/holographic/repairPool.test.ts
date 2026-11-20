/**
 * Tests for the Repair-Party recoverable-HP state machine (repairPool.ts) —
 * the grey layer of the three-layer HP bar.
 *
 * The contract under test is the game's own repair-bar reading: damage inside
 * a Repair Party window accrues a recoverable pool at the heal coefficient,
 * heals drain that pool FIRST (never accrue), two back-to-back repairs keep
 * independent pools that sum, the total is capped by coefficient x maxHp, and
 * every answer is a pure function of the playhead (scrub-stable) with absent
 * events meaning "feature off".
 */
import { describe, expect, it } from "vitest";

import type { ConsumableUseEvent, HpSample } from "@/api";

import {
  REPAIR_PARTY_CONSUMABLE_ID,
  REPAIR_PARTY_RECOVERABLE_FRAC,
  hasRepairPartyUse,
  hpBarSegments,
  repairRecoverableAt,
  repairRecoverableFracAt,
  repairWindowsFor,
} from "./repairPool";

const MAX_HP = 10_000;

/** One vehicle consumable activation on the wire shape. */
function use(
  time: number,
  entityId: number,
  duration = 28,
  consumableId = REPAIR_PARTY_CONSUMABLE_ID,
): ConsumableUseEvent {
  return { time, entityId, usageType: 1, consumableId, duration };
}

function hp(time: number, value: number): HpSample {
  return { time, value };
}

describe("repairWindowsFor", () => {
  it("keeps only the hull's own repair-party windows, sorted and positive", () => {
    const events = [
      use(30, 7),
      use(10, 7, 28),
      use(12, 9), // another hull
      use(14, 7, 0), // zero duration opens no window
      use(16, 7, 28, 0), // damage control, not repair party
    ];
    expect(repairWindowsFor(events, 7)).toEqual([
      { start: 10, end: 38 },
      { start: 30, end: 58 },
    ]);
    expect(repairWindowsFor(events, 9)).toEqual([{ start: 12, end: 40 }]);
    expect(repairWindowsFor(undefined, 7)).toEqual([]);
  });

  it("answers the feature-on flag per hull", () => {
    const events = [use(10, 7)];
    expect(hasRepairPartyUse(events, 7)).toBe(true);
    expect(hasRepairPartyUse(events, 8)).toBe(false);
    expect(hasRepairPartyUse(undefined, 7)).toBe(false);
  });
});

describe("repairRecoverableAt", () => {
  it("accrues damage taken inside the window at the coefficient", () => {
    const events = [use(10, 7)];
    const samples = [hp(0, MAX_HP), hp(20, 8_000)];
    // 2,000 damage inside the window x 0.5 = 1,000 recoverable.
    expect(repairRecoverableAt(events, samples, MAX_HP, 0.5, 25, 7)).toBe(1_000);
    // Before the window opens there is no pool yet.
    expect(repairRecoverableAt(events, samples, MAX_HP, 0.5, 5, 7)).toBe(0);
  });

  it("ignores damage taken OUTSIDE every window", () => {
    const events = [use(10, 7)];
    const samples = [
      hp(0, MAX_HP),
      hp(5, 9_000), // before the window opens: lost for good
      hp(20, 8_000), // inside the window: +500
      hp(45, 7_500), // after it closed (ends at 38): lost for good
    ];
    expect(repairRecoverableAt(events, samples, MAX_HP, 0.5, 46, 7)).toBe(500);
  });

  it("drains the pool on heals and never counts a heal as damage", () => {
    const events = [use(10, 7)];
    const samples = [
      hp(0, MAX_HP),
      hp(15, 8_000), // -2,000 in the window -> +1,000 pool
      hp(20, 9_000), // +1,000 heal -> pool drains to 0
      hp(25, 9_500), // +500 more heal: nothing left to drain, never damage
    ];
    expect(repairRecoverableAt(events, samples, MAX_HP, 0.5, 16, 7)).toBe(1_000);
    expect(repairRecoverableAt(events, samples, MAX_HP, 0.5, 21, 7)).toBe(0);
    expect(repairRecoverableAt(events, samples, MAX_HP, 0.5, 26, 7)).toBe(0);
  });

  it("keeps two back-to-back repairs in separate pools and sums them", () => {
    const events = [use(10, 7), use(40, 7)];
    const samples = [
      hp(0, MAX_HP),
      hp(20, 8_000), // window 1: -2,000 -> +1,000
      hp(30, 8_500), // +500 heal -> pool 1 keeps 500
      hp(45, 7_000), // window 2: -1,500 -> pool 2 +750
    ];
    // Both windows' pools show at once: 500 (window 1) + 750 (window 2).
    expect(repairRecoverableAt(events, samples, MAX_HP, 0.5, 46, 7)).toBe(1_250);
    // The re-cast did NOT re-claim what the first window already queued and
    // the heal already drained: between the two windows the bar reads 500.
    expect(repairRecoverableAt(events, samples, MAX_HP, 0.5, 31, 7)).toBe(500);
  });

  it("caps the pool at coefficient x maxHp", () => {
    // The cap only binds when the HP stream reads ABOVE the resolved total
    // (a stale arena maxHp): 11,000 damage x 0.5 = 5,500 would paint a grey
    // segment wider than the hull's whole budget — clamp to 5,000.
    const events = [use(10, 7)];
    const samples = [hp(0, 20_000), hp(15, 9_000)];
    expect(repairRecoverableAt(events, samples, MAX_HP, 0.5, 16, 7)).toBe(5_000);
  });

  it("is scrub-stable: any query order, any seek, same answer", () => {
    const events = [use(10, 7), use(60, 7)];
    const samples = [
      hp(0, MAX_HP),
      hp(15, 8_000), // -2,000 in window 1 -> 1,000
      hp(25, 8_500), // +500 heal -> 500
      hp(35, 7_000), // -1,500 in window 1 -> +750 -> 1,250
      hp(70, 7_500), // +500 heal -> 750
    ];
    const times = [10, 16, 26, 36, 50, 71];
    const expected = [0, 1_000, 500, 1_250, 1_250, 750];
    const forward = times.map((t) =>
      repairRecoverableAt(events, samples, MAX_HP, 0.5, t, 7),
    );
    expect(forward).toEqual(expected);
    // Backwards, then a shuffled probe order: every call replays the fold
    // from the samples at or before t, so the answers cannot drift.
    const backwards = [...times]
      .reverse()
      .map((t) => repairRecoverableAt(events, samples, MAX_HP, 0.5, t, 7))
      .reverse();
    expect(backwards).toEqual(expected);
    for (const i of [3, 0, 5, 2, 1, 4]) {
      expect(repairRecoverableAt(events, samples, MAX_HP, 0.5, times[i], 7)).toBe(
        expected[i],
      );
    }
  });

  it("is a no-op without events (feature off) and without a hull budget", () => {
    const samples = [hp(0, MAX_HP), hp(20, 5_000)];
    expect(repairRecoverableAt(undefined, samples, MAX_HP, 0.5, 25, 7)).toBe(0);
    expect(repairRecoverableAt([], samples, MAX_HP, 0.5, 25, 7)).toBe(0);
    // Events for OTHER hulls change nothing for this one.
    expect(repairRecoverableAt([use(10, 9)], samples, MAX_HP, 0.5, 25, 7)).toBe(0);
    // Unknown max HP / empty HP stream: no readable bar, no pool.
    expect(repairRecoverableAt([use(10, 7)], samples, null, 0.5, 25, 7)).toBe(0);
    expect(repairRecoverableAt([use(10, 7)], [], MAX_HP, 0.5, 25, 7)).toBe(0);
  });

  it("defaults the coefficient to the documented flat 0.5", () => {
    expect(REPAIR_PARTY_RECOVERABLE_FRAC).toBe(0.5);
    const events = [use(10, 7)];
    const samples = [hp(0, MAX_HP), hp(20, 8_000)];
    expect(repairRecoverableFracAt(events, samples, MAX_HP, 25, 7)).toBeCloseTo(0.1, 10);
  });
});

describe("repairRecoverableFracAt", () => {
  it("reports null when the hull has no repair data (feature off)", () => {
    const samples = [hp(0, MAX_HP), hp(20, 8_000)];
    expect(repairRecoverableFracAt(undefined, samples, MAX_HP, 25, 7)).toBeNull();
    expect(repairRecoverableFracAt([use(10, 9)], samples, MAX_HP, 25, 7)).toBeNull();
    expect(repairRecoverableFracAt([use(10, 7)], samples, null, 25, 7)).toBeNull();
  });

  it("reports 0 (not null) once a repair's pool is exhausted", () => {
    const events = [use(10, 7)];
    const samples = [hp(0, MAX_HP), hp(15, 8_000), hp(20, 10_000)];
    expect(repairRecoverableFracAt(events, samples, MAX_HP, 26, 7)).toBe(0);
  });
});

describe("hpBarSegments", () => {
  it("splits green | gray | red with the gray eating the lost width", () => {
    const s = hpBarSegments(0.6, 0.25);
    expect(s.green).toBeCloseTo(0.6, 10);
    expect(s.gray).toBeCloseTo(0.25, 10);
    expect(s.red).toBeCloseTo(0.15, 10);
  });

  it("never takes width out of green", () => {
    // A pool larger than the lost HP (a stale/over-accrued read) clamps to
    // the lost remainder instead of painting over the green.
    const s = hpBarSegments(0.8, 0.5);
    expect(s.green).toBeCloseTo(0.8, 10);
    expect(s.gray).toBeCloseTo(0.2, 10);
    expect(s.red).toBe(0);
  });

  it("leaves the bar unchanged when there is no repair pool", () => {
    expect(hpBarSegments(0.4, null)).toEqual({ green: 0.4, gray: 0, red: 0.6 });
    expect(hpBarSegments(0.4, 0)).toEqual({ green: 0.4, gray: 0, red: 0.6 });
  });

  it("clamps garbage instead of painting past the track", () => {
    expect(hpBarSegments(null, null)).toEqual({ green: 0, gray: 0, red: 1 });
    expect(hpBarSegments(Number.NaN, -2)).toEqual({ green: 0, gray: 0, red: 1 });
    expect(hpBarSegments(2, 0.5)).toEqual({ green: 1, gray: 0, red: 0 });
  });
});
