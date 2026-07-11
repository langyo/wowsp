/**
 * WoWSP theme presets + CSS-var emission. Adapted from shittim-chest's
 * theme/presets.ts. Each preset defines dark + light RGB channel triples for
 * `rgb(var(--color-x) / a%)` opacity syntax.
 *
 * Four built-in presets: ocean (default, naval blue), nord (cool slate),
 * gruvbox (warm), tokyonight (deep purple-blue). Mode "system" resolves via
 * solar altitude (see useSolarTime.ts).
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

export type ThemeMode = "system" | "dark" | "light";
export type EffectiveMode = "dark" | "light";

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
  nord: {
    id: "nord",
    name: "Nord",
    dark: {
      primary: "136 192 208",
      secondary: "143 188 187",
      accent: "235 203 139",
      text: "236 239 244",
      muted: "128 138 153",
      border: "67 76 94",
      focusedBorder: "136 192 208",
      background: "35 40 52",
      surface: "52 59 74",
      selectedBackground: "94 129 172",
      selectedText: "236 239 244",
      statusBarBackground: "40 45 58",
      success: "163 190 140",
      error: "191 97 106",
      warning: "235 203 139",
      info: "136 192 208",
    },
    light: {
      primary: "94 129 172",
      secondary: "143 188 187",
      accent: "180 142 173",
      text: "46 52 64",
      muted: "94 105 117",
      border: "202 211 219",
      focusedBorder: "94 129 172",
      background: "236 239 244",
      surface: "229 233 240",
      selectedBackground: "94 129 172",
      selectedText: "236 239 244",
      statusBarBackground: "229 233 240",
      success: "163 190 140",
      error: "191 97 106",
      warning: "208 135 112",
      info: "94 129 172",
    },
  },
  gruvbox: {
    id: "gruvbox",
    name: "Gruvbox",
    dark: {
      primary: "214 168 104",
      secondary: "208 135 112",
      accent: "184 187 38",
      text: "235 219 178",
      muted: "146 131 116",
      border: "80 73 69",
      focusedBorder: "214 168 104",
      background: "40 40 40",
      surface: "60 56 54",
      selectedBackground: "214 168 104",
      selectedText: "40 40 40",
      statusBarBackground: "50 48 47",
      success: "152 151 26",
      error: "251 73 52",
      warning: "250 189 47",
      info: "69 133 136",
    },
    light: {
      primary: "175 135 5",
      secondary: "177 98 52",
      accent: "121 116 14",
      text: "60 56 54",
      muted: "146 131 116",
      border: "189 174 138",
      focusedBorder: "175 135 5",
      background: "251 241 199",
      surface: "249 245 215",
      selectedBackground: "175 135 5",
      selectedText: "251 241 199",
      statusBarBackground: "242 232 195",
      success: "121 116 14",
      error: "204 36 29",
      warning: "181 118 20",
      info: "7 102 120",
    },
  },
  tokyonight: {
    id: "tokyonight",
    name: "Tokyo Night",
    dark: {
      primary: "122 162 247",
      secondary: "187 154 247",
      accent: "187 247 208",
      text: "192 207 240",
      muted: "115 130 160",
      border: "38 50 80",
      focusedBorder: "122 162 247",
      background: "16 22 40",
      surface: "27 35 58",
      selectedBackground: "122 162 247",
      selectedText: "16 22 40",
      statusBarBackground: "21 28 48",
      success: "59 198 156",
      error: "237 135 150",
      warning: "231 130 132",
      info: "122 162 247",
    },
    light: {
      primary: "48 80 159",
      secondary: "97 76 159",
      accent: "47 182 149",
      text: "39 52 74",
      muted: "90 105 130",
      border: "180 195 220",
      focusedBorder: "48 80 159",
      background: "222 234 252",
      surface: "232 240 252",
      selectedBackground: "48 80 159",
      selectedText: "222 234 252",
      statusBarBackground: "212 226 248",
      success: "47 182 149",
      error: "215 75 95",
      warning: "210 130 60",
      info: "48 80 159",
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
    // Alias: many components use --color-bg for recessed panels (input
    // fields, card interiors, stat tiles). It mirrors --color-background.
    "--color-bg": tokens.background,
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

export function getThemeTokens(presetId: string, mode: EffectiveMode): ThemeTokenRGB {
  const preset = themePresets[presetId] ?? themePresets.ocean;
  return mode === "dark" ? preset.dark : preset.light;
}
