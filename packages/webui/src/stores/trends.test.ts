import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, type CommunityTrend, type TrendResult } from "@/api";
import { useTrendsStore } from "./trends";

vi.mock("@/api", () => ({ api: {
  getPlayerTrend: vi.fn(), getCommunityShipTrend: vi.fn(), getShipServerStats: vi.fn(),
} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const player = (accountId: number, realm = "asia"): TrendResult => ({ accountId, realm, buckets: [], patches: [] });
const community = (shipId: number): CommunityTrend => ({ shipId, available: true, buckets: [] });

beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
});

describe("trend request identity", () => {
  it("retains a same-player chart during a refresh and clears its error on recovery", async () => {
    vi.mocked(api.getPlayerTrend).mockResolvedValueOnce(player(1)).mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValueOnce(player(1));
    const store = useTrendsStore();
    await store.loadPlayer(1, "asia");
    const refresh = store.loadPlayer(1, "asia");
    expect(store.playerTrend).toEqual(player(1));
    await refresh;
    expect(store.playerTrend).toEqual(player(1));
    expect(store.error).toBe("temporary failure");
    await store.loadPlayer(1, "asia");
    expect(store.error).toBeNull();
    expect(store.loading).toBe(false);
  });

  it.each(["success", "failure"])("ignores a previous player's late %s", async (outcome) => {
    const pending = deferred<TrendResult>();
    vi.mocked(api.getPlayerTrend).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(player(2));
    const store = useTrendsStore();
    const old = store.loadPlayer(1, "asia");
    await store.loadPlayer(2, "asia");
    if (outcome === "success") pending.resolve(player(1));
    else pending.reject(new Error("old player failure"));
    await old;

    expect(store.playerTrend).toEqual(player(2));
    expect(store.error).toBeNull();
    expect(store.loading).toBe(false);
  });

  it("does not stop the current player's spinner when an older request completes", async () => {
    const old = deferred<TrendResult>();
    const current = deferred<TrendResult>();
    vi.mocked(api.getPlayerTrend).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const store = useTrendsStore();
    const first = store.loadPlayer(1, "asia");
    const second = store.loadPlayer(2, "asia");
    old.resolve(player(1));
    await first;
    const loadingBeforeCurrent = store.loading;
    current.resolve(player(2));
    await second;

    expect(loadingBeforeCurrent).toBe(true);
    expect(store.playerTrend).toEqual(player(2));
  });

  it("clears the previous realm's chart while the same account id loads elsewhere", async () => {
    const pending = deferred<TrendResult>();
    vi.mocked(api.getPlayerTrend).mockResolvedValueOnce(player(1)).mockReturnValueOnce(pending.promise);
    const store = useTrendsStore();
    await store.loadPlayer(1, "asia");
    const next = store.loadPlayer(1, "eu");
    const chartWhileLoading = store.playerTrend;
    pending.reject(new Error("EU unavailable"));
    await next;

    expect(chartWhileLoading).toBeNull();
    expect(store.playerTrend).toBeNull();
    expect(store.error).toBe("EU unavailable");
  });

  it.each(["success", "failure"])("ignores a previous ship's community %s", async (outcome) => {
    const pending = deferred<CommunityTrend>();
    vi.mocked(api.getCommunityShipTrend).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(community(2));
    const store = useTrendsStore();
    const old = store.loadCommunity(1);
    await store.loadCommunity(2);
    if (outcome === "success") pending.resolve(community(1));
    else pending.reject(new Error("old ship failed"));
    await old;

    expect(store.communityTrend).toEqual(community(2));
  });

  it("clears the previous ship's community chart before fetching another ship", async () => {
    const pending = deferred<CommunityTrend>();
    vi.mocked(api.getCommunityShipTrend).mockResolvedValueOnce(community(1)).mockReturnValueOnce(pending.promise);
    const store = useTrendsStore();
    await store.loadCommunity(1);
    const next = store.loadCommunity(2);
    const chartWhileLoading = store.communityTrend;
    pending.reject(new Error("no community data"));
    await next;

    expect(chartWhileLoading).toBeNull();
    expect(store.communityTrend).toEqual({ shipId: 2, available: false, buckets: [] });
  });
});
