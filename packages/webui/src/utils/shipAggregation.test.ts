/** Tests for the date-range views:
 *  - `dateRangeCutoff` converts 1d/7d/30d to Unix-second cutoffs;
 *  - `filterByDateRange` (the career fallback) keeps ships whose last battle
 *    falls inside the window — its rows still carry career totals, which is
 *    exactly why the real range view must go through `computeRecentDelta`;
 *  - `computeRecentDelta` picks the latest baseline at or before the cutoff,
 *    subtracts per-ship totals, derives winrate/avgDamage from the deltas,
 *    keeps first-seen ships whole, drops untouched ships, clamps negative
 *    totals, and reports null when no old-enough baseline exists. A finite
 *    `endSec` bounds the window the same way — the latest snapshot at or
 *    before it closes the window, so a past end day never leaks newer
 *    battles in;
 *  - `isoDayWindowSec` turns a picker ISO date pair into local-day Unix
 *    seconds; `filterByDateWindow` is that window's career fallback.
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
  filterByDateWindow,
  isPoisonedCareerRow,
  isoDayWindowSec,
  shipRecentDelta,
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

  it("closes a finite window at the latest snapshot at or before the end bound", () => {
    // The user's `to` day lies in the past: battles fought AFTER it must not
    // leak into the window, so the end reference is the snapshot, not the
    // current rows. Window = [15 days ago, 10 days ago]; snapshots exist at
    // 40 days and 10 days.
    const current = [ship({ shipId: 1, battles: 4_100, wins: 2_090, damageCaused: 400_000_000, lastBattleTime: now - 100 })];
    const history = [
      point(now - 40 * 86_400, [
        { shipId: 1, battles: 4_000, wins: 2_050, damageCaused: 390_000_000, frags: 5_900, survivedBattles: 1_180, lastBattleTime: 0 },
      ]),
      point(now - 10 * 86_400, [
        { shipId: 1, battles: 4_040, wins: 2_070, damageCaused: 396_000_000, frags: 5_950, survivedBattles: 1_190, lastBattleTime: 0 },
      ]),
    ];
    const delta = computeRecentDelta(current, history, now - 15 * 86_400, now - 10 * 86_400)!;
    expect(delta.sinceTs).toBe(now - 40 * 86_400);
    expect(delta.endTs).toBe(now - 10 * 86_400);
    // 4_040 (end snapshot) - 4_000 (baseline) — NOT 4_100 - 4_000.
    expect(delta.ships[0].battles).toBe(40);
    expect(delta.ships[0].wins).toBe(20);
    expect(delta.ships[0].damageCaused).toBe(6_000_000);
  });

  it("drops ships absent from the end snapshot (unplayed at the window's close)", () => {
    const current = [ship({ shipId: 1, battles: 100, wins: 50, damageCaused: 1_000_000 })];
    const history = [
      point(now - 40 * 86_400, [
        { shipId: 1, battles: 80, wins: 40, damageCaused: 800_000, frags: 10, survivedBattles: 5, lastBattleTime: 0 },
        { shipId: 2, battles: 1, wins: 1, damageCaused: 50_000, frags: 1, survivedBattles: 1, lastBattleTime: 0 },
      ]),
      // Ship 1 is missing here — its window delta would be ≤ 0.
      point(now - 10 * 86_400, [
        { shipId: 2, battles: 2, wins: 1, damageCaused: 60_000, frags: 1, survivedBattles: 1, lastBattleTime: 0 },
      ]),
    ];
    const delta = computeRecentDelta(current, history, cutoff, now - 10 * 86_400)!;
    expect(delta.ships).toHaveLength(0);
  });

  it("closes at the newest snapshot when the end bound reaches past it", () => {
    // `to` = today: the fetch that produced the current rows is itself the
    // newest snapshot ≤ the bound, so the window closes there — effectively
    // the current totals, never older.
    const current = [ship({ shipId: 1, battles: 4_100, wins: 2_090, damageCaused: 400_000_000 })];
    const history = [
      point(now - 40 * 86_400, [
        { shipId: 1, battles: 4_000, wins: 2_050, damageCaused: 390_000_000, frags: 5_900, survivedBattles: 1_180, lastBattleTime: 0 },
      ]),
      point(now - 86_400, [
        { shipId: 1, battles: 4_080, wins: 2_084, damageCaused: 398_000_000, frags: 5_970, survivedBattles: 1_196, lastBattleTime: 0 },
      ]),
    ];
    const delta = computeRecentDelta(current, history, cutoff, now + 86_400)!;
    expect(delta.endTs).toBe(now - 86_400);
    expect(delta.ships[0].battles).toBe(80);
    expect(delta.ships[0].wins).toBe(34);
  });
});

describe("isoDayWindowSec (custom range days)", () => {
  it("converts an ISO date pair to local-day Unix seconds", () => {
    const w = isoDayWindowSec("2026-10-01", "2026-10-07")!;
    const midnight = (iso: string) => {
      const [y, m, d] = iso.split("-").map(Number);
      return Math.floor(new Date(y, m - 1, d).getTime() / 1000);
    };
    expect(w.fromSec).toBe(midnight("2026-10-01"));
    // The to bound is one second before the following day's midnight (not a
    // flat +86399 — DST transitions can make a local day 23 or 25 hours).
    expect(w.toSec).toBe(midnight("2026-10-08") - 1);
  });

  it("rejects malformed input and inverted pairs", () => {
    expect(isoDayWindowSec("2026-10-07", "2026-10-01")).toBeNull();
    expect(isoDayWindowSec("garbage", "2026-10-01")).toBeNull();
    expect(isoDayWindowSec("2026-10-01", "")).toBeNull();
    // Rollover dates normalize to the next month — not real calendar days.
    expect(isoDayWindowSec("2026-02-31", "2026-03-05")).toBeNull();
  });
});

describe("filterByDateWindow (career fallback)", () => {
  it("keeps only ships whose last battle is inside the custom window", () => {
    const now = 1_700_000_000;
    const ships = [
      ship({ shipId: 1, battles: 4_000, lastBattleTime: now - 2 * 86_400 }),
      ship({ shipId: 2, battles: 50, lastBattleTime: now - 30 * 86_400 }),
      ship({ shipId: 3, battles: 10, lastBattleTime: now }),
    ];
    const from = now - 10 * 86_400;
    const to = now - 86_400;
    const kept = filterByDateWindow(ships, from, to);
    expect(kept.map((s) => s.shipId)).toEqual([1]);
    // Same contract as filterByDateRange: the row keeps its career totals.
    expect(kept[0].battles).toBe(4_000);
  });
});

describe("shipRecentDelta (single-ship slice)", () => {
  const now = 1_700_000_000;
  const cutoff = dateRangeCutoff("7d", now);

  const current = ship({
    shipId: 7,
    battles: 320,
    wins: 176,
    damageCaused: 21_824_000,
    frags: 412,
    survivedBattles: 120,
  });

  it("subtracts the ship's totals at the latest baseline at or before the cutoff", () => {
    const history = [
      point(now - 40 * 86_400, [
        { shipId: 7, battles: 300, wins: 160, damageCaused: 20_400_000, frags: 380, survivedBattles: 110, lastBattleTime: 0 },
      ]),
      // Newer than the cutoff — must not be picked as the baseline.
      point(now - 1 * 86_400, [
        { shipId: 7, battles: 315, wins: 172, damageCaused: 21_400_000, frags: 402, survivedBattles: 116, lastBattleTime: 0 },
      ]),
    ];
    const d = shipRecentDelta(current, history, cutoff)!;
    expect(d.battles).toBe(20);
    expect(d.wins).toBe(16);
    expect(d.frags).toBe(32);
    expect(d.winrate).toBeCloseTo(80.0, 5);
    expect(d.avgDamage).toBeCloseTo(71_200, 5);
    expect(d.avgFrags).toBeCloseTo(1.6, 5);
    expect(d.sinceTs).toBe(now - 40 * 86_400);
  });

  it("treats a baseline lacking the ship as a full-career window", () => {
    const history = [point(now - 40 * 86_400, [])];
    const d = shipRecentDelta(current, history, cutoff)!;
    expect(d.battles).toBe(320);
    expect(d.sinceTs).toBe(now - 40 * 86_400);
  });

  it("returns null with no baseline or when the ship was unplayed in the window", () => {
    expect(shipRecentDelta(current, [], cutoff)).toBeNull();
    const history = [
      point(now - 40 * 86_400, [
        { shipId: 7, battles: 320, wins: 176, damageCaused: 21_824_000, frags: 412, survivedBattles: 120, lastBattleTime: 0 },
      ]),
    ];
    expect(shipRecentDelta(current, history, cutoff)).toBeNull();
  });
});

describe("poisoned baseline rows (zero-counter career totals)", () => {
  const now = 1_700_000_000;
  const cutoff = dateRangeCutoff("7d", now);

  // The 2026-09 CN vortex regression recorded history rows whose battles
  // carried career totals while damage/frags came back as 0. Diffing against
  // such a row resurrects the whole career total: the reported symptom was a
  // 2-battle Thunderer showing 10.6M "avg" damage — its career total ÷ 2.

  it("flags only rows with battles but zero damage and zero frags", () => {
    expect(
      isPoisonedCareerRow({ shipId: 1, battles: 198, wins: 99, damageCaused: 0, frags: 0, survivedBattles: 40, lastBattleTime: 0 }),
    ).toBe(true);
    // Odd but partially-present counters are trusted.
    expect(
      isPoisonedCareerRow({ shipId: 1, battles: 5, wins: 2, damageCaused: 0, frags: 3, survivedBattles: 1, lastBattleTime: 0 }),
    ).toBe(false);
    expect(
      isPoisonedCareerRow({ shipId: 1, battles: 0, wins: 0, damageCaused: 0, frags: 0, survivedBattles: 0, lastBattleTime: 0 }),
    ).toBe(false);
  });

  it("computeRecentDelta falls back to the latest healthy earlier row", () => {
    const current = [ship({ shipId: 1, battles: 200, wins: 100, damageCaused: 4_200_000, frags: 32, survivedBattles: 62 })];
    const history = [
      point(now - 40 * 86_400, [
        { shipId: 1, battles: 190, wins: 95, damageCaused: 4_000_000, frags: 30, survivedBattles: 60, lastBattleTime: 0 },
      ]),
      // Latest point at or before the cutoff, but poisoned — must not
      // become the baseline, and must not displace the healthy row above.
      point(now - 10 * 86_400, [
        { shipId: 1, battles: 198, wins: 99, damageCaused: 0, frags: 0, survivedBattles: 61, lastBattleTime: 0 },
      ]),
    ];
    const delta = computeRecentDelta(current, history, cutoff)!;
    expect(delta.ships[0].battles).toBe(10);
    expect(delta.ships[0].damageCaused).toBe(200_000);
    expect(delta.ships[0].avgDamage).toBeCloseTo(20_000, 5);
    // The view-wide label stays on the latest point at or before the cutoff.
    expect(delta.sinceTs).toBe(now - 10 * 86_400);
  });

  it("treats a ship recorded only as poisoned rows as first-seen (career delta)", () => {
    const current = [ship({ shipId: 2, battles: 55, wins: 30, damageCaused: 1_100_000, frags: 70 })];
    const history = [
      point(cutoff - 1, [
        { shipId: 2, battles: 50, wins: 27, damageCaused: 0, frags: 0, survivedBattles: 25, lastBattleTime: 0 },
      ]),
    ];
    const delta = computeRecentDelta(current, history, cutoff)!;
    expect(delta.ships[0].battles).toBe(55);
    expect(delta.ships[0].damageCaused).toBe(1_100_000);
    expect(delta.ships[0].avgDamage).toBeCloseTo(20_000, 5);
  });

  it("shipRecentDelta uses the latest healthy row and labels the window from it", () => {
    const current = ship({ shipId: 7, battles: 320, wins: 176, damageCaused: 21_824_000, frags: 412, survivedBattles: 120 });
    const history = [
      point(now - 40 * 86_400, [
        { shipId: 7, battles: 300, wins: 160, damageCaused: 20_400_000, frags: 380, survivedBattles: 110, lastBattleTime: 0 },
      ]),
      point(now - 10 * 86_400, [
        { shipId: 7, battles: 315, wins: 172, damageCaused: 0, frags: 0, survivedBattles: 116, lastBattleTime: 0 },
      ]),
    ];
    const d = shipRecentDelta(current, history, cutoff)!;
    expect(d.battles).toBe(20);
    expect(d.avgDamage).toBeCloseTo(71_200, 5);
    expect(d.sinceTs).toBe(now - 40 * 86_400);
  });

  it("shipRecentDelta treats an all-poisoned history as a full-career window", () => {
    const current = ship({ shipId: 7, battles: 320, wins: 176, damageCaused: 21_824_000, frags: 412, survivedBattles: 120 });
    const history = [
      point(now - 10 * 86_400, [
        { shipId: 7, battles: 315, wins: 172, damageCaused: 0, frags: 0, survivedBattles: 116, lastBattleTime: 0 },
      ]),
    ];
    const d = shipRecentDelta(current, history, cutoff)!;
    expect(d.battles).toBe(320);
    expect(d.sinceTs).toBe(now - 10 * 86_400);
  });
});
