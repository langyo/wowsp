/**
 * Tests for the shared in-game plugin status card. Pinned here:
 *
 *  - the safe-mode shape: the quarantine copy replaces the install offer,
 *    and the action surface is the one-click "turn mods back on and
 *    repair" recovery (never an install/update the backend must refuse);
 *  - that recovery runs the shared flow — safe mode off first, then the
 *    embedded plugin install — and reports success;
 *  - the status-only shape (the live panel while the game runs) shows the
 *    same quarantine copy WITHOUT a button, because the recovery rename is
 *    a res_mods mutation the backend refuses during a live client;
 *  - a regression guard: the normal absent branch keeps its install
 *    button, untouched by the safe-mode work.
 *
 * The api module is mocked; the pinia stores are real so the card reads
 * the same state the app does. i18n is initialized before mounting, so
 * lookups compare the rendered copy.
 */
import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import { useToast } from "@celestia-island/hikari";

import { initLocaleMessages, t } from "@/i18n";

const mocks = vi.hoisted(() => ({
  ingamePluginInstall: vi.fn(),
  ingamePluginStatus: vi.fn(),
  modHubSafeMode: vi.fn(),
  modHubSetSafeMode: vi.fn(),
}));

vi.mock("@/api", () => ({
  api: {
    ingamePluginInstall: mocks.ingamePluginInstall,
    ingamePluginStatus: mocks.ingamePluginStatus,
    modHubSafeMode: mocks.modHubSafeMode,
    modHubSetSafeMode: mocks.modHubSetSafeMode,
  },
}));

import { useConfigStore } from "@/stores/config";
import type { GameInstall } from "@/api";

import PluginStatusCard from "./PluginStatusCard";

enableAutoUnmount(afterEach);

beforeAll(async () => {
  await initLocaleMessages();
});

const GAME = "C:/Games/WorldOfWarships";

/** The quarantine shape: live res_mods is renamed away, so the probe
 *  reports the plugin absent while safe mode explains why. */
const SAFE_STATUS = { installed: false, outdated: false, safeMode: true };

function mountCard(actions = true) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const config = useConfigStore();
  config.activeInstall = { kind: "manual", path: GAME, realm: "ru" } as GameInstall;
  const wrapper = mount(PluginStatusCard, {
    props: { actions },
    global: { plugins: [pinia] },
  });
  return wrapper;
}

/** Footer-less card: the one action button is inside the card body. */
const actionButton = (wrapper: ReturnType<typeof mountCard>) =>
  wrapper.find<HTMLButtonElement>("button.plugin-status-card__btn");

beforeEach(() => {
  mocks.ingamePluginInstall.mockReset();
  mocks.ingamePluginStatus.mockReset();
  mocks.modHubSafeMode.mockReset();
  mocks.modHubSetSafeMode.mockReset();
  mocks.ingamePluginStatus.mockResolvedValue(SAFE_STATUS);
  mocks.modHubSafeMode.mockResolvedValue(false);
  mocks.modHubSetSafeMode.mockResolvedValue(false);
  mocks.ingamePluginInstall.mockResolvedValue("ok");
  const toasts = useToast().toasts;
  for (const slot of [...toasts]) useToast().remove(slot.id);
});

describe("PluginStatusCard safe mode", () => {
  it("replaces the install offer with the quarantine copy and recovery action", async () => {
    const wrapper = mountCard();
    await flushPromises();

    const card = wrapper.find(".plugin-status-card");
    expect(card.classes()).toContain("plugin-status-card--safe-mode");
    expect(card.text()).toContain(t("replay.live.pluginSafeModeTitle"));
    expect(card.text()).toContain(t("replay.live.pluginSafeModeDesc"));
    // The backend refuses res_mods writes while quarantined — the card
    // must never offer install/update, only the recovery.
    expect(card.text()).not.toContain(t("replay.live.idlePluginInstall"));
    expect(card.text()).not.toContain(t("replay.live.idlePluginOffDesc"));

    const btn = actionButton(wrapper);
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toContain(t("replay.live.pluginSafeModeRepair"));
  });

  it("repairs through the shared store flow: mods back on, then install", async () => {
    mocks.ingamePluginInstall.mockImplementation(async () => {
      // The post-repair probe sees the quarantine gone and the plugin back.
      mocks.ingamePluginStatus.mockResolvedValue({
        installed: true,
        outdated: false,
        safeMode: false,
      });
    });
    const wrapper = mountCard();
    await flushPromises();

    await actionButton(wrapper).trigger("click");
    await flushPromises();

    expect(mocks.modHubSetSafeMode).toHaveBeenCalledWith(GAME, false);
    expect(mocks.ingamePluginInstall).toHaveBeenCalledWith(GAME);
    const texts = useToast().toasts.flatMap((s) => s.messages.map((m) => m.text));
    expect(texts).toContain(t("replay.live.pluginSafeModeRepaired"));
  });

  it("keeps the copy but hides the button on status-only surfaces", async () => {
    const wrapper = mountCard(false);
    await flushPromises();

    const card = wrapper.find(".plugin-status-card");
    expect(card.classes()).toContain("plugin-status-card--safe-mode");
    expect(card.text()).toContain(t("replay.live.pluginSafeModeDesc"));
    // The recovery rename is a mutation — no button while the game runs.
    expect(actionButton(wrapper).exists()).toBe(false);
  });
});

describe("PluginStatusCard normal branches", () => {
  it("keeps the absent branch's install offer untouched", async () => {
    mocks.ingamePluginStatus.mockResolvedValue({ installed: false, outdated: false });
    const wrapper = mountCard();
    await flushPromises();

    const card = wrapper.find(".plugin-status-card");
    expect(card.classes()).toContain("plugin-status-card--absent");
    expect(card.text()).toContain(t("replay.live.idlePluginOffTitle"));
    expect(card.text()).not.toContain(t("replay.live.pluginSafeModeTitle"));
    expect(actionButton(wrapper).text()).toContain(t("replay.live.idlePluginInstall"));
  });
});
