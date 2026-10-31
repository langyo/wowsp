/**
 * DashboardView — the 自定义 (custom) date-range path.
 *
 * The dashboard's range strip is the shared DateRangeTabs component (that
 * component has its own suite for the popover mechanics), so this file pins
 * only what the DASHBOARD does with the window the strip reports:
 *   - the strip renders the five segments 1D / 7D / 30D / All / 自定义, with
 *     自定义 LAST (the host appends it to the shared preset list);
 *   - selecting 自定义 is inert until BOTH pickers carry a day — a half-picked
 *     pair reports a null window, so the per-ship list must stay unfiltered;
 *   - a complete pair with no local snapshot history and no replay log falls
 *     back to the labeled career filter: only ships whose `lastBattleTime`
 *     lands inside the inclusive [fromSec, toSec] window survive;
 *   - flipping the strip back to All restores the full career list;
 *   - the localBattles store is asked to load EXACTLY the picked window and
 *     never on the All tab (career totals need no replay scan). The store is
 *     an inert stub, so no IPC happens and the assertion is on its arguments;
 *   - a SECOND load of the same preset segment re-reads the clock: the refresh
 *     pill must request a window that has MOVED since the tab click. The
 *     cached-window regression kept serving the window captured at select
 *     time and hid every battle played after the tab was selected.
 *
 * Everything below the strip (cards, the filter bar, modals, the share-shot
 * pipeline) is stubbed the way LookupView.test.tsx stubs its children: these
 * tests assert on the props the view hands down, never on a child's own
 * rendering. hikari's primitives are stubbed too — HkTabs mirrors the real
 * segmented control's active-key guard and ARIA shape (so clicking a radio is
 * the genuine gesture), HkPopover renders its slot, HkDatePicker renders
 * nothing but emits its model. DateRangeTabs itself stays REAL: its segment
 * order and picker-driven `update:window` are exactly what the dashboard's
 * contract is built on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { h, reactive, type VNode } from "vue";
import type { PlayerShipStats, PlayerStats } from "@/api";

/** The one active account every case mounts with — also the cache key the
 *  stats / per-ship rows are seeded under. */
const ACCOUNT = { accountId: 101, nickname: "Solo", realm: "asia" };
const ACCOUNT_KEY = `${ACCOUNT.realm}_${ACCOUNT.accountId}`;

/** The account-level snapshot that makes the dashboard render its content
 *  branch (the view shows the bind prompt without one). */
const PLAYER_STATS: PlayerStats = {
  accountId: ACCOUNT.accountId,
  name: "Solo",
  realm: ACCOUNT.realm,
  battles: 100,
  winrate: 50,
  hidden: false,
  clanId: null,
};

const mocks = vi.hoisted(() => ({
  /** localBattles.load — the replay-source request the view fires. Its call
   *  arguments are asserted directly, which is why the store needs no real
   *  implementation here. */
  load: vi.fn(),
  /** One slot per stubbed Pinia store; beforeEach installs them. */
  stores: {} as Record<string, unknown>,
}));

/** One day in seconds. Every ship stamp is seeded relative to the window the
 *  pickers resolve, so no assertion depends on the wall clock or DST. */
const DAY = 86_400;

/** A per-ship career row — the shape the dashboard's career fallback filters
 *  on `lastBattleTime`. */
function ship(shipId: number, lastBattleTime: number): PlayerShipStats {
  return {
    shipId,
    name: `Ship${shipId}`,
    battles: 10,
    wins: 6,
    damageCaused: 50_000,
    frags: 4,
    survivedBattles: 3,
    winrate: 60,
    avgDamage: 5_000,
    lastBattleTime,
  };
}

/** `offsetDays` from today as an ISO `YYYY-MM-DD` in the local zone (the
 *  format the date pickers emit; negative = past), matching
 *  LookupView.test.tsx's fixture helper. */
