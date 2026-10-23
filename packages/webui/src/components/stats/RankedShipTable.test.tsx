/**
 * Tests for the season modal's ship breakdown (RankedShipTable).
 *
 * Pinned here:
 *  - the rows are the SELECTED season's slice of the per-ship store slot
 *    (rows of other seasons never render);
 *  - the tier chip is ABSENT (its job taken by the bracket buttons) while
 *    the other five water-table chips stay;
 *  - the bracket buttons label themselves with the localized league names
 *    plus the season's tier window, and a pick filters the rows by that
 *    window; switching seasons resets the pick;
 *  - the CN career fallback: with the ship slot empty on realm "cn", the
 *    rows come from the shared ship-stats cache's ranked split and the
 *    career hint line shows (the bracket filter still applies);
 *  - empty rows show the empty state.
 *
 * Stores are seeded directly (the component never fetches seasons), the
 * api module is mocked for the lazy ship fetch's error path only, and the
 * en-US baseline i18n messages load via the i18n module import —
 * assertions use the English strings and fixture-driven text.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { DOMWrapper, enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import RankedShipTable from "./RankedShipTable";
import { useRankedStore } from "@/stores/ranked";
import { useShipStatsStore } from "@/stores/shipStats";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import type {
  PlayerShipStats,
  RankedLeagueTiers,
  RankedSeasonStats,
  RankedShipSeasonStats,
  ShipInfo,
  ShipModeStats,
} from "@/api";

vi.mock("@/api", () => ({
  api: {
    getRankedStats: vi.fn(),
    getRankedShipStats: vi.fn(async () => []),
  },
}));

enableAutoUnmount(afterEach);

/** S30's league→tier windows (Gold IX–X, Silver VII–VIII, Bronze VI). */
const LEAGUES: RankedLeagueTiers[] = [
  { league: 1, minTier: 9, maxTier: 10 },
  { league: 2, minTier: 7, maxTier: 8 },
  { league: 3, minTier: 6, maxTier: 6 },
];

function seasonFixture(over: Partial<RankedSeasonStats> = {}): RankedSeasonStats {
  return {
    seasonId: 1030,
    seasonName: "Season 30",
    battles: 30,
    wins: 15,
    losses: 15,
    damageDealt: 1_000_000,
    frags: 20,
    maxDamage: 100_000,
    maxXp: 2_000,
    survivedBattles: 10,
    planesKilled: 5,
    currentRank: 10,
    bestRank: 10,
    bestLeague: 2,
    bestRankDisplay: "Silver 10",
    leagues: LEAGUES,
    ...over,
  } as RankedSeasonStats;
}

function shipRow(shipId: number, over: Partial<RankedShipSeasonStats> = {}): RankedShipSeasonStats {
  return {
    shipId,
    seasonId: 1030,
    battles: 10,
    wins: 5,
    losses: 5,
    damageDealt: 100_000,
    frags: 9,
    survivedBattles: 4,
    planesKilled: 1,
    xp: 15_000,
    maxDamage: 30_000,
    maxXp: 2_500,
    solo: { battles: 10, wins: 5 },
    div2: null,
    div3: null,
    ...over,
  };
}

/** Ships a tier apart on purpose: Yamato (X) sits in Gold's window,
 *  Budyonny (VI) in Bronze's — a Bronze pick keeps exactly Budyonny.
 *  The Friedrich row belongs to ANOTHER season and must never surface
 *  while S30 is selected. Yamato carries a div2 split for the mode-chip
 *  test. */
const ROWS = [
  shipRow(1, { battles: 20, wins: 12, div2: { battles: 4, wins: 3 } }),
  shipRow(3),
  shipRow(4, { seasonId: 1031 }),
];

const META = [
  { shipId: 1, name: "Yamato", tier: 10, type: "Battleship", nation: "japan" },
  { shipId: 3, name: "Budyonny", tier: 6, type: "Cruiser", nation: "ussr" },
  { shipId: 4, name: "Friedrich", tier: 9, type: "Battleship", nation: "germany" },
] as unknown as ShipInfo[];

/** Career rows for the CN fallback — the water-table shape with a ranked
 *  split; a ship with no ranked battles must never surface. */
function careerRow(shipId: number, rankedBattles: number): PlayerShipStats {
  const bucket: ShipModeStats = {
    battles: rankedBattles,
    wins: 0,
    damageCaused: 0,
    frags: 0,
    survivedBattles: 0,
    winrate: 0,
    avgDamage: 0,
  };
  return {
    shipId,
    name: "",
    battles: 50,
    wins: 25,
    damageCaused: 500_000,
    frags: 20,
    survivedBattles: 12,
    winrate: 50,
    avgDamage: 10_000,
    lastBattleTime: 0,
    modes: { solo: null, div2: null, div3: null, coop: null, ranked: bucket },
  } as unknown as PlayerShipStats;
}

