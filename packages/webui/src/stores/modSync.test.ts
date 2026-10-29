/** Mod-sync store: the default-on preference, the junk sweep in its
 *  loader, the persistence round-trip and the absent-key-is-on encoding
 *  (same contract family as closeBehavior.test.ts). The module-level
 *  `modSyncState` ref hydrates from localStorage at import time, so
 *  cases that need a freshly seeded storage re-import the module
 *  (vi.resetModules) instead of re-seeding existing state. */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MOD_SYNC_STORAGE_KEY, loadModSyncEnabled } from "./modSync";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  // The top-level import stays bound to the original module instance
  // (resetModules only affects later dynamic imports); a fresh pinia per
  // test is all the store needs.
  setActivePinia(createPinia());
});

async function freshModule() {
  const mod = await import("./modSync");
  setActivePinia(createPinia());
  return mod;
}

describe("loadModSyncEnabled", () => {
  it("defaults to unified sync ON when nothing is stored", () => {
    expect(loadModSyncEnabled()).toBe(true);
  });

  it("honours a stored opt-out", () => {
    localStorage.setItem(MOD_SYNC_STORAGE_KEY, "off");
    expect(loadModSyncEnabled()).toBe(false);
  });

  it("sweeps a junk value off disk before falling back to ON", () => {
    localStorage.setItem(MOD_SYNC_STORAGE_KEY, "voodoo");
    expect(loadModSyncEnabled()).toBe(true);
    expect(localStorage.getItem(MOD_SYNC_STORAGE_KEY)).toBeNull();
  });
});

describe("useModSyncStore", () => {
  it("persists the opt-out and clears the slot when re-enabled", async () => {
    const { useModSyncStore: fresh } = await freshModule();
    const store = fresh();
    // Pinia setup stores unwrap refs on the store instance.
    expect(store.syncEnabled).toBe(true);

    store.toggleSync();
    expect(store.syncEnabled).toBe(false);
    expect(localStorage.getItem(MOD_SYNC_STORAGE_KEY)).toBe("off");

    store.setSyncEnabled(true);
    expect(store.syncEnabled).toBe(true);
    // ON is the absent-key default, never a written string.
    expect(localStorage.getItem(MOD_SYNC_STORAGE_KEY)).toBeNull();
  });

  it("hydrates the module-level state from a stored opt-out", async () => {
    localStorage.setItem(MOD_SYNC_STORAGE_KEY, "off");
    const { modSyncState, useModSyncStore: fresh } = await freshModule();
    expect(modSyncState.value).toBe(false);
    expect(fresh().syncEnabled).toBe(false);
  });
});
