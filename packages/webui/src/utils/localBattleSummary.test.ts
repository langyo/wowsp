/** Replay-derived range summary: mode filter (random + ranked only), win
 *  accounting (`won === true` only), per-ship aggregation and the ranked
 *  split the dashboard's range note reads. */
import { describe, expect, it } from "vitest";

import type { LocalBattle } from "@/api";
import { summarizeLocalBattles } from "./localBattleSummary";

/** One decodable replay row; per-test overrides pick the variant. */
function battle(overrides: Partial<LocalBattle> = {}): LocalBattle {
  return {
    timestamp: 1_760_000_000,
    dateTime: "20261026_193418",
    matchGroup: "pvp",
    scenario: "domination_3point",
    eventType: "PCVP000",
    shipId: 1,
    team: 0,
    won: true,
    damage: 50_000,
    frags: 1,
    survived: true,
    exp: 1_000,
    ...overrides,
  };
}

const SINCE = 1_759_000_000;
const END = 1_760_000_000;

describe("summarizeLocalBattles", () => {
  it("keeps random and ranked battles only", () => {
    const rows = [
      battle({ matchGroup: "pvp" }),
      battle({ matchGroup: "ranked", scenario: "ranked_solo" }),
      battle({ matchGroup: "pve", scenario: "asymm_3point_coop" }),
      battle({ matchGroup: "clan", scenario: "domination_clan" }),
      battle({ matchGroup: "pve", scenario: "domination_3point", eventType: "PCVE027" }),
    ];
    const summary = summarizeLocalBattles(rows, SINCE, END);
    expect(summary.battles).toBe(2);
    expect(summary.rankedBattles).toBe(1);
    expect(summary.ships).toHaveLength(1);
  });

  it("classifies a ranked scenario as ranked even under a generic match group", () => {
    const summary = summarizeLocalBattles(
      [battle({ matchGroup: "pvp", scenario: "ranked_league" })],
      SINCE,
      END,
    );
    expect(summary.battles).toBe(1);
    expect(summary.rankedBattles).toBe(1);
  });

  it("counts only won === true as wins (null verdicts are non-wins)", () => {
    const summary = summarizeLocalBattles(
      [
        battle({ won: true }),
        battle({ won: false }),
        battle({ won: null }),
        battle({ won: true }),
      ],
      SINCE,
      END,
    );
    expect(summary.battles).toBe(4);
    expect(summary.wins).toBe(2);
    expect(summary.winrate).toBeCloseTo(50);
  });

  it("aggregates per ship and derives the API-shaped row", () => {
    const summary = summarizeLocalBattles(
      [
        battle({ shipId: 7, won: true, damage: 60_000, frags: 2, survived: true, exp: 1_200, timestamp: 1_759_500_000 }),
        battle({ shipId: 7, won: false, damage: 40_000, frags: 0, survived: false, exp: 800, timestamp: 1_759_900_000 }),
        battle({ shipId: 9, won: true, damage: 30_000, frags: 1, survived: true, exp: 900, timestamp: 1_759_100_000 }),
      ],
      SINCE,
      END,
    );
    expect(summary.battles).toBe(3);
    expect(summary.wins).toBe(2);
    expect(summary.winrate).toBeCloseTo((2 / 3) * 100);
    expect(summary.avgDamage).toBeCloseTo(130_000 / 3);
    // Most-played ship first.
    expect(summary.ships.map((s) => s.shipId)).toEqual([7, 9]);
    const seven = summary.ships[0]!;
    expect(seven.name).toBe("");
    expect(seven.battles).toBe(2);
    expect(seven.wins).toBe(1);
    expect(seven.winrate).toBeCloseTo(50);
    expect(seven.damageCaused).toBe(100_000);
    expect(seven.avgDamage).toBe(50_000);
    expect(seven.frags).toBe(2);
    expect(seven.survivedBattles).toBe(1);
    expect(seven.lastBattleTime).toBe(1_759_900_000);
    expect(seven.avgXp).toBe(1_000);
    expect(seven.pr).toBeNull();
  });

  it("keeps account totals for rows whose ship id is unknown", () => {
    const summary = summarizeLocalBattles(
      [battle({ shipId: null, won: true, damage: 10_000 }), battle({ shipId: 3, won: false })],
      SINCE,
      END,
    );
    expect(summary.battles).toBe(2);
    expect(summary.wins).toBe(1);
    expect(summary.ships.map((s) => s.shipId)).toEqual([3]);
  });

  it("reports a null avgXp when no row carried XP", () => {
    const summary = summarizeLocalBattles([battle({ shipId: 4, exp: null })], SINCE, END);
    expect(summary.ships[0]!.avgXp).toBeNull();
  });

  it("echoes the window and zeroes for an empty log", () => {
    const summary = summarizeLocalBattles([], SINCE, END);
    expect(summary).toEqual({
      ships: [],
      battles: 0,
      wins: 0,
      winrate: 0,
      avgDamage: 0,
      sinceTs: SINCE,
      endTs: END,
      rankedBattles: 0,
    });
  });
});
