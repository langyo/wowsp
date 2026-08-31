/**
 * WoWSP brand theme presets registered into hikari's theme system.
 *
 * hikari already ships nord / gruvbox / tokyonight upstream — wowsp no longer
 * carries its own copies. Only the brand-default "ocean" ("Abyssal Glass"
 * naval palette) lives here, converted from the legacy string-triplet token
 * shape to hikari's {r,g,b} scheme and merged into `themePresets` before
 * `initTheme()` runs (see bootstrap.ts). index.html declares
 * `window.__celestiaThemes = { ocean: … }` + `__celestiaDefaultTheme` so the
 * stored-id resolver accepts "ocean" even before this module evaluates.
 */
import { themePresets, type CustomThemePreset } from "@celestia-island/hikari";

function rgb(triplet: string): { r: number; g: number; b: number } {
  const [r, g, b] = triplet.split(" ").map((n) => Number.parseInt(n, 10));
  return { r, g, b };
}

/** Convert wowsp's legacy string-triplet token rows to hikari's shape.
 *  `onPrimary` is dropped — hikari derives it from the primary luminance. */
function scheme(row: Record<string, string>) {
  const pick = (...keys: string[]) => rgb(row[keys[0]]);
  return {
    primary: pick("primary"),
    secondary: pick("secondary"),
    accent: pick("accent"),
    text: pick("text"),
    muted: pick("muted"),
    border: pick("border"),
    focusedBorder: pick("focusedBorder"),
    background: pick("background"),
    surface: pick("surface"),
    selectedBackground: pick("selectedBackground"),
    selectedText: pick("selectedText"),
    statusBarBackground: pick("statusBarBackground"),
    success: pick("success"),
    error: pick("error"),
    warning: pick("warning"),
    info: pick("info"),
  };
}

const ocean: CustomThemePreset = {
  id: "ocean",
  name: "Ocean",
  dark: scheme({
    primary: "56 189 248",
    secondary: "34 211 238",
    accent: "245 184 92",
    text: "226 236 248",
    muted: "139 156 184",
    border: "44 58 80",
    focusedBorder: "56 189 248",
    background: "5 9 17",
    surface: "15 23 38",
    selectedBackground: "56 189 248",
    selectedText: "4 18 31",
    statusBarBackground: "9 14 24",
    success: "52 211 153",
    error: "248 113 113",
    warning: "251 191 36",
    info: "56 189 248",
  }),
  light: scheme({
    primary: "2 132 199",
    secondary: "8 145 178",
    accent: "180 120 20",
    text: "55 65 81",
    muted: "84 103 130",
    border: "205 216 230",
    focusedBorder: "2 132 199",
    background: "244 247 251",
    surface: "255 255 255",
    selectedBackground: "2 132 199",
    selectedText: "255 255 255",
    statusBarBackground: "236 242 249",
    success: "5 150 105",
    error: "220 38 38",
    warning: "217 119 6",
    info: "2 132 199",
  }),
};

/** Merge brand presets into hikari's registry. Must run before initTheme()
 *  so applyTheme() can resolve "ocean" and WallpaperRenderer's
 *  getThemeTokens(data-theme) lookup succeeds. */
export function registerBrandThemes() {
  Object.assign(themePresets, { [ocean.id]: ocean });
}
