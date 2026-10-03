/** Stats-prefs store: defaults, persistence round-trip and corrupt-storage
 *  tolerance. The module-level `statsPrefsState` ref initializes from
 *  localStorage at import time, so every case re-imports the module against
 *  a freshly seeded storage (vi.resetModules) instead of trying to re-seed
 *  state that already exists. */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_STATS_PREFS,
  STATS_PREFS_STORAGE_KEY,
  loadStatsPrefs,
  useStatsPrefsStore,
} from "./statsPrefs";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  // The top-level import stays bound to the original module instance
  // (resetModules only affects later dynamic imports); a fresh pinia per
  // test is all the store needs.
  setActivePinia(createPinia());
});

async function freshModule() {
  const mod = await import("./statsPrefs");
  setActivePinia(createPinia());
  return mod;
}

describe("loadStatsPrefs", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(loadStatsPrefs()).toEqual(DEFAULT_STATS_PREFS);
    // The PR rating and ALL FOUR stat columns ship on (the roster reads
    // winrate/PR/battles together, each individually switchable); the fun
    // wording, seals and the tier-weighted team winrate ship on. Team
    // averages ship off (dense already). Both roster-density overrides ship
    // off: full cards on the live panel and compact rows post-battle are
    // the defaults.
    expect(DEFAULT_STATS_PREFS).toEqual({
      prEnabled: true,
      prAlgo: "winrate",
      sealsEnabled: true,
      localizedTiers: true,
      weightedTeamWr: true,
      liveRosterCompact: false,
      postbattleRosterFull: false,
      teamIntelEnabled: true,
      sealDisabled: {},
      overlayChips: { winrate: true, pr: true, battles: true, damage: true },
      overlayShipScope: "all",
      overlayBattleScope: "follow",
      overlaySoloScope: "all",
      overlayIntel: { radar: true, hydro: true, smoke: true },
      overlayTeamAvg: { winrate: false, pr: false, damage: false },
    });
  });

  it("falls back to defaults on corrupt JSON — and heals it onto disk", () => {
    localStorage.setItem(STATS_PREFS_STORAGE_KEY, "{not json");
    expect(loadStatsPrefs()).toEqual(DEFAULT_STATS_PREFS);
    // Heal-write: the corrupt blob is replaced by the defaults so the fix
    // sticks instead of re-defaulting on every boot.
    expect(localStorage.getItem(STATS_PREFS_STORAGE_KEY)).toBe(
      JSON.stringify(DEFAULT_STATS_PREFS),
    );
  });

  it("rewrites a partially-invalid blob in its normalized form", () => {
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({ prAlgo: "voodoo", sealDisabled: { rat: true, junk: true } }),
    );
    expect(loadStatsPrefs()).toEqual({
      ...DEFAULT_STATS_PREFS,
      sealDisabled: { rat: true },
    });
    expect(localStorage.getItem(STATS_PREFS_STORAGE_KEY)).toBe(
      JSON.stringify({ ...DEFAULT_STATS_PREFS, sealDisabled: { rat: true } }),
    );
  });

  it("migrates the legacy avg-stats switch into the chip toggles", () => {
    // A pre-overlayChips blob: avgStatsEnabled seeded winrate + damage, and
    // the normalized rewrite drops the legacy key so it never comes back.
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({ prEnabled: true, avgStatsEnabled: false }),
    );
    expect(loadStatsPrefs()).toEqual({
      ...DEFAULT_STATS_PREFS,
      prEnabled: true,
      overlayChips: { winrate: false, pr: false, battles: false, damage: false },
    });
    expect(localStorage.getItem(STATS_PREFS_STORAGE_KEY)).not.toContain(
      "avgStatsEnabled",
    );

    // The ON legacy value keeps the shipped chip content.
    localStorage.setItem(STATS_PREFS_STORAGE_KEY, JSON.stringify({ avgStatsEnabled: true }));
    expect(loadStatsPrefs().overlayChips).toEqual(
      DEFAULT_STATS_PREFS.overlayChips,
    );

    // An explicit overlayChips object always wins over the legacy seed.
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({
        avgStatsEnabled: false,
        overlayChips: { winrate: true, pr: true, battles: true, damage: false },
      }),
    );
    expect(loadStatsPrefs().overlayChips).toEqual({
      winrate: true,
      pr: true,
      battles: true,
      damage: false,
    });
  });

  it("fills missing fields with defaults instead of dropping the blob", () => {
    localStorage.setItem(STATS_PREFS_STORAGE_KEY, JSON.stringify({ prEnabled: true }));
    const prefs = loadStatsPrefs();
    expect(prefs.prEnabled).toBe(true);
    expect(prefs.prAlgo).toBe("winrate");
    expect(prefs.sealsEnabled).toBe(true);
    expect(prefs.localizedTiers).toBe(true);
    expect(prefs.weightedTeamWr).toBe(true);
    expect(prefs.teamIntelEnabled).toBe(true);
    expect(prefs.sealDisabled).toEqual({});
    expect(prefs.overlayChips).toEqual(DEFAULT_STATS_PREFS.overlayChips);
    expect(prefs.overlayShipScope).toBe("all");
    expect(prefs.overlayBattleScope).toBe("follow");
    expect(prefs.overlaySoloScope).toBe("all");
    expect(prefs.overlayIntel).toEqual(DEFAULT_STATS_PREFS.overlayIntel);
    expect(prefs.overlayTeamAvg).toEqual(DEFAULT_STATS_PREFS.overlayTeamAvg);
  });

  it("keeps only known boolean keys in sealDisabled", () => {
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({
        sealDisabled: { rat: true, air: false, voodoo: true, miracle: "yes" },
      }),
    );
    expect(loadStatsPrefs().sealDisabled).toEqual({ rat: true, air: false });
  });

  it("keeps only known boolean keys in the toggle objects", () => {
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({
        overlayChips: { winrate: false, junk: true, pr: "yes" },
        overlayIntel: { radar: false, smoke: true, sonar: true },
        overlayTeamAvg: { pr: true, damage: true, karma: true },
      }),
    );
    const prefs = loadStatsPrefs();
    expect(prefs.overlayChips).toEqual({
      ...DEFAULT_STATS_PREFS.overlayChips,
      winrate: false,
    });
    expect(prefs.overlayIntel).toEqual({ radar: false, hydro: true, smoke: true });
    expect(prefs.overlayTeamAvg).toEqual({
      ...DEFAULT_STATS_PREFS.overlayTeamAvg,
      pr: true,
      damage: true,
    });
  });

  it("rejects an unknown algorithm value", () => {
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({ prEnabled: true, prAlgo: "voodoo" }),
    );
    expect(loadStatsPrefs().prAlgo).toBe("winrate");
  });

  it("rejects an unknown battle-scope value", () => {
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({ overlayBattleScope: "solo" }),
    );
    expect(loadStatsPrefs().overlayBattleScope).toBe("follow");
  });

  it("rejects an unknown ship-scope value", () => {
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({ overlayShipScope: "fleet" }),
    );
    expect(loadStatsPrefs().overlayShipScope).toBe("all");
  });

  it("rejects an unknown solo-scope value", () => {
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({ overlaySoloScope: "div2" }),
    );
    expect(loadStatsPrefs().overlaySoloScope).toBe("all");
  });

  it("migrates the legacy single-enum stats mode onto the battle dimension", () => {
    // A pre-split blob carries only the retired `overlayStatsMode`; each
    // value seeds the battle scope, and the normalized rewrite drops the
    // legacy key so it never comes back.
    const cases: [string, "follow" | "random" | "ranked" | "all"][] = [
      ["auto", "follow"],
      ["random", "random"],
      ["ranked", "ranked"],
      ["global", "all"],
    ];
    for (const [legacy, battle] of cases) {
      localStorage.setItem(
        STATS_PREFS_STORAGE_KEY,
        JSON.stringify({ overlayStatsMode: legacy }),
      );
      const prefs = loadStatsPrefs();
      expect(prefs.overlayBattleScope).toBe(battle);
      expect(prefs.overlayShipScope).toBe("all");
      expect(prefs.overlaySoloScope).toBe("all");
      expect(localStorage.getItem(STATS_PREFS_STORAGE_KEY)).not.toContain(
        "overlayStatsMode",
      );
    }
  });

  it("an explicit battle scope wins over the legacy seed", () => {
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({ overlayStatsMode: "ranked", overlayBattleScope: "all" }),
    );
    expect(loadStatsPrefs().overlayBattleScope).toBe("all");
  });
});