async function mountTable(
  opts: { season?: RankedSeasonStats; realm?: string; cnCache?: PlayerShipStats[] } = {},
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const ranked = useRankedStore();
  ranked.accountId = 42;
  const realm = opts.realm ?? "asia";
  ranked.realm = realm;
  // On CN the store's ship slot stays empty (the backend's protocol) —
  // that emptiness is what arms the career fallback.
  ranked.shipSeasons = opts.cnCache ? [] : ROWS;
  const encyclopedia = useEncyclopediaStore(pinia);
  encyclopedia.ships = META;
  // Keep the filter bar's onMounted lazy encyclopedia load off the
  // network: its guard skips when a realm is already loaded.
  encyclopedia.loadedRealm = realm;
  if (opts.cnCache) {
    useShipStatsStore(pinia).cache.set(`cn_42`, opts.cnCache);
  }
  const wrapper = mount(RankedShipTable, {
    props: { season: opts.season ?? seasonFixture() },
    global: { plugins: [pinia] },
  });
  await flushPromises();
  return wrapper;
}

const rows = (wrapper: Awaited<ReturnType<typeof mountTable>>) =>
  Array.from(wrapper.findAll(".ranked-ships__ship")).map(
    (r) => r.find(".ranked-ships__ship-name").text(),
  );
const bracketBtns = (wrapper: Awaited<ReturnType<typeof mountTable>>) =>
  wrapper.findAll(".ranked-ships__bracket");
const chips = (wrapper: Awaited<ReturnType<typeof mountTable>>) =>
  Array.from(wrapper.findAll(".ship-filter-bar__chip")).map((c) => c.attributes("data-chip"));

/** The filter popups teleport to body (HkPopover) — poll for the machine's
 *  timer-driven enter to settle. */
async function waitPop() {
  for (let i = 0; i < 40; i++) {
    if (document.body.querySelector(".ship-filter-bar__pop")) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}
const popOpts = () =>
  Array.from(
    document.body.querySelectorAll<HTMLElement>(".ship-filter-bar__pop .ship-filter-bar__opt"),
  ).map((el) => new DOMWrapper(el));

describe("RankedShipTable", () => {
  beforeEach(() => {
    // The filter bar persists its picks (own ranked key) — one test's
    // selections must not filter the next test's mount.
    localStorage.clear();
  });

  it("renders the selected season's ship rows and skips other seasons'", async () => {
    const wrapper = await mountTable();
    // Battles-desc default order; the 1031 row stays sliced away.
    expect(rows(wrapper)).toEqual(["Yamato", "Budyonny"]);
  });

  it("drops the tier chip from the filter bar (brackets take its job)", async () => {
    const wrapper = await mountTable();
    expect(chips(wrapper)).toEqual(["type", "nation", "winrate", "battles", "mode"]);
  });

  it("labels the bracket buttons with the localized leagues and tier windows", async () => {
    const wrapper = await mountTable();
    const labels = bracketBtns(wrapper).map((b) => b.text());
    // The en-US baseline messages load via the test setup; tier windows
    // render as roman spans.
    expect(labels[0]).toContain("All leagues");
    expect(labels[1]).toContain("Gold");
    expect(labels[1]).toContain("IX–X");
    expect(labels[3]).toContain("Bronze");
    expect(labels[3]).toContain("VI");
  });

  it("filters the rows by the picked league's tier window; stale picks never hide rows", async () => {
    const wrapper = await mountTable();
    // Bronze (league 3, tier VI–VI): only the tier-VI cruiser stays.
    await bracketBtns(wrapper)[3].trigger("click");
    await flushPromises();
    expect(rows(wrapper)).toEqual(["Budyonny"]);

    // Re-picking the same bracket drops the filter entirely.
    await bracketBtns(wrapper)[3].trigger("click");
    await flushPromises();
    expect(rows(wrapper)).toEqual(["Yamato", "Budyonny"]);

    // A silver pick (VII–VIII) matches neither row → the no-match state.
    await bracketBtns(wrapper)[2].trigger("click");
    await flushPromises();
    expect(wrapper.find(".ranked-ships__state").exists()).toBe(true);
    // Across a season swap the stale pick must not hide rows either: the
    // modal remounts this table per (account, season), and a season whose
    // metadata lacks the picked league's window no-ops the filter — the
    // 1031 row (tier IX) renders either way.
    await wrapper.setProps({ season: seasonFixture({ seasonId: 1031, leagues: [] }) });
    await flushPromises();
    expect(rows(wrapper)).toEqual(["Friedrich"]);
  });

  it("keeps the mode chips truthful on the season slice (mode splits ride along)", async () => {
    const wrapper = await mountTable();
    // Open the 组队模式 popup and pick 双人 (div2). Only Yamato's row
    // carries a div2 split — a season slice without the splits would
    // empty the table here instead.
    await wrapper.find('[data-chip="mode"]').trigger("click");
    await waitPop();
    const opts = popOpts();
    // Option order: 全部…, 单人, 双人, 三人, 排位.
    await opts[2]!.trigger("click");
    await flushPromises();
    expect(rows(wrapper)).toEqual(["Yamato"]);
  });

  it("falls back to the career ranked split on CN with a hint line", async () => {
    const wrapper = await mountTable({
      realm: "cn",
      cnCache: [careerRow(1, 15), careerRow(4, 0)],
    });
    // The store's ship slot stays empty on CN by protocol (no fetch
    // failure, no rows) → the career fallback kicks in.
    expect(wrapper.find(".ranked-ships__note").exists()).toBe(true);
    expect(rows(wrapper)).toEqual(["Yamato"]);
  });

  it("shows the empty state when the season has no ship rows", async () => {
    const wrapper = await mountTable({ season: seasonFixture({ seasonId: 1009 }) });
    expect(wrapper.find(".ranked-ships__state").exists()).toBe(true);
  });
});
