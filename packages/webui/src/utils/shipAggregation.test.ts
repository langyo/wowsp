/** Tests for the date-range views:
 *  - `dateRangeCutoff` converts 1d/7d/30d/90d to Unix-second cutoffs;
 *  - `filterByDateRange` (the career fallback) keeps ships whose last battle
 *    falls inside the window — its rows still carry career totals, which is
 *    exactly why the real range view must go through `computeRecentDelta`;
 *  - `computeRecentDelta` picks the latest baseline at or before the cutoff,
 *    subtracts per-ship totals, derives winrate/avgDamage from the deltas,
 *    keeps first-seen ships whole, drops untouched ships, clamps negative
 *    totals, and reports null when no old-enough baseline exists. The
 *    last-battle stamp is treated as evidence: a stale one (zero — the
 *    vortex transport serves none — or predating the ship's own baseline
 *    point, i.e. carried from an older write) keeps the real after-baseline
 *    delta and re-dates the row at the window end, while the missing-baseline
 *    resurrection — old stamp with no baseline at all, or a stamp consistent
 *    with its baseline yet before the window start — still drops. A finite
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
    expect(dateRangeCutoff("90d", now)).toBe(now - 90 * 86_400);
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
    const current = [ship({ shipId: 1, battles: 20, wins: 5, damageCaused: 50_000, frags: 2, survivedBattles: 1, lastBattleTime: now - 100 })];
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
    const current = [ship({ shipId: 1, battles: 10, wins: 5, damageCaused: 100_000, lastBattleTime: now - 100 })];
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
        { shipId: 1, battles: 4_040, wins: 2_070, damageCaused: 396_000_000, frags: 5_950, survivedBattles: 1_190, lastBattleTime: now - 10 * 86_400 },
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

  it("keeps a ship played inside a past-ended window whose career continues past it", () => {
    // The guard dates a bounded-window delta by the closing snapshot's
    // career-last battle time, never the current row's — playing again
    // after `to` must not eject the ship, and must not count those later
    // battles either.
    const current = [ship({ shipId: 1, battles: 4_020, wins: 2_010, damageCaused: 400_200_000, lastBattleTime: now - 2 * 86_400 })];
    const history = [
      point(now - 40 * 86_400, [
        { shipId: 1, battles: 4_000, wins: 2_000, damageCaused: 400_000_000, frags: 6_000, survivedBattles: 1_200, lastBattleTime: now - 40 * 86_400 },
      ]),
      point(now - 10 * 86_400, [
        { shipId: 1, battles: 4_010, wins: 2_005, damageCaused: 400_100_000, frags: 6_010, survivedBattles: 1_205, lastBattleTime: now - 12 * 86_400 },
      ]),
    ];
    const delta = computeRecentDelta(current, history, now - 15 * 86_400, now - 10 * 86_400)!;
    expect(delta.ships[0].battles).toBe(10);
    expect(delta.ships[0].lastBattleTime).toBe(now - 2 * 86_400);
  });

  it("drops a bounded-window ship whose closing snapshot predates the window", () => {
    // The bounded-window leak: the baseline at or before `from` lacks the
    // ship (truncated fetch), so the diff resurrects everything up to the
    // closing snapshot — all fought before `from`. Dating by the closing
    // snapshot's career-last time (not the current row's, which kept
    // advancing after `to`) is what drops it.
    const current = [ship({ shipId: 1, battles: 50, wins: 25, damageCaused: 1_000_000, lastBattleTime: now - 2 * 86_400 })];
    const history = [
      point(now - 15 * 86_400, []),
      point(now - 10 * 86_400, [
        { shipId: 1, battles: 49, wins: 24, damageCaused: 980_000, frags: 40, survivedBattles: 20, lastBattleTime: now - 20 * 86_400 },
      ]),
    ];
    const delta = computeRecentDelta(current, history, now - 15 * 86_400, now - 10 * 86_400)!;
    expect(delta.ships).toHaveLength(0);
  });

  it("drops ships absent from the end snapshot (unplayed at the window's close)", () => {
    const current = [ship({ shipId: 1, battles: 100, wins: 50, damageCaused: 1_000_000, lastBattleTime: now - 100 })];
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
    const current = [ship({ shipId: 1, battles: 4_100, wins: 2_090, damageCaused: 400_000_000, lastBattleTime: now - 100 })];
    const history = [
      point(now - 40 * 86_400, [
        { shipId: 1, battles: 4_000, wins: 2_050, damageCaused: 390_000_000, frags: 5_900, survivedBattles: 1_180, lastBattleTime: 0 },
      ]),
      point(now - 86_400, [
        { shipId: 1, battles: 4_080, wins: 2_084, damageCaused: 398_000_000, frags: 5_970, survivedBattles: 1_196, lastBattleTime: now - 86_400 },
      ]),
    ];
    const delta = computeRecentDelta(current, history, cutoff, now + 86_400)!;
    expect(delta.endTs).toBe(now - 86_400);
    expect(delta.ships[0].battles).toBe(80);
    expect(delta.ships[0].wins).toBe(34);
  });

  it("drops ships whose battles all predate the labeled window start", () => {
    // A truncated latest point (the ship's row is missing from it) keeps the
    // ship's baseline on a much older point; the diff then resurrects a
    // battle fought between the two as a "recent" delta. The career-last
    // battle time proves nothing was played inside the labeled window, so
    // the ship must drop out. Reported symptom: a ship last played
    // 2026/10/7 (and one last played 2023) turning up under the 1d tab.
    const sincePoint = cutoff - 3600;
    const current = [
      ship({
        shipId: 1,
        battles: 4_100,
        wins: 2_090,
        damageCaused: 400_000_000,
        lastBattleTime: now - 12 * 86_400,
      }),
      ship({ shipId: 2, battles: 12, wins: 6, damageCaused: 240_000, lastBattleTime: now - 100 }),
      // Boundary: a battle fought exactly at sinceTs is inside the window.
      ship({ shipId: 3, battles: 6, wins: 3, damageCaused: 120_000, lastBattleTime: sincePoint }),
    ];
    const history = [
      point(now - 40 * 86_400, [
        { shipId: 1, battles: 4_099, wins: 2_089, damageCaused: 399_900_000, frags: 5_999, survivedBattles: 1_199, lastBattleTime: now - 12 * 86_400 },
      ]),
      // Latest point at or before the cutoff — ship 1's row is missing.
      point(sincePoint, [
        { shipId: 2, battles: 10, wins: 5, damageCaused: 200_000, frags: 4, survivedBattles: 2, lastBattleTime: now - 100 },
        { shipId: 3, battles: 5, wins: 2, damageCaused: 100_000, frags: 3, survivedBattles: 1, lastBattleTime: sincePoint },
      ]),
    ];
    const delta = computeRecentDelta(current, history, cutoff)!;
    expect(delta.sinceTs).toBe(sincePoint);
    const ids = delta.ships.map((s) => s.shipId);
    expect(ids).not.toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
    expect(delta.ships.find((s) => s.shipId === 2)!.battles).toBe(2);
    expect(delta.ships.find((s) => s.shipId === 3)!.battles).toBe(1);
  });

  it("keeps a re-played ship whose zero stamp cannot date it", () => {
    // The vortex per-ship transport serves no lastBattleTime (0), and the
    // disk-cache carry-forward can only copy an older write. A ship re-played
    // since the baseline still arrives with a zero stamp, so the positive
    // delta decides: keep the row and re-date it at the window end so the
    // views' date column does not show the epoch.
    const current = [ship({ shipId: 1, battles: 30, wins: 15, damageCaused: 600_000 })];
    const history = [
      point(cutoff - 1, [
        { shipId: 1, battles: 10, wins: 5, damageCaused: 200_000, frags: 4, survivedBattles: 2, lastBattleTime: 0 },
      ]),
    ];
    const delta = computeRecentDelta(current, history, cutoff)!;
    expect(delta.ships).toHaveLength(1);
    expect(delta.ships[0].battles).toBe(20);
    expect(delta.ships[0].lastBattleTime).toBe(delta.endTs);
  });

  it("includes a never-stamped ship with no baseline as first played in the window", () => {
    // The reported fresh-ship bug: Lightning/Jervis/Admiral Scheer were played
    // after the baseline, are absent from it, and carry lastBattleTime 0 — the
    // old guard dropped them from the 1d/7d tabs entirely ("0 艘 · 0 场").
    const current = [
      ship({ shipId: 1, battles: 3, wins: 0, damageCaused: 29_301 }),
      ship({ shipId: 2, battles: 2, wins: 1, damageCaused: 10_865 }),
    ];
    const history = [
      // A baseline point exists for the window label, but never saw ships 1/2.
      point(cutoff - 86_400, [
        { shipId: 3, battles: 10, wins: 5, damageCaused: 200_000, frags: 4, survivedBattles: 2, lastBattleTime: 0 },
      ]),
    ];
    const delta = computeRecentDelta(current, history, cutoff)!;
    expect(delta.sinceTs).toBe(cutoff - 86_400);
    const byId = new Map(delta.ships.map((s) => [s.shipId, s]));
    expect(byId.get(1)!.battles).toBe(3);
    expect(byId.get(2)!.battles).toBe(2);
    // Dated at the window end — a new ship was played inside this window.
    expect(byId.get(1)!.lastBattleTime).toBe(delta.endTs);
    expect(byId.get(2)!.lastBattleTime).toBe(delta.endTs);
  });

  it("keeps a re-played ship whose stale carried stamp predates its baseline", () => {
    // Carry-forward copies the previous write's stamp, so a ship re-played
    // after a gap can keep a stamp from BEFORE the baseline it is diffed
    // against. That stamp cannot account for the delta — the battles are real
    // window battles, the stamp is the artifact.
    const staleStamp = now - 60 * 86_400;
    const current = [
      ship({ shipId: 1, battles: 120, wins: 60, damageCaused: 12_000_000, lastBattleTime: staleStamp }),
    ];
    const history = [
      point(now - 40 * 86_400, [
        { shipId: 1, battles: 100, wins: 50, damageCaused: 10_000_000, frags: 100, survivedBattles: 20, lastBattleTime: staleStamp },
      ]),
    ];
    const delta = computeRecentDelta(current, history, cutoff)!;
    expect(delta.ships[0].battles).toBe(20);
    expect(delta.ships[0].damageCaused).toBe(2_000_000);
    expect(delta.ships[0].lastBattleTime).toBe(delta.endTs);
  });

  it("dates a stale-stamp ship at the closing snapshot in a bounded window", () => {
    // Same rescue in a custom [from, to] window: the date must be the window's
    // close (endTs), never "now", and the delta must close at the snapshot.
    const current = [ship({ shipId: 1, battles: 10, wins: 5, damageCaused: 100_000 })];
    const history = [
      point(now - 15 * 86_400, []),
      point(now - 10 * 86_400, [
        { shipId: 1, battles: 10, wins: 5, damageCaused: 100_000, frags: 4, survivedBattles: 2, lastBattleTime: 0 },
      ]),
    ];
    const delta = computeRecentDelta(current, history, now - 15 * 86_400, now - 10 * 86_400)!;
    expect(delta.endTs).toBe(now - 10 * 86_400);
    expect(delta.ships[0].battles).toBe(10);
    expect(delta.ships[0].lastBattleTime).toBe(now - 10 * 86_400);
  });

  it("drops an old-stamp ship with no baseline (poisoned-baseline artifact)", () => {
    // No healthy baseline row exists (its only recorded row is poisoned), so
    // the real stamp is the only evidence: last battle long before the window
    // means the resurrected full-career delta is an artifact. (Phra Ruang in
    // the reported cache: 1 career battle from 2023, no baseline row.)
    const current = [
      ship({ shipId: 5, battles: 55, wins: 30, damageCaused: 1_100_000, lastBattleTime: now - 1_000 * 86_400 }),
    ];
    const history = [
      point(cutoff - 1, [
        { shipId: 5, battles: 50, wins: 27, damageCaused: 0, frags: 0, survivedBattles: 25, lastBattleTime: now - 1_000 * 86_400 },
      ]),
    ];
    const delta = computeRecentDelta(current, history, cutoff)!;
    expect(delta.ships).toHaveLength(0);
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
    lastBattleTime: now - 100,
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

  it("includes a first-seen ship with no stamp as played in the window", () => {
    // Single-ship counterpart of the fresh-ship bug: no baseline row for the
    // ship (it was absent from the baseline fetch) and a zero stamp — the
    // whole career is the recent delta, labeled from the baseline point.
    const fresh = ship({ shipId: 9, battles: 12, wins: 9, damageCaused: 2_400_000, lastBattleTime: 0 });
    const history = [
      point(now - 40 * 86_400, [
        { shipId: 7, battles: 300, wins: 160, damageCaused: 20_400_000, frags: 380, survivedBattles: 110, lastBattleTime: 0 },
      ]),
    ];
    const d = shipRecentDelta(fresh, history, cutoff)!;
    expect(d.battles).toBe(12);
    expect(d.wins).toBe(9);
    expect(d.avgDamage).toBeCloseTo(200_000, 5);
    expect(d.sinceTs).toBe(now - 40 * 86_400);
  });

  it("includes a re-played ship whose stale carried stamp predates its baseline", () => {
    // Carry-forward cannot advance the stamp, so it can predate the very
    // baseline row it is diffed against — the delta is real, the stamp is not.
    const staleStamp = now - 60 * 86_400;
    const replayed = ship({
      shipId: 7,
      battles: 320,
      wins: 176,
      damageCaused: 21_824_000,
      frags: 412,
      survivedBattles: 120,
      lastBattleTime: staleStamp,
    });
    const history = [
      point(now - 40 * 86_400, [
        { shipId: 7, battles: 300, wins: 160, damageCaused: 20_400_000, frags: 380, survivedBattles: 110, lastBattleTime: staleStamp },
      ]),
    ];
    const d = shipRecentDelta(replayed, history, cutoff)!;
    expect(d.battles).toBe(20);
    expect(d.sinceTs).toBe(now - 40 * 86_400);
  });

  it("returns null for an old-stamp ship with no baseline row", () => {
    // The resurrected full career is dated before the window and the ship has
    // no healthy baseline row to prove otherwise — keep it out.
    const stale = ship({ shipId: 7, battles: 5, wins: 2, damageCaused: 100_000, lastBattleTime: now - 1_000 * 86_400 });
    const history = [
      point(now - 40 * 86_400, [
        { shipId: 8, battles: 10, wins: 5, damageCaused: 200_000, frags: 4, survivedBattles: 2, lastBattleTime: 0 },
      ]),
    ];
    expect(shipRecentDelta(stale, history, cutoff)).toBeNull();
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
    const current = [ship({ shipId: 1, battles: 200, wins: 100, damageCaused: 4_200_000, frags: 32, survivedBattles: 62, lastBattleTime: now - 100 })];
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
    const current = [ship({ shipId: 2, battles: 55, wins: 30, damageCaused: 1_100_000, frags: 70, lastBattleTime: now - 100 })];
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

  it("drops a poisoned-only ship whose career ends before the window (no resurrection)", () => {
    // The reported 1d-tab symptom: a ship played once in 2023 with a
    // zero-counter career row (damage AND kills 0) never enters a baseline
    // — the poisoned-row skip — so the diff resurrects its whole career as
    // a "recent" delta, complete with a "data anomaly" damage cell. Its
    // lastBattleTime proves the ship was not played in the window.
    const current = [
      ship({
        shipId: 9,
        battles: 1,
        wins: 0,
        damageCaused: 0,
        frags: 0,
        survivedBattles: 0,
        lastBattleTime: now - 1_000 * 86_400,
      }),
    ];
    const history = [
      point(cutoff - 1, [
        // Poisoned — never becomes a baseline row.
        { shipId: 9, battles: 1, wins: 0, damageCaused: 0, frags: 0, survivedBattles: 0, lastBattleTime: now - 1_000 * 86_400 },
      ]),
    ];
    const delta = computeRecentDelta(current, history, cutoff)!;
    expect(delta.ships).toHaveLength(0);
  });

  it("shipRecentDelta uses the latest healthy row and labels the window from it", () => {
    const current = ship({ shipId: 7, battles: 320, wins: 176, damageCaused: 21_824_000, frags: 412, survivedBattles: 120, lastBattleTime: now - 100 });
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
    const current = ship({ shipId: 7, battles: 320, wins: 176, damageCaused: 21_824_000, frags: 412, survivedBattles: 120, lastBattleTime: now - 100 });
    const history = [
      point(now - 10 * 86_400, [
        { shipId: 7, battles: 315, wins: 172, damageCaused: 0, frags: 0, survivedBattles: 116, lastBattleTime: 0 },
      ]),
    ];
    const d = shipRecentDelta(current, history, cutoff)!;
    expect(d.battles).toBe(320);
    expect(d.sinceTs).toBe(now - 10 * 86_400);
  });

  it("shipRecentDelta returns null when the resurrected career predates the window", () => {
    // Same artifact as the account-level view's poisoned-only drop: the
    // zero-counter history row never becomes a baseline, so the diff yields
    // the full career — but the ship was last played long before the window.
    const stale = ship({
      shipId: 7,
      battles: 1,
      wins: 0,
      damageCaused: 0,
      frags: 0,
      survivedBattles: 0,
      lastBattleTime: now - 1_000 * 86_400,
    });
    const history = [
      point(now - 10 * 86_400, [
        { shipId: 7, battles: 1, wins: 0, damageCaused: 0, frags: 0, survivedBattles: 0, lastBattleTime: now - 1_000 * 86_400 },
      ]),
    ];
    expect(shipRecentDelta(stale, history, cutoff)).toBeNull();
  });
});
