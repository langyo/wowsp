/**
 * Wallpaper overlay (dim scrim) opacity preference — the user-facing
 * transparency control for image backgrounds (port of shittim-chest's
 * display-settings thinking, scoped to the one dial that matters here):
 *
 *   0   → wallpaper at full brightness
 *   100 → wallpaper fully washed into the theme background
 *
 * Stored as an integer percent under `wowsp-wallpaper-overlay`; the default
 * mirrors the shipped dark-mode dimming. Solid backgrounds never draw a
 * scrim, so the value only matters while an image wallpaper is active.
 */
import { ref } from "vue";

export const WALLPAPER_OVERLAY_STORAGE_KEY = "wowsp-wallpaper-overlay";
export const WALLPAPER_OVERLAY_DEFAULT = 60;
export const WALLPAPER_OVERLAY_MIN = 0;
export const WALLPAPER_OVERLAY_MAX = 100;

function clampPercent(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return WALLPAPER_OVERLAY_DEFAULT;
  return Math.min(WALLPAPER_OVERLAY_MAX, Math.max(WALLPAPER_OVERLAY_MIN, Math.round(n)));
}

function loadStoredOverlayPercent(): number {
  try {
    const raw = localStorage.getItem(WALLPAPER_OVERLAY_STORAGE_KEY);
    if (raw == null) return WALLPAPER_OVERLAY_DEFAULT;
    const percent = clampPercent(raw);
    // Heal-write: a value that needed clamping (or was garbage and took the
    // default) is forced back to disk so the correction sticks instead of
    // re-clamping a stale value on every boot.
    if (String(percent) !== raw) {
      localStorage.setItem(WALLPAPER_OVERLAY_STORAGE_KEY, String(percent));
    }
    return percent;
  } catch {
    return WALLPAPER_OVERLAY_DEFAULT;
  }
}

/** Reactive percent — WallpaperRenderer derives the CSS var from it and the
 *  settings slider binds to it, so drags preview live. */
export const wallpaperOverlayPercent = ref<number>(loadStoredOverlayPercent());

/** Change + persist (settings slider). */
export function setWallpaperOverlayPercent(percent: number) {
  wallpaperOverlayPercent.value = clampPercent(percent);
  try {
    localStorage.setItem(WALLPAPER_OVERLAY_STORAGE_KEY, String(wallpaperOverlayPercent.value));
  } catch {
    // storage unavailable — the choice holds for the session
  }
}
