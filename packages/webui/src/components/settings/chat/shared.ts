/** Shared value formatting for the chat-translation settings panes: the
 *  language options grid and the read-only summary values both the first-
 *  level section and the secondary windows show. Pure — no store, no t(). */
import {
  SUPPORTED_TRANSLATE_LANGS,
  TRANSLATE_LANG_LABELS,
  type TranslateLang,
} from "@/api/modules/chat";

/** Language tags as the checkbox grid's option list (native names). */
export const LANG_OPTIONS = SUPPORTED_TRANSLATE_LANGS.map((lang) => ({
  lang,
  label: TRANSLATE_LANG_LABELS[lang],
}));

/** Human name for one language tag (native name; the raw tag when unknown). */
export function languageLabel(tag: string): string {
  return SUPPORTED_TRANSLATE_LANGS.includes(tag as TranslateLang)
    ? TRANSLATE_LANG_LABELS[tag as TranslateLang]
    : tag;
}

/** The endpoint's host for the provider summary row: `https://api.deepseek.com/v1`
 *  → `api.deepseek.com`. A hand-edited value without a scheme falls back to
 *  the raw string (the shell heals it on save; the summary just shows it). */
export function endpointHost(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed === "") return "";
  try {
    return new URL(trimmed).host;
  } catch {
    return trimmed;
  }
}