function isoDaysAgo(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * DAY * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A fixture day pair plus the inclusive second-based window it resolves to —
 *  exactly the window DateRangeTabs reports through `update:window`. */
function pickedWindow() {
  const fromIso = isoDaysAgo(-12);
  const toIso = isoDaysAgo(-3);
  const window = isoDayWindowSec(fromIso, toIso);
  if (!window) throw new Error("the fixture day pair must resolve to a window");
  return { fromIso, toIso, window };
}

// ── Ambient modules: router, IPC client, Pinia stores ──────────────────────
// The view is mounted outside any Pinia/router app (LookupView.test.tsx's
// style): every store it pulls is a hand-rolled reactive stub, so these tests
// exercise the view's own wiring instead of store internals.
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/api", () => ({ api: {} }));
vi.mock("@/stores/account", () => ({ useAccountStore: () => mocks.stores.account }));
vi.mock("@/stores/stats", () => ({ useStatsStore: () => mocks.stores.stats }));
vi.mock("@/stores/shipStats", () => ({ useShipStatsStore: () => mocks.stores.shipStats }));
vi.mock("@/stores/localBattles", () => ({ useLocalBattlesStore: () => mocks.stores.localBattles }));
vi.mock("@/stores/encyclopedia", () => ({ useEncyclopediaStore: () => mocks.stores.encyclopedia }));
vi.mock("@/stores/trends", () => ({ useTrendsStore: () => mocks.stores.trends }));
vi.mock("@/stores/ranked", () => ({ useRankedStore: () => mocks.stores.ranked }));
vi.mock("@/stores/loadingTasks", () => ({ useLoadingTasksStore: () => mocks.stores.loadingTasks }));
// utils/winrate.ts reads this module-level ref (the PR tier labels), so it
// rides along with the store stub.
vi.mock("@/stores/statsPrefs", () => ({
  useStatsPrefsStore: () => mocks.stores.statsPrefs,
  statsPrefsState: { value: { prEnabled: true, prAlgo: "winrate", localizedTiers: true } },
}));

// ── Composables, share-shot pipeline, data helpers ─────────────────────────
// None of these participate in the range-filtering contract; keeping them out
// of the graph also keeps the suite free of three.js / WebGL import-time work.
vi.mock("@/composables/useShipDetail", () => ({
  useShipDetail: () => ({
    selectedShip: { value: null },
    gameRoot: { value: "" },
    closeShip: vi.fn(),
    openShip: vi.fn(),
  }),
}));
vi.mock("@/composables/useCareerStamp", () => ({ useCareerStamp: () => ({ value: null }) }));
vi.mock("@/composables/useCompositionStamps", () => ({ useCompositionStamps: () => ({ value: null }) }));
vi.mock("@/features/share/useShareImage", () => ({
  useShareImage: () => ({ busy: { value: false }, copyShot: vi.fn() }),
}));
vi.mock("@/features/share/statsShot", () => ({ renderStatsShot: vi.fn() }));
vi.mock("@/features/replay/shipLiveStats", () => ({ shipTypeBadgeShort: () => "BB" }));
vi.mock("@/components/stats/shipTypeHint", () => ({ shipTypeHintCard: () => ({}) }));
vi.mock("@/features/holographic/modelLoader", () => ({
  shipOfflineEntry: () => null,
  shipNameFromModelDb: () => "",
  shipNameFromOfflineDb: () => "",
}));
vi.mock("@wowsp/holo", () => ({ tierToRoman: (tier: number) => String(tier) }));
vi.mock("@/i18n", () => ({ t: (key: string) => key, te: () => false }));
vi.mock("@/i18n/useLanguage", () => ({ useLanguage: () => ({ uiLocale: { value: "en" } }) }));

// ── Child components ───────────────────────────────────────────────────────
// Children below the range strip render nothing: the dashboard's contract is
// the props it hands them — ShipFilterBar's `ships` above all.
// StatsCard is a surface the range tests do not inspect, but its `actions`
// slot carries the refresh pill. That button must be mounted (not stubbed
// away with the card) for the fresh-window regression below.
vi.mock("@/components/stats/StatsCard", () => ({
  default: {
    name: "StatsCard",
    props: ["stats", "rankedWr", "rankedBattles"],
    setup(_: unknown, { slots }: { slots: { actions?: () => VNode[] } }) {
      return () => h("div", { class: "stats-card-actions" }, slots.actions?.() ?? []);
    },
  },
}));
vi.mock("@/components/stats/RankedSeasonModal", () => ({
  default: { name: "RankedSeasonModal", props: ["modelValue", "playerName"], render: () => null },
}));
// The refresh pill drives refresh() — the fresh-window regression clicks it
// after moving the clock.
vi.mock("@/components/stats/RefreshStatsButton", () => ({
  default: { name: "RefreshStatsButton", props: ["busy"], emits: ["refresh"], render: () => null },
}));
vi.mock("@/components/stats/ShipDistCharts", () => ({
  default: { name: "ShipDistCharts", props: ["ships"], render: () => null },
}));
vi.mock("@/components/account/AccountSwitcherModal", () => ({
  default: { name: "AccountSwitcherModal", props: ["modelValue"], render: () => null },
}));
vi.mock("@/components/ships/ShipFilterBar", () => ({
  default: {
    name: "ShipFilterBar",
    props: ["ships", "realm"],
    emits: ["change"],
    render: () => null,
  },
}));
vi.mock("@/components/ships/ShipDetailModal", () => ({
  default: {
    name: "ShipDetailModal",
    props: ["ship", "source", "accountId", "realm", "gameRoot"],
    render: () => null,
  },
}));
vi.mock("@/components/base/SScrollTop", () => ({
  default: { name: "SScrollTop", props: ["container"], render: () => null },
}));
vi.mock("@/components/base/ErrorCard", () => ({
  default: { name: "ErrorCard", props: ["error"], render: () => null },
}));
vi.mock("@/components/base/BattleIcon", () => ({
  default: { name: "BattleIcon", props: ["type", "variant", "size"], render: () => null },
}));
vi.mock("@/features/share/ShareShotButton", () => ({
  default: { name: "ShareShotButton", props: ["busy"], render: () => null },
}));

// ── hikari primitives ──────────────────────────────────────────────────────
// Same stubs DateRangeTabs.test.tsx / LookupView.test.tsx use: the segmented
// control keeps the real active-key guard (a click on the already-active
// segment emits nothing) and ARIA shape, the popover renders its slot, and
// the date pickers are emit-only.
vi.mock("@celestia-island/hikari", () => ({
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
                type: "button",
                role: "radio",
                "aria-checked": tb.key === props.modelValue ? "true" : "false",
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
  HkPopover: {
    name: "HkPopover",
    props: ["modelValue", "anchorRef", "placement", "title"],
    emits: ["update:modelValue"],
    setup(_: unknown, { slots }: { slots: { default?: () => VNode[] } }) {
      return () => h("div", { class: "hk-popover-panel" }, slots.default?.() ?? []);
    },
  },
  HkDatePicker: {
    name: "HkDatePicker",
    props: ["modelValue", "min", "max", "placeholder", "size"],
    emits: ["update:modelValue"],
    render: () => null,
  },
  // The kit's locale-ordered date capsule (wowsp stopped carrying the local
  // stopgap copy in 0.55.246) — the row renders nothing in these suites.
  HkDateTag: {
    name: "HkDateTag",
    props: ["value", "time"],
    render: () => null,
  },
  HkScrollContainer: {
    name: "HkScrollContainer",
    setup(_: unknown, { slots }: { slots: { default?: () => VNode[] } }) {
      return () => h("div", slots.default?.() ?? []);
    },
  },
  HkButton: {
    name: "HkButton",
    setup(_: unknown, { slots }: { slots: { default?: () => VNode[] } }) {
      return () => h("button", slots.default?.() ?? []);
    },
  },
  useToast: () => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }),
  useBreakpoint: () => ({ isMobile: { value: false } }),
}));

