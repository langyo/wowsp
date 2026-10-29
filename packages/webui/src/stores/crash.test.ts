/** crash store: the watchdog mirror (event ingestion + history + prompt
 *  resolution), the per-record actions (dismiss / analyze cache / export),
 *  and the guarded relaunch paths (restart, safe-mode-then-restart). The
 *  api module is mocked; the gameStatus/config stores are real (their
 *  refs are set directly). */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { useToast } from "@celestia-island/hikari";

import type { CrashAnalysis, GameCrashRecord } from "@/api";
import { initLocaleMessages, t } from "@/i18n";

vi.mock("@/api", () => ({
  api: {
    listenGameCrash: vi.fn((_handler: unknown) => Promise.resolve(() => undefined)),
    listGameCrashes: vi.fn(),
    dismissGameCrash: vi.fn(),
    dismissAllGameCrashes: vi.fn(),
    analyzeGameCrash: vi.fn(),
    exportGameCrashReport: vi.fn(),
    listQuarantinedMods: vi.fn(),
    quarantineMod: vi.fn(),
    restoreMod: vi.fn(),
    restartGame: vi.fn(),
    modHubSetSafeMode: vi.fn(),
    safeguardEnabled: vi.fn(),
    setSafeguard: vi.fn(),
    scanRecentCrashes: vi.fn(),
  },
}));

import { api } from "@/api";
import { useConfigStore } from "./config";
import { useCrashStore } from "./crash";
import { useGameStatusStore } from "./gameStatus";

const GAME = "D:\\Games\\World of Warships";
const OTHER = "E:\\OtherClient";

const mocked = {
  listen: vi.mocked(api.listenGameCrash),
  list: vi.mocked(api.listGameCrashes),
  dismiss: vi.mocked(api.dismissGameCrash),
  dismissAll: vi.mocked(api.dismissAllGameCrashes),
  analyze: vi.mocked(api.analyzeGameCrash),
  export: vi.mocked(api.exportGameCrashReport),
  quarantined: vi.mocked(api.listQuarantinedMods),
  quarantine: vi.mocked(api.quarantineMod),
  restore: vi.mocked(api.restoreMod),
  restart: vi.mocked(api.restartGame),
  safeMode: vi.mocked(api.modHubSetSafeMode),
  safeguardEnabled: vi.mocked(api.safeguardEnabled),
  setSafeguard: vi.mocked(api.setSafeguard),
  scanRecent: vi.mocked(api.scanRecentCrashes),
};

function record(overrides: Partial<GameCrashRecord> = {}): GameCrashRecord {
  return {
    id: "crash-1",
    detectedAt: "2026-10-28T10:00:00Z",
    pid: 4242,
    imageName: "WorldOfWarships64.exe",
    gameRoot: GAME,
    source: "event-log",
    modsActive: true,
    status: "new",
    ...overrides,
  };
}

const analysis: CrashAnalysis = {
  record: record(),
  findings: [],
  gameLogs: [],
  appLogs: [],
  modsInventory: [],
  suspects: [],
  currentBuild: null,
  generatedAt: "2026-10-28T10:01:00Z",
};

const restartInfo = { gameRoot: GAME, exePath: GAME + "\\bin\\WorldOfWarships64.exe", pid: 99 };

beforeAll(async () => {
  await initLocaleMessages();
});

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  // The toast context is module-global — reset its slots between tests.
  const toast = useToast();
  toast.toasts.splice(0, toast.toasts.length);
  mocked.listen.mockImplementation((_handler: unknown) => Promise.resolve(() => undefined));
  mocked.list.mockResolvedValue([] as never);
  mocked.dismiss.mockResolvedValue(null as never);
  mocked.dismissAll.mockResolvedValue(0 as never);
  mocked.analyze.mockResolvedValue(analysis as never);
  mocked.export.mockResolvedValue("C:\\exports\\crash.zip" as never);
  mocked.quarantined.mockResolvedValue([] as never);
  mocked.quarantine.mockResolvedValue([] as never);
  mocked.restore.mockResolvedValue([] as never);
  mocked.restart.mockResolvedValue(restartInfo as never);
  mocked.safeMode.mockResolvedValue([] as never);
});

afterEach(() => {
  const toasts = useToast().toasts;
  for (const slot of [...toasts]) useToast().remove(slot.id);
});

