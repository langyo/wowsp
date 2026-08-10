export const SUPPORTED_LOCALES = [
  "en",
  "zh-Hans",
  "zh-Hant",
  "ja",
  "ko",
  "fr",
  "es",
  "ru",
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_OPTIONS: { code: Locale; label: string; native: string }[] = [
  { code: "en", label: "English", native: "EN" },
  { code: "zh-Hans", label: "简体中文", native: "简" },
  { code: "zh-Hant", label: "繁體中文", native: "繁" },
  { code: "ja", label: "日本語", native: "日" },
  { code: "ko", label: "한국어", native: "한" },
  { code: "fr", label: "Français", native: "FR" },
  { code: "es", label: "Español", native: "ES" },
  { code: "ru", label: "Русский", native: "RU" },
];

export function isValidLocale(v: string): v is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(v);
}

export function detectLocale(): Locale {
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  const lower = nav.toLowerCase();
  if (lower.startsWith("zh")) {
    if (lower.includes("hant") || lower.includes("tw") || lower.includes("hk")) return "zh-Hant";
    return "zh-Hans";
  }
  if (lower.startsWith("ja")) return "ja";
  if (lower.startsWith("ko")) return "ko";
  if (lower.startsWith("fr")) return "fr";
  if (lower.startsWith("es")) return "es";
  if (lower.startsWith("ru")) return "ru";
  return "en";
}
