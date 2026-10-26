/**
 * Chat-translation settings store: the `chat-translate.toml` public config
 * (provider endpoint, target-language selection, display/send knobs) plus
 * the provider connectivity-test state. Mirrors stores/overlayConfig: one
 * shared load, captured writes that stay ordered, and an older reply can
 * never roll back a choice the user made while that write was pending.
 *
 * Secret discipline (see api/modules/chat.ts): the shell never returns the
 * API key — this store only ever holds the tri-state write argument. The
 * section hands in `null` (unchanged) unless the user typed a replacement
 * or pressed the clear button (""), so an unrelated save can never wipe a
 * stored key.
 *
 * The shell sanitizes every value (clamps, unknown enum healing, known-
 * language filtering), so the store applies the RESPONSE as the truth and
 * treats its own draft as disposable.
 */
import { defineStore } from "pinia";
import { ref } from "vue";

import { chatTranslateApi } from "@/api/modules/chat";
import type {
  ChatTranslateConfigPublic,
  ChatTranslateConfigResponse,
  ChatTranslateConfigUpdate,
  ChatTranslateLanguagesConfig,
  ChatTranslateProviderConfig,
  ChatTranslateSendConfig,
  ProviderTestResult,
} from "@/api/modules/chat";
import { notifySettingsSaved } from "@/stores/settingsSavedFlash";

/** Field defaults mirrored from the shell's `chat-translate.toml` defaults
 *  (commands/chat_translate/config.rs): the pre-load render and a shell
 *  that predates the command both land on these instead of blank fields. */
function defaultConfig(): ChatTranslateConfigPublic {
  return {
    enabled: false,
    consentVersion: 0,
    provider: {
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      apiKey: "",
      timeoutMs: 10000,
      temperature: 0,
    },
    languages: { selfLang: "", mode: "auto", always: [], exclude: [], maxTargets: 4 },
    detect: { minChars: 2 },
    context: { shipNames: true, teams: true, recentLines: 8, nicknames: false },
    display: { maxLines: 8 },
    send: {
      mode: "clipboard",
      suffixEnabled: true,
      suffixFormat: "per-segment",
      splitChars: 120,
      paceMs: 500,
      maxPerSend: 3,
      perBattleCap: 20,
      cooldownS: 10,
      hintTimeoutS: 60,
    },
  };
}

/** Tolerant read of the shell's response: an older/partial answer can only
 *  ever produce the corresponding default, never a crash or a blank field.
 *  The API key is forced to "" — the response never carries it. */
function normalizeConfig(raw: unknown): ChatTranslateConfigPublic {
  const base = defaultConfig();
  if (raw === null || typeof raw !== "object") return base;
  const r = raw as Partial<ChatTranslateConfigPublic>;
  const provider = (r.provider ?? {}) as Partial<ChatTranslateProviderConfig>;
  const languages = (r.languages ?? {}) as Partial<ChatTranslateLanguagesConfig>;
  const detect = (r.detect ?? {}) as Partial<ChatTranslateConfigPublic["detect"]>;
  const context = (r.context ?? {}) as Partial<ChatTranslateConfigPublic["context"]>;
  const display = (r.display ?? {}) as Partial<ChatTranslateConfigPublic["display"]>;
  const send = (r.send ?? {}) as Partial<ChatTranslateSendConfig>;
  const tags = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const number = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : base.enabled,
    consentVersion: number(r.consentVersion, base.consentVersion),
    provider: {
      baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : base.provider.baseUrl,
      model: typeof provider.model === "string" ? provider.model : base.provider.model,
      apiKey: "",
      timeoutMs: number(provider.timeoutMs, base.provider.timeoutMs),
      temperature: number(provider.temperature, base.provider.temperature),
    },
    languages: {
      selfLang:
        typeof languages.selfLang === "string"
          ? languages.selfLang
          : base.languages.selfLang,
      mode: languages.mode === "fixed" ? "fixed" : "auto",
      always: tags(languages.always),
      exclude: tags(languages.exclude),
      maxTargets: number(languages.maxTargets, base.languages.maxTargets),
    },
    detect: { minChars: number(detect.minChars, base.detect.minChars) },
    context: {
      shipNames:
        typeof context.shipNames === "boolean" ? context.shipNames : base.context.shipNames,
      teams: typeof context.teams === "boolean" ? context.teams : base.context.teams,
      recentLines: number(context.recentLines, base.context.recentLines),
      nicknames:
        typeof context.nicknames === "boolean" ? context.nicknames : base.context.nicknames,
    },
    display: { maxLines: number(display.maxLines, base.display.maxLines) },
    send: {
      mode: typeof send.mode === "string" ? send.mode : base.send.mode,
      suffixEnabled:
        typeof send.suffixEnabled === "boolean" ? send.suffixEnabled : base.send.suffixEnabled,
      suffixFormat:
        send.suffixFormat === "unified" ? "unified" : "per-segment",
      splitChars: number(send.splitChars, base.send.splitChars),
      paceMs: number(send.paceMs, base.send.paceMs),
      maxPerSend: number(send.maxPerSend, base.send.maxPerSend),
      perBattleCap: number(send.perBattleCap, base.send.perBattleCap),
      cooldownS: number(send.cooldownS, base.send.cooldownS),
      hintTimeoutS: number(send.hintTimeoutS, base.send.hintTimeoutS),
    },
  };
}