describe("useCrashStore start / ingestion", () => {
  it("loads the retained list on start and pins the newest undismissed record", async () => {
    mocked.list.mockResolvedValue([
      record(), // newest first
      record({ id: "older", status: "dismissed" }),
    ] as never);

    const crash = useCrashStore();
    crash.start();

    await vi.waitFor(() => expect(crash.history).toHaveLength(2));
    expect(crash.activeRecord?.id).toBe("crash-1");
    expect(crash.history[0]?.id).toBe("crash-1"); // backend order kept (newest first)
    expect(mocked.listen).toHaveBeenCalledTimes(1);
  });

  it("keeps everything null when the backend has no records (browser dev)", async () => {
    const crash = useCrashStore();
    crash.start();
    await vi.waitFor(() => expect(crash.historyLoading).toBe(false));
    expect(crash.history).toEqual([]);
    expect(crash.activeRecord).toBeNull();
  });

  it("pins a pushed record as the active prompt and prepends history", async () => {
    let emit: ((r: GameCrashRecord) => void) | undefined;
    mocked.listen.mockImplementation((handler: unknown) => {
      emit = handler as typeof emit;
      return Promise.resolve(() => undefined);
    });
    mocked.list.mockResolvedValue([record()] as never);
    const crash = useCrashStore();
    crash.start();
    await vi.waitFor(() => expect(crash.historyLoading).toBe(false));

    emit?.(record({ id: "crash-2" }));

    expect(crash.activeRecord?.id).toBe("crash-2");
    expect(crash.history.map((r) => r.id)).toEqual(["crash-2", "crash-1"]);
  });

  it("a pushed record re-upserts instead of duplicating history rows", async () => {
    let emit: ((r: GameCrashRecord) => void) | undefined;
    mocked.listen.mockImplementation((handler: unknown) => {
      emit = handler as typeof emit;
      return Promise.resolve(() => undefined);
    });
    const crash = useCrashStore();
    crash.start();
    await vi.waitFor(() => expect(crash.historyLoading).toBe(false));

    emit?.(record()); // the same id again (backend reconnect replay)
    expect(crash.history.map((r) => r.id)).toEqual(["crash-1"]);
    expect(crash.activeRecord?.id).toBe("crash-1");
  });

  it("a pushed dismissed record never pins a prompt and clears its own", async () => {
    let emit: ((r: GameCrashRecord) => void) | undefined;
    mocked.listen.mockImplementation((handler: unknown) => {
      emit = handler as typeof emit;
      return Promise.resolve(() => undefined);
    });
    const crash = useCrashStore();
    crash.start();
    await vi.waitFor(() => expect(crash.historyLoading).toBe(false));
    emit?.(record({ id: "a", status: "new" }));
    expect(crash.activeRecord?.id).toBe("a");

    emit?.(record({ id: "a", status: "dismissed" }));
    expect(crash.activeRecord).toBeNull();
    expect(crash.history[0]?.status).toBe("dismissed");
  });

  it("start/stop is race-safe: a stop racing the handshake releases the listener", async () => {
    let offCalls = 0;
    mocked.listen.mockImplementation(
      () =>
        Promise.resolve(() => {
          offCalls += 1;
        }),
    );
    const crash = useCrashStore();
    crash.start();
    crash.stop();
    await vi.waitFor(() => expect(offCalls).toBe(1));
    // restart works after a stop (fresh handshake)
    crash.start();
    await vi.waitFor(() => expect(mocked.listen).toHaveBeenCalledTimes(2));
  });
});

describe("useCrashStore.dismiss", () => {
  it("dismisses backend-side, clears the prompt and marks history", async () => {
    const crash = useCrashStore();
    crash.activeRecord = record();
    crash.history = [record()];

    await crash.dismiss("crash-1");

    expect(mocked.dismiss).toHaveBeenCalledWith("crash-1");
    expect(crash.activeRecord).toBeNull();
    expect(crash.history[0]?.status).toBe("dismissed");
  });

  it("only clears the prompt when the dismissed record IS the prompt", async () => {
    const crash = useCrashStore();
    crash.activeRecord = record({ id: "live" });
    crash.history = [record({ id: "live" }), record({ id: "old", status: "new" })];

    await crash.dismiss("old");

    expect(crash.activeRecord?.id).toBe("live");
  });
});

describe("useCrashStore.dismissAll", () => {
  it("resets every record backend-side and reloads, dropping the prompt", async () => {
    mocked.dismissAll.mockResolvedValue(2 as never);
    mocked.list.mockResolvedValue([
      record({ id: "a", status: "dismissed" }),
      record({ id: "b", status: "dismissed" }),
    ] as never);
    const crash = useCrashStore();
    crash.activeRecord = record({ id: "a" });
    crash.history = [record({ id: "a" }), record({ id: "b", status: "new" })];

    const count = await crash.dismissAll();

    expect(count).toBe(2);
    expect(mocked.dismissAll).toHaveBeenCalledOnce();
    expect(mocked.list).toHaveBeenCalled();
    expect(crash.activeRecord).toBeNull();
    expect(crash.history.every((r) => r.status === "dismissed")).toBe(true);
  });

  it("propagates backend refusals to the calling surface", async () => {
    mocked.dismissAll.mockRejectedValue(new Error("nope") as never);
    const crash = useCrashStore();

    await expect(crash.dismissAll()).rejects.toThrow("nope");
    expect(mocked.list).not.toHaveBeenCalled();
  });
});

