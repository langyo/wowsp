/** Wallpaper id migration: the built-in list is art-only since the solid
 *  preset retired, so stale ids must heal-write to the art default while
 *  custom file ids survive. Each case re-imports the module against
 *  freshly seeded storage (loadActiveWallpaperId reads at call time). */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { STORAGE_BG_KEY } from "./wallpaper";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function freshModule() {
  return import("./wallpaper");
}

describe("loadActiveWallpaperId", () => {
  it("defaults to the art pair with no stored value", async () => {
    const { loadActiveWallpaperId, DEFAULT_WALLPAPER_ID } = await freshModule();
    expect(loadActiveWallpaperId()).toBe(DEFAULT_WALLPAPER_ID);
    expect(DEFAULT_WALLPAPER_ID).toBe("art-auto");
  });

  it("keeps the current default verbatim", async () => {
    localStorage.setItem(STORAGE_BG_KEY, "art-auto");
    const { loadActiveWallpaperId } = await freshModule();
    expect(loadActiveWallpaperId()).toBe("art-auto");
  });

  it("heals a retired solid-auto id onto the art default", async () => {
    localStorage.setItem(STORAGE_BG_KEY, "solid-auto");
    const { loadActiveWallpaperId } = await freshModule();
    expect(loadActiveWallpaperId()).toBe("art-auto");
    expect(localStorage.getItem(STORAGE_BG_KEY)).toBe("art-auto");
  });

  it("heals ids of removed presets and the dead custom list", async () => {
    localStorage.setItem(STORAGE_BG_KEY, "solid-black");
    const { loadActiveWallpaperId } = await freshModule();
    expect(loadActiveWallpaperId()).toBe("art-auto");
    expect(localStorage.getItem(STORAGE_BG_KEY)).toBe("art-auto");
  });

  it("keeps custom file ids (wallpaper-*) untouched", async () => {
    localStorage.setItem(STORAGE_BG_KEY, "wallpaper-1728012345123456789.png");
    const { loadActiveWallpaperId } = await freshModule();
    expect(loadActiveWallpaperId()).toBe("wallpaper-1728012345123456789.png");
    expect(localStorage.getItem(STORAGE_BG_KEY)).toBe("wallpaper-1728012345123456789.png");
  });
});
