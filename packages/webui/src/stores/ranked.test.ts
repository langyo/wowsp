/** Ranked store: the `ttlMs` revisit guards — each slot (seasons, and the
 *  lazy per-ship rows) may only be served back for the SAME player and
 *  window within the TTL (the dashboard's network-free revisits); other
 *  players, other windows, a reset or a lapsed window still re-query. */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  api,
  type RankedSeasonStats,
  type RankedShipSeasonStats,
} from "@/api";
import { useRankedStore } from "./ranked";

vi.mock("@/api", () => ({
  api: {
    getRankedStats: vi.fn(),
    getRankedShipStats: vi.fn(),
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

describe("ranked store ship-slot ttl guard", () => {
  function shipRow(shipId: number, seasonId = 1030): RankedShipSeasonStats {
    return {
      shipId,
      seasonId,
      battles: 10,
      wins: 5,
      losses: 5,
      damageDealt: 100_000,
      frags: 9,
      survivedBattles: 4,
      planesKilled: 1,
      xp: 15_000,
      maxDamage: 30_000,
      maxXp: 2_500,
      solo: { battles: 10, wins: 5 },
      div2: null,
      div3: null,
    };
  }

  it("serves the ship slot within the ttl and re-queries for another player", async () => {
    const store = useRankedStore();
    vi.mocked(api.getRankedShipStats).mockResolvedValue([shipRow(1)]);

    await store.loadShips(101, "asia", { ttlMs: 60_000 });
    await store.loadShips(101, "asia", { ttlMs: 60_000 });
    expect(api.getRankedShipStats).toHaveBeenCalledTimes(1);
    expect(store.shipSeasons).toEqual([shipRow(1)]);
    expect(store.shipsError).toBeNull();

    await store.loadShips(202, "asia", { ttlMs: 60_000 });
    expect(api.getRankedShipStats).toHaveBeenCalledTimes(2);
  });

  it("records the fetch failure and clears the slot", async () => {
    const store = useRankedStore();
    vi.mocked(api.getRankedShipStats).mockRejectedValueOnce(new Error("down"));

    await store.loadShips(101, "asia");
    expect(store.shipSeasons).toEqual([]);
    expect(store.shipsError).toBe("down");
  });

  it("reset drops the ship slot too", async () => {
    const store = useRankedStore();
    vi.mocked(api.getRankedShipStats).mockResolvedValue([shipRow(1)]);

    await store.loadShips(101, "asia", { ttlMs: 60_000 });
    store.reset();
    await store.loadShips(101, "asia", { ttlMs: 60_000 });

    expect(api.getRankedShipStats).toHaveBeenCalledTimes(2);
    expect(store.shipsError).toBeNull();
  });
});
