/**
 * Tests for the ranked season-timeline modal.
 *
 * The modal presents the shared ranked store's seasons as one horizontal
 * chronological strip (oldest left, newest right — the store serves
 * newest-first, so the strip order is the reverse) plus a detail card for
 * the selected season. Pinned here:
 *
 *  - the strip order and the metal tint per season's best-rank league;
 *  - opening defaults the selection to the NEWEST season — the common
 *    flow opens the modal while the host's load is still in flight, and
 *    the selection must adopt the seasons once they land;
 *  - clicking a node re-targets the detail card;
 *  - loading / empty states.
 *
 * The store is seeded directly rather than through a transport mock: the
 * modal never loads, its host view does. i18n messages are not loaded in
 * tests (keys render as their paths), so assertions ride on fixture-driven
 * text (season names, rank displays) and classes.
 */
import { describe, expect, it, afterEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import { useRankedStore } from "@/stores/ranked";
import type { RankedSeasonStats } from "@/api";

import RankedSeasonModal from "./RankedSeasonModal";

enableAutoUnmount(afterEach);

/** Full-shape season fixture; `id` follows the backend convention
 *  (1000 + season number) so seasonName and the tag derive from it. */
function season(id: number, over: Partial<RankedSeasonStats> = {}): RankedSeasonStats {
  return {
    seasonId: id,
    seasonName: `Season ${id - 1000}`,
    battles: 10,
    wins: 5,
    losses: 5,
    damageDealt: 300_000,
    frags: 9,
    maxDamage: 120_000,
    maxXp: 3_000,
    survivedBattles: 4,
    planesKilled: 6,
    currentRank: 5,
    bestRank: 3,
    bestRankDisplay: "Silver 3",
    ...over,
  } as RankedSeasonStats;
}

/** The store serves newest-first (the backend's order). */
const SEASONS = [
  season(1030, { bestRankDisplay: "Gold 1", battles: 53, wins: 33 }),
  season(1029, { bestRankDisplay: "Bronze 6", battles: 26, wins: 12 }),
  season(1009, { bestRankDisplay: "Silver 7", battles: 7, wins: 3 }),
];

function seedStore(over: { seasons?: RankedSeasonStats[]; loading?: boolean } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const ranked = useRankedStore();
  ranked.seasons = over.seasons ?? SEASONS;
  ranked.accountId = 42;
  if (over.loading) ranked.loading = true;
  return { pinia, ranked };
}

const bodyNodes = () =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>(".ranked-modal__node"));
const bodyDetail = () => document.body.querySelector<HTMLElement>(".ranked-modal__detail");
const bodyState = () => document.body.querySelector<HTMLElement>(".ranked-modal__state");

async function mountModal(
  seed: Parameters<typeof seedStore>[0] = {},
  props: Record<string, unknown> = {},
) {
  const { pinia } = seedStore(seed);
  const wrapper = mount(RankedSeasonModal, {
    props: { modelValue: true, playerName: "Tester", ...props },
    global: { plugins: [pinia] },
  });
  await flushPromises();
  return wrapper;
}

describe("RankedSeasonModal", () => {
  it("lays the strip out oldest-left → newest-right and defaults the detail to the newest season", async () => {
    await mountModal();
    const tags = bodyNodes().map((n) => n.querySelector(".ranked-modal__node-tag")?.textContent);
    expect(tags).toEqual(["S9", "S29", "S30"]);
    // Newest node selected, its season named by the detail card.
    expect(bodyNodes()[2].classList.contains("ranked-modal__node--sel")).toBe(true);
    expect(bodyDetail()?.querySelector(".ranked-modal__detail-name")?.textContent).toBe(
      "Season 30",
    );
  });

  it("tints each node with its best-rank league metal", async () => {
    await mountModal();
    const leagues = bodyNodes().map((n) =>
      ["gold", "silver", "bronze"].find((m) => n.classList.contains(`ranked-modal__node--${m}`)),
    );
    // Strip order is chronological, so the metals follow S9 → S29 → S30.
    expect(leagues).toEqual(["silver", "bronze", "gold"]);
  });

  it("re-targets the detail card when a node is clicked", async () => {
    await mountModal();
    await bodyNodes()[1].click();
    await flushPromises();
    expect(bodyNodes()[1].classList.contains("ranked-modal__node--sel")).toBe(true);
    expect(bodyDetail()?.querySelector(".ranked-modal__detail-name")?.textContent).toBe(
      "Season 29",
    );
    expect(bodyDetail()?.querySelector(".ranked-modal__detail-rank")?.textContent).toContain(
      "Bronze 6",
    );
  });

  it("adopts seasons that land after the modal opened (host load still in flight)", async () => {
    const { pinia, ranked } = seedStore({ seasons: [], loading: true });
    const wrapper = mount(RankedSeasonModal, {
      props: { modelValue: true, playerName: "Tester" },
      global: { plugins: [pinia] },
    });
    await flushPromises();
    // The load in flight: the spinner state, no nodes yet.
    expect(bodyState()).toBeTruthy();
    // The load settles the way the store does: data lands, loading clears.
    ranked.loading = false;
    ranked.seasons = SEASONS;
    await flushPromises();
    expect(wrapper.exists()).toBe(true);
    expect(bodyNodes().map((n) => n.querySelector(".ranked-modal__node-tag")?.textContent)).toEqual(
      ["S9", "S29", "S30"],
    );
    expect(bodyDetail()?.querySelector(".ranked-modal__detail-name")?.textContent).toBe(
      "Season 30",
    );
  });

  it("shows the empty state for a player without ranked battles", async () => {
    await mountModal({ seasons: [] });
    expect(bodyState()).toBeTruthy();
    expect(bodyNodes()).toHaveLength(0);
  });
});
