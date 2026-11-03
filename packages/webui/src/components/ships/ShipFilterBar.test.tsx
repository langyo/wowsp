/**
 * Tests for the chip-based ShipFilterBar interaction model (mixed
 *  multi/single select + the tier corridor slider):
 *  - six collapsed chips default to the inert all state — the three PURE
 *    facets (type/nation/mode) render hikari HkFilterChip triggers, the
 *    sort categories keep the bespoke grayed 全部… chip; with nothing
 *    engaged the view keeps the historical battles-desc order;
 *  - the popup hosts the category's control: type/nation/mode are
 *    HkFilterChip pill groups (multi-select, picks OR within the
 *    category, the leading all-pill clears the facet), winrate/battles
 *    hold a SINGLE pick (a new bracket replaces the old one), and tier
 *    hosts the shared TierRangeSelect dual-thumb slider — the
 *    keyboard-driven tests below narrow its corridor through the
 *    teleported popup. Re-clicking a picked option (or the tier flip
 *    toggle) flips the sort categories' SHARED 正序/倒序 flag, and 全部…
 *    resets the category when a selection exists;
 *  - 全部… runs the all-state sort through a THREE-click cycle on the
 *    sort categories while nothing is picked: engage in the canonical
 *    direction (--sort style), flip, switch off entirely (the chip
 *    returns to the gray state) — and the direction arrow renders only
 *    while a sort is actually engaged;
 *  - concrete ship types and nations are pure filters: no arrows
 *    anywhere, re-clicking one deselects it, and the migrated facet's
 *    all-pill only clears (the pure 全部…-sort cycle retired with the
 *    HkFilterChip migration);
 *  - division modes (组队模式) filter on the per-ship mode breakdown the
 *    same pure multi-select way: every pill — 单人/双人/三人/排位
 *    — keeps ships with battles > 0 in its bucket, picks OR together, and
 *    rows with NO breakdown (modes null) match nothing — they drop out
 *    while any mode pill is picked and return when the facet clears; the
 *    chip label mirrors the picks in canonical option order capped at
 *    three + "+N";
 *  - nations are data-derived: only canonical nations PRESENT in the
 *    queried list get pills (offline-DB spellings normalize onto the
 *    canonical codes), and event/rental ships with no canonical nation
 *    pass only while the selection is empty;
 *  - every other category's option group is RESIDENT: it never shrinks
 *    with the queried data, so a pick with no matches in the current range
 *    keeps its popup entry, chip label and re-click deselect (an empty
 *    result is the hosting view's business);
 *  - the multi-key sort priority is the FIXED canonical chip order: the
 *    earlier sorting category is the primary key, the next breaks ties;
 *  - the v4/v5 storage migrates to v6 carrying only the selections (the
 *    drag order is dead state, tier bracket pills fold into the slider
 *    corridor), the legacy key swept and the v6 blob written back;
 *  - stale multi-select storage of the now-single categories is clamped
 *    to one pick on load;
 *  - selections survive an unmount/remount cycle;
 *  - the nation facet's pills ride hikari HkPillToggleGroup's own
 *    one-line pannable strip with the facet hint line (the bespoke
 *    scroll container and its gesture hint retired with the migration;
 *    plain clicks still select), and the extracted pan helpers (wheel
 *    delta normalizer, 5px pan threshold) hold their contracts.
 *
 * The popups render through hikari HkPopover: the bespoke panels teleport
 * to document.body as .ship-filter-bar__pop, the migrated pure facets'
 * pill groups land in the same overlay root (.hk-popover-panel carrying
 * HkFilterChip's .hk-filter-chip-body > .hk-pill-group) — all body-scoped
 * queries, and each open/close is polled to let the popover machine's
 * timer-driven enter/leave settle.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createPinia } from "pinia";
import { DOMWrapper, enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import { fakeAs } from "@/test-utils/fakes";

import ShipFilterBar, { type FilterState } from "./ShipFilterBar";
import { panEngaged, stripWheelDelta } from "./optionStrip";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { resetAppliedDpiScaleForTest } from "@/theme/dpiPrefs";
import type { PlayerShipStats, ShipInfo, ShipModeBreakdown, ShipModeStats } from "@/api";

const PERSIST_KEY = "wowsp.shipFilter.v6";
const LEGACY_PERSIST_KEY = "wowsp.shipFilter.v5";
const V4_PERSIST_KEY = "wowsp.shipFilter.v4";

// A popover left open by one test must not leak into the next test's
// body-level queries — unmount every wrapper after each test.
enableAutoUnmount(afterEach);

function ship(partial: Partial<PlayerShipStats> & { shipId: number }): PlayerShipStats {
  return {
    name: `Ship ${partial.shipId}`,
    battles: 10,
    wins: 5,
    damageCaused: 500,
    frags: 1,
    survivedBattles: 3,
    winrate: 50,
    avgDamage: 50,
    lastBattleTime: 0,
    ...partial,
  };
}

// Data chosen to expose each mechanism:
//   ids 1 and 2 tie on battles (100) so a secondary key decides them;
//   id 3 (70 battles, 58%, T6) passes the ≥30 and 50–60% and VI–VII picks;
//   id 4 (10 battles, 40%, T10 DD) is excluded by the ≥30 pick;
//   id 5 sits in the ≥60% winrate bracket at T10.
const SHIPS: PlayerShipStats[] = [
  ship({ shipId: 1, battles: 100, winrate: 55, avgDamage: 30 }),
  ship({ shipId: 2, battles: 100, winrate: 52, avgDamage: 20 }),
  ship({ shipId: 3, battles: 70, winrate: 58, avgDamage: 90 }),
  ship({ shipId: 4, battles: 10, winrate: 40, avgDamage: 50 }),
  ship({ shipId: 5, battles: 50, winrate: 65, avgDamage: 45 }),
];

/** Encyclopedia metadata so the type/tier popups get real options. */
const META = [
  { shipId: 1, name: "Ship 1", tier: 8, type: "Battleship", nation: "japan" },
  { shipId: 2, name: "Ship 2", tier: 9, type: "Battleship", nation: "usa" },
  { shipId: 3, name: "Ship 3", tier: 6, type: "Cruiser", nation: "ussr" },
  { shipId: 4, name: "Ship 4", tier: 10, type: "Destroyer", nation: "germany" },
  { shipId: 5, name: "Ship 5", tier: 10, type: "Cruiser", nation: "uk" },
].map((m) => fakeAs<ShipInfo>(m));

