/** liveSelf store: the live temp-replay polling loop. Pins the two
 *  mid-write hardening behaviors:
 *   - a failed snapshot read is retried even when the file size did not
 *     change (the growth gate records sizes only after a successful read);
 *   - a stale read error clears once no temp container exists (no battle in
 *     progress — the previous failure is history, not a current state).
 *  The api module is mocked partially (buildSelfStats needs the real
 *  foldDamageStats); useLanguage is stubbed for a fixed data language. */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nextTick } from "vue";
import type { ArenaInfo, LiveSelfStream, ReplayStream } from "@/api";

vi.mock("@/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api")>();
  return {
    ...actual,
    api: {
      liveTempReplay: vi.fn(),
      readLiveReplaySnapshot: vi.fn(),
      readReplayPositions: vi.fn(),
    },
  };
});

vi.mock("@/i18n/useLanguage", () => ({
  useLanguage: () => ({ dataLanguage: { value: "zh-CN" } }),
}));

import { api } from "@/api";
import { useLiveSelfStore } from "./liveSelf";

const liveTempReplay = vi.mocked(api.liveTempReplay);
const readLiveReplaySnapshot = vi.mocked(api.readLiveReplaySnapshot);
const readReplayPositions = vi.mocked(api.readReplayPositions);

const EMPTY_STREAM: LiveSelfStream = {
  trajectories: [],
  shotKills: [],
  damageStats: [],
  achievements: [],
  arenaPlayers: [],
  battleResults: null,
};

const ARENA = {
  dateTime: "2026-10-08T12:00:00",
  vehicles: [{ id: 1, name: "Me", relation: 0, shipId: 101 }],
} as ArenaInfo;

