import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyModeTokens } from "./modeTokens";

/** hikari's theme state is module-global; the fake keeps the surface the
 *  bridge touches (currentTheme/effectiveMode refs + the preset table). */
const state = vi.hoisted(() => {
  return {
    currentTheme: { value: "default" },
    effectiveMode: { value: "dark" as "dark" | "light" },
  };
});

vi.mock("@celestia-island/hikari", () => {
  const nordDark = {
    background: { r: 22, g: 27, b: 38 },
    surface: { r: 34, g: 40, b: 54 },
    text: { r: 247, g: 249, b: 252 },
    primary: { r: 136, g: 192, b: 208 },
  };
  const nordLight = {
    background: { r: 236, g: 239, b: 244 },
    surface: { r: 255, g: 255, b: 255 },
    text: { r: 46, g: 52, b: 64 },
    primary: { r: 136, g: 192, b: 208 },
  };
  const preset = { id: "default", dark: nordDark, light: nordLight };
  return {
    themePresets: { default: preset },
    getThemeTokens: (_id: string, mode: "dark" | "light") =>
      mode === "dark" ? nordDark : nordLight,
    tokensToCSSVars: (tokens: Record<string, { r: number; g: number; b: number }>) => ({
      "--color-background": `${tokens.background.r} ${tokens.background.g} ${tokens.background.b}`,
      "--color-surface": `${tokens.surface.r} ${tokens.surface.g} ${tokens.surface.b}`,
      "--color-text": `${tokens.text.r} ${tokens.text.g} ${tokens.text.b}`,
      "--color-primary": `${tokens.primary.r} ${tokens.primary.g} ${tokens.primary.b}`,
    }),
    useTheme: () => state,
  };
});

describe("applyModeTokens", () => {
  beforeEach(() => {
    document.documentElement.style.cssText = "";
    state.currentTheme.value = "default";
    state.effectiveMode.value = "dark";
  });

  it("writes the resolved dark palette as inline styles on <html>", () => {
    applyModeTokens();
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--color-background")).toBe("22 27 38");
    expect(style.getPropertyValue("--color-surface")).toBe("34 40 54");
    expect(style.getPropertyValue("--color-text")).toBe("247 249 252");
  });

  it("re-applies with the light palette after the mode flips", () => {
    applyModeTokens();
    state.effectiveMode.value = "light";
    applyModeTokens();
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--color-background")).toBe("236 239 244");
    expect(style.getPropertyValue("--color-surface")).toBe("255 255 255");
  });

  it("is a no-op without a resolvable theme id", () => {
    state.currentTheme.value = "";
    const before = document.documentElement.style.cssText;
    applyModeTokens();
    expect(document.documentElement.style.cssText).toBe(before);
  });
});
