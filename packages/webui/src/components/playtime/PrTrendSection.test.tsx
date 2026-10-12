import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { h, nextTick, reactive, type VNode } from "vue";

import type { ExpectedPrEntry, ShipStatsHistoryPoint } from "@/api";
import shipNamesDbRaw from "../../data/ship_names.json";

enableAutoUnmount(afterEach);

/** Two REAL offline-DB ship ids of different classes — the popup's type
 *  group only renders options for types the offline DB can resolve, so the
 *  narrowing test needs actual ids (fixture ids degrade to "unknown"). */
function firstShipIdOfType(type: string): number {
  const hit = Object.entries(shipNamesDbRaw).find(
    ([, e]) => (e as { type?: string }).type === type,
  );
  if (!hit) throw new Error(`no ${type} in the offline DB`);
  return Number(hit[0]);
}

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
vi.mock("@/features/holographic/shipIcons", () => ({
  shipIconUrl: (type: string) => (type ? `icon://${type}` : null),
}));
vi.mock("./PrTrendChart", () => ({
  default: {
    name: "PrTrendChart",
    props: ["points", "fmtTick", "hintOf"],
    setup(props: { points: unknown[] }) {
      return () => h("svg", { class: "pr-trend-stub", "data-points": props.points.length });
    },
  },
}));
// HkPopover renders its slot so the popup content mounts under mount();
// HkTabs mirrors the real guard (no update for the active key); HkCheckbox
// renders the modelValue so indeterminate (null) is observable.
vi.mock("@celestia-island/hikari", () => ({
  HkPopover: {
    name: "HkPopover",
    props: ["modelValue", "title"],
    setup(props: { modelValue: boolean }, { slots }: { slots: Record<string, () => VNode[]> }) {
      return () => (props.modelValue ? h("div", { class: "pop-stub" }, slots.default?.()) : null);
    },
  },
  HkTabs: {
    name: "HkTabs",
    props: ["modelValue", "tabs", "variant"],
    emits: ["update:modelValue"],
    setup(
      props: { modelValue: string; tabs: { key: string; label: string }[] },
      { emit }: { emit: (ev: string, v: string) => void },
    ) {
      return () =>
        h(
          "div",
          (props.tabs ?? []).map((tb) =>
            h(
              "button",
              {
                key: tb.key,
                role: "radio",
                "aria-checked": tb.key === props.modelValue,
                onClick: () => {
                  if (tb.key !== props.modelValue) emit("update:modelValue", tb.key);
                },
              },
              tb.label,
            ),
          ),
        );
    },
  },
  HkCheckbox: {
    name: "HkCheckbox",
    props: ["modelValue", "size"],
    emits: ["update:modelValue"],
    setup(props: { modelValue: boolean | null }, { emit }: { emit: (ev: string) => void }) {
      return () =>
        h("span", {
          // The real component's root carries .hk-checkbox — the popup
          // rows' click guard (skip the checkbox, its emit owns the
          // toggle) keys on exactly that class.
          class: "hk-checkbox cb-stub",
          "data-checked": props.modelValue === true ? "" : undefined,
          "data-indeterminate": props.modelValue === null ? "" : undefined,
          onClick: () => emit("update:modelValue"),
        });
    },
  },
  HkDatePicker: {
    name: "HkDatePicker",
    props: ["modelValue", "placeholder", "min", "max", "size"],
    emits: ["update:modelValue"],
    render: () => null,
  },
  useBreakpoint: () => ({ isMobile: { value: false } }),
}));

import PrTrendSection from "./PrTrendSection";

/** Per-test history fixture: null = the read resolves WITHOUT caching a
 *  value (the failed-read / no-file path). */
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

const DAY = 86_400;

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

const TABLE: ExpectedPrEntry[] = [{ shipId: 1, avgDamage: 1000, avgFrags: 1, winrate: 50 }];

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
    // Recent point: the default 30d window keeps it (an old point would
    // plot an empty series and the no-data note instead).
    historyFixture = [historyPoint(Math.floor(Date.now() / 1000) - DAY, [[1, 10, 5, 10000, 10]])];
    mocks.getExpectedPrTable.mockResolvedValue(TABLE);
    const wrapper = mount(PrTrendSection);
    await flushPromises();
    expect(wrapper.find(".pr-trend-stub").exists()).toBe(true);
    expect(wrapper.text()).toContain("playtime.prTrendHint");
  });

  it("falls through to the empty note when the history read caches nothing", async () => {
    historyFixture = null;
    mocks.getExpectedPrTable.mockReturnValue(new Promise(() => {}));
    const wrapper = mount(PrTrendSection);
    await flushPromises();
    expect(wrapper.find(".pr-trend-section").exists()).toBe(true);
    expect(wrapper.text()).toContain("playtime.prTrendEmpty");
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

  it("shows the no-expected-data note over the preserved chart frame", async () => {
    historyFixture = [historyPoint(Math.floor(Date.now() / 1000) - DAY, [[1, 10, 5, 10000, 10]])];
    mocks.getExpectedPrTable.mockResolvedValue([]);
    const wrapper = mount(PrTrendSection);
    await flushPromises();
    expect(wrapper.text()).toContain("playtime.prTrendNoExpected");
    // The empty frame stands so the section never collapses.
    expect(wrapper.find(".pr-trend-stub").exists()).toBe(true);
  });
});

