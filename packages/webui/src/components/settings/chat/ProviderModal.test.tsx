/**
 * The provider window's registry-driven shortcuts and layout:
 *
 *  - the service-provider / model pickers list the shared langyo/provider-registry
 *    catalog (localized names for the running interface locale) plus the
 *    custom entries;
 *  - picking a preset fills the endpoint and its preferred model; "custom"
 *    keeps both fields editable, so the window works without the registry;
 *  - the API key owns a full-width row, and timeout/temperature collapse into
 *    the HkExpansionPanel (closed by default, aria-expanded=false);
 *  - a catalog failure shows the localized sentence while the manual fields
 *    keep working.
 *
 * hikari is partially stubbed: the real HkModal (footer teleports to body) and
 * the real HkExpansionPanel (its aria-expanded toggle is what the collapse
 * test asserts) are kept; the pickers/inputs become small interactive doubles.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h } from "vue";

import type {
  ChatProviderRegistry,
  ChatTranslateConfigPublic,
  ChatTranslateConfigResponse,
  ChatTranslateConfigUpdate,
} from "@/api/modules/chat";

const mocks = vi.hoisted(() => ({
  chatApi: {
    getChatTranslateConfig: vi.fn(),
    setChatTranslateConfig: vi.fn(),
    testChatTranslateProvider: vi.fn(),
    getChatProviderRegistry: vi.fn(),
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
  const HkSpinner = defineComponent({
    name: "HkSpinner",
    setup() {
      return () => h("span", { class: "stub-HkSpinner" });
    },
  });
  const HkButton = defineComponent({
    name: "HkButton",
    inheritAttrs: false,
    setup(_props, { slots, attrs }) {
      return () => h("button", { ...attrs, type: "button" }, slots.default?.() ?? []);
    },
  });
  const HkIconButton = defineComponent({
    name: "HkIconButton",
    inheritAttrs: false,
    setup(_props, { slots, attrs }) {
      return () => h("button", { ...attrs, type: "button" }, slots.default?.() ?? []);
    },
  });
  const HkInput = defineComponent({
    name: "HkInput",
    props: {
      modelValue: { type: String, default: "" },
      placeholder: { type: String, default: "" },
      disabled: { type: Boolean, default: false },
      variant: { type: String, default: "text" },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      return () =>
        h("input", {
          class: "stub-HkInput",
          value: props.modelValue,
          placeholder: props.placeholder,
          disabled: props.disabled,
          // Mirrors the real component's password variant (the API-key row's
          // test asserts it is what the user sees).
          type: props.variant === "password" ? "password" : undefined,
          onInput: (event: Event) =>
            emit("update:modelValue", (event.target as HTMLInputElement).value),
        });
    },
  });
  const HkNumberInput = defineComponent({
    name: "HkNumberInput",
    props: { modelValue: { type: Number, default: 0 } },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      return () =>
        h("input", {
          class: "stub-HkNumberInput",
          type: "number",
          value: String(props.modelValue),
          onInput: (event: Event) =>
            emit("update:modelValue", Number((event.target as HTMLInputElement).value)),
        });
    },
  });
  const HkSelect = defineComponent({
    name: "HkSelect",
    props: {
      modelValue: { type: String, default: "" },
      options: { type: Array, default: () => [] },
      placeholder: { type: String, default: "" },
      disabled: { type: Boolean, default: false },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      return () =>
        h(
          "div",
          {
            class: "stub-HkSelect",
            "data-value": props.modelValue,
            "data-disabled": props.disabled ? "" : undefined,
          },
          (props.options as Array<{ value: string; label: string }>).map((option) =>
            h(
              "button",
              {
                key: option.value,
                type: "button",
                onClick: () => emit("update:modelValue", option.value),
              },
              option.label,
            ),
          ),
        );
    },
  });
  return {
    ...actual,
    HkButton,
    HkIconButton,
    HkInput,
    HkNumberInput,
    HkSelect,
    HkSettingsHint,
    HkSpinner,
    HkTag,
  };
});

import { i18n, initLocaleMessages, loadLocaleMessages, t } from "@/i18n";
import ProviderModal from "./ProviderModal";
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
      baseUrl: "https://custom.example/v1",
      model: "my-model",
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

function responseOf(config: ChatTranslateConfigPublic): ChatTranslateConfigResponse {
  return { config, apiKeySet: false, envKeyOverride: false };
}

/** The shell's echo for a settings write: store the update as the truth. */
function echoConfig(update: ChatTranslateConfigUpdate): ChatTranslateConfigResponse {
  return responseOf({
    enabled: update.enabled,
    consentVersion: update.consentVersion,
    provider: { ...update.provider, apiKey: "" },
    languages: update.languages,
    detect: update.detect,
    context: update.context,
    display: update.display,
    send: update.send,
  });
}

