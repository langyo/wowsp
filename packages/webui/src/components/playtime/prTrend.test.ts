/**
 * The chart geometry cases (the retired prTrendLayout describe) left with
 * the hand-drawn SVG: PrTrendChart now renders through hikari's
 * HkTrendChart (its wowsp-migration extras — the stepped 250-multiple
 * y domain, the tier guides, the axis/tick text and the clearance rule —
 * are pinned by hikari's own trendGeometry.test.ts, and the mounted
 * contract lives in PrTrendChart.test.tsx). This file keeps pinning the
 * DATA derivation: the PR formula, the interval deltas, the catalog and
 * the range window.
 */
import { describe, expect, it } from "vitest";

import type { ExpectedPrEntry, ShipStatsHistoryPoint } from "@/api";

import {
  expectedPrFromTotals,
  expectedPrMap,
  filterIntervalsByRange,
  prOfInterval,
  prTrendIntervals,
  prTrendShipCatalog,
} from "./prTrend";

function point(
  t: number,
  ships: Array<[number, number, number, number, number]>,
): ShipStatsHistoryPoint {
  // [shipId, battles, wins, damage, frags]
  return {
    timestamp: t,
    ships: ships.map(([shipId, battles, wins, damage, frags]) => ({
      shipId,
      battles,
      wins,
      damageCaused: damage,
      frags,
      survivedBattles: 0,
      lastBattleTime: 0,
    })),
  };
}

function ev(shipId: number, dmg: number, frags: number, wr: number): ExpectedPrEntry {
  return { shipId, avgDamage: dmg, avgFrags: frags, winrate: wr };
}

describe("expectedPrFromTotals", () => {
  it("lands on 1150 when playing exactly at the server average", () => {
    // All three ratios are 1 → 700 + 300 + 150.
    expect(expectedPrFromTotals(1000, 10, 50, 1000, 10, 50)).toBe(1150);
  });

  it("floors each normalized ratio at zero and clamps the result", () => {
    // Far below average: every ratio under its floor → 0.
    expect(expectedPrFromTotals(100, 0, 1, 1000, 10, 50)).toBe(0);
    // Far above average saturates long before 10000 but stays clamped there
    // for absurd inputs.
    expect(
      expectedPrFromTotals(1_000_000, 10_000, 50_000, 1000, 10, 50),
    ).toBe(10_000);
  });

  it("returns null when an expected total is unusable", () => {
    expect(expectedPrFromTotals(1, 1, 1, 0, 10, 50)).toBeNull();
    expect(expectedPrFromTotals(1, 1, 1, 100, 0, 50)).toBeNull();
    expect(expectedPrFromTotals(1, 1, 1, 100, 10, 0)).toBeNull();
  });
});

describe("prTrendIntervals", () => {
  it("derives per-ship deltas between adjacent points", () => {
    const intervals = prTrendIntervals([
      point(100, [[1, 10, 5, 100_000, 8]]),
      point(200, [[1, 13, 7, 142_000, 11]]),
    ]);
    expect(intervals).toHaveLength(2);
    // First observation: the full totals are the baseline interval.
    expect(intervals[0]).toEqual({
      t: 100,
      deltas: [{ shipId: 1, battles: 10, wins: 5, damage: 100_000, frags: 8 }],
    });
    expect(intervals[1]).toEqual({
      t: 200,
      deltas: [{ shipId: 1, battles: 3, wins: 2, damage: 42_000, frags: 3 }],
    });
  });

  it("keeps the LAST SEEN row as the baseline across holes", () => {
    // Ship 1 present at t=100, dropped at t=200 (upstream retention), back
    // at t=300: the t=300 delta must be measured against t=100's totals,
    // not resurrect the whole career.
    const intervals = prTrendIntervals([
      point(100, [[1, 10, 5, 100_000, 8]]),
      point(200, [[2, 4, 2, 20_000, 1]]),
      point(300, [[1, 12, 6, 118_000, 9]]),
    ]);
    expect(intervals[2].deltas).toEqual([
      { shipId: 1, battles: 2, wins: 1, damage: 18_000, frags: 1 },
    ]);
    // A ship with no new battles stays out of the interval.
    expect(intervals[1].deltas).toEqual([
      { shipId: 2, battles: 4, wins: 2, damage: 20_000, frags: 1 },
    ]);
  });

  it("clamps negative deltas to zero and sorts by timestamp", () => {
    // Out-of-order points and a regressing total (cache written by an older
    // build) must not produce negative intervals or reordered output.
    const intervals = prTrendIntervals([
      point(300, [[1, 9, 5, 90_000, 8]]),
      point(100, [[1, 10, 5, 100_000, 8]]),
    ]);
    expect(intervals.map((i) => i.t)).toEqual([100, 300]);
    expect(intervals[1].deltas).toEqual([]);
  });
});

