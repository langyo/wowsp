// Theme + runtime forwarding: the shared theme system lives in hikari.
// WoWSP-specific pieces stay local: brand presets (brandThemes.ts) and the
// wallpaper system (wallpaper.ts / useWallpaper.ts).
//
// hikari's runtime buses replace wowsp's former animationBus / cronBus /
// useSolarTime (deleted in the hikari sync) — same API surface, upstream
// maintained.
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
