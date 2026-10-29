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
 *  - the install action rides the shared ingamePlugin store and closes on
 *    success;
 *  - safe mode flips the SAME window into the recovery question: the
 *    quarantine copy replaces the desc, the dismissal checkbox disappears
 *    (closing it is not an install decline) and the repair action turns
 *    mods back on, repairs the plugin and closes only on success;
 *  - markPluginPromptDismissed (the wizard's direct write) lands in the
 *    same slot the store reads.
 *
 * i18n messages load lazily, so the bundle is in place before mounting —
 * footer buttons are then addressed by their localized labels.
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

/** Footer action buttons in declared order ([later, primary action]). The
 *  modal teleports to document.body, so everything is queried there. */
const footerButtons = () =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>(".hk-modal-footer button"));

function footerButton(label: string): HTMLButtonElement {
  const btn = footerButtons().find((b) => b.textContent === label);
  if (!btn) throw new Error(`footer button "${label}" not rendered`);
  return btn;
}

const checkboxInput = () =>
  document.body.querySelector<HTMLInputElement>("input.hk-checkbox-input");

beforeEach(() => {
  mocks.ingamePluginInstall.mockReset();
  mocks.ingamePluginStatus.mockReset();
  mocks.modHubSafeMode.mockReset();
  mocks.modHubSetSafeMode.mockReset();
  mocks.ingamePluginStatus.mockResolvedValue({
    installed: false,
    outdated: false,
    safeMode: false,
  });
  mocks.modHubSafeMode.mockResolvedValue(false);
  mocks.modHubSetSafeMode.mockResolvedValue(false);
  localStorage.removeItem(DISMISSED_KEY);
  document.body.innerHTML = "";
  // The hikari toast context is a module singleton — retire any slots a
  // previous case left behind so the assertions read only this case's text.
  const toasts = useToast().toasts;
  for (const slot of [...toasts]) useToast().remove(slot.id);
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

  it("shows the safe-mode recovery instead of the install offer", async () => {
    // The quarantine reports installed=false even though nothing is
    // broken — the install offer would only hit the backend's refusal.
    mocks.ingamePluginStatus.mockResolvedValue({
      installed: false,
      outdated: false,
      safeMode: true,
    });
    mountPrompt();
    await flushPromises();

    expect(
      document.body.querySelector(".hk-modal-title")?.textContent,
    ).toContain(t("replay.live.pluginSafeModeTitle"));
    expect(
      document.body.querySelector(".plugin-install-prompt__desc")?.textContent,
    ).toContain(t("replay.live.pluginSafeModeDesc"));
    // No dismissal checkbox: a state-recovery question must not offer to
    // silence the boot-time install ask.
    expect(checkboxInput()).toBeNull();

    const labels = footerButtons().map((b) => b.textContent);
    expect(labels).toContain(t("replay.live.pluginSafeModeLater"));
    expect(labels).toContain(t("replay.live.pluginSafeModeRepair"));
    expect(labels).not.toContain(t("replay.live.idlePluginInstall"));
  });

  it("repairs safe mode through the shared flow and never writes the marker", async () => {
    mocks.ingamePluginStatus.mockResolvedValue({
      installed: false,
      outdated: false,
      safeMode: true,
    });
    mocks.ingamePluginInstall.mockImplementation(async () => {
      // The backend's post-repair probe sees the quarantine gone and the
      // plugin back — flip the status the way the real one would.
      mocks.ingamePluginStatus.mockResolvedValue({
        installed: true,
        outdated: false,
        safeMode: false,
      });
    });
    const { prompt } = mountPrompt();
    await flushPromises();

    footerButton(t("replay.live.pluginSafeModeRepair")).click();
    await flushPromises();

    // Turn mods back on FIRST, then the embedded install.
    expect(mocks.modHubSetSafeMode).toHaveBeenCalledWith("C:/Games/WorldOfWarships", false);
    expect(mocks.ingamePluginInstall).toHaveBeenCalledWith("C:/Games/WorldOfWarships");
    expect(prompt.visible).toBe(false);
    const plugin = useIngamePluginStore();
    expect(plugin.safeMode).toBe(false);
    expect(plugin.installed).toBe(true);
    // A recovery is not an install decline — the boot ask stays armed.
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull();
  });

  it("closes the safe-mode window on later without touching the dismissal marker", async () => {
    mocks.ingamePluginStatus.mockResolvedValue({
      installed: false,
      outdated: false,
      safeMode: true,
    });
    const { prompt } = mountPrompt();
    await flushPromises();

    footerButton(t("replay.live.pluginSafeModeLater")).click();
    await flushPromises();

    expect(prompt.visible).toBe(false);
    // Not a decline: the boot-time ask stays armed for the next start.
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull();
  });

  it("re-renders the normal install offer when mods return but the repair install fails", async () => {
    mocks.ingamePluginStatus.mockResolvedValue({
      installed: false,
      outdated: false,
      safeMode: true,
    });
    mocks.ingamePluginInstall.mockImplementation(async () => {
      // The restore rename landed (safe mode off), but the reinstall was
      // refused (e.g. a locked file): the fresh probe reports a genuinely
      // missing plugin, not a quarantine.
      mocks.ingamePluginStatus.mockResolvedValue({
        installed: false,
        outdated: false,
        safeMode: false,
      });
      throw new Error("the plugin entry file is locked");
    });
    const { prompt } = mountPrompt();
    await flushPromises();

    footerButton(t("replay.live.pluginSafeModeRepair")).click();
    await flushPromises();

    // Stays open on the NORMAL variant — the quarantine is over, so the
    // recovery question would be a lie and the install offer is real.
    expect(prompt.visible).toBe(true);
    expect(
      document.body.querySelector(".hk-modal-title")?.textContent,
    ).toContain(t("replay.live.pluginPromptTitle"));
    expect(checkboxInput()).toBeTruthy();
    const labels = footerButtons().map((b) => b.textContent);
    expect(labels).toContain(t("replay.live.idlePluginInstall"));
    expect(labels).not.toContain(t("replay.live.pluginSafeModeRepair"));
    const texts = useToast().toasts.flatMap((s) => s.messages.map((m) => m.text));
    expect(texts).toContain("the plugin entry file is locked");
  });

  it("stays open on a repair failure and surfaces the raw backend sentence", async () => {
    mocks.ingamePluginStatus.mockResolvedValue({
      installed: false,
      outdated: false,
      safeMode: true,
    });
    mocks.modHubSetSafeMode.mockRejectedValue(
      new Error("res_mods is locked by the game"),
    );
    const { prompt } = mountPrompt();
    await flushPromises();

    footerButton(t("replay.live.pluginSafeModeRepair")).click();
    await flushPromises();

    expect(prompt.visible).toBe(true);
    expect(mocks.ingamePluginInstall).not.toHaveBeenCalled();
    // The tError contract: a raw backend sentence (spaces, no key path)
    // surfaces verbatim instead of being looked up as a message key.
    const texts = useToast().toasts.flatMap((s) => s.messages.map((m) => m.text));
    expect(texts).toContain("res_mods is locked by the game");
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
