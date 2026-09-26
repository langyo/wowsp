/**
 * vue-i18n bootstrap. Locales (standardized BCP 47 lang-loc — the same nine
 * codes the game-asset data language offers) are auto-discovered from
 * res/i18n/locales and deep-merged by namespace path. The detected locale
 * comes from window.__WOWSP_OS_PREFS__ (seeded by the Tauri shell before
 * page load) or the browser. Adapted from shittim-chest's i18n.
 *
 * Locale JSON is LAZY: a non-eager glob keeps all 9 locales × 17 namespaces
 * out of the main bundle, and each locale's namespaces are awaited and
 * merged on first use (see loadLocaleMessages). The fallback (en-US) and
 * the resolved initial locale are preloaded before the app mounts
 * (initLocaleMessages), so rendering never races a missing message table,
 * and missing keys still fall back to en-US exactly as before.
 */
import { createI18n } from "vue-i18n";

const modules = import.meta.glob("../../../../res/i18n/locales/**/*.json");

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

export const FALLBACK_LOCALE: Locale = "en-US";

type Messages = Record<string, Record<string, any>>;

/** Fold one namespace JSON into a locale's message tree at its namespace
 *  path (nested res/i18n/locales dirs become nested message keys) — the
 *  single merge implementation shared by every locale load. */
function mergeNamespace(
  target: Record<string, unknown>,
  ns: string,
  content: unknown,
): void {
  const nsParts = ns.split("/");
  let cur = target;
  for (let i = 0; i < nsParts.length - 1; i++) {
    cur[nsParts[i]] = (cur[nsParts[i]] as Record<string, unknown>) ?? {};
    cur = cur[nsParts[i]] as Record<string, unknown>;
  }
  cur[nsParts[nsParts.length - 1]] = content;
}

/** In-flight/finished locale loads, so concurrent callers share one load
 *  (and a loaded locale is never re-fetched or re-merged). A REJECTED load
 *  is evicted so a failed chunk fetch can be retried on the next switch. */
const localeLoads = new Map<string, Promise<void>>();

/** Load one locale's namespace JSONs and register the merged message tree
 *  on the i18n instance via setLocaleMessage. No-op (same resolved promise)
 *  when the locale is already loaded or loading. */
export function loadLocaleMessages(locale: string): Promise<void> {
  let load = localeLoads.get(locale);
  if (!load) {
    load = (async () => {
      const target: Record<string, unknown> = {};
      await Promise.all(
        Object.entries(modules).map(async ([path, importModule]) => {
          // path looks like: .../locales/en-US/common.json
          const m = path.match(/locales\/([^/]+)\/(.+)\.json$/);
          if (!m || m[1] !== locale) return;
          const mod = await importModule();
          mergeNamespace(target, m[2], (mod as { default: unknown }).default);
        }),
      );
      i18n.global.setLocaleMessage(locale, target);
    })();
    load.catch(() => localeLoads.delete(locale));
    localeLoads.set(locale, load);
  }
  return load;
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
  fallbackLocale: FALLBACK_LOCALE,
  // Link URLs (about.links.*) are en-US-only by design and fall back for
  // every other locale; key parity for all remaining messages is enforced
  // by scripts/check_i18n.py, so per-key fallback chatter is just dev noise.
  fallbackWarn: false,
  messages: {} as Messages,
});

/** Pre-mount bootstrap: load the fallback (en-US — vue-i18n resolves every
 *  missing key against it) and the resolved initial locale, so the first
 *  render already has its message table. When the initial locale IS the
 *  fallback it is loaded once. */
export async function initLocaleMessages(): Promise<void> {
  const initial = (i18n.global.locale as unknown as { value: Locale }).value;
  const loads = [loadLocaleMessages(FALLBACK_LOCALE)];
  if (initial !== FALLBACK_LOCALE) loads.push(loadLocaleMessages(initial));
  await Promise.all(loads);
}

/** Monotonic request sequence: only the MOST RECENT setLocale call flips the
 *  active locale once its bundle lands — two rapid switches to not-yet-
 *  loaded locales cannot invert the user's final choice when the slower
 *  chunk resolves last. */
let localeRequestSeq = 0;

export async function setLocale(locale: Locale): Promise<void> {
  const seq = ++localeRequestSeq;
  await loadLocaleMessages(locale);
  if (seq !== localeRequestSeq) return;
  (i18n.global.locale as unknown as { value: Locale }).value = locale;
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

export function t(key: string, params?: Record<string, unknown>): string {
  return i18n.global.t(key, params as never);
}
