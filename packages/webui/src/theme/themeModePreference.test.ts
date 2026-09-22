/** Theme-mode preference: storage migration, persistence, and the mapping
 *  onto hikari's mode (observable through hikari's own persisted key —
 *  hikari's setMode writes `hikari-theme-mode`, which is exactly what our
 *  apply step drives). The module initializes its ref at import time, so
 *  each case re-imports against freshly seeded storage.
 *
 *  The wallpaper composable is mocked: outside Tauri its active id always
 *  falls back to the solid preset, and solid pins the effective mode to
 *  dark — every mapping assertion would hide behind that override. The
 *  mock's isSolid ref is steered per case to exercise both branches. */
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { THEME_MODE_PREFERENCE_STORAGE_KEY } from "./themeModePreference";

const LEGACY_KEY = "hikari-theme-mode";

vi.mock("./useWallpaper", async () => {
  const { ref } = await import("vue");
  const isSolid = ref(true);
  return {
    useWallpaper: () => ({ isSolid }),
    // Test handle: the real composable only reaches an image wallpaper
    // with the Tauri filesystem behind it.
    __testIsSolid: isSolid,
  };
});

/** The mocked wallpaper state the freshly imported modules share. */
async function testIsSolid(): Promise<{ value: boolean }> {
  const mod = (await import("./useWallpaper")) as unknown as {
    __testIsSolid: { value: boolean };
  };
  return mod.__testIsSolid;
}

/** An image wallpaper is active — the stored preference maps through
 *  un-overridden. */
async function imageWallpaper() {
  (await testIsSolid()).value = false;
}

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  (await testIsSolid()).value = true;
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

  it("falls back to solar on a corrupt value — and heals it onto disk", async () => {
    localStorage.setItem(THEME_MODE_PREFERENCE_STORAGE_KEY, "fish");
    const { readStoredThemeModePreference } = await freshModule();
    expect(readStoredThemeModePreference()).toBe("solar");
    // Heal-write: the corrupt value is forced back to the default so the
    // fix sticks instead of re-defaulting on every boot.
    expect(localStorage.getItem(THEME_MODE_PREFERENCE_STORAGE_KEY)).toBe("solar");
  });
});

describe("setThemeModePreference", () => {
  it("persists the preference and drives hikari's mode", async () => {
    await imageWallpaper();
    const { setThemeModePreference, themeModePreference } = await freshModule();
    setThemeModePreference("dark");
    expect(themeModePreference.value).toBe("dark");
    expect(localStorage.getItem(THEME_MODE_PREFERENCE_STORAGE_KEY)).toBe("dark");
    // hikari's own persisted mode mirrors the mapping (dark → dark).
    expect(localStorage.getItem(LEGACY_KEY)).toBe("dark");
  });

  it("maps solar onto hikari's sun-following 'system' mode", async () => {
    await imageWallpaper();
    const { setThemeModePreference } = await freshModule();
    setThemeModePreference("solar");
    expect(localStorage.getItem(LEGACY_KEY)).toBe("system");
  });

  it("maps light verbatim", async () => {
    await imageWallpaper();
    const { setThemeModePreference } = await freshModule();
    setThemeModePreference("light");
    expect(localStorage.getItem(LEGACY_KEY)).toBe("light");
    // Re-applying the same preference does not churn hikari's key.
    setThemeModePreference("light");
    expect(localStorage.getItem(LEGACY_KEY)).toBe("light");
  });

  it("overrides every preference with dark while a solid wallpaper is active", async () => {
    const { setThemeModePreference } = await freshModule();
    setThemeModePreference("solar");
    expect(localStorage.getItem(LEGACY_KEY)).toBe("dark");
    setThemeModePreference("light");
    expect(localStorage.getItem(LEGACY_KEY)).toBe("dark");
    // The override is presentation-only: the stored key keeps the true
    // preference so an image wallpaper restores it verbatim.
    expect(localStorage.getItem(THEME_MODE_PREFERENCE_STORAGE_KEY)).toBe("light");
  });
});

describe("initThemeModePreference", () => {
  it("applies the stored preference over whatever hikari restored", async () => {
    await imageWallpaper();
    // Simulate a boot where hikari restored "light" (its own last state)
    // but our authoritative key says dark.
    localStorage.setItem(LEGACY_KEY, "light");
    localStorage.setItem(THEME_MODE_PREFERENCE_STORAGE_KEY, "dark");
    const { initThemeModePreference } = await freshModule();
    initThemeModePreference();
    expect(localStorage.getItem(LEGACY_KEY)).toBe("dark");
  });

  it("re-applies when the wallpaper flips between image and solid", async () => {
    const isSolid = await testIsSolid();
    await imageWallpaper();
    localStorage.setItem(THEME_MODE_PREFERENCE_STORAGE_KEY, "light");
    const { initThemeModePreference } = await freshModule();
    initThemeModePreference();
    expect(localStorage.getItem(LEGACY_KEY)).toBe("light");

    // Switching to the solid background forces dark; switching back
    // restores the stored preference. The watcher flushes on microtask.
    isSolid.value = true;
    await nextTick();
    expect(localStorage.getItem(LEGACY_KEY)).toBe("dark");
    isSolid.value = false;
    await nextTick();
    expect(localStorage.getItem(LEGACY_KEY)).toBe("light");
  });
});
