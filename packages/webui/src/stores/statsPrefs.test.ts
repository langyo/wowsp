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
    // PR rating ships opt-out; the fun wording and seals ship on.
    expect(DEFAULT_STATS_PREFS).toEqual({
      prEnabled: false,
      prAlgo: "winrate",
      sealsEnabled: true,
      localizedTiers: true,
      sealDisabled: {},
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

  it("fills missing fields with defaults instead of dropping the blob", () => {
    localStorage.setItem(STATS_PREFS_STORAGE_KEY, JSON.stringify({ prEnabled: true }));
    const prefs = loadStatsPrefs();
    expect(prefs.prEnabled).toBe(true);
    expect(prefs.prAlgo).toBe("winrate");
    expect(prefs.sealsEnabled).toBe(true);
    expect(prefs.localizedTiers).toBe(true);
    expect(prefs.sealDisabled).toEqual({});
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

  it("rejects an unknown algorithm value", () => {
    localStorage.setItem(
      STATS_PREFS_STORAGE_KEY,
      JSON.stringify({ prEnabled: true, prAlgo: "voodoo" }),
    );
    expect(loadStatsPrefs().prAlgo).toBe("winrate");
  });
});

describe("statsPrefs store", () => {
  it("persists every knob and round-trips through storage", async () => {
    const store = useStatsPrefsStore();
    store.setPrEnabled(true);
    store.setPrAlgo("expected");
    store.setSealsEnabled(false);
    store.setLocalizedTiers(false);

    const raw = localStorage.getItem(STATS_PREFS_STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual({
      prEnabled: true,
      prAlgo: "expected",
      sealsEnabled: false,
      localizedTiers: false,
      sealDisabled: {},
    });
    // Same values read back through the pure loader (the round trip).
    expect(loadStatsPrefs()).toEqual({
      prEnabled: true,
      prAlgo: "expected",
      sealsEnabled: false,
      localizedTiers: false,
      sealDisabled: {},
    });
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
    expect(store.prefs.prEnabled).toBe(false);
    expect(prAlgoFresh()).toBeUndefined();
    store.setPrEnabled(true);
    expect(prAlgoFresh()).toBe("winrate");
  });
});
