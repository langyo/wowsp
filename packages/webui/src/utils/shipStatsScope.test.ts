/** Ship-scoped roster views — the aggregation behind the stats source's
 *  ship / solo dimensions: scope filtering (ship / class / tier / all),
 *  battle-bucket selection off the per-ship payloads, the WR→PR anchor
 *  port (pinned to the backend's own test values), and the account-career
 *  fallback while no ship-scoped dimension is on. */
import { describe, expect, it } from "vitest";

import type { PlayerShipStats } from "@/api";
import type { ShipMetaResolver } from "@/utils/shipStatsScope";
import {
  aggregateShipScopeStats,
  prProxyFromWinrate,
  scopedRosterView,
} from "@/utils/shipStatsScope";
import { EMPTY_ROSTER_VIEW, type RosterStatsDims } from "@/utils/statView";

/** 418430930 = destroyer "Yamagiri" stand-in; ids only need to be stable
 *  for the injected resolver below (tests never touch the offline DB). */
const ship = (over: Partial<PlayerShipStats>): PlayerShipStats =>
  ({
    shipId: 0,
    name: "",
    battles: 0,
    wins: 0,
    damageCaused: 0,
    frags: 0,
    survivedBattles: 0,
    winrate: 0,
    avgDamage: 0,
    lastBattleTime: 0,
    ...over,
  }) as PlayerShipStats;

const mode = (battles: number, wins: number, damage: number) => ({
  battles,
  wins,
  damageCaused: damage,
  frags: 0,
  survivedBattles: 0,
  winrate: (wins / battles) * 100,
  avgDamage: damage / battles,
});

/** Two destroyers (one tier X, one tier VIII) and one battleship. */
const SHIPS: PlayerShipStats[] = [
  ship({
    shipId: 1,
    battles: 100,
    wins: 55,
    damageCaused: 100_000,
    // 60 solo battles at 50% + 40 div2 battles at 62.5%.
    modes: { solo: mode(60, 30, 54_000), div2: mode(40, 25, 46_000), div3: null, coop: null, ranked: mode(20, 12, 22_000) },
  }),
  ship({
    shipId: 2,
    battles: 50,
    wins: 20,
    damageCaused: 40_000,
    modes: { solo: null, div2: null, div3: null, coop: null, ranked: null },
  }),
  ship({
    shipId: 3,
    battles: 200,
    wins: 100,
    damageCaused: 400_000,
    modes: { solo: mode(200, 100, 400_000), div2: null, div3: null, coop: null, ranked: mode(10, 5, 25_000) },
  }),
];

/** type 1 = destroyer, 2 = battleship; ids 1/2 are tier X, 3 is tier VIII. */
const resolver: ShipMetaResolver = (shipId) => {
  if (shipId === 1) return { type: "Destroyer", tier: 10 };
  if (shipId === 2) return { type: "Destroyer", tier: 8 };
  if (shipId === 3) return { type: "Battleship", tier: 8 };
  return null;
};

const q = (over: Partial<Parameters<typeof aggregateShipScopeStats>[2]> = {}) => ({
  scope: "ship" as const,
  battle: "random" as const,
  solo: false,
  prAlgo: "winrate" as const,
  ...over,
});

describe("prProxyFromWinrate", () => {
  it("pins the backend rating_from_winrate anchors", () => {
    // The same values commands/wg_api.rs's own test asserts — the port
    // must never drift from the backend scale.
    expect(prProxyFromWinrate(30)).toBe(0);
    expect(prProxyFromWinrate(47)).toBe(750);
    expect(prProxyFromWinrate(52)).toBe(1350);
    expect(prProxyFromWinrate(56)).toBe(1750);
    expect(prProxyFromWinrate(60)).toBe(2100);
    expect(prProxyFromWinrate(65)).toBe(2450);
  });

  it("clamps below the first anchor and extrapolates above the last", () => {
    expect(prProxyFromWinrate(0)).toBe(0);
    // Above 65: continue along the 60→65 segment (70 PR per 1%).
    expect(prProxyFromWinrate(70)).toBe(2800);
    // Between anchors is piecewise-linear (47→52 climbs 600 over 5).
    expect(prProxyFromWinrate(50)).toBe(1110);
  });
});

