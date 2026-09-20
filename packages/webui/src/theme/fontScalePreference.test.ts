/** Font-scale preference: storage round-trip, invalid-value fallback, and
 *  the inline `--text-*` override mechanism (observable through
 *  documentElement's inline style + dataset). The module initializes its
 *  ref at import time, so each case re-imports against freshly seeded
 *  storage. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FONT_SCALE_STORAGE_KEY,
} from "./fontScalePreference";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  document.documentElement.style.cssText = "";
  delete document.documentElement.dataset.fontScale;
});

async function freshModule() {
  return import("./fontScalePreference");
}

describe("readStoredFontScaleLevel", () => {
  it("defaults to 0 (stylesheets rule) with no stored value", async () => {
    const { readStoredFontScaleLevel } = await freshModule();
    expect(readStoredFontScaleLevel()).toBe(0);
  });

  it("reads back every stored level verbatim", async () => {
    for (const level of [-2, -1, 1, 2]) {
      localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(level));
      const { readStoredFontScaleLevel } = await freshModule();
      expect(readStoredFontScaleLevel()).toBe(level);
    }
  });

  it("falls back to 0 on a corrupt or out-of-range value", async () => {
    for (const raw of ["fish", "3", "-3", "1.5", ""]) {
      localStorage.setItem(FONT_SCALE_STORAGE_KEY, raw);
      const { readStoredFontScaleLevel } = await freshModule();
      expect(readStoredFontScaleLevel()).toBe(0);
    }
  });
});

describe("setFontScaleLevel", () => {
  it("persists the level and applies inline calc() overrides", async () => {
    const { setFontScaleLevel, fontScaleLevel } = await freshModule();
    setFontScaleLevel(1);
    expect(fontScaleLevel.value).toBe(1);
    expect(localStorage.getItem(FONT_SCALE_STORAGE_KEY)).toBe("1");
    const el = document.documentElement;
    expect(el.style.getPropertyValue("--text-base")).toBe(
      "calc(0.875rem * 1.1)",
    );
    expect(el.style.getPropertyValue("--text-lg")).toBe(
      "calc(1.125rem * 1.1)",
    );
    expect(el.dataset.fontScale).toBe("1");
  });

  it("shrinks every token at a negative level", async () => {
    const { setFontScaleLevel } = await freshModule();
    setFontScaleLevel(-2);
    const el = document.documentElement;
    expect(el.style.getPropertyValue("--text-sm")).toBe(
      "calc(0.8125rem * 0.8)",
    );
    expect(el.dataset.fontScale).toBe("-2");
  });

  it("level 0 removes the inline overrides and the dataset marker", async () => {
    localStorage.setItem(FONT_SCALE_STORAGE_KEY, "2");
    const { setFontScaleLevel } = await freshModule();
    setFontScaleLevel(0);
    const el = document.documentElement;
    expect(el.style.getPropertyValue("--text-base")).toBe("");
    expect(el.style.getPropertyValue("--text-lg")).toBe("");
    expect(el.dataset.fontScale).toBeUndefined();
    expect(localStorage.getItem(FONT_SCALE_STORAGE_KEY)).toBe("0");
  });
});

describe("initFontScalePreference", () => {
  it("applies the stored level at boot", async () => {
    localStorage.setItem(FONT_SCALE_STORAGE_KEY, "2");
    const { initFontScalePreference } = await freshModule();
    initFontScalePreference();
    const el = document.documentElement;
    expect(el.style.getPropertyValue("--text-base")).toBe(
      "calc(0.875rem * 1.2)",
    );
    expect(el.dataset.fontScale).toBe("2");
  });

  it("clears stale inline overrides when the stored level is 0", async () => {
    document.documentElement.style.setProperty("--text-base", "999px");
    const { initFontScalePreference } = await freshModule();
    initFontScalePreference();
    const el = document.documentElement;
    expect(el.style.getPropertyValue("--text-base")).toBe("");
    expect(el.dataset.fontScale).toBeUndefined();
  });
});
