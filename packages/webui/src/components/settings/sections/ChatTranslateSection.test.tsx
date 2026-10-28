/**
 * Settings → Chat translation, staged (user feedback wave):
 *
 *  1. OFF renders ONLY the master switch + the offHint line — no provider /
 *     languages / sending / display nodes, no Configure buttons, no windows;
 *  2. turning the switch on with consentVersion 0 opens the CONSENT window
 *     (real hikari HkModal, teleported footer → document.body) instead of
 *     enabling; only "Agree and enable" writes enabled+consentVersion;
 *  3. ON renders the four compact cards; each Configure button opens its
 *     secondary HkModal (the provider window holds the endpoint, key and
 *     connectivity test — the translation probe lives in its own first-level
 *     test window — the send window only the detail knobs; the off/clipboard
 *     pick stays inline). Controls keep writing the store immediately; the
 *     provider window stages its drafts and saves only from its footer.
 *
 * hikari is partially stubbed: the real HkModal/窗口 machinery is kept (the
 * teleported footer/body is what these tests assert against), while the form
 * widgets become small interactive doubles (tabs/switch/inputs) so the tests
 * can click and type. The shell api module is mocked with the store-test
 * fixtures; the i18n module is real so `t(key)` resolves the same text the
 * render used.
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
  overlay: {
    getOverlayConfig: vi.fn(),
    setOverlayConfig: vi.fn(),
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
vi.mock("@/api", () => ({
  api: {
    getOverlayConfig: mocks.overlay.getOverlayConfig,
    setOverlayConfig: mocks.overlay.setOverlayConfig,
  },
}));
vi.mock("@/stores/settingsSavedFlash", () => ({ notifySettingsSaved: vi.fn() }));

vi.mock("@celestia-island/hikari", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@celestia-island/hikari")>();
  const passthrough = (name: string) =>
    defineComponent({
      name,
      props: { title: { type: String, default: undefined } },
      setup(props, { slots }) {
        return () =>
          h("div", { class: `stub-${name}` }, [
            props.title ? h("span", { class: "stub-title" }, props.title) : null,
            slots.default?.() ?? [],
          ]);
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
      return () =>
        h("button", { ...attrs, type: "button" }, slots.default?.() ?? []);
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
            emit(
              "update:modelValue",
              Number((event.target as HTMLInputElement).value),
            ),
        });
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
  const HkSwitch = defineComponent({
    name: "HkSwitch",
    props: { modelValue: { type: Boolean, default: false } },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      return () =>
        h(
          "button",
          {
            type: "button",
            class: "stub-HkSwitch",
            "data-checked": props.modelValue ? "" : undefined,
            onClick: () => emit("update:modelValue", !props.modelValue),
          },
          props.modelValue ? "on" : "off",
        );
    },
  });
  const HkTabs = defineComponent({
    name: "HkTabs",
    props: {
      modelValue: { type: String, default: "" },
      tabs: { type: Array, default: () => [] },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      return () =>
        h(
          "div",
          { class: "stub-HkTabs" },
          (props.tabs as Array<{ key: string; label: string }>).map((tab) =>
            h(
              "button",
              {
                key: tab.key,
                type: "button",
                "data-tab": tab.key,
                "data-active": tab.key === props.modelValue ? "" : undefined,
                onClick: () => emit("update:modelValue", tab.key),
              },
              tab.label,
            ),
          ),
        );
    },
  });
  const HkCheckbox = defineComponent({
    name: "HkCheckbox",
    props: {
      modelValue: { type: Boolean, default: false },
      label: { type: String, default: "" },
    },
    emits: ["update:modelValue"],
    setup(props, { emit }) {
      return () =>
        h("label", { class: "stub-HkCheckbox" }, [
          h("input", {
            type: "checkbox",
            checked: props.modelValue,
            onChange: () => emit("update:modelValue", !props.modelValue),
          }),
          props.label,
        ]);
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
  return {
    ...actual,
    HkButton,
    HkCheckbox,
    HkInput,
    HkJsonTree,
    HkNumberInput,
    HkSelect,
    HkSettingsGroup: passthrough("HkSettingsGroup"),
    HkSettingsHint: passthrough("HkSettingsHint"),
    HkSettingsSub: passthrough("HkSettingsSub"),
    HkSwitch,
    HkTag,
    HkTabs,
    useToast: () => mocks.toast,
  };
});

import { initLocaleMessages, t } from "@/i18n";
import ChatTranslateSection from "./ChatTranslateSection";

enableAutoUnmount(afterEach);

// Load the real message tables: the assertions compare against the SAME
// localized strings the component renders (and the new keys' presence is
// exercised for real instead of echoing missing-key paths).
beforeAll(async () => {
  await initLocaleMessages();
});

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
      // Mirrors the shell's conservative default (off).
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

function enabledConfig(patch: Partial<ChatTranslateConfigPublic> = {}): ChatTranslateConfigPublic {
  return { ...baseConfig(), enabled: true, consentVersion: 1, ...patch };
}

function responseOf(
  config: ChatTranslateConfigPublic,
  extra: { apiKeySet?: boolean; envKeyOverride?: boolean } = {},
): ChatTranslateConfigResponse {
  return {
    config,
    apiKeySet: extra.apiKeySet ?? false,
    envKeyOverride: extra.envKeyOverride ?? false,
  };
}

function overlayConfig() {
  return {
    table: "detect",
    roster: "plugin",
    aimCard: true,
    aimCardHangPx: 60,
    chatPanel: true,
    chatPanelMaxLines: 8,
  };
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
  mocks.chatApi.debugTranslateText.mockResolvedValue({
    detected: "ja",
    translations: [{ lang: "en", text: "hello", source: "model" }],
    elapsedMs: 5,
  });
  mocks.overlay.getOverlayConfig.mockResolvedValue(overlayConfig());
  mocks.overlay.setOverlayConfig.mockResolvedValue(overlayConfig());
});

function mountSection(): VueWrapper {
  return mount(ChatTranslateSection, { attachTo: document.body });
}

const bodyText = () => document.body.textContent ?? "";

function bodyButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => (button.textContent ?? "").includes(label),
  );
}

/** HkModal teleports its footer actions into body. */
function footerButtons(): HTMLButtonElement[] {
  return Array.from(
    document.body.querySelectorAll<HTMLButtonElement>(".hk-modal-footer button"),
  );
}

