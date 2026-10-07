/** Wallpaper blur preference: storage round-trip, invalid-value fallback
 *  with heal-write, clamping to the 0–8 range, and the whole-value CSS
 *  vars on documentElement (the sidebar side always carries a blur() so
 *  the rail's backdrop layer never disappears; the main side drops to
 *  `none` at 0 so the no-blur paint stays free of the backdrop
 *  composite). The module initializes its refs at import time, so each
 *  case re-imports against freshly seeded storage. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  WALLPAPER_BLUR_MAIN_STORAGE_KEY,
  WALLPAPER_BLUR_SIDEBAR_STORAGE_KEY,
} from "./wallpaperBlur";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  document.documentElement.style.cssText = "";
});

async function freshModule() {
  return import("./wallpaperBlur");
}

describe("stored value", () => {
  it("defaults to 0 for both areas with no stored value", async () => {
    const { wallpaperSidebarBlurPx, wallpaperMainBlurPx } = await freshModule();
    expect(wallpaperSidebarBlurPx.value).toBe(0);
    expect(wallpaperMainBlurPx.value).toBe(0);
  });

  it("reads back stored px verbatim", async () => {
    localStorage.setItem(WALLPAPER_BLUR_SIDEBAR_STORAGE_KEY, "4");
    localStorage.setItem(WALLPAPER_BLUR_MAIN_STORAGE_KEY, "7");
    const { wallpaperSidebarBlurPx, wallpaperMainBlurPx } = await freshModule();
    expect(wallpaperSidebarBlurPx.value).toBe(4);
    expect(wallpaperMainBlurPx.value).toBe(7);
  });

  it("clamps an above-ceiling value to 8 — and heals it onto disk", async () => {
    localStorage.setItem(WALLPAPER_BLUR_SIDEBAR_STORAGE_KEY, "24");
    const { wallpaperSidebarBlurPx } = await freshModule();
    expect(wallpaperSidebarBlurPx.value).toBe(8);
    expect(localStorage.getItem(WALLPAPER_BLUR_SIDEBAR_STORAGE_KEY)).toBe("8");
  });

  it("clamps a below-floor value to 0 — and heals it onto disk", async () => {
    localStorage.setItem(WALLPAPER_BLUR_MAIN_STORAGE_KEY, "-3");
    const { wallpaperMainBlurPx } = await freshModule();
    expect(wallpaperMainBlurPx.value).toBe(0);
    expect(localStorage.getItem(WALLPAPER_BLUR_MAIN_STORAGE_KEY)).toBe("0");
  });

  it("falls back to 0 on garbage — and heals it onto disk", async () => {
    localStorage.setItem(WALLPAPER_BLUR_SIDEBAR_STORAGE_KEY, "crisp");
    const { wallpaperSidebarBlurPx } = await freshModule();
    expect(wallpaperSidebarBlurPx.value).toBe(0);
    expect(localStorage.getItem(WALLPAPER_BLUR_SIDEBAR_STORAGE_KEY)).toBe("0");
  });
});

describe("setters", () => {
  it("updates the refs, persists, and writes the whole-value CSS vars", async () => {
    const {
      setWallpaperSidebarBlurPx,
      setWallpaperMainBlurPx,
      wallpaperSidebarBlurPx,
      wallpaperMainBlurPx,
    } = await freshModule();
    setWallpaperSidebarBlurPx(6);
    setWallpaperMainBlurPx(3);
    expect(wallpaperSidebarBlurPx.value).toBe(6);
    expect(wallpaperMainBlurPx.value).toBe(3);
    expect(localStorage.getItem(WALLPAPER_BLUR_SIDEBAR_STORAGE_KEY)).toBe("6");
    expect(localStorage.getItem(WALLPAPER_BLUR_MAIN_STORAGE_KEY)).toBe("3");
    expect(document.documentElement.style.getPropertyValue("--wallpaper-blur-sidebar")).toBe(
      "blur(6px)",
    );
    expect(document.documentElement.style.getPropertyValue("--wallpaper-blur-main")).toBe(
      "blur(3px)",
    );
  });

  it("keeps the sidebar var a blur() at 0 while the main var drops to none", async () => {
    const { setWallpaperSidebarBlurPx, setWallpaperMainBlurPx } = await freshModule();
    setWallpaperSidebarBlurPx(0);
    setWallpaperMainBlurPx(0);
    expect(document.documentElement.style.getPropertyValue("--wallpaper-blur-sidebar")).toBe(
      "blur(0px)",
    );
    expect(document.documentElement.style.getPropertyValue("--wallpaper-blur-main")).toBe(
      "none",
    );
  });

  it("clamps and rounds what it is given", async () => {
    const { setWallpaperMainBlurPx, wallpaperMainBlurPx } = await freshModule();
    setWallpaperMainBlurPx(99);
    expect(wallpaperMainBlurPx.value).toBe(8);
    setWallpaperMainBlurPx(2.6);
    expect(wallpaperMainBlurPx.value).toBe(3);
    expect(localStorage.getItem(WALLPAPER_BLUR_MAIN_STORAGE_KEY)).toBe("3");
  });

  it("keeps the session choice when storage throws", async () => {
    const { setWallpaperSidebarBlurPx, wallpaperSidebarBlurPx } = await freshModule();
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    setWallpaperSidebarBlurPx(5);
    spy.mockRestore();
    expect(wallpaperSidebarBlurPx.value).toBe(5);
    expect(document.documentElement.style.getPropertyValue("--wallpaper-blur-sidebar")).toBe(
      "blur(5px)",
    );
  });
});

describe("initWallpaperBlurPreferences", () => {
  it("applies the stored values before first paint", async () => {
    localStorage.setItem(WALLPAPER_BLUR_SIDEBAR_STORAGE_KEY, "2");
    localStorage.setItem(WALLPAPER_BLUR_MAIN_STORAGE_KEY, "8");
    const { initWallpaperBlurPreferences } = await freshModule();
    initWallpaperBlurPreferences();
    expect(document.documentElement.style.getPropertyValue("--wallpaper-blur-sidebar")).toBe(
      "blur(2px)",
    );
    expect(document.documentElement.style.getPropertyValue("--wallpaper-blur-main")).toBe(
      "blur(8px)",
    );
  });
});
