/**
 * Tests for the sidebar's exclusive-fullscreen warning card: it opens by
 * itself while the running client reports the exclusive display mode
 * (anchored ABOVE the game-status card, warning-toned, passive), stays
 * closed for the windowed modes / unknown / offline, and lifts the moment
 * the mode changes or the game closes — re-opening for the next exclusive
 * launch, which is the per-launch rescan contract.
 *
 * The api module is mocked; the pinia stores are real (their refs are set
 * directly). happy-dom measures every box as 0×0, so the anchor element's
 * getBoundingClientRect is stubbed per mount.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";

const mocks = vi.hoisted(() => ({}));

vi.mock("@/api", () => ({ api: mocks }));

import { initLocaleMessages, t } from "@/i18n";
import type { GameDisplayMode, GameProcessInfo } from "@/api";
import { useGameStatusStore } from "@/stores/gameStatus";
import { resetAppliedDpiScaleForTest } from "@/theme/dpiPrefs";
import FullscreenModeHint from "./FullscreenModeHint";

enableAutoUnmount(afterEach);

const GAME = "D:\\Games\\World of Warships";

function runningInfo(displayMode: GameDisplayMode | null): GameProcessInfo {
  return {
    running: true,
    pid: 42,
    kind: "steam",
    realm: "asia",
    exePath: `${GAME}\\WorldOfWarships64.exe`,
    matchedInstall: { kind: "steam", path: GAME, realm: "asia" },
    displayMode,
  };
}

/** A stand-in for the sidebar's game-status card with a plausible rect. */
function anchorCard(left = 16, top = 700, height = 40): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({
      left,
      top,
      height,
      right: left + 200,
      bottom: top + height,
      width: 200,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

/** Mount the hint around a stubbed anchor with a seeded process report. */
async function mountHint(process: GameProcessInfo, card: HTMLElement) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const gameStatus = useGameStatusStore();
  gameStatus.process = process;
  const anchor = ref<HTMLElement | null>(card);
  const wrapper = mount(FullscreenModeHint, {
    props: { anchor },
    global: { plugins: [pinia] },
  });
  await flushPromises();
  await nextTick();
  return { wrapper, gameStatus };
}

function card(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".fullscreen-mode-hint");
}

beforeAll(async () => {
  await initLocaleMessages();
});

// The DPI singleton re-reads the documentElement per test: a zoom test's
// scale must never leak into the unzoomed default.
beforeEach(() => {
  delete document.documentElement.dataset.dpiScale;
  document.documentElement.style.removeProperty("zoom");
  resetAppliedDpiScaleForTest();
});

afterEach(() => {
  delete document.documentElement.dataset.dpiScale;
  document.documentElement.style.removeProperty("zoom");
  resetAppliedDpiScaleForTest();
});

describe("FullscreenModeHint", () => {
  it("opens on its own above the status card while the client runs exclusive fullscreen", async () => {
    const { wrapper } = await mountHint(runningInfo("exclusiveFullscreen"), anchorCard());
    const el = card();
    expect(el).toBeTruthy();
    expect(el?.textContent).toContain(t("resources.exclusiveFullscreenTitle"));
    expect(el?.textContent).toContain(t("resources.exclusiveFullscreenBody"));
    // Anchored above the card: same left edge, top above the card's.
    expect(el?.style.left).toBe("16px");
    expect(Number.parseFloat(el?.style.top ?? "0")).toBeLessThan(700);
    wrapper.unmount();
  });

  it("divides the anchor geometry by the applied root zoom", async () => {
    // PluginUpdateHint's zoom regression, mirrored for the shared anchor
    // grammar: at 125% the unconverted card drifted scale× off the
    // sidebar (16 visual / 1.25 → 12.8 local; 700/1.25 − 10 → 550).
    document.documentElement.dataset.dpiScale = "125";
    resetAppliedDpiScaleForTest();
    const { wrapper } = await mountHint(runningInfo("exclusiveFullscreen"), anchorCard());

    const el = card();
    expect(el).toBeTruthy();
    expect(el?.style.left).toBe("12.8px");
    expect(el?.style.top).toBe("550px");
    wrapper.unmount();
  });

  it("stays closed for borderless / windowed / unknown modes and offline", async () => {
    const offline: GameProcessInfo = {
      running: false,
      pid: null,
      kind: null,
      realm: null,
      exePath: null,
      matchedInstall: null,
      displayMode: null,
    };
    for (const process of [
      runningInfo("borderless"),
      runningInfo("windowed"),
      runningInfo(null),
      offline,
    ]) {
      document.body.innerHTML = "";
      const { wrapper } = await mountHint(process, anchorCard());
      expect(card(), `mode ${process.displayMode}`).toBeNull();
      wrapper.unmount();
    }
  });

  it("lifts when the mode changes and re-opens for the next exclusive launch", async () => {
    const { wrapper, gameStatus } = await mountHint(
      runningInfo("exclusiveFullscreen"),
      anchorCard(),
    );
    expect(card()).toBeTruthy();
    gameStatus.process = runningInfo("borderless");
    await flushPromises();
    await nextTick();
    expect(card()).toBeNull();
    gameStatus.process = runningInfo("exclusiveFullscreen");
    await flushPromises();
    await nextTick();
    expect(card()).toBeTruthy();
    wrapper.unmount();
  });
});