function footerButton(label: string): HTMLButtonElement {
  const button = footerButtons().find((candidate) =>
    (candidate.textContent ?? "").includes(label),
  );
  if (!button) throw new Error(`footer button "${label}" not rendered`);
  return button;
}

function setCalls() {
  return mocks.chatApi.setChatTranslateConfig.mock.calls;
}

describe("chat translation settings staged pane", () => {
  it("hides every configuration node while the feature is off", async () => {
    const wrapper = mountSection();
    await flushPromises();
    const text = wrapper.text();
    // The switch stays; the off hint explains what enabling unlocks.
    expect(wrapper.find(".stub-HkSwitch").exists()).toBe(true);
    expect(text).toContain(t("settings.chatTranslate.offHint"));
    expect(text).not.toContain(t("settings.chatTranslate.providerTitle"));
    expect(text).not.toContain(t("settings.chatTranslate.languagesTitle"));
    expect(text).not.toContain(t("settings.chatTranslate.sendTitle"));
    expect(text).not.toContain(t("settings.chatTranslate.displayTitle"));
    // No Configure button, no consent/configuration window — not even an
    // unmounted-but-present modal host renders anything (hk-modal-root absent).
    expect(bodyButton(t("settings.chatTranslate.providerConfigure"))).toBeUndefined();
    expect(footerButtons()).toHaveLength(0);
    expect(document.querySelector(".hk-modal-root")).toBeNull();
    expect(setCalls()).toHaveLength(0);
  });

  it("opens the consent window instead of enabling on the first flip", async () => {
    const wrapper = mountSection();
    await flushPromises();
    await wrapper.find(".stub-HkSwitch").trigger("click");
    await flushPromises();
    // Nothing was enabled yet — the window is the gate.
    expect(setCalls()).toHaveLength(0);
    const consentText = bodyText();
    for (const key of [
      "settings.chatTranslate.consentBody",
      "settings.chatTranslate.consentLead",
      "settings.chatTranslate.consentItemText",
      "settings.chatTranslate.consentItemContext",
      "settings.chatTranslate.consentItemProvider",
      "settings.chatTranslate.consentItemLocal",
    ]) {
      expect(consentText).toContain(t(key));
    }
    expect(footerButton(t("settings.chatTranslate.consentAgree"))).toBeTruthy();
  });

  it("cancelling the consent window leaves the feature off", async () => {
    const wrapper = mountSection();
    await flushPromises();
    await wrapper.find(".stub-HkSwitch").trigger("click");
    await flushPromises();
    footerButton(t("settings.chatTranslate.consentCancel")).click();
    await flushPromises();
    expect(setCalls()).toHaveLength(0);
    expect(footerButtons()).toHaveLength(0);
    expect(wrapper.text()).toContain(t("settings.chatTranslate.offHint"));
  });

  it("agreeing enables and stamps the consent version", async () => {
    const wrapper = mountSection();
    await flushPromises();
    await wrapper.find(".stub-HkSwitch").trigger("click");
    await flushPromises();
    footerButton(t("settings.chatTranslate.consentAgree")).click();
    await flushPromises();
    expect(setCalls()).toHaveLength(1);
    expect(setCalls()[0][0]).toEqual(
      expect.objectContaining({ enabled: true, consentVersion: 1 }),
    );
    expect(footerButtons()).toHaveLength(0);
    // The store's echoed config flipped the section into the ON layout.
    expect(wrapper.text()).toContain(t("settings.chatTranslate.providerTitle"));
    expect(wrapper.text()).toContain(t("settings.chatTranslate.providerConfigure"));
  });

  it("shows the compact summaries and opens the provider window", async () => {
    mocks.chatApi.getChatTranslateConfig.mockResolvedValue(
      responseOf(
        enabledConfig({
          provider: {
            ...baseConfig().provider,
            baseUrl: "https://api.deepseek.com/v1",
            model: "deepseek-flash",
          },
        }),
      ),
    );
    const wrapper = mountSection();
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain("deepseek-flash");
    expect(text).toContain("api.deepseek.com");
    expect(text).toContain(t("settings.chatTranslate.apiKeyMissing"));
    for (const key of ["providerConfigure", "languagesConfigure", "sendConfigure"]) {
      expect(wrapper.text()).toContain(t(`settings.chatTranslate.${key}`));
    }
    // Provider window: all migrated controls, Save writes the tri-state key
    // as null (untouched) and closes.
    bodyButton(t("settings.chatTranslate.providerConfigure"))!.click();
    await flushPromises();
    const modal = document.querySelector(".hk-modal-root");
    expect(modal).not.toBeNull();
    expect(modal!.textContent).toContain(t("settings.chatTranslate.providerHint"));
    expect(modal!.querySelector("input")).not.toBeNull();
    footerButton(t("settings.chatTranslate.save")).click();
    await flushPromises();
    await flushPromises();
    expect(setCalls()).toHaveLength(1);
    expect(setCalls()[0][0]).toEqual(
      expect.objectContaining({
        provider: expect.objectContaining({ apiKey: null }),
      }),
    );
    expect(footerButtons()).toHaveLength(0);
  });

  it("keeps the provider window open with the typed key when the save fails", async () => {
    mocks.chatApi.getChatTranslateConfig.mockResolvedValue(
      responseOf(enabledConfig()),
    );
    mocks.chatApi.setChatTranslateConfig.mockRejectedValueOnce(
      new Error("shell down"),
    );
    mountSection();
    await flushPromises();
    bodyButton(t("settings.chatTranslate.providerConfigure"))!.click();
    await flushPromises();
    const modal = document.querySelector(".hk-modal-root");
    expect(modal).not.toBeNull();
    const keyPlaceholder = t("settings.chatTranslate.apiKeyMissing");
    const keyInput = modal!.querySelector<HTMLInputElement>(
      `input[placeholder="${keyPlaceholder}"]`,
    );
    expect(keyInput).not.toBeNull();
    keyInput!.value = "sk-fresh";
    keyInput!.dispatchEvent(new Event("input"));
    footerButton(t("settings.chatTranslate.save")).click();
    await flushPromises();
    await flushPromises();
    // Still open, its typed key still on screen, and the failure is spelled out.
    expect(document.querySelector(".hk-modal-root")).not.toBeNull();
    const reopenedKey = document.querySelector<HTMLInputElement>(
      `.hk-modal-root input[placeholder="${keyPlaceholder}"]`,
    );
    expect(reopenedKey?.value).toBe("sk-fresh");
    expect(document.body.textContent).toContain(
      t("settings.chatTranslate.saveFailed"),
    );
  });

  it("puts the connectivity test in the provider footer before Save, with toasts", async () => {
    mocks.chatApi.getChatTranslateConfig.mockResolvedValue(
      responseOf(enabledConfig(), { apiKeySet: true }),
    );
    mountSection();
    await flushPromises();
    bodyButton(t("settings.chatTranslate.providerConfigure"))!.click();
    await flushPromises();
    // Footer order: Close -> Test connection -> Save (Save rightmost/primary).
    const labels = footerButtons().map((button) => button.textContent ?? "");
    expect(labels).toHaveLength(3);
    expect(labels[0]).toContain(t("settings.chatTranslate.close"));
    expect(labels[1]).toContain(t("settings.chatTranslate.testBtn"));
    expect(labels[2]).toContain(t("settings.chatTranslate.save"));
    // The probe block left this window entirely.
    expect(bodyText()).not.toContain(t("settings.chatTranslate.tryTitle"));
    expect(
      document.querySelector<HTMLInputElement>(
        `input[placeholder="${t("settings.chatTranslate.tryLabel")}"]`,
      ),
    ).toBeNull();
    // Success toast carries the latency + echoed model.
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
    // Failure toast wraps the shell's raw sentence in the localized template.
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

  it("disables the footer test button while a connectivity test is in flight", async () => {
    mocks.chatApi.getChatTranslateConfig.mockResolvedValue(
      responseOf(enabledConfig(), { apiKeySet: true }),
    );
    let release: (value: unknown) => void = () => undefined;
    mocks.chatApi.testChatTranslateProvider.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    mountSection();
    await flushPromises();
    bodyButton(t("settings.chatTranslate.providerConfigure"))!.click();
    await flushPromises();
    const testButton = footerButton(t("settings.chatTranslate.testBtn"));
    testButton.click();
    await flushPromises();
    // The in-flight window: the same footer button is disabled (no double
    // requests) while the footer keeps its order.
    expect(
      footerButton(t("settings.chatTranslate.testBtn")).disabled,
    ).toBe(true);
    release({ ok: true, latencyMs: 7, modelEcho: null, error: null });
    await flushPromises();
    await flushPromises();
    expect(
      footerButton(t("settings.chatTranslate.testBtn")).disabled,
    ).toBe(false);
  });

  it("opens the translation-test window from the first level", async () => {
    mocks.chatApi.getChatTranslateConfig.mockResolvedValue(
      responseOf(enabledConfig(), { apiKeySet: true }),
    );
    mountSection();
    await flushPromises();
    expect(document.querySelector(".hk-modal-root")).toBeNull();
    bodyButton(t("settings.chatTranslate.translateTestOpen"))!.click();
    await flushPromises();
    const modal = document.querySelector(".hk-modal-root");
    expect(modal).not.toBeNull();
    expect(modal!.textContent).toContain(t("settings.chatTranslate.translateTestTitle"));
    expect(modal!.textContent).toContain(t("settings.chatTranslate.testGroupLabel"));
    expect(modal!.textContent).toContain(t("settings.chatTranslate.testCaseLabel"));
    // The new window is reachable only from the ON layout (button hidden on OFF
    // is covered by the off-state test's "no Configure buttons" assertion plus
    // the four-card gate).
  });

  it("opens the languages window and writes an immediate change", async () => {
    mocks.chatApi.getChatTranslateConfig.mockResolvedValue(
      responseOf(enabledConfig()),
    );
    mountSection();
    await flushPromises();
    bodyButton(t("settings.chatTranslate.languagesConfigure"))!.click();
    await flushPromises();
    const modal = document.querySelector(".hk-modal-root");
    expect(modal).not.toBeNull();
    expect(modal!.querySelector(".stub-HkSelect")).not.toBeNull();
    const fixed = modal!.querySelector<HTMLButtonElement>('[data-tab="fixed"]');
    expect(fixed).not.toBeNull();
    fixed!.click();
    await flushPromises();
    expect(setCalls()).toHaveLength(1);
    expect(setCalls()[0][0]).toEqual(
      expect.objectContaining({
        languages: expect.objectContaining({ mode: "fixed" }),
      }),
    );
  });

  it("opens the sending window for the detail knobs only", async () => {
    mocks.chatApi.getChatTranslateConfig.mockResolvedValue(
      responseOf(enabledConfig()),
    );
    const wrapper = mountSection();
    await flushPromises();
    // The primary off/clipboard pick stays on the first level, and clicking
    // it writes the mode immediately (the store's off/clipboard setter).
    const clipboardTab = wrapper.find('[data-tab="clipboard"]');
    expect(clipboardTab.exists()).toBe(true);
    await clipboardTab.trigger("click");
    await flushPromises();
    expect(setCalls()).toHaveLength(1);
    expect(setCalls()[0][0]).toEqual(
      expect.objectContaining({
        send: expect.objectContaining({ mode: "clipboard" }),
      }),
    );
    mocks.chatApi.setChatTranslateConfig.mockClear();
    bodyButton(t("settings.chatTranslate.sendConfigure"))!.click();
    await flushPromises();
    const modal = document.querySelector(".hk-modal-root");
    expect(modal).not.toBeNull();
    // Detail knobs: suffix switch + layout tabs + the two numbers.
    expect(modal!.querySelector(".stub-HkSwitch")).not.toBeNull();
    expect(modal!.querySelectorAll(".stub-HkNumberInput")).toHaveLength(2);
    const unified = modal!.querySelector<HTMLButtonElement>('[data-tab="unified"]');
    expect(unified).not.toBeNull();
    unified!.click();
    await flushPromises();
    expect(setCalls()).toHaveLength(1);
    expect(setCalls()[0][0]).toEqual(
      expect.objectContaining({
        send: expect.objectContaining({ suffixFormat: "unified" }),
      }),
    );
  });

  it("keeps the overlay panel switches inline on the ON layout", async () => {
    mocks.chatApi.getChatTranslateConfig.mockResolvedValue(
      responseOf(enabledConfig()),
    );
    const wrapper = mountSection();
    await flushPromises();
    expect(wrapper.text()).toContain(t("settings.chatTranslate.displayTitle"));
    expect(wrapper.text()).toContain(t("settings.chatTranslate.panelEnable"));
    expect(wrapper.text()).toContain(t("settings.chatTranslate.panelMaxLines"));
  });
});
