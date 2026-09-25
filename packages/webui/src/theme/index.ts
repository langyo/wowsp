// Theme + runtime forwarding: the shared theme system lives in hikari.
// WoWSP-specific pieces stay local: the wallpaper system (wallpaper.ts /
// useWallpaper.ts / wallpaperOverlay.ts) and the mode preference
// (themeModePreference.ts).
//
// hikari's runtime buses replace wowsp's former animationBus / cronBus /
// useSolarTime (deleted in the hikari sync) — same API surface, upstream
// maintained.

// Imported as well as re-exported (below): an indirect `export … from`
// binds no local name, and themePresetIds reads the table per call.
import { themePresets } from "@celestia-island/hikari";

/** Preferred display order of the shipped color presets, used by the
 *  onboarding wizard's theme step (the settings appearance section now
 *  reads the theme engine's merged view directly — presets + custom
 *  schemes — so it has no use for a preset-id order): Nord first,
 *  Synthwave '84 deliberately last, and hikari's collapsed `default` pair
 *  after the ids it retired (see themePresetIds). Naming an id here states
 *  a PREFERENCE, never a whitelist of what a picker may show. */
export const THEME_PRESET_ORDER = [
  "nord",
  "gruvbox",
  "tokyonight",
  "synthwave84",
  "default",
] as const;

/**
 * The preset ids the WIZARD's picker may show, derived from the LIVE hikari
 * preset table: every preset the table carries, in THEME_PRESET_ORDER where
 * that order names it and in table order for anything else. Resolved per
 * call (the idiom hikari itself uses for its scheme-editor seed), so the
 * list follows whatever table the running build ends up with.
 *
 * What this replaces: hikari collapsed its four stock presets into a single
 * `default` (0.55.61 — the SAME 0.55.x minor, so it is already inside this
 * package's `^0.55.53` range and arrives on a routine lock refresh). The
 * settings row kept a whitelist of the four retired ids and filtered it
 * against the table; the wizard mapped that same whitelist and dropped every
 * id whose tokens no longer resolved. Either way the collapsed table left
 * both rows with ZERO cards — no error, nothing that fails a build. Deriving
 * the list from the table yields the shipped presets on both sides of the
 * collapse (four before it, one after) and is never empty while the table
 * holds anything.
 *
 * `known` is the seam that pins BOTH shipped tables in tests (the
 * pre-collapse four ids and the collapsed one); production callers pass
 * nothing and read the installed table.
 */
export function themePresetIds(known: readonly string[] = Object.keys(themePresets)): string[] {
  const present = new Set(known);
  const ordered: string[] = THEME_PRESET_ORDER.filter((id) => present.has(id));
  const named = new Set(ordered);
  return [...ordered, ...known.filter((id) => !named.has(id))];
}

export {
  initTheme,
  useTheme,
  themePresets,
  tokensToCSSVars,
  getThemeTokens,
  loadCustomThemes,
  saveCustomThemes,
  addCustomTheme,
  removeCustomTheme,
  type ThemeId,
  type ThemeMode,
  type ThemePreset,
  type ThemeSchemeTokens,
  type ThemeTokens,
  type CustomThemePreset,
  type TimePeriod,
} from "@celestia-island/hikari";

// Solar clock (theme "system" mode + the settings indicator).
export {
  getTimePeriod,
  getGeolocation,
  solarAltitude,
  DEFAULT_GEO_LOCATION,
} from "@celestia-island/hikari";

// Font-size scaling preference (appearance settings + onboarding wizard):
// inline --text-* overrides on :root driven by the persisted level.
export {
  FONT_SCALE_FACTORS,
  FONT_SCALE_LEVELS,
  FONT_SCALE_STORAGE_KEY,
  fontScaleLevel,
  readStoredFontScaleLevel,
  setFontScaleLevel,
  initFontScalePreference,
  type FontScaleLevel,
} from "./fontScalePreference";

// Interface-scale (DPI) preference (appearance settings): root CSS `zoom`
// driven by the persisted percent, with the app-level preview countdown and
// the escape hatches. Canvas hosts read the applied scale via
// useAppliedDpiScale to keep their backing stores crisp.
export {
  applyDpiPrefs,
  DPI_MAX,
  DPI_MIN,
  DPI_REVERT_SECONDS,
  DPI_STEP,
  getDpiCountdownRemaining,
  getDpiCountdownRemainingMs,
  getPreviewedDpiScale,
  initDpiPrefs,
  isDpiCountdownActive,
  isDpiRisky,
  keepDpiScale,
  loadDpiScale,
  previewDpiScale,
  resetAppliedDpiScaleForTest,
  resetDpiScale,
  revertPreviewDpiScale,
  saveDpiScale,
  shutdownDpiPrefs,
  useAppliedDpiScale,
  useDpiCountdown,
  type DpiCountdownState,
} from "./dpiPrefs";

// Shared animation/timer buses (idle-zero-frame scheduling).
export {
  onFrame,
  onceFrame,
  scheduleFrame,
  scheduleEvery,
  scheduleAfter,
  reportTransition,
  setReducedMotion,
  notifyScrollStart,
  scheduleCron,
  scheduleCronAfter,
  type AnimationHandle,
  type CronHandle,
  type FrameContext,
} from "@celestia-island/hikari";
