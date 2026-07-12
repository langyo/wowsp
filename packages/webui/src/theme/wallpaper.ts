/**
 * WoWSP wallpaper types + presets. Adapted from shittim-chest's wallpaper.ts,
 * simplified to solid + image types only (no video/slang shader).
 *
 * Solid: plain color background (black/white/auto-follows-theme).
 * Image: a picture background with an overlay tint for readability.
 *
 * The wallpaper is applied to <body> via CSS custom properties consumed by
 * theme.scss: --wallpaper-image, --wallpaper-solid-color, --wallpaper-overlay-opacity.
 */

export type WallpaperType = "solid" | "image";

export type SolidSource = {
  type: "solid";
  color: "black" | "white" | "auto";
};

export type ImageSource = {
  type: "image";
  url: string;
};

export type WallpaperSource = SolidSource | ImageSource;

export type WallpaperPreset = {
  id: string;
  name: string;
  thumbnail?: string;
  source: WallpaperSource;
  /** Force this wallpaper to only show in dark/light mode (e.g. a bright
   *  photo only suitable for light mode). null = no restriction. */
  modeRestriction?: "dark" | "light" | null;
};

export type CustomWallpaper = {
  id: string;
  name: string;
  source: WallpaperSource;
  addedAt: number;
};

export const DEFAULT_WALLPAPER_ID = "solid-auto";

// A naval-themed image background can be added here when we ship one.
// For now the default is solid-auto (follows theme mode).
const bgUrl = ""; // placeholder — set to an imported image URL when available

export const DEFAULT_PRESETS: WallpaperPreset[] = [
  {
    id: "solid-auto",
    name: "Solid (auto)",
    source: { type: "solid", color: "auto" },
    modeRestriction: null,
  },
  {
    id: "solid-black",
    name: "Solid black",
    source: { type: "solid", color: "black" },
    modeRestriction: "dark",
  },
  {
    id: "solid-white",
    name: "Solid white",
    source: { type: "solid", color: "white" },
    modeRestriction: "light",
  },
  ...(bgUrl
    ? [
        {
          id: "naval-bg",
          name: "Naval",
          source: { type: "image" as const, url: bgUrl },
          modeRestriction: "light" as const,
        },
      ]
    : []),
];

// ── localStorage helpers ────────────────────────────────────────────────

const STORAGE_BG_KEY = "wowsp-wallpaper";
const STORAGE_CUSTOM_KEY = "wowsp-custom-wallpapers";

export function loadActiveWallpaperId(): string {
  return localStorage.getItem(STORAGE_BG_KEY) || DEFAULT_WALLPAPER_ID;
}

export function saveActiveWallpaperId(id: string): void {
  localStorage.setItem(STORAGE_BG_KEY, id);
}

export function loadCustomWallpapers(): CustomWallpaper[] {
  try {
    const raw = localStorage.getItem(STORAGE_CUSTOM_KEY);
    return raw ? (JSON.parse(raw) as CustomWallpaper[]) : [];
  } catch {
    return [];
  }
}

export function saveCustomWallpapers(list: CustomWallpaper[]): void {
  localStorage.setItem(STORAGE_CUSTOM_KEY, JSON.stringify(list));
}

export function addCustomWallpaper(wp: CustomWallpaper): void {
  const list = loadCustomWallpapers();
  list.push(wp);
  saveCustomWallpapers(list);
}

export function removeCustomWallpaper(id: string): void {
  saveCustomWallpapers(loadCustomWallpapers().filter((w) => w.id !== id));
}
