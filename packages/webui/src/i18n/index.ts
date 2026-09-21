/**
 * vue-i18n bootstrap. Locales (standardized BCP 47 lang-loc — the same nine
 * codes the game-asset data language offers) are auto-discovered from
 * res/i18n/locales and deep-merged by namespace path. The detected locale
 * comes from window.__WOWSP_OS_PREFS__ (seeded by the Tauri shell before
 * page load) or the browser. Adapted from shittim-chest's i18n.
 */
import { createI18n } from "vue-i18n";

const modules = import.meta.glob("../../../../res/i18n/locales/**/*.json", { eager: true });

export const SUPPORTED_LOCALES = [
  "en-US",
  "zh-CN",
  "zh-SG",
  "zh-TW",
  "ja-JP",
  "ko-KR",
  "ru-RU",
  "fr-FR",
  "es-ES",
] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

type Messages = Record<string, Record<string, any>>;
const messages: Messages = {};
for (const [path, mod] of Object.entries(modules)) {
  // path looks like: .../locales/en-US/common.json
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

/** Map a BCP-47 tag (OS preference / navigator.language) onto a supported UI
 *  locale. Chinese collapses by script/region — TW/HK/Hant → zh-TW, SG →
 *  zh-SG, everything else zh → zh-CN — and bare language tags pick the
 *  primary locale. Returns null when the language isn't offered. */
export function matchLocale(tag: string): Locale | null {
  const t = tag.toLowerCase();
  if (t.startsWith("zh")) {
    if (/(^|[-_])(tw|hk|mo|hant)\b/.test(t)) return "zh-TW";
    if (/(^|[-_])sg\b/.test(t)) return "zh-SG";
    return "zh-CN";
  }
  const byLang: Partial<Record<string, Locale>> = {
    en: "en-US",
    ja: "ja-JP",
    ko: "ko-KR",
    ru: "ru-RU",
    fr: "fr-FR",
    es: "es-ES",
  };
  return byLang[t.split(/[-_]/)[0]] ?? null;
}

function detectLocale(): Locale {
  const pref = window.__WOWSP_OS_PREFS__?.locale;
  if (pref) {
    const hit = matchLocale(pref);
    if (hit) return hit;
  }
  const nav = typeof navigator !== "undefined" ? navigator.language : "en-US";
  return matchLocale(nav) ?? "en-US";
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: "en-US",
  // Link URLs (about.links.*) are en-US-only by design and fall back for
  // every other locale; key parity for all remaining messages is enforced
  // by scripts/check_i18n.py, so per-key fallback chatter is just dev noise.
  fallbackWarn: false,
  messages,
});

export function setLocale(locale: Locale): void {
  (i18n.global.locale as unknown as { value: Locale }).value = locale;
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

export function t(key: string, params?: Record<string, unknown>): string {
  return i18n.global.t(key, params as never);
}
