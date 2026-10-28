/**
 * The dedicated translation-test window: preset case groups drive one line
 * through the real pipeline, and the window explains the call with three
 * boxes (system prompt / structured user payload / structured response) plus
 * the compact result summary. The tests pin the preset data's group→case
 * reset, the store call, the trace rendering (including the raw-response
 * fallback), the inline error and the disabled gate.
 *
 * hikari is partially stubbed: the REAL HkModal is kept (its footer is
 * teleported into body), while the form widgets become interactive doubles
 * whose state the assertions read (HkJsonTree exposes its text/value as data
 * attributes, HkSelect is a plain <select>).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";

import type {
  ChatTranslateConfigPublic,
  ChatTranslateConfigResponse,
} from "@/api/modules/chat";

const mocks = vi.hoisted(() => ({
  chatApi: {
    getChatTranslateConfig: vi.fn(),
    setChatTranslateConfig: vi.fn(),
    testChatTranslateProvider: vi.fn(),
    debugTranslateText: vi.fn(),
  },
}));

vi.mock("@/api/modules/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/modules/chat")>();
  return { ...actual, chatTranslateApi: mocks.chatApi };
});
vi.mock("@/stores/settingsSavedFlash", () => ({ notifySettingsSaved: vi.fn() }));

vi.mock("@celestia-island/hikari", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@celestia-island/hikari")>();
  const HkSettingsHint = defineComponent({
    name: "HkSettingsHint",
    setup(_props, { slots }) {
      return () => h("div", { class: "stub-HkSettingsHint" }, slots.default?.() ?? []);
    },
  });
  const HkTag = defineComponent({
    name: "HkTag",
    setup(_props, { slots }) {
      return () => h("span", { class: "stub-HkTag" }, slots.default?.() ?? []);
    },
  });
  const HkButton = defineComponent({
    name: "HkButton",
    inheritAttrs: false,
    setup(_props, { slots, attrs }) {
      return () => h("button", { ...attrs, type: "button" }, slots.default?.() ?? []);
    },
  });
  const HkSelect = defineComponent({
    name: "HkSelect",
    props: {
      modelValue: { type: String, default: "" },
      options: { type: Array, default: () => [] },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      return () =>
        h(
          "select",
          {
            class: "stub-HkSelect",
            value: props.modelValue,
            onChange: (event: Event) =>
              emit("update:modelValue", (event.target as HTMLSelectElement).value),
          },
          (props.options as Array<{ value: string; label: string }>).map((option) =>
            h("option", { key: option.value, value: option.value }, option.label),
          ),
        );
    },
  });
  const HkJsonTree = defineComponent({
    name: "HkJsonTree",
    props: {
      text: { type: String, default: "" },
      value: { type: null, default: undefined },
      maxDepth: { type: Number, default: 8 },
    },
    setup(props) {
      return () =>
        h("div", {
          class: "stub-HkJsonTree",
          "data-text": props.text,
          "data-json":
            props.value === undefined || props.value === null
              ? undefined
              : JSON.stringify(props.value),
        });
    },
  });
  return { ...actual, HkButton, HkJsonTree, HkSelect, HkSettingsHint, HkTag };
});

import { initLocaleMessages, t } from "@/i18n";
import TranslateTestModal from "./TranslateTestModal";
import { useChatTranslateStore } from "@/stores/chatTranslate";

enableAutoUnmount(afterEach);

beforeAll(async () => {
  await initLocaleMessages();
});

function baseConfig(): ChatTranslateConfigPublic {
  return {
    enabled: true,
    consentVersion: 1,
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

function responseOf(
  config: ChatTranslateConfigPublic,
  extra: { apiKeySet?: boolean; envKeyOverride?: boolean } = {},
): ChatTranslateConfigResponse {
  return {
    config,
    apiKeySet: extra.apiKeySet ?? true,
    envKeyOverride: extra.envKeyOverride ?? false,
  };
}

const TRACE = {
  detected: "ja",
  translations: [{ lang: "zh-CN", text: "请保护我", source: "model" }],
  elapsedMs: 812,
  systemPrompt: "SYS PROMPT",
  userPayload: '{"text":"wp","targets":["zh-CN"]}',
  requestBody: { model: "deepseek-flash", messages: [] },
  response: { detected: "ja", "zh-CN": "请保护我" },
  responseRaw: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  setActivePinia(createPinia());
  document.body.innerHTML = "";
  mocks.chatApi.getChatTranslateConfig.mockResolvedValue(responseOf(baseConfig()));
  mocks.chatApi.debugTranslateText.mockResolvedValue(TRACE);
});

const caseText = () =>
  document.querySelector<HTMLElement>(".chat-settings__test-case-text")?.textContent ?? "";
const selects = () =>
  Array.from(document.querySelectorAll<HTMLSelectElement>(".stub-HkSelect"));
const trees = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".stub-HkJsonTree"));
const translateButton = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
    (button.textContent ?? "").includes(t("settings.chatTranslate.tryBtn")),
  );

async function mountModal() {
  await useChatTranslateStore().load();
  const wrapper = mount(TranslateTestModal, {
    props: { modelValue: true },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

describe("translation test window", () => {
  it("renders both pickers and the three empty result boxes", async () => {
    await mountModal();
    // Group + case pickers.
    const rows = selects();
    expect(rows).toHaveLength(2);
    // Exactly the four documented groups, and the 11 preset cases across them
    // (3 basic + 3 tactic + 2 multi + 3 edge).
    const groupOptions = Array.from(rows[0].options);
    expect(groupOptions.map((option) => option.value)).toEqual([
      "basic",
      "tactic",
      "multi",
      "edge",
    ]);
    const casesByGroup: Record<string, number> = {};
    for (const option of groupOptions) {
      rows[0].value = option.value;
      rows[0].dispatchEvent(new Event("change"));
      await flushPromises();
      casesByGroup[option.value] = selects()[1].options.length;
    }
    expect(casesByGroup).toEqual({ basic: 3, tactic: 3, multi: 2, edge: 3 });
    // Back to the first group for the rest of the assertions.
    rows[0].value = "basic";
    rows[0].dispatchEvent(new Event("change"));
    await flushPromises();
    expect(selects()[1].value).toBe("wp");
    expect(caseText()).toBe("wp");
    // No result yet: every box shows its placeholder, none shows trace data.
    const text = document.body.textContent ?? "";
    expect(text).toContain(t("settings.chatTranslate.testSystemPrompt"));
    expect(text).toContain(t("settings.chatTranslate.testInputPayload"));
    expect(text).toContain(t("settings.chatTranslate.testResponsePayload"));
    expect(trees()).toHaveLength(0);
  });

  it("resets the case to the group's first entry when the group changes", async () => {
    await mountModal();
    const [groupSelect, caseSelect] = selects();
    groupSelect.value = "edge";
    groupSelect.dispatchEvent(new Event("change"));
    await flushPromises();
    expect(caseText()).toBe("*** ??? 123");
    expect(selects()[1].value).toBe("symbols");
    caseSelect.value = "edge-japanese"; // stale option from the previous group: ignored
    caseSelect.dispatchEvent(new Event("change"));
    await flushPromises();
    expect(caseText()).toBe("*** ??? 123");
  });

  it("runs the selected preset through the store and renders the trace boxes", async () => {
    await mountModal();
    translateButton()!.click();
    await flushPromises();
    expect(mocks.chatApi.debugTranslateText).toHaveBeenCalledWith("wp", []);
    // Box 1: the system prompt verbatim.
    expect(document.body.textContent).toContain("SYS PROMPT");
    // Box 2 + 3: the JSON trees carry the structured payload / response.
    const renderedTrees = trees();
    expect(renderedTrees).toHaveLength(2);
    expect(renderedTrees[0].getAttribute("data-text")).toBe(TRACE.userPayload);
    expect(renderedTrees[1].getAttribute("data-json")).toBe(JSON.stringify(TRACE.response));
    // Result summary: detected language + latency + the translated row.
    expect(document.body.textContent).toContain(
      t("settings.chatTranslate.tryResult", { lang: "ja" }),
    );
    expect(document.body.textContent).toContain("812 ms");
    expect(document.body.textContent).toContain("请保护我");
    expect(document.body.textContent).toContain(
      t("settings.chatTranslate.trySourceModel"),
    );
  });

  it("hides the previous trace when the selected case changes", async () => {
    await mountModal();
    translateButton()!.click();
    await flushPromises();
    expect(caseText()).toBe("wp");
    expect(trees().length).toBeGreaterThan(0);
    const [, caseSelect] = selects();
    caseSelect.value = "gg";
    caseSelect.dispatchEvent(new Event("change"));
    await flushPromises();
    // The result of "wp" must not explain the "gg" case: boxes go empty
    // until the next run.
    expect(caseText()).toBe("gg");
    expect(trees()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("SYS PROMPT");
  });

  it("falls back to the raw response text when the answer did not parse", async () => {
    mocks.chatApi.debugTranslateText.mockResolvedValueOnce({
      ...TRACE,
      response: null,
      responseRaw: "not json, just text",
    });
    await mountModal();
    translateButton()!.click();
    await flushPromises();
    // Only the INPUT tree renders: a non-container answer is not a tree
    // (HkJsonTree renders containers only — a primitive or prose answer
    // would leave the box blank), so it lands in the readable pre instead.
    const renderedTrees = trees();
    expect(renderedTrees).toHaveLength(1);
    expect(renderedTrees[0].getAttribute("data-text")).toBe(TRACE.userPayload);
    // A non-JSON answer also lands in a readable pre block (the system
    // prompt's pre is a different one — collect them all).
    const pres = Array.from(
      document.querySelectorAll<HTMLElement>(".chat-settings__test-prompt"),
    ).map((node) => node.textContent ?? "");
    expect(pres.some((text) => text.includes("not json, just text"))).toBe(true);
  });

  it("splits a two-line user payload into a JSON head tree and a context pre", async () => {
    // WA's real payload: request JSON on line 1, the locked "context: {...}"
    // line on line 2 — the whole string is NOT valid JSON, so the box must
    // split it instead of handing it to HkJsonTree verbatim.
    const jsonLine = '{"text":"wp","targets":["zh-CN"],"selfLang":""}';
    const contextLine = 'context: {"shipNames":true,"teams":true}';
    mocks.chatApi.debugTranslateText.mockResolvedValueOnce({
      ...TRACE,
      userPayload: `${jsonLine}\n${contextLine}`,
    });
    await mountModal();
    translateButton()!.click();
    await flushPromises();
    // Head: exactly the JSON line (never the full two-line payload).
    const treeTexts = trees().map((node) => node.getAttribute("data-text") ?? "");
    expect(treeTexts).toContain(jsonLine);
    expect(treeTexts.some((text) => text.includes("\n"))).toBe(false);
    // Tail: the context line rendered verbatim in a pre block.
    const pres = Array.from(
      document.querySelectorAll<HTMLElement>(".chat-settings__test-prompt"),
    ).map((node) => node.textContent ?? "");
    expect(pres.some((text) => text.includes(contextLine))).toBe(true);
  });

  it("degrades to one pre block when the payload head is not JSON", async () => {
    const payload = "plain reminder\ncontext: {}";
    mocks.chatApi.debugTranslateText.mockResolvedValueOnce({
      ...TRACE,
      userPayload: payload,
    });
    await mountModal();
    translateButton()!.click();
    await flushPromises();
    // No payload tree (only the structured response tree remains).
    expect(trees()).toHaveLength(1);
    const pres = Array.from(
      document.querySelectorAll<HTMLElement>(".chat-settings__test-prompt"),
    ).map((node) => node.textContent ?? "");
    expect(pres.some((text) => text.includes(payload))).toBe(true);
  });

  it("shows a provider-side failure WITH its trace", async () => {
    // The shell reports a provider failure as an OK result carrying the
    // trace: the window shows the error sentence AND the three boxes.
    mocks.chatApi.debugTranslateText.mockResolvedValueOnce({
      ...TRACE,
      translations: [],
      response: null,
      responseRaw: "not json, just text",
      error: "translation service returned an unexpected answer",
    });
    await mountModal();
    translateButton()!.click();
    await flushPromises();
    const error = document.querySelector<HTMLElement>(".chat-settings__test-error");
    expect(error).not.toBeNull();
    expect(error!.textContent).toContain(
      t("settings.chatTranslate.translateTestFailed", {
        msg: "translation service returned an unexpected answer",
      }),
    );
    // The boxes still render the trace (system prompt + payload tree).
    expect(document.body.textContent).toContain("SYS PROMPT");
    expect(trees().length).toBeGreaterThan(0);
  });

  it("drops a result that lands after the case was switched away", async () => {
    let release: (value: unknown) => void = () => undefined;
    mocks.chatApi.debugTranslateText.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await mountModal();
    translateButton()!.click();
    await flushPromises();
    // In flight: switch the case, then let the old request finish.
    const [, caseSelect] = selects();
    caseSelect.value = "gg";
    caseSelect.dispatchEvent(new Event("change"));
    await flushPromises();
    release({ ...TRACE });
    await flushPromises();
    // The late trace belongs to "wp": it must not explain the "gg" case.
    expect(caseText()).toBe("gg");
    expect(trees()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("SYS PROMPT");
  });

  it("shows the pipeline error inline", async () => {
    mocks.chatApi.debugTranslateText.mockRejectedValueOnce(
      new Error("no API key configured"),
    );
    await mountModal();
    translateButton()!.click();
    await flushPromises();
    const error = document.querySelector<HTMLElement>(".chat-settings__test-error");
    expect(error).not.toBeNull();
    expect(error!.textContent).toContain("no API key configured");
    expect(trees()).toHaveLength(0);
  });

  it("blocks the probe while the feature is off", async () => {
    mocks.chatApi.getChatTranslateConfig.mockResolvedValue(
      responseOf({ ...baseConfig(), enabled: false }, { apiKeySet: true }),
    );
    await mountModal();
    const button = translateButton();
    expect(button).toBeDefined();
    expect(button!.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      t("settings.chatTranslate.tryNeedKey"),
    );
  });

  it("blocks the probe without a key", async () => {
    mocks.chatApi.getChatTranslateConfig.mockResolvedValue(
      responseOf(baseConfig(), { apiKeySet: false, envKeyOverride: false }),
    );
    await mountModal();
    expect(translateButton()!.disabled).toBe(true);
  });
});
