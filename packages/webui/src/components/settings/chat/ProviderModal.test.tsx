/**
 * The simplified provider window (registry pickers removed per user request):
 *
 *  - the endpoint, the model and the API key are three hand-typed full-width
 *    rows; the model's placeholder is the shell's default deepseek-flash;
 *  - no service-provider / model dropdown exists anywhere in the window;
 *  - timeout + temperature live in the HkExpansionPanel, collapsed by default
 *    (aria-expanded=false) and rendered as two compact parameters on one line;
 *  - the connectivity test reports through toasts, Save writes the tri-state
 *    key (untouched = null / typed = replace / clear = "") and a failed save
 *    keeps the window open with the typed draft.
 *
 * hikari is partially stubbed: the real HkModal (footer teleports to body) and
 * the real HkExpansionPanel (its aria-expanded toggle is asserted) are kept;
 * the fields become small interactive doubles.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h } from "vue";

import type {
  ChatTranslateConfigPublic,
  ChatTranslateConfigResponse,
  ChatTranslateConfigUpdate,
} from "@/api/modules/chat";

const mocks = vi.hoisted(() => ({
  chatApi: {
    getChatTranslateConfig: vi.fn(),
    setChatTranslateConfig: vi.fn(),
    testChatTranslateProvider: vi.fn(),
    debugTranslateText: vi.fn(),
  },
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
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
  const HkInput = defineComponent({
    name: "HkInput",
    inheritAttrs: false,
    props: {
      modelValue: { type: String, default: "" },
      placeholder: { type: String, default: "" },
      disabled: { type: Boolean, default: false },
      variant: { type: String, default: "text" },
    },
    emits: ["update:modelValue"],
    setup(props, { emit, attrs }) {
      return () =>
        h("input", {
          ...attrs,
          class: ["stub-HkInput", attrs.class],
          value: props.modelValue,
          placeholder: props.placeholder,
          disabled: props.disabled,
          // Mirror the real component's password variant: the API-key row's
          // masking must be asserted, not assumed.
          type: props.variant === "password" ? "password" : undefined,
          onInput: (event: Event) =>
            emit("update:modelValue", (event.target as HTMLInputElement).value),
          // Mirror the real HkInput's submitOnEnter contract (the endpoint and
          // model fields save on Enter as well as through the footer).
          onKeydown: (event: KeyboardEvent) => {
            if (event.key !== "Enter") return;
            const submit = attrs.submitOnEnter as (() => void) | undefined;
            if (typeof submit === "function") submit();
          },
        });
    },
  });
  const HkNumberInput = defineComponent({
    name: "HkNumberInput",
    inheritAttrs: false,
    props: { modelValue: { type: Number, default: 0 } },
    emits: ["update:modelValue"],
    setup(props, { emit, attrs }) {
      return () =>
        h("input", {
          ...attrs,
          class: ["stub-HkNumberInput", attrs.class],
          type: "number",
          value: String(props.modelValue),
          onInput: (event: Event) =>
            emit(
              "update:modelValue",
              Number((event.target as HTMLInputElement).value),
            ),
        });
    },
  });
  return {
    ...actual,
    HkButton,
    HkInput,
    HkNumberInput,
    HkSettingsHint,
    HkTag,
    useToast: () => mocks.toast,
  };
});

import { initLocaleMessages, t } from "@/i18n";
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

function responseOf(
  config: ChatTranslateConfigPublic,
  apiKeySet = false,
): ChatTranslateConfigResponse {
  return { config, apiKeySet, envKeyOverride: false };
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

beforeEach(() => {
  vi.resetAllMocks();
  setActivePinia(createPinia());
  document.body.innerHTML = "";
  mocks.chatApi.getChatTranslateConfig.mockResolvedValue(responseOf(baseConfig()));
  mocks.chatApi.setChatTranslateConfig.mockImplementation(
    (update: ChatTranslateConfigUpdate) => Promise.resolve(echoConfig(update)),
  );
  mocks.chatApi.testChatTranslateProvider.mockResolvedValue({
    ok: true,
    latencyMs: 12,
    modelEcho: "deepseek-flash",
    error: null,
  });
});

const modalRoot = () => document.querySelector<HTMLElement>(".hk-modal-root");
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
const fieldByLabel = (label: string) =>
  Array.from(modalRoot()!.querySelectorAll<HTMLElement>(".chat-settings__field")).find(
    (field) => (field.textContent ?? "").includes(label),
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

describe("provider window (manual endpoint form)", () => {
  it("renders the manual fields and no dropdowns", async () => {
    await openWindow();
    expect(fieldByLabel(t("settings.chatTranslate.baseUrl"))).toBeDefined();
    expect(fieldByLabel(t("settings.chatTranslate.model"))).toBeDefined();
    expect(fieldByLabel(t("settings.chatTranslate.apiKey"))).toBeDefined();
    expect(modalRoot()!.textContent).toContain(
      t("settings.chatTranslate.advancedParams"),
    );
    // The registry pickers are gone: no select widget of any kind. The
    // real hikari HkSelect renders `.hk-select-wrapper` (not a native
    // <select>), so assert BOTH shapes — a future re-introduction must fail
    // here even if the test mock no longer stubs HkSelect.
    expect(modalRoot()!.querySelector("select")).toBeNull();
    expect(modalRoot()!.querySelector(".stub-HkSelect")).toBeNull();
    expect(modalRoot()!.querySelector(".hk-select-wrapper")).toBeNull();
    // Footer order: Close -> Test connection -> Save.
    const labels = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".hk-modal-footer button"),
    ).map((button) => button.textContent ?? "");
    expect(labels).toHaveLength(3);
    expect(labels[0]).toContain(t("settings.chatTranslate.close"));
    expect(labels[1]).toContain(t("settings.chatTranslate.testBtn"));
    expect(labels[2]).toContain(t("settings.chatTranslate.save"));
  });

  it("shows the shell's default model as the model placeholder", async () => {
    await openWindow();
    const modelInput = inputByPlaceholder("deepseek-flash");
    expect(modelInput).not.toBeNull();
    // The stored draft fills the field; the placeholder stays deepseek-flash.
    expect(modelInput!.placeholder).toBe("deepseek-flash");
    expect(modelInput!.value).toBe("my-model");
  });

  it("writes a hand-typed endpoint and model, leaving the key untouched", async () => {
    await openWindow();
    const baseUrl = inputByPlaceholder("https://api.deepseek.com")!;
    const model = inputByPlaceholder("deepseek-flash")!;
    baseUrl.value = "https://api.example.com/v1";
    baseUrl.dispatchEvent(new Event("input"));
    model.value = "deepseek-flash";
    model.dispatchEvent(new Event("input"));
    await flushPromises();
    footerButton(t("settings.chatTranslate.save")).click();
    await flushPromises();
    expect(setCalls()).toHaveLength(1);
    expect(setCalls()[0][0]).toEqual(
      expect.objectContaining({
        provider: expect.objectContaining({
          baseUrl: "https://api.example.com/v1",
          model: "deepseek-flash",
          apiKey: null,
        }),
      }),
    );
  });

  it("leaves an untouched key as null on save", async () => {
    // The "unchanged" arm: the shell keeps whatever key is stored on disk.
    await openWindow();
    footerButton(t("settings.chatTranslate.save")).click();
    await flushPromises();
    expect(setCalls()[0][0]).toEqual(
      expect.objectContaining({ provider: expect.objectContaining({ apiKey: null }) }),
    );
  });

  it("replaces the stored key when one is typed", async () => {
    await openWindow();
    const keyInput = inputByPlaceholder(
      t("settings.chatTranslate.apiKeyMissing"),
    )!;
    // The key field is masked and sits ALONE on its own row (the review's
    // "API key gets its own line" layout), not beside another input.
    expect(keyInput.getAttribute("type")).toBe("password");
    const keyRow = keyInput.closest(".chat-settings__field");
    expect(keyRow).not.toBeNull();
    expect(keyRow!.querySelectorAll("input")).toHaveLength(1);
    keyInput.value = "sk-test-replacement";
    keyInput.dispatchEvent(new Event("input"));
    await flushPromises();
    footerButton(t("settings.chatTranslate.save")).click();
    await flushPromises();
    expect(setCalls()[0][0]).toEqual(
      expect.objectContaining({
        provider: expect.objectContaining({ apiKey: "sk-test-replacement" }),
      }),
    );
  });

  it("clears the stored key through the clear button", async () => {
    // The "clear" arm: the button writes "" immediately (no footer save).
    mocks.chatApi.getChatTranslateConfig.mockResolvedValue(
      responseOf(baseConfig(), true),
    );
    await openWindow();
    const clearButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".hk-modal-root button"),
    ).find((button) =>
      (button.textContent ?? "").includes(t("settings.chatTranslate.apiKeyClear")),
    );
    expect(clearButton).toBeDefined();
    clearButton!.click();
    await flushPromises();
    expect(setCalls()[0][0]).toEqual(
      expect.objectContaining({ provider: expect.objectContaining({ apiKey: "" }) }),
    );
  });

  it("collapses the advanced parameters until expanded", async () => {
    await openWindow();
    const header = modalRoot()!.querySelector<HTMLButtonElement>(
      ".hk-expansion-panel-header",
    )!;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    // Two compact numeric parameters, not full-width fields.
    expect(modalRoot()!.querySelectorAll(".chat-settings__number")).toHaveLength(2);
    header.click();
    await flushPromises();
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(
      modalRoot()!.querySelectorAll(".stub-HkNumberInput.chat-settings__number"),
    ).toHaveLength(2);
    expect(modalRoot()!.textContent).toContain(
      t("settings.chatTranslate.temperature"),
    );
  });

  it("reports the connectivity test through toasts", async () => {
    await openWindow();
    footerButton(t("settings.chatTranslate.testBtn")).click();
    await flushPromises();
    await flushPromises();
    expect(mocks.chatApi.testChatTranslateProvider).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success).toHaveBeenLastCalledWith(
      t("settings.chatTranslate.testOkModel", {
        model: "deepseek-flash",
        ms: 12,
      }),
    );
    mocks.chatApi.testChatTranslateProvider.mockResolvedValueOnce({
      ok: false,
      latencyMs: 0,
      modelEcho: null,
      error: "synthetic timeout",
    });
    footerButton(t("settings.chatTranslate.testBtn")).click();
    await flushPromises();
    await flushPromises();
    expect(mocks.toast.error).toHaveBeenLastCalledWith(
      t("settings.chatTranslate.testFail", { msg: "synthetic timeout" }),
    );
  });

  it("keeps the window and the typed draft when the save fails", async () => {
    mocks.chatApi.setChatTranslateConfig.mockRejectedValueOnce(
      new Error("shell down"),
    );
    await openWindow();
    const keyInput = inputByPlaceholder(
      t("settings.chatTranslate.apiKeyMissing"),
    )!;
    keyInput.value = "sk-fresh";
    keyInput.dispatchEvent(new Event("input"));
    await flushPromises();
    footerButton(t("settings.chatTranslate.save")).click();
    await flushPromises();
    await flushPromises();
    // Still open, its typed key still on screen, and the failure is spelled out.
    expect(modalRoot()).not.toBeNull();
    expect(
      inputByPlaceholder(t("settings.chatTranslate.apiKeyMissing"))!.value,
    ).toBe("sk-fresh");
    expect(document.body.textContent).toContain(
      t("settings.chatTranslate.saveFailed"),
    );
  });

  it("keeps the endpoint and model drafts when the save fails", async () => {
    mocks.chatApi.setChatTranslateConfig.mockRejectedValueOnce(
      new Error("shell down"),
    );
    await openWindow();
    const baseUrl = inputByPlaceholder("https://api.deepseek.com")!;
    baseUrl.value = "https://typed.example/v2";
    baseUrl.dispatchEvent(new Event("input"));
    const model = inputByPlaceholder("deepseek-flash")!;
    model.value = "typed-model";
    model.dispatchEvent(new Event("input"));
    await flushPromises();
    footerButton(t("settings.chatTranslate.save")).click();
    await flushPromises();
    await flushPromises();
    // The window survives the failed write with BOTH typed drafts intact —
    // a retry must save the same endpoint/model, not the old stored pair.
    expect(modalRoot()).not.toBeNull();
    expect(inputByPlaceholder("https://api.deepseek.com")!.value).toBe(
      "https://typed.example/v2",
    );
    expect(model.value).toBe("typed-model");
    expect(document.body.textContent).toContain(
      t("settings.chatTranslate.saveFailed"),
    );
  });

  it("saves on Enter from the endpoint field", async () => {
    await openWindow();
    const baseUrl = inputByPlaceholder("https://api.deepseek.com")!;
    baseUrl.value = "https://enter.example/v1";
    baseUrl.dispatchEvent(new Event("input"));
    expect(
      mocks.chatApi.setChatTranslateConfig,
    ).not.toHaveBeenCalled();
    // The field's submit-on-enter wiring reaches the same save path as the
    // footer button.
    baseUrl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flushPromises();
    expect(mocks.chatApi.setChatTranslateConfig).toHaveBeenCalledTimes(1);
    expect(setCalls()[0][0]).toEqual(
      expect.objectContaining({
        provider: expect.objectContaining({
          baseUrl: "https://enter.example/v1",
        }),
      }),
    );
  });

  it("shows the shell-healed defaults after saving an empty model", async () => {
    // The shell heals an empty model to deepseek-flash; the response re-syncs
    // the drafts, so the window must show the healed value (not stay blank).
    mocks.chatApi.setChatTranslateConfig.mockImplementationOnce(
      (update: ChatTranslateConfigUpdate) =>
        Promise.resolve(
          responseOf({
            ...baseConfig(),
            provider: {
              ...update.provider,
              model: "deepseek-flash",
              apiKey: "",
            },
          }),
        ),
    );
    const wrapper = await openWindow();
    const model = inputByPlaceholder("deepseek-flash")!;
    model.value = "";
    model.dispatchEvent(new Event("input"));
    await flushPromises();
    footerButton(t("settings.chatTranslate.save")).click();
    await flushPromises();
    await flushPromises();
    // A successful save closes the window; reopening it shows the shell's
    // healed model (the store applied the response, the draft re-syncs). The
    // prop must go false first: the component's close is an emit, which the
    // host is responsible for applying before a reopen.
    await wrapper.setProps({ modelValue: false });
    await flushPromises();
    await wrapper.setProps({ modelValue: true });
    await flushPromises();
    expect(inputByPlaceholder("deepseek-flash")!.value).toBe("deepseek-flash");
  });
});
