import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, type ShipInfo } from "@/api";
import { loadShipsBasics } from "@/utils/shipsBasics";
import { useEncyclopediaStore } from "./encyclopedia";
import { useShipsUiStore } from "@/stores/shipsUi";

vi.mock("@/api", () => ({ api: { getGameVersion: vi.fn(), getShipEncyclopedia: vi.fn() } }));
vi.mock("@/i18n/useLanguage", () => ({
  useLanguage: () => ({ dataLanguage: { value: "zh-CN" } }),
  wgApiLanguage: () => "zh-cn",
}));
vi.mock("@/stores/account", () => ({ useAccountStore: () => ({ activeRealm: "asia" }) }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/features/holographic/modelLoader", () => ({
  shipNameFromOfflineDb: vi.fn(), shipDescriptionFromOfflineDb: vi.fn(),
}));
vi.mock("@/utils/shipsBasics", () => ({ loadShipsBasics: vi.fn(), basicsToShipInfo: vi.fn() }));

// The overlay module is exercised by its own test against the generated
// data; here it stands in deterministically — hiding the fake WG-only hull
// 777 and appending the fake Lesta ship 9001 while the tree realm is lesta
// (the display-list contract the store relies on), with the resolution
// union carrying 9001 in either mode and pruning nothing.
vi.mock("@/utils/shipsLesta", () => ({
  withLestaOverlay: vi.fn(async (list: ShipInfo[], _lang: string) => {
    const { useShipsUiStore: ui } = await import("@/stores/shipsUi");
    if (ui().treeRealm !== "lesta") return list;
    return [
      ...list.filter((s) => s.shipId !== 777),
      { shipId: 9001, name: "Lesta ship" } as ShipInfo,
    ];
  }),
  withLestaResolution: vi.fn(async (list: ShipInfo[], _lang: string) =>
    list.some((s) => s.shipId === 9001)
      ? list
      : [...list, { shipId: 9001, name: "Lesta ship" } as ShipInfo],
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const ASIA_SHIPS = [{ shipId: 1, name: "Asia ship" }] as ShipInfo[];
const EU_SHIPS = [{ shipId: 2, name: "EU ship" }] as ShipInfo[];

beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
  vi.mocked(api.getGameVersion).mockResolvedValue({ gameVersion: "test", shipsTotal: 1, timestamp: 0 });
});

describe("encyclopedia request ownership", () => {
  it("keeps an explicit same-realm refresh when another consumer uses the cached realm", async () => {
    const pending = deferred<ShipInfo[]>();
    vi.mocked(api.getShipEncyclopedia).mockResolvedValueOnce(ASIA_SHIPS).mockReturnValueOnce(pending.promise);
    const store = useEncyclopediaStore();
    await store.load("asia");
    const refreshing = store.load("asia", true);
    await Promise.resolve();
    await store.load("asia");
    const loadingDuringRefresh = store.loading;
    const updated = [{ ...ASIA_SHIPS[0], name: "Updated Asia ship" }];
    pending.resolve(updated);
    await refreshing;

    expect(store.ships).toEqual(updated);
    expect(loadingDuringRefresh).toBe(true);
    expect(store.loading).toBe(false);
  });

  it.each(["success", "failure"])("reselecting cached realm supersedes a pending other realm's %s", async (outcome) => {
    const pending = deferred<ShipInfo[]>();
    vi.mocked(api.getShipEncyclopedia).mockResolvedValueOnce(ASIA_SHIPS).mockReturnValueOnce(pending.promise);
    vi.mocked(loadShipsBasics).mockRejectedValue(new Error("no offline bundle"));
    const store = useEncyclopediaStore();
    await store.load("asia");
    const eu = store.load("eu");
    await Promise.resolve();
    await store.load("asia");
    const loadingAfterCacheHit = store.loading;
    if (outcome === "success") pending.resolve(EU_SHIPS);
    else pending.reject(new Error("EU unavailable"));
    await eu;

    expect(store.loadedRealm).toBe("asia");
    expect(store.ships).toEqual(ASIA_SHIPS);
    expect(store.error).toBeNull();
    expect(loadingAfterCacheHit).toBe(false);
    expect(api.getShipEncyclopedia).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("ignores obsolete offline fallback failure (English retry: %s)", async (englishRetry) => {
    const pending = deferred<Awaited<ReturnType<typeof loadShipsBasics>>>();
    let started!: () => void;
    const fallbackStarted = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(loadShipsBasics).mockImplementation(() => { started(); return pending.promise; });
    vi.mocked(api.getShipEncyclopedia).mockRejectedValueOnce(new Error(englishRetry ? "INVALID_LANGUAGE" : "old network failure"));
    if (englishRetry) vi.mocked(api.getShipEncyclopedia).mockRejectedValueOnce(new Error("old English failure"));
    vi.mocked(api.getShipEncyclopedia).mockResolvedValue(ASIA_SHIPS);
    const store = useEncyclopediaStore();
    const old = store.load("eu");
    await fallbackStarted;
    await store.load("asia");
    pending.reject(new Error("old bundle failure"));
    await old;

    expect(store.loadedRealm).toBe("asia");
    expect(store.ships).toEqual(ASIA_SHIPS);
    expect(store.error).toBeNull();
    expect(store.loading).toBe(false);
  });
});

describe("Lesta overlay", () => {
  it("appends the overlay ships while the branch source is Lesta", async () => {
    vi.mocked(api.getShipEncyclopedia).mockResolvedValue(ASIA_SHIPS);
    const store = useEncyclopediaStore();
    useShipsUiStore().setTreeRealm("lesta");
    await store.load("asia", true);

    expect(store.ships.map((s) => s.shipId)).toEqual([1, 9001]);
  });

  it("re-derives the list locally when the branch source flips, no refetch", async () => {
    vi.mocked(api.getShipEncyclopedia).mockResolvedValue(ASIA_SHIPS);
    // The previous test persists lesta through localStorage — start clean.
    useShipsUiStore().setTreeRealm("wg");
    const store = useEncyclopediaStore();
    await store.load("asia", true);
    expect(store.ships.map((s) => s.shipId)).toEqual([1]);

    useShipsUiStore().setTreeRealm("lesta");
    await vi.waitFor(() => expect(store.ships.map((s) => s.shipId)).toEqual([1, 9001]));
    useShipsUiStore().setTreeRealm("wg");
    await vi.waitFor(() => expect(store.ships.map((s) => s.shipId)).toEqual([1]));
    // One fetch only — the flip never round-tripped the WG API.
    expect(api.getShipEncyclopedia).toHaveBeenCalledTimes(1);
  });

  it("keeps branch-dropped WG-only ships resolvable in byId", async () => {
    // The 458-battle "unknown type" regression: a WG-only event hull hides
    // from the Lesta-mode display list, yet the account played it — stats
    // resolution (byId) must still classify it, alongside the overlay's
    // Lesta-only ships and the untouched base.
    const wgOnly = { shipId: 777, name: "WG-only event ship" } as ShipInfo;
    vi.mocked(api.getShipEncyclopedia).mockResolvedValue([...ASIA_SHIPS, wgOnly]);
    useShipsUiStore().setTreeRealm("lesta");
    const store = useEncyclopediaStore();
    await store.load("asia", true);

    expect(store.ships.map((s) => s.shipId)).toEqual([1, 9001]);
    expect(store.byId.get(777)?.name).toBe("WG-only event ship");
    expect(store.byId.get(9001)?.name).toBe("Lesta ship");
    expect(store.byId.get(1)?.name).toBe("Asia ship");
  });

  it("resolves Lesta-only ships in WG mode too — byId is branch-independent", async () => {
    vi.mocked(api.getShipEncyclopedia).mockResolvedValue(ASIA_SHIPS);
    useShipsUiStore().setTreeRealm("wg");
    const store = useEncyclopediaStore();
    await store.load("asia", true);

    expect(store.ships.map((s) => s.shipId)).toEqual([1]);
    expect(store.byId.get(9001)?.name).toBe("Lesta ship");
  });
});