// Mode-breakdown helpers — every ShipModeStats field besides battles is
// noise for the matching predicates, so the buckets carry zeros.
function modeBucket(battles: number): ShipModeStats {
  return {
    battles,
    wins: 0,
    damageCaused: 0,
    frags: 0,
    survivedBattles: 0,
    winrate: 0,
    avgDamage: 0,
  };
}
function modeBreakdown(solo: number, div2: number, div3: number, ranked = 0): ShipModeBreakdown {
  return {
    solo: modeBucket(solo),
    div2: modeBucket(div2),
    div3: modeBucket(div3),
    coop: null,
    ranked: ranked > 0 ? modeBucket(ranked) : null,
  };
}

// Mode test fleet: id 1 solo-only play; id 2 mixes solo and div2; id 3 is
// trio-ONLY (no solo battles at all — it must drop from 单人); id 4 mixes
// ranked into solo play; id 5 carries NO breakdown at all (realms that
// don't serve battle-type splits) — it must vanish under any mode pick and
// return when the category resets.
const MODE_SHIPS: PlayerShipStats[] = [
  ship({ shipId: 1, battles: 90, modes: modeBreakdown(90, 0, 0) }),
  ship({ shipId: 2, battles: 100, modes: modeBreakdown(40, 60, 0) }),
  ship({ shipId: 3, battles: 70, modes: modeBreakdown(0, 0, 60) }),
  ship({ shipId: 4, battles: 40, modes: modeBreakdown(30, 0, 0, 10) }),
  ship({ shipId: 5, battles: 50, modes: null }),
];

function mountBar(ships: PlayerShipStats[] = SHIPS, meta: ShipInfo[] = META) {
  const pinia = createPinia();
  useEncyclopediaStore(pinia).ships = meta;
  return mount(ShipFilterBar, {
    props: { ships, realm: "" },
    global: { plugins: [pinia] },
  });
}

const lastState = (wrapper: ReturnType<typeof mountBar>): FilterState => {
  const calls = wrapper.emitted("change") ?? [];
  // `emitted()` is `unknown[][]` — the emit signature is known here, so one
  // asserted read (pinned by every assertion that consumes the state).
  const [state] = calls[calls.length - 1] as [FilterState];
  return state;
};
const order = (wrapper: ReturnType<typeof mountBar>) =>
  lastState(wrapper).ships.map((s) => s.shipId);
const chip = (wrapper: ReturnType<typeof mountBar>, key: string) =>
  wrapper.find(`[data-chip="${key}"]`);

describe("ShipFilterBar chip indent", () => {
  it("measures the bar offset in the root zoom's local space", async () => {
    // 125% interface scale: the rect difference answers in visual px while
    // the consumed --sfb-indent (a CSS length inside the zoomed subtree)
    // and the computed paddings are local — unconverted, a zoomed root
    // over-measured the offset by (scale − 1) of itself.
    document.documentElement.dataset.dpiScale = "125";
    resetAppliedDpiScaleForTest();
    // The bar (the chips row) sits 30 visual px from the viewport's left,
    // its host row at 10 → a 20 visual px offset; computed paddings are 0
    // in happy-dom.
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const left = this.classList.contains("ship-filter-bar") ? 30 : 10;
        return {
          left,
          right: left + 200,
          top: 0,
          bottom: 20,
          width: 200,
          height: 20,
          x: left,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });
    try {
      const wrapper = mountBar();
      // The onMounted measure lands after the mount tick.
      await flushPromises();
      // 20 visual ÷ 1.25 → 16 local, floored.
      expect(wrapper.attributes("style")).toContain("--sfb-indent: 16px");
    } finally {
      spy.mockRestore();
      delete document.documentElement.dataset.dpiScale;
      document.documentElement.style.removeProperty("zoom");
      resetAppliedDpiScaleForTest();
    }
  });
});
/** Popup options follow the category's option order: index 0 is 全部…. The
 *  popups teleport to body (HkPopover), so they are queried there. */
const bodyPops = () => [
  ...document.body.querySelectorAll<HTMLElement>(".ship-filter-bar__pop"),
];
const popOpts = (): DOMWrapper<HTMLElement>[] =>
  [
    ...document.body.querySelectorAll<HTMLElement>(
      ".ship-filter-bar__pop .ship-filter-bar__opt",
    ),
  ].map((el) => new DOMWrapper(el));
const activeOpts = (): DOMWrapper<HTMLElement>[] =>
  [...document.body.querySelectorAll<HTMLElement>(".ship-filter-bar__opt[data-active]")].map(
    (el) => new DOMWrapper(el),
  );

/** The migrated pure facets render hikari HkFilterChip: the chip trigger
 *  (.hk-filter-chip — aria-expanded, the --on picked tint) sits inside the
 *  [data-chip] anchor div, and its pill group teleports to the overlay root
 *  (body scope) as a .hk-popover-panel body — pills carry aria-pressed and
 *  the data-active tint, pill[0] is the all-pill. */
