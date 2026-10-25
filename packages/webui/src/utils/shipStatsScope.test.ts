/** Ship-scoped roster views — the aggregation behind the stats source's
 *  ship / solo dimensions: scope filtering (ship / class / tier / all),
 *  battle-bucket selection off the per-ship payloads, the WR→PR anchor
 *  port (pinned to the backend's own test values), and the account-career
 *  paths — the global fallback while no ship-scoped dimension is on, and
 *  the career solo split behind every solo-only view. */
import { describe, expect, it } from "vitest";

import type { PlayerShipStats } from "@/api";
import type { ShipMetaResolver } from "@/utils/shipStatsScope";
import {
  aggregateShipScopeStats,
  prProxyFromWinrate,
  scopedRosterView,
} from "@/utils/shipStatsScope";
import {
  EMPTY_ROSTER_VIEW,
  columnsNeedShipStats,
  overlayColumnDims,
  type RosterBattleScope,
  type RosterStatsDims,
  type OverlayColumn,
} from "@/utils/statView";

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

const mode = (
  battles: number,
  wins: number,
  damage: number,
  frags = 0,
  survived = 0,
) => ({
  battles,
  wins,
  damageCaused: damage,
  frags,
  survivedBattles: survived,
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
    // 120 frags, 40 survived → 120 frags / 60 deaths = 2.0 K/D.
    frags: 120,
    survivedBattles: 40,
    // 60 solo battles at 50% + 40 div2 battles at 62.5%. Solo split: 90
    // frags, 20 survived → 90/40 = 2.25; ranked: 30 frags, 4 survived →
    // 30/16 = 1.875.
    modes: {
      solo: mode(60, 30, 54_000, 90, 20),
      div2: mode(40, 25, 46_000),
      div3: null,
      coop: null,
      ranked: mode(20, 12, 22_000, 30, 4),
    },
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

  it("zero battles in scope answers an honest 0 count with dashed ratios", () => {
    const none = [ship({ shipId: 7, battles: 0 })];
    expect(aggregateShipScopeStats(none, 7, q(), resolver)).toEqual({
      winrate: null,
      pr: null,
      battles: 0,
      avgDamage: null,
      kd: null,
    });
    // The row's ship missing from the landed list entirely is the same
    // verdict — never played IS zero battles, not a data miss.
    expect(aggregateShipScopeStats(SHIPS, 99, q(), resolver)).toEqual({
      winrate: null,
      pr: null,
      battles: 0,
      avgDamage: null,
      kd: null,
    });
    // Through the view resolver the same dims hold: the count renders 0,
    // the ratio metrics keep the dash face.
    const career = {
      winrate: 52.5,
      pr: 1600,
      battles: 12_000,
      avgDamage: 85_000,
      kd: 1.8,
      ranked: null,
      global: null,
      solo: { winrate: 51, pr: null, battles: 8000, avgDamage: null, kd: 1.6 },
    };
    const dims: RosterStatsDims = { ship: "ship", battle: "random", solo: "all" };
    expect(
      scopedRosterView({ ...career, ships: SHIPS }, 99, dims, "random", "winrate"),
    ).toEqual({
      winrate: null,
      pr: null,
      battles: 0,
      avgDamage: null,
      kd: null,
    });
  });

  it("the solo filter reads the randoms solo split", () => {
    const view = aggregateShipScopeStats(SHIPS, 1, q({ solo: true }), resolver);
    expect(view!.battles).toBe(60);
    expect(view!.winrate).toBeCloseTo(50, 5);
    expect(view!.avgDamage).toBeCloseTo(54_000 / 60, 5);
  });

  it("the solo filter over ranked answers the dash face (no split exists)", () => {
    expect(aggregateShipScopeStats(SHIPS, 1, q({ solo: true, battle: "ranked" }), resolver)).toEqual(
      EMPTY_ROSTER_VIEW,
    );
  });

  it("the solo filter over the merged bucket keeps only the solo randoms", () => {
    // Ship 1: 60 solo randoms — the 20 unsplit ranked battles must not
    // masquerade as solo numbers.
    const view = aggregateShipScopeStats(SHIPS, 1, q({ solo: true, battle: "all" }), resolver);
    expect(view!.battles).toBe(60);
    expect(view!.winrate).toBeCloseTo(50, 5);
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

  it("K/D aggregates the summed raw counters (Σfrags / Σdeaths)", () => {
    // Ship 1's randoms career: 120 frags / (100 − 40 survived) = 2.0 — the
    // game's own caliber over the row's counters.
    const view = aggregateShipScopeStats(SHIPS, 1, q(), resolver);
    expect(view!.kd).toBeCloseTo(2.0, 6);
    // The solo split: 90 frags / (60 − 20) = 2.25.
    const soloView = aggregateShipScopeStats(SHIPS, 1, q({ solo: true }), resolver);
    expect(soloView!.kd).toBeCloseTo(2.25, 6);
    // The ranked bucket: 30 frags / (20 − 4) = 1.875.
    const rankedView = aggregateShipScopeStats(SHIPS, 1, q({ battle: "ranked" }), resolver);
    expect(rankedView!.kd).toBeCloseTo(1.875, 6);
    // The merged bucket SUMS both sides' counters first:
    // (120 + 30) / ((100 − 40) + (20 − 4)) = 150/76.
    const mergedView = aggregateShipScopeStats(SHIPS, 1, q({ battle: "all" }), resolver);
    expect(mergedView!.kd).toBeCloseTo(150 / 76, 6);
  });

  it("an aggregate where nobody died answers the K/D dash, not zero", () => {
    const immortal = [
      ship({ shipId: 1, battles: 10, wins: 5, damageCaused: 0, frags: 7, survivedBattles: 10 }),
    ];
    const view = aggregateShipScopeStats(immortal, 1, q(), resolver);
    expect(view!.battles).toBe(10);
    expect(view!.kd).toBeNull();
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
    kd: 1.8,
    ranked: { winrate: 48, pr: 1100, battles: 300, avgDamage: 60_000, kd: 1.2 },
    global: null,
    // The career solo split, mapped data-only (PR/avgDamage null — the
    // view derives the PR per algorithm; kd rides when the wire carried
    // it).
    solo: { winrate: 51, pr: null, battles: 8000, avgDamage: null, kd: 1.6 },
  };

  it("the default dims keep reading the account careers", () => {
    const dims: RosterStatsDims = { ship: "all", battle: "random", solo: "all" };
    expect(scopedRosterView(CAREER, 1, dims, "random", "winrate")).toEqual({
      winrate: 52.5,
      pr: 1600,
      battles: 12_000,
      avgDamage: 85_000,
      kd: 1.8,
    });
  });

  it("the solo-only dims carry the split's own K/D (or its dash)", () => {
    const dims: RosterStatsDims = { ship: "all", battle: "random", solo: "solo" };
    expect(scopedRosterView(CAREER, 1, dims, "random", "winrate").kd).toBeCloseTo(1.6, 6);
    // A split without the K/D detail (CN's battles/wins-only div nodes)
    // keeps the dash face — never the career K/D wearing a solo tag.
    const noKd = { ...CAREER, solo: { winrate: 51, pr: null, battles: 8000, avgDamage: null, kd: null } };
    expect(scopedRosterView(noKd, 1, dims, "random", "winrate").kd).toBeNull();
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

  it("solo-only dims read the career solo split — no per-ship list needed", () => {
    const dims: RosterStatsDims = { ship: "all", battle: "random", solo: "solo" };
    // Note ships stays undefined: the career carries the split, so the
    // per-ship transport (the one bulk fetch that can fail or lag behind
    // the career) is never on the solo columns' critical path.
    const view = scopedRosterView(CAREER, 1, dims, "random", "winrate");
    expect(view.battles).toBe(8000);
    expect(view.winrate).toBeCloseTo(51, 6);
    expect(view.pr).toBe(prProxyFromWinrate(51));
    expect(view.avgDamage).toBeNull();
  });

  it("solo-only dims over the merged battle scope stay randoms-solo", () => {
    const dims: RosterStatsDims = { ship: "all", battle: "all", solo: "solo" };
    const view = scopedRosterView(
      { ...CAREER, ships: SHIPS },
      1,
      dims,
      "all",
      "winrate",
    );
    // The career solo split IS the randoms-solo career — the ranked side
    // (no solo split anywhere) contributes nothing.
    expect(view.battles).toBe(8000);
  });

  it("solo-only dims over ranked answer the dash face — with ships or without", () => {
    const dims: RosterStatsDims = { ship: "all", battle: "ranked", solo: "solo" };
    expect(scopedRosterView({ ...CAREER, ships: SHIPS }, 1, dims, "ranked", "winrate")).toEqual(
      EMPTY_ROSTER_VIEW,
    );
    expect(scopedRosterView(CAREER, 1, dims, "ranked", "winrate")).toEqual(EMPTY_ROSTER_VIEW);
  });

  it("solo-only PR stays dashed under the expected algorithm", () => {
    const dims: RosterStatsDims = { ship: "all", battle: "random", solo: "solo" };
    const view = scopedRosterView(CAREER, 1, dims, "random", "expected");
    expect(view.battles).toBe(8000);
    expect(view.pr).toBeNull();
  });

  it("a career without the solo split dashes the solo-only view", () => {
    const dims: RosterStatsDims = { ship: "all", battle: "random", solo: "solo" };
    const { solo: _solo, ...withoutSolo } = CAREER;
    expect(scopedRosterView(withoutSolo, 1, dims, "random", "winrate")).toEqual(EMPTY_ROSTER_VIEW);
  });

  it("a MIRRORED solo split (equal to the career) dashes the solo-only view", () => {
    const dims: RosterStatsDims = { ship: "all", battle: "random", solo: "solo" };
    // The transport-mirror shape: pvp_solo just echoes pvp. However real
    // the winrate looks, the split is not a measurement.
    const mirrored = { ...CAREER, solo: { winrate: 52.5, pr: null, battles: 12_000, avgDamage: null, kd: null } };
    expect(scopedRosterView(mirrored, 1, dims, "random", "winrate")).toEqual(EMPTY_ROSTER_VIEW);
    // A near-mirror (within the 1% line) dashes too.
    const nearMirror = { ...CAREER, solo: { winrate: 52.4, pr: null, battles: 11_950, avgDamage: null, kd: null } };
    expect(scopedRosterView(nearMirror, 1, dims, "random", "winrate")).toEqual(EMPTY_ROSTER_VIEW);
    // A genuinely dominant — but clearly split — solo share stays a figure.
    const dominant = { ...CAREER, solo: { winrate: 51.9, pr: null, battles: 11_700, avgDamage: null, kd: null } };
    const view = scopedRosterView(dominant, 1, dims, "random", "winrate");
    expect(view.battles).toBe(11_700);
    // The short-career exception: ≤50 battles may honestly be all solo.
    const fresh = {
      ...CAREER,
      battles: 50,
      solo: { winrate: 51, pr: null, battles: 50, avgDamage: null, kd: null },
    };
    expect(scopedRosterView(fresh, 1, dims, "random", "winrate").battles).toBe(50);
  });

  it("a ship scope combined with the solo filter aggregates the per-ship solo split", () => {
    const dims: RosterStatsDims = { ship: "ship", battle: "random", solo: "solo" };
    const view = scopedRosterView({ ...CAREER, ships: SHIPS }, 1, dims, "random", "winrate");
    // Ship 1's own solo split: 60 battles at 50% — a "this ship's solo
    // career" question the account career (8000 battles) cannot answer.
    expect(view.battles).toBe(60);
    expect(view.winrate).toBeCloseTo(50, 6);
    expect(view.avgDamage).toBeCloseTo(54_000 / 60, 6);
    // Ranked has no solo split on any ship scope either.
    expect(
      scopedRosterView({ ...CAREER, ships: SHIPS }, 1, dims, "ranked", "winrate"),
    ).toEqual(EMPTY_ROSTER_VIEW);
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

describe("columnsNeedShipStats", () => {
  const col = (scope: OverlayColumn["scope"], metric: OverlayColumn["metric"] = "winrate") => ({
    scope,
    metric,
  });

  it("global and solo columns ride the account careers alone", () => {
    expect(
      columnsNeedShipStats([col("global"), col("global", "battles"), col("solo")], true),
    ).toBe(false);
    // PR columns the rating master hides do not count either.
    expect(
      columnsNeedShipStats([col("global"), col("global", "pr")], false),
    ).toBe(false);
  });

  it("a ship or class scope still forces the per-ship lists", () => {
    expect(columnsNeedShipStats([col("global"), col("ship")], true)).toBe(true);
    expect(columnsNeedShipStats([col("global"), col("class", "battles")], true)).toBe(true);
    // The ship × solo combination aggregates the per-ship solo splits, so
    // it rides the per-ship pipeline like the plain ship scope does.
    expect(columnsNeedShipStats([col("global"), col("shipSolo", "battles")], true)).toBe(true);
  });
});

describe("overlayColumnDims", () => {
  const battle: RosterBattleScope = "follow";
  const dimsOf = (scope: OverlayColumn["scope"]) => overlayColumnDims(scope, battle);

  it("pins every column scope onto its ship/solo dims pair", () => {
    expect(dimsOf("global")).toEqual({ ship: "all", battle, solo: "all" });
    expect(dimsOf("solo")).toEqual({ ship: "all", battle, solo: "solo" });
    expect(dimsOf("ship")).toEqual({ ship: "ship", battle, solo: "all" });
    expect(dimsOf("shipSolo")).toEqual({ ship: "ship", battle, solo: "solo" });
    expect(dimsOf("class")).toEqual({ ship: "class", battle, solo: "all" });
  });

  it("the ship-solo scope resolves the row ship's own solo split", () => {
    // The dims pair the shipSolo column resolves through — feeding the
    // exact combination the scopedRosterView suite above aggregates: ship
    // 1's own 60 solo battles, never the career's 8000.
    const career = {
      winrate: 52.5,
      pr: 1600,
      battles: 12_000,
      avgDamage: 85_000,
      kd: 1.8,
      ranked: null,
      global: null,
      solo: { winrate: 51, pr: null, battles: 8000, avgDamage: null, kd: 1.6 },
    };
    const view = scopedRosterView(
      { ...career, ships: SHIPS },
      1,
      dimsOf("shipSolo"),
      "random",
      "winrate",
    );
    expect(view.battles).toBe(60);
    expect(view.winrate).toBeCloseTo(50, 6);
  });
});