describe("useCrashStore.analyze / exportReport", () => {
  it("analyzes once per id and serves later calls from the cache", async () => {
    mocked.analyze.mockResolvedValue(analysis as never);
    const crash = useCrashStore();

    const first = await crash.analyze("crash-1");
    const second = await crash.analyze("crash-1");

    expect(mocked.analyze).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(crash.analysisFor("crash-1")).toBe(first);
    expect(crash.analyzingId).toBeNull();
  });

  it("clears the analyzing flag even when the pass fails", async () => {
    mocked.analyze.mockRejectedValueOnce(new Error("heavy io died") as never);
    const crash = useCrashStore();
    await expect(crash.analyze("crash-1")).rejects.toThrow("heavy io died");
    expect(crash.analyzingId).toBeNull();
    // the failed pass leaves no poisoned cache entry
    mocked.analyze.mockResolvedValueOnce(analysis as never);
    await crash.analyze("crash-1");
    expect(mocked.analyze).toHaveBeenCalledTimes(2);
  });

  it("exportReport resolves the revealed path and clears its busy flag", async () => {
    const crash = useCrashStore();
    const path = await crash.exportReport("crash-1");
    expect(path).toBe("C:\\exports\\crash.zip");
    expect(mocked.export).toHaveBeenCalledWith("crash-1");
    expect(crash.exportingId).toBeNull();
  });
});

describe("useCrashStore.restart guards", () => {
  it("refuses while the target client is running: no RPC, one error toast", async () => {
    const gameStatus = useGameStatusStore();
    gameStatus.process = {
      running: true,
      pid: 7,
      kind: "manual",
      realm: null,
      exePath: GAME + "\\WorldOfWarships64.exe",
      matchedInstall: { kind: "manual", path: GAME },
    };
    const crash = useCrashStore();

    const info = await crash.restart(GAME);

    expect(info).toBeNull();
    expect(mocked.restart).not.toHaveBeenCalled();
    const texts = useToast().toasts.flatMap((s) => s.messages.map((m) => m.text));
    expect(texts).toContain(t("crash.errors.gameRunning"));
  });

  it("refuses conservatively when a running client's folder is unknown", async () => {
    const gameStatus = useGameStatusStore();
    gameStatus.process = { running: true, pid: 7, kind: null, realm: null, exePath: null, matchedInstall: null };
    const crash = useCrashStore();

    expect(await crash.restart(GAME)).toBeNull();
    expect(mocked.restart).not.toHaveBeenCalled();
  });

  it("lets a restart through when only an UNRELATED client is running", async () => {
    const gameStatus = useGameStatusStore();
    gameStatus.process = {
      running: true,
      pid: 7,
      kind: "manual",
      realm: null,
      exePath: OTHER + "\\WorldOfWarships64.exe",
      matchedInstall: { kind: "manual", path: OTHER },
    };
    const crash = useCrashStore();

    const info = await crash.restart(GAME);

    expect(info?.pid).toBe(99);
    expect(mocked.restart).toHaveBeenCalledWith(GAME);
    expect(crash.restarting).toBe(false);
  });

  it("passes an absent root through as the backend's last-crashed resolution", async () => {
    const crash = useCrashStore();
    await crash.restart();
    expect(mocked.restart).toHaveBeenCalledWith(undefined);
  });

  it("restart toasts a backend failure and stays usable", async () => {
    mocked.restart.mockRejectedValueOnce(new Error("spawn failed") as never);
    const crash = useCrashStore();
    const info = await crash.restart(GAME);
    expect(info).toBeNull();
    const texts = useToast().toasts.flatMap((s) => s.messages.map((m) => m.text));
    expect(texts).toContain("spawn failed");
    expect(crash.restarting).toBe(false);
  });
});

