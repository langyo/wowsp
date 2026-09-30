/** The Tab overlay's display-prefs reader + the shared stat-source
 *  helpers — the bare-DOM page's whole settings surface, so the
 *  tolerant-read contract and the auto stats-source resolution are pinned
 *  here. */
import { afterEach, describe, expect, it } from "vitest";

import {
  readOverlayDisplayPrefs,
  resolveRosterStatsMode,
  rosterStatView,
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
  ranked: {
    winrate: 48,
    avgDamage: 60000,
    pr: 1100,
    battles: 300,
  },
  global: {
    winrate: 51.9,
    avgDamage: 82000,
    pr: 1550,
    battles: 12300,
  },
  clanId: null,
  clanTag: null,
  hidden: false,
};

describe("readOverlayDisplayPrefs", () => {
  it("answers the store defaults when nothing is stored", () => {
    expect(readOverlayDisplayPrefs()).toEqual({
      chips: { winrate: true, pr: true, battles: true, damage: true },
      statsMode: "auto",
      intel: { radar: true, hydro: true, smoke: true },
      teamIntel: true,
      teamAvg: { winrate: false, pr: false, damage: false },
      weightedTeamWr: true,
      sealsOn: true, // PR master + seals both default on now
      sealsDisabled: new Set(),
      prAlgo: "winrate",
      prOn: true,
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
    expect(p.chips).toEqual({ winrate: false, pr: true, battles: true, damage: true });
    expect(p.statsMode).toBe("ranked");
    expect(p.intel).toEqual({ radar: false, hydro: true, smoke: true });
    expect(p.teamIntel).toBe(false);
    expect(p.teamAvg).toEqual({ winrate: true, pr: true, damage: true });
    expect(p.weightedTeamWr).toBe(false);
    expect(p.sealsOn).toBe(true);
    expect(p.sealsDisabled).toEqual(new Set(["rat"]));
    expect(p.prAlgo).toBe("expected");
  });

  it("accepts the global stats mode", () => {
    localStorage.setItem(
      "wowsp-stats-prefs",
      JSON.stringify({ overlayStatsMode: "global" }),
    );
    expect(readOverlayDisplayPrefs().statsMode).toBe("global");
  });

  it("falls back to defaults on a corrupt blob", () => {
    localStorage.setItem("wowsp-stats-prefs", "{not json");
    const p = readOverlayDisplayPrefs();
    expect(p.chips.winrate).toBe(true);
    expect(p.statsMode).toBe("auto");
    expect(p.sealsOn).toBe(true);
    expect(p.prAlgo).toBe("winrate");
  });

  it("seals stay off while the PR master is off, and the algo follows it", () => {
    localStorage.setItem(
      "wowsp-stats-prefs",
      JSON.stringify({ prEnabled: false, prAlgo: "expected", sealsEnabled: true }),
    );
    const p = readOverlayDisplayPrefs();
    expect(p.sealsOn).toBe(false);
    expect(p.prAlgo).toBeUndefined();
    expect(p.prOn).toBe(false);
  });
});

describe("resolveRosterStatsMode", () => {
  it("fixed modes speak for themselves", () => {
    expect(resolveRosterStatsMode("ranked", { matchGroup: "pvp" })).toBe("ranked");
    expect(resolveRosterStatsMode("random", { matchGroup: "ranked" })).toBe("random");
    expect(resolveRosterStatsMode("global", { matchGroup: "ranked" })).toBe("global");
  });

  it("auto follows the battle's mode key", () => {
    expect(resolveRosterStatsMode("auto", { matchGroup: "ranked" })).toBe("ranked");
    expect(
      resolveRosterStatsMode("auto", { matchGroup: "pvp", scenario: "epic_12v12" }),
    ).toBe("random");
    // Scenario-level ranked fingerprints (modeKey's lower layers).
    expect(
      resolveRosterStatsMode("auto", { matchGroup: "pve", scenario: "ranked_arena_12" }),
    ).toBe("ranked");
  });
});

describe("rosterStatView", () => {
  it("randoms source answers the overall numbers", () => {
    expect(rosterStatView(RAW, "random")).toEqual({
      winrate: 52.5,
      pr: 1600,
      battles: 12000,
      avgDamage: 85000,
    });
  });

  it("ranked source answers the ranked numbers", () => {
    expect(rosterStatView(RAW, "ranked")).toEqual({
      winrate: 48,
      pr: 1100,
      battles: 300,
      avgDamage: 60000,
    });
  });

  it("global source answers the merged numbers", () => {
    expect(rosterStatView(RAW, "global")).toEqual({
      winrate: 51.9,
      pr: 1550,
      battles: 12300,
      avgDamage: 82000,
    });
  });

  it("a missing player answers all-null (renders the same dash face)", () => {
    expect(rosterStatView(undefined, "ranked")).toEqual({
      winrate: null,
      pr: null,
      battles: null,
      avgDamage: null,
    });
  });

  it("a player without ranked battles answers ranked nulls", () => {
    expect(rosterStatView({ ...RAW, ranked: null }, "ranked")).toEqual({
      winrate: null,
      pr: null,
      battles: null,
      avgDamage: null,
    });
  });

  it("a payload without global fields falls back to the randoms view", () => {
    expect(rosterStatView({ ...RAW, global: null }, "global")).toEqual({
      winrate: 52.5,
      pr: 1600,
      battles: 12000,
      avgDamage: 85000,
    });
  });
});
