/**
 * The Tab overlay's plate-opacity dial — how opaque the dark glass behind
 * the overlay's content plates is (every per-player chip plus the centered
 * status card), ONE knob for the whole overlay.
 *
 * The value itself is persisted in the statsPrefs blob (`overlayBackdropPct`,
 * 50–100, 80 = the shipped default) because the overlay window shares that
 * localStorage with the main window and re-reads it live on the
 * `wowsp://stats-prefs-changed` broadcast — the only channel into this
 * window (overlay/main.ts's refreshPrefs). This module is the CSS end of
 * that path: a PERCENTAGE value written as one inline custom property on
 * <html> (theme/uiOpacityPreference.ts's mechanism), so every plate styles
 * itself from the same number and a settings change restyles the live window
 * without re-rendering a single chip.
 *
 * The number is the plate's FINAL alpha, not a multiplier over the
 * stylesheet literal: overlay.scss hands it straight to the fill's alpha
 * slot, so 100% really is fully opaque rather than a fraction of some
 * shipped alpha.
 */
import {
  DEFAULT_OVERLAY_BACKDROP_PCT,
  OVERLAY_BACKDROP_PCT_MAX,
  OVERLAY_BACKDROP_PCT_MIN,
} from "@/stores/statsPrefs";

/** Inline custom property on <html>; overlay.scss's plate rules fall back
 *  to the dial's default while it is unset (the JS-less sample page). */
export const OVERLAY_BACKDROP_CSS_VAR = "--overlay-backdrop-opacity";

/** The dial's shipped default — the plates' inline fallback before the
 *  boot apply lands, derived from the store constant so the two cannot
 *  drift. */
export const DEFAULT_BACKDROP_OPACITY_PCT = DEFAULT_OVERLAY_BACKDROP_PCT;

/** Pure percent → CSS value: clamp into the dial's band and spell it as a
 *  percentage. Non-finite input answers the default (the same tolerant
 *  contract the prefs readers apply), so a stray NaN can never write an
 *  invalid declaration. */
export function overlayBackdropCss(pct: number): string {
  const clamped = Number.isFinite(pct)
    ? Math.min(OVERLAY_BACKDROP_PCT_MAX, Math.max(OVERLAY_BACKDROP_PCT_MIN, pct))
    : DEFAULT_BACKDROP_OPACITY_PCT;
  return `${clamped}%`;
}

/** Write the dial onto <html> — called once at overlay boot and again after
 *  every prefs broadcast (overlay/main.ts), so a settings change repaints
 *  the plates live. */
export function applyOverlayBackdropPercent(pct: number): void {
  document.documentElement.style.setProperty(
    OVERLAY_BACKDROP_CSS_VAR,
    overlayBackdropCss(pct),
  );
}
