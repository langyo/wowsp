/** Close-behavior store: the remembered close action, the junk sweep in its
 *  loader and the persistence round-trip. The module-level `closeActionState`
 *  ref hydrates from localStorage at import time, so cases that need a
 *  freshly seeded storage re-import the module (vi.resetModules) instead of
 *  trying to re-seed state that already exists. */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLOSE_ACTION_STORAGE_KEY,
  loadCloseAction,
  useCloseBehaviorStore,
} from "./closeBehavior";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  // The top-level import stays bound to the original module instance
  // (resetModules only affects later dynamic imports); a fresh pinia per
  // test is all the store needs.
  setActivePinia(createPinia());
});

async function freshModule() {
  const mod = await import("./closeBehavior");
  setActivePinia(createPinia());
  return mod;
}

describe("loadCloseAction", () => {
  it("returns \"ask\" when nothing is stored", () => {
    expect(loadCloseAction()).toBe("ask");
  });

  it("honours a stored concrete choice", () => {
    localStorage.setItem(CLOSE_ACTION_STORAGE_KEY, "minimize");
    expect(loadCloseAction()).toBe("minimize");
    localStorage.setItem(CLOSE_ACTION_STORAGE_KEY, "quit");
    expect(loadCloseAction()).toBe("quit");
  });

  it("sweeps a junk value off disk before falling back to \"ask\"", () => {
    localStorage.setItem(CLOSE_ACTION_STORAGE_KEY, "voodoo");
    expect(loadCloseAction()).toBe("ask");
    // Heal-write: the stale value must not survive, or it would re-fail on
    // every close instead of landing back on the ask dialog.
    expect(localStorage.getItem(CLOSE_ACTION_STORAGE_KEY)).toBeNull();
  });
});

describe("closeBehavior store", () => {
  it("persists a concrete action and clears the key for \"ask\"", () => {
    const store = useCloseBehaviorStore();
    store.setAction("quit");
    expect(store.action).toBe("quit");
    expect(localStorage.getItem(CLOSE_ACTION_STORAGE_KEY)).toBe("quit");
    // Same value read back through the pure loader (the round trip).
    expect(loadCloseAction()).toBe("quit");

    store.setAction("ask");
    expect(store.action).toBe("ask");
    // Absent IS the ask state — the sentinel is never written to storage.
    expect(localStorage.getItem(CLOSE_ACTION_STORAGE_KEY)).toBeNull();
    expect(loadCloseAction()).toBe("ask");
  });

  it("initializes state from persisted storage", async () => {
    localStorage.setItem(CLOSE_ACTION_STORAGE_KEY, "minimize");
    const { useCloseBehaviorStore: useFresh } = await freshModule();
    const store = useFresh();
    expect(store.action).toBe("minimize");
  });
});