const DAMAGE_STREAM: LiveSelfStream = {
  ...EMPTY_STREAM,
  damageStats: [{ time: 20, weapon: 1, category: 0, count: 6, total: 5123 }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

describe("liveSelf store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    liveTempReplay.mockReset();
    readLiveReplaySnapshot.mockReset();
    readReplayPositions.mockReset();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not restore an old live snapshot after the session resets", async () => {
    const pending = deferred<LiveSelfStream>();
    liveTempReplay.mockResolvedValue({ path: "temp.wowsreplay", size: 100 });
    readLiveReplaySnapshot.mockReturnValue(pending.promise);
    const store = useLiveSelfStore();
    store.setArena(ARENA);
    store.attach();
    await vi.advanceTimersByTimeAsync(1);
    store.reset();
    pending.resolve(DAMAGE_STREAM);
    await vi.advanceTimersByTimeAsync(1);

    expect(store.model).toBeNull();
    expect(store.phase).toBe("idle");
    expect(store.error).toBeNull();
    store.detach();
  });

  it("polls the new battle while the previous battle's snapshot is still pending", async () => {
    const oldRead = deferred<LiveSelfStream>();
    const newRead = deferred<LiveSelfStream>();
    liveTempReplay.mockResolvedValue({ path: "temp.wowsreplay", size: 100 });
    readLiveReplaySnapshot.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const store = useLiveSelfStore();
    store.setArena(ARENA);
    store.attach();
    await vi.advanceTimersByTimeAsync(1);
    store.setArena({ ...ARENA, dateTime: "next-battle", vehicles: [{ ...ARENA.vehicles[0], id: 2, name: "New" }] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(readLiveReplaySnapshot).toHaveBeenCalledTimes(2);

    oldRead.resolve(DAMAGE_STREAM);
    await vi.advanceTimersByTimeAsync(5000);
    // The obsolete tick's finally must not release the new tick's slot.
    expect(readLiveReplaySnapshot).toHaveBeenCalledTimes(2);
    expect(store.model).toBeNull();
    newRead.resolve(DAMAGE_STREAM);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.model?.selfPlayerId).toBe(2);
    expect(store.phase).toBe("live");
    store.detach();
  });

  it.each(["temp", "snapshot"])("ignores an old %s read failure after reset", async (stage) => {
    const discovery = deferred<Awaited<ReturnType<typeof api.liveTempReplay>>>();
    const snapshot = deferred<LiveSelfStream>();
    liveTempReplay.mockReturnValue(stage === "temp" ? discovery.promise : Promise.resolve({ path: "temp.wowsreplay", size: 100 }));
    readLiveReplaySnapshot.mockReturnValue(snapshot.promise);
    const store = useLiveSelfStore();
    store.setArena(ARENA);
    store.attach();
    await vi.advanceTimersByTimeAsync(1);
    store.reset();
    (stage === "temp" ? discovery : snapshot).reject(new Error("old session read failed"));
    await vi.advanceTimersByTimeAsync(1);

    expect(store.error).toBeNull();
    expect(store.model).toBeNull();
    expect(store.phase).toBe("idle");
    store.detach();
  });

  it("retains the settled report after roster clearing and ignores a late live snapshot", async () => {
    const pending = deferred<LiveSelfStream>();
    liveTempReplay.mockResolvedValue({ path: "temp.wowsreplay", size: 100 });
    readLiveReplaySnapshot.mockReturnValue(pending.promise);
    readReplayPositions.mockResolvedValue({
      ...DAMAGE_STREAM,
      damageStats: [{ time: 20, weapon: 1, category: 0, count: 6, total: 6000 }],
    } as ReplayStream);
    const store = useLiveSelfStore();
    store.setArena(ARENA);
    store.attach();
    await store.settle("finished.wowsreplay");
    store.setArena(null);
    pending.resolve(DAMAGE_STREAM);
    await vi.advanceTimersByTimeAsync(1);
    store.detach();
    store.attach();
    await vi.advanceTimersByTimeAsync(5000);

    expect(store.model?.damage).toBe(6000);
    expect(store.phase).toBe("final");
    expect(liveTempReplay).toHaveBeenCalledTimes(1);
    store.detach();
  });

  it("does not pin the next battle final when an older settled parse completes", async () => {
    const pending = deferred<ReplayStream>();
    readReplayPositions.mockReturnValue(pending.promise);
    const store = useLiveSelfStore();
    store.setArena(ARENA);
    await nextTick();
    const parsing = store.settle("old.wowsreplay");
    store.setArena({ ...ARENA, dateTime: "next-battle" });
    await nextTick();
    pending.resolve(DAMAGE_STREAM as ReplayStream);
    await parsing;

    expect(store.model).toBeNull();
    expect(store.phase).toBe("waiting");
  });

  it("does not retry a failed old parse after reset even when the path is reused", async () => {
    const pending = deferred<ReplayStream>();
    readReplayPositions.mockReturnValueOnce(pending.promise).mockResolvedValue(DAMAGE_STREAM as ReplayStream);
    const store = useLiveSelfStore();
    store.setArena(ARENA);
    await nextTick();
    const oldParse = store.settle("same.wowsreplay");
    store.reset();
    store.setArena({ ...ARENA, dateTime: "next-battle" });
    await nextTick();
    await store.settle("same.wowsreplay");
    pending.reject(new Error("old parse failed"));
    await oldParse;
    await vi.advanceTimersByTimeAsync(2500);

    expect(readReplayPositions).toHaveBeenCalledTimes(2);
    expect(store.error).toBeNull();
    expect(store.phase).toBe("final");
  });

  it("invalidates an already scheduled retry when the next session reuses the path", async () => {
    readReplayPositions.mockRejectedValueOnce(new Error("still flushing")).mockResolvedValue(DAMAGE_STREAM as ReplayStream);
    const store = useLiveSelfStore();
    store.setArena(ARENA);
    await store.settle("same.wowsreplay");
    store.reset();
    store.setArena(ARENA);
    await store.settle("same.wowsreplay");
    await vi.advanceTimersByTimeAsync(2500);

    expect(readReplayPositions).toHaveBeenCalledTimes(2);
    expect(store.model?.damage).toBe(5123);
    expect(store.phase).toBe("final");
  });

  it("retries a failed snapshot read even when the file size did not change", async () => {
    liveTempReplay.mockResolvedValue({ path: "temp.wowsreplay", size: 100 });
    readLiveReplaySnapshot
      .mockRejectedValueOnce(new Error("locked"))
      .mockResolvedValue(EMPTY_STREAM);
    const store = useLiveSelfStore();
    store.setArena(ARENA);
    store.attach();
    await vi.advanceTimersByTimeAsync(1);
    expect(readLiveReplaySnapshot).toHaveBeenCalledTimes(1);

    // Same size, but the read failed — the gate must not swallow the retry.
    await vi.advanceTimersByTimeAsync(5000);
    expect(readLiveReplaySnapshot).toHaveBeenCalledTimes(2);

    // The successful read records the size: a third same-size tick is
    // skipped (the growth gate's actual job).
    await vi.advanceTimersByTimeAsync(5000);
    expect(readLiveReplaySnapshot).toHaveBeenCalledTimes(2);
    store.detach();
  });

  it("clears a stale read error once the temp container is gone", async () => {
    liveTempReplay
      .mockResolvedValueOnce({ path: "temp.wowsreplay", size: 100 })
      .mockResolvedValue(null);
    readLiveReplaySnapshot.mockRejectedValueOnce(new Error("locked"));
    const store = useLiveSelfStore();
    store.setArena(ARENA);
    store.attach();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.error).not.toBeNull();

    // No container = no battle: the previous read failure is no longer a
    // current condition and must not keep rendering.
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.error).toBeNull();
    store.detach();
  });

  it("clears a stale read error once a later read succeeds (even when empty)", async () => {
    liveTempReplay.mockResolvedValue({ path: "temp.wowsreplay", size: 100 });
    readLiveReplaySnapshot
      .mockRejectedValueOnce(new Error("locked"))
      .mockResolvedValue(EMPTY_STREAM);
    const store = useLiveSelfStore();
    store.setArena(ARENA);
    store.attach();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.error).not.toBeNull();

    // The container is still mid-write (empty snapshot) but the read
    // itself is healthy again — the stale failure must not keep sticking
    // to the syncing panel for the rest of the battle.
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.error).toBeNull();
    store.detach();
  });
});