// The component and the window helper are imported AFTER the mock block on
// purpose: DashboardView's module graph must resolve against the stubs above.
import DashboardView from "./DashboardView";
import { isoDayWindowSec } from "@/utils/shipAggregation";

enableAutoUnmount(afterEach);

/** Mount the view with `ships` seeded as the active account's career rows.
 *  Two flushes: the mount watcher's refresh() chain is microtask-only, and the
 *  second pass settles the range watcher it arms before a test clicks. */
async function mountDashboard(ships: PlayerShipStats[] = []) {
  (mocks.stores.shipStats as { cache: Map<string, PlayerShipStats[]> }).cache = new Map([
    [ACCOUNT_KEY, ships],
  ]);
  const view = mount(DashboardView);
  await flushPromises();
  await flushPromises();
  return view;
}

type DashboardMount = Awaited<ReturnType<typeof mountDashboard>>;

/** The per-ship rows the view currently hands to ShipFilterBar — the list the
 *  page renders. Reading the prop (rather than the table markup) keeps the
 *  assertion on the filtering decision, not on a child's rendering. */
function barShips(view: DashboardMount): PlayerShipStats[] {
  return view.findComponent({ name: "ShipFilterBar" }).props("ships") as PlayerShipStats[];
}

/** Click one range segment by its label (t() is mocked to the key). */
async function clickSegment(view: DashboardMount, label: string): Promise<void> {
  const segment = view.findAll('[role="radio"]').find((r) => r.text() === label);
  if (!segment) throw new Error(`no range segment labelled ${label}`);
  await segment.trigger("click");
  await flushPromises();
}

