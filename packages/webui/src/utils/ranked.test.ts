/** Tests for the ranked winrate aggregation: season summing plus the null
 *  fallback when no ranked battles exist at all. */
import { describe, expect, it } from "vitest";

import type { RankedSeasonStats } from "@/api";
import { aggregateRankedWinrate } from "./ranked";

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
