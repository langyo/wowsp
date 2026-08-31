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
