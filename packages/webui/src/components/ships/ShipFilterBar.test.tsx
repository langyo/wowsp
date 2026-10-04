/**
 * Tests for the chip-based ShipFilterBar interaction model (mixed
 * multi/single select):
 *  - five collapsed chips default to the inert grayed 全部… state; with
 *    nothing engaged the view keeps the historical battles-desc order;
 *  - the popup hosts the category's option group: type/nation/tier are
 *    multi-select (picks OR within the category — the tier test covers the
 *    shared-direction flip), winrate/battles hold a SINGLE pick (a new
 *    bracket replaces the old one). Re-clicking the picked option flips
 *    the category's SHARED 正序/倒序 flag (every arrow in the category
 *    follows), and 全部… resets the category when a selection exists;
 *  - 全部… runs the all-state sort through a THREE-click cycle while
 *    nothing is picked: engage in the canonical direction (--sort style),
 *    flip, switch off entirely (the chip returns to the gray state) — and
 *    the direction arrow renders only while a sort is actually engaged;
 *  - concrete ship types and nations are pure filters: no arrows anywhere,
 *    re-clicking one deselects it, and only the 全部… option can make the
 *    category sort;
 *  - nations are data-derived: only canonical nations PRESENT in the
 *    queried list get options (offline-DB spellings normalize onto the
 *    canonical codes), and event/rental ships with no canonical nation
 *    pass only while the selection is empty;
 *  - every other category's option group is RESIDENT: it never shrinks
 *    with the queried data, so a pick with no matches in the current range
 *    keeps its popup entry, chip label and re-click deselect (an empty
 *    result is the hosting view's business);
 *  - the multi-key sort priority is the FIXED canonical chip order: the
 *    earlier sorting category is the primary key, the next breaks ties;
 *  - the v4 drag-era storage migrates to v5 carrying only the selections
 *    (the drag order is dead state), the legacy key swept and the v5 blob
 *    written back;
 *  - stale multi-select storage of the now-single categories is clamped
 *    to one pick on load;
 *  - selections survive an unmount/remount cycle;
 *  - the nation popup alone renders its options as a pannable strip with
 *    a scroll hint (the other categories keep the plain track, and plain
 *    clicks still select), and the extracted pan helpers (wheel delta
 *    normalizer, 5px pan threshold) hold their contracts.
 *
 * The option popups render through hikari HkPopover: their DOM teleports to
 * document.body (overflow ancestors can never clip them), so popup queries
 * scope to body and each open/close is polled to let the popover machine's
 * timer-driven enter/leave settle.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createPinia } from "pinia";
import { DOMWrapper, enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import ShipFilterBar, { type FilterState } from "./ShipFilterBar";
import { panEngaged, stripWheelDelta } from "./optionStrip";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import type { PlayerShipStats, ShipInfo } from "@/api";

const PERSIST_KEY = "wowsp.shipFilter.v5";
const LEGACY_PERSIST_KEY = "wowsp.shipFilter.v4";

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
] as unknown as ShipInfo[];

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
  const [state] = calls[calls.length - 1] as unknown as [FilterState];
  return state;
};
const order = (wrapper: ReturnType<typeof mountBar>) =>
  lastState(wrapper).ships.map((s) => s.shipId);
const chip = (wrapper: ReturnType<typeof mountBar>, key: string) =>
  wrapper.find(`[data-chip="${key}"]`);
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

  it("renders five collapsed chips defaulting to the grayed 全部… state", async () => {
    const wrapper = mountBar();
    await flushPromises();

    for (const key of ["type", "nation", "tier", "winrate", "battles"]) {
      expect(chip(wrapper, key).classes()).toContain("ship-filter-bar__chip--all");
      // Nothing engaged → no direction arrow anywhere on the chips.
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

  it("syncs the direction across multi-selected tier brackets", async () => {
    const wrapper = mountBar();
    await flushPromises();

    await chip(wrapper, "tier").trigger("click");
    await waitPops(1);
    await popOpts()[2]!.trigger("click"); // VI–VII → id 3 only
    await popOpts()[3]!.trigger("click"); // VIII–IX → adds ids 1, 2
    await flushPromises();
    expect(order(wrapper)).toEqual([2, 1, 3]); // tier desc: T9, T8, T6

    // Both brackets are active, both show the same down arrow…
    expect(activeOpts().length).toBe(2);
    expect(activeOpts().filter((o) => o.find(".lucide-arrow-down").exists()).length).toBe(2);

    // …and flipping ONE of them flips BOTH (shared category direction).
    await popOpts()[3]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([3, 1, 2]); // tier asc: T6, T8, T9
    expect(activeOpts().filter((o) => o.find(".lucide-arrow-up").exists()).length).toBe(2);
  });

  it("keeps ship types pure filters: no arrows, re-click deselects", async () => {
    const wrapper = mountBar();
    await flushPromises();

    await chip(wrapper, "type").trigger("click");
    await waitPops(1);
    // Option order: 全部舰种, Battleship, AirCarrier, Cruiser, Destroyer,
    // Submarine — the full resident list, independent of the data.
    expect(popOpts().length).toBe(6);
    await popOpts()[1]!.trigger("click"); // Battleship
    await flushPromises();

    expect(chip(wrapper, "type").classes()).toContain("ship-filter-bar__chip--on");
    expect(order(wrapper)).toEqual([1, 2]); // filtered, battles-desc within
    // No direction anywhere: not on the chip, not on the picked option.
    expect(chip(wrapper, "type").find(".ship-filter-bar__dir").exists()).toBe(false);
    expect(popOpts()[1]!.find(".ship-filter-bar__dir").exists()).toBe(false);

    // Re-clicking a type deselects it instead of flipping a direction.
    await popOpts()[1]!.trigger("click");
    await flushPromises();
    expect(chip(wrapper, "type").classes()).toContain("ship-filter-bar__chip--all");
    expect(order(wrapper)).toEqual([1, 2, 3, 5, 4]);

    // 全部舰种 is the only way to make the category sort: ascending first
    // (no visible change here — BB happens to lead), then descending.
    await popOpts()[0]!.trigger("click");
    await flushPromises();
    expect(chip(wrapper, "type").classes()).toContain("ship-filter-bar__chip--sort");
    expect(order(wrapper)).toEqual([1, 2, 3, 5, 4]);
    await popOpts()[0]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([4, 3, 5, 1, 2]); // DD → CA → BB

    // The third 全部舰种 click switches the sort off entirely — the gray
    // state and the historical battles-desc order return.
    await popOpts()[0]!.trigger("click");
    await flushPromises();
    expect(chip(wrapper, "type").classes()).toContain("ship-filter-bar__chip--all");
    expect(chip(wrapper, "type").find(".ship-filter-bar__dir").exists()).toBe(false);
    expect(order(wrapper)).toEqual([1, 2, 3, 5, 4]);
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

    await chip(wrapper, "nation").trigger("click");
    await waitPops(1);
    // Options: 全部国家 + the five canonical nations PRESENT in the data,
    // in tech-tree order (japan, usa, ussr, germany, uk) — the offline
    // spellings normalized, "events" gets no option of its own.
    expect(popOpts().length).toBe(6);
    // Concrete options lead with the flag badge (letter fallback in the
    // test env — the wrapper span is what matters).
    expect(popOpts()[1]!.find(".nation-flag").exists()).toBe(true);

    // Japan (id 1) — pure filter, no direction arrow anywhere.
    await popOpts()[1]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([1]);
    expect(chip(wrapper, "nation").find(".ship-filter-bar__dir").exists()).toBe(false);
    expect(chip(wrapper, "nation").classes()).toContain("ship-filter-bar__chip--on");

    // Multi-select ORs: + germany (id 4, the 10-battle DD).
    await popOpts()[4]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([1, 4]);

    // Re-clicking a picked nation deselects it (pure filter, like types).
    await popOpts()[1]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([4]);

    // 全部国家 resets the set — every ship returns, the event curio
    // included (it passes only while the selection is empty).
    await popOpts()[0]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([1, 2, 3, 5, 4, 6]);
    expect(chip(wrapper, "nation").classes()).toContain("ship-filter-bar__chip--all");
  });

  it("derives the nation options from the queried data only", async () => {
    // Half the fleet: only japan/usa/germany remain — the popup never
    // offers nations with no ships in range.
    const ships = SHIPS.filter((s) => [1, 2, 4].includes(s.shipId));
    const wrapper = mountBar(ships, META);
    await flushPromises();

    await chip(wrapper, "nation").trigger("click");
    await waitPops(1);
    expect(popOpts().length).toBe(4); // 全部 + japan + usa + germany
  });

  it("keeps every type option resident when the queried data lacks the type", async () => {
    // 1-day-range reproduction: no destroyer was played in the range while
    // the selection still asks for one — the popup must not lose the
    // Destroyer option and the empty result must stay recoverable in place.
    const wrapper = mountBar(SHIPS.filter((s) => s.shipId !== 4));
    await flushPromises();

    await chip(wrapper, "type").trigger("click");
    await waitPops(1);
    // All five concrete types remain listed (plus 全部舰种), Destroyer
    // included, even though the data holds no destroyer.
    expect(popOpts().length).toBe(6);

    await popOpts()[4]!.trigger("click"); // Destroyer
    await flushPromises();
    // The filter applies normally and yields the empty result…
    expect(lastState(wrapper).ships).toEqual([]);
    expect(chip(wrapper, "type").classes()).toContain("ship-filter-bar__chip--on");
    // …while the chip keeps its resolved label and the pick stays active
    // and re-clickable in the popup (no degradation, no dead state).
    expect(chip(wrapper, "type").text()).toContain("Destroyer");
    expect(activeOpts().map((o) => o.text())).toEqual(["Destroyer"]);

    // Re-click the still-listed Destroyer option → deselect → list returns.
    await popOpts()[4]!.trigger("click");
    await flushPromises();
    expect(chip(wrapper, "type").classes()).toContain("ship-filter-bar__chip--all");
    expect(order(wrapper)).toEqual([1, 2, 3, 5]);
  });

  it("keeps a resident type pick selectable when props.ships swaps to data lacking it", async () => {
    // The other half of the 1-day switch: the selection is made on full
    // data first, THEN the range swap removes the type — the option group
    // must not shrink under the open or reopened popup.
    const wrapper = mountBar();
    await flushPromises();

    await chip(wrapper, "type").trigger("click");
    await waitPops(1);
    await popOpts()[4]!.trigger("click"); // Destroyer → id 4 only
    await flushPromises();
    expect(order(wrapper)).toEqual([4]);

    // Range swap: the 1-day delta only covers non-destroyers.
    await wrapper.setProps({ ships: SHIPS.filter((s) => s.shipId !== 4) });
    await flushPromises();
    expect(lastState(wrapper).ships).toEqual([]);
    expect(chip(wrapper, "type").text()).toContain("Destroyer");

    // Reopening the popup still shows the full resident group; deselect
    // recovers the range's ships. (The popup stayed open through the swap,
    // so the first chip click closes it and the second reopens.)
    await chip(wrapper, "type").trigger("click");
    await waitPops(0);
    await chip(wrapper, "type").trigger("click");
    await waitPops(1);
    expect(popOpts().length).toBe(6);
    await popOpts()[4]!.trigger("click");
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
    await popOpts()[0]!.trigger("click"); // 全部等级 → tier sort (desc)
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

  it("carries the v4 drag-era storage into v5 as selections only", async () => {
    // A v4-era blob (any drag order plus a live selection): the order side
    // is dead state now, only the selection migrates.
    localStorage.setItem(
      LEGACY_PERSIST_KEY,
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
    // …the v5 blob is written back immediately, selections only (the state
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

  it("renders the nation popup alone as a pannable strip with a scroll hint", async () => {
    const wrapper = mountBar();
    await flushPromises();

    await chip(wrapper, "nation").trigger("click");
    await waitPops(1);
    // Nation track: the strip modifier plus the gesture hint line beneath
    // it (the popup itself is width-capped in CSS — not observable here).
    expect(document.body.querySelector(".ship-filter-bar__opts--scroll")).not.toBeNull();
    const hint = document.body.querySelector(".ship-filter-bar__scroll-hint");
    expect(hint).not.toBeNull();
    expect(hint!.textContent).not.toBe("");

    // Another category keeps the plain track: no strip class, no hint.
    await chip(wrapper, "tier").trigger("click");
    await waitPops(1);
    expect(document.body.querySelector(".ship-filter-bar__opts--scroll")).toBeNull();
    expect(document.body.querySelector(".ship-filter-bar__scroll-hint")).toBeNull();

    // Back to the nation strip: a plain click (no pan movement) still
    // selects — the pan machinery never swallows threshold-free clicks.
    await chip(wrapper, "nation").trigger("click");
    await waitPops(1);
    await popOpts()[1]!.trigger("click"); // japan
    await flushPromises();
    expect(chip(wrapper, "nation").classes()).toContain("ship-filter-bar__chip--on");
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
