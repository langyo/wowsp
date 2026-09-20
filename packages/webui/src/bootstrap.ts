/**
 * WoWSP bootstrap — global hooks wired before the app mounts. Mirrors
 * shittim-chest's composables/bootstrapApp.ts: everything here must run
 * before first paint so theme/fonts/viewport never flash.
 *
 * The same routine serves BOTH windows (main shell + game overlay) — the
 * overlay is transparent but still consumes theme tokens for its roster.
 */
import { watch } from "vue";

import {
  applyViewportPolicy,
  initFontContext,
  initTheme,
  setLocale as setHikariLocale,
  useTheme,
} from "@celestia-island/hikari";

import { registerBrandThemes } from "./theme/brandThemes";
import { installGlobalTooltip } from "./composables/globalTooltip";
import { initDpiPrefs } from "./theme/dpiPrefs";
import { initFontScalePreference } from "./theme/fontScalePreference";
import { initThemeModePreference } from "./theme/themeModePreference";
import { i18n } from "./i18n";

/** Canonical wowsp locale → hikari i18n dir. Hikari ships simplified-
 *  Chinese and English component copy only; every other UI locale falls
 *  back to English for those shared components. */
function hikariLocaleOf(locale: string): string {
  return locale.startsWith("zh") ? "zh-Hans" : "en";
}

export function bootstrap(): void {
  // Mobile UX contract (hikari #325): normalize the viewport meta before
  // first paint. No-op for the desktop webview's standard meta, but keeps
  // the browser window honest on phones.
  applyViewportPolicy();

  // Brand presets must be in hikari's registry before initTheme resolves
  // the stored/default theme id ("ocean"). index.html additionally declares
  // window.__celestiaThemes/__celestiaDefaultTheme pre-module so the
  // stored-id resolver accepts "ocean" even before this line evaluates.
  registerBrandThemes();
  initTheme();
  // WoWSP's own three-way mode preference (dark/light/solar) sits on top of
  // hikari's mode and must run AFTER initTheme so the authoritative
  // `wowsp-theme-mode` key wins over whatever hikari restored.
  // The ?theme= deep link below still overrides both for this load only.
  initThemeModePreference();
  // WoWSP's font-size preference (five levels over the --text-* scale)
  // writes inline :root overrides after the stylesheets load — same
  // authoritative-key-wins contract as the mode preference above.
  initFontScalePreference();
  // WoWSP's interface-scale (DPI) preference writes a root CSS `zoom` over
  // the whole shell — same authoritative-key-wins contract as above. Only
  // this main-window bootstrap runs it: the game overlay and manual-locate
  // windows have separate non-Vue bootstraps and never call bootstrap(), so
  // the zoom cannot leak into their screen-coordinate math.
  initDpiPrefs();
  initFontContext();

  // Delegated tooltip hook: everything that used to lean on native
  // `title` popups opts in via data-hint and renders hikari-style.
  installGlobalTooltip();

  // One-shot deep link (?theme=light|dark): force the mode for this load
  // WITHOUT persisting it — same semantics as the pre-hikari theme manager.
  // Mutate the mode ref directly, then re-apply via setTheme (persists only
  // the unchanged theme id); setMode() would write localStorage.
  const forced = new URLSearchParams(window.location.search).get("theme");
  if (forced === "light" || forced === "dark") {
    const theme = useTheme();
    if (theme.currentMode.value !== forced) {
      theme.currentMode.value = forced;
      theme.setTheme(theme.currentTheme.value);
    }
  }

  // Seed hikari's own i18n context (upstreamed components render their own
  // copy: confirm dialog buttons, empty states, …) from the detected app
  // locale, and keep it in sync when the user switches languages.
  const appLocale = (i18n.global.locale as unknown as { value: string }).value;
  document.documentElement.lang = appLocale;
  void setHikariLocale(hikariLocaleOf(appLocale));
  watch(
    () => (i18n.global.locale as unknown as { value: string }).value,
    (locale) => {
      document.documentElement.lang = locale;
      void setHikariLocale(hikariLocaleOf(locale));
    },
  );
}
