import { describe, expect, it } from "vitest";

import { aggregateTeamStats, type TeamStatEntry } from "./teamAggregate";

/** Winrate helper: entries carry percent values (0–100). */
const e = (winrate: number | null, tier: number | null, pr: number | null = null): TeamStatEntry => ({
  winrate,
  pr,
  tier,
});

describe("aggregateTeamStats", () => {
  it("plain mode is the arithmetic mean winrate", () => {
    const agg = aggregateTeamStats([e(60, 10), e(40, 5)], false);
    expect(agg.winrate).toBeCloseTo(50, 10);
    expect(agg.counted).toBe(2);
  });

  it("weighted mode leans on higher tiers (weight = tier)", () => {
    // (60*10 + 40*5) / 15 = 53.33… — above the plain 50 because the T10's
    // winrate carries twice the T5's weight.
    const agg = aggregateTeamStats([e(60, 10), e(40, 5)], true);
    expect(agg.winrate).toBeCloseTo(800 / 15, 10);
  });

  it("gives ships of unknown tier the neutral mean weight", () => {
    // Known tiers 10 and 6 → neutral 8; (60*10 + 40*6 + 50*8) / 24 = 51.66…
    const agg = aggregateTeamStats([e(60, 10), e(40, 6), e(50, null)], true);
    expect(agg.winrate).toBeCloseTo(1240 / 24, 10);
  });

  it("degrades to the plain mean when no tier is known", () => {
    const agg = aggregateTeamStats([e(60, null), e(40, null)], true);
    expect(agg.winrate).toBeCloseTo(50, 10);
  });

  it("skips players without a landed winrate (AI, hidden, loading)", () => {
    const agg = aggregateTeamStats([e(60, 10), e(null, 8), e(40, 5)], false);
    expect(agg.winrate).toBeCloseTo(50, 10);
    expect(agg.counted).toBe(2);
  });

  it("averages PR only over players that have one", () => {
    const agg = aggregateTeamStats([e(60, 10, 1500), e(40, 5, null), e(50, 8, 900)], false);
    expect(agg.avgPr).toBeCloseTo(1200, 10);
  });

  it("returns null aggregates when nothing landed", () => {
    const agg = aggregateTeamStats([e(null, 10), e(null, 8, null)], true);
    expect(agg).toEqual({ winrate: null, avgPr: null, counted: 0 });
  });

  it("handles the empty roster", () => {
    expect(aggregateTeamStats([], true)).toEqual({
      winrate: null,
      avgPr: null,
      counted: 0,
    });
  });
});
