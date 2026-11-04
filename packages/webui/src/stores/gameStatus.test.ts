/** The game-status store's multi-instance contracts: `process` derives the
 *  PREFERRED instance (the backend's single-process pick) out of the plural
 *  report — every consumer keeps reading the singular shape while the
 *  sidebar counts the running instances — and the singular write path
 *  (tests + legacy callers) collapses the plural state to one entry + its
 *  preference. */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GameProcessInfo, GameProcessReport, SessionSnapshot } from "@/api";

vi.mock("@/api", () => ({
  api: {
    getGameProcesses: vi.fn(),
    listenSessionChanged: vi.fn(),
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

describe("gameStatus session-changed subscription", () => {
  function boot() {
    const store = useGameStatusStore();
    useConfigStore().installs = [];
    return store;
  }

  it("refetches on every session-changed push and unsubscribes on stop", async () => {
    const off = vi.fn();
    let push: (snapshot: SessionSnapshot) => void = () => {};
    let subscribed = false;
    vi.mocked(api.listenSessionChanged).mockImplementation(async (handler) => {
      push = handler;
      subscribed = true;
      return off;
    });
    const store = boot();
    vi.mocked(api.getGameProcesses).mockResolvedValue(report([proc(100, "asia")], 100));
    store.start();
    await vi.waitFor(() => expect(subscribed).toBe(true));
    // The immediate boot fetch landed the running report.
    expect(store.process.pid).toBe(100);
    // The Rust hub pushes (client exited) — the store refetches at once
    // instead of waiting out its 3 s safety-net poll.
    vi.mocked(api.getGameProcesses).mockResolvedValue(report([], null));
    push({} as SessionSnapshot);
    await vi.waitFor(() => expect(store.process.running).toBe(false));
    store.stop();
    expect(off).toHaveBeenCalledOnce();
  });

  it("releases the straggler handshake when stop/start races the subscription", async () => {
    const released = vi.fn();
    const resolvers: ((off: () => void) => void)[] = [];
    vi.mocked(api.listenSessionChanged).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    vi.mocked(api.getGameProcesses).mockResolvedValue(report([], null));
    const store = boot();
    store.start(); // handshake 1 pending
    store.stop(); // raced: unlisten is still null here
    store.start(); // handshake 2 pending
    expect(resolvers).toHaveLength(2);
    // The OLD start's handshake is the straggler (epoch mismatch): it must
    // release its own listener instead of leaking a second live one.
    resolvers[1](() => released());
    resolvers[0](() => released());
    await vi.waitFor(() => expect(released).toHaveBeenCalledOnce());
    store.stop();
    expect(released).toHaveBeenCalledTimes(2);
  });
});
