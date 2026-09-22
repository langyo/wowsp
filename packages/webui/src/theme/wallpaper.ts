/**
 * WoWSP wallpaper types + presets.
 *
 * The wallpaper choice is deliberately two-dimensional and nothing more:
 *   - Solid: a plain background that always presents dark (see
 *     themeModePreference) — the single built-in preset.
 *   - Custom: image files the user imported, stored in the fixed
 *     `<data_dir>/wallpapers/` folder (see commands::wallpaper). The
 *     directory IS the list — ids are file names, so there is no metadata
 *     blob to keep in sync.
 *
 * The active wallpaper is applied by WallpaperRenderer: image sources as a
 * dedicated fixed layer on <body>, solid as body's background-color — see
 * theme.scss for the layer/scrim rules.
 */

export type WallpaperType = "solid" | "image";

export type SolidSource = {
  type: "solid";
};

export type ImageSource = {
  type: "image";
  url: string;
};

export type WallpaperSource = SolidSource | ImageSource;

export type WallpaperAuthor = {
  name: string;
  url: string;
};

export type WallpaperPreset = {
  id: string;
  /** i18n key for built-in presets; custom entries carry a literal name. */
  nameKey?: string;
  name: string;
  source: WallpaperSource;
  /** Art credit — surfaced by the desktop corner mark and the settings
   *  attributions section. */
  author?: WallpaperAuthor | null;
};

export const DEFAULT_WALLPAPER_ID = "solid-auto";

/** The single built-in background: plain color, follows the theme mode. */
export const SOLID_WALLPAPER: WallpaperPreset = {
  id: DEFAULT_WALLPAPER_ID,
  nameKey: "settings.wallpaperSolid",
  name: "Solid",
  source: { type: "solid" },
  author: null,
};

// A naval-themed image background can be added here when we ship one.
// (Give it an `author` credit — see attributions.ts.)

// ── localStorage helpers ────────────────────────────────────────────────
// Only the active id persists here; the custom list itself lives on disk
// in the wallpapers folder and is read through commands::wallpaper.

const STORAGE_BG_KEY = "wowsp-wallpaper";
/** Pre-AppData custom list (JSON in localStorage) — swept on first read. */
const LEGACY_CUSTOM_KEY = "wowsp-custom-wallpapers";

export function loadActiveWallpaperId(): string {
  try {
    // Custom wallpapers moved to the wallpapers folder; drop the dead list.
    localStorage.removeItem(LEGACY_CUSTOM_KEY);
    const raw = localStorage.getItem(STORAGE_BG_KEY);
    if (raw == null) return DEFAULT_WALLPAPER_ID;
    // Old installs may carry ids of removed presets (solid-black/white) or
    // of the old localStorage custom list ("custom-…") — those entries no
    // longer exist. The default is FORCED back to disk (heal-write) so the
    // stale id is corrected once instead of re-defaulting every boot;
    // useWallpaper also self-heals when a custom file disappears from disk.
    if (raw === DEFAULT_WALLPAPER_ID || raw.startsWith("wallpaper-")) return raw;
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