describe("aggregateShipScopeStats", () => {
  it("the exact-ship scope reads that ship's randoms career", () => {
    const view = aggregateShipScopeStats(SHIPS, 1, q(), resolver);
    expect(view).not.toBeNull();
    expect(view!.battles).toBe(100);
    expect(view!.winrate).toBeCloseTo(55, 6);
    expect(view!.avgDamage).toBeCloseTo(1000, 6);
    expect(view!.pr).toBe(prProxyFromWinrate(55));
  });

  it("the class scope merges every ship of the row's current-ship class", () => {
    const view = aggregateShipScopeStats(SHIPS, 1, q({ scope: "class" }), resolver);
    expect(view).not.toBeNull();
    // Ship 1 + ship 2 (both destroyers): 150 battles, 75 wins, 140k damage.
    expect(view!.battles).toBe(150);
    expect(view!.winrate).toBeCloseTo(50, 5);
    expect(view!.avgDamage).toBeCloseTo(140_000 / 150, 5);
  });

  it("the tier scope merges every ship of the row's current-ship tier", () => {
    // Row ship 3 is a tier VIII battleship: ships 2 and 3 share the tier.
    const view = aggregateShipScopeStats(SHIPS, 3, q({ scope: "tier" }), resolver);
    expect(view!.battles).toBe(250);
    expect(view!.winrate).toBeCloseTo(48, 5);
  });

  it("the all scope sweeps the whole list (solo-only configuration)", () => {
    const view = aggregateShipScopeStats(SHIPS, null, q({ scope: "all" }), resolver);
    expect(view!.battles).toBe(350);
  });

  it("an unknown row ship cannot resolve class/tier and answers null", () => {
    expect(
      aggregateShipScopeStats(SHIPS, 99, q({ scope: "class" }), resolver),
    ).toBeNull();
    expect(aggregateShipScopeStats(SHIPS, null, q({ scope: "ship" }), resolver)).toBeNull();
  });

  it("zero battles in scope answers the all-null view (the dash face)", () => {
    const none = [ship({ shipId: 7, battles: 0 })];
    expect(aggregateShipScopeStats(none, 7, q(), resolver)).toEqual(EMPTY_ROSTER_VIEW);
  });

  it("the solo filter reads the randoms solo split", () => {
    const view = aggregateShipScopeStats(SHIPS, 1, q({ solo: true }), resolver);
    expect(view!.battles).toBe(60);
    expect(view!.winrate).toBeCloseTo(50, 5);
    expect(view!.avgDamage).toBeCloseTo(54_000 / 60, 5);
  });

  it("the ranked bucket reads the per-ship ranked split", () => {
    const view = aggregateShipScopeStats(SHIPS, 1, q({ battle: "ranked" }), resolver);
    expect(view!.battles).toBe(20);
    expect(view!.winrate).toBeCloseTo(60, 5);
    expect(view!.avgDamage).toBeCloseTo(22_000 / 20, 5);
  });

  it("the merged bucket sums randoms and ranked", () => {
    const view = aggregateShipScopeStats(SHIPS, 1, q({ battle: "all" }), resolver);
    expect(view!.battles).toBe(120);
    expect(view!.winrate).toBeCloseTo((55 + 12) / 1.2, 5);
  });

  it("expected PR aggregates as the battles-weighted mean of per-row PRs (randoms only)", () => {
    const rows = [
      ship({ shipId: 1, battles: 100, wins: 50, damageCaused: 0, pr: 1000 }),
      ship({ shipId: 2, battles: 300, wins: 150, damageCaused: 0, pr: 2000 }),
    ];
    const view = aggregateShipScopeStats(
      rows,
      1,
      q({ scope: "all", prAlgo: "expected" }),
      resolver,
    );
    expect(view!.pr).toBe((1000 * 100 + 2000 * 300) / 400);
    // No expected form exists for the solo split — PR stays null, not a
    // made-up number.
    const soloView = aggregateShipScopeStats(
      rows,
      1,
      q({ scope: "all", solo: true, prAlgo: "expected" }),
      resolver,
    );
    expect(soloView!.pr).toBeNull();
  });
});

describe("scopedRosterView", () => {
  const CAREER = {
    winrate: 52.5,
    pr: 1600,
    battles: 12_000,
    avgDamage: 85_000,
    ranked: { winrate: 48, pr: 1100, battles: 300, avgDamage: 60_000 },
    global: null,
  };

  it("the default dims keep reading the account careers", () => {
    const dims: RosterStatsDims = { ship: "all", battle: "random", solo: "all" };
    expect(scopedRosterView(CAREER, 1, dims, "random", "winrate")).toEqual({
      winrate: 52.5,
      pr: 1600,
      battles: 12_000,
      avgDamage: 85_000,
    });
  });

  it("a ship-scoped source aggregates the attached per-ship list", () => {
    const dims: RosterStatsDims = { ship: "ship", battle: "random", solo: "all" };
    const view = scopedRosterView(
      { ...CAREER, ships: SHIPS },
      1,
      dims,
      "random",
      "winrate",
    );
    expect(view.battles).toBe(100);
    expect(view.winrate).toBeCloseTo(55, 6);
    expect(view.avgDamage).toBeCloseTo(1000, 6);
    expect(view.pr).toBe(prProxyFromWinrate(55));
  });

  it("solo-only with the all-ship scope sweeps the whole list", () => {
    const dims: RosterStatsDims = { ship: "all", battle: "random", solo: "solo" };
    const view = scopedRosterView(
      { ...CAREER, ships: SHIPS },
      1,
      dims,
      "random",
      "winrate",
    );
    // Solo splits: ship 1's 60 + ship 3's 200.
    expect(view.battles).toBe(260);
  });

  it("loading or unavailable per-ship data answers the dash face", () => {
    const dims: RosterStatsDims = { ship: "ship", battle: "random", solo: "all" };
    expect(
      scopedRosterView({ ...CAREER, shipsLoading: true }, 1, dims, "random", "winrate"),
    ).toEqual(EMPTY_ROSTER_VIEW);
    expect(
      scopedRosterView({ ...CAREER, ships: null }, 1, dims, "random", "winrate"),
    ).toEqual(EMPTY_ROSTER_VIEW);
  });
});