export const useChatTranslateStore = defineStore("chatTranslate", () => {
  const config = ref<ChatTranslateConfigPublic>(defaultConfig());
  /** A key is stored on disk (the value itself never leaves the shell). */
  const apiKeySet = ref(false);
  /** WOWSP_CHAT_TRANSLATE_API_KEY is set and takes precedence over the file. */
  const envKeyOverride = ref(false);
  const loaded = ref(false);
  const testing = ref(false);
  /** Last connectivity-test result; null until the first run. */
  const testResult = ref<ProviderTestResult | null>(null);
  let pendingLoad: Promise<void> | null = null;
  let pendingSave = Promise.resolve();
  let saveSequence = 0;

  function applyResponse(response: ChatTranslateConfigResponse | null | undefined): void {
    config.value = normalizeConfig(response?.config);
    apiKeySet.value = response?.apiKeySet === true;
    envKeyOverride.value = response?.envKeyOverride === true;
  }

  /** Load once; every later caller shares the same promise. A failure (no
   *  shell command yet, or a broken file) keeps the defaults — the section
   *  still renders and saving retries. */
  function load(): Promise<void> {
    if (!pendingLoad) {
      pendingLoad = (async () => {
        try {
          applyResponse(await chatTranslateApi.getChatTranslateConfig());
        } catch {
          // missing command / mock backend — keep the defaults
        } finally {
          loaded.value = true;
        }
      })();
    }
    return pendingLoad;
  }

  /** Persist one merged config; `apiKey` is the write's tri-state secret
   *  argument (null = unchanged, "" = clear, value = replace). */
  function persist(next: ChatTranslateConfigPublic, apiKey: string | null): Promise<void> {
    const update: ChatTranslateConfigUpdate = {
      enabled: next.enabled,
      consentVersion: next.consentVersion,
      provider: { ...next.provider, apiKey },
      languages: { ...next.languages, always: [...next.languages.always], exclude: [...next.languages.exclude] },
      detect: { ...next.detect },
      context: { ...next.context },
      display: { ...next.display },
      send: { ...next.send },
    };
    const sequence = ++saveSequence;
    pendingSave = pendingSave.then(async () => {
      try {
        const saved = await chatTranslateApi.setChatTranslateConfig(update);
        // An older reply must not roll back a newer choice (the same
        // ordering contract stores/overlayConfig keeps).
        if (sequence !== saveSequence) return;
        applyResponse(saved);
        testResult.value = null;
        notifySettingsSaved();
      } catch {
        // best-effort persistence; the in-memory draft still applies
      }
    });
    return pendingSave;
  }

  /** Flip the master switch. Enabling without consent must go through
   *  acceptConsent (the section gates the switch on consentVersion). */
  async function setEnabled(enabled: boolean): Promise<void> {
    await load();
    config.value = { ...config.value, enabled };
    await persist(config.value, null);
  }

  /** The one-shot consent accept: enable AND stamp consentVersion 1 in the
   *  same write, so the consent block never reappears. */
  async function acceptConsent(): Promise<void> {
    await load();
    config.value = { ...config.value, enabled: true, consentVersion: 1 };
    await persist(config.value, null);
  }

  /** Provider card save: endpoint knobs + the tri-state key. */
  async function setProvider(
    patch: Partial<Omit<ChatTranslateProviderConfig, "apiKey">>,
    apiKey: string | null,
  ): Promise<void> {
    await load();
    config.value = {
      ...config.value,
      provider: { ...config.value.provider, ...patch },
    };
    await persist(config.value, apiKey);
  }

  /** Target-language controls (self / mode / always / exclude / maxTargets). */
  async function setLanguages(patch: Partial<ChatTranslateLanguagesConfig>): Promise<void> {
    await load();
    config.value = {
      ...config.value,
      languages: { ...config.value.languages, ...patch },
    };
    await persist(config.value, null);
  }

  /** Send-card toggles (suffix layout, split threshold, hint timeout). */
  async function setSend(patch: Partial<ChatTranslateSendConfig>): Promise<void> {
    await load();
    config.value = { ...config.value, send: { ...config.value.send, ...patch } };
    await persist(config.value, null);
  }

  /** Run the shell's connectivity probe against the STORED provider
   *  config (pending writes are flushed first, so "save then test" always
   *  tests what the card shows). A rejected command lands as a failed
   *  result — the card renders one path for both. */
  async function testProvider(): Promise<void> {
    await load();
    await pendingSave;
    testing.value = true;
    testResult.value = null;
    try {
      const result = await chatTranslateApi.testChatTranslateProvider();
      testResult.value = {
        ok: result?.ok === true,
        latencyMs:
          typeof result?.latencyMs === "number" && Number.isFinite(result.latencyMs)
            ? result.latencyMs
            : 0,
        modelEcho: typeof result?.modelEcho === "string" ? result.modelEcho : null,
        error: typeof result?.error === "string" ? result.error : null,
      };
    } catch (error) {
      testResult.value = {
        ok: false,
        latencyMs: 0,
        modelEcho: null,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      testing.value = false;
    }
  }

  return {
    config,
    apiKeySet,
    envKeyOverride,
    loaded,
    testing,
    testResult,
    load,
    setEnabled,
    acceptConsent,
    setProvider,
    setLanguages,
    setSend,
    testProvider,
  };
});
