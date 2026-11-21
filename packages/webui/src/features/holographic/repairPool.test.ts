/**
 * Tests for the Repair-Party recoverable-HP state machine (repairPool.ts) —
 * the grey layer of the three-layer HP bar.
 *
 * The contract under test is the game's own repair-bar reading, split into the
 * two GameParams numbers it is made of: damage inside a Repair Party window
 * accrues a recoverable pool at the per-DAMAGE share (hit-location
 * regeneratedHPPart, a flat 0.5 typical), capped by the per-CHARGE CAPACITY
 * (one charge's regenerationHPSpeed × workTime × maxHp, the baked table);
 * heals drain that pool FIRST (never accrue), two back-to-back repairs keep
 * independent pools that each cap at their own charge capacity and sum on the
 * bar, and every answer is a pure function of the playhead (scrub-stable)
 * with absent events meaning "feature off".
 */
import { describe, expect, it } from "vitest";

import type { ConsumableUseEvent, HpSample } from "@/api";
import repairCoefficients from "@/data/repair_coefficients.json";

import {
  REPAIR_PARTY_CONSUMABLE_ID,
  REPAIR_PARTY_DAMAGE_SHARE,
  REPAIR_PARTY_RECOVERABLE_FRAC,
  hasRepairPartyUse,
  hpBarSegments,
  repairCoefficientFor,
  repairRecoverableAt,
  repairRecoverableFracAt,
  repairWindowsFor,
} from "./repairPool";

const MAX_HP = 10_000;

/** The single-window examples use a deliberately loose 0.5 capacity (5,000 HP
 *  of a 10,000 HP hull) so they measure the SHARE, not the cap; the cap cases
 *  pass their own tighter coefficient. */
const CAPACITY = 0.5;

