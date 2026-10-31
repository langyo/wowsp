import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";

const { chatMock, savedMock } = vi.hoisted(() => ({
  chatMock: {
    getChatTranslateConfig: vi.fn(),
    setChatTranslateConfig: vi.fn(),
    testChatTranslateProvider: vi.fn(),
    debugTranslateText: vi.fn(),
  },
  savedMock: { notifySettingsSaved: vi.fn() },
}));
vi.mock("@/api/modules/chat", () => ({ chatTranslateApi: chatMock }));
vi.mock("@/stores/settingsSavedFlash", () => savedMock);
import { useChatTranslateStore } from "./chatTranslate";
import type {
  ChatTranslateConfigPublic,
  ChatTranslateConfigResponse,
} from "@/api/modules/chat";

/** The shell's default config (chat-translate.toml pristine state). */
function baseConfig(): ChatTranslateConfigPublic {
  return {
    enabled: false,
    consentVersion: 0,
    provider: {
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      apiKey: "",
      timeoutMs: 10000,
      temperature: 0,
    },
    languages: { selfLang: "", mode: "auto", always: [], exclude: [], maxTargets: 4 },
    detect: { minChars: 2 },
    context: { shipNames: true, teams: true, recentLines: 8, nicknames: false },
    display: { maxLines: 8 },
    send: {
      // Conservative default — must mirror the shell's Default (off).
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

function response(
  overrides: Partial<ChatTranslateConfigPublic> = {},
  extra: { apiKeySet?: boolean; envKeyOverride?: boolean } = {},
): ChatTranslateConfigResponse {
  return {
    config: { ...baseConfig(), ...overrides },
    apiKeySet: extra.apiKeySet ?? false,
    envKeyOverride: extra.envKeyOverride ?? false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  setActivePinia(createPinia());
  chatMock.getChatTranslateConfig.mockResolvedValue(response());
  chatMock.setChatTranslateConfig.mockImplementation(
    async (update: { enabled: boolean; consentVersion: number }) =>
      response({ enabled: update.enabled, consentVersion: update.consentVersion }),
  );
});

describe("chat translation settings", () => {
  it("shares one initial read across concurrent callers", async () => {
    const read = deferred<ChatTranslateConfigResponse>();
    chatMock.getChatTranslateConfig.mockReturnValueOnce(read.promise);
    const store = useChatTranslateStore();
    const first = store.load();
    let secondFinished = false;
    const second = store.load().then(() => {
      secondFinished = true;
    });
    await flushPromises();
    expect(store.loaded).toBe(false);
    expect(secondFinished).toBe(false);
    expect(chatMock.getChatTranslateConfig).toHaveBeenCalledTimes(1);
    read.resolve(response({ provider: { ...baseConfig().provider, model: "test-model" } }));
    await Promise.all([first, second]);
    expect(store.loaded).toBe(true);
    expect(store.config.provider.model).toBe("test-model");
  });

  it("falls back to the defaults when the shell has no command yet", async () => {
    chatMock.getChatTranslateConfig.mockRejectedValueOnce(new Error("command not found"));
    const store = useChatTranslateStore();
    await store.load();
    expect(store.loaded).toBe(true);
    expect(store.config.enabled).toBe(false);
    expect(store.config.provider.baseUrl).toBe("https://api.deepseek.com");
    expect(store.config.send.splitChars).toBe(120);
  });

  it("writes the API key tri-state conservatively", async () => {
    const store = useChatTranslateStore();
    await store.load();
    // null = leave the stored key untouched (an unrelated provider edit
    // must never wipe it).
    await store.setProvider({ baseUrl: "https://example.test/v1" }, null);
    expect(chatMock.setChatTranslateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: expect.objectContaining({
          baseUrl: "https://example.test/v1",
          apiKey: null,
        }),
      }),
    );
    // "" = clear.
    await store.setProvider({}, "");
    expect(chatMock.setChatTranslateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: expect.objectContaining({ apiKey: "" }) }),
    );
    // a value = replace (test fixture only; never a real key).
    await store.setProvider({}, "sk-test-placeholder");
    expect(chatMock.setChatTranslateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: expect.objectContaining({ apiKey: "sk-test-placeholder" }),
      }),
    );
  });

  it("stamps consent together with the enable write", async () => {
    const store = useChatTranslateStore();
    await store.load();
    await store.acceptConsent();
    expect(chatMock.setChatTranslateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true, consentVersion: 1 }),
    );
    expect(store.config.enabled).toBe(true);
    expect(store.config.consentVersion).toBe(1);
  });

  it("merges section patches without dropping the other fields", async () => {
    const store = useChatTranslateStore();
    await store.load();
    await store.setLanguages({ mode: "fixed", always: ["ja", "ko"] });
    expect(chatMock.setChatTranslateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        languages: expect.objectContaining({
          mode: "fixed",
          always: ["ja", "ko"],
          // untouched fields survive the merge
          selfLang: "",
          maxTargets: 4,
        }),
        send: expect.objectContaining({ splitChars: 120 }),
      }),
    );
    await store.setSend({ suffixEnabled: false, suffixFormat: "unified" });
    expect(chatMock.setChatTranslateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        send: expect.objectContaining({
          suffixEnabled: false,
          suffixFormat: "unified",
          hintTimeoutS: 60,
        }),
      }),
    );
  });

  it("applies the sanitized response and the key flags as the truth", async () => {
    chatMock.setChatTranslateConfig.mockResolvedValueOnce(
      response(
        { languages: { ...baseConfig().languages, maxTargets: 6 } },
        { apiKeySet: true, envKeyOverride: true },
      ),
    );
    const store = useChatTranslateStore();
    await store.load();
    await store.setLanguages({ maxTargets: 99 });
    // The shell clamps 1..=6 — the store accepts the reply.
    expect(store.config.languages.maxTargets).toBe(6);
    expect(store.apiKeySet).toBe(true);
    expect(store.envKeyOverride).toBe(true);
    expect(savedMock.notifySettingsSaved).toHaveBeenCalledTimes(1);
  });

  it("records a connectivity-test result and surfaces command failures", async () => {
    const store = useChatTranslateStore();
    await store.load();
    chatMock.testChatTranslateProvider.mockResolvedValueOnce({
      ok: true,
      latencyMs: 87,
      modelEcho: "deepseek-flash",
      error: null,
    });
    await store.testProvider();
    expect(store.testing).toBe(false);
    expect(store.testResult).toEqual({
      ok: true,
      latencyMs: 87,
      modelEcho: "deepseek-flash",
      error: null,
    });
    chatMock.testChatTranslateProvider.mockRejectedValueOnce(
      new Error("synthetic provider timeout"),
    );
    await store.testProvider();
    expect(store.testResult?.ok).toBe(false);
    expect(store.testResult?.error).toContain("synthetic provider timeout");
  });

  it("records a try-translation result and normalizes its wire shape", async () => {
    chatMock.debugTranslateText.mockResolvedValueOnce({
      detected: "ja",
      translations: [
        { lang: "zh-CN", text: "请保护我", source: "model" },
        { lang: "en", text: "Protect me", source: "passthrough" },
        // A newer/odd shell row still degrades to a usable entry.
        { lang: "ko", text: null, source: "untranslatable" },
        { text: "no lang, dropped" },
      ],
      elapsedMs: 812,
      // The trace half: the translation-test window renders these.
      systemPrompt: "SYS PROMPT",
      userPayload: '{"text":"プロテクトして","targets":["zh-CN","en"]}',
      requestBody: { model: "deepseek-flash", messages: [] },
      response: { detected: "ja", "zh-CN": "请保护我" },
      responseRaw: null,
    });
    const store = useChatTranslateStore();
    await store.load();
    await store.debugTranslate("  プロテクトして  ", ["zh-CN", "en"]);
    // The draft is trimmed before it leaves the store.
    expect(chatMock.debugTranslateText).toHaveBeenCalledWith("プロテクトして", ["zh-CN", "en"]);
    expect(store.debugging).toBe(false);
    expect(store.debugError).toBeNull();
    expect(store.debugResult).toEqual({
      detected: "ja",
      translations: [
        { lang: "zh-CN", text: "请保护我", source: "model" },
        { lang: "en", text: "Protect me", source: "passthrough" },
        { lang: "ko", text: "", source: "untranslatable" },
      ],
      elapsedMs: 812,
      systemPrompt: "SYS PROMPT",
      userPayload: '{"text":"プロテクトして","targets":["zh-CN","en"]}',
      requestBody: { model: "deepseek-flash", messages: [] },
      response: { detected: "ja", "zh-CN": "请保护我" },
      responseRaw: null,
      error: null,
    });
  });

  it("tolerates an older shell without the debug-trace fields", async () => {
    chatMock.debugTranslateText.mockResolvedValueOnce({
      detected: null,
      translations: [],
      elapsedMs: 0,
    });
    const store = useChatTranslateStore();
    await store.load();
    await store.debugTranslate("hello");
    expect(store.debugError).toBeNull();
    expect(store.debugResult).toEqual({
      detected: null,
      translations: [],
      elapsedMs: 0,
      systemPrompt: "",
      userPayload: "",
      requestBody: null,
      response: null,
      responseRaw: null,
      error: null,
    });
  });

  it("keeps the provider-side failure sentence and trace apart from guard failures", async () => {
    // The shell reports a provider failure as an OK result: trace + error
    // together (guard failures reject instead).
    chatMock.debugTranslateText.mockResolvedValueOnce({
      detected: null,
      translations: [],
      elapsedMs: 640,
      systemPrompt: "SYS PROMPT",
      userPayload: '{"text":"wp","targets":["en"]}',
      requestBody: { model: "deepseek-flash", messages: [] },
      response: null,
      responseRaw: "not json, just text",
      error: "translation service returned an unexpected answer",
    });
    const store = useChatTranslateStore();
    await store.load();
    await store.debugTranslate("wp");
    expect(store.debugError).toBeNull();
    expect(store.debugResult?.error).toBe(
      "translation service returned an unexpected answer",
    );
    expect(store.debugResult?.responseRaw).toBe("not json, just text");
    expect(store.debugResult?.systemPrompt).toBe("SYS PROMPT");
  });

  it("surfaces try-translation failures and ignores blank input", async () => {
    const store = useChatTranslateStore();
    await store.load();
    chatMock.debugTranslateText.mockRejectedValueOnce(
      new Error("no API key configured — save one in Settings → Chat translation"),
    );
    await store.debugTranslate("hello");
    expect(store.debugging).toBe(false);
    expect(store.debugResult).toBeNull();
    expect(store.debugError).toContain("no API key configured");
    // Blank / whitespace-only input never reaches the shell.
    chatMock.debugTranslateText.mockClear();
    await store.debugTranslate("   ");
    expect(chatMock.debugTranslateText).not.toHaveBeenCalled();
  });

  it("ignores a second probe while one is already in flight", async () => {
    const store = useChatTranslateStore();
    await store.load();
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    chatMock.debugTranslateText.mockImplementationOnce(() => gate.then(() => ({})));
    const first = store.debugTranslate("hello");
    await store.debugTranslate("hello again");
    // The re-entrant call is a no-op: still exactly one shell call.
    expect(chatMock.debugTranslateText).toHaveBeenCalledTimes(1);
    release({});
    await first;
    expect(store.debugging).toBe(false);
  });

  it("never applies an older reply over a newer choice", async () => {
    // Later writes echo their own update back (the real shell sanitizes and
    // returns what it stored); the STALE first reply below claims the
    // untouched defaults, so applying it would flip both choices back.
    chatMock.setChatTranslateConfig.mockImplementation(
      async (update: {
        enabled: boolean;
        consentVersion: number;
        languages: ChatTranslateConfigPublic["languages"];
        send: ChatTranslateConfigPublic["send"];
      }) =>
        response({
          enabled: update.enabled,
          consentVersion: update.consentVersion,
          languages: update.languages,
          send: update.send,
        }),
    );
    const store = useChatTranslateStore();
    await store.load();
    const firstWrite = deferred<ChatTranslateConfigResponse>();
    chatMock.setChatTranslateConfig.mockReturnValueOnce(firstWrite.promise);
    const first = store.setLanguages({ mode: "fixed" });
    await flushPromises();
    const second = store.setSend({ suffixEnabled: false });
    await flushPromises();
    expect(chatMock.setChatTranslateConfig).toHaveBeenCalledTimes(1);
    // The stale reply claims the untouched defaults; it must be dropped.
    firstWrite.resolve(response());
    await Promise.all([first, second]);
    expect(store.config.languages.mode).toBe("fixed");
    expect(store.config.send.suffixEnabled).toBe(false);
  });

  it("exposes and writes the send mode", async () => {
    const store = useChatTranslateStore();
    await store.load();
    expect(store.sendMode).toBe("off");
    chatMock.setChatTranslateConfig.mockResolvedValueOnce(
      response({ send: { ...baseConfig().send, mode: "off" } }),
    );
    await store.setSendMode("off");
    expect(chatMock.setChatTranslateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        send: expect.objectContaining({ mode: "off" }),
      }),
    );
    // The shell's reply is the truth: the row flips with it.
    expect(store.sendMode).toBe("off");
    await store.setSendMode("clipboard");
    expect(chatMock.setChatTranslateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        send: expect.objectContaining({ mode: "clipboard" }),
      }),
    );
  });

  it("heals an unknown stored send mode to off (never auto-copies)", async () => {
    chatMock.getChatTranslateConfig.mockResolvedValueOnce(
      response({ send: { ...baseConfig().send, mode: "weird-value" } }),
    );
    const store = useChatTranslateStore();
    await store.load();
    expect(store.sendMode).toBe("off");
    expect(store.config.send.mode).toBe("off");
  });
});
