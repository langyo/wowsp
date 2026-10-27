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
 *
 * The try-translation probe (`debugTranslate`) is the section's one
 * end-to-end check: it runs a typed line through the shell's real pipeline
 * and keeps the last result/error so the card can render them. The text
 * itself stays in the component (a draft input, not settings state).
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { chatTranslateApi } from "@/api/modules/chat";
import type {
  ChatTranslateConfigPublic,
  ChatTranslateConfigResponse,
  ChatTranslateConfigUpdate,
  ChatTranslateLanguagesConfig,
  ChatTranslateProviderConfig,
  ChatTranslateSendConfig,
  ChatTranslateSendMode,
  DebugTranslateResult,
  DebugTranslation,
  DebugTranslationSource,
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
      // Conservative default, mirroring the shell: the outgoing path stays
      // OFF until the user opts in on the settings card.
      mode: "off",
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
      // The shell heals unknown modes to "off"; a missing field (an
      // older shell) also falls back to the conservative "off" default.
      mode:
        send.mode === "off" || send.mode === "clipboard"
          ? send.mode
          : typeof send.mode === "string"
            ? "off"
            : base.send.mode,
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

/** The three debug sources, mirrored from the shell's projection. Unknown
 *  values from a newer shell degrade to "model" (a translated line is the
 *  common case and the label stays truthful enough for a debug row). */
function normalizeDebugSource(raw: unknown): DebugTranslationSource {
  return raw === "passthrough" || raw === "untranslatable" ? raw : "model";
}

/** Tolerant read of the shell's try-translation result: a malformed answer
 *  can only ever drop rows, never crash the card. */
function normalizeDebugResult(raw: unknown): DebugTranslateResult {
  if (raw === null || typeof raw !== "object") {
    return { detected: null, translations: [], elapsedMs: 0 };
  }
  const r = raw as {
    detected?: unknown;
    translations?: unknown;
    elapsedMs?: unknown;
  };
  const translations: DebugTranslation[] = Array.isArray(r.translations)
    ? r.translations
        .filter(
          (entry): entry is { lang: string; text: unknown; source: unknown } =>
            entry !== null &&
            typeof entry === "object" &&
            typeof (entry as { lang?: unknown }).lang === "string",
        )
        .map((entry) => ({
          lang: entry.lang,
          text: typeof entry.text === "string" ? entry.text : "",
          source: normalizeDebugSource(entry.source),
        }))
    : [];
  return {
    detected: typeof r.detected === "string" && r.detected !== "" ? r.detected : null,
    translations,
    elapsedMs:
      typeof r.elapsedMs === "number" && Number.isFinite(r.elapsedMs) ? r.elapsedMs : 0,
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
  /** Try-translation probe is in flight. */
  const debugging = ref(false);
  /** Last try-translation result; null until the first run (or after a
   *  failure, which lands in `debugError`). */
  const debugResult = ref<DebugTranslateResult | null>(null);
  /** User-facing error text from the last try-translation failure. */
  const debugError = ref<string | null>(null);
  /** Whether the LAST config write reached the shell (the provider window
   *  keeps itself open and says so instead of closing on a failed save). */
  const lastSaveOk = ref(true);
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
    lastSaveOk.value = true;
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
        // Best-effort persistence keeps the in-memory draft; only a STALE
        // failure is ignored — the newest write's failure is surfaced to
        // the caller (the provider window reads `lastSaveOk`).
        if (sequence === saveSequence) lastSaveOk.value = false;
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

  /** The send mode as the settings row reads it: the shell's sanitized value
   *  narrowed to the two supported picks (anything else = off, the safe
   *  reading — never silently auto-copy). */
  const sendMode = computed<ChatTranslateSendMode>(() =>
    config.value.send.mode === "clipboard" ? "clipboard" : "off",
  );

  /** The send card's mode row: off / clipboard (the shell heals the rest). */
  async function setSendMode(mode: ChatTranslateSendMode): Promise<void> {
    await setSend({ mode });
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

  /** Run one line through the shell's real translation pipeline. The
   *  pending save is flushed first, so the probe uses exactly the provider
   *  settings the card shows. Any failure (feature disabled, no key,
   *  provider error) lands in `debugError` as user-facing text. */
  async function debugTranslate(text: string, targets: string[] = []): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "") return;
    // Re-entry guard, armed SYNCHRONOUSLY before the first await: the card's
    // Enter path bypasses the button's disabled state, and a guard checked
    // after `await load()` would still let a second press slip through the
    // micro-task gap (the first finisher then clears `debugging` early and
    // the result becomes last-completion-wins).
    if (debugging.value) return;
    debugging.value = true;
    debugResult.value = null;
    debugError.value = null;
    try {
      await load();
      await pendingSave;
      const result = await chatTranslateApi.debugTranslateText(trimmed, targets);
      debugResult.value = normalizeDebugResult(result);
    } catch (error) {
      debugError.value = error instanceof Error ? error.message : String(error);
    } finally {
      debugging.value = false;
    }
  }

  return {
    config,
    apiKeySet,
    envKeyOverride,
    loaded,
    testing,
    testResult,
    debugging,
    debugResult,
    debugError,
    lastSaveOk,
    load,
    setEnabled,
    acceptConsent,
    setProvider,
    setLanguages,
    setSend,
    sendMode,
    setSendMode,
    testProvider,
    debugTranslate,
  };
});