/** The documented typical per-damage share: 2,000 damage → 1,000 queued. */
const SHARE = REPAIR_PARTY_DAMAGE_SHARE;

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
  it("queues damage taken inside the window at the per-damage share", () => {
    const events = [use(10, 7)];
    const samples = [hp(0, MAX_HP), hp(20, 8_000)];
    // 2,000 damage inside the window x 0.5 share = 1,000 recoverable; the
    // 5,000-HP charge capacity does not bind.
    expect(
      repairRecoverableAt(events, samples, MAX_HP, CAPACITY, 25, 7, SHARE),
    ).toBe(1_000);
    // Before the window opens there is no pool yet.
    expect(
      repairRecoverableAt(events, samples, MAX_HP, CAPACITY, 5, 7, SHARE),
    ).toBe(0);
  });

  it("ignores damage taken OUTSIDE every window", () => {
    const events = [use(10, 7)];
    const samples = [
      hp(0, MAX_HP),
      hp(5, 9_000), // before the window opens: lost for good
      hp(20, 8_000), // inside the window: +500
      hp(45, 7_500), // after it closed (ends at 38): lost for good
    ];
    expect(
      repairRecoverableAt(events, samples, MAX_HP, CAPACITY, 46, 7, SHARE),
    ).toBe(500);
  });

  it("drains the pool on heals and never counts a heal as damage", () => {
    const events = [use(10, 7)];
    const samples = [
      hp(0, MAX_HP),
      hp(15, 8_000), // -2,000 in the window -> +1,000 pool
      hp(20, 9_000), // +1,000 heal -> pool drains to 0
      hp(25, 9_500), // +500 more heal: nothing left to drain, never damage
    ];
    expect(
      repairRecoverableAt(events, samples, MAX_HP, CAPACITY, 16, 7, SHARE),
    ).toBe(1_000);
    expect(
      repairRecoverableAt(events, samples, MAX_HP, CAPACITY, 21, 7, SHARE),
    ).toBe(0);
    expect(
      repairRecoverableAt(events, samples, MAX_HP, CAPACITY, 26, 7, SHARE),
    ).toBe(0);
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
    expect(
      repairRecoverableAt(events, samples, MAX_HP, CAPACITY, 46, 7, SHARE),
    ).toBe(1_250);
    // The re-cast did NOT re-claim what the first window already queued and
    // the heal already drained: between the two windows the bar reads 500.
    expect(
      repairRecoverableAt(events, samples, MAX_HP, CAPACITY, 31, 7, SHARE),
    ).toBe(500);
  });

  it("caps a window's pool at its own charge capacity", () => {
    // 6,000 damage inside the window x 0.5 share = 3,000 queued, but a 0.25
    // capacity charge restores only 2,500 — the capacity clamps the pool.
    const events = [use(10, 7)];
    const samples = [hp(0, MAX_HP), hp(15, 4_000)];
    expect(
      repairRecoverableAt(events, samples, MAX_HP, 0.25, 16, 7, SHARE),
    ).toBe(2_500);
  });

  it("caps stacked windows independently, one charge capacity each", () => {
    // Two windows, 3,000 damage inside each: each pool caps at its own
    // 1,000-HP charge capacity, and the bar shows both charges' worth.
    const events = [use(10, 7), use(40, 7)];
    const samples = [
      hp(0, MAX_HP),
      hp(15, 7_000), // window 1: 1,500 by share, capped at 1,000
      hp(45, 4_000), // window 2: 1,500 by share, capped at 1,000
    ];
    expect(
      repairRecoverableAt(events, samples, MAX_HP, 0.1, 16, 7, SHARE),
    ).toBe(1_000);
    expect(
      repairRecoverableAt(events, samples, MAX_HP, 0.1, 46, 7, SHARE),
    ).toBe(2_000);
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
      repairRecoverableAt(events, samples, MAX_HP, CAPACITY, t, 7, SHARE),
    );
    expect(forward).toEqual(expected);
    // Backwards, then a shuffled probe order: every call replays the fold
    // from the samples at or before t, so the answers cannot drift.
    const backwards = [...times]
      .reverse()
      .map((t) =>
        repairRecoverableAt(events, samples, MAX_HP, CAPACITY, t, 7, SHARE),
      )
      .reverse();
    expect(backwards).toEqual(expected);
    for (const i of [3, 0, 5, 2, 1, 4]) {
      expect(
        repairRecoverableAt(events, samples, MAX_HP, CAPACITY, times[i], 7, SHARE),
      ).toBe(expected[i]);
    }
  });

  it("re-folds when the damage share changes (memo key includes it)", () => {
    const events = [use(10, 7)];
    const samples = [hp(0, MAX_HP), hp(20, 8_000)];
    expect(
      repairRecoverableAt(events, samples, MAX_HP, CAPACITY, 25, 7, 0.5),
    ).toBe(1_000);
    // Same arrays, same capacity, different share: the cached prefix must not
    // answer the stale fold.
    expect(
      repairRecoverableAt(events, samples, MAX_HP, CAPACITY, 25, 7, 0.25),
    ).toBe(500);
    expect(
      repairRecoverableAt(events, samples, MAX_HP, CAPACITY, 25, 7, 0.5),
    ).toBe(1_000);
  });

  it("is a no-op without events (feature off) and without a hull budget", () => {
    const samples = [hp(0, MAX_HP), hp(20, 5_000)];
    expect(repairRecoverableAt(undefined, samples, MAX_HP, CAPACITY, 25, 7, SHARE)).toBe(0);
    expect(repairRecoverableAt([], samples, MAX_HP, CAPACITY, 25, 7, SHARE)).toBe(0);
    // Events for OTHER hulls change nothing for this one.
    expect(
      repairRecoverableAt([use(10, 9)], samples, MAX_HP, CAPACITY, 25, 7, SHARE),
    ).toBe(0);
    // Unknown max HP / empty HP stream: no readable bar, no pool.
    expect(
      repairRecoverableAt([use(10, 7)], samples, null, CAPACITY, 25, 7, SHARE),
    ).toBe(0);
    expect(repairRecoverableAt([use(10, 7)], [], MAX_HP, CAPACITY, 25, 7, SHARE)).toBe(0);
  });

  it("defaults the capacity and the damage share to the documented flat 0.5", () => {
    expect(REPAIR_PARTY_RECOVERABLE_FRAC).toBe(0.5);
    expect(REPAIR_PARTY_DAMAGE_SHARE).toBe(0.5);
    const events = [use(10, 7)];
    const samples = [hp(0, MAX_HP), hp(20, 8_000)];
    // Both parameters default: the 0.5 capacity (5,000 HP) does not bind and
    // the 0.5 share queues 1,000 HP — 0.1 of the bar.
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

describe("repairCoefficientFor", () => {
  // The source is the COMMITTED GameParams bake
  // (scripts/extract_repair_coefficients.py): shipParamsId → the fraction of
  // max HP ONE Repair Party charge restores — the pool's CAPACITY.
  const table = repairCoefficients as Record<string, number>;
  /** Montana (shipParamsId 4277090288) — the standard premium repair charge,
   *  regenerationHPSpeed 0.0066 × workTime 28 s = 0.1848 of max HP. */
  const MONTANA = 4_277_090_288;

  it("reads the hull's baked GameParams capacity fraction", () => {
    expect(table[String(MONTANA)]).toBeCloseTo(0.1848, 10);
    expect(repairCoefficientFor(MONTANA, 30_000)).toBeCloseTo(0.1848, 10);
  });

  it("is a hull property, not a ratio of maxHp", () => {
    // The old stream cap was absolute HP and got divided by maxHp; the baked
    // table already IS the fraction, so the hull answers the same either way.
    expect(repairCoefficientFor(MONTANA, 10_000)).toBe(
      repairCoefficientFor(MONTANA, 120_000),
    );
  });

  it("answers every baked hull with its own row", () => {
    const ids = Object.keys(table);
    expect(ids.length).toBeGreaterThan(500);
    for (const id of ids) {
      expect(repairCoefficientFor(Number(id), MAX_HP)).toBeCloseTo(table[id], 10);
      // JSON object keys are strings; a string shipId joins the same row.
      expect(repairCoefficientFor(id, MAX_HP)).toBeCloseTo(table[id], 10);
      expect(table[id]).toBeGreaterThan(0);
      expect(table[id]).toBeLessThanOrEqual(1);
    }
  });

  it("falls back to the documented flat 0.5 for an unknown hull", () => {
    expect(table["1"]).toBeUndefined();
    expect(repairCoefficientFor(1, 25_000)).toBe(
      REPAIR_PARTY_RECOVERABLE_FRAC,
    );
    expect(repairCoefficientFor(null, 25_000)).toBe(0.5);
    expect(repairCoefficientFor(undefined, 25_000)).toBe(0.5);
    // Without a usable maxHp there is no bar to segment, even though the
    // fraction itself no longer needs the division.
    expect(repairCoefficientFor(MONTANA, null)).toBe(0.5);
    expect(repairCoefficientFor(MONTANA, 0)).toBe(0.5);
    expect(repairCoefficientFor(MONTANA, Number.NaN)).toBe(0.5);
  });

  it("feeds the state machine the charge CAPACITY and the flat damage SHARE", () => {
    const HULL_HP = 50_000;
    const capacity = repairCoefficientFor(MONTANA, HULL_HP);
    expect(capacity).toBeCloseTo(0.1848, 10);
    // One charge restores at most 0.1848 × 50,000 = 9,240 HP.
    expect(capacity * HULL_HP).toBeCloseTo(9_240, 6);
    const events = [use(10, 7)];
    // A 5,000-damage salvo inside the window queues 5,000 × 0.5 = 2,500 HP
    // (the SHARE), well under the 9,240-HP charge capacity.
    const salvo = [hp(0, HULL_HP), hp(20, 45_000)];
    expect(
      repairRecoverableAt(events, salvo, HULL_HP, capacity, 25, 7, SHARE),
    ).toBeCloseTo(2_500, 6);
    expect(
      repairRecoverableFracAt(events, salvo, HULL_HP, 25, 7, capacity, SHARE),
    ).toBeCloseTo(0.05, 10);
    // A 30,000-damage burst would queue 15,000 by share, but the charge only
    // restores 9,240 — the CAPACITY clamps the grey segment.
    const burst = [hp(0, HULL_HP), hp(20, 20_000)];
    expect(
      repairRecoverableAt(events, burst, HULL_HP, capacity, 25, 7, SHARE),
    ).toBeCloseTo(9_240, 6);
    expect(
      repairRecoverableFracAt(events, burst, HULL_HP, 25, 7, capacity, SHARE),
    ).toBeCloseTo(0.1848, 10);
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