function names(en: string, zhs: string) {
  return { en, zhs, zht: zhs, ja: en, ko: en, fr: en, es: en, ru: en };
}

function registry(): ChatProviderRegistry {
  return {
    fetchedAt: 123,
    stale: false,
    providers: [
      {
        id: "deepseek_default",
        providerId: "deepseek",
        names: names("DeepSeek", "深度求索"),
        baseUrl: "https://api.deepseek.com",
        envVar: "DEEPSEEK_API_KEY",
        defaultModel: "deepseek-flash",
        models: [
          { id: "deepseek-flash", name: "DeepSeek Flash" },
          { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
        ],
      },
      {
        id: "openrouter_default",
        providerId: "openrouter",
        names: names("OpenRouter", "OpenRouter 中转"),
        baseUrl: "https://openrouter.ai/api/v1",
        envVar: null,
        defaultModel: null,
        models: [{ id: "vendor/model", name: null }],
      },
    ],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  setActivePinia(createPinia());
  document.body.innerHTML = "";
  (i18n.global.locale as unknown as { value: string }).value = "en-US";
  mocks.chatApi.getChatTranslateConfig.mockResolvedValue(responseOf(baseConfig()));
  mocks.chatApi.setChatTranslateConfig.mockImplementation(
    (update: ChatTranslateConfigUpdate) => Promise.resolve(echoConfig(update)),
  );
  mocks.chatApi.getChatProviderRegistry.mockResolvedValue(registry());
});

const modalRoot = () => document.querySelector<HTMLElement>(".hk-modal-root");
const selects = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".stub-HkSelect"));
const selectButton = (select: HTMLElement, label: string) =>
  Array.from(select.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => (button.textContent ?? "") === label,
  );
const footerButton = (label: string) => {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".hk-modal-footer button"),
  ).find((candidate) => (candidate.textContent ?? "").includes(label));
  if (!button) throw new Error(`footer button "${label}" not found`);
  return button;
};
const inputByPlaceholder = (placeholder: string) =>
  document.querySelector<HTMLInputElement>(
    `input.stub-HkInput[placeholder="${placeholder}"]`,
  );
const setCalls = () => mocks.chatApi.setChatTranslateConfig.mock.calls;

async function openWindow(): Promise<VueWrapper> {
  await useChatTranslateStore().load();
  const wrapper = mount(ProviderModal, {
    props: { modelValue: false },
    attachTo: document.body,
  });
  await flushPromises();
  await wrapper.setProps({ modelValue: true });
  await flushPromises();
  await flushPromises();
  return wrapper;
}

