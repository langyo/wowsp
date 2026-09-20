/**
 * Tests for the chip-based ShipFilterBar interaction model (mixed
 * multi/single select):
 *  - four collapsed chips default to the inert grayed 全部… state; with
 *    nothing engaged the view keeps the historical battles-desc order;
 *  - the popup hosts the category's option group: type/tier are
 *    multi-select (picks OR within the category — the tier test covers the
 *    shared-direction flip), winrate/battles hold a SINGLE pick (a new
 *    bracket replaces the old one). Re-clicking the picked option flips
 *    the category's SHARED 正序/倒序 flag (every arrow in the category
 *    follows), and 全部… resets the category when a selection exists;
 *  - 全部… itself always shows the direction arrow: without a selection it
 *    engages the sort-in-全部-state mode (first click sorts in the shown
 *    direction, further clicks flip it) — the chip wears the --sort style;
 *  - concrete ship types are pure filters: no arrows anywhere, re-clicking
 *    a type deselects it, and only 全部舰种 can make the category sort;
 *  - the chip drag order (persisted, hence seedable via localStorage) is
 *    the multi-key sort priority: leftmost sorting chip is the primary key;
 *  - stale multi-select storage of the now-single categories is clamped
 *    to one pick on load;
 *  - selections survive an unmount/remount cycle.
 *
 * The option popups render through hikari HPopover: their DOM teleports to
 * document.body (overflow ancestors can never clip them), so popup queries
 * scope to body and each open/close is polled to let the popover machine's
 * timer-driven enter/leave settle.
 *
 * The drag gesture itself is pointer-driven and exercised by hand; the
 * priority mechanics it feeds are covered here through the persisted order.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createPinia } from "pinia";
import { DOMWrapper, enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import ShipFilterBar, { type FilterState } from "./ShipFilterBar";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import type { PlayerShipStats, ShipInfo } from "@/api";

const PERSIST_KEY = "wowsp.shipFilter.v3";

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

function mountBar() {
  const pinia = createPinia();
  useEncyclopediaStore(pinia).ships = META;
  return mount(ShipFilterBar, {
    props: { ships: SHIPS, realm: "" },
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
 *  popups teleport to body (HPopover), so they are queried there. */
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

  it("renders four collapsed chips defaulting to the grayed 全部… state", async () => {
    const wrapper = mountBar();
    await flushPromises();

    for (const key of ["type", "tier", "winrate", "battles"]) {
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

  it("engages a 全部… sort (arrow always shown) and flips it like any key", async () => {
    const wrapper = mountBar();
    await flushPromises();

    await chip(wrapper, "winrate").trigger("click");
    await waitPops(1);
    // 全部胜率 shows its direction arrow before anything is engaged.
    expect(popOpts()[0]!.find(".ship-filter-bar__dir").exists()).toBe(true);

    // First click sorts in the displayed (descending) direction while the
    // chip keeps filtering nothing — the intermediate --sort style.
    await popOpts()[0]!.trigger("click");
    await flushPromises();
    expect(chip(wrapper, "winrate").classes()).toContain("ship-filter-bar__chip--sort");
    expect(chip(wrapper, "winrate").find(".lucide-arrow-down").exists()).toBe(true);
    expect(order(wrapper)).toEqual([5, 3, 1, 2, 4]);

    // Further clicks flip the direction.
    await popOpts()[0]!.trigger("click");
    await flushPromises();
    expect(chip(wrapper, "winrate").find(".lucide-arrow-up").exists()).toBe(true);
    expect(order(wrapper)).toEqual([4, 2, 1, 3, 5]);

    // A concrete pick keeps the direction and adds the filter on top.
    await popOpts()[3]!.trigger("click"); // 50–60%
    await flushPromises();
    expect(chip(wrapper, "winrate").classes()).toContain("ship-filter-bar__chip--on");
    expect(order(wrapper)).toEqual([2, 1, 3]);

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
    // Option order: 全部舰种, Battleship, Cruiser, Destroyer (present only).
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
  });

  it("uses the persisted chip order as the multi-key sort priority", async () => {
    // Drag order seeded as battles → winrate: battles is the primary key,
    // winrate only breaks ties.
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({ order: ["battles", "winrate", "tier", "type"], sel: {} }),
    );
    const wrapper = mountBar();
    await flushPromises();

    await chip(wrapper, "battles").trigger("click");
    await waitPops(1);
    await popOpts()[1]!.trigger("click"); // ≥30 场
    // Chip-to-chip switches swap teleported popovers — the retired panel
    // must be fully gone before the next option query or its options
    // pollute the indices.
    await chip(wrapper, "winrate").trigger("click");
    await waitPops(1);
    await popOpts()[3]!.trigger("click"); // 50–60%
    await flushPromises();

    // Both filters pass ids {1, 2, 3} (id 5 is above the bracket). Battles
    // desc leads; the 100-battle tie resolves by the secondary winrate key
    // (55 before 52).
    expect(order(wrapper)).toEqual([1, 2, 3]);

    // Flipping the primary (battles) to ascending reorders everything; the
    // 100-battle pair still resolves by winrate desc (55 before 52).
    // (Only one popup is open at a time — reopen the battles chip first.)
    await chip(wrapper, "battles").trigger("click");
    await waitPops(1);
    await popOpts()[1]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([3, 1, 2]);
  });

  it("clamps stale multi-select storage of the now-single categories to one pick", async () => {
    // Storage written by the all-multi-select model: two winrate brackets
    // and two battle thresholds picked at once.
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        order: ["battles", "winrate", "tier", "type"],
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
    expect(order(wrapper)).toEqual([1, 2, 3]);
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
});
