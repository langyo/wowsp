import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type PlaytimeBattle, type PlaytimeBattles, type PlaytimeOverview } from "@/api";
import { usePlaytimeStore } from "./playtime";

vi.mock("@/api", () => ({ api: { getPlaytimeOverview: vi.fn(), playtimeBattles: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const overview = (launchCount = 1, running = false) => ({
  launchCount, totalSeconds: launchCount * 100,
  lastLaunch: { start: launchCount * 1000, running, durationSeconds: 100 },
}) as PlaytimeOverview;
const battles = (stamp: string): PlaytimeBattles => ({ battles: [{ dateTime: stamp } as PlaytimeBattle] });

beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.mocked(api.getPlaytimeOverview).mockResolvedValue(overview());
  vi.mocked(api.playtimeBattles).mockResolvedValue(battles("current"));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("playtime polling", () => {
  it("acknowledges a slow successful idle scan even if newer polls saw the same activity", async () => {
    const pending = deferred<PlaytimeBattles>();
    vi.mocked(api.playtimeBattles).mockReturnValueOnce(pending.promise);
    const store = usePlaytimeStore();
    store.start();
    await vi.advanceTimersByTimeAsync(60_001);
    pending.resolve(battles("slow-idle"));
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.battles).toEqual(battles("slow-idle"));
    expect(api.playtimeBattles).toHaveBeenCalledTimes(1);
    store.stop();
  });

  it("coalesces polls during a slow battle scan and lets that scan publish", async () => {
    const pending = deferred<PlaytimeBattles>();
    vi.mocked(api.getPlaytimeOverview).mockResolvedValue(overview(1, true));
    vi.mocked(api.playtimeBattles).mockReturnValueOnce(pending.promise);
    const store = usePlaytimeStore();
    store.start();
    await vi.advanceTimersByTimeAsync(90_001);
    expect(api.playtimeBattles).toHaveBeenCalledTimes(1);
    pending.resolve(battles("slow"));
    await vi.advanceTimersByTimeAsync(1);
    expect(store.battles).toEqual(battles("slow"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.playtimeBattles).toHaveBeenCalledTimes(2);
    store.stop();
  });

  it("does not acknowledge a new activity with the previous activity's pending scan", async () => {
    const pending = deferred<PlaytimeBattles>();
    vi.mocked(api.playtimeBattles).mockReturnValueOnce(pending.promise);
    const store = usePlaytimeStore();
    store.start();
    await vi.advanceTimersByTimeAsync(1);
    vi.mocked(api.getPlaytimeOverview).mockResolvedValue(overview(2));
    await vi.advanceTimersByTimeAsync(30_000);
    pending.resolve(battles("previous-activity"));
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.playtimeBattles).toHaveBeenCalledTimes(2);
    expect(store.battles).toEqual(battles("current"));
    store.stop();
  });

  it("still loads battles when the overview is unavailable", async () => {
    vi.mocked(api.getPlaytimeOverview).mockRejectedValue(new Error("overview unavailable"));
    const store = usePlaytimeStore();
    store.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.battles).toEqual(battles("current"));
    expect(store.loaded).toBe(false);
    store.stop();
  });

  it("starts a new scan after remount without letting the retired scan overwrite it", async () => {
    const old = deferred<PlaytimeBattles>();
    vi.mocked(api.playtimeBattles).mockReturnValueOnce(old.promise);
    const store = usePlaytimeStore();
    store.start();
    await vi.advanceTimersByTimeAsync(1);
    store.stop();
    store.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.battles).toEqual(battles("current"));
    old.resolve(battles("retired"));
    await vi.advanceTimersByTimeAsync(1);
    expect(store.battles).toEqual(battles("current"));
    store.stop();
  });

  it("retries a failed first battle scan even when the idle activity key is unchanged", async () => {
    vi.mocked(api.playtimeBattles).mockRejectedValueOnce(new Error("scan locked"));
    const store = usePlaytimeStore();
    store.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.battles).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.playtimeBattles).toHaveBeenCalledTimes(2);
    expect(store.battles).toEqual(battles("current"));
    store.stop();
  });

  it("scans each poll while the game runs because new battles can finish in the same launch", async () => {
    vi.mocked(api.getPlaytimeOverview).mockResolvedValue(overview(1, true));
    const store = usePlaytimeStore();
    store.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.playtimeBattles).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.playtimeBattles).toHaveBeenCalledTimes(3);
    store.stop();
  });

  it("does not rescan a successfully loaded idle activity key", async () => {
    const store = usePlaytimeStore();
    store.start();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(api.playtimeBattles).toHaveBeenCalledTimes(1);
    store.stop();
  });

  it("retries a changed activity key after a failed scan without discarding previous battles", async () => {
    const store = usePlaytimeStore();
    store.start();
    await vi.advanceTimersByTimeAsync(1);
    vi.mocked(api.getPlaytimeOverview).mockResolvedValue(overview(2));
    vi.mocked(api.playtimeBattles).mockRejectedValueOnce(new Error("scan locked"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.battles).toEqual(battles("current"));
    vi.mocked(api.playtimeBattles).mockResolvedValue(battles("after-exit"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.battles).toEqual(battles("after-exit"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.playtimeBattles).toHaveBeenCalledTimes(3);
    store.stop();
  });

  it("keeps a newer overview when an older poll returns later", async () => {
    const old = deferred<PlaytimeOverview>();
    vi.mocked(api.getPlaytimeOverview).mockReturnValueOnce(old.promise).mockResolvedValueOnce(overview(2));
    const store = usePlaytimeStore();
    const first = store.fetch();
    await store.fetch();
    old.resolve(overview(1));
    await first;
    expect(store.overview).toEqual(overview(2));
  });

  it("keeps a newer battle scan when an older scan returns later", async () => {
    const old = deferred<PlaytimeBattles>();
    vi.mocked(api.playtimeBattles).mockReturnValueOnce(old.promise).mockResolvedValueOnce(battles("new"));
    const store = usePlaytimeStore();
    const first = store.fetchBattles();
    await store.fetchBattles();
    old.resolve(battles("old"));
    await first;
    expect(store.battles).toEqual(battles("new"));
  });

  it("does not resume scanning when an overview request completes after stop", async () => {
    const store = usePlaytimeStore();
    store.start();
    await vi.advanceTimersByTimeAsync(1);
    const pending = deferred<PlaytimeOverview>();
    vi.mocked(api.getPlaytimeOverview).mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    store.stop();
    pending.resolve(overview(2));
    await vi.advanceTimersByTimeAsync(1);
    expect(api.playtimeBattles).toHaveBeenCalledTimes(1);
    expect(store.overview).toEqual(overview(1));
  });
});