describe("provider window (registry + layout)", () => {
  it("loads the catalog on open and lists localized providers", async () => {
    await openWindow();
    expect(mocks.chatApi.getChatProviderRegistry).toHaveBeenCalledTimes(1);
    expect(mocks.chatApi.getChatProviderRegistry).toHaveBeenCalledWith(false);
    const providerSelect = selects()[0];
    expect(providerSelect).toBeDefined();
    for (const label of [
      t("settings.chatTranslate.providerPresetCustom"),
      "DeepSeek",
      "OpenRouter",
    ]) {
      expect(selectButton(providerSelect, label)).toBeDefined();
    }
    // The refresh control forces a live fetch and is disabled while loading.
    const refresh = document.querySelector<HTMLButtonElement>(
      `[aria-label="${t("settings.chatTranslate.registryRefresh")}"]`,
    );
    expect(refresh).not.toBeNull();
    refresh!.click();
    await flushPromises();
    expect(mocks.chatApi.getChatProviderRegistry).toHaveBeenLastCalledWith(true);
  });

  it("fills the endpoint and model from a preset and saves them", async () => {
    await openWindow();
    selectButton(selects()[0], "DeepSeek")!.click();
    await flushPromises();
    expect(inputByPlaceholder("https://api.deepseek.com")!.value).toBe(
      "https://api.deepseek.com",
    );
    const modelSelect = selects()[1];
    expect(modelSelect.getAttribute("data-value")).toBe("deepseek-flash");
    footerButton(t("settings.chatTranslate.save")).click();
    await flushPromises();
    expect(setCalls()).toHaveLength(1);
    expect(setCalls()[0][0]).toEqual(
      expect.objectContaining({
        provider: expect.objectContaining({
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-flash",
          apiKey: null,
        }),
      }),
    );
  });

  it("keeps the custom provider fully editable", async () => {
    await openWindow();
    // No registry match for the stored custom endpoint: free inputs are shown.
    const baseUrl = inputByPlaceholder("https://api.deepseek.com")!;
    const model = inputByPlaceholder("deepseek-flash")!;
    baseUrl.value = "https://elsewhere.example/v2";
    baseUrl.dispatchEvent(new Event("input"));
    model.value = "some-model";
    model.dispatchEvent(new Event("input"));
    await flushPromises();
    footerButton(t("settings.chatTranslate.save")).click();
    await flushPromises();
    expect(setCalls()[0][0]).toEqual(
      expect.objectContaining({
        provider: expect.objectContaining({
          baseUrl: "https://elsewhere.example/v2",
          model: "some-model",
        }),
      }),
    );
  });

  it("shows the free model input for the custom-model choice", async () => {
    await openWindow();
    selectButton(selects()[0], "DeepSeek")!.click();
    await flushPromises();
    selectButton(
      selects()[1],
      t("settings.chatTranslate.modelPresetCustom"),
    )!.click();
    await flushPromises();
    const modelInput = inputByPlaceholder("deepseek-flash")!;
    expect(modelInput).not.toBeNull();
    expect(modelInput.value).toBe("deepseek-flash");
    modelInput.value = "deepseek-experimental";
    modelInput.dispatchEvent(new Event("input"));
    await flushPromises();
    footerButton(t("settings.chatTranslate.save")).click();
    await flushPromises();
    expect(setCalls()[0][0]).toEqual(
      expect.objectContaining({
        provider: expect.objectContaining({ model: "deepseek-experimental" }),
      }),
    );
  });

  it("collapses the advanced parameters until expanded", async () => {
    await openWindow();
    const header = modalRoot()!.querySelector<HTMLButtonElement>(
      ".hk-expansion-panel-header",
    );
    expect(header).not.toBeNull();
    // Closed by default; the MD3 header owns the state via aria-expanded.
    expect(header!.getAttribute("aria-expanded")).toBe("false");
    header!.click();
    await flushPromises();
    expect(header!.getAttribute("aria-expanded")).toBe("true");
    expect(modalRoot()!.querySelectorAll(".stub-HkNumberInput")).toHaveLength(2);
    expect(modalRoot()!.textContent).toContain(
      t("settings.chatTranslate.advancedParams"),
    );
    // One row, two labelled compact fields (timeout + temperature) — not two
    // full-width bars stacked (the settings review's stretched-controls fix).
    expect(modalRoot()!.querySelectorAll(".chat-settings__param")).toHaveLength(2);
    expect(
      modalRoot()!.querySelectorAll(".stub-HkNumberInput.chat-settings__number"),
    ).toHaveLength(2);
  });

  it("gives the API key its own full-width row", async () => {
    await openWindow();
    const fields = Array.from(
      modalRoot()!.querySelectorAll<HTMLElement>(".chat-settings__field"),
    );
    const keyField = fields.find((field) =>
      (field.textContent ?? "").includes(t("settings.chatTranslate.apiKey")),
    );
    expect(keyField).toBeDefined();
    // A password field, alone on its own field row (the endpoint row is a
    // different field) — the layout the review asked for.
    const keyInput = keyField!.querySelector<HTMLInputElement>("input");
    expect(keyInput).not.toBeNull();
    expect(keyInput!.getAttribute("type")).toBe("password");
    expect(keyField!.querySelectorAll("input")).toHaveLength(1);
  });

  it("echoes a stored preset endpoint and model back into the pickers", async () => {
    mocks.chatApi.getChatTranslateConfig.mockResolvedValue(
      responseOf({
        ...baseConfig(),
        provider: {
          ...baseConfig().provider,
          baseUrl: "https://api.deepseek.com/",
          model: "deepseek-v4-pro",
        },
      }),
    );
    await openWindow();
    // A trailing slash / case difference still recognizes the preset.
    expect(selects()[0].getAttribute("data-value")).toBe("deepseek_default");
    expect(selects()[1].getAttribute("data-value")).toBe("deepseek-v4-pro");
    // A model OUTSIDE the preset's catalog falls back to the free input.
    mocks.chatApi.getChatTranslateConfig.mockResolvedValue(
      responseOf({
        ...baseConfig(),
        provider: {
          ...baseConfig().provider,
          baseUrl: "https://api.deepseek.com",
          model: "some-private-model",
        },
      }),
    );
    document.body.innerHTML = "";
    setActivePinia(createPinia());
    await openWindow();
    expect(selects()[1].getAttribute("data-value")).toBe("\u0000custom");
    expect(inputByPlaceholder("deepseek-flash")!.value).toBe("some-private-model");
  });

  it("disables the refresh control while a fetch is in flight", async () => {
    await openWindow();
    let release: (value: unknown) => void = () => undefined;
    mocks.chatApi.getChatProviderRegistry.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const refresh = document.querySelector<HTMLButtonElement>(
      `[aria-label="${t("settings.chatTranslate.registryRefresh")}"]`,
    )!;
    refresh.click();
    await flushPromises();
    expect(refresh.disabled).toBe(true);
    expect(refresh.querySelector(".stub-HkSpinner")).not.toBeNull();
    release(registry());
    await flushPromises();
    await flushPromises();
    expect(refresh.disabled).toBe(false);
  });

  it("never overwrites edits made while the catalog is still loading", async () => {
    let release: (value: unknown) => void = () => undefined;
    mocks.chatApi.getChatProviderRegistry.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await openWindow();
    // Catalog in flight: the user types the preset's own endpoint. The guard
    // is what keeps the late catalog from snapping the picker onto it — the
    // typed value alone would match, so removing the guard flips this test.
    const baseUrl = inputByPlaceholder("https://api.deepseek.com")!;
    baseUrl.value = "https://api.deepseek.com";
    baseUrl.dispatchEvent(new Event("input"));
    await flushPromises();
    release(registry());
    await flushPromises();
    await flushPromises();
    // The late catalog must NOT snap the picker onto a preset.
    expect(inputByPlaceholder("https://api.deepseek.com")!.value).toBe(
      "https://api.deepseek.com",
    );
    expect(selects()[0].getAttribute("data-value")).toBe("");
  });

  it("picks the entry whose catalog holds the stored model on a shared base URL", async () => {
    const sharedBase = "https://api.minimax.chat/v1";
    mocks.chatApi.getChatTranslateConfig.mockResolvedValue(
      responseOf({
        ...baseConfig(),
        provider: {
          ...baseConfig().provider,
          baseUrl: sharedBase,
          model: "minimax-m2.5",
        },
      }),
    );
    mocks.chatApi.getChatProviderRegistry.mockResolvedValue({
      fetchedAt: 1,
      stale: false,
      providers: [
        {
          id: "minimax_default",
          providerId: "minimax",
          names: names("MiniMax (China)", "MiniMax（中国）"),
          baseUrl: sharedBase,
          envVar: null,
          defaultModel: "MiniMax-M2.7",
          models: [
            { id: "MiniMax-M2.7", name: null },
            { id: "minimax-m2.5", name: null },
            { id: "MiniMax-Text-01", name: null },
          ],
        },
        {
          id: "minimax_coding_max",
          providerId: "minimax",
          names: names("MiniMax Coding Plan Max", "MiniMax 编程套餐 Max"),
          baseUrl: sharedBase,
          envVar: null,
          defaultModel: "minimax-m2.5",
          models: [
            { id: "minimax-m2.5", name: null },
            { id: "minimax-m2.1", name: null },
          ],
        },
      ],
    });
    await openWindow();
    // Both entries share the endpoint; the stored MODEL decides which plan
    // the picker reports (the shortest matching catalog = the more specific
    // plan entry).
    expect(selects()[0].getAttribute("data-value")).toBe("minimax_coding_max");
    expect(selects()[1].getAttribute("data-value")).toBe("minimax-m2.5");
  });

  it("says when the shown catalog is a stale cached fallback", async () => {
    mocks.chatApi.getChatProviderRegistry.mockResolvedValueOnce({
      ...registry(),
      stale: true,
    });
    await openWindow();
    expect(modalRoot()!.textContent).toContain(
      t("settings.chatTranslate.registryStale"),
    );
    // The cached providers are still pickable.
    expect(selectButton(selects()[0], "DeepSeek")).toBeDefined();
  });

  it("surfaces a catalog failure while the manual fields keep working", async () => {
    mocks.chatApi.getChatProviderRegistry.mockRejectedValueOnce(
      new Error("registry fetch failed"),
    );
    await openWindow();
    const text = modalRoot()!.textContent ?? "";
    expect(text).toContain(t("settings.chatTranslate.registryFailed"));
    expect(text).toContain("registry fetch failed");
    // The custom path is untouched: both fields are still there and save.
    const baseUrl = inputByPlaceholder("https://api.deepseek.com")!;
    const model = inputByPlaceholder("deepseek-flash")!;
    baseUrl.value = "https://manual.example/v1";
    baseUrl.dispatchEvent(new Event("input"));
    model.value = "manual-model";
    model.dispatchEvent(new Event("input"));
    await flushPromises();
    footerButton(t("settings.chatTranslate.save")).click();
    await flushPromises();
    expect(setCalls()[0][0]).toEqual(
      expect.objectContaining({
        provider: expect.objectContaining({
          baseUrl: "https://manual.example/v1",
          model: "manual-model",
        }),
      }),
    );
  });

  it("picks the registry names matching the interface locale", async () => {
    // Load the target locale so the mounted labels resolve too (the assertion
    // below only needs the registry names, but missing-key chatter is noise).
    await loadLocaleMessages("zh-CN");
    (i18n.global.locale as unknown as { value: string }).value = "zh-CN";
    await openWindow();
    const providerSelect = selects()[0];
    expect(selectButton(providerSelect, "深度求索")).toBeDefined();
    expect(
      selectButton(providerSelect, t("settings.chatTranslate.providerPresetCustom")),
    ).toBeDefined();
  });
});
