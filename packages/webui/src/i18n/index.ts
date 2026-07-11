/**
 * vue-i18n bootstrap. Two locales (en + zhs) are auto-discovered from
 * res/i18n/locales and deep-merged by namespace path. The detected
 * locale comes from window.__WOWSP_OS_PREFS__ (seeded by the Tauri shell
 * before page load) or the browser. Adapted from shittim-chest's i18n.
 */
import { createI18n } from "vue-i18n";

const modules = import.meta.glob("../../../../res/i18n/locales/**/*.json", { eager: true });

export const SUPPORTED_LOCALES = ["en", "zhs"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

type Messages = Record<string, Record<string, unknown>>;
const messages: Messages = {};
for (const [path, mod] of Object.entries(modules)) {
  // path looks like: .../locales/en/common.json
  const m = path.match(/locales\/([^/]+)\/(.+)\.json$/);
  if (!m) continue;
  const [, lang, ns] = m;
  const nsParts = ns.split("/");
  const target = (messages[lang] ??= {});
  let cur = target;
  for (let i = 0; i < nsParts.length - 1; i++) {
    cur[nsParts[i]] = (cur[nsParts[i]] as Record<string, unknown>) ?? {};
    cur = cur[nsParts[i]] as Record<string, unknown>;
  }
  cur[nsParts[nsParts.length - 1]] = (mod as { default: unknown }).default;
}

function detectLocale(): Locale {
  const pref = window.__WOWSP_OS_PREFS__?.locale;
  if (pref && pref.startsWith("zh")) return "zhs";
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  return nav.startsWith("zh") ? "zhs" : "en";
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: "en",
  messages,
});

export function setLocale(locale: Locale): void {
  i18n.global.locale.value = locale;
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale === "zhs" ? "zh-CN" : "en";
  }
}

export function t(key: string, params?: Record<string, unknown>): string {
  return i18n.global.t(key, params as never);
}
