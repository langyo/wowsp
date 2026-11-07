/**
 * stores/perfHud — the session-only perf HUD switch. Pins the contract
 * that fixes the v0.6.9 incident: the default follows the build flavor
 * (dev on / release off), the toggle flips either way, and NOTHING is
 * persisted — the old stored `wowsp.perf` flag could be set by support
 * tooling but never cleared from a packaged build, which kept the overlay
 * stuck on across releases.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { usePerfHudStore } from "./perfHud";

/** Fresh pinia AFTER the env stub — the build default is read when the
 *  store's setup first runs (first usePerfHudStore() on the active
 *  pinia), so stub-then-create is what pins each flavor. */
function freshStoreAfterStub(dev: boolean): ReturnType<typeof usePerfHudStore> {
  vi.stubEnv("DEV", dev);
  setActivePinia(createPinia());
  return usePerfHudStore();
}

describe("usePerfHudStore", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllEnvs();
  });

  it("defaults on under a dev build", () => {
    expect(freshStoreAfterStub(true).enabled).toBe(true);
  });

  it("defaults off under a production build", () => {
    expect(freshStoreAfterStub(false).enabled).toBe(false);
  });

  it("the toggle flips either way for the current session", () => {
    const store = freshStoreAfterStub(false);
    store.setEnabled(true);
    expect(store.enabled).toBe(true);
    store.setEnabled(false);
    expect(store.enabled).toBe(false);
  });

  it("never persists — no localStorage write, ever", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const store = freshStoreAfterStub(true);
    store.setEnabled(false);
    store.setEnabled(true);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem("wowsp.perf")).toBeNull();
  });
});
