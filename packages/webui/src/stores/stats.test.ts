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
  vi.resetAllMocks();
});

describe("stats store lookup", () => {
  it.each(["success", "failure"])("orders best-effort disk snapshots after an older write's %s", async (outcome) => {
    const store = useStatsStore();
    store.index.set("asia_langyo", 101);
    const disk = new Map<string, string>();
    const playerFile = "stats-cache/asia_101.json";
    let finishWrite!: () => void;
    let failWrite!: (error: Error) => void;
    const pending = new Promise<void>((resolve, reject) => { finishWrite = resolve; failWrite = reject; });
    let firstSnapshot = true;
    vi.mocked(api.appdataWrite).mockImplementation(async (file, data) => {
      if (file === playerFile && firstSnapshot) {
        firstSnapshot = false;
        await pending;
      }
      disk.set(file, data);
      return null;
    });
    vi.mocked(api.lookupPlayerStats)
      .mockResolvedValueOnce(mockStats({ battles: 100, dogTag: DOG_TAG }))
      .mockResolvedValueOnce(mockStats({ battles: 200, dogTag: DOG_TAG }));
    await store.lookup("langyo", "asia", { force: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const second = await store.lookup("langyo", "asia", { force: true });
    expect(second.battles).toBe(200); // Persistence must not block fresh UI data.
    const snapshotsStarted = vi.mocked(api.appdataWrite).mock.calls.filter(([file]) => file === playerFile).length;
    if (outcome === "success") finishWrite();
    else failWrite(new Error("old disk write failed"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(JSON.parse(disk.get(playerFile)!).stats.battles).toBe(200);
    expect(snapshotsStarted).toBe(1);
    expect(JSON.parse(disk.get("stats-cache/index.json")!).asia_langyo).toBe(101);
  });

  it("persists the cumulative nickname index after an older index write completes", async () => {
    const store = useStatsStore();
    const disk = new Map<string, string>();
    let finishWrite!: () => void;
    const pending = new Promise<void>((resolve) => { finishWrite = resolve; });
    let firstIndex = true;
    vi.mocked(api.appdataWrite).mockImplementation(async (file, data) => {
      if (file === "stats-cache/index.json" && firstIndex) {
        firstIndex = false;
        await pending;
      }
      disk.set(file, data);
      return null;
    });
    vi.mocked(api.lookupPlayerStats).mockImplementation(async (name) =>
      mockStats({ accountId: name === "alice" ? 1 : 2, name, dogTag: DOG_TAG }),
    );
    await store.lookup("alice", "asia", { force: true });
    await store.lookup("bob", "asia", { force: true });
    finishWrite();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(JSON.parse(disk.get("stats-cache/index.json")!)).toEqual({ asia_alice: 1, asia_bob: 2 });
    expect(JSON.parse(disk.get("stats-cache/asia_1.json")!).stats.accountId).toBe(1);
    expect(JSON.parse(disk.get("stats-cache/asia_2.json")!).stats.accountId).toBe(2);
  });

  it.each(["snapshot", "missing", "failure"])("keeps refreshed stats when an older disk read finishes with %s", async (outcome) => {
    const store = useStatsStore();
    store.index.set("asia_langyo", 101);
    let finishRead!: (raw: string | null) => void;
    let failRead!: (error: Error) => void;
    vi.mocked(api.appdataRead).mockImplementationOnce(() => new Promise((resolve, reject) => {
      finishRead = resolve;
      failRead = reject;
    }));
    const hydration = store.loadCached("asia", 101);
    const fresh = mockStats({ battles: 200, dogTag: DOG_TAG });
    vi.mocked(api.lookupPlayerStats).mockResolvedValue(fresh);
    await store.lookup("langyo", "asia", { force: true });
    const timestamp = store.fetchedAt.get("asia_101");

    if (outcome === "failure") failRead(new Error("old disk read failed"));
    else finishRead(outcome === "missing" ? null : JSON.stringify({ fetchedAt: 1, stats: mockStats({ battles: 100 }) }));
    expect(await hydration).toEqual(fresh);
    expect(store.cache.get("asia_101")).toEqual(fresh);
    expect(store.fetchedAt.get("asia_101")).toBe(timestamp);
  });

  it("keeps newly learned nickname mappings when an older index read finishes", async () => {
    const store = useStatsStore();
    let finishRead!: (raw: string) => void;
    vi.mocked(api.appdataRead)
      .mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }))
      .mockResolvedValue(null);
    vi.mocked(api.lookupPlayerStats).mockImplementation(async (name) =>
      mockStats({ accountId: name === "alice" ? 1 : 2, name, dogTag: DOG_TAG }),
    );
    const alice = store.lookup("alice", "asia", { force: true });
    await store.lookup("bob", "asia", { force: true });
    finishRead(JSON.stringify({ asia_bob: 999, asia_cached: 3 }));
    await alice;

    expect(store.index.get("asia_alice")).toBe(1);
    expect(store.index.get("asia_bob")).toBe(2);
    expect(store.index.get("asia_cached")).toBe(3);
  });

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
