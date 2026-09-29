/** The Tab overlay's display-prefs reader + stat-source helpers — the
 *  bare-DOM page's whole settings surface, so the tolerant-read contract
 *  and the auto stats-source resolution are pinned here. */
import { afterEach, describe, expect, it } from "vitest";

import {
  readOverlayDisplayPrefs,
  rankedStatsSource,
  statViewOf,
  type RawStat,
} from "./overlayPrefs";

afterEach(() => {
  localStorage.clear();
});

const RAW: RawStat = {
  winrate: 52.5,
  avgDamage: 85000,
  pr: 1600,
  battles: 12000,
  rankedWinrate: 48,
  rankedAvgDamage: 60000,
  rankedPr: 1100,
  rankedBattles: 300,
};

describe("readOverlayDisplayPrefs", () => {
  it("answers the store defaults when nothing is stored", () => {
    expect(readOverlayDisplayPrefs()).toEqual({
      chips: { winrate: true, pr: false, battles: false, damage: true },
      statsMode: "auto",
      intel: { radar: true, hydro: true, smoke: true },
      teamIntel: true,
      teamAvg: { winrate: false, pr: false, damage: false },
      weightedTeamWr: true,
      sealsOn: false, // PR master defaults off
      sealsDisabled: new Set(),
      prAlgo: undefined,
    });
  });

  it("reads the blob with the store's tolerance contract", () => {
    localStorage.setItem(
      "wowsp-stats-prefs",
      JSON.stringify({
        prEnabled: true,
        prAlgo: "expected",
        sealsEnabled: true,
        sealDisabled: { rat: true, junk: true },
        weightedTeamWr: false,
        teamIntelEnabled: false,
        overlayChips: { winrate: false, battles: true, voodoo: true },
        overlayStatsMode: "ranked",
        overlayIntel: { radar: false },
        overlayTeamAvg: { winrate: true, pr: true, damage: true },
      }),
    );
    const p = readOverlayDisplayPrefs();
    expect(p.chips).toEqual({ winrate: false, pr: false, battles: true, damage: true });
    expect(p.statsMode).toBe("ranked");
    expect(p.intel).toEqual({ radar: false, hydro: true, smoke: true });
    expect(p.teamIntel).toBe(false);
    expect(p.teamAvg).toEqual({ winrate: true, pr: true, damage: true });
    expect(p.weightedTeamWr).toBe(false);
    expect(p.sealsOn).toBe(true);
    expect(p.sealsDisabled).toEqual(new Set(["rat"]));
    expect(p.prAlgo).toBe("expected");
  });

  it("falls back to defaults on a corrupt blob", () => {
    localStorage.setItem("wowsp-stats-prefs", "{not json");
    const p = readOverlayDisplayPrefs();
    expect(p.chips.winrate).toBe(true);
    expect(p.statsMode).toBe("auto");
    expect(p.sealsOn).toBe(false);
    expect(p.prAlgo).toBeUndefined();
  });

  it("seals stay off while the PR master is off, and the algo follows it", () => {
    localStorage.setItem(
      "wowsp-stats-prefs",
      JSON.stringify({ prEnabled: false, prAlgo: "expected", sealsEnabled: true }),
    );
    const p = readOverlayDisplayPrefs();
    expect(p.sealsOn).toBe(false);
    expect(p.prAlgo).toBeUndefined();
  });
});

describe("rankedStatsSource", () => {
  it("fixed modes speak for themselves", () => {
    expect(rankedStatsSource("ranked", { matchGroup: "pvp" })).toBe(true);
    expect(rankedStatsSource("random", { matchGroup: "ranked" })).toBe(false);
  });

  it("auto follows the battle's mode key", () => {
    expect(rankedStatsSource("auto", { matchGroup: "ranked" })).toBe(true);
    expect(rankedStatsSource("auto", { matchGroup: "pvp", scenario: "epic_12v12" })).toBe(false);
    // Scenario-level ranked fingerprints (modeKey's lower layers).
    expect(rankedStatsSource("auto", { matchGroup: "pve", scenario: "ranked_arena_12" })).toBe(
      true,
    );
  });
});

describe("statViewOf", () => {
  it("randoms source answers the overall numbers", () => {
    expect(statViewOf(RAW, false)).toEqual({
      winrate: 52.5,
      pr: 1600,
      battles: 12000,
      damage: 85000,
    });
  });

  it("ranked source answers the ranked numbers", () => {
    expect(statViewOf(RAW, true)).toEqual({
      winrate: 48,
      pr: 1100,
      battles: 300,
      damage: 60000,
    });
  });

  it("a missing player answers all-null (renders the same dash face)", () => {
    expect(statViewOf(undefined, true)).toEqual({
      winrate: null,
      pr: null,
      battles: null,
      damage: null,
    });
  });

  it("a player without ranked battles answers ranked nulls", () => {
    expect(
      statViewOf(
        {
          ...RAW,
          rankedWinrate: null,
          rankedBattles: null,
          rankedPr: null,
          rankedAvgDamage: null,
        },
        true,
      ),
    ).toEqual({
      winrate: null,
      pr: null,
      battles: null,
      damage: null,
    });
  });
});
