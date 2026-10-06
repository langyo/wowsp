/** Stats store: in-flight lookup dedupe (concurrent lookups share ONE API
 *  call) and dog-tag continuity — a fresh pull that lost the emblem must
 *  not wipe the previously cached one (the Rust command swallows Vortex
 *  dog-tag failures into null). */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, type PlayerStats } from "@/api";
import { useStatsStore } from "./stats";

vi.mock("@/api", () => ({
  api: {
    appdataRead: vi.fn(async () => null),
    appdataWrite: vi.fn(async () => {}),
    lookupPlayerStats: vi.fn(),
    snapshotPlayerStats: vi.fn(async () => {}),
  },
}));

const DOG_TAG = {
  textureId: 1,
  symbolId: 2,
  borderColor: 0,
  backgroundColor: 0,
  backgroundId: 3,
};

function mockStats(overrides: Partial<PlayerStats> = {}): PlayerStats {
  return {
    accountId: 101,
    name: "langyo",
    battles: 100,
    winrate: 50,
    dogTag: null,
    ...overrides,
  } as PlayerStats;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("stats store lookup", () => {
  it("carries the previous dog tag over a fresh result that lost it", async () => {
    const store = useStatsStore();
    store.cache.set("asia_101", mockStats({ dogTag: DOG_TAG }));
    vi.mocked(api.lookupPlayerStats).mockResolvedValue(mockStats({ dogTag: null }));

    const result = await store.lookup("langyo", "asia", { force: true });

    expect(result.dogTag).toEqual(DOG_TAG);
    expect(store.cache.get("asia_101")?.dogTag).toEqual(DOG_TAG);
    // The disk envelope persists the MERGED snapshot too.
    const envelope = vi
      .mocked(api.appdataWrite)
      .mock.calls.find(([file]) => file === "stats-cache/asia_101.json");
    expect(envelope).toBeTruthy();
    expect(
      (JSON.parse(envelope![1] as string) as { stats: PlayerStats }).stats.dogTag,
    ).toEqual(DOG_TAG);
  });

  it("warms the disk cache to carry the dog tag over on a cold session", async () => {
    const store = useStatsStore();
    // No in-memory snapshot — the previous emblem lives only on disk.
    vi.mocked(api.appdataRead).mockImplementation(async (file: string) =>
      file === "stats-cache/asia_101.json"
        ? JSON.stringify({ fetchedAt: 1, stats: mockStats({ dogTag: DOG_TAG }) })
        : null,
    );
    vi.mocked(api.lookupPlayerStats).mockResolvedValue(mockStats({ dogTag: null }));

    const result = await store.lookup("langyo", "asia", { force: true });

    expect(result.dogTag).toEqual(DOG_TAG);
    expect(store.cache.get("asia_101")?.dogTag).toEqual(DOG_TAG);
  });

  it("lets a fresh dog tag replace the old one", async () => {
    const store = useStatsStore();
    const freshTag = { ...DOG_TAG, symbolId: 9 };
    store.cache.set("asia_101", mockStats({ dogTag: DOG_TAG }));
    vi.mocked(api.lookupPlayerStats).mockResolvedValue(mockStats({ dogTag: freshTag }));

    const result = await store.lookup("langyo", "asia", { force: true });

    expect(result.dogTag).toEqual(freshTag);
  });

  it("dedupes concurrent lookups of the same player into one API call", async () => {
    const store = useStatsStore();
    let resolve!: (value: PlayerStats) => void;
    vi.mocked(api.lookupPlayerStats).mockImplementation(
      () =>
        new Promise<PlayerStats>((r) => {
          resolve = r;
        }),
    );

    const p1 = store.lookup("langyo", "asia", { force: true });
    const p2 = store.lookup("langyo", "asia", { force: true });
    // lookup awaits the index read before reaching the API — drain the
    // microtask queue so the (single) API call is actually in flight.
    await new Promise<void>((r) => setTimeout(r, 0));
    resolve(mockStats());
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(api.lookupPlayerStats).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
  });

  it("releases the in-flight slot after a failed attempt", async () => {
    const store = useStatsStore();
    vi.mocked(api.lookupPlayerStats).mockRejectedValueOnce(new Error("boom"));
    await expect(store.lookup("langyo", "asia", { force: true })).rejects.toThrow("boom");
    // The rejection must flow through lookup's catch even though the fetch
    // ran on the queued pipeline message — the lookup page's error notice
    // and the dashboard's error strip both read this state.
    expect(store.error).toBe("boom");
    expect(store.loading).toBe(false);

    vi.mocked(api.lookupPlayerStats).mockResolvedValueOnce(mockStats());
    await expect(store.lookup("langyo", "asia", { force: true })).resolves.toBeTruthy();
    expect(store.error).toBe(null);
    expect(api.lookupPlayerStats).toHaveBeenCalledTimes(2);
  });

  it("runs different players' lookups serially, in FIFO submission order", async () => {
    const store = useStatsStore();
    const calls: string[] = [];
    const resolvers = new Map<string, (value: PlayerStats) => void>();
    vi.mocked(api.lookupPlayerStats).mockImplementation(
      (name: string) =>
        new Promise<PlayerStats>((r) => {
          calls.push(name);
          resolvers.set(name, r);
        }),
    );

    // Two surfaces querying two different players "at once" — the WG API
    // must still see them strictly one after the other.
    const p1 = store.lookup("alice", "asia", { force: true });
    const p2 = store.lookup("bob", "asia", { force: true });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(calls).toEqual(["alice"]);

    resolvers.get("alice")!(mockStats({ accountId: 1, name: "alice" }));
    await p1;
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(calls).toEqual(["alice", "bob"]);

    resolvers.get("bob")!(mockStats({ accountId: 2, name: "bob" }));
    await p2;
    expect(api.lookupPlayerStats).toHaveBeenCalledTimes(2);
  });
});
