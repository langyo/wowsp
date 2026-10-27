/**
 * The send card's mode row (M3): the clipboard auto-fill pick is a real
 * setting — the row renders both localized picks, mirrors the shell's stored
 * mode, and a click writes the pick through the settings store (which debounce-
 * free persists with a full public update; the shell heals/clamps).
 *
 * Only the controls the row touches are "real" in this mount: the hikari stub
 * renders HkTabs as clickable buttons (the section's own tabs stay
 * unreachable markup), everything else is a pass-through box. The chat API
 * module is mocked with the same fixtures the store test uses, and the
 * overlay-config store gets a canned get/set pair.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";

import type { ChatTranslateConfigPublic, ChatTranslateConfigResponse } from "@/api/modules/chat";

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
vi.mock("@/i18n", () => ({ t: (key: string) => key }));

vi.mock("@celestia-island/hikari", () => {
  const passthrough = (name: string) =>
    defineComponent({
      name,
      setup(_props, { slots }) {
        return () => h("div", { class: `stub-${name}` }, slots.default?.() ?? []);
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
          { class: "stub-hk-tabs" },
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
            class: "stub-hk-switch",
            onClick: () => emit("update:modelValue", !props.modelValue),
          },
          String(props.modelValue),
        );
    },
  });
  return {
    HkButton: passthrough("HkButton"),
    HkCheckbox: passthrough("HkCheckbox"),
    HkInput: passthrough("HkInput"),
    HkNumberInput: passthrough("HkNumberInput"),
    HkSelect: passthrough("HkSelect"),
    HkSettingsGroup: passthrough("HkSettingsGroup"),
    HkSettingsHint: passthrough("HkSettingsHint"),
    HkSettingsSub: passthrough("HkSettingsSub"),
    HkSwitch,
    HkTag: passthrough("HkTag"),
    HkTabs,
  };
});

import ChatTranslateSection from "./ChatTranslateSection";

enableAutoUnmount(afterEach);

function baseConfig(): ChatTranslateConfigPublic {
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

function response(config: ChatTranslateConfigPublic = baseConfig()): ChatTranslateConfigResponse {
  return { config, apiKeySet: false, envKeyOverride: false };
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

beforeEach(() => {
  vi.resetAllMocks();
  setActivePinia(createPinia());
  mocks.chatApi.getChatTranslateConfig.mockResolvedValue(response());
  mocks.chatApi.setChatTranslateConfig.mockResolvedValue(response());
  mocks.overlay.getOverlayConfig.mockResolvedValue(overlayConfig());
  mocks.overlay.setOverlayConfig.mockResolvedValue(overlayConfig());
});

describe("chat translation send card", () => {
  it("renders the send-mode row with both localized picks", async () => {
    const wrapper = mount(ChatTranslateSection);
    await flushPromises();
    const labels = wrapper.text();
    expect(labels).toContain("settings.chatTranslate.sendMode");
    expect(labels).toContain("settings.chatTranslate.sendModeDesc");
    expect(wrapper.find('[data-tab="off"]').text()).toBe(
      "settings.chatTranslate.sendModeOff",
    );
    expect(wrapper.find('[data-tab="clipboard"]').text()).toBe(
      "settings.chatTranslate.sendModeClipboard",
    );
  });

  it("mirrors the stored mode as the active pick", async () => {
    const wrapper = mount(ChatTranslateSection);
    await flushPromises();
    expect(wrapper.find('[data-tab="clipboard"]').attributes("data-active")).toBeDefined();
    expect(wrapper.find('[data-tab="off"]').attributes("data-active")).toBeUndefined();
  });

  it("writes the off pick through the settings store", async () => {
    const wrapper = mount(ChatTranslateSection);
    await flushPromises();
    await wrapper.find('[data-tab="off"]').trigger("click");
    await flushPromises();
    expect(mocks.chatApi.setChatTranslateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        send: expect.objectContaining({ mode: "off" }),
      }),
    );
  });

  it("writes the clipboard pick back after switching away", async () => {
    const wrapper = mount(ChatTranslateSection);
    await flushPromises();
    await wrapper.find('[data-tab="off"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-tab="clipboard"]').trigger("click");
    await flushPromises();
    expect(mocks.chatApi.setChatTranslateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        send: expect.objectContaining({ mode: "clipboard" }),
      }),
    );
  });
});
