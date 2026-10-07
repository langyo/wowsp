/** Wallpaper id migration + preset table: the built-in list is the art
 *  pair plus the pure-color preset, so stale ids must heal-write to the
 *  art default while builtin and custom file ids survive. Each case
 *  re-imports the module against freshly seeded storage
 *  (loadActiveWallpaperId reads at call time). */
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

  it("keeps the pure-color builtin id verbatim (it is NOT the default, but it is resolvable)", async () => {
    localStorage.setItem(STORAGE_BG_KEY, "PureColor");
    const { loadActiveWallpaperId } = await freshModule();
    expect(loadActiveWallpaperId()).toBe("PureColor");
    expect(localStorage.getItem(STORAGE_BG_KEY)).toBe("PureColor");
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

describe("preset table", () => {
  it("registers the pure-color preset as a builtin without making it the default", async () => {
    const {
      ART_WALLPAPER,
      BUILTIN_WALLPAPER_IDS,
      DEFAULT_WALLPAPER_ID,
      PURE_COLOR_WALLPAPER,
      PURE_COLOR_WALLPAPER_ID,
    } = await freshModule();
    expect(PURE_COLOR_WALLPAPER_ID).toBe("PureColor");
    expect(PURE_COLOR_WALLPAPER.id).toBe(PURE_COLOR_WALLPAPER_ID);
    expect(PURE_COLOR_WALLPAPER.source).toEqual({ type: "solid" });
    expect(DEFAULT_WALLPAPER_ID).toBe(ART_WALLPAPER.id);
    expect(DEFAULT_WALLPAPER_ID).not.toBe(PURE_COLOR_WALLPAPER_ID);
    expect(BUILTIN_WALLPAPER_IDS.has(ART_WALLPAPER.id)).toBe(true);
    expect(BUILTIN_WALLPAPER_IDS.has(PURE_COLOR_WALLPAPER_ID)).toBe(true);
  });

  it("names the art pair per theme side and other presets via the flat key", async () => {
    const { ART_WALLPAPER, PURE_COLOR_WALLPAPER, wallpaperNameKey } = await freshModule();
    expect(wallpaperNameKey(ART_WALLPAPER, "light")).toBe("settings.wallpaperArtLight");
    expect(wallpaperNameKey(ART_WALLPAPER, "dark")).toBe("settings.wallpaperArtDark");
    expect(wallpaperNameKey(PURE_COLOR_WALLPAPER, "light")).toBe(
      "settings.wallpaperPureColor",
    );
    expect(wallpaperNameKey(PURE_COLOR_WALLPAPER, "dark")).toBe(
      "settings.wallpaperPureColor",
    );
    expect(
      wallpaperNameKey({ id: "x", name: "literal", source: { type: "solid" } }, "light"),
    ).toBeUndefined();
  });
});
