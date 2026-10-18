/** Stats-prefs store: defaults, persistence round-trip, corrupt-storage
 *  tolerance and the live-change broadcast the Tab overlay refreshes
 *  through. The module-level `statsPrefsState` ref initializes from
 *  localStorage at import time, so every case re-imports the module against
 *  a freshly seeded storage (vi.resetModules) instead of trying to re-seed
 *  state that already exists. */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_STATS_PREFS,
  STATS_PREFS_STORAGE_KEY,
  loadStatsPrefs,
  overlayColumnsAreDefault,
  useStatsPrefsStore,
} from "./statsPrefs";

// The Tauri event bus, mocked: persist() dynamically imports the event
// module only inside a Tauri webview, and this factory answers that
// import. hoisted so the factory and the assertions share one fn.
const { emitMock } = vi.hoisted(() => ({ emitMock: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: emitMock }));

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  // The top-level import stays bound to the original module instance
  // (resetModules only affects later dynamic imports); a fresh pinia per
  // test is all the store needs.
  setActivePinia(createPinia());
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  emitMock.mockClear();
});

async function freshModule() {
  const mod = await import("./statsPrefs");
  setActivePinia(createPinia());
  return mod;
}

describe("loadStatsPrefs", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(loadStatsPrefs()).toEqual(DEFAULT_STATS_PREFS);
    // The PR rating and the four shipped stat columns (global winrate /
    // PR / battles / avg damage) ship on; the fun wording, seals and the
    // tier-weighted team winrate ship on. Team averages ship off (dense
    // already). Both roster-density overrides ship off: full cards on the
    // live panel and compact rows post-battle are the defaults. The
    // PR-tier row wash ships on.
    expect(DEFAULT_STATS_PREFS).toEqual({
      prEnabled: true,
      prAlgo: "winrate",
      sealsEnabled: true,
      localizedTiers: true,
      weightedTeamWr: true,
      liveRosterCompact: false,
      liveRosterPrTint: true,
      postbattleRosterFull: false,
      teamIntelEnabled: true,
      sealDisabled: {},
      overlayColumns: [
        { scope: "global", metric: "winrate" },
        { scope: "global", metric: "pr" },
        { scope: "global", metric: "battles" },
        { scope: "global", metric: "damage" },
      ],
      // The aim crosshair panel ships with the three most-glanceable
      // career numbers (winrate / PR / battles) — one narrower than the
      // roster default.
      aimColumns: [
        { scope: "global", metric: "winrate" },
        { scope: "global", metric: "pr" },
        { scope: "global", metric: "battles" },
      ],
      overlayBattleScope: "follow",
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

  it("migrates the legacy avg-stats switch into empty columns when off", () => {
    // A pre-overlayChips blob: avgStatsEnabled seeded the whole shipped
    // chip set, and the normalized rewrite drops the legacy key so it
    // never comes back.
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({ prEnabled: true, avgStatsEnabled: false }),
    );
    expect(loadStatsPrefs()).toEqual({
      ...DEFAULT_STATS_PREFS,
      prEnabled: true,
      overlayColumns: [],
    });
    expect(localStorage.getItem(STATS_PREFS_STORAGE_KEY)).not.toContain(
      "avgStatsEnabled",
    );

    // The ON legacy value keeps the shipped columns.
    localStorage.setItem(STATS_PREFS_STORAGE_KEY, JSON.stringify({ avgStatsEnabled: true }));
    expect(loadStatsPrefs().overlayColumns).toEqual(
      DEFAULT_STATS_PREFS.overlayColumns,
    );
  });

  it("migrates the retired chip toggles + ship/solo dims into scoped columns", () => {
    // A pre-columns blob: every enabled chip becomes a column of the scope
    // the retired dims mapped onto, in that build's render order.
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({
        overlayChips: { winrate: true, pr: true, battles: true, damage: false },
        overlayShipScope: "ship",
        overlaySoloScope: "all",
      }),
    );
    expect(loadStatsPrefs().overlayColumns).toEqual([
      { scope: "ship", metric: "winrate" },
      { scope: "ship", metric: "pr" },
      { scope: "ship", metric: "battles" },
    ]);
    // The normalized rewrite drops the retired keys so they never come
    // back.
    expect(localStorage.getItem(STATS_PREFS_STORAGE_KEY)).not.toContain(
      "overlayChips",
    );

    // Solo wins over the ship dim (the retired model's precedence, kept).
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({
        overlayChips: { winrate: true, pr: false, battles: false, damage: true },
        overlayShipScope: "tier",
        overlaySoloScope: "solo",
      }),
    );
    expect(loadStatsPrefs().overlayColumns).toEqual([
      { scope: "solo", metric: "winrate" },
      { scope: "solo", metric: "damage" },
    ]);

    // "tier" has no column scope — it falls back to the account career.
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({ overlayChips: { battles: true } }),
    );
    expect(loadStatsPrefs().overlayColumns).toEqual([
      { scope: "global", metric: "battles" },
    ]);

    // An explicit columns list always wins over the legacy seed.
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({
        overlayChips: { winrate: true },
        overlayColumns: [{ scope: "class", metric: "damage" }],
      }),
    );
    expect(loadStatsPrefs().overlayColumns).toEqual([
      { scope: "class", metric: "damage" },
    ]);
  });

  it("drops junk entries, duplicates and over-limit tails in the column list", () => {
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({
        overlayColumns: [
          { scope: "global", metric: "winrate" },
          { scope: "voodoo", metric: "pr" },
          { scope: "ship", metric: "bogus" },
          "junk",
          null,
          { scope: "solo", metric: "winrate" },
          { scope: "global", metric: "winrate" },
          { scope: "ship", metric: "winrate" },
          { scope: "class", metric: "winrate" },
          { scope: "global", metric: "pr" },
          { scope: "global", metric: "battles" },
          { scope: "global", metric: "damage" },
        ],
      }),
    );
    expect(loadStatsPrefs().overlayColumns).toEqual([
      { scope: "global", metric: "winrate" },
      { scope: "solo", metric: "winrate" },
      { scope: "ship", metric: "winrate" },
      { scope: "class", metric: "winrate" },
      { scope: "global", metric: "pr" },
    ]);
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
    expect(prefs.overlayColumns).toEqual(DEFAULT_STATS_PREFS.overlayColumns);
    // A pre-aim-panel blob takes the shipped aim default (no legacy seed
    // exists for the crosshair list), and the heal-write persists it.
    expect(prefs.aimColumns).toEqual(DEFAULT_STATS_PREFS.aimColumns);
    expect(prefs.overlayBattleScope).toBe("follow");
    expect(prefs.overlayIntel).toEqual(DEFAULT_STATS_PREFS.overlayIntel);
    expect(prefs.overlayTeamAvg).toEqual(DEFAULT_STATS_PREFS.overlayTeamAvg);
  });

  it("keeps an explicitly empty aimColumns list (it hides the panel)", () => {
    localStorage.setItem(STATS_PREFS_STORAGE_KEY, JSON.stringify({ aimColumns: [] }));
    expect(loadStatsPrefs().aimColumns).toEqual([]);
  });

  it("drops junk entries, non-global scopes, duplicates and over-limit tails in the aim column list", () => {
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({
        aimColumns: [
          { scope: "global", metric: "winrate" },
          { scope: "voodoo", metric: "pr" },
          // The bridge's v1 protocol answers "global" only — a
          // hand-edited scoped entry drops out here (never pushed), same
          // as a junk shape.
          { scope: "solo", metric: "winrate" },
          "junk",
          null,
          { scope: "global", metric: "winrate" },
          { scope: "global", metric: "pr" },
          { scope: "global", metric: "battles" },
          { scope: "global", metric: "damage" },
          { scope: "class", metric: "damage" },
        ],
      }),
    );
    expect(loadStatsPrefs().aimColumns).toEqual([
      { scope: "global", metric: "winrate" },
      { scope: "global", metric: "pr" },
      { scope: "global", metric: "battles" },
      { scope: "global", metric: "damage" },
    ]);
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
        overlayIntel: { radar: false, smoke: true, sonar: true },
        overlayTeamAvg: { pr: true, damage: true, karma: true },
      }),
    );
    const prefs = loadStatsPrefs();
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

