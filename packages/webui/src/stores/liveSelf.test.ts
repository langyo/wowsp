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

import type { ArenaInfo, LiveSelfStream } from "@/api";

vi.mock("@/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api")>();
  return {
    ...actual,
    api: {
      liveTempReplay: vi.fn(),
      readLiveReplaySnapshot: vi.fn(),
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

describe("liveSelf store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    liveTempReplay.mockReset();
    readLiveReplaySnapshot.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
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
