/**
 * The /feedback console's locale table — the SAME res/i18n/locales
 * facility the webui consumes (en-US baseline, 8 locales, key parity
 * enforced by scripts/check_i18n.py); the entries import the JSON
 * directly instead of the worker compile-time-embedding them.
 */
import { createI18n, type DefineLocaleMessage } from "vue-i18n";

export const FEEDBACK_LOCALES = [
  "en-US",
  "zh-CN",
  "zh-TW",
  "ja-JP",
  "ko-KR",
  "ru-RU",
  "fr-FR",
  "es-ES",
] as const;

import enUS from "@res/i18n/locales/en-US/feedback.json";
import zhCN from "@res/i18n/locales/zh-CN/feedback.json";
import zhTW from "@res/i18n/locales/zh-TW/feedback.json";
import jaJP from "@res/i18n/locales/ja-JP/feedback.json";
import koKR from "@res/i18n/locales/ko-KR/feedback.json";
import ruRU from "@res/i18n/locales/ru-RU/feedback.json";
import frFR from "@res/i18n/locales/fr-FR/feedback.json";
import esES from "@res/i18n/locales/es-ES/feedback.json";

const TABLE: Record<string, DefineLocaleMessage> = {
  "en-US": enUS,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  "ja-JP": jaJP,
  "ko-KR": koKR,
  "ru-RU": ruRU,
  "fr-FR": frFR,
  "es-ES": esES,
};

function detectLocale(): string {
  try {
    const saved = localStorage.getItem("wowsp-fb-locale");
    if (saved && saved in TABLE) return saved;
  } catch {
    /* storage unavailable */
  }
  const nav = navigator.language || "zh-CN";
  if (nav in TABLE) return nav;
  const short = nav.split("-")[0];
  const hit = FEEDBACK_LOCALES.find((code) => code.startsWith(`${short}-`));
  return hit ?? "zh-CN";
}

export function createFeedbackI18n() {
  return createI18n({
    legacy: false,
    locale: detectLocale(),
    fallbackLocale: "en-US",
    messages: TABLE,
  });
}
