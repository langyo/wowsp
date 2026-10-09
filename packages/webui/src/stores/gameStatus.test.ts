/** The game-status store's multi-instance contracts: `process` derives the
 *  WATCHED instance (the sidebar's instance-card selection), falling back
 *  to the preferred one; a watched pid that leaves the report drops the
 *  selection instead of pinning the view to a dead process; and the
 *  singular write path (tests + legacy callers) collapses the plural state
 *  to one entry + its preference. */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GameProcessInfo, GameProcessReport } from "@/api";

vi.mock("@/api", () => ({
  api: {
    getGameProcesses: vi.fn(),
  },
}));

import { api } from "@/api";
import { useConfigStore } from "./config";
import { useGameStatusStore } from "./gameStatus";

function proc(pid: number, realm: string): GameProcessInfo {
  return {
    running: true,
    pid,
    kind: "steam",
    realm,
    exePath: `C:\\game-${pid}\\WorldOfWarships.exe`,
    matchedInstall: { kind: "steam", path: `C:\\game-${pid}`, realm },
  };
}

function report(processes: GameProcessInfo[], preferredPid: number | null): GameProcessReport {
  return { processes, preferredPid };
}

async function check(listeners: GameProcessReport) {
  const store = useGameStatusStore();
  useConfigStore().installs = [];
  vi.mocked(api.getGameProcesses).mockResolvedValue(listeners);
  await store.check();
  return store;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("gameStatus multi-instance store", () => {
  it("derives the preferred process while nothing is watched", async () => {
    const store = await check(report([proc(100, "asia"), proc(200, "ru")], 200));
    expect(store.process.pid).toBe(200);
    expect(store.process.realm).toBe("ru");
    expect(store.anyRunning).toBe(true);
  });

  it("follows the watched instance once selected", async () => {
    const store = await check(report([proc(100, "asia"), proc(200, "ru")], 200));
    store.selectProcess(100);
    expect(store.process.pid).toBe(100);
    expect(store.process.realm).toBe("asia");
  });

  it("drops a watched pid that left the report (client exited)", async () => {
    const store = await check(report([proc(100, "asia"), proc(200, "ru")], 200));
    store.selectProcess(100);
    vi.mocked(api.getGameProcesses).mockResolvedValue(report([proc(200, "ru")], 200));
    await store.check();
    expect(store.watchedPid).toBeNull();
    expect(store.process.pid).toBe(200);
  });

  it("renders the offline projection when no client runs", async () => {
    const store = await check(report([], null));
    expect(store.processes).toEqual([]);
    expect(store.process.running).toBe(false);
    expect(store.process.pid).toBeNull();
    expect(store.anyRunning).toBe(false);
  });

  it("collapses a singular write into a one-entry report", async () => {
    const store = await check(report([proc(100, "asia"), proc(200, "ru")], 200));
    store.selectProcess(100);
    store.process = proc(300, "eu");
    expect(store.processes.map((p) => p.pid)).toEqual([300]);
    expect(store.preferredPid).toBe(300);
    expect(store.watchedPid).toBeNull();
    expect(store.process.pid).toBe(300);
  });
});