const hkChip = (wrapper: ReturnType<typeof mountBar>, key: string) =>
  wrapper.find(`[data-chip="${key}"] .hk-filter-chip`);
const hkPillGroups = () => [
  ...document.body.querySelectorAll<HTMLElement>(".hk-popover-panel .hk-pill-group"),
];
const hkPills = (): DOMWrapper<HTMLElement>[] =>
  [
    ...document.body.querySelectorAll<HTMLElement>(
      ".hk-popover-panel .hk-pill-group .hk-pill-group-pill",
    ),
  ].map((el) => new DOMWrapper(el));
const activeHkPills = (): DOMWrapper<HTMLElement>[] =>
  [
    ...document.body.querySelectorAll<HTMLElement>(
      ".hk-popover-panel .hk-pill-group .hk-pill-group-pill[data-active]",
    ),
  ].map((el) => new DOMWrapper(el));

/** Poll until exactly `count` HkFilterChip pill groups stand mounted in
 *  body — the same settle-the-machine dance as waitPops (the migrated
 *  facets' popovers run the identical HkPopover enter/leave timers). */
async function waitHkPops(count: number) {
  await flushPromises();
  for (let i = 0; i < 100 && hkPillGroups().length !== count; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(hkPillGroups().length).toBe(count);
}

/** Poll until exactly `count` popovers stand mounted in body — 1 means the
 *  opened panel is in AND any earlier panel has fully retired (the switch
 *  overlap would otherwise pollute the option queries). */
async function waitPops(count: number) {
  await flushPromises();
  for (let i = 0; i < 100 && bodyPops().length !== count; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(bodyPops().length).toBe(count);
}

describe("ShipFilterBar chips", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders six collapsed chips defaulting to the inert all state", async () => {
    const wrapper = mountBar();
    await flushPromises();

    // The pure facets are hikari HkFilterChip triggers: closed, carrying
    // the caret only — no picked tint, no direction arrow anywhere.
    for (const key of ["type", "nation", "mode"]) {
      const c = hkChip(wrapper, key);
      expect(c.classes()).toContain("hk-filter-chip");
      expect(c.classes()).not.toContain("hk-filter-chip--on");
      expect(c.attributes("aria-haspopup")).toBe("dialog");
      expect(c.attributes("aria-expanded")).toBe("false");
      expect(c.find(".hk-filter-chip-caret").exists()).toBe(true);
      expect(c.find(".ship-filter-bar__dir").exists()).toBe(false);
      expect(c.find(".lucide-arrow-down").exists()).toBe(false);
    }
    // The sort categories keep the bespoke chips in the gray 全部… state.
    for (const key of ["tier", "winrate", "battles"]) {
      expect(chip(wrapper, key).classes()).toContain("ship-filter-bar__chip--all");
      expect(chip(wrapper, key).find(".ship-filter-bar__dir").exists()).toBe(false);
    }
    // Defaults keep the historical view: battles descending, stable ties.
    expect(order(wrapper)).toEqual([1, 2, 3, 5, 4]);
  });

  it("single-selects winrate brackets, flips direction on re-pick, resets on 全部", async () => {
    const wrapper = mountBar();
    await flushPromises();

    // Open the winrate popup and pick the 50–60% bracket (option 3).
    await chip(wrapper, "winrate").trigger("click");
    await waitPops(1);
    await popOpts()[3]!.trigger("click");
    await flushPromises();

    // Chip turns active; filter applied; descending → higher winrate first.
    expect(chip(wrapper, "winrate").classes()).toContain("ship-filter-bar__chip--on");
    expect(order(wrapper)).toEqual([3, 1, 2]);

    // Re-click the 50–60% option → the SHARED flag flips to ascending.
    await popOpts()[3]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([2, 1, 3]);

    // Picking ≥60% REPLACES the bracket instead of OR-ing with it.
    await popOpts()[4]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([5]);
    expect(activeOpts().length).toBe(1);
    // The single pick keeps the category's (flipped) ascending arrow.
    expect(activeOpts()[0]!.find(".lucide-arrow-up").exists()).toBe(true);

    // 全部胜率 (option 0) resets the chip to the gray state.
    await popOpts()[0]!.trigger("click");
    await flushPromises();
    expect(chip(wrapper, "winrate").classes()).toContain("ship-filter-bar__chip--all");
    expect(order(wrapper)).toEqual([1, 2, 3, 5, 4]);
    expect(activeOpts().length).toBe(1); // only 全部胜率 itself
  });

  it("cycles the 全部… sort through engage → flip → off in three clicks", async () => {
    const wrapper = mountBar();
    await flushPromises();

    await chip(wrapper, "winrate").trigger("click");
    await waitPops(1);
    // Nothing engaged yet: the 全部胜率 pill carries no direction arrow.
    expect(popOpts()[0]!.find(".ship-filter-bar__dir").exists()).toBe(false);

    // First click engages in the canonical (descending) direction while the
    // chip keeps filtering nothing — the intermediate --sort style.
    await popOpts()[0]!.trigger("click");
    await flushPromises();
    expect(chip(wrapper, "winrate").classes()).toContain("ship-filter-bar__chip--sort");
    expect(chip(wrapper, "winrate").find(".lucide-arrow-down").exists()).toBe(true);
    expect(order(wrapper)).toEqual([5, 3, 1, 2, 4]);

    // Second click flips the direction.
    await popOpts()[0]!.trigger("click");
    await flushPromises();
    expect(chip(wrapper, "winrate").find(".lucide-arrow-up").exists()).toBe(true);
    expect(order(wrapper)).toEqual([4, 2, 1, 3, 5]);

    // Third click switches the sort OFF entirely: the chip returns to the
    // gray state, drops its arrow and the historical battles-desc order.
    await popOpts()[0]!.trigger("click");
    await flushPromises();
    expect(chip(wrapper, "winrate").classes()).toContain("ship-filter-bar__chip--all");
    expect(chip(wrapper, "winrate").find(".ship-filter-bar__dir").exists()).toBe(false);
    expect(order(wrapper)).toEqual([1, 2, 3, 5, 4]);

    // The cycle re-arms from the canonical direction, not the flipped one.
    await popOpts()[0]!.trigger("click");
    await flushPromises();
    expect(chip(wrapper, "winrate").find(".lucide-arrow-down").exists()).toBe(true);
    expect(order(wrapper)).toEqual([5, 3, 1, 2, 4]);

    // A concrete pick keeps the direction (descending, freshly re-engaged)
    // and adds the filter on top.
    await popOpts()[3]!.trigger("click"); // 50–60%
    await flushPromises();
    expect(chip(wrapper, "winrate").classes()).toContain("ship-filter-bar__chip--on");
    expect(order(wrapper)).toEqual([3, 1, 2]);

    // 全部胜率 with a selection resets the category completely — the
    // all-state sort goes off with the filter.
    await popOpts()[0]!.trigger("click");
    await flushPromises();
    expect(chip(wrapper, "winrate").classes()).toContain("ship-filter-bar__chip--all");
    expect(order(wrapper)).toEqual([1, 2, 3, 5, 4]);
  });

  /** The tier popup's slider rides the teleported panel (body-level). */
  const bodyEl = (sel: string) =>
    new DOMWrapper(document.body.querySelector(sel) as HTMLElement);
  const tierThumb = (which: "lo" | "hi") =>
    bodyEl(`.ship-filter-bar__pop .range-slider__thumb[data-thumb="${which}"]`);

  it("renders the tier popup as the corridor slider with the ★ tick rail", async () => {
    const wrapper = mountBar();
    await flushPromises();

    await chip(wrapper, "tier").trigger("click");
    await waitPops(1);

    // The shared slider mounts inside the popup: 11 stops, the supership
    // star on the right end, roman numerals elsewhere.
    expect(document.body.querySelector(".ship-filter-bar__pop .tier-range")).not.toBeNull();
    expect(
      document.body.querySelectorAll(".ship-filter-bar__pop .range-slider__label").length,
    ).toBe(11);
    expect(bodyEl(".ship-filter-bar__pop .tier-range__star").text()).toBe("★");
    const labels = [...document.body.querySelectorAll(".ship-filter-bar__pop .range-slider__label")];
    expect(labels[0]!.textContent).toBe("I");
    expect(labels[9]!.textContent).toBe("X");
    // No option pills in the tier popup — only the 全部… action row.
    expect(
      document.body.querySelectorAll(".ship-filter-bar__pop .ship-filter-bar__opt").length,
    ).toBe(1);
    // Idle full range: no flip toggle while the category does not sort.
    expect(document.body.querySelector("[data-tier-flip]")).toBeNull();
  });

  it("filters a tier corridor through the slider and flips its sort", async () => {
    const wrapper = mountBar();
    await flushPromises();

    await chip(wrapper, "tier").trigger("click");
    await waitPops(1);

    // Walk the lo thumb five steps → corridor [6, 11] ("VI – ★").
    for (let i = 0; i < 5; i += 1) {
      await tierThumb("lo").trigger("keydown", { key: "ArrowRight" });
    }
    await flushPromises();

    // Chip wears the corridor as its label and turns active.
    expect(chip(wrapper, "tier").classes()).toContain("ship-filter-bar__chip--on");
    expect(chip(wrapper, "tier").text()).toContain("VI");
    expect(chip(wrapper, "tier").text()).toContain("★");
    // All five ships sit in tiers 6..10 — the corridor sorts tier desc:
    // T10 T10 T9 T8 T6 (battles desc breaks the T10 tie).
    expect(order(wrapper)).toEqual([5, 4, 2, 1, 3]);
    // The narrowed corridor engages the category's sort → chip arrow and
    // the popup's flip toggle appear.
    expect(chip(wrapper, "tier").find(".lucide-arrow-down").exists()).toBe(true);
    expect(document.body.querySelector("[data-tier-flip]")).not.toBeNull();

    // Flip the shared direction via the toggle.
    await bodyEl("[data-tier-flip]").trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([3, 1, 2, 5, 4]); // tier asc; battles desc breaks the T10 tie

    // 全部等级 resets the whole category — gray chip, historical order.
    await bodyEl("[data-tier-all]").trigger("click");
    await flushPromises();
    expect(chip(wrapper, "tier").classes()).toContain("ship-filter-bar__chip--all");
    expect(chip(wrapper, "tier").text()).not.toContain("VI");
    expect(order(wrapper)).toEqual([1, 2, 3, 5, 4]);
  });

  it("runs the tier 全部… sort through the same three-click cycle", async () => {
    const wrapper = mountBar();
    await flushPromises();

    await chip(wrapper, "tier").trigger("click");
    await waitPops(1);

    // Engage in the canonical direction (tier desc) from the idle state.
    await bodyEl("[data-tier-all]").trigger("click");
    await flushPromises();
    expect(chip(wrapper, "tier").classes()).toContain("ship-filter-bar__chip--sort");
    expect(chip(wrapper, "tier").find(".lucide-arrow-down").exists()).toBe(true);
    expect(order(wrapper)).toEqual([5, 4, 2, 1, 3]);

    // Second click flips; third switches the sort off entirely.
    await bodyEl("[data-tier-all]").trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([3, 1, 2, 5, 4]);
    await bodyEl("[data-tier-all]").trigger("click");
    await flushPromises();
    expect(chip(wrapper, "tier").classes()).toContain("ship-filter-bar__chip--all");
    expect(order(wrapper)).toEqual([1, 2, 3, 5, 4]);
  });

  it("keeps a tier corridor across an unmount/remount cycle", async () => {
    const first = mountBar();
    await flushPromises();
    await chip(first, "tier").trigger("click");
    await waitPops(1);
    // Walk the hi thumb three steps left → corridor [1, 8].
    for (let i = 0; i < 3; i += 1) {
      await tierThumb("hi").trigger("keydown", { key: "ArrowLeft" });
    }
    await flushPromises();
    // Tiers ≤ 8: the T8 and T6 ships, tier desc.
    expect(order(first)).toEqual([1, 3]);
    first.unmount();

    const second = mountBar();
    await flushPromises();
    expect(chip(second, "tier").classes()).toContain("ship-filter-bar__chip--on");
    expect(order(second)).toEqual([1, 3]);
    second.unmount();
  });

  it("keeps ship types pure filters: no arrows, re-click deselects, the all-pill clears", async () => {
    const wrapper = mountBar();
    await flushPromises();

    await hkChip(wrapper, "type").trigger("click");
    await waitHkPops(1);
    // Pill order: the all-pill first, then the full resident type list —
    // independent of the data.
    expect(hkPills().length).toBe(6);
    await hkPills()[1]!.trigger("click"); // Battleship
    await flushPromises();

    expect(hkChip(wrapper, "type").classes()).toContain("hk-filter-chip--on");
    expect(order(wrapper)).toEqual([1, 2]); // filtered, battles-desc within
    // No direction anywhere: not on the chip, not on the picked pill — and
    // the pill reports itself pressed like a proper toggle set.
    expect(hkChip(wrapper, "type").find(".ship-filter-bar__dir").exists()).toBe(false);
    expect(hkChip(wrapper, "type").find(".lucide-arrow-down").exists()).toBe(false);
    expect(hkPills()[1]!.attributes("aria-pressed")).toBe("true");

    // Re-clicking a type deselects it instead of flipping a direction.
    await hkPills()[1]!.trigger("click");
    await flushPromises();
    expect(hkChip(wrapper, "type").classes()).not.toContain("hk-filter-chip--on");
    expect(order(wrapper)).toEqual([1, 2, 3, 5, 4]);

    // The all-pill clears outright — the bespoke 全部… three-click all-sort
    // cycle retired with the migration (a pure category only ever filters).
    await hkPills()[0]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([1, 2, 3, 5, 4]);
    expect(activeHkPills().map((o) => o.text())).toEqual(["All types"]);
  });

  it("filters by nation (multi-select) with offline spellings normalized", async () => {
    // The offline DB spells nations differently (russia / united_kingdom /
    // events); the options and the predicate both fold onto the canonical
    // codes. Id 6 is an event curio with NO canonical nation.
    const meta = META.map((m) =>
      m.shipId === 3 ? { ...m, nation: "russia" } : m.shipId === 5 ? { ...m, nation: "united_kingdom" } : m,
    ) as ShipInfo[];
    const ships = [...SHIPS, ship({ shipId: 6, battles: 5, winrate: 50, avgDamage: 10 })];
    const wrapper = mountBar(ships, meta);
    await flushPromises();

    await hkChip(wrapper, "nation").trigger("click");
    await waitHkPops(1);
    // Pills: the all-pill + the five canonical nations PRESENT in the data,
    // in tech-tree order (japan, usa, ussr, germany, uk) — the offline
    // spellings normalized, "events" gets no pill of its own.
    expect(hkPills().length).toBe(6);
    // Concrete pills lead with the flag badge (letter fallback in the
    // test env — the wrapper span is what matters).
    expect(hkPills()[1]!.find(".nation-flag").exists()).toBe(true);

    // Japan (id 1) — pure filter, no direction arrow anywhere.
    await hkPills()[1]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([1]);
    expect(hkChip(wrapper, "nation").find(".ship-filter-bar__dir").exists()).toBe(false);
    expect(hkChip(wrapper, "nation").classes()).toContain("hk-filter-chip--on");

    // Multi-select ORs: + germany (id 4, the 10-battle DD).
    await hkPills()[4]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([1, 4]);

    // Re-clicking a picked nation deselects it (pure filter, like types).
    await hkPills()[1]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([4]);

    // The all-pill resets the set — every ship returns, the event curio
    // included (it passes only while the selection is empty).
    await hkPills()[0]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([1, 2, 3, 5, 4, 6]);
    expect(hkChip(wrapper, "nation").classes()).not.toContain("hk-filter-chip--on");
  });

  it("derives the nation options from the queried data only", async () => {
    // Half the fleet: only japan/usa/germany remain — the popup never
    // offers nations with no ships in range.
    const ships = SHIPS.filter((s) => [1, 2, 4].includes(s.shipId));
    const wrapper = mountBar(ships, META);
    await flushPromises();

    await hkChip(wrapper, "nation").trigger("click");
    await waitHkPops(1);
    expect(hkPills().length).toBe(4); // all + japan + usa + germany
  });

  it("keeps a stale data-derived nation pick visible and deselectable", async () => {
    // Pick japan, then narrow the queried data until japan has no ships —
    // the nation options are data-derived, so the pick goes stale. It must
    // NOT silently filter behind an all-labelled chip: the chip keeps
    // mirroring the resolved label and an appended pressed pill carries
    // the deselect (the type facet's options are resident, so only nations
    // can go stale).
    const wrapper = mountBar();
    await flushPromises();

    await hkChip(wrapper, "nation").trigger("click");
    await waitHkPops(1);
    await hkPills()[1]!.trigger("click"); // japan
    await flushPromises();
    expect(hkChip(wrapper, "nation").classes()).toContain("hk-filter-chip--on");

    // The data slice loses japan (ship 1 was its only ship).
    await wrapper.setProps({ ships: SHIPS.filter((s) => s.shipId !== 1) });
    await flushPromises();

    // The chip still names the pick and the popup still offers it —
    // appended after the concrete pills, wearing the pressed tint.
    expect(hkChip(wrapper, "nation").text()).toContain("Japan");
    const pillsNow = hkPills();
    const stale = pillsNow[pillsNow.length - 1]!;
    expect(stale.attributes("aria-pressed")).toBe("true");

    // The stale pill deselects like any other.
    await stale.trigger("click");
    await flushPromises();
    expect(hkChip(wrapper, "nation").classes()).not.toContain("hk-filter-chip--on");
  });

  it("keeps every type option resident when the queried data lacks the type", async () => {
    // 1-day-range reproduction: no destroyer was played in the range while
    // the selection still asks for one — the popup must not lose the
    // Destroyer option and the empty result must stay recoverable in place.
    const wrapper = mountBar(SHIPS.filter((s) => s.shipId !== 4));
    await flushPromises();

    await hkChip(wrapper, "type").trigger("click");
    await waitHkPops(1);
    // All five concrete types remain listed (plus the all-pill), Destroyer
    // included, even though the data holds no destroyer.
    expect(hkPills().length).toBe(6);

    await hkPills()[4]!.trigger("click"); // Destroyer
    await flushPromises();
    // The filter applies normally and yields the empty result…
    expect(lastState(wrapper).ships).toEqual([]);
    expect(hkChip(wrapper, "type").classes()).toContain("hk-filter-chip--on");
    // …while the chip keeps its label and the pick stays active and
    // re-clickable in the popup (no degradation, no dead state).
    expect(hkChip(wrapper, "type").text()).toContain("Destroyer");
    expect(activeHkPills().map((o) => o.text())).toEqual(["Destroyer"]);

    // Re-click the still-listed Destroyer pill → deselect → list returns.
    await hkPills()[4]!.trigger("click");
    await flushPromises();
    expect(hkChip(wrapper, "type").classes()).not.toContain("hk-filter-chip--on");
    expect(order(wrapper)).toEqual([1, 2, 3, 5]);
  });

  it("keeps a resident type pick selectable when props.ships swaps to data lacking it", async () => {
    // The other half of the 1-day switch: the selection is made on full
    // data first, THEN the range swap removes the type — the option group
    // must not shrink under the open or reopened popup.
    const wrapper = mountBar();
    await flushPromises();

    await hkChip(wrapper, "type").trigger("click");
    await waitHkPops(1);
    await hkPills()[4]!.trigger("click"); // Destroyer → id 4 only
    await flushPromises();
    expect(order(wrapper)).toEqual([4]);

    // Range swap: the 1-day delta only covers non-destroyers.
    await wrapper.setProps({ ships: SHIPS.filter((s) => s.shipId !== 4) });
    await flushPromises();
    expect(lastState(wrapper).ships).toEqual([]);
    expect(hkChip(wrapper, "type").text()).toContain("Destroyer");

    // Reopening the popup still shows the full resident group; deselect
    // recovers the range's ships. (The popup stayed open through the swap,
    // so the first chip click closes it and the second reopens.)
    await hkChip(wrapper, "type").trigger("click");
    await waitHkPops(0);
    await hkChip(wrapper, "type").trigger("click");
    await waitHkPops(1);
    expect(hkPills().length).toBe(6);
    await hkPills()[4]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([1, 2, 3, 5]);
  });

  it("sorts by the fixed canonical priority when several categories sort", async () => {
    const wrapper = mountBar();
    await flushPromises();

    // Engage winrate first, tier second — the priority is the canonical
    // chip order, not the engagement order: tier (earlier) is the primary
    // key, winrate only breaks ties.
    await chip(wrapper, "winrate").trigger("click");
    await waitPops(1);
    await popOpts()[0]!.trigger("click"); // 全部胜率 → winrate sort (desc)
    // Chip-to-chip switches swap teleported popovers — the retired panel
    // must be fully gone before the next option query or its options
    // pollute the indices.
    await chip(wrapper, "tier").trigger("click");
    await waitPops(1);
    // The tier popup's 全部… pill (no option group there).
    await bodyEl("[data-tier-all]").trigger("click"); // → tier sort (desc)
    await flushPromises();

    // Tier desc leads (T10 T10 T9 T8 T6); the T10 tie resolves by the
    // secondary winrate key (65 before 40).
    expect(order(wrapper)).toEqual([5, 4, 2, 1, 3]);
  });

  it("clamps stale multi-select storage of the now-single categories to one pick", async () => {
    // Storage written by the all-multi-select model: two winrate brackets
    // and two battle thresholds picked at once.
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        sel: {
          winrate: { values: ["gte60", "50-60"], dir: "desc", allSort: false },
          battles: { values: ["100", "30"], dir: "desc", allSort: false },
        },
      }),
    );
    const wrapper = mountBar();
    await flushPromises();

    // Winrate keeps the canonical-first bracket, battles its lowest
    // threshold — the latter is exactly what the old OR filtered by.
    expect(chip(wrapper, "winrate").text()).toContain("50–60%");
    expect(chip(wrapper, "battles").text()).toContain("≥30");
    // Both filters pass ids {1, 2, 3}; with the fixed canonical priority
    // the earlier winrate slot sorts desc (58, 55, 52) and battles only
    // breaks ties.
    expect(order(wrapper)).toEqual([3, 1, 2]);
  });

  it("carries the v4 drag-era storage into v6 as selections only", async () => {
    // A v4-era blob (any drag order plus a live selection): the order side
    // is dead state now, only the selection migrates.
    localStorage.setItem(
      V4_PERSIST_KEY,
      JSON.stringify({
        order: ["battles", "winrate", "tier", "type", "nation"],
        sel: {
          winrate: { values: ["gte60"], dir: "desc", allSort: false },
        },
      }),
    );
    const wrapper = mountBar();
    await flushPromises();

    // The carried-over selection still filters…
    expect(order(wrapper)).toEqual([5]);
    // …the v6 blob is written back immediately, selections only (the state
    // must survive a no-interaction session, not re-migrate next boot)…
    const persisted = JSON.parse(localStorage.getItem(PERSIST_KEY)!) as {
      sel?: Record<string, unknown>;
      order?: unknown;
    };
    expect(persisted.sel?.winrate).toBeDefined();
    expect(persisted.order).toBeUndefined();
    // …and the legacy key is swept so the migration runs exactly once.
    expect(localStorage.getItem(LEGACY_PERSIST_KEY)).toBe(null);
  });

  it("folds v5 tier bracket pills into the v6 corridor covering them", async () => {
    // A v5 blob whose tier category still holds bracket pill picks — a
    // contiguous set maps straight, a non-contiguous one widens to its
    // hull (the slider only expresses corridors; the superset never hides
    // a ship the old OR filter showed).
    localStorage.setItem(
      LEGACY_PERSIST_KEY,
      JSON.stringify({
        sel: {
          tier: { values: ["VI–VII", "X–★"], dir: "desc", allSort: false },
        },
      }),
    );
    const wrapper = mountBar();
    await flushPromises();

    // Hull of {6,7} ∪ {10,11} → corridor [6, 11], chip "VI – ★".
    expect(chip(wrapper, "tier").classes()).toContain("ship-filter-bar__chip--on");
    expect(chip(wrapper, "tier").text()).toContain("VI");
    expect(chip(wrapper, "tier").text()).toContain("★");
    // Every test ship (T6..T10) passes; the engaged tier sort reads desc.
    expect(order(wrapper)).toEqual([5, 4, 2, 1, 3]);
    // The v6 blob carries the corridor; the v5 key is swept.
    const persisted = JSON.parse(localStorage.getItem(PERSIST_KEY)!) as {
      sel?: { tier?: { lo?: number; hi?: number } };
    };
    expect(persisted.sel?.tier?.lo).toBe(6);
    expect(persisted.sel?.tier?.hi).toBe(11);
    expect(localStorage.getItem(LEGACY_PERSIST_KEY)).toBe(null);
  });

  it("maps a migrated engaged 全部…-sort onto the cycle's legal states", async () => {
    // A v4-era blob can hold an engaged sort whose direction was flipped
    // freely: the load keeps it (it IS a legal mid-cycle state), so the
    // first 全部… click lands on OFF and the cycle re-arms from the
    // canonical direction afterwards.
    localStorage.setItem(
      LEGACY_PERSIST_KEY,
      JSON.stringify({
        order: ["type", "nation", "tier", "winrate", "battles"],
        sel: {
          winrate: { values: [], dir: "asc", allSort: true },
        },
      }),
    );
    const wrapper = mountBar();
    await flushPromises();

    expect(chip(wrapper, "winrate").classes()).toContain("ship-filter-bar__chip--sort");
    expect(chip(wrapper, "winrate").find(".lucide-arrow-up").exists()).toBe(true);
    expect(order(wrapper)).toEqual([4, 2, 1, 3, 5]); // winrate asc

    await chip(wrapper, "winrate").trigger("click");
    await waitPops(1);
    await popOpts()[0]!.trigger("click");
    await flushPromises();
    // The migrated flipped state reads as mid-cycle: first click switches
    // the sort off entirely…
    expect(chip(wrapper, "winrate").classes()).toContain("ship-filter-bar__chip--all");
    expect(order(wrapper)).toEqual([1, 2, 3, 5, 4]);
    // …and the next engagement starts from the canonical direction again.
    await popOpts()[0]!.trigger("click");
    await flushPromises();
    expect(chip(wrapper, "winrate").find(".lucide-arrow-down").exists()).toBe(true);
    expect(order(wrapper)).toEqual([5, 3, 1, 2, 4]);
  });

  it("keeps selections across an unmount/remount cycle", async () => {
    const first = mountBar();
    await flushPromises();
    await chip(first, "winrate").trigger("click");
    await waitPops(1);
    await popOpts()[4]!.trigger("click"); // ≥60%
    await flushPromises();
    first.unmount();

    const second = mountBar();
    await flushPromises();
    expect(chip(second, "winrate").classes()).toContain("ship-filter-bar__chip--on");
    expect(order(second)).toEqual([5]);
    second.unmount();
  });

  it("filters by division mode as a pure multi-select category", async () => {
    const wrapper = mountBar(MODE_SHIPS, META);
    await flushPromises();
    // Unfiltered: the no-breakdown row is just another ship, battles-desc.
    expect(order(wrapper)).toEqual([2, 1, 3, 5, 4]);

    await hkChip(wrapper, "mode").trigger("click");
    await waitHkPops(1);
    // Resident pill group: the all-pill + 单人 + 双人 + 三人 + 排位.
    expect(hkPills().length).toBe(5);

    // 单人 (Solo): every ship WITH solo battles — the trio-only ship (no
    // solo battles at all) and the no-breakdown row are excluded.
    await hkPills()[1]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([2, 1, 4]);
    expect(hkChip(wrapper, "mode").classes()).toContain("hk-filter-chip--on");
    // Pure category: no direction arrow on the chip or the picked pill.
    expect(hkChip(wrapper, "mode").find(".ship-filter-bar__dir").exists()).toBe(false);
    expect(hkPills()[1]!.find(".ship-filter-bar__dir").exists()).toBe(false);
    expect(hkChip(wrapper, "mode").text()).toContain("Solo");

    // Re-clicking a picked mode deselects it (pure filter, like types).
    await hkPills()[1]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([2, 1, 3, 5, 4]);

    // Multi-select ORs: 双人 then +三人 keeps ships played in either
    // division size (battles-desc within the pick — pure picks never
    // reorder); the chip mirrors the picks in canonical option order.
    await hkPills()[2]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([2]);
    await hkPills()[3]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([2, 3]);
    expect(hkChip(wrapper, "mode").text()).toContain("Duo");
    expect(hkChip(wrapper, "mode").text()).toContain("Trio");

    // 排位 adds id 4 (its ranked battles qualify it; its solo battles
    // are irrelevant to the ranked pick) — three picks still fit the chip.
    await hkPills()[4]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([2, 3, 4]);
    expect(hkChip(wrapper, "mode").text()).toContain("Duo, Trio, Ranked");

    // The fourth pick trips HkFilterChip's label cap: three labels + "+N".
    await hkPills()[1]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([2, 1, 3, 4]); // battles-desc within the pick
    expect(hkChip(wrapper, "mode").text()).toContain("Solo, Duo, Trio +1");

    // The all-pill resets the set — every ship returns, the breakdown-less
    // row included (it drops out only while a mode pill is picked).
    await hkPills()[0]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([2, 1, 3, 5, 4]);
    expect(hkChip(wrapper, "mode").classes()).not.toContain("hk-filter-chip--on");
  });

  it("keeps a mode selection across an unmount/remount cycle", async () => {
    const first = mountBar(MODE_SHIPS, META);
    await flushPromises();
    await hkChip(first, "mode").trigger("click");
    await waitHkPops(1);
    await hkPills()[2]!.trigger("click"); // 双人
    await flushPromises();
    expect(order(first)).toEqual([2]);
    first.unmount();

    const second = mountBar(MODE_SHIPS, META);
    await flushPromises();
    expect(hkChip(second, "mode").classes()).toContain("hk-filter-chip--on");
    expect(order(second)).toEqual([2]);
    second.unmount();
  });

  it("renders the nation popup as hikari's own pannable pill strip with the hint line", async () => {
    const wrapper = mountBar();
    await flushPromises();

    await hkChip(wrapper, "nation").trigger("click");
    await waitHkPops(1);
    // The migrated facet's track IS hikari HkPillToggleGroup's one-line
    // pannable strip (wheel / drag / touch + edge fades) — no bespoke
    // scroll container, no gesture-hint line anymore; the facet hint
    // rides HkFilterChip's own hint element.
    expect(document.body.querySelector(".hk-popover-panel .hk-pill-group")).not.toBeNull();
    const hint = document.body.querySelector(".hk-filter-chip-hint");
    expect(hint).not.toBeNull();
    expect(hint!.textContent).not.toBe("");
    expect(document.body.querySelector(".ship-filter-bar__opts--scroll")).toBeNull();
    expect(document.body.querySelector(".ship-filter-bar__scroll-hint")).toBeNull();

    // A bespoke category keeps its own panel: no pill group, no facet hint.
    await chip(wrapper, "tier").trigger("click");
    await waitPops(1);
    await waitHkPops(0);
    expect(document.body.querySelector(".hk-pill-group")).toBeNull();
    expect(document.body.querySelector(".hk-filter-chip-hint")).toBeNull();

    // Back to the nation strip: a plain click (no pan movement) still
    // selects — the pan machinery never swallows threshold-free clicks.
    await hkChip(wrapper, "nation").trigger("click");
    await waitHkPops(1);
    await hkPills()[1]!.trigger("click"); // japan
    await flushPromises();
    expect(hkChip(wrapper, "nation").classes()).toContain("hk-filter-chip--on");
  });
});