/** Switch to 自定义, then emit a day on each picker (from, then to). */
async function pickCustomWindow(
  view: DashboardMount,
  fromIso: string,
  toIso: string,
): Promise<void> {
  await clickSegment(view, "dashboard.rangeCustom");
  const pickers = view.findAllComponents({ name: "HkDatePicker" });
  expect(pickers).toHaveLength(2);
  await pickers[0].vm.$emit("update:modelValue", fromIso);
  await flushPromises();
  await pickers[1].vm.$emit("update:modelValue", toIso);
  await flushPromises();
}

beforeEach(() => {
  vi.resetAllMocks();

  // The localBattles stub is deliberately inert: no replay log is adopted and
  // nothing is fetched, which is exactly the "no replay source" fixture the
  // career-fallback cases need. The spy still records what the view asked for.
  mocks.load.mockResolvedValue({ battles: [], pending: 0, sinceTs: 0, endTs: 0 });

  mocks.stores.account = reactive({ activeAccount: ACCOUNT });
  mocks.stores.stats = reactive({
    cache: new Map([[ACCOUNT_KEY, PLAYER_STATS]]),
    loadCached: vi.fn().mockResolvedValue(undefined),
    lookup: vi.fn().mockResolvedValue(PLAYER_STATS),
    error: null,
  });
  mocks.stores.shipStats = reactive({
    cache: new Map<string, PlayerShipStats[]>(),
    // No snapshot history → computeRecentDelta yields null, forcing the
    // labeled career fallback instead of a real window delta.
    history: new Map(),
    load: vi.fn().mockResolvedValue(undefined),
  });
  mocks.stores.localBattles = {
    load: mocks.load,
    windowFor: () => null,
    logFor: () => null,
  };
  mocks.stores.encyclopedia = reactive({
    byId: new Map(),
    load: vi.fn().mockResolvedValue(undefined),
  });
  mocks.stores.trends = reactive({ loadPlayer: vi.fn().mockResolvedValue(undefined) });
  mocks.stores.ranked = reactive({
    load: vi.fn().mockResolvedValue(undefined),
    winrate: null,
    battles: null,
  });
  mocks.stores.loadingTasks = reactive({ begin: vi.fn(() => 1), end: vi.fn() });
  mocks.stores.statsPrefs = reactive({ prefs: { prEnabled: true, sealsEnabled: false } });
});

