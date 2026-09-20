/**
 * WoWSP's own four-way theme-mode preference, layered on top of hikari's
 * three-way mode (dark/light/system):
 *
 *   "dark"   常黑    → setMode("dark")
 *   "light"  常白    → setMode("light")
 *   "solar"  根据时间 → setMode("system") — hikari's "system" follows the SUN
 *                      (day/dusk/night clock), not the OS; this is the
 *                      shipped behavior and stays the default.
 *   "system" 根据系统 → follow the OS `prefers-color-scheme` instead: a
 *                      module-level matchMedia listener maps OS changes onto
 *                      setMode("dark"/"light") while the preference is
 *                      active, and is detached the moment it is not.
 *
 * The preference persists under `wowsp-theme-mode` (ours, authoritative) and
 * migrates hikari's legacy `hikari-theme-mode` key on first read
 * ("system" → "solar": the legacy value meant daylight-following here).
 * hikari's own setMode keeps writing ITS key — that is fine, our key wins on
 * every boot because initThemeModePreference() re-applies after initTheme().
 */
import { ref } from "vue";

import { useTheme } from "@celestia-island/hikari";

export type ThemeModePreference = "dark" | "light" | "solar" | "system";

export const THEME_MODE_PREFERENCE_STORAGE_KEY = "wowsp-theme-mode";
/** hikari's own mode key (see hikari useTheme THEME_MODE_STORAGE_KEY). */
const LEGACY_HIKARI_MODE_KEY = "hikari-theme-mode";

function isThemeModePreference(v: unknown): v is ThemeModePreference {
  return v === "dark" || v === "light" || v === "solar" || v === "system";
}

/** Read + migrate. Missing new key → adopt the legacy hikari value
 *  (dark/light verbatim, anything else — including hikari's "system",
 *  which was daylight-following here — becomes "solar") and write it back.
 *  A corrupt present value falls back to the default without rewriting
 *  history we cannot interpret. */
export function readStoredThemeModePreference(): ThemeModePreference {
  try {
    const raw = localStorage.getItem(THEME_MODE_PREFERENCE_STORAGE_KEY);
    if (raw == null) {
      const legacy = localStorage.getItem(LEGACY_HIKARI_MODE_KEY);
      const migrated: ThemeModePreference =
        legacy === "dark" || legacy === "light" ? legacy : "solar";
      localStorage.setItem(THEME_MODE_PREFERENCE_STORAGE_KEY, migrated);
      return migrated;
    }
    return isThemeModePreference(raw) ? raw : "solar";
  } catch {
    return "solar";
  }
}

/** Reactive current preference — the settings section and the onboarding
 *  wizard bind their selected states to this module-level ref so both
 *  surfaces always agree. */
export const themeModePreference = ref<ThemeModePreference>(
  readStoredThemeModePreference(),
);

// ── OS prefers-color-scheme follower (module-level singleton) ───────────
let mediaQuery: MediaQueryList | null = null;
let mediaListener: ((e: MediaQueryListEvent) => void) | null = null;

function osPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function attachSystemListener(applyNow: boolean) {
  if (mediaQuery) return;
  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaListener = () => applyOsMode();
  mediaQuery.addEventListener("change", mediaListener);
  if (applyNow) applyOsMode();
}

function detachSystemListener() {
  if (mediaQuery && mediaListener) {
    mediaQuery.removeEventListener("change", mediaListener);
  }
  mediaQuery = null;
  mediaListener = null;
}

function applyOsMode() {
  const theme = useTheme();
  const next = osPrefersDark() ? "dark" : "light";
  if (theme.currentMode.value !== next) theme.setMode(next);
}

/** Map the preference onto hikari's mode now (always drives setMode so the
 *  hikari-side state is deterministic after every apply — e.g. a boot where
 *  hikari restored the raw mapping of a DIFFERENT preference gets
 *  corrected here). */
function applyPreference(mode: ThemeModePreference) {
  if (mode === "system") {
    attachSystemListener(true);
    return;
  }
  detachSystemListener();
  useTheme().setMode(mode === "solar" ? "system" : mode);
}

/** Change + persist + apply immediately (settings section, onboarding
 *  wizard — both want live preview). */
export function setThemeModePreference(mode: ThemeModePreference) {
  themeModePreference.value = mode;
  try {
    localStorage.setItem(THEME_MODE_PREFERENCE_STORAGE_KEY, mode);
  } catch {
    // storage unavailable — the preference holds for the session
  }
  applyPreference(mode);
}

/** Boot hook: apply the stored preference after hikari's initTheme() so the
 *  authoritative key wins over whatever hikari restored. */
export function initThemeModePreference() {
  applyPreference(themeModePreference.value);
}
