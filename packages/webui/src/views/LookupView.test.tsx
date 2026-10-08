import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, shallowMount } from "@vue/test-utils";
import { reactive } from "vue";
import type { ClanInfo, PlayerStats } from "@/api";

const mocks = vi.hoisted(() => ({
  route: { query: {} as Record<string, string> },
  player: vi.fn(), clan: vi.fn(), ranked: vi.fn(), ships: vi.fn(),
  stores: {} as Record<string, unknown>,
}));

vi.mock("vue-router", () => ({ useRoute: () => mocks.route }));
vi.mock("@/api", () => ({ api: {} }));
vi.mock("@/stores/stats", () => ({ useStatsStore: () => mocks.stores.stats }));
vi.mock("@/stores/clanStats", () => ({
  useClanStatsStore: () => mocks.stores.clan,
  clanCacheKey: (realm: string, id: number) => `${realm}_${id}`,
}));
vi.mock("@/stores/shipStats", () => ({ useShipStatsStore: () => mocks.stores.ships }));
vi.mock("@/stores/ranked", () => ({ useRankedStore: () => mocks.stores.ranked }));
vi.mock("@/stores/loadingTasks", () => ({ useLoadingTasksStore: () => ({ begin: vi.fn(), end: vi.fn() }) }));
vi.mock("@/stores/encyclopedia", () => ({ useEncyclopediaStore: () => ({ byId: new Map() }) }));
vi.mock("@/stores/statsPrefs", () => ({ useStatsPrefsStore: () => ({ prefs: {} }) }));
vi.mock("@/composables/useShipDetail", () => ({ useShipDetail: () => ({ selectedShip: { value: null }, gameRoot: { value: "" }, closeShip: vi.fn(), openShip: vi.fn() }) }));
vi.mock("@/composables/useCareerStamp", () => ({ useCareerStamp: () => ({ value: null }) }));
vi.mock("@/composables/useCompositionStamps", () => ({ useCompositionStamps: () => ({ value: null }) }));
vi.mock("@/features/share/useShareImage", () => ({ useShareImage: () => ({ busy: { value: false }, copyShot: vi.fn() }) }));
vi.mock("@/features/share/statsShot", () => ({ renderStatsShot: vi.fn() }));
vi.mock("@/features/share/clanShot", () => ({ renderClanShot: vi.fn() }));
vi.mock("@/features/holographic/modelLoader", () => ({ shipOfflineEntry: () => null, shipNameFromModelDb: () => "", shipNameFromOfflineDb: () => "" }));
vi.mock("@/features/holographic/shipIcons", () => ({ shipIcon: () => null }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/useLanguage", () => ({ useLanguage: () => ({ uiLocale: { value: "en" } }) }));
vi.mock("@/components/stats/StatsCard", () => ({ default: { name: "StatsCard", props: ["stats"], render: () => null } }));
vi.mock("@/components/stats/ClanCard", () => ({ default: { name: "ClanCard", props: ["clan"], render: () => null }, defaultRosterOrder: vi.fn(), roleLabel: vi.fn() }));
vi.mock("@/components/stats/RankedSeasonModal", () => ({ default: { name: "RankedSeasonModal", render: () => null } }));
vi.mock("@/components/stats/LookupErrorNotice", () => ({ default: { name: "LookupErrorNotice", props: ["raw"], render: () => null } }));
vi.mock("@/components/stats/ShipDistCharts", () => ({ default: { name: "ShipDistCharts", render: () => null } }));
vi.mock("@/components/search/AsyncSearchCombo", () => ({ default: { name: "AsyncSearchCombo", render: () => null } }));
vi.mock("@/components/ships/ShipFilterBar", () => ({ default: { name: "ShipFilterBar", props: ["ships", "realm"], render: () => null } }));
vi.mock("@/components/ships/ShipDetailModal", () => ({ default: { name: "ShipDetailModal", props: ["realm"], render: () => null } }));
vi.mock("@/features/share/ShareShotButton", () => ({ default: { name: "ShareShotButton", render: () => null } }));
vi.mock("@celestia-island/hikari", () => ({ HkTabs: { name: "HkTabs", render: () => null }, HkSpinner: { name: "HkSpinner", render: () => null } }));

import LookupView from "./LookupView";

enableAutoUnmount(afterEach);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const player = (accountId: number, realm = "asia") => ({ accountId, realm, name: `Player${accountId}`, clanId: 42 }) as PlayerStats;
const clan = (clanId: number, realm = "asia") => ({ clanId, realm, tag: `Clan${clanId}`, members: [] }) as unknown as ClanInfo;
function mountLookup(query: Record<string, string> = {}) {
  mocks.route.query = query;
  return shallowMount(LookupView);
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  mocks.stores.stats = reactive({ cache: new Map(), lookup: mocks.player, loading: false, error: null, lookupError: null });
  mocks.stores.clan = reactive({ cache: new Map(), lookup: mocks.clan, loading: false, error: null, lookupError: null });
  mocks.stores.ships = reactive({ cache: new Map([["asia_101", [{ shipId: 1, battles: 10 }]]]), history: new Map(), load: mocks.ships });
  mocks.stores.ranked = { load: mocks.ranked, reset: vi.fn(), winrate: null, battles: null };
  mocks.ships.mockResolvedValue([]);
  mocks.ranked.mockResolvedValue([]);
});

describe("lookup result ownership", () => {
  it("keeps the newest clan after replies arrive in reverse order", async () => {
    const first = deferred<ClanInfo>();
    const second = deferred<ClanInfo>();
    mocks.clan.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = mountLookup({ clan: "1", realm: "asia" });
    view.findComponent({ name: "AsyncSearchCombo" }).vm.$emit("select", { clanId: 2 });
    second.resolve(clan(2));
    await flushPromises();
    first.resolve(clan(1));
    await flushPromises();
    expect(view.findComponent({ name: "ClanCard" }).props("clan").clanId).toBe(2);
    expect(JSON.parse(localStorage.getItem("wowsp.lookup.history")!)[0].id).toBe(2);
  });

  it("does not start old player's shared ranked work after another query starts", async () => {
    const first = deferred<PlayerStats>();
    const second = deferred<PlayerStats>();
    mocks.player.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = mountLookup({ name: "101", realm: "asia" });
    view.findComponent({ name: "AsyncSearchCombo" }).vm.$emit("select", { accountId: 202 });
    first.resolve(player(101));
    await flushPromises();
    expect(mocks.ranked).not.toHaveBeenCalled();
    expect(view.findComponent({ name: "StatsCard" }).exists()).toBe(false);
    second.resolve(player(202));
    await flushPromises();
    expect(mocks.ranked).toHaveBeenCalledExactlyOnceWith(202, "asia");
  });

  it("discards delayed lookup work after leaving the view", async () => {
    const pending = deferred<PlayerStats>();
    mocks.player.mockReturnValueOnce(pending.promise);
    const view = mountLookup({ name: "101", realm: "asia" });
    view.unmount();
    pending.resolve(player(101));
    await flushPromises();
    expect(mocks.ranked).not.toHaveBeenCalled();
    expect(mocks.ships).not.toHaveBeenCalled();
    expect(localStorage.getItem("wowsp.lookup.history")).toBeNull();
  });

  it("keeps displayed player's realm when the next-search realm picker changes", async () => {
    mocks.player.mockResolvedValueOnce(player(101));
    const view = mountLookup({ name: "101", realm: "asia" });
    await flushPromises();
    view.findAllComponents({ name: "HkTabs" })[0].vm.$emit("update:modelValue", "eu");
    await flushPromises();
    expect(view.findComponent({ name: "ShipFilterBar" }).props("ships")).toHaveLength(1);
    expect(view.findComponent({ name: "ShipFilterBar" }).props("realm")).toBe("asia");
    expect(view.findComponent({ name: "ShipDetailModal" }).props("realm")).toBe("asia");
    mocks.clan.mockResolvedValueOnce(clan(42));
    view.findComponent({ name: "StatsCard" }).vm.$emit("clanClick");
    await flushPromises();
    expect(mocks.clan).toHaveBeenCalledExactlyOnceWith(42, "asia", { force: true });
  });

  it("keeps the current pending row independent of an older store request finishing", async () => {
    const old = deferred<ClanInfo>();
    const latest = deferred<ClanInfo>();
    mocks.clan.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const view = mountLookup({ clan: "1", realm: "asia" });
    view.findComponent({ name: "AsyncSearchCombo" }).vm.$emit("select", { clanId: 2 });
    old.resolve(clan(1));
    await flushPromises();
    expect(view.find(".lookup-view__pending").exists()).toBe(true);
    view.findAllComponents({ name: "HkTabs" })[0].vm.$emit("update:modelValue", "eu");
    await flushPromises();
    expect(view.find(".lookup-view__pending-realm").text()).toBe("ASIA");
    latest.resolve(clan(2));
    await flushPromises();
    expect(view.find(".lookup-view__pending").exists()).toBe(false);
  });

  it("shows this query's native string error and ignores foreign store errors", async () => {
    const pending = deferred<PlayerStats>();
    mocks.player.mockReturnValueOnce(pending.promise);
    const view = mountLookup({ name: "101", realm: "asia" });
    Object.assign(mocks.stores.stats!, { error: "another screen failed" });
    await flushPromises();
    expect(view.findComponent({ name: "LookupErrorNotice" }).exists()).toBe(false);
    pending.reject("this query failed");
    await flushPromises();
    expect(view.findComponent({ name: "LookupErrorNotice" }).props("raw")).toBe("this query failed");
  });

  it("ignores a previous query's failure after the latest query succeeds", async () => {
    const old = deferred<ClanInfo>();
    mocks.clan.mockReturnValueOnce(old.promise).mockResolvedValueOnce(clan(2));
    const view = mountLookup({ clan: "1", realm: "asia" });
    view.findComponent({ name: "AsyncSearchCombo" }).vm.$emit("select", { clanId: 2 });
    await flushPromises();
    old.reject("old query failed");
    await flushPromises();
    expect(view.findComponent({ name: "LookupErrorNotice" }).exists()).toBe(false);
    expect(view.findComponent({ name: "ClanCard" }).props("clan").clanId).toBe(2);
  });

  it("invalidates a player request when switching to clan mode", async () => {
    const pending = deferred<PlayerStats>();
    mocks.player.mockReturnValueOnce(pending.promise);
    const view = mountLookup({ name: "101", realm: "asia" });
    view.findAllComponents({ name: "HkTabs" })[1].vm.$emit("update:modelValue", "clan");
    pending.resolve(player(101));
    await flushPromises();
    expect(view.find(".lookup-view__pending").exists()).toBe(false);
    expect(mocks.ranked).not.toHaveBeenCalled();
    expect(localStorage.getItem("wowsp.lookup.history")).toBeNull();
  });

  it("uses the displayed clan's realm for member navigation after the picker changes", async () => {
    mocks.clan.mockResolvedValueOnce(clan(1));
    const view = mountLookup({ clan: "1", realm: "asia" });
    await flushPromises();
    view.findAllComponents({ name: "HkTabs" })[0].vm.$emit("update:modelValue", "eu");
    mocks.player.mockResolvedValueOnce(player(101));
    view.findComponent({ name: "ClanCard" }).vm.$emit("memberClick", { accountId: 101 });
    await flushPromises();
    expect(mocks.player).toHaveBeenCalledExactlyOnceWith("101", "asia", { force: true });
  });
});
