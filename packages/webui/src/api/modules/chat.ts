/** Chat-translation domain of the WoWSP API client: the provider config
 *  (chat-translate.toml, see commands/chat_translate/), the sanitized
 *  read/write pair the settings section drives, and the provider
 *  connectivity test. Composed into `api` by client.ts.
 *
 *  Secret discipline: the shell NEVER returns the API key — the public
 *  config's `provider.apiKey` is always "" and the state lives in the
 *  `apiKeySet` / `envKeyOverride` flags. A write carries
 *  `provider.apiKey`: null = leave the stored key unchanged, "" = clear
 *  it, a value = replace it.
 */
import { transport } from "@/transport";
import { RPC } from "@/rpc";

/** The v1 known-language table — the same list
 *  `wowsp_tauri_shared::chat_translate::SUPPORTED_LANGS` validates
 *  against (BCP 47 tags; bare language subtags where the game client
 *  itself uses one). The settings UI's target-language controls and the
 *  shell's self-heal pass share it. */
export const SUPPORTED_TRANSLATE_LANGS = [
  "zh-CN",
  "zh-TW",
  "ja",
  "ko",
  "ru",
  "en",
  "de",
  "fr",
  "es",
  "it",
  "pl",
  "cs",
  "tr",
  "pt",
  "uk",
  "th",
  "vi",
] as const;
export type TranslateLang = (typeof SUPPORTED_TRANSLATE_LANGS)[number];

/** Native names for the language pickers (language-neutral by design: a
 *  target-language list is most readable in the language it names, and
 *  these avoid 8-locale translation tables for 17 tags). */
export const TRANSLATE_LANG_LABELS: Record<TranslateLang, string> = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  ja: "日本語",
  ko: "한국어",
  ru: "Русский",
  en: "English",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  it: "Italiano",
  pl: "Polski",
  cs: "Čeština",
  tr: "Türkçe",
  pt: "Português",
  uk: "Українська",
  th: "ไทย",
  vi: "Tiếng Việt",
};

/** Provider endpoint settings (chat-translate.toml `[provider]`). */
export interface ChatTranslateProviderConfig {
  /** OpenAI-compatible base URL; must carry a scheme (the shell heals a
   *  scheme-less value back to the default). */
  baseUrl: string;
  model: string;
  /** Always "" in responses — see the module docstring. */
  apiKey: string;
  /** Request timeout, clamped 3 000..=60 000 shell-side. */
  timeoutMs: number;
  /** Sampling temperature, clamped 0.0..=2.0 shell-side. */
  temperature: number;
}

/** `[languages]`: target-language selection. */
export interface ChatTranslateLanguagesConfig {
  /** The user's own language; "" = follow the UI locale. The wire/TOML
   *  key is `selfLang` (not `self` — that is a Rust keyword, so the
   *  shell's field is `self_lang` under `rename_all = "camelCase"`). */
  selfLang: string;
  /** "auto" (translate whatever the battle speaks) | "fixed" (the
   *  picked target list only); unknown values heal to "auto". */
  mode: string;
  /** BCP 47 tags; the shell filters to the known table and dedupes. */
  always: string[];
  exclude: string[];
  /** Max target languages per request, clamped 1..=6. */
  maxTargets: number;
}

/** `[detect]` — foreign-language detection thresholds. */
export interface ChatTranslateDetectConfig {
  /** Clamped 1..=20 shell-side. */
  minChars: number;
}

/** `[context]` — the match context attached to each request. */
export interface ChatTranslateContextConfig {
  shipNames: boolean;
  teams: boolean;
  /** Clamped 0..=30 shell-side. */
  recentLines: number;
  nicknames: boolean;
}

/** `[display]` — data-side line cap (the overlay window's own cap is
 *  `chatPanelMaxLines` in overlay-config.toml). */
export interface ChatTranslateDisplayConfig {
  /** Clamped 3..=30 shell-side. */
  maxLines: number;
}

/** `[send]` — how translated chat is offered back to the game. */
export interface ChatTranslateSendConfig {
  /** "clipboard" | "off" in this version; unknown values heal to "off". */
  mode: string;
  suffixEnabled: boolean;
  /** "per-segment" | "unified"; unknown values heal to "per-segment". */
  suffixFormat: string;
  /** Message split threshold, clamped 40..=138 shell-side. */
  splitChars: number;
  /** Clamped 200..=5 000 shell-side. */
  paceMs: number;
  /** Clamped 1..=5 shell-side. */
  maxPerSend: number;
  /** Clamped 1..=100 shell-side. */
  perBattleCap: number;
  /** Clamped 0..=300 shell-side. */
  cooldownS: number;
  /** Clamped 5..=600 shell-side. */
  hintTimeoutS: number;
}

/** The sanitized config the shell returns (mirrors
 *  `ChatTranslateConfigPublic`; the IPC shape is the TOML key set in
 *  camelCase). */
export interface ChatTranslateConfigPublic {
  enabled: boolean;
  /** 0 = consent never given; enabling requires >= 1. */
  consentVersion: number;
  provider: ChatTranslateProviderConfig;
  languages: ChatTranslateLanguagesConfig;
  detect: ChatTranslateDetectConfig;
  context: ChatTranslateContextConfig;
  display: ChatTranslateDisplayConfig;
  send: ChatTranslateSendConfig;
}

/** Write shape (`ChatTranslateConfigUpdate`): the public shape with the
 *  tri-state API key — null = unchanged, "" = clear, a value = replace. */
export interface ChatTranslateConfigUpdate
  extends Omit<ChatTranslateConfigPublic, "provider"> {
  provider: Omit<ChatTranslateProviderConfig, "apiKey"> & {
    apiKey: string | null;
  };
}

/** `get_chat_translate_config` / `set_chat_translate_config` response.
 *  `apiKeySet` = a key is stored, `envKeyOverride` = the environment
 *  variable WOWSP_CHAT_TRANSLATE_API_KEY takes precedence over it. */
export interface ChatTranslateConfigResponse {
  config: ChatTranslateConfigPublic;
  apiKeySet: boolean;
  envKeyOverride: boolean;
}

/** `test_chat_translate_provider` result. `modelEcho` is the provider's
 *  own model id when the endpoint answered with one; `error` is a
 *  user-facing sentence (never includes the key or the Authorization
 *  header). */
export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  modelEcho: string | null;
  error: string | null;
}

export const chatTranslateApi = {
  getChatTranslateConfig: () =>
    transport.invoke<ChatTranslateConfigResponse>(RPC.get_chat_translate_config),
  setChatTranslateConfig: (update: ChatTranslateConfigUpdate) =>
    transport.invoke<ChatTranslateConfigResponse>(RPC.set_chat_translate_config, {
      update,
    }),
  testChatTranslateProvider: () =>
    transport.invoke<ProviderTestResult>(RPC.test_chat_translate_provider),
};
