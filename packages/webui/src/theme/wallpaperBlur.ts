/**
 * Wallpaper background-blur preference — how strongly the background is
 * diffused behind the two shell regions, set SEPARATELY (the readability
 * scrim's twin dial, wallpaperOverlay.ts):
 *
 *   sidebar → the nav rail's own backdrop-filter (Sidebar.scss)
 *   main    → a body-level fixed blur band over the content column
 *             (theme.scss body::after)
 *
 * 0–8 px in 1px steps, 0 (no blur) the shipped default. Both write whole
 * backdrop-filter VALUES as inline custom properties on <html>
 * (uiOpacityPreference's mechanism), so drags preview live — but the two
 * areas deliberately differ in shape:
 *
 *   --wallpaper-blur-sidebar is always `blur(Npx)` (0 included): the rail
 *     has carried a backdrop-filter since the glass rework, and its
 *     non-none value doubles as a containing block for positioned nav
 *     chrome — flipping it to `none` at 0 would silently change that
 *     geometry, so the blur strength changes but the layer never goes
 *     away.
 *   --wallpaper-blur-main is `none` at 0: the band is a NEW body-level
 *     layer with no descendants, so dropping the property entirely at the
 *     default keeps the no-blur paint free of the backdrop composite the
 *     blur would cost. The band rule itself is additionally gated on
 *     html[data-wallpaper-art] — a solid background has nothing to blur.
 *
 * Like the overlay dial, the values only matter while an image wallpaper
 * is active; the settings sliders render under the same gate.
 */
import { ref } from "vue";

export const WALLPAPER_BLUR_SIDEBAR_STORAGE_KEY = "wowsp-wallpaper-blur-sidebar";
export const WALLPAPER_BLUR_MAIN_STORAGE_KEY = "wowsp-wallpaper-blur-main";
export const WALLPAPER_BLUR_MIN = 0;
export const WALLPAPER_BLUR_MAX = 8;
export const WALLPAPER_BLUR_DEFAULT = 0;

function clampPx(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return WALLPAPER_BLUR_DEFAULT;
  return Math.min(WALLPAPER_BLUR_MAX, Math.max(WALLPAPER_BLUR_MIN, Math.round(n)));
}

function loadStoredPx(storageKey: string): number {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw == null) return WALLPAPER_BLUR_DEFAULT;
    const px = clampPx(raw);
    // Heal-write: same contract as wallpaperOverlay — a value that needed
    // clamping (or was garbage and took the default) is forced back to
    // disk so the correction sticks instead of re-clamping on every boot.
    if (String(px) !== raw) {
      localStorage.setItem(storageKey, String(px));
    }
    return px;
  } catch {
    return WALLPAPER_BLUR_DEFAULT;
  }
}

/** Reactive px — the settings sliders bind to these; every write applies
 * the CSS var immediately, so drags preview live. */
export const wallpaperSidebarBlurPx = ref<number>(
  loadStoredPx(WALLPAPER_BLUR_SIDEBAR_STORAGE_KEY),
);
export const wallpaperMainBlurPx = ref<number>(
  loadStoredPx(WALLPAPER_BLUR_MAIN_STORAGE_KEY),
);

function applySidebarBlur(px: number): void {
  document.documentElement.style.setProperty("--wallpaper-blur-sidebar", `blur(${px}px)`);
}

function applyMainBlur(px: number): void {
  document.documentElement.style.setProperty(
    "--wallpaper-blur-main",
    px > WALLPAPER_BLUR_MIN ? `blur(${px}px)` : "none",
  );
}

/** Change + persist + apply immediately (settings slider). */
export function setWallpaperSidebarBlurPx(px: number) {
  wallpaperSidebarBlurPx.value = clampPx(px);
  try {
    localStorage.setItem(
      WALLPAPER_BLUR_SIDEBAR_STORAGE_KEY,
      String(wallpaperSidebarBlurPx.value),
    );
  } catch {
    // storage unavailable — the choice holds for the session
  }
  applySidebarBlur(wallpaperSidebarBlurPx.value);
}

/** Change + persist + apply immediately (settings slider). */
export function setWallpaperMainBlurPx(px: number) {
  wallpaperMainBlurPx.value = clampPx(px);
  try {
    localStorage.setItem(WALLPAPER_BLUR_MAIN_STORAGE_KEY, String(wallpaperMainBlurPx.value));
  } catch {
    // storage unavailable — the choice holds for the session
  }
  applyMainBlur(wallpaperMainBlurPx.value);
}

/** Boot hook: re-apply the stored values over the stylesheet defaults
 * before first paint (bootstrap.ts). */
export function initWallpaperBlurPreferences() {
  applySidebarBlur(wallpaperSidebarBlurPx.value);
  applyMainBlur(wallpaperMainBlurPx.value);
}
