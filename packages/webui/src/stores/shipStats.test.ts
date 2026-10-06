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

describe("shipStats store ttl guard", () => {
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
