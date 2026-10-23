/** Tests for the ranked aggregation utils: season summing, the null
 *  fallback when no ranked battles exist, and the timeline helpers
 *  (league metal of a rank display, the "S30" season number). */
import { describe, expect, it } from "vitest";

import type { RankedSeasonStats } from "@/api";
import {
  aggregateRankedWinrate,
  leagueFromNumber,
  leagueTierWindow,
  rankLeague,
  seasonNumber,
} from "./ranked";

/** Partial season: only the fields the util reads plus just enough identity
 *  to stay readable — the cast mirrors the backend's full shape. */
function season(battles: number, wins: number): RankedSeasonStats {
  return { seasonId: 1, seasonName: "Test Season", battles, wins } as RankedSeasonStats;
}

describe("aggregateRankedWinrate", () => {
  it("returns null for an empty season list", () => {
    expect(aggregateRankedWinrate([])).toBeNull();
  });

  it("returns null when no season has battles", () => {
    expect(aggregateRankedWinrate([season(0, 0)])).toBeNull();
    expect(aggregateRankedWinrate([season(0, 0), season(0, 0)])).toBeNull();
  });

  it("computes the winrate of a single season", () => {
    expect(aggregateRankedWinrate([season(80, 40)])).toBeCloseTo(50);
  });

  it("aggregates wins and battles across seasons", () => {
    const wr = aggregateRankedWinrate([season(100, 55), season(50, 20)]);
    expect(wr).toBeCloseTo(50);
  });
});

describe("rankLeague", () => {
  it("maps the backend rank displays to their metals", () => {
    expect(rankLeague("Gold 3")).toBe("gold");
    expect(rankLeague("Silver 10")).toBe("silver");
    expect(rankLeague("Bronze 1")).toBe("bronze");
  });

  it("is case-insensitive and trims", () => {
    expect(rankLeague(" gold 1")).toBe("gold");
  });

  it("returns null for absent or unknown displays", () => {
    expect(rankLeague(null)).toBeNull();
    expect(rankLeague(undefined)).toBeNull();
    expect(rankLeague("")).toBeNull();
    expect(rankLeague("Unknown 5")).toBeNull();
  });
});

describe("leagueFromNumber", () => {
  it("maps the backend league numbers onto the metals", () => {
    expect(leagueFromNumber(1)).toBe("gold");
    expect(leagueFromNumber(2)).toBe("silver");
    expect(leagueFromNumber(3)).toBe("bronze");
  });

  it("returns null for anything else (absent, unknown)", () => {
    expect(leagueFromNumber(null)).toBeNull();
    expect(leagueFromNumber(undefined)).toBeNull();
    expect(leagueFromNumber(0)).toBeNull();
    expect(leagueFromNumber(4)).toBeNull();
  });
});

describe("leagueTierWindow", () => {
  const leagues = [
    { league: 1, minTier: 9, maxTier: 10 },
    { league: 2, minTier: 7, maxTier: 8 },
    { league: 3, minTier: 6, maxTier: 6 },
  ];

  it("returns the picked league's tier window", () => {
    expect(leagueTierWindow(leagues, 1)).toEqual([9, 10]);
    expect(leagueTierWindow(leagues, 3)).toEqual([6, 6]);
  });

  it("returns null without metadata or for an unknown league", () => {
    expect(leagueTierWindow(undefined, 1)).toBeNull();
    expect(leagueTierWindow([], 1)).toBeNull();
    expect(leagueTierWindow(leagues, 9)).toBeNull();
  });
});

describe("seasonNumber", () => {
  it("parses the trailing number of the season name", () => {
    expect(seasonNumber({ seasonId: 1030, seasonName: "Season 30" })).toBe(30);
  });

  it("falls back to the id convention (id − 1000) without a number", () => {
    expect(seasonNumber({ seasonId: 1029, seasonName: "Season" })).toBe(29);
  });
});
