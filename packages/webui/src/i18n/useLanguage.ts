/**
 * Language settings — two independent knobs, persisted to localStorage.
 *
 *   uiLocale      — the SOFTWARE INTERFACE language (menus, labels, the app's
 *                   own copy). Drives `i18n.global.locale` and `t()`.
 *                   Standardized BCP 47 lang-loc — the same nine codes the
 *                   data language offers (see UI_LOCALE_OPTIONS).
 *   dataLanguage  — the GAME-ASSET language used to fetch localized names
 *                   (ships, maps, ...). Also standardized BCP 47 lang-loc:
 *                   "zh-CN" (国服简体), "zh-SG" (亚服简体), "zh-TW" (亚服繁体),
 *                   "en-US", "ja-JP", "ko-KR", "ru-RU", "fr-FR", "es-ES".
 *                   The explicit region suffix is what keeps 简体大陆 and
 *                   简体新加坡 distinct.
 *
 * Every external boundary converts from the canonical lang-loc:
 *   - WG API (`wgApiLanguage`): "zh-CN" → "zh-cn", "zh-SG" → "zh-cn".
 *     IMPORTANT: the WG API has no "zh-sg" language — every realm answers
 *     INVALID_LANGUAGE (407) for it. The API's ONLY simplified Chinese is
 *     "zh-cn", and its content is the harmonized CN translation (IJN ships
 *     get animal names) on every realm. The realm-distinct 亚服简体 original
 *     names live only in the game client files (res/texts/zh_sg) and reach
 *     the UI through the offline ship-name DB — NOT through the WG API.
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

import { RPC } from "@/rpc";
import { isTauri, transport } from "@/transport";

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
  // wgApi "zh-cn", NOT "zh-sg": the WG API rejects "zh-sg" with 407
  // INVALID_LANGUAGE on every realm (verified against the live API). Both
  // simplified-Chinese options share the API's single zh-cn content; the
  // 亚服 original names come from the offline game-file DB instead.
  { code: "zh-SG", label: "简体中文（亚服）", wgApi: "zh-cn", gettext: "zh_sg" },
  { code: "zh-TW", label: "繁體中文（亞服）", wgApi: "zh-tw", gettext: "zh_tw" },
  { code: "en-US", label: "English", wgApi: "en", gettext: "en" },
  { code: "ja-JP", label: "日本語", wgApi: "ja", gettext: "ja" },
  // NOTE: "ko" is not accepted by the asia realm API either — the
  // encyclopedia store falls back to en for the API call while display
  // names still resolve through the offline DB.
  { code: "ko-KR", label: "한국어", wgApi: "ko", gettext: "ko" },
  { code: "ru-RU", label: "Русский", wgApi: "ru", gettext: "ru" },
  { code: "fr-FR", label: "Français", wgApi: "fr", gettext: "fr" },
  { code: "es-ES", label: "Español", wgApi: "es", gettext: "es" },
];

const LANG_LOC_BY_CODE = new Map(LANG_LOCS.map((l) => [l.code, l]));

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

/** UI-language dropdown options — the same nine lang-locs the data language
 *  offers, labeled in their own language. The zh-CN / zh-SG pair shares one
 *  simplified-Chinese UI copy; the choice only seeds the FIRST-STARTUP data
 *  language (国服 vs 亚服 game-asset names), which stays independently
 *  switchable. */
export const UI_LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: "en-US", label: "English" },
  { value: "zh-CN", label: "简体中文（大陆）" },
  { value: "zh-SG", label: "简体中文（新加坡）" },
  { value: "zh-TW", label: "繁體中文（台灣）" },
  { value: "ja-JP", label: "日本語" },
  { value: "ko-KR", label: "한국어" },
  { value: "ru-RU", label: "Русский" },
  { value: "fr-FR", label: "Français" },
  { value: "es-ES", label: "Español" },
];

/** Determine the best-fit data language from UI locale + realm.
 *  Called once on first startup when no data-language preference is saved.
 *  Every UI locale is itself a valid data lang-loc — except 简体中文, where
 *  the realm decides 国服 vs 亚服 game-asset naming. */
export function determineDataLanguage(ui: Locale, realm: string): string {
  if (ui === "zh-CN") {
    return realm === "cn" ? "zh-CN" : "zh-SG";
  }
  return ui;
}

