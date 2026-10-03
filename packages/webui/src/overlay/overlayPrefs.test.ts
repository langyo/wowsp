/** The Tab overlay's display-prefs reader + the shared stat-source
 *  helpers — the bare-DOM page's whole settings surface, so the
 *  tolerant-read contract and the auto stats-source resolution are pinned
 *  here. */
import { afterEach, describe, expect, it } from "vitest";

import {
  readOverlayDisplayPrefs,
  resolveRosterBattleScope,
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
      statsDims: { battle: "follow" },
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
        overlayShipScope: "tier",
        overlayStatsMode: "ranked",
        overlayIntel: { radar: false },
        overlayTeamAvg: { winrate: true, pr: true, damage: true },
      }),
    );
    const p = readOverlayDisplayPrefs();
    expect(p.chips).toEqual({ winrate: false, pr: true, battles: true, damage: true });
    // The battle scope reads through (and migrates off the legacy enum);
    // the ship/solo dimensions are main-window-only and stay unmodeled
    // here (the overlay renders the account careers).
    expect(p.statsDims.battle).toBe("ranked");
    expect(p.intel).toEqual({ radar: false, hydro: true, smoke: true });
    expect(p.teamIntel).toBe(false);
    expect(p.teamAvg).toEqual({ winrate: true, pr: true, damage: true });
    expect(p.weightedTeamWr).toBe(false);
    expect(p.sealsOn).toBe(true);
    expect(p.sealsDisabled).toEqual(new Set(["rat"]));
    expect(p.prAlgo).toBe("expected");
  });

  it("accepts the global battle scope and migrates the legacy enum", () => {
    localStorage.setItem(
      "wowsp-stats-prefs",
      JSON.stringify({ overlayBattleScope: "all" }),
    );
    expect(readOverlayDisplayPrefs().statsDims.battle).toBe("all");

    // A blob last written by a pre-split build: the retired enum seeds the
    // battle dimension ("global" WAS the merged career).
    localStorage.setItem(
      "wowsp-stats-prefs",
      JSON.stringify({ overlayStatsMode: "global" }),
    );
    expect(readOverlayDisplayPrefs().statsDims.battle).toBe("all");
    localStorage.setItem(
      "wowsp-stats-prefs",
      JSON.stringify({ overlayStatsMode: "auto" }),
    );
    expect(readOverlayDisplayPrefs().statsDims.battle).toBe("follow");
  });

  it("falls back to defaults on a corrupt blob", () => {
    localStorage.setItem("wowsp-stats-prefs", "{not json");
    const p = readOverlayDisplayPrefs();
    expect(p.chips.winrate).toBe(true);
    expect(p.statsDims.battle).toBe("follow");
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

describe("resolveRosterBattleScope", () => {
  it("fixed scopes speak for themselves", () => {
    expect(resolveRosterBattleScope("ranked", { matchGroup: "pvp" })).toBe("ranked");
    expect(resolveRosterBattleScope("random", { matchGroup: "ranked" })).toBe("random");
    expect(resolveRosterBattleScope("all", { matchGroup: "ranked" })).toBe("all");
  });

  it("follow tracks the battle's mode key", () => {
    expect(resolveRosterBattleScope("follow", { matchGroup: "ranked" })).toBe("ranked");
    expect(
      resolveRosterBattleScope("follow", { matchGroup: "pvp", scenario: "epic_12v12" }),
    ).toBe("random");
    // Scenario-level ranked fingerprints (modeKey's lower layers).
    expect(
      resolveRosterBattleScope("follow", { matchGroup: "pve", scenario: "ranked_arena_12" }),
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
    expect(rosterStatView(RAW, "all")).toEqual({
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
    expect(rosterStatView({ ...RAW, global: null }, "all")).toEqual({
      winrate: 52.5,
      pr: 1600,
      battles: 12000,
      avgDamage: 85000,
    });
  });
});