describe("nation strip pan helpers", () => {
  it("translates the vertical wheel notch but honors a real horizontal swipe", () => {
    // Pixel mode (the common engine default).
    expect(stripWheelDelta(0, 0, 120)).toBe(120);
    expect(stripWheelDelta(0, 0, -120)).toBe(-120);
    // Trackpad sideways swipes (and shift+wheel, reported as deltaX
    // natively) win over the vertical delta.
    expect(stripWheelDelta(0, -60, 120)).toBe(-60);
    expect(stripWheelDelta(0, 15, -90)).toBe(15);
    expect(stripWheelDelta(0, 0, 0)).toBe(0);
  });

  it("normalizes Firefox line-mode wheel notches to pixels", () => {
    // deltaMode 1 (lines): one notch is ~3 lines — scaled by 40px/line so
    // a notch pans a wheel-like distance instead of ~3px.
    expect(stripWheelDelta(1, 0, 3)).toBe(120);
    expect(stripWheelDelta(1, 0, -1)).toBe(-40);
    // A horizontal line-mode delta scales the same way.
    expect(stripWheelDelta(1, -2, 0)).toBe(-80);
    // Page mode (2) passes through raw — effectively extinct, and
    // inventing a page height would guess wrong.
    expect(stripWheelDelta(2, 0, 1)).toBe(1);
  });

  it("arms the pan only past the threshold on either axis", () => {
    // Under the threshold on both axes: a click, not a pan.
    expect(panEngaged(0, 0, 5)).toBe(false);
    expect(panEngaged(4, 4, 5)).toBe(false);
    expect(panEngaged(-4, 3, 5)).toBe(false);
    // The threshold itself engages.
    expect(panEngaged(5, 0, 5)).toBe(true);
    expect(panEngaged(0, -5, 5)).toBe(true);
    expect(panEngaged(-9, 3, 5)).toBe(true);
  });
});
