/**
 * Tests for the shipStats store's streaming-progress hook — the state
 * machine the degraded-loading chip and the lookup table's progressive
 * fill ride: "slow" registers a source, "done"/"aborted" stand it down,
 * "partial" rows fill the cache ONLY while a load() for that player is
 * pending (roster-only fetches and late events must not clobber the
 * table), and zero-battle rows are filtered exactly like final answers.
 *
 * The api module is mocked; pinia and the shared FIFO pipeline are real —
 * a load() is held open with a manually-resolved promise so pending-state
 * transitions are observable.
 */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readShipStatsHistory: vi.fn(),
  lookupPlayerShipStats: vi.fn(),
  upstreamHealth: vi.fn(),
}));

vi.mock("@/api", () => ({
  api: {
    ...mocks,
    listenShipStatsProgress: undefined,
  },
}));

import type { PlayerShipStats } from "@/api";
import { useShipStatsStore } from "@/stores/shipStats";

function row(shipId: number, battles: number): PlayerShipStats {
  return {
    shipId,
    name: "",
    battles,
    wins: 0,
    damageCaused: 0,
    frags: 0,
    survivedBattles: 0,
    winrate: 0,
    avgDamage: 0,
    lastBattleTime: 0,
    pr: null,
    avgXp: null,
    modes: null,
  } as PlayerShipStats;
}

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.readShipStatsHistory.mockReset().mockResolvedValue([]);
  mocks.lookupPlayerShipStats.mockReset();
  mocks.upstreamHealth.mockReset().mockResolvedValue([]);
});

describe("shipStats streaming progress", () => {
  it("slow/done/aborted drive the slow-source registry", () => {
    const store = useShipStatsStore();
    expect(store.anySlowStream).toBe(false);
    store.applyProgress({ realm: "asia", accountId: 1, phase: "slow", source: "vortex:pvp" });
    store.applyProgress({ realm: "asia", accountId: 1, phase: "slow", source: "official" });
    expect(store.slowStreams.size).toBe(2);
    // A repeated slow phase is idempotent.
    store.applyProgress({ realm: "asia", accountId: 1, phase: "slow", source: "official" });
    expect(store.slowStreams.size).toBe(2);
    store.applyProgress({ realm: "asia", accountId: 1, phase: "done", source: "official" });
    expect(store.slowStreams.size).toBe(1);
    store.applyProgress({ realm: "asia", accountId: 1, phase: "aborted", source: "vortex:pvp" });
    expect(store.anySlowStream).toBe(false);
  });

  it("partial rows apply only while a load() is pending", async () => {
    const store = useShipStatsStore();
    // No pending load: partial rows are roster noise, not table data.
    store.applyProgress({
      realm: "asia",
      accountId: 7,
      phase: "partial",
      source: "vortex:pvp",
      rows: [row(1, 10)],
    });
    expect(store.cache.get("asia_7")).toBeUndefined();

    // Hold a load open, then feed partials into it.
    let release!: (rows: PlayerShipStats[]) => void;
    mocks.lookupPlayerShipStats.mockReturnValue(
      new Promise<PlayerShipStats[]>((resolve) => {
        release = resolve;
      }),
    );
    const pending = store.load(7, "asia");
    store.applyProgress({
      realm: "asia",
      accountId: 7,
      phase: "partial",
      source: "vortex:pvp",
      rows: [row(1, 10), row(2, 0)],
    });
    // Zero-battle rows filtered exactly like a final answer.
    expect(store.cache.get("asia_7")).toEqual([row(1, 10)]);

    release([row(1, 12), row(3, 5)]);
    await expect(pending).resolves.toHaveLength(2);
    expect(store.cache.get("asia_7")).toEqual([row(1, 12), row(3, 5)]);

    // After the load settled, a LATE partial must not clobber the final.
    store.applyProgress({
      realm: "asia",
      accountId: 7,
      phase: "partial",
      source: "official",
      rows: [row(9, 99)],
    });
    expect(store.cache.get("asia_7")).toEqual([row(1, 12), row(3, 5)]);
  });

  it("a failed load keeps the partial rows standing (degraded face)", async () => {
    const store = useShipStatsStore();
    mocks.lookupPlayerShipStats.mockRejectedValue(new Error("stalled 15s"));
    const pending = store.load(9, "cn");
    store.applyProgress({
      realm: "cn",
      accountId: 9,
      phase: "partial",
      source: "vortex:pvp",
      rows: [row(4, 44)],
    });
    // No older cache existed — the load's catch finds the stream's partial
    // rows standing in the cache and RESOLVES with them (the degraded
    // "partial data" face) instead of rejecting into a silent .catch.
    await expect(pending).resolves.toEqual([row(4, 44)]);
    expect(store.cache.get("cn_9")).toEqual([row(4, 44)]);
  });

  it("partials never downgrade a complete cached answer", async () => {
    const store = useShipStatsStore();
    mocks.lookupPlayerShipStats.mockResolvedValue([row(1, 100), row(2, 200)]);
    await store.load(5, "asia");
    expect(store.cache.get("asia_5")).toHaveLength(2);
    // A later lookup of the same player goes pending again; its stream's
    // partials must not replace the complete rows already on show.
    mocks.lookupPlayerShipStats.mockReturnValue(new Promise<PlayerShipStats[]>(() => {}));
    const pending = store.load(5, "asia");
    store.applyProgress({
      realm: "asia",
      accountId: 5,
      phase: "partial",
      source: "vortex:pvp",
      rows: [row(3, 1)],
    });
    expect(store.cache.get("asia_5")).toHaveLength(2);
    void pending; // stays pending; the guard is what this test asserts
  });

  it("a later partial never shrinks the visible table", async () => {
    const store = useShipStatsStore();
    mocks.lookupPlayerShipStats.mockReturnValue(new Promise<PlayerShipStats[]>(() => {}));
    const pending = store.load(6, "ru");
    // The racer lands first with a full 3-row list…
    store.applyProgress({
      realm: "ru",
      accountId: 6,
      phase: "partial",
      source: "official",
      rows: [row(1, 10), row(2, 20), row(3, 30)],
    });
    expect(store.cache.get("ru_6")).toHaveLength(3);
    // …then the primary's first 1-row batch must not shrink it.
    store.applyProgress({
      realm: "ru",
      accountId: 6,
      phase: "partial",
      source: "vortex:pvp",
      rows: [row(9, 5)],
    });
    expect(store.cache.get("ru_6")).toHaveLength(3);
    // A growing batch still applies.
    store.applyProgress({
      realm: "ru",
      accountId: 6,
      phase: "partial",
      source: "vortex:pvp",
      rows: [row(9, 5), row(8, 6), row(7, 7), row(6, 8)],
    });
    expect(store.cache.get("ru_6")).toHaveLength(4);
    void pending;
  });
});
