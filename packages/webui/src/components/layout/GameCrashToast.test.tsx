/**
 * GameCrashToast: the persistent crash prompt card. Covers the idle
 * render-nothing contract, the full content (title / body / exception
 * code when present) and the four actions — safe-mode restart (the
 * modHubSetSafeMode + restart pair), plain restart, the settings jump to
 * the crash section, and dismiss clearing the record off the card.
 *
 * The api module is mocked; the crash + settingsUi stores are real (the
 * toast card renders straight out of them, Teleported to body).
 */
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  listenGameCrash: vi.fn((_handler: unknown) => Promise.resolve(() => undefined)),
  listGameCrashes: vi.fn(),
  dismissGameCrash: vi.fn(),
  analyzeGameCrash: vi.fn(),
  exportGameCrashReport: vi.fn(),
  listQuarantinedMods: vi.fn(),
  quarantineMod: vi.fn(),
  restoreMod: vi.fn(),
  restartGame: vi.fn(),
  modHubSetSafeMode: vi.fn(),
}));

vi.mock("@/api", () => ({ api: mocks }));

import { useToast } from "@celestia-island/hikari";

import type { GameCrashRecord } from "@/api";
import { initLocaleMessages, t } from "@/i18n";
import { useCrashStore } from "@/stores/crash";
import { useSettingsUiStore } from "@/stores/settingsUi";
import GameCrashToast from "./GameCrashToast";

enableAutoUnmount(afterEach);

const CARD = ".crash-toast";
const GAME = "D:\\Games\\World of Warships";

function card(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(CARD);
}

function buttons(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>(CARD + " .hk-btn"));
}

function buttonByVariant(variant: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(CARD + " .hk-btn-" + variant);
}

function record(overrides: Partial<GameCrashRecord> = {}): GameCrashRecord {
  return {
    id: "crash-1",
    detectedAt: "2026-10-28T10:00:00Z",
    pid: 4242,
    imageName: "WorldOfWarships64.exe",
    gameRoot: GAME,
    source: "event-log",
    exceptionCode: "0xC0000005",
    modsActive: true,
    status: "new",
    ...overrides,
  };
}

beforeAll(async () => {
  await initLocaleMessages();
});

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.dismissGameCrash.mockResolvedValue(null);
  mocks.restartGame.mockResolvedValue({ gameRoot: GAME, exePath: GAME + "\\bin\\x.exe", pid: 99 });
  mocks.modHubSetSafeMode.mockResolvedValue([]);
});

describe("GameCrashToast idle contract", () => {
  it("renders nothing without an active record", async () => {
    mount(GameCrashToast);
    await nextTick();
    expect(card()).toBeNull();
  });
});

describe("GameCrashToast content", () => {
  it("shows title, body (image + pid), the exception code and the four actions", async () => {
    const crash = useCrashStore();
    crash.activeRecord = record();
    crash.history = [crash.activeRecord];
    mount(GameCrashToast);
    await nextTick();

    expect(card()).not.toBeNull();
    expect(document.body.querySelector<HTMLElement>(CARD + " .crash-toast__title")?.textContent).toBe(
      t("crash.toast.title"),
    );
    expect(document.body.querySelector<HTMLElement>(CARD + " .crash-toast__body")?.textContent).toBe(
      t("crash.toast.body", { image: "WorldOfWarships64.exe", pid: 4242 }),
    );
    expect(document.body.querySelector<HTMLElement>(CARD + " .crash-toast__code")?.textContent).toBe(
      t("crash.toast.code", { code: "0xC0000005" }),
    );
    const labels = buttons().map((b) => b.textContent?.trim());
    expect(labels).toEqual([
      t("crash.toast.safeRestart"),
      t("crash.toast.restart"),
      t("crash.toast.analysis"),
      t("crash.toast.dismiss"),
    ]);
  });

  it("drops the code line when the record carries no exception code", async () => {
    const crash = useCrashStore();
    crash.activeRecord = record({ exceptionCode: null });
    mount(GameCrashToast);
    await nextTick();
    expect(card()).not.toBeNull();
    expect(document.body.querySelector(CARD + " .crash-toast__code")).toBeNull();
  });
});

describe("GameCrashToast actions", () => {
  it("primary: safe mode + restart for the record's known root", async () => {
    const crash = useCrashStore();
    crash.activeRecord = record();
    mount(GameCrashToast);
    await nextTick();

    buttonByVariant("primary")?.click();
    await vi.waitFor(() => expect(mocks.modHubSetSafeMode).toHaveBeenCalledTimes(1));

    expect(mocks.modHubSetSafeMode).toHaveBeenCalledWith(GAME, true);
    expect(mocks.restartGame).toHaveBeenCalledWith(GAME);
  });

  it("secondary: plain restart goes straight to the backend", async () => {
    const crash = useCrashStore();
    crash.activeRecord = record();
    mount(GameCrashToast);
    await nextTick();

    buttonByVariant("secondary")?.click();
    await vi.waitFor(() => expect(mocks.restartGame).toHaveBeenCalledTimes(1));
    expect(mocks.modHubSetSafeMode).not.toHaveBeenCalled();
  });

  it("tertiary: opens settings on the crash section", async () => {
    const crash = useCrashStore();
    const settingsUi = useSettingsUiStore();
    crash.activeRecord = record();
    mount(GameCrashToast);
    await nextTick();

    buttonByVariant("outline")?.click();
    await nextTick();

    expect(settingsUi.section).toBe("crash");
    expect(settingsUi.visible).toBe(true);
  });

  it("ghost: dismiss calls the backend and clears the card", async () => {
    const crash = useCrashStore();
    crash.activeRecord = record();
    crash.history = [record()];
    mount(GameCrashToast);
    await nextTick();
    expect(card()).not.toBeNull();

    buttonByVariant("ghost")?.click();
    await vi.waitFor(() => expect(mocks.dismissGameCrash).toHaveBeenCalledWith("crash-1"));
    await vi.waitFor(() => expect(card()).toBeNull());
    expect(crash.activeRecord).toBeNull();
    expect(crash.history[0]?.status).toBe("dismissed");
  });

  it("primary without a game root falls back to a plain restart (safe mode skipped)", async () => {
    const crash = useCrashStore();
    crash.activeRecord = record({ gameRoot: null });
    mount(GameCrashToast);
    await nextTick();

    buttonByVariant("primary")?.click();
    await vi.waitFor(() => expect(mocks.restartGame).toHaveBeenCalled());

    expect(mocks.modHubSetSafeMode).not.toHaveBeenCalled();
    expect(mocks.restartGame).toHaveBeenCalledWith(undefined);
  });

  it("primary refuses while the game is running: no restart RPC, one error toast", async () => {
    const { useGameStatusStore } = await import("@/stores/gameStatus");
    const gameStatus = useGameStatusStore();
    gameStatus.process = {
      running: true,
      pid: 7,
      kind: "manual",
      realm: null,
      exePath: null,
      matchedInstall: { kind: "manual", path: GAME },
    };
    const crash = useCrashStore();
    crash.activeRecord = record();
    mount(GameCrashToast);
    await nextTick();

    buttonByVariant("primary")?.click();
    // The toast HOST component is not mounted here — assert the useToast
    // service state the host renders (the store raises the refusal).
    await vi.waitFor(() =>
      expect(useToast().toasts.some((s) => s.type === "error")).toBe(true),
    );

    expect(mocks.modHubSetSafeMode).not.toHaveBeenCalled();
    expect(mocks.restartGame).not.toHaveBeenCalled();
  });
});