describe("useCrashStore.safeModeAndRestart", () => {
  it("flips safe mode on, then restarts the same install", async () => {
    const crash = useCrashStore();

    const info = await crash.safeModeAndRestart(GAME);

    expect(mocked.safeMode).toHaveBeenCalledWith(GAME, true);
    expect(mocked.restart).toHaveBeenCalledWith(GAME);
    expect(info?.pid).toBe(99);
    expect(crash.restarting).toBe(false);
  });

  it("refuses while the game is running — safe mode never fires either", async () => {
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

    const info = await crash.safeModeAndRestart(GAME);

    expect(info).toBeNull();
    expect(mocked.safeMode).not.toHaveBeenCalled();
    expect(mocked.restart).not.toHaveBeenCalled();
    const texts = useToast().toasts.flatMap((s) => s.messages.map((m) => m.text));
    expect(texts).toContain(t("crash.errors.gameRunning"));
  });

  it("degrades to a plain restart when no game root is known", async () => {
    const crash = useCrashStore();
    await crash.safeModeAndRestart("");
    expect(mocked.safeMode).not.toHaveBeenCalled();
    expect(mocked.restart).toHaveBeenCalledWith(undefined);
  });

  it("stops after a safe-mode failure without restarting", async () => {
    mocked.safeMode.mockRejectedValueOnce(new Error("safe mode refused") as never);
    const crash = useCrashStore();
    const info = await crash.safeModeAndRestart(GAME);
    expect(info).toBeNull();
    expect(mocked.restart).not.toHaveBeenCalled();
    const texts = useToast().toasts.flatMap((s) => s.messages.map((m) => m.text));
    expect(texts).toContain("safe mode refused");
    expect(crash.restarting).toBe(false);
  });
});

describe("useCrashStore.quarantine", () => {
  it("resolves the root from the active record and pins the manifest", async () => {
    const manifest = [{ name: "suspect_mod", crashId: "crash-1", quarantinedAt: "2026-10-28T10:02:00Z" }];
    mocked.quarantine.mockResolvedValue(manifest as never);
    const crash = useCrashStore();
    crash.activeRecord = record();

    const out = await crash.quarantine("suspect_mod", "crash-1");

    expect(mocked.quarantine).toHaveBeenCalledWith(GAME, "suspect_mod", "crash-1");
    expect(out).toEqual(manifest);
    expect(crash.quarantined).toEqual(manifest);
    expect(crash.quarantineBusy.has("suspect_mod")).toBe(false);
  });

  it("falls back to the active install when no record carries a root", async () => {
    const crash = useCrashStore();
    const config = useConfigStore();
    config.activeInstall = { kind: "manual", path: OTHER };
    await crash.restore("kept_mod");
    expect(mocked.restore).toHaveBeenCalledWith(OTHER, "kept_mod");
  });

  it("loadQuarantined pins the manifest for an explicit root", async () => {
    const manifest = [{ name: "old_mod", crashId: null, quarantinedAt: "2026-10-27T00:00:00Z" }];
    mocked.quarantined.mockResolvedValue(manifest as never);
    const crash = useCrashStore();
    await crash.loadQuarantined(GAME);
    expect(mocked.quarantined).toHaveBeenCalledWith(GAME);
    expect(crash.quarantined).toEqual(manifest);
    expect(crash.quarantineLoading).toBe(false);
  });
});


describe("useCrashStore.safeguard", () => {
  it("mirrors the switch from the backend and reloads history after a flip", async () => {
    mocked.list.mockResolvedValue([]);
    mocked.safeguardEnabled.mockResolvedValue(false);
    const crash = useCrashStore();
    await crash.start();
    await vi.waitFor(() => {
      expect(crash.safeguard).toBe(false);
    });

    mocked.setSafeguard.mockResolvedValue(true);
    mocked.list.mockResolvedValue([record()]);
    await crash.setSafeguard(true);
    expect(mocked.setSafeguard).toHaveBeenCalledWith(true);
    expect(crash.safeguard).toBe(true);
    // history reloaded after the flip
    expect(crash.history.length).toBe(1);
  });

  it("scanRecent ingests imported records and answers the count", async () => {
    mocked.list.mockResolvedValue([]);
    const crash = useCrashStore();
    const backfilled = record({ id: "crash-bf-1", detectedAt: "2026-10-20T10:00:00Z" });
    mocked.scanRecent.mockResolvedValue([backfilled]);
    const count = await crash.scanRecent();
    expect(count).toBe(1);
    expect(crash.history.some((r) => r.id === "crash-bf-1")).toBe(true);
    expect(mocked.scanRecent).toHaveBeenCalledTimes(1);
  });
});

it("raises the crash prompt as a standard sticky toast and clears it", async () => {
  mocked.list.mockResolvedValue([record()]);
  const store = useCrashStore();
  await store.start();
  await vi.waitFor(() => {
    expect(store.activeRecord?.id).toBe("crash-1");
  });
  const toast = useToast();
  await vi.waitFor(() => {
    const slot = toast.toasts.find((s) => s.type === "error" && s.action);
    expect(slot).toBeTruthy();
    expect(slot!.action!.label).toBe(t("crash.toast.open"));
    // Sticky: duration 0 survives the severity default.
    expect(slot!.duration).toBe(0);
  });
  store.clearPrompt();
  expect(toast.toasts.some((s) => s.type === "error" && s.action)).toBe(false);
});
