/** The game-status store's multi-instance contracts: `process` derives the
 *  PREFERRED instance (the backend's single-process pick) out of the plural
 *  report — every consumer keeps reading the singular shape while the
 *  sidebar counts the running instances — and the singular write path
 *  (tests + legacy callers) collapses the plural state to one entry + its
 *  preference. */
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

function report(
  processes: GameProcessInfo[],
  preferredPid: number | null,
): GameProcessReport {
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
  it("derives the preferred process out of the plural report", async () => {
    const store = await check(report([proc(100, "asia"), proc(200, "ru")], 200));
    expect(store.process.pid).toBe(200);
    expect(store.process.realm).toBe("ru");
    // The full list stays available for the running-count badge.
    expect(store.processes).toHaveLength(2);
  });

  it("falls back to the first entry when the report has no preference", async () => {
    const store = await check(report([proc(100, "asia"), proc(200, "ru")], null));
    expect(store.process.pid).toBe(100);
  });

  it("falls to the first entry when the preferred pid is not listed", async () => {
    // Defensive branch: the backend resolves preferred_pid over the same
    // snapshot it lists, so this should never fire — but the derivation
    // must not crash or serve undefined either way.
    const store = await check(report([proc(100, "asia"), proc(200, "ru")], 999));
    expect(store.process.pid).toBe(100);
  });

  it("renders the offline projection when no client runs", async () => {
    const store = await check(report([], null));
    expect(store.processes).toEqual([]);
    expect(store.process.running).toBe(false);
    expect(store.process.pid).toBeNull();
  });

  it("collapses a singular write into a one-entry report", async () => {
    const store = await check(report([proc(100, "asia"), proc(200, "ru")], 200));
    store.process = proc(300, "eu");
    expect(store.processes.map((p) => p.pid)).toEqual([300]);
    expect(store.preferredPid).toBe(300);
    expect(store.process.pid).toBe(300);
  });
});