describe("overlayColumnsAreDefault", () => {
  it("matches only the shipped four global columns", () => {
    expect(overlayColumnsAreDefault(DEFAULT_STATS_PREFS.overlayColumns)).toBe(true);
    // Reordered → not default (the chip's customized face keys on this).
    const reordered = [...DEFAULT_STATS_PREFS.overlayColumns].reverse();
    expect(overlayColumnsAreDefault(reordered)).toBe(false);
    // Scoped / added / removed → not default.
    expect(
      overlayColumnsAreDefault([{ scope: "ship", metric: "winrate" }]),
    ).toBe(false);
    expect(overlayColumnsAreDefault([])).toBe(false);
    expect(
      overlayColumnsAreDefault([
        ...DEFAULT_STATS_PREFS.overlayColumns,
        { scope: "solo", metric: "battles" },
      ]),
    ).toBe(false);
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
    store.setLiveRosterPrTint(false);
    store.setPostbattleRosterFull(true);
    store.setTeamIntelEnabled(false);
    store.setOverlayColumns([
      { scope: "solo", metric: "winrate" },
      { scope: "ship", metric: "pr" },
      { scope: "class", metric: "damage" },
    ]);
    store.setAimColumns([
      { scope: "global", metric: "damage" },
      { scope: "global", metric: "winrate" },
    ]);
    store.setOverlayBattleScope("ranked");
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
      liveRosterPrTint: false,
      postbattleRosterFull: true,
      teamIntelEnabled: false,
      sealDisabled: {},
      overlayColumns: [
        { scope: "solo", metric: "winrate" },
        { scope: "ship", metric: "pr" },
        { scope: "class", metric: "damage" },
      ],
      aimColumns: [
        { scope: "global", metric: "damage" },
        { scope: "global", metric: "winrate" },
      ],
      overlayBattleScope: "ranked",
      overlayIntel: { radar: false, hydro: true, smoke: true },
      overlayTeamAvg: { winrate: false, pr: true, damage: false },
    };
    expect(JSON.parse(raw!)).toEqual(expected);
    // Same values read back through the pure loader (the round trip).
    expect(loadStatsPrefs()).toEqual(expected);
  });

  it("silently rejects a duplicate or over-limit column write", async () => {
    const store = useStatsPrefsStore();
    const before = store.prefs.overlayColumns;
    // A duplicate combo never lands (the editor prevents it; this is the
    // hand-edited-state guard).
    store.setOverlayColumns([...before, before[0]]);
    expect(store.prefs.overlayColumns).toEqual(before);
  });

  it("silently rejects a duplicate or over-limit AIM column write, keeps an empty one", async () => {
    const store = useStatsPrefsStore();
    const before = store.prefs.aimColumns;
    store.setAimColumns([...before, before[0]]);
    expect(store.prefs.aimColumns).toEqual(before);
    // The aim list allows a FIFTH roster column's worth of junk in, but
    // not past its own (narrower) limit.
    store.setAimColumns([
      { scope: "global", metric: "winrate" },
      { scope: "global", metric: "pr" },
      { scope: "global", metric: "battles" },
      { scope: "global", metric: "damage" },
      { scope: "solo", metric: "winrate" },
    ]);
    expect(store.prefs.aimColumns).toEqual(before);
    // Emptying the list is the shipped way to HIDE the panel — a valid
    // write that must land (and persist).
    store.setAimColumns([]);
    expect(store.prefs.aimColumns).toEqual([]);
    expect(loadStatsPrefs().aimColumns).toEqual([]);
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

  it("broadcasts the prefs-changed event after a write inside the Tauri shell", async () => {
    // The Tab overlay listens for exactly this event to re-read the blob
    // live (overlay/main.ts's refreshPrefs) — the one channel between the
    // windows, which share localStorage but not Pinia state.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const { useStatsPrefsStore: useFresh } = await freshModule();
    useFresh().setOverlayBattleScope("ranked");
    // The broadcast dynamically imports the event module — let that
    // microtask land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emitMock).toHaveBeenCalledWith("wowsp://stats-prefs-changed");
  });

  it("does not broadcast outside the Tauri shell", async () => {
    const { useStatsPrefsStore: useFresh } = await freshModule();
    useFresh().setOverlayBattleScope("ranked");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emitMock).not.toHaveBeenCalled();
  });
});
