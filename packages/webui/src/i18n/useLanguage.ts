/**
 * Language settings — two independent knobs, persisted to localStorage.
 *
 *   uiLocale      — the SOFTWARE INTERFACE language (menus, labels, the app's
 *                   own copy). Drives `i18n.global.locale` and `t()`. One of
 *                   the SUPPORTED_LOCALES (en / zhs / ...).
 *   dataLanguage  — the GAME-ASSET language used to fetch localized names
 *                   from the WG API (ships, captains, maps, ...). An explicit
 *                   WG language code so the user can force e.g. 国服简体 vs
 *                   亚服简体 independently of the UI language.
 *
 * The split exists because the same language can have different official
 * translations across regions — e.g. 国服 (CN) simplified uses animal names
 * for IJN ships while 亚服 (ASIA) uses standard historical names — and the
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

/** Explicit WG API language codes the user can choose for game assets. */
export const WG_LANGUAGES = [
  { value: "zh-cn", label: "简体中文（国服）" },
  { value: "zh-sg", label: "简体中文（亚服）" },
  { value: "zh-tw", label: "繁體中文（亞服）" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "ru", label: "Русский" },
  { value: "fr", label: "Français" },
  { value: "es", label: "Español" },
] as const;

/** UI-language dropdown options (the app's own supported locales). */
export const UI_LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: "en", label: "English" },
  { value: "zhs", label: "简体中文" },
];

/** Determine the best-fit WG language code from UI locale + realm.
 *  Called once on first startup when no data-language preference is saved. */
export function determineDataLanguage(ui: Locale, realm: string): string {
  if (ui === "zhs") {
    return realm === "cn" ? "zh-cn" : "zh-sg";
  }
  // en, ja, ko, etc. — happen to match WG codes directly
  return ui;
}

function loadUiLocale(): Locale {
  const saved = localStorage.getItem(UI_KEY) as Locale | null;
  if (saved && (SUPPORTED_LOCALES as readonly string[]).includes(saved)) return saved;
  return i18n.global.locale.value as Locale;
}

function loadDataLanguage(): string {
  const saved = localStorage.getItem(DATA_KEY);
  if (saved) return saved;

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

/** The effective WG language code is always the explicitly selected one
 *  (or the auto-determined one from first startup). */
export const effectiveWgLanguage = computed(() => dataLanguage.value);

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
