/** ShipStats store: the `ttlMs` revisit guard — a cached result younger
 *  than the TTL must not re-query the WG API (dashboard hops stay
 *  network-free), while the default call, another player's key and a
 *  lapsed window still re-fetch. */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, type PlayerShipStats } from "@/api";
import { useShipStatsStore } from "./shipStats";

vi.mock("@/api", () => ({
  api: {
    lookupPlayerShipStats: vi.fn(),
    readShipStatsHistory: vi.fn(async () => []),
  },
}));

function mockShips(shipId = 1): PlayerShipStats[] {
  return [
    {
      shipId,
      name: "Yamato",
      battles: 10,
      wins: 5,
      damageCaused: 100_000,
      frags: 2,
      survivedBattles: 3,
      winrate: 50,
      avgDamage: 10_000,
      lastBattleTime: 1_700_000_000,
    },
  ];
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("shipStats store", () => {
  /** The backend keeps zero-pvp ship rows for the roster's ranked/co-op
   *  buckets; this store feeds the randoms per-ship table, where such a
   *  row (battles 0, 0% winrate) is noise — it must filter out at load. */
  it("filters zero-pvp rows out of the table's list", async () => {
    const store = useShipStatsStore();
    const zeroPvp: PlayerShipStats = {
      ...mockShips(2)[0]!,
      shipId: 2,
      battles: 0,
      wins: 0,
      winrate: 0,
      avgDamage: 0,
    };
    vi.mocked(api.lookupPlayerShipStats).mockResolvedValue([...mockShips(1), zeroPvp]);

    const rows = await store.load(101, "asia");

    expect(rows.map((r) => r.shipId)).toEqual([1]);
    // The filtered shape is what lands in the cache (and history reads).
    expect(store.cache.get("asia_101")?.map((r) => r.shipId)).toEqual([1]);
  });

  it("serves a cached result within the ttl without re-querying", async () => {
    const store = useShipStatsStore();
    vi.mocked(api.lookupPlayerShipStats).mockResolvedValue(mockShips());

    const first = await store.load(101, "asia", { ttlMs: 60_000 });
    const second = await store.load(101, "asia", { ttlMs: 60_000 });

    expect(api.lookupPlayerShipStats).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("re-fetches once the ttl window has lapsed", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const store = useShipStatsStore();
      vi.mocked(api.lookupPlayerShipStats).mockResolvedValue(mockShips());

      await store.load(101, "asia", { ttlMs: 60_000 });
      vi.setSystemTime(1_000_000 + 60_001);
      await store.load(101, "asia", { ttlMs: 60_000 });

      expect(api.lookupPlayerShipStats).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still fetches another player inside the window", async () => {
    const store = useShipStatsStore();
    vi.mocked(api.lookupPlayerShipStats).mockResolvedValue(mockShips());

    await store.load(101, "asia", { ttlMs: 60_000 });
    await store.load(202, "asia", { ttlMs: 60_000 });

    expect(api.lookupPlayerShipStats).toHaveBeenCalledTimes(2);
  });

  it("always re-fetches without a ttl option (default behavior)", async () => {
    const store = useShipStatsStore();
    vi.mocked(api.lookupPlayerShipStats).mockResolvedValue(mockShips());

    await store.load(101, "asia");
    await store.load(101, "asia");

    expect(api.lookupPlayerShipStats).toHaveBeenCalledTimes(2);
  });
});
