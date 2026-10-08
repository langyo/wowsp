import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, type ShipInfo } from "@/api";
import { loadShipsBasics } from "@/utils/shipsBasics";
import { useEncyclopediaStore } from "./encyclopedia";

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
