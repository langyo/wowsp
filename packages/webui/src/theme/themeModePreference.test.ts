/** Theme-mode preference: storage migration, persistence, and the mapping
 *  onto hikari's mode (observable through hikari's own persisted key —
 *  hikari's setMode writes `hikari-theme-mode`, which is exactly what our
 *  apply step drives). The module initializes its ref at import time, so
 *  each case re-imports against freshly seeded storage. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { THEME_MODE_PREFERENCE_STORAGE_KEY } from "./themeModePreference";

const LEGACY_KEY = "hikari-theme-mode";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function freshModule() {
  return import("./themeModePreference");
}

describe("readStoredThemeModePreference", () => {
  it("defaults to solar (daylight-following) with no stored value", async () => {
    const { readStoredThemeModePreference } = await freshModule();
    expect(readStoredThemeModePreference()).toBe("solar");
  });

  it("migrates hikari's legacy dark/light verbatim and writes the new key", async () => {
    localStorage.setItem(LEGACY_KEY, "dark");
    const { readStoredThemeModePreference } = await freshModule();
    expect(readStoredThemeModePreference()).toBe("dark");
    expect(localStorage.getItem(THEME_MODE_PREFERENCE_STORAGE_KEY)).toBe("dark");

    localStorage.clear();
    localStorage.setItem(LEGACY_KEY, "light");
    const again = await freshModule();
    expect(again.readStoredThemeModePreference()).toBe("light");
  });

  it("maps hikari's legacy 'system' onto solar — legacy 'system' meant daylight here", async () => {
    localStorage.setItem(LEGACY_KEY, "system");
    const { readStoredThemeModePreference } = await freshModule();
    expect(readStoredThemeModePreference()).toBe("solar");
    expect(localStorage.getItem(THEME_MODE_PREFERENCE_STORAGE_KEY)).toBe("solar");
  });

  it("migrates the retired wowsp-side 'system' value onto solar", async () => {
    localStorage.setItem(THEME_MODE_PREFERENCE_STORAGE_KEY, "system");
    const { readStoredThemeModePreference } = await freshModule();
    expect(readStoredThemeModePreference()).toBe("solar");
    expect(localStorage.getItem(THEME_MODE_PREFERENCE_STORAGE_KEY)).toBe("solar");
  });

  it("keeps the new key authoritative once written and ignores the legacy one", async () => {
    localStorage.setItem(THEME_MODE_PREFERENCE_STORAGE_KEY, "light");
    localStorage.setItem(LEGACY_KEY, "dark");
    const { readStoredThemeModePreference } = await freshModule();
    expect(readStoredThemeModePreference()).toBe("light");
  });

  it("falls back to solar on a corrupt value", async () => {
    localStorage.setItem(THEME_MODE_PREFERENCE_STORAGE_KEY, "fish");
    const { readStoredThemeModePreference } = await freshModule();
    expect(readStoredThemeModePreference()).toBe("solar");
  });
});

describe("setThemeModePreference", () => {
  it("persists the preference and drives hikari's mode", async () => {
    const { setThemeModePreference, themeModePreference } = await freshModule();
    setThemeModePreference("dark");
    expect(themeModePreference.value).toBe("dark");
    expect(localStorage.getItem(THEME_MODE_PREFERENCE_STORAGE_KEY)).toBe("dark");
    // hikari's own persisted mode mirrors the mapping (dark → dark).
    expect(localStorage.getItem(LEGACY_KEY)).toBe("dark");
  });

  it("maps solar onto hikari's sun-following 'system' mode", async () => {
    const { setThemeModePreference } = await freshModule();
    setThemeModePreference("solar");
    expect(localStorage.getItem(LEGACY_KEY)).toBe("system");
  });

  it("maps light verbatim", async () => {
    const { setThemeModePreference } = await freshModule();
    setThemeModePreference("light");
    expect(localStorage.getItem(LEGACY_KEY)).toBe("light");
    // Re-applying the same preference does not churn hikari's key.
    setThemeModePreference("light");
    expect(localStorage.getItem(LEGACY_KEY)).toBe("light");
  });
});

describe("initThemeModePreference", () => {
  it("applies the stored preference over whatever hikari restored", async () => {
    // Simulate a boot where hikari restored "light" (its own last state)
    // but our authoritative key says dark.
    localStorage.setItem(LEGACY_KEY, "light");
    localStorage.setItem(THEME_MODE_PREFERENCE_STORAGE_KEY, "dark");
    const { initThemeModePreference } = await freshModule();
    initThemeModePreference();
    expect(localStorage.getItem(LEGACY_KEY)).toBe("dark");
  });
});
