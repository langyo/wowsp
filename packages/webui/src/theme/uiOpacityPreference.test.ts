/** UI-opacity preference: storage round-trip, invalid-value fallback with
 *  heal-write, and the inline `--ui-opacity` override mechanism on
 *  documentElement. The module initializes its ref at import time, so each
 *  case re-imports against freshly seeded storage. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UI_OPACITY_STORAGE_KEY } from "./uiOpacityPreference";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  document.documentElement.style.cssText = "";
  delete document.documentElement.dataset.uiGlass;
});

async function freshModule() {
  return import("./uiOpacityPreference");
}

describe("stored value", () => {
  it("defaults to 95 (a hair clearer than fully solid) with no stored value", async () => {
    const { uiOpacityPercent } = await freshModule();
    expect(uiOpacityPercent.value).toBe(95);
  });

  it("reads back a stored percent verbatim", async () => {
    localStorage.setItem(UI_OPACITY_STORAGE_KEY, "140");
    const { uiOpacityPercent } = await freshModule();
    expect(uiOpacityPercent.value).toBe(140);
  });

  it("clamps a below-floor value to 0 — and heals it onto disk", async () => {
    localStorage.setItem(UI_OPACITY_STORAGE_KEY, "-20");
    const { uiOpacityPercent } = await freshModule();
    expect(uiOpacityPercent.value).toBe(0);
    expect(localStorage.getItem(UI_OPACITY_STORAGE_KEY)).toBe("0");
  });

  it("clamps an above-ceiling value to 200 — and heals it onto disk", async () => {
    localStorage.setItem(UI_OPACITY_STORAGE_KEY, "999");
    const { uiOpacityPercent } = await freshModule();
    expect(uiOpacityPercent.value).toBe(200);
    expect(localStorage.getItem(UI_OPACITY_STORAGE_KEY)).toBe("200");
  });

  it("falls back to 95 on garbage — and heals it onto disk", async () => {
    localStorage.setItem(UI_OPACITY_STORAGE_KEY, "glass");
    const { uiOpacityPercent } = await freshModule();
    expect(uiOpacityPercent.value).toBe(95);
    expect(localStorage.getItem(UI_OPACITY_STORAGE_KEY)).toBe("95");
  });
});

describe("setUiOpacityPercent", () => {
  it("updates the ref, persists, and writes the inline --ui-opacity", async () => {
    const { uiOpacityPercent, setUiOpacityPercent } = await freshModule();
    setUiOpacityPercent(60);
    expect(uiOpacityPercent.value).toBe(60);
    expect(localStorage.getItem(UI_OPACITY_STORAGE_KEY)).toBe("60");
    expect(document.documentElement.style.getPropertyValue("--ui-opacity")).toBe("0.60");
  });

  it("clamps and rounds what it is given", async () => {
    const { uiOpacityPercent, setUiOpacityPercent } = await freshModule();
    setUiOpacityPercent(300);
    expect(uiOpacityPercent.value).toBe(200);
    setUiOpacityPercent(57.6);
    expect(uiOpacityPercent.value).toBe(58);
    expect(localStorage.getItem(UI_OPACITY_STORAGE_KEY)).toBe("58");
  });

  it("keeps the session choice when storage throws", async () => {
    const { uiOpacityPercent, setUiOpacityPercent } = await freshModule();
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    setUiOpacityPercent(80);
    spy.mockRestore();
    expect(uiOpacityPercent.value).toBe(80);
    expect(document.documentElement.style.getPropertyValue("--ui-opacity")).toBe("0.80");
  });

  it("marks data-ui-glass only below the default percent", async () => {
    const { setUiOpacityPercent } = await freshModule();
    setUiOpacityPercent(94);
    expect(document.documentElement.hasAttribute("data-ui-glass")).toBe(true);
    setUiOpacityPercent(95);
    expect(document.documentElement.hasAttribute("data-ui-glass")).toBe(false);
    setUiOpacityPercent(150);
    expect(document.documentElement.hasAttribute("data-ui-glass")).toBe(false);
  });
});

describe("initUiOpacityPreference", () => {
  it("applies the stored value before first paint", async () => {
    localStorage.setItem(UI_OPACITY_STORAGE_KEY, "150");
    const { initUiOpacityPreference } = await freshModule();
    initUiOpacityPreference();
    expect(document.documentElement.style.getPropertyValue("--ui-opacity")).toBe("1.50");
  });
});
