/** Tests for the date-range views:
 *  - `dateRangeCutoff` converts 1d/7d/30d to Unix-second cutoffs;
 *  - `filterByDateRange` (the career fallback) keeps ships whose last battle
 *    falls inside the window — its rows still carry career totals, which is
 *    exactly why the real range view must go through `computeRecentDelta`;
 *  - `computeRecentDelta` picks the latest baseline at or before the cutoff,
 *    subtracts per-ship totals, derives winrate/avgDamage from the deltas,
 *    keeps first-seen ships whole, drops untouched ships, clamps negative
 *    totals, and reports null when no old-enough baseline exists.
 *
 *  The scenario behind these tests: an active player touches nearly every
 *  ship in a week, so filtering by lastBattleTime and summing career totals
 *  counted the whole career as "recent 7 days". */
import { describe, expect, it } from "vitest";

import type { PlayerShipStats, ShipStatsHistoryPoint } from "@/api";
import {
  computeRecentDelta,
  dateRangeCutoff,
  filterByDateRange,
} from "./shipAggregation";

function ship(partial: Partial<PlayerShipStats> & { shipId: number }): PlayerShipStats {
  return {
    name: "",
    battles: 0,
    wins: 0,
    damageCaused: 0,
    frags: 0,
    survivedBattles: 0,
    winrate: 0,
    avgDamage: 0,
    lastBattleTime: 0,
    ...partial,
  };
}

function point(timestamp: number, ships: ShipStatsHistoryPoint["ships"]): ShipStatsHistoryPoint {
  return { timestamp, ships };
}

describe("dateRangeCutoff", () => {
  it("converts ranges to day-based Unix-second cutoffs", () => {
    const now = 1_700_000_000;
    expect(dateRangeCutoff("1d", now)).toBe(now - 86_400);
    expect(dateRangeCutoff("7d", now)).toBe(now - 7 * 86_400);
    expect(dateRangeCutoff("30d", now)).toBe(now - 30 * 86_400);
  });
});

describe("filterByDateRange (career fallback)", () => {
  it("keeps only ships whose last battle is inside the window", () => {
    const now = 1_700_000_000;
    const ships = [
      ship({ shipId: 1, battles: 4000, lastBattleTime: now - 100 }),
      ship({ shipId: 2, battles: 50, lastBattleTime: now - 10 * 86_400 }),
    ];
    // Regression guard for the reported bug: the kept row still carries its
    // 4000 career battles — callers must NOT present that sum as "7d stats".
    const kept = filterByDateRange(ships, "7d", now);
    expect(kept.map((s) => s.shipId)).toEqual([1]);
    expect(kept[0].battles).toBe(4000);
  });

  it("returns everything for all", () => {
    const ships = [ship({ shipId: 1 })];
    expect(filterByDateRange(ships, "all")).toBe(ships);
  });
});

describe("computeRecentDelta", () => {
  const now = 1_700_000_000;
  const cutoff = dateRangeCutoff("7d", now);

  it("derives real recent stats from the latest baseline at or before the cutoff", () => {
    const current = [
      ship({
        shipId: 1,
        battles: 4_100,
        wins: 2_090,
        damageCaused: 400_000_000,
        frags: 6_000,
        survivedBattles: 1_200,
        lastBattleTime: now - 100,
      }),
      // Untouched since the baseline — must drop out of the range view.
      ship({ shipId: 2, battles: 50, wins: 25, damageCaused: 1_000_000, lastBattleTime: cutoff - 5 }),
      // First seen after the baseline — whole career IS the recent delta.
      ship({ shipId: 3, battles: 12, wins: 9, damageCaused: 2_400_000, lastBattleTime: now - 50 }),
    ];
    const history = [
      point(now - 40 * 86_400, [
        { shipId: 1, battles: 4_000, wins: 2_050, damageCaused: 390_000_000, frags: 5_900, survivedBattles: 1_180, lastBattleTime: now - 40 * 86_400 },
        { shipId: 2, battles: 50, wins: 25, damageCaused: 1_000_000, frags: 40, survivedBattles: 20, lastBattleTime: cutoff - 5 },
      ]),
      // Inside the window — newer than the cutoff, so NOT the baseline.
      point(now - 3 * 86_400, [
        { shipId: 1, battles: 4_060, wins: 2_070, damageCaused: 396_000_000, frags: 5_950, survivedBattles: 1_195, lastBattleTime: now - 3 * 86_400 },
      ]),
    ];

    const delta = computeRecentDelta(current, history, cutoff);
    expect(delta).not.toBeNull();
    expect(delta!.sinceTs).toBe(now - 40 * 86_400);

    const byId = new Map(delta!.ships.map((s) => [s.shipId, s]));
    expect(byId.has(2)).toBe(false);

    const s1 = byId.get(1)!;
    expect(s1.battles).toBe(100);
    expect(s1.wins).toBe(40);
    expect(s1.damageCaused).toBe(10_000_000);
    expect(s1.frags).toBe(100);
    expect(s1.survivedBattles).toBe(20);
    expect(s1.winrate).toBeCloseTo(40.0, 5);
    expect(s1.avgDamage).toBeCloseTo(100_000, 5);
    // Display fields survive the delta rewrite.
    expect(s1.lastBattleTime).toBe(now - 100);

    const s3 = byId.get(3)!;
    expect(s3.battles).toBe(12);
    expect(s3.wins).toBe(9);
    expect(s3.winrate).toBeCloseTo(75.0, 5);
  });

  it("clamps negative totals against WG-side corrections", () => {
    const current = [ship({ shipId: 1, battles: 20, wins: 5, damageCaused: 50_000, frags: 2, survivedBattles: 1 })];
    const history = [
      point(cutoff - 1, [{ shipId: 1, battles: 10, wins: 8, damageCaused: 90_000, frags: 9, survivedBattles: 4, lastBattleTime: 0 }]),
    ];
    const delta = computeRecentDelta(current, history, cutoff)!;
    expect(delta.ships[0].battles).toBe(10);
    expect(delta.ships[0].wins).toBe(0);
    expect(delta.ships[0].damageCaused).toBe(0);
    expect(delta.ships[0].frags).toBe(0);
    expect(delta.ships[0].survivedBattles).toBe(0);
  });

  it("returns null without an old-enough baseline", () => {
    const current = [ship({ shipId: 1, battles: 10 })];
    expect(computeRecentDelta(current, [], cutoff)).toBeNull();
    // First-ever lookup: the only recorded point is the current fetch.
    expect(computeRecentDelta(current, [point(now, [])], cutoff)).toBeNull();
  });

  it("accepts a baseline recorded exactly at the cutoff", () => {
    const current = [ship({ shipId: 1, battles: 10, wins: 5, damageCaused: 100_000 })];
    const exact = point(cutoff, [
      { shipId: 1, battles: 4, wins: 2, damageCaused: 40_000, frags: 3, survivedBattles: 1, lastBattleTime: 0 },
    ]);
    const delta = computeRecentDelta(current, [exact], cutoff);
    expect(delta).not.toBeNull();
    expect(delta!.sinceTs).toBe(cutoff);
    expect(delta!.ships[0].battles).toBe(6);
  });
});
