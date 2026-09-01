/** Regression test for the sort-direction flip: clicking the ACTIVE sort
 *  option must toggle desc↔asc. HTabs (radio semantics) never re-emits
 *  for the already-active option, which used to swallow the flip entirely
 *  after the hikari migration — the bar now intercepts that click itself.
 *  See fix/sort-direction-toggle. */
import { describe, expect, it } from "vitest";
import { createPinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";

import ShipFilterBar, { type FilterState } from "./ShipFilterBar";
import type { PlayerShipStats } from "@/api";

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

const SHIPS: PlayerShipStats[] = [
  ship({ shipId: 1, battles: 100, winrate: 40, avgDamage: 30 }),
  ship({ shipId: 2, battles: 50, winrate: 60, avgDamage: 20 }),
  ship({ shipId: 3, battles: 75, winrate: 55, avgDamage: 90 }),
];

function mountBar() {
  return mount(ShipFilterBar, {
    props: { ships: SHIPS, realm: "" },
    global: { plugins: [createPinia()] },
  });
}

describe("ShipFilterBar sort direction", () => {
  it("flips direction when the active sort option is clicked", async () => {
    const wrapper = mountBar();
    await flushPromises();

    // Trigger order follows the tabs array: battles, winrate, avgDamage.
    const triggers = () => wrapper.findAll(".ship-filter-bar__sort .hk-tabs-trigger");
    const lastOrder = () => {
      const calls = wrapper.emitted("change") ?? [];
      const [state] = calls[calls.length - 1] as unknown as [FilterState];
      return state.ships.map((s) => s.shipId);
    };

    // Initial: battles, descending.
    expect(lastOrder()).toEqual([1, 3, 2]);
    expect(triggers()[0]!.attributes("data-active")).toBeDefined();

    // Click the already-active battles option → flips to ascending.
    await triggers()[0]!.trigger("click");
    await flushPromises();
    expect(lastOrder()).toEqual([2, 3, 1]);
    expect(triggers()[0]!.attributes("data-active")).toBeDefined();

    // Click it once more → back to descending.
    await triggers()[0]!.trigger("click");
    await flushPromises();
    expect(lastOrder()).toEqual([1, 3, 2]);

    // Switching keys resets to descending (avgDamage: 90 > 30 > 20).
    await triggers()[2]!.trigger("click");
    await flushPromises();
    expect(lastOrder()).toEqual([3, 1, 2]);
    expect(triggers()[0]!.attributes("data-active")).toBeUndefined();

    // The new active option flips too.
    await triggers()[2]!.trigger("click");
    await flushPromises();
    expect(lastOrder()).toEqual([2, 1, 3]);
  });
});
