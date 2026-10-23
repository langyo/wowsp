/**
 * hikari runtime bootstrap for both console entries — the SAME calls the
 * website's main.ts makes (theme vars, font context, viewport policy).
 * hikari's initTheme() owns every --color-* token on the page; nothing
 * hand-rolls a palette here.
 */
import {
  applyViewportPolicy,
  initFontContext,
  initTheme,
  setLocale as setHikariLocale,
} from "@celestia-island/hikari";

import "@/styles/hikari.scss";

/** Console locale (wowsp BCP 47) → hikari i18n dir. Hikari carries its
 *  own component copy (error-landing labels, …) for these languages;
 *  everything else falls back to English. Without this seeding the
 *  error card's built-in micro-labels would stay English in the zh UI. */
function hikariLocaleOf(locale: string): string {
  const t = locale.toLowerCase();
  if (t.startsWith("zh")) {
    return /(^|[-_])(tw|hk|mo|hant)\b/.test(t) ? "zh-Hant" : "zh-Hans";
  }
  const primary = t.split(/[-_]/)[0];
  return ["ja", "ko", "ru", "fr", "es"].includes(primary) ? primary : "en";
}

export function bootHikari(locale: string): void {
  document.documentElement.lang = locale;
  initTheme();
  initFontContext();
  applyViewportPolicy();
  void setHikariLocale(hikariLocaleOf(locale));
}
