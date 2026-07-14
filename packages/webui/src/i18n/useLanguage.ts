/**
 * Language settings — two independent knobs, persisted to localStorage.
 *
 *   uiLocale      — the SOFTWARE INTERFACE language (menus, labels, the app's
 *                   own copy). Drives `i18n.global.locale` and `t()`. One of
 *                   the SUPPORTED_LOCALES (en / zhs / ...).
 *   dataLanguage  — the GAME-ASSET language used to fetch localized names
 *                   from the WG API (ships, captains, maps, ...). Either
 *                   "auto" (derive from uiLocale + active realm, preserving
 *                   the CN-server animal-name distinction) or an explicit WG
 *                   language code so the user can force e.g. 国服简体 vs
 *                   亚服繁体 independently of the UI language.
 *
 * The split exists because the same language can have different official
 * translations across regions — e.g. 国服 (CN) simplified uses animal names
 * for IJN ships while 亚服 (ASIA) uses standard historical names — and the
 * user may want a Japanese UI but English ship names, etc.
 *
 * `resolveWgLanguage` mirrors the Rust `resolve_encyclopedia_language` so the
 * frontend can show the effective WG code next to the dropdown, and the
 * encyclopedia store can pass either the resolved or explicit code through.
 */
import { computed, ref, watch } from "vue";

import { i18n, setLocale, SUPPORTED_LOCALES, type Locale } from "./index";
import { useAccountStore } from "@/stores/account";

const UI_KEY = "wowsp-ui-locale";
const DATA_KEY = "wowsp-data-language";

/** Explicit WG API language codes the user can force for game assets. */
export const WG_LANGUAGES = [
  { value: "auto", label: "auto" },
  { value: "zh-cn", label: "简体中文（国服）" },
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

function loadUiLocale(): Locale {
  const saved = localStorage.getItem(UI_KEY) as Locale | null;
  if (saved && (SUPPORTED_LOCALES as readonly string[]).includes(saved)) return saved;
  // Fall back to the i18n instance's already-detected locale.
  return i18n.global.locale.value as Locale;
}

function loadDataLanguage(): string {
  return localStorage.getItem(DATA_KEY) || "auto";
}

const uiLocale = ref<Locale>(loadUiLocale());
const dataLanguage = ref<string>(loadDataLanguage());

// Apply the persisted UI locale to the i18n instance on load.
setLocale(uiLocale.value);

/** The realm used to resolve "auto" data language (CN gets zh-cn animal names). */
function activeRealm(): string {
  const accounts = useAccountStore();
  return accounts.activeRealm || "asia";
}

/** Resolve the effective WG language code for the current settings + realm.
 *  Mirrors the Rust `resolve_encyclopedia_language`. When dataLanguage is
 *  "auto", the UI locale + realm decide; otherwise the explicit code wins. */
export function resolveWgLanguage(ui: Locale = uiLocale.value, data: string = dataLanguage.value): string {
  if (data !== "auto") return data;
  const realm = activeRealm();
  if (ui === "zhs") return realm === "cn" ? "zh-cn" : "zh-tw";
  if (ui === "zht") return "zh-tw";
  return ui;
}

/** The WG language code the encyclopedia should fetch in right now. Reactive
 *  over both settings + the active realm. */
export const effectiveWgLanguage = computed(() => resolveWgLanguage());

function setUiLocale(locale: Locale): void {
  uiLocale.value = locale;
  localStorage.setItem(UI_KEY, locale);
  setLocale(locale);
}

function setDataLanguage(code: string): void {
  dataLanguage.value = code;
  localStorage.setItem(DATA_KEY, code);
}

/** Keep the i18n instance in sync if uiLocale ever changes externally. */
watch(uiLocale, (l) => setLocale(l));

export function useLanguage() {
  return {
    uiLocale,
    dataLanguage,
    effectiveWgLanguage,
    uiLocaleOptions: UI_LOCALE_OPTIONS,
    wgLanguageOptions: WG_LANGUAGES,
    setUiLocale,
    setDataLanguage,
    resolveWgLanguage,
  };
}