describe("statsPrefs store", () => {
  it("persists every knob and round-trips through storage", async () => {
    const store = useStatsPrefsStore();
    store.setPrEnabled(true);
    store.setPrAlgo("expected");
    store.setSealsEnabled(false);
    store.setLocalizedTiers(false);
    store.setWeightedTeamWr(false);
    store.setLiveRosterCompact(true);
    store.setPostbattleRosterFull(true);
    store.setTeamIntelEnabled(false);
    store.setOverlayChip("winrate", false);
    store.setOverlayChip("pr", true);
    store.setOverlayShipScope("ship");
    store.setOverlayBattleScope("ranked");
    store.setOverlaySoloScope("solo");
    store.setOverlayIntel("radar", false);
    store.setOverlayTeamAvg("pr", true);

    const raw = localStorage.getItem(STATS_PREFS_STORAGE_KEY);
    expect(raw).toBeTruthy();
    const expected = {
      prEnabled: true,
      prAlgo: "expected",
      sealsEnabled: false,
      localizedTiers: false,
      weightedTeamWr: false,
      liveRosterCompact: true,
      postbattleRosterFull: true,
      teamIntelEnabled: false,
      sealDisabled: {},
      overlayChips: {
        winrate: false,
        pr: true,
        battles: true,
        damage: true,
      },
      overlayShipScope: "ship",
      overlayBattleScope: "ranked",
      overlaySoloScope: "solo",
      overlayIntel: { radar: false, hydro: true, smoke: true },
      overlayTeamAvg: { winrate: false, pr: true, damage: false },
    };
    expect(JSON.parse(raw!)).toEqual(expected);
    // Same values read back through the pure loader (the round trip).
    expect(loadStatsPrefs()).toEqual(expected);
  });

  it("persists a per-seal toggle and round-trips it", async () => {
    const store = useStatsPrefsStore();
    store.setSealDisabled("air", true);
    store.setSealDisabled("rat", true);
    store.setSealDisabled("air", false);
    expect(loadStatsPrefs().sealDisabled).toEqual({ rat: true });
  });

  it("initializes state from persisted storage", async () => {
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({ prEnabled: true, prAlgo: "expected" }),
    );
    const { useStatsPrefsStore: useFresh, prAlgoForRequest: prAlgoFresh } =
      await freshModule();
    const store = useFresh();
    expect(store.prefs.prEnabled).toBe(true);
    expect(store.prefs.prAlgo).toBe("expected");
    // prAlgoForRequest mirrors the enabled state for RPC injection.
    expect(prAlgoFresh()).toBe("expected");
  });

  it("omits the RPC algorithm while the PR rating is off", async () => {
    const { useStatsPrefsStore: useFresh, prAlgoForRequest: prAlgoFresh } =
      await freshModule();
    const store = useFresh();
    // The rating ships ON now — the RPC param rides until it is turned off.
    expect(store.prefs.prEnabled).toBe(true);
    expect(prAlgoFresh()).toBe("winrate");
    store.setPrEnabled(false);
    expect(prAlgoFresh()).toBeUndefined();
  });
});
