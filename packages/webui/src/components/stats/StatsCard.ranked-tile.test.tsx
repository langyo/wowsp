/**
 * Tests for the StatsCard's ranked split tile — the entry point into the
 * season-timeline modal. The tile renders as a link only when the host
 * passes `onRankedClick` (dashboard + lookup do; the share-shot model and
 * any other consumer without the handler keep the inert tile), and the
 * click reaches that handler.
 *
 * i18n messages are not loaded in tests, so assertions ride on classes
 * and roles, not label text.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { createPinia } from "pinia";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import StatsCard from "./StatsCard";
import type { PlayerStats } from "@/api";

enableAutoUnmount(afterEach);

const STATS = {
  accountId: 7,
  name: "TileProbe",
  realm: "asia",
  battles: 1000,
  winrate: 52.5,
  avgDamage: 48_000,
  pr: 1550,
} as PlayerStats;

function mountCard(props: Record<string, unknown>) {
  return mount(StatsCard, {
    props: { stats: STATS, ...props },
    global: { plugins: [createPinia()] },
  });
}

describe("StatsCard ranked tile", () => {
  it("renders the ranked tile as a link when the host passes onRankedClick", async () => {
    const onRankedClick = vi.fn();
    const wrapper = mountCard({ rankedWr: 62.3, rankedBattles: 53, onRankedClick });
    const tiles = wrapper.findAll(".stats-card__division");
    // The strip holds all four splits; only the ranked one is a link.
    expect(tiles).toHaveLength(4);
    const linkTiles = tiles.filter((t) => t.classes().includes("stats-card__division--open"));
    expect(linkTiles).toHaveLength(1);
    expect(linkTiles[0].attributes("role")).toBe("button");
    await linkTiles[0].trigger("click");
    expect(onRankedClick).toHaveBeenCalledTimes(1);
  });

  it("keeps the ranked tile inert without a handler", () => {
    const wrapper = mountCard({ rankedWr: 62.3, rankedBattles: 53 });
    expect(
      wrapper.findAll(".stats-card__division--open"),
    ).toHaveLength(0);
  });

  it("still shows the strip when only the ranked split has data", () => {
    const wrapper = mountCard({ rankedWr: 48.0, rankedBattles: 0, onRankedClick: vi.fn() });
    expect(wrapper.findAll(".stats-card__division")).toHaveLength(4);
  });
});