function loadUiLocale(): Locale {
  const saved = localStorage.getItem(UI_KEY) as string | null;
  if (saved && (SUPPORTED_LOCALES as readonly string[]).includes(saved)) {
    return saved as Locale;
  }
  const detected = (i18n.global.locale as unknown as { value: Locale }).value as Locale;
  // Heal-write: a saved-but-unsupported locale (stale tag from an older
  // build's locale list, hand edit) is forced back to the detected value so
  // the correction sticks instead of re-detecting on every boot.
  if (saved != null) {
    try {
      localStorage.setItem(UI_KEY, detected);
    } catch {
      // storage unavailable — the detected locale holds for the session
    }
  }
  return detected;
}

/** Installer-wizard locale → canonical UI locale. The installer shell
 *  offers ten wizard locales; the eight with a matching webui UI copy
 *  seed that locale, while de / pt have no UI locale here and stay
 *  unmapped — the seed ignores them. Anything else is unmappable and
 *  ignored too. */
const INSTALLER_LOCALE_TO_UI: Record<string, Locale> = {
  "zh-Hans": "zh-CN",
  "zh-Hant": "zh-TW",
  en: "en-US",
  ru: "ru-RU",
  ja: "ja-JP",
  ko: "ko-KR",
  fr: "fr-FR",
  es: "es-ES",
};

/** Map an installer-wizard locale onto a UI locale, or null when unknown. */
export function installerLocaleToUi(locale: string): Locale | null {
  return INSTALLER_LOCALE_TO_UI[locale] ?? null;
}

/**
 * First-startup seed: when the user has never picked a UI locale in the
 * app (no `wowsp-ui-locale` in localStorage), adopt the language the
 * installer wizard ran under — the app reads it from the on-disk install
 * manifest via the `installer_language` command. The seed NEVER overrides
 * a user's own choice: it runs only while the key is absent (re-checked
 * after the IPC round-trip) and is never persisted, so the system-locale
 * fallback stays in charge the moment the user picks (or declines to pick)
 * inside the app. Any failure — plain-browser build, older installer
 * without the command — keeps the existing locale untouched.
 */
export async function seedUiLocaleFromInstaller(): Promise<void> {
  if (localStorage.getItem(UI_KEY)) return;
  if (!isTauri()) return;
  try {
    const raw = await transport.invoke<string | null>(RPC.installer_language);
    if (localStorage.getItem(UI_KEY)) return;
    const seeded = raw ? installerLocaleToUi(raw) : null;
    if (seeded && seeded !== uiLocale.value) {
      uiLocale.value = seeded;
      // Await so callers observe the locale (and its messages) switched.
      await setLocale(seeded);
    }
  } catch {
    // Not available (mock backend / old installer) — keep the fallback.
  }
}

function loadDataLanguage(): string {
  const saved = localStorage.getItem(DATA_KEY);
  if (saved && isLangLoc(saved)) return saved;

  // First startup: determine from UI locale + realm, then persist.
  const ui = (i18n.global.locale as unknown as { value: Locale }).value as Locale;
  const realm = localStorage.getItem("wowsp-active-realm") || "asia";
  const determined = determineDataLanguage(ui, realm);
  localStorage.setItem(DATA_KEY, determined);
  return determined;
}

const uiLocale = ref<Locale>(loadUiLocale());
const dataLanguage = ref<string>(loadDataLanguage());

// Apply the persisted UI locale to the i18n instance on load. setLocale is
// async (the locale bundle loads on demand), so expose the in-flight apply:
// the app entry awaits it before mounting, keeping first paint in the
// persisted locale instead of flashing the detected one.
export const uiLocaleReady = setLocale(uiLocale.value);

// Consult the installer seed once, after the saved/system resolution ran:
// it can only ever upgrade a truly-first startup, never a stored choice.
void seedUiLocaleFromInstaller();

/** The effective data language is always the explicitly selected one
 *  (or the auto-determined one from first startup). */
export const effectiveWgLanguage = computed(() => wgApiLanguage(dataLanguage.value));

function setUiLocale(locale: Locale): void {
  uiLocale.value = locale;
  localStorage.setItem(UI_KEY, locale);
  // Fire-and-forget: a settings-dropdown toggle. Nothing here reads
  // messages synchronously after the switch, and reactive t() callers
  // re-render once the bundle lands and the locale ref flips.
  void setLocale(locale);
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
