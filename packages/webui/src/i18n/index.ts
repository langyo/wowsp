/**
 * vue-i18n bootstrap. Locales (standardized BCP 47 lang-loc — the eight UI
 * codes the game-asset data language offers minus zh-SG, which exists only
 * as a data language) are auto-discovered from res/i18n/locales and
 * deep-merged by namespace path. The detected locale
 * comes from window.__WOWSP_OS_PREFS__ (seeded by the Tauri shell before
 * page load) or the browser. Adapted from shittim-chest's i18n.
 *
 * Locale JSON is LAZY: a non-eager glob keeps all 8 locales × 22 namespaces
 * out of the main bundle, and each locale's namespaces are awaited and
 * merged on first use (see loadLocaleMessages). The fallback (en-US) and
 * the resolved initial locale are preloaded before the app mounts
 * (initLocaleMessages), so rendering never races a missing message table,
 * and missing keys still fall back to en-US exactly as before.
 */
import { createI18n } from "vue-i18n";

import { syncHikariLocale } from "./hikariMessages";

const modules = import.meta.glob("../../../../res/i18n/locales/**/*.json");

export const SUPPORTED_LOCALES = [
  "en-US",
  "zh-CN",
  "zh-TW",
  "ja-JP",
  "ko-KR",
  "ru-RU",
  "fr-FR",
  "es-ES",
] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const FALLBACK_LOCALE: Locale = "en-US";

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
 *  locale. Chinese collapses by script — TW/HK/MO/Hant → zh-TW, every other
 *  zh (SG included) → zh-CN — and bare language tags pick the primary
 *  locale. Returns null when the language isn't offered. */
export function matchLocale(tag: string): Locale | null {
  const t = tag.toLowerCase();
  if (t.startsWith("zh")) {
    if (/(^|[-_])(tw|hk|mo|hant)\b/.test(t)) return "zh-TW";
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
  // Empty message table — locales are merged in lazily by
  // loadLocaleMessages (setLocaleMessage) before first render; the createI18n
  // default for `messages` is the same empty object.
  messages: {},
});

/** The active UI locale as the project's `Locale` union.
 *
 *  vue-i18n models the active locale as a plain `WritableComputedRef<string>`
 *  (the tag is data, so the library cannot know this app's eight codes), so
 *  reading `.locale.value` yields `string`. Validating through matchLocale is
 *  the honest narrowing: every in-app write goes through setLocale(), which
 *  only ever receives a `Locale`, so a tag that fails to match could only be
 *  a stale value — fall back exactly like detection does. */
export function currentLocale(): Locale {
  return matchLocale(i18n.global.locale.value) ?? FALLBACK_LOCALE;
}

/** Pre-mount bootstrap: load the fallback (en-US — vue-i18n resolves every
 *  missing key against it) and the resolved initial locale, so the first
 *  render already has its message table. When the initial locale IS the
 *  fallback it is loaded once. */
export async function initLocaleMessages(): Promise<void> {
  const initial = i18n.global.locale.value;
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
  i18n.global.locale.value = locale;
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
  // Hikari components carry their own chrome strings (its i18n context is
  // a separate module singleton) — keep them on the app's locale.
  syncHikariLocale(locale);
}

export function t(key: string, params?: Record<string, unknown>): string {
  return i18n.global.t(key, params as never);
}

/** Whether a message is registered for the key — the warning-free probe
 *  for optional message branches (t() on an absent key both echoes the
 *  key path and fires vue-i18n's missing-warn on every lookup). Callers
 *  still guard t()'s echoed-path sentinel; this just skips the noise. */
export function te(key: string): boolean {
  return i18n.global.te(key);
}

/**
 * Localize an error string that may be EITHER an i18n key or a raw
 * backend sentence. The plugin lifecycle stores' error contract mixes
 * shapes: their own sentinel values are keys ("common.game.offline" —
 * dot paths, no spaces), while command rejections arrive as raw anyhow
 * Display strings (English sentences, always with spaces). Only the key
 * may pass through t() — a lookup on a raw sentence is a guaranteed miss
 * that merely happens to echo the input back (and would break the day a
 * message collides with the interpolation syntax).
 */
export function tError(text: string): string {
  return /\s/.test(text) ? text : t(text);
}
