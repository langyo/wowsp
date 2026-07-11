/**
 * WoWSP theme presets + CSS-var emission. Adapted from shittim-chest's
 * theme/presets.ts (simplified to 2 built-ins: dark default + light).
 * Each preset defines 16 RGB channel triples for `rgb(var(--color-x) / a%)`.
 */

export interface ThemeTokenRGB {
  primary: string;
  secondary: string;
  accent: string;
  text: string;
  muted: string;
  border: string;
  focusedBorder: string;
  background: string;
  surface: string;
  selectedBackground: string;
  selectedText: string;
  statusBarBackground: string;
  success: string;
  error: string;
  warning: string;
  info: string;
}

export type ThemeMode = "dark" | "light";

export interface ThemePreset {
  id: string;
  name: string;
  dark: ThemeTokenRGB;
  light: ThemeTokenRGB;
}

export const themePresets: Record<string, ThemePreset> = {
  ocean: {
    id: "ocean",
    name: "Ocean",
    dark: {
      primary: "0 120 200",
      secondary: "110 200 240",
      accent: "255 180 60",
      text: "220 228 238",
      muted: "150 160 175",
      border: "50 60 75",
      focusedBorder: "0 120 200",
      background: "12 18 30",
      surface: "22 30 46",
      selectedBackground: "0 120 200",
      selectedText: "255 255 255",
      statusBarBackground: "18 24 38",
      success: "60 180 120",
      error: "220 80 80",
      warning: "230 170 50",
      info: "90 160 220",
    },
    light: {
      primary: "0 100 180",
      secondary: "90 180 220",
      accent: "200 140 30",
      text: "30 40 55",
      muted: "90 100 115",
      border: "200 210 220",
      focusedBorder: "0 100 180",
      background: "245 248 252",
      surface: "255 255 255",
      selectedBackground: "0 100 180",
      selectedText: "255 255 255",
      statusBarBackground: "238 242 248",
      success: "40 160 100",
      error: "200 70 70",
      warning: "210 155 40",
      info: "70 150 210",
    },
  },
};

/** Emit `--color-*` CSS custom properties from a token set. */
export function tokensToCSSVars(tokens: ThemeTokenRGB): Record<string, string> {
  return {
    "--color-primary": tokens.primary,
    "--color-secondary": tokens.secondary,
    "--color-accent": tokens.accent,
    "--color-text": tokens.text,
    "--color-muted": tokens.muted,
    "--color-border": tokens.border,
    "--color-focused-border": tokens.focusedBorder,
    "--color-background": tokens.background,
    "--color-surface": tokens.surface,
    "--color-selected-bg": tokens.selectedBackground,
    "--color-selected-text": tokens.selectedText,
    "--color-status-bar-bg": tokens.statusBarBackground,
    "--color-success": tokens.success,
    "--color-error": tokens.error,
    "--color-warning": tokens.warning,
    "--color-info": tokens.info,
  };
}

export function getThemeTokens(presetId: string, mode: ThemeMode): ThemeTokenRGB {
  const preset = themePresets[presetId] ?? themePresets.ocean;
  return mode === "dark" ? preset.dark : preset.light;
}