describe("DashboardView custom date range", () => {
  it("renders the shared range strip with 自定义 as the last segment", async () => {
    const now = Math.floor(Date.now() / 1000);
    const view = await mountDashboard([ship(1, now)]);

    expect(view.findComponent({ name: "DateRangeTabs" }).exists()).toBe(true);
    const segments = view.findAll('[role="radio"]').map((r) => r.text());
    expect(segments).toEqual([
      "dashboard.range1d",
      "dashboard.range7d",
      "dashboard.range30d",
      "dashboard.rangeAll",
      "dashboard.rangeCustom",
    ]);
    // The host appends 自定义 to the shared presets — it is the LAST radio,
    // which is also the only segment whose click opens the picker popover.
    expect(segments[segments.length - 1]).toBe("dashboard.rangeCustom");
  });

  it("leaves the ship list unfiltered until both days are picked", async () => {
    const { window } = pickedWindow();
    const ships = [ship(1, window.fromSec + DAY), ship(2, window.fromSec - DAY)];
    const view = await mountDashboard(ships);
    expect(barShips(view)).toHaveLength(2);

    await clickSegment(view, "dashboard.rangeCustom");
    // A selected segment is not a window: no days picked, no filtering.
    expect(barShips(view)).toHaveLength(2);

    // A half-picked pair reports null (DateRangeTabs's contract), so the list
    // must not shrink to the single ship dated inside the would-be window.
    const pickers = view.findAllComponents({ name: "HkDatePicker" });
    await pickers[0].vm.$emit("update:modelValue", isoDaysAgo(-12));
    await flushPromises();
    expect(barShips(view)).toHaveLength(2);
  });

  it("keeps only the ships last played inside the picked window (career fallback)", async () => {
    const { fromIso, toIso, window } = pickedWindow();
    // Both window bounds are inclusive, so the rows exactly ON each bound must
    // survive; one second outside on either side must not.
    const ships = [
      ship(1, window.fromSec + DAY),
      ship(2, window.fromSec),
      ship(3, window.toSec),
      ship(4, window.fromSec - 1),
      ship(5, window.toSec + 1),
    ];
    const view = await mountDashboard(ships);
    expect(barShips(view)).toHaveLength(5);

    await pickCustomWindow(view, fromIso, toIso);

    // No per-ship history and no replay log in this fixture, so the view takes
    // the labeled career fallback: filterByDateWindow over lastBattleTime.
    expect(barShips(view).map((s) => s.shipId)).toEqual([1, 2, 3]);
  });

  it("restores the full career list when the strip flips back to All", async () => {
    const { fromIso, toIso, window } = pickedWindow();
    const ships = [ship(1, window.fromSec), ship(2, window.toSec + DAY)];
    const view = await mountDashboard(ships);

    await pickCustomWindow(view, fromIso, toIso);
    expect(barShips(view).map((s) => s.shipId)).toEqual([1]);

    await clickSegment(view, "dashboard.rangeAll");
    // All ignores the retained picker window — the career rows are back in
    // their original order.
    expect(barShips(view).map((s) => s.shipId)).toEqual([1, 2]);
  });

  it("asks localBattles for exactly the picked window and never on the All tab", async () => {
    const { fromIso, toIso, window } = pickedWindow();
    const view = await mountDashboard([ship(1, window.fromSec)]);

    // All is answered from the career rows already loaded on mount — the
    // replay log is never requested for an unbounded "all-time" range.
    expect(mocks.load).not.toHaveBeenCalled();

    await pickCustomWindow(view, fromIso, toIso);
    // One request, for precisely the window the pickers reported: the store
    // must receive [fromSec, toSec], not a preset or a career-wide span.
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
      ACCOUNT.accountId,
      ACCOUNT.realm,
      window.fromSec,
      window.toSec,
      { force: false },
    );

    // Flipping back to All adds no request, and every request ever made was
    // the picked window — there is no "all" load.
    await clickSegment(view, "dashboard.rangeAll");
    expect(mocks.load).toHaveBeenCalledTimes(1);
    for (const call of mocks.load.mock.calls) {
      expect(call.slice(2, 4)).toEqual([window.fromSec, window.toSec]);
    }
  });

  it("recomputes the preset window from a moved clock on refresh", async () => {
    // A fixed clock base makes the expected windows exact: the regression was
    // about WHICH clock reading a repeated load uses, so this test drives that
    // reading instead of trusting the wall clock between two statements.
    const base = 1_790_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base * 1000);
    try {
      // Select the 7D preset with a seeded career row so the range path is
      // live — the tab click is what arms the replay source.
      const view = await mountDashboard([ship(1, base)]);
      await clickSegment(view, "dashboard.range7d");

      // Selecting the tab loads the preset window ending "now".
      expect(mocks.load).toHaveBeenCalledTimes(1);
      const first = mocks.load.mock.calls[0];
      expect(first[2]).toBe(base - 7 * DAY);
      expect(first[3]).toBe(base);
      expect(first[4]).toEqual({ force: false });

      // An hour of battles happens, then the refresh pill is clicked. The pill
      // calls refresh(true); its phase 4 re-reads the clock through
      // currentWindow(), where a cached computed would still answer `base`.
      nowSpy.mockReturnValue((base + 3_600) * 1000);
      await view.findComponent({ name: "RefreshStatsButton" }).vm.$emit("refresh");
      await flushPromises();
      await flushPromises();

      expect(mocks.load).toHaveBeenCalledTimes(2);
      const last = mocks.load.mock.calls[mocks.load.mock.calls.length - 1];
      // Recomputed, not reused: the window END tracked the moved clock and the
      // start stayed exactly one 7-day span behind it.
      expect(last[2]).toBe(base + 3_600 - 7 * DAY);
      expect(last[3]).toBe(base + 3_600);
      // The pill forces a re-scan (bypassing the store's window cache).
      expect(last[4]).toEqual({ force: true });
      // ...and the two windows genuinely differ: a cached object would make
      // the second request identical to the first.
      expect(first[3]).not.toBe(last[3]);
      expect(first[2]).not.toBe(last[2]);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
