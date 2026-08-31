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
import { i18n } from "./i18n";

/** Canonical wowsp locale ("en-US" / "zh-CN") → hikari i18n dir. */
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
  initFontContext();

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
