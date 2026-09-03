/**
 * Tests for the chip-based ShipFilterBar interaction model:
 *  - four collapsed chips defaulting to the grayed 全部… state;
 *  - the chip popup hosts the category's segmented HTabs group: picking an
 *    option filters, re-clicking the ACTIVE option flips its asc/desc flag
 *    (HTabs never re-emits — the bar's wrapper click intercepts it), and
 *    picking 全部… resets to gray;
 *  - the chip drag order (persisted, hence seedable via localStorage) is the
 *    multi-key sort priority: leftmost active chip is the primary key;
 *  - selections survive an unmount/remount cycle.
 *
 * The drag gesture itself is pointer-driven and exercised by hand; the
 * priority mechanics it feeds are covered here through the persisted order.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { createPinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";

import ShipFilterBar, { type FilterState } from "./ShipFilterBar";
import type { PlayerShipStats } from "@/api";

const PERSIST_KEY = "wowsp.shipFilter.v2";

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
//   id 3 (70 battles, 58%) passes both the ≥30 and 50–60% selections;
//   id 4 (10 battles, 40%) is excluded by the ≥30 pick;
//   id 5 sits in the ≥60% winrate bracket.
const SHIPS: PlayerShipStats[] = [
  ship({ shipId: 1, battles: 100, winrate: 55, avgDamage: 30 }),
  ship({ shipId: 2, battles: 100, winrate: 52, avgDamage: 20 }),
  ship({ shipId: 3, battles: 70, winrate: 58, avgDamage: 90 }),
  ship({ shipId: 4, battles: 10, winrate: 40, avgDamage: 50 }),
  ship({ shipId: 5, battles: 50, winrate: 65, avgDamage: 45 }),
];

function mountBar() {
  return mount(ShipFilterBar, {
    props: { ships: SHIPS, realm: "" },
    global: { plugins: [createPinia()] },
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
/** Popup triggers follow the category's option order: index 0 is 全部…. */
const popTriggers = (wrapper: ReturnType<typeof mountBar>) =>
  wrapper.findAll(".ship-filter-bar__pop .hk-tabs-trigger");

describe("ShipFilterBar chips", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders four collapsed chips defaulting to the grayed 全部… state", async () => {
    const wrapper = mountBar();
    await flushPromises();

    for (const key of ["type", "tier", "winrate", "battles"]) {
      expect(chip(wrapper, key).classes()).toContain("ship-filter-bar__chip--all");
    }
    // Defaults keep the historical view: battles descending, stable ties.
    expect(order(wrapper)).toEqual([1, 2, 3, 5, 4]);
  });

  it("filters on pick, flips direction on re-pick, resets on 全部", async () => {
    const wrapper = mountBar();
    await flushPromises();

    // Open the winrate popup and pick the 50–60% bracket (trigger 3).
    await chip(wrapper, "winrate").trigger("click");
    expect(wrapper.find(".ship-filter-bar__pop").exists()).toBe(true);
    await popTriggers(wrapper)[3]!.trigger("click");
    await flushPromises();

    // Chip turns active; filter applied; descending → higher winrate first.
    expect(chip(wrapper, "winrate").classes()).toContain("ship-filter-bar__chip--on");
    expect(order(wrapper)).toEqual([3, 1, 2]);

    // Re-click the ALREADY-active option → wrapper flips to ascending.
    expect(popTriggers(wrapper)[3]!.attributes("data-active")).toBeDefined();
    await popTriggers(wrapper)[3]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([2, 1, 3]);

    // 全部胜率 (trigger 0) resets the chip to the gray state.
    await popTriggers(wrapper)[0]!.trigger("click");
    await flushPromises();
    expect(chip(wrapper, "winrate").classes()).toContain("ship-filter-bar__chip--all");
    expect(order(wrapper)).toEqual([1, 2, 3, 5, 4]);
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
    await popTriggers(wrapper)[1]!.trigger("click"); // ≥30 场
    await chip(wrapper, "winrate").trigger("click");
    await popTriggers(wrapper)[3]!.trigger("click"); // 50–60%
    await flushPromises();

    // Both filters pass ids {1, 2, 3} (id 5 is above the bracket). Battles
    // desc leads; the 100-battle tie resolves by the secondary winrate key
    // (55 before 52).
    expect(order(wrapper)).toEqual([1, 2, 3]);

    // Flipping the primary (battles) to ascending reorders everything; the
    // 100-battle pair still resolves by winrate desc (55 before 52).
    // (Only one popup is open at a time — reopen the battles chip first.)
    await chip(wrapper, "battles").trigger("click");
    await popTriggers(wrapper)[1]!.trigger("click");
    await flushPromises();
    expect(order(wrapper)).toEqual([3, 1, 2]);
  });

  it("keeps selections across an unmount/remount cycle", async () => {
    const first = mountBar();
    await flushPromises();
    await chip(first, "winrate").trigger("click");
    await popTriggers(first)[4]!.trigger("click"); // ≥60%
    await flushPromises();
    first.unmount();

    const second = mountBar();
    await flushPromises();
    expect(chip(second, "winrate").classes()).toContain("ship-filter-bar__chip--on");
    expect(order(second)).toEqual([5]);
    second.unmount();
  });
});
