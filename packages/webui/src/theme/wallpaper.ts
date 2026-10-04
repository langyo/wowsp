/**
 * WoWSP wallpaper types + presets.
 *
 * The wallpaper choice is deliberately two-dimensional and nothing more:
 *   - Built-in: the shipped art pair (正弦线's light/dark illustrations,
 *     the default — one per theme side, swapped live by the effective
 *     mode; see themeModePreference for the mode preference it follows).
 *     There is deliberately no solid preset — users who want a plain
 *     color can slide the wallpaper overlay to 100% (theme.scss scrim).
 *   - Custom: image files the user imported, stored in the fixed
 *     `<data_dir>/wallpapers/` folder (see commands::wallpaper). The
 *     directory IS the list — ids are file names, so there is no metadata
 *     blob to keep in sync.
 *
 * The active wallpaper is applied by WallpaperRenderer: image sources as a
 * dedicated fixed layer on <body> — see theme.scss for the layer/scrim
 * rules. The "solid" source type survives only as the renderer's fallback
 * path (an id that resolves to nothing paints the theme base); no preset
 * carries it.
 */

export type WallpaperType = "solid" | "image" | "mode-image";

export type SolidSource = {
  type: "solid";
};

export type ImageSource = {
  type: "image";
  url: string;
};

/** A built-in art pair — one illustration per theme side; the active file
 *  follows the effective mode, exactly like the retired solid preset's
 *  base did. */
export type ModeImageSource = {
  type: "mode-image";
  light: string;
  dark: string;
};

export type WallpaperSource = SolidSource | ImageSource | ModeImageSource;

export type WallpaperPreset = {
  id: string;
  /** i18n key for built-in presets; custom entries carry a literal name. */
  nameKey?: string;
  name: string;
  source: WallpaperSource;
};

export const DEFAULT_WALLPAPER_ID = "art-auto";

/** The shipped art pair — the default background. One of 正弦线's light/
 *  dark illustrations per theme side, swapped live when the mode flips
 *  (files live in publicDir → served at /wallpapers). */
export const ART_WALLPAPER: WallpaperPreset = {
  id: DEFAULT_WALLPAPER_ID,
  nameKey: "settings.wallpaperArt",
  name: "Illustration",
  source: {
    type: "mode-image",
    light: "/wallpapers/bg_light.webp",
    dark: "/wallpapers/bg_dark.webp",
  },
};

/** Every id the app can resolve without touching the custom folder. */
export const BUILTIN_WALLPAPER_IDS: ReadonlySet<string> = new Set([
  ART_WALLPAPER.id,
]);

/** Resolve an image-bearing source to the single URL the given mode
 *  paints — the renderer and the settings/wizard previews share this. */
export function imageSourceUrl(
  source: ImageSource | ModeImageSource,
  mode: "light" | "dark",
): string {
  if (source.type === "image") return source.url;
  return mode === "dark" ? source.dark : source.light;
}

// ── localStorage helpers ────────────────────────────────────────────────
// Only the active id persists here; the custom list itself lives on disk
// in the wallpapers folder and is read through commands::wallpaper.

export const STORAGE_BG_KEY = "wowsp-wallpaper";
/** Pre-AppData custom list (JSON in localStorage) — swept on first read. */
const LEGACY_CUSTOM_KEY = "wowsp-custom-wallpapers";

export function loadActiveWallpaperId(): string {
  try {
    // Custom wallpapers moved to the wallpapers folder; drop the dead list.
    localStorage.removeItem(LEGACY_CUSTOM_KEY);
    const raw = localStorage.getItem(STORAGE_BG_KEY);
    if (raw == null) return DEFAULT_WALLPAPER_ID;
    // Old installs may carry ids of removed presets (solid-auto — the
    // retired plain-color default — solid-black/white) or of the old
    // localStorage custom list ("custom-…") — those entries no longer
    // exist. The default is FORCED back to disk (heal-write) so the stale
    // id is corrected once instead of re-defaulting every boot;
    // useWallpaper also self-heals when a custom file disappears from disk.
    if (BUILTIN_WALLPAPER_IDS.has(raw) || raw.startsWith("wallpaper-")) return raw;
    localStorage.setItem(STORAGE_BG_KEY, DEFAULT_WALLPAPER_ID);
    return DEFAULT_WALLPAPER_ID;
  } catch {
    return DEFAULT_WALLPAPER_ID;
  }
}

export function saveActiveWallpaperId(id: string): void {
  try {
    localStorage.setItem(STORAGE_BG_KEY, id);
  } catch {
    // storage unavailable — the choice holds for the session
  }
}
