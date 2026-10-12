import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { h, nextTick, reactive } from "vue";

import type { ExpectedPrEntry, ShipStatsHistoryPoint } from "@/api";

enableAutoUnmount(afterEach);

const mocks = vi.hoisted(() => ({
  account: { activeAccount: null as { accountId: number; realm: string } | null },
  shipStats: {
    history: new Map<string, ShipStatsHistoryPoint[]>(),
    loadHistory: vi.fn(),
  },
  getExpectedPrTable: vi.fn(),
  prefs: { value: { prEnabled: true } },
}));

vi.mock("@/api", () => ({ api: { getExpectedPrTable: mocks.getExpectedPrTable } }));
vi.mock("@/stores/account", () => ({ useAccountStore: () => mocks.account }));
vi.mock("@/stores/shipStats", () => ({ useShipStatsStore: () => mocks.shipStats }));
vi.mock("@/stores/statsPrefs", () => ({ statsPrefsState: mocks.prefs }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/i18n/useLanguage", () => ({ useLanguage: () => ({ uiLocale: { value: "en" } }) }));
vi.mock("@/components/ships/FilterCategoryChip", () => ({
  default: {
    name: "FilterCategoryChip",
    props: ["title", "allLabel", "options", "selected", "open", "edge"],
    render: () => null,
  },
}));
vi.mock("./PrTrendChart", () => ({
  default: {
    name: "PrTrendChart",
    props: ["points"],
    render: () => h("svg", { class: "pr-trend-stub" }),
  },
}));

import PrTrendSection from "./PrTrendSection";

/** Per-test history fixture: null = the read resolves WITHOUT caching a
 *  value (the failed-read / no-file path), [] = an empty history. */
let historyFixture: ShipStatsHistoryPoint[] | null = null;

function historyPoint(
  t: number,
  ships: Array<[number, number, number, number, number]>,
): ShipStatsHistoryPoint {
  // [shipId, battles, wins, damage, frags]
  return {
    timestamp: t,
    ships: ships.map(([shipId, battles, wins, damage, frags]) => ({
      shipId,
      battles,
      wins,
      damageCaused: damage,
      frags,
      survivedBattles: 0,
      lastBattleTime: 0,
    })),
  };
}

beforeEach(() => {
  historyFixture = null;
  // Reactive account: the switch tests mutate activeAccount and the
  // component's computed/watch must observe it (mirrors the real store).
  mocks.account = reactive({ activeAccount: { accountId: 1, realm: "asia" } });
  // Reactive Map: the component's computed reads history.get() and must see
  // the store-side set (mirrors the real shipStats store's ref<Map>).
  mocks.shipStats.history = reactive(new Map<string, ShipStatsHistoryPoint[]>());
  mocks.shipStats.loadHistory = vi.fn(async (accountId: number, realm: string) => {
    const points = historyFixture ?? [];
    if (historyFixture) mocks.shipStats.history.set(`${realm}_${accountId}`, points);
    return points;
  });
  mocks.prefs.value = { prEnabled: true };
  mocks.getExpectedPrTable.mockReset();
});

describe("PrTrendSection gating", () => {
  it("keeps the section visible with the empty note once the history read settles empty", async () => {
    historyFixture = [];
    mocks.getExpectedPrTable.mockReturnValue(new Promise(() => {})); // still out
    const wrapper = mount(PrTrendSection);
    await flushPromises();
    // The frame is on screen even while the expected table is still being
    // fetched — the regression this pins: the whole section used to vanish.
    expect(wrapper.find(".pr-trend-section").exists()).toBe(true);
    expect(wrapper.text()).toContain("playtime.prTrendTitle");
    expect(wrapper.text()).toContain("playtime.prTrendEmpty");
    expect(wrapper.find(".pr-trend-stub").exists()).toBe(false);
  });

  it("renders the frame with no body while the expected table loads (history present)", async () => {
    historyFixture = [historyPoint(100, [[1, 10, 5, 10000, 10]])];
    mocks.getExpectedPrTable.mockReturnValue(new Promise(() => {}));
    const wrapper = mount(PrTrendSection);
    await flushPromises();
    expect(wrapper.find(".pr-trend-section").exists()).toBe(true);
    expect(wrapper.text()).not.toContain("prTrendEmpty");
    expect(wrapper.text()).not.toContain("prTrendNoExpected");
    expect(wrapper.text()).not.toContain("prTrendNoData");
    expect(wrapper.find(".pr-trend-stub").exists()).toBe(false);
  });

  it("draws the chart once the history and the expected table are both in", async () => {
    historyFixture = [historyPoint(100, [[1, 10, 5, 10000, 10]])];
    let resolveTable!: (v: ExpectedPrEntry[]) => void;
    mocks.getExpectedPrTable.mockReturnValue(new Promise((r) => (resolveTable = r)));
    const wrapper = mount(PrTrendSection);
    await flushPromises();
    resolveTable([{ shipId: 1, avgDamage: 1000, avgFrags: 1, winrate: 50 }]);
    await flushPromises();
    await nextTick();
    expect(wrapper.find(".pr-trend-stub").exists()).toBe(true);
    expect(wrapper.text()).toContain("playtime.prTrendHint");
  });

  it("falls through to the empty note when the history read caches nothing", async () => {
    // A read that resolves without a cache entry (a store failure, or a
    // host where the command is unavailable) must not hide the section.
    historyFixture = null;
    mocks.getExpectedPrTable.mockReturnValue(new Promise(() => {}));
    const wrapper = mount(PrTrendSection);
    await flushPromises();
    expect(wrapper.find(".pr-trend-section").exists()).toBe(true);
    expect(wrapper.text()).toContain("playtime.prTrendEmpty");
  });

  it("shows the no-expected-data note when the table came back empty", async () => {
    historyFixture = [historyPoint(100, [[1, 10, 5, 10000, 10]])];
    mocks.getExpectedPrTable.mockResolvedValue([]);
    const wrapper = mount(PrTrendSection);
    await flushPromises();
    expect(wrapper.text()).toContain("playtime.prTrendNoExpected");
    expect(wrapper.find(".pr-trend-stub").exists()).toBe(false);
  });

  it("keeps the frame with no note while the history read is still out", async () => {
    // A read that never settles must not produce a note (nor hide the
    // frame) — the face stays "loading" until it does.
    mocks.shipStats.loadHistory = vi.fn(() => new Promise(() => {}));
    mocks.getExpectedPrTable.mockReturnValue(new Promise(() => {}));
    const wrapper = mount(PrTrendSection);
    await flushPromises();
    expect(wrapper.find(".pr-trend-section").exists()).toBe(true);
    expect(wrapper.text()).not.toContain("prTrendEmpty");
    expect(wrapper.text()).not.toContain("prTrendNoExpected");
    expect(wrapper.text()).not.toContain("prTrendNoData");
  });

  it("does not let a late read of the previous account settle the new one", async () => {
    // Switch A→B while A's read is still in flight: A's late resolution must
    // not mark B's history settled (B's read is still out — a note there
    // would be wrong).
    let resolveA!: (v: ShipStatsHistoryPoint[]) => void;
    mocks.shipStats.loadHistory = vi.fn((accountId: number) => {
      if (accountId === 1) return new Promise((r) => (resolveA = r));
      return new Promise(() => {}); // B's read stays out
    });
    mocks.getExpectedPrTable.mockReturnValue(new Promise(() => {}));
    const wrapper = mount(PrTrendSection);
    await flushPromises();
    mocks.account.activeAccount = { accountId: 2, realm: "asia" };
    await nextTick();
    await flushPromises();
    resolveA([historyPoint(100, [[1, 10, 5, 10000, 10]])]);
    await flushPromises();
    await nextTick();
    expect(wrapper.find(".pr-trend-section").exists()).toBe(true);
    expect(wrapper.text()).not.toContain("prTrendEmpty");
  });

  it("renders nothing without an active account", async () => {
    mocks.account = { activeAccount: null };
    mocks.getExpectedPrTable.mockReturnValue(new Promise(() => {}));
    const wrapper = mount(PrTrendSection);
    await flushPromises();
    expect(wrapper.find(".pr-trend-section").exists()).toBe(false);
  });

  it("renders nothing while PR display is off", async () => {
    mocks.prefs.value = { prEnabled: false };
    historyFixture = [];
    mocks.getExpectedPrTable.mockReturnValue(new Promise(() => {}));
    const wrapper = mount(PrTrendSection);
    await flushPromises();
    expect(wrapper.find(".pr-trend-section").exists()).toBe(false);
  });
});
