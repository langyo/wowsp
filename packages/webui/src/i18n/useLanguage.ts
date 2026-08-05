/**
 * Language settings — two independent knobs, persisted to localStorage.
 *
 *   uiLocale      — the SOFTWARE INTERFACE language (menus, labels, the app's
 *                   own copy). Drives `i18n.global.locale` and `t()`.
 *                   Standardized BCP 47 lang-loc: "en-US" / "zh-CN".
 *   dataLanguage  — the GAME-ASSET language used to fetch localized names
 *                   (ships, maps, ...). Also standardized BCP 47 lang-loc:
 *                   "zh-CN" (国服简体), "zh-SG" (亚服简体), "zh-TW" (亚服繁体),
 *                   "en-US", "ja-JP", "ko-KR", "ru-RU", "fr-FR", "es-ES".
 *                   The explicit region suffix is what keeps 简体大陆 and
 *                   简体新加坡 distinct.
 *
 * Every external boundary converts from the canonical lang-loc:
 *   - WG API (`wgApiLanguage`): "zh-CN" → "zh-cn" (API uses lowercase codes)
 *   - game gettext dirs (`gettextDir`): "zh-CN" → "zh", "zh-SG" → "zh_sg",
 *     "zh-TW" → "zh_tw" (WG uses underscore dirs for the regional variants)
 *
 * The split exists because the same language can have different official
 * translations across regions — e.g. 国服 (CN) simplified uses animal names
 * for IJN ships while 亚服 (SG) uses standard historical names — and the
 * user may want a Japanese UI but English ship names, etc.
 *
 * On first startup (no saved preference), the data language is auto-determined
 * from the UI locale + active realm, then persisted so it behaves as if the
 * user selected it explicitly.
 */
import { computed, ref } from "vue";

import { i18n, setLocale, SUPPORTED_LOCALES, type Locale } from "./index";

const UI_KEY = "wowsp-ui-locale";
const DATA_KEY = "wowsp-data-language";

/** Canonical BCP 47 lang-loc → external code mappings.
 *  `wgApi` is the WG API language parameter; `gettext` is the game's
 *  res/texts/<dir> name. Both derived from the game install. */
interface LangLoc {
  code: string;
  label: string;
  wgApi: string;
  gettext: string;
}

export const LANG_LOCS: LangLoc[] = [
  { code: "zh-CN", label: "简体中文（国服）", wgApi: "zh-cn", gettext: "zh" },
  { code: "zh-SG", label: "简体中文（亚服）", wgApi: "zh-sg", gettext: "zh_sg" },
  { code: "zh-TW", label: "繁體中文（亞服）", wgApi: "zh-tw", gettext: "zh_tw" },
  { code: "en-US", label: "English", wgApi: "en", gettext: "en" },
  { code: "ja-JP", label: "日本語", wgApi: "ja", gettext: "ja" },
  { code: "ko-KR", label: "한국어", wgApi: "ko", gettext: "ko" },
  { code: "ru-RU", label: "Русский", wgApi: "ru", gettext: "ru" },
  { code: "fr-FR", label: "Français", wgApi: "fr", gettext: "fr" },
  { code: "es-ES", label: "Español", wgApi: "es", gettext: "es" },
];

const LANG_LOC_BY_CODE = new Map(LANG_LOCS.map((l) => [l.code, l]));

/** Legacy pre-standardization codes → canonical lang-loc (migration). */
const LEGACY_MIGRATION: Record<string, string> = {
  "zh-cn": "zh-CN",
  "zh-sg": "zh-SG",
  "zh-tw": "zh-TW",
  en: "en-US",
  ja: "ja-JP",
  ko: "ko-KR",
  ru: "ru-RU",
  fr: "fr-FR",
  es: "es-ES",
  zhs: "zh-CN",
};

/** WG API language parameter for a canonical lang-loc ("zh-CN" → "zh-cn"). */
export function wgApiLanguage(code: string): string {
  return LANG_LOC_BY_CODE.get(code)?.wgApi ?? code;
}

/** Game gettext directory for a canonical lang-loc ("zh-SG" → "zh_sg"). */
export function gettextDir(code: string): string {
  return LANG_LOC_BY_CODE.get(code)?.gettext ?? code;
}

/** Human label for a lang-loc, or the code itself when unknown. */
export function langLocLabel(code: string): string {
  return LANG_LOC_BY_CODE.get(code)?.label ?? code;
}

/** Whether a string is a canonical lang-loc we support. */
export function isLangLoc(code: string): boolean {
  return LANG_LOC_BY_CODE.has(code);
}

/** Data-language dropdown options (the game-asset languages). */
export const WG_LANGUAGES = LANG_LOCS.map(({ code, label }) => ({ value: code, label }));

/** UI-language dropdown options (the app's own supported locales). */
export const UI_LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: "en-US", label: "English" },
  { value: "zh-CN", label: "简体中文" },
];

/** Determine the best-fit data language from UI locale + realm.
 *  Called once on first startup when no data-language preference is saved. */
export function determineDataLanguage(ui: Locale, realm: string): string {
  if (ui === "zh-CN") {
    return realm === "cn" ? "zh-CN" : "zh-SG";
  }
  // en-US, ja-JP, etc. — the region suffix is implied by the UI choice
  return ui;
}

function loadUiLocale(): Locale {
  const saved = localStorage.getItem(UI_KEY) as string | null;
  if (saved) {
    if ((SUPPORTED_LOCALES as readonly string[]).includes(saved)) return saved as Locale;
    // Legacy "zhs" / "en" values from before standardization.
    const migrated = LEGACY_MIGRATION[saved];
    if (migrated && (SUPPORTED_LOCALES as readonly string[]).includes(migrated)) {
      return migrated as Locale;
    }
  }
  return i18n.global.locale.value as Locale;
}

function loadDataLanguage(): string {
  const saved = localStorage.getItem(DATA_KEY);
  if (saved) {
    if (isLangLoc(saved)) return saved;
    // Legacy WG codes ("zh-cn" / "zh-sg" / ...) → canonical lang-loc, then
    // persist the migration so it only happens once.
    const migrated = LEGACY_MIGRATION[saved];
    if (migrated) {
      localStorage.setItem(DATA_KEY, migrated);
      return migrated;
    }
  }

  // First startup: determine from UI locale + realm, then persist.
  const ui = i18n.global.locale.value as Locale;
  const realm = localStorage.getItem("wowsp-active-realm") || "asia";
  const determined = determineDataLanguage(ui, realm);
  localStorage.setItem(DATA_KEY, determined);
  return determined;
}

const uiLocale = ref<Locale>(loadUiLocale());
const dataLanguage = ref<string>(loadDataLanguage());

// Apply the persisted UI locale to the i18n instance on load.
setLocale(uiLocale.value);

/** The effective data language is always the explicitly selected one
 *  (or the auto-determined one from first startup). */
export const effectiveWgLanguage = computed(() => wgApiLanguage(dataLanguage.value));

function setUiLocale(locale: Locale): void {
  uiLocale.value = locale;
  localStorage.setItem(UI_KEY, locale);
  setLocale(locale);
}

function setDataLanguage(code: string): void {
  dataLanguage.value = code;
  localStorage.setItem(DATA_KEY, code);
}

export function useLanguage() {
  return {
    uiLocale,
    dataLanguage,
    effectiveWgLanguage,
    uiLocaleOptions: UI_LOCALE_OPTIONS,
    wgLanguageOptions: WG_LANGUAGES,
    setUiLocale,
    setDataLanguage,
  };
}
