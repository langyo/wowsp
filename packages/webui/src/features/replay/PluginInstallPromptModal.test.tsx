/**
 * Tests for the standalone in-game plugin install prompt (the boot-time
 * second-chance ask) and the pluginPrompt store backing it.
 *
 * The window is the manual/auto re-entry for the plugin offer: AppShell
 * raises it for plugin-absent existing installs, and the settings'
 * closeBehavior section re-raises it via the same store. Pinned here:
 *
 *  - a plain 暂不安装 closes with the marker explicitly cleared, so the
 *    next boot may ask again;
 *  - a checked 暂不安装 persists the marker (the same slot the onboarding
 *    wizard's declined offer writes), silencing the boot-time ask;
 *  - the checkbox adopts the marker on open, so the settings-re-opened
 *    window round-trips the boot ask both ways (re-arm by clearing);
 *  - 一键安装 rides the shared ingamePlugin store and closes on success;
 *  - markPluginPromptDismissed (the wizard's direct write) lands in the
 *    same slot the store reads.
 *
 * i18n messages load lazily, so the bundle is in place before mounting —
 * footer buttons are then addressed by their localized labels.
 */
import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import { initLocaleMessages, t } from "@/i18n";

const mocks = vi.hoisted(() => ({
  ingamePluginInstall: vi.fn(),
  ingamePluginStatus: vi.fn(),
}));

vi.mock("@/api", () => ({
  api: {
    ingamePluginInstall: mocks.ingamePluginInstall,
    ingamePluginStatus: mocks.ingamePluginStatus,
  },
}));

import { useConfigStore } from "@/stores/config";
import { useIngamePluginStore } from "@/stores/ingamePlugin";
import { usePluginPromptStore, markPluginPromptDismissed } from "@/stores/pluginPrompt";
import type { GameInstall } from "@/api";

import PluginInstallPromptModal from "./PluginInstallPromptModal";

enableAutoUnmount(afterEach);

beforeAll(async () => {
  await initLocaleMessages();
});

const DISMISSED_KEY = "wowsp-plugin-prompt-dismissed";

/** A plausible active install — the plugin store only needs a root. */
function seedActiveInstall() {
  const config = useConfigStore();
  config.activeInstall = {
    kind: "manual",
    path: "C:/Games/WorldOfWarships",
    realm: "ru",
  } as GameInstall;
}

function mountPrompt() {
  const pinia = createPinia();
  setActivePinia(pinia);
  seedActiveInstall();
  const prompt = usePluginPromptStore();
  prompt.open();
  const wrapper = mount(PluginInstallPromptModal, { global: { plugins: [pinia] } });
  return { wrapper, prompt };
}

/** Footer action buttons in declared order ([later, install]). The modal
 *  teleports to document.body, so everything is queried there. */
const footerButtons = () =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>(".hk-modal-footer button"));

const checkboxInput = () =>
  document.body.querySelector<HTMLInputElement>("input.hk-checkbox-input");

beforeEach(() => {
  mocks.ingamePluginInstall.mockReset();
  mocks.ingamePluginStatus.mockReset();
  mocks.ingamePluginStatus.mockResolvedValue({ installed: false, outdated: false });
  localStorage.removeItem(DISMISSED_KEY);
  document.body.innerHTML = "";
});

describe("PluginInstallPromptModal", () => {
  it("renders the offer with the checkbox unchecked while open", async () => {
    mountPrompt();
    await flushPromises();

    expect(document.body.querySelector(".plugin-install-prompt")).not.toBeNull();
    expect(checkboxInput()).toBeTruthy();
    expect(checkboxInput()?.checked).toBe(false);
  });

  it("closes on 暂不安装 without the checkbox and leaves the marker unset", async () => {
    const { prompt } = mountPrompt();
    await flushPromises();

    const later = footerButtons().find((b) => b.textContent === t("replay.live.pluginPromptLater"));
    expect(later).toBeTruthy();
    later?.click();
    await flushPromises();

    expect(prompt.visible).toBe(false);
    expect(prompt.dismissed).toBe(false);
    // Unchecked decline writes the explicit re-arm value, not nothing.
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("0");
  });

  it("persists the 不再提示 marker on a checked decline", async () => {
    const { prompt } = mountPrompt();
    await flushPromises();

    checkboxInput()?.click();
    await flushPromises();
    const later = footerButtons().find((b) => b.textContent === t("replay.live.pluginPromptLater"));
    later?.click();
    await flushPromises();

    expect(prompt.visible).toBe(false);
    expect(prompt.dismissed).toBe(true);
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("1");
  });

  it("adopts the marker on open and a re-opened unchecked decline re-arms the boot ask", async () => {
    // The boot ask was previously silenced — the re-opened window must
    // show that state, and declining with the box cleared must re-arm it.
    localStorage.setItem(DISMISSED_KEY, "1");
    const { prompt } = mountPrompt();
    await flushPromises();

    expect(prompt.dismissed).toBe(true);
    expect(checkboxInput()?.checked).toBe(true);

    checkboxInput()?.click(); // clear the box
    await flushPromises();
    const later = footerButtons().find((b) => b.textContent === t("replay.live.pluginPromptLater"));
    later?.click();
    await flushPromises();

    expect(prompt.dismissed).toBe(false);
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("0");
  });

  it("installs through the shared plugin store and closes on success", async () => {
    mocks.ingamePluginInstall.mockImplementation(async () => {
      // The post-install refresh must see the bridge file present — flip
      // the probe the way the real backend would.
      mocks.ingamePluginStatus.mockResolvedValue({ installed: true, outdated: false });
    });
    const { prompt } = mountPrompt();
    await flushPromises();

    const install = footerButtons().find(
      (b) => b.textContent === t("replay.live.idlePluginInstall"),
    );
    expect(install).toBeTruthy();
    install?.click();
    await flushPromises();

    expect(mocks.ingamePluginInstall).toHaveBeenCalledWith("C:/Games/WorldOfWarships");
    expect(prompt.visible).toBe(false);
    expect(useIngamePluginStore().installed).toBe(true);
    // A successful install is not a decline — the marker stays unset.
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull();
  });

  it("stays open when the install command fails", async () => {
    mocks.ingamePluginInstall.mockRejectedValue(new Error("game running"));
    const { prompt } = mountPrompt();
    await flushPromises();

    const install = footerButtons().find(
      (b) => b.textContent === t("replay.live.idlePluginInstall"),
    );
    install?.click();
    await flushPromises();

    expect(prompt.visible).toBe(true);
  });
});

describe("pluginPrompt store dismissal slot", () => {
  it("markPluginPromptDismissed writes the slot a fresh store reads back", () => {
    const pinia = createPinia();
    setActivePinia(pinia);

    markPluginPromptDismissed();
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("1");

    // A NEW store instance (the next boot's shape) picks the marker up.
    const fresh = usePluginPromptStore();
    expect(fresh.dismissed).toBe(true);
  });

  it("open() re-syncs the marker a direct write landed after instantiation", () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const prompt = usePluginPromptStore();
    expect(prompt.dismissed).toBe(false);

    // The wizard's decline writes localStorage behind the live instance.
    markPluginPromptDismissed();
    prompt.open();

    // Raising the window must adopt the fresh marker — a stale false
    // would show an unchecked 不再提示 box whose decline re-arms the ask.
    expect(prompt.dismissed).toBe(true);
  });
});
