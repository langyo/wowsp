/**
 * UI surface opacity preference — the chrome-side twin of the wallpaper
 * overlay dial (wallpaperOverlay.ts). Every translucent surface in the
 * app (sidebar, cards, stage panels, modals, the title bar …) draws its
 * fill as `rgb(var(--color-surface) / min(100%, calc(base% *
 * var(--ui-opacity))))`, so ONE multiplier rescales the whole glass
 * family together while each surface keeps its relative weight:
 *
 *   <95  → clearer glass; the wallpaper shows through the chrome
 *   95   → the shipped default: a hair clearer than the fully-solid paint,
 *          so the wallpaper still ghosts under every UI element
 *   >95  → solidified panels, readable over busy wallpapers — alpha is
 *          capped at fully opaque, so 200 reads as "as solid as it gets"
 *
 * Stored as an integer percent under `wowsp-ui-opacity`; applied as an
 * inline `--ui-opacity` on <html> (fontScalePreference's mechanism), so
 * drags preview live without re-rendering a single component. Fully
 * opaque surfaces (stats tables, inputs, phone sheets) are deliberately
 * outside the dial — they are content chrome, not wallpaper-adaptive
 * glass, and stay readable at every setting.
 */
import { ref } from "vue";

export const UI_OPACITY_STORAGE_KEY = "wowsp-ui-opacity";
export const UI_OPACITY_DEFAULT = 95;
export const UI_OPACITY_MIN = 0;
export const UI_OPACITY_MAX = 200;

function clampPercent(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return UI_OPACITY_DEFAULT;
  return Math.min(UI_OPACITY_MAX, Math.max(UI_OPACITY_MIN, Math.round(n)));
}

function loadStoredUiOpacityPercent(): number {
  try {
    const raw = localStorage.getItem(UI_OPACITY_STORAGE_KEY);
    if (raw == null) return UI_OPACITY_DEFAULT;
    const percent = clampPercent(raw);
    // Heal-write: same contract as wallpaperOverlay — a value that needed
    // clamping (or was garbage and took the default) is forced back to
    // disk so the correction sticks instead of re-clamping on every boot.
    if (String(percent) !== raw) {
      localStorage.setItem(UI_OPACITY_STORAGE_KEY, String(percent));
    }
    return percent;
  } catch {
    return UI_OPACITY_DEFAULT;
  }
}

/** Reactive percent — the settings slider binds to it; every write applies
 *  the CSS var immediately, so drags preview live. */
export const uiOpacityPercent = ref<number>(loadStoredUiOpacityPercent());

function applyUiOpacity(percent: number): void {
  const html = document.documentElement;
  html.style.setProperty("--ui-opacity", (percent / 100).toFixed(2));
  // Marker for style rules that must engage only BELOW the default percent
  // (today: the desktop modal blur token, theme.scss — the at-rest 95%
  // glass is readable without it) so the shipped look stays free of the
  // backdrop layer that would cost.
  if (percent < UI_OPACITY_DEFAULT) html.dataset.uiGlass = "";
  else delete html.dataset.uiGlass;
}

/** Change + persist + apply immediately (settings slider). */
export function setUiOpacityPercent(percent: number) {
  uiOpacityPercent.value = clampPercent(percent);
  try {
    localStorage.setItem(UI_OPACITY_STORAGE_KEY, String(uiOpacityPercent.value));
  } catch {
    // storage unavailable — the choice holds for the session
  }
  applyUiOpacity(uiOpacityPercent.value);
}

/** Boot hook: re-apply the stored value over the stylesheet default (0.95)
 *  before first paint (bootstrap.ts). */
export function initUiOpacityPreference() {
  applyUiOpacity(uiOpacityPercent.value);
}