describe("prOfInterval", () => {
  const table = expectedPrMap([
    ev(1, 100_000, 1.0, 50),
    ev(2, 50_000, 0.5, 52),
  ]);

  it("battle-weights the expected side across ships (not a mean of PRs)", () => {
    // Ship 1: 10 battles at exactly its averages → 1150 alone. Ship 2:
    // 30 battles at exactly its averages → 1150 alone. Together the sums
    // still balance at the average → 1150, but with different per-ship
    // damage the weighting is what keeps the result honest.
    const interval = {
      t: 200,
      deltas: [
        { shipId: 1, battles: 10, wins: 5, damage: 1_000_000, frags: 10 },
        { shipId: 2, battles: 30, wins: 15.6, damage: 1_500_000, frags: 15 },
      ],
    };
    const p = prOfInterval(interval, table, () => true);
    expect(p?.pr).toBe(1150);
    expect(p?.battles).toBe(40);
    expect(p?.winrate).toBeCloseTo((5 + 15.6) / 40 * 100, 5);
  });

  it("skips ships missing from the table on both sides", () => {
    const interval = {
      t: 200,
      deltas: [
        { shipId: 999, battles: 50, wins: 25, damage: 9_999_999, frags: 50 },
        { shipId: 1, battles: 10, wins: 5, damage: 1_000_000, frags: 10 },
      ],
    };
    const p = prOfInterval(interval, table, () => true);
    expect(p?.battles).toBe(10);
    expect(p?.pr).toBe(1150);
  });

  it("returns null when nothing rated survives the selection", () => {
    const interval = {
      t: 200,
      deltas: [{ shipId: 999, battles: 50, wins: 25, damage: 100, frags: 1 }],
    };
    expect(prOfInterval(interval, table, () => true)).toBeNull();
    const only1 = {
      t: 200,
      deltas: [{ shipId: 2, battles: 10, wins: 5, damage: 500_000, frags: 5 }],
    };
    expect(prOfInterval(only1, table, (id) => id === 1)).toBeNull();
  });

  it("aggregates the selection the filter picks (type / single ship)", () => {
    const interval = {
      t: 200,
      deltas: [
        { shipId: 1, battles: 10, wins: 5, damage: 1_000_000, frags: 10 },
        { shipId: 2, battles: 10, wins: 5.2, damage: 500_000, frags: 5 },
      ],
    };
    const ship2Only = prOfInterval(interval, table, (id) => id === 2);
    expect(ship2Only?.battles).toBe(10);
    // Exactly ship 2's averages → 1150; ship 1's battles stay out.
    expect(ship2Only?.pr).toBe(1150);
  });
});

describe("prTrendShipCatalog", () => {
  it("lists ships with played battles, most-played first (ties by id)", () => {
    const intervals = prTrendIntervals([
      point(100, [
        [1, 10, 5, 100_000, 8],
        [2, 5, 2, 50_000, 1],
        [3, 0, 0, 0, 0],
      ]),
      point(200, [[2, 8, 4, 90_000, 3]]),
    ]);
    const catalog = prTrendShipCatalog(intervals);
    expect(catalog.map((s) => s.shipId)).toEqual([1, 2]);
    expect(catalog[0].battles).toBe(10);
    expect(catalog[1].battles).toBe(8);
    // Aggregate row stats for the popup: ship 2 spans both intervals
    // (5+3 battles, 2+2 wins, 50k+40k damage — deltas, not totals).
    expect(catalog[1].wins).toBe(4);
    expect(catalog[1].damage).toBe(90_000);
    expect(catalog[0].type).toBeTruthy();
    expect(Number.isInteger(catalog[0].tier) || catalog[0].tier === null).toBe(true);
  });
});

describe("filterIntervalsByRange", () => {
  const DAY = 86_400;
  // now = day 30; points at days 1, 10, 26, 29.
  const NOW = 30 * DAY;
  function mk(ts: number[]) {
    return prTrendIntervals(ts.map((t) => point(t, [[1, 1, 1, 1000, 1]])));
  }

  it("all is the identity", () => {
    const ivs = mk([DAY, 10 * DAY, 29 * DAY]);
    expect(filterIntervalsByRange(ivs, { key: "all" }, NOW)).toBe(ivs);
  });

  it("presets keep intervals observed within N days of now (boundary inclusive)", () => {
    const ivs = mk([DAY, 10 * DAY, 26 * DAY, 29 * DAY]);
    expect(filterIntervalsByRange(ivs, { key: "7d" }, NOW).map((i) => i.t)).toEqual([
      26 * DAY,
      29 * DAY,
    ]);
    // t == exactly now − 7d sits on the inclusive boundary.
    const edge = mk([23 * DAY, 10 * DAY]);
    expect(filterIntervalsByRange(edge, { key: "7d" }, NOW).map((i) => i.t)).toEqual([23 * DAY]);
    expect(filterIntervalsByRange(ivs, { key: "30d" }, NOW)).toHaveLength(4);
  });

  it("custom keeps the inclusive window and returns empty while incomplete", () => {
    const ivs = mk([DAY, 10 * DAY, 26 * DAY]);
    const w = { key: "custom" as const, fromSec: 9 * DAY, toSec: 26 * DAY };
    expect(filterIntervalsByRange(ivs, w, NOW).map((i) => i.t)).toEqual([10 * DAY, 26 * DAY]);
    // Both bounds required — an unfinished pick answers an empty series
    // rather than an unfiltered one.
    expect(filterIntervalsByRange(ivs, { key: "custom", fromSec: 9 * DAY, toSec: null }, NOW)).toEqual([]);
  });
});
