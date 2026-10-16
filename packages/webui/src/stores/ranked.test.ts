/** Ranked store: the `ttlMs` revisit guard — the single slot may only be
 *  served back for the SAME player and season window within the TTL (the
 *  dashboard's network-free revisits); other players, other windows, a
 *  reset or a lapsed window still re-query. */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, type RankedSeasonStats } from "@/api";
import { useRankedStore } from "./ranked";

vi.mock("@/api", () => ({
  api: {
    getRankedStats: vi.fn(),
  },
}));

function mockSeasons(seasonId = 1): RankedSeasonStats[] {
  return [
    {
      seasonId,
      seasonName: "Season 1",
      battles: 10,
      wins: 5,
      losses: 5,
      damageDealt: 100_000,
      frags: 2,
      maxDamage: 20_000,
      maxXp: 1_500,
      survivedBattles: 3,
      planesKilled: 1,
      currentRank: 10,
      bestRank: 8,
      bestRankDisplay: "8",
    },
  ];
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("ranked store ttl guard", () => {
  it.each(["success", "failure"] as const)("a cached revisit supersedes another player's pending %s", async (outcome) => {
    const store = useRankedStore();
    vi.mocked(api.getRankedStats).mockResolvedValueOnce(mockSeasons(1));
    await store.load(101, "asia", undefined, { ttlMs: 60_000 });
    let resolve!: (rows: RankedSeasonStats[]) => void;
    let reject!: (reason: unknown) => void;
    const pending = new Promise<RankedSeasonStats[]>((yes, no) => { resolve = yes; reject = no; });
    vi.mocked(api.getRankedStats).mockReturnValueOnce(pending);
    const otherPlayer = store.load(202, "eu");
    await store.load(101, "asia", undefined, { ttlMs: 60_000 });
    if (outcome === "success") resolve(mockSeasons(2));
    else reject(new Error("the superseded player failed"));
    await otherPlayer;
    expect(store.accountId).toBe(101);
    expect(store.seasons).toEqual(mockSeasons(1));
    expect(store.error).toBeNull();
    expect(api.getRankedStats).toHaveBeenCalledTimes(2);
  });

  it("serves the slot within the ttl for the same player and window", async () => {
    const store = useRankedStore();
    vi.mocked(api.getRankedStats).mockResolvedValue(mockSeasons());

    await store.load(101, "asia", undefined, { ttlMs: 60_000 });
    await store.load(101, "asia", undefined, { ttlMs: 60_000 });

    expect(api.getRankedStats).toHaveBeenCalledTimes(1);
    expect(store.seasons).toEqual(mockSeasons());
  });

  it("re-queries within the window for another player", async () => {
    const store = useRankedStore();
    vi.mocked(api.getRankedStats).mockResolvedValue(mockSeasons());

    await store.load(101, "asia", undefined, { ttlMs: 60_000 });
    await store.load(202, "asia", undefined, { ttlMs: 60_000 });

    expect(api.getRankedStats).toHaveBeenCalledTimes(2);
  });

  it("re-queries within the window for a different season count", async () => {
    const store = useRankedStore();
    vi.mocked(api.getRankedStats).mockResolvedValue(mockSeasons());

    await store.load(101, "asia", undefined, { ttlMs: 60_000 });
    await store.load(101, "asia", 5, { ttlMs: 60_000 });

    expect(api.getRankedStats).toHaveBeenCalledTimes(2);
  });

  it("re-queries after reset clears the slot", async () => {
    const store = useRankedStore();
    vi.mocked(api.getRankedStats).mockResolvedValue(mockSeasons());

    await store.load(101, "asia", undefined, { ttlMs: 60_000 });
    store.reset();
    await store.load(101, "asia", undefined, { ttlMs: 60_000 });

    expect(api.getRankedStats).toHaveBeenCalledTimes(2);
  });

  it("re-queries once the ttl window has lapsed", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const store = useRankedStore();
      vi.mocked(api.getRankedStats).mockResolvedValue(mockSeasons());

      await store.load(101, "asia", undefined, { ttlMs: 60_000 });
      vi.setSystemTime(1_000_000 + 60_001);
      await store.load(101, "asia", undefined, { ttlMs: 60_000 });

      expect(api.getRankedStats).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("always re-queries without a ttl option (default behavior)", async () => {
    const store = useRankedStore();
    vi.mocked(api.getRankedStats).mockResolvedValue(mockSeasons());

    await store.load(101, "asia");
    await store.load(101, "asia");

    expect(api.getRankedStats).toHaveBeenCalledTimes(2);
  });
});