describe("PrTrendSection range + ship popup", () => {
  it("keeps plotting inside the default window and reacts to the range tabs", async () => {
    // One ancient point, one recent: the default 30d window keeps only the
    // recent one; switching to 全生涯 admits both.
    const nowSec = Math.floor(Date.now() / 1000);
    historyFixture = [
      historyPoint(nowSec - 200 * DAY, [[1, 10, 5, 10000, 10]]),
      historyPoint(nowSec - DAY, [[1, 12, 7, 12400, 12]]),
    ];
    mocks.getExpectedPrTable.mockResolvedValue(TABLE);
    const wrapper = mount(PrTrendSection);
    await flushPromises();
    expect(wrapper.find(".pr-trend-stub").attributes("data-points")).toBe("1");
    const tabs = wrapper.findAll("[role='radio']");
    const allTab = tabs.find((tb) => tb.text() === "playtime.prTrendRangeAll");
    expect(allTab).toBeTruthy();
    await allTab!.trigger("click");
    await nextTick();
    // The ancient point joins the series.
    expect(wrapper.find(".pr-trend-stub").attributes("data-points")).toBe("2");
  });

  it("lists ships with stats in the popup and supports select-all with indeterminate", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    historyFixture = [
      historyPoint(nowSec - 3 * DAY, [
        [1, 10, 5, 10000, 2],
        [2, 20, 10, 40000, 6],
      ]),
      historyPoint(nowSec - DAY, [
        [1, 14, 8, 14000, 3],
        [2, 24, 12, 44000, 7],
      ]),
    ];
    mocks.getExpectedPrTable.mockResolvedValue(TABLE);
    const wrapper = mount(PrTrendSection);
    await flushPromises();
    // Open the ship popup.
    await wrapper.find("button.ship-filter-bar__chip").trigger("click");
    const rows = wrapper.findAll(".pr-trend-pop__row");
    expect(rows).toHaveLength(2);
    // Ship 2 (more battles) first. Fixture ship ids are absent from the
    // offline DB, so the name degrades to the raw id "2". Deltas: p1 full
    // totals (20 battles / 10 wins / 40k) + p2 delta (4 / 2 / 4k) = 24
    // battles, 12 wins → 50.0%, avg 44000/24 = 1833.
    expect(rows[0].text()).toContain("24");
    expect(rows[0].text()).toContain("50.0%");
    expect(rows[0].text()).toContain(Math.round(44000 / 24).toLocaleString("en"));
    // Nothing picked → select-all unchecked; pick one row → indeterminate.
    expect(wrapper.find(".pr-trend-pop__all .cb-stub").attributes("data-checked")).toBeUndefined();
    await rows[0].find(".cb-stub").trigger("click");
    expect(wrapper.find(".pr-trend-pop__all .cb-stub").attributes("data-indeterminate")).toBe("");
    // Chip label switches to the picked count.
    expect(wrapper.find("button.ship-filter-bar__chip").text()).toContain(
      "playtime.prTrendShipCount",
    );
    // Select-all checks the rest.
    await wrapper.find(".pr-trend-pop__all .cb-stub").trigger("click");
    expect(wrapper.find(".pr-trend-pop__all .cb-stub").attributes("data-checked")).toBe("");
    expect(wrapper.findAll(".pr-trend-pop__row .cb-stub[data-checked]")).toHaveLength(2);
  });

  it("shows the incomplete-custom hint until both dates are picked", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    historyFixture = [historyPoint(nowSec - DAY, [[1, 10, 5, 10000, 10]])];
    mocks.getExpectedPrTable.mockResolvedValue(TABLE);
    const wrapper = mount(PrTrendSection);
    await flushPromises();
    expect(wrapper.find(".pr-trend-stub").exists()).toBe(true);
    // Switch to 自定义 with no dates: the body names the cause (not the
    // no-data note), and the chart steps aside.
    const customTab = wrapper
      .findAll("[role='radio']")
      .find((tb) => tb.text() === "dashboard.rangeCustom");
    expect(customTab).toBeTruthy();
    await customTab!.trigger("click");
    await nextTick();
    expect(wrapper.text()).toContain("playtime.prTrendRangeIncomplete");
    // The empty frame stands so the section never collapses.
    expect(wrapper.find(".pr-trend-stub").exists()).toBe(true);
  });

  it("does not let a late read of the previous account settle the new one", async () => {
    // Switch A→B while A's read is still out: A's late resolution must not
    // mark B's history settled (B's read is still out — a note there would
    // be wrong), and the chip's selections reset to 全部舰船.
    let resolveA!: (v: ShipStatsHistoryPoint[]) => void;
    mocks.shipStats.loadHistory = vi.fn((accountId: number) => {
      if (accountId === 1) return new Promise((r) => (resolveA = r));
      return new Promise(() => {}); // B's read stays out
    });
    mocks.getExpectedPrTable.mockReturnValue(new Promise(() => {}));
    historyFixture = [historyPoint(Math.floor(Date.now() / 1000) - DAY, [[1, 10, 5, 10000, 10]])];
    const wrapper = mount(PrTrendSection);
    await flushPromises();
    // Pick a selection state on A, then switch.
    mocks.shipStats.history.set("asia_1", historyFixture!);
    await flushPromises();
    await wrapper.find("button.ship-filter-bar__chip").trigger("click");
    const rows = wrapper.findAll(".pr-trend-pop__row");
    expect(rows.length).toBeGreaterThan(0);
    await rows[0].find(".hk-checkbox").trigger("click");
    expect(wrapper.find("button.ship-filter-bar__chip").text()).toContain(
      "playtime.prTrendShipCount",
    );
    mocks.account.activeAccount = { accountId: 2, realm: "asia" };
    await nextTick();
    await flushPromises();
    // Selections reset; A's late settle changes nothing for B (frame only,
    // no note while B's read is still out).
    expect(wrapper.find("button.ship-filter-bar__chip").text()).not.toContain(
      "playtime.prTrendShipCount",
    );
    resolveA([historyPoint(100, [[1, 10, 5, 10000, 10]])]);
    await flushPromises();
    await nextTick();
    expect(wrapper.find(".pr-trend-section").exists()).toBe(true);
    expect(wrapper.text()).not.toContain("prTrendEmpty");
    expect(wrapper.text()).not.toContain("prTrendNoExpected");
    expect(wrapper.text()).not.toContain("prTrendNoData");
  });

  it("narrows the popup list with the type group; 全部 resets it", async () => {
    // Real ships of TWO different classes: picking one type must drop the
    // other ship's row (fixture ids would both be "unknown" and render no
    // type options at all).
    const bb = firstShipIdOfType("Battleship");
    const dd = firstShipIdOfType("Destroyer");
    const nowSec = Math.floor(Date.now() / 1000);
    historyFixture = [
      historyPoint(nowSec - 3 * DAY, [
        [bb, 10, 5, 10000, 2],
        [dd, 20, 10, 40000, 6],
      ]),
    ];
    mocks.getExpectedPrTable.mockResolvedValue([
      { shipId: bb, avgDamage: 1000, avgFrags: 1, winrate: 50 },
      { shipId: dd, avgDamage: 2000, avgFrags: 1, winrate: 50 },
    ]);
    const wrapper = mount(PrTrendSection);
    await flushPromises();
    await wrapper.find("button.ship-filter-bar__chip").trigger("click");
    expect(wrapper.findAll(".pr-trend-pop__row")).toHaveLength(2);
    // The type group now carries real options: [全部舰种, ...present types].
    const typeOpts = wrapper.findAll(".pr-trend-pop__groups .ship-filter-bar__opt");
    expect(typeOpts.length).toBeGreaterThanOrEqual(3); // 全部 + ≥2 types
    // Pick the first CONCRETE type (index 1) — one of BB/CV/CA/DD/SS — and
    // exactly one row survives.
    await typeOpts[1].trigger("click");
    await nextTick();
    expect(wrapper.findAll(".pr-trend-pop__row")).toHaveLength(1);
    // 全部 resets: both rows return.
    await typeOpts[0].trigger("click");
    await nextTick();
    expect(wrapper.findAll(".pr-trend-pop__row")).toHaveLength(2);
  });
});
