/** The one-shot name-keyed roster lookup's contracts around the module
 *  statCache: entries it returns are COPIES (attaching per-ship lists to
 *  the shared cache objects used to leak a stale or empty list verdict
 *  into every future battle's live-panel cache hit, defeating the per
 *  battle re-attach), fully-warm calls still attach the ship lists (the
 *  post-battle dims watch re-runs warm), and the hidden-profile clan
 *  verdict settles onto the returned copies (they no longer receive the
 *  cache entry's in-place writeback). */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, type PlayerShipStats, type PlayerStats } from "@/api";
import { statsPrefsState } from "@/stores/statsPrefs";
import { fetchRosterStatsByNames } from "./useRosterStats";

vi.mock("@/api", () => ({
  api: {
    lookupPlayersStatsBatch: vi.fn(),
    lookupPlayerShipStats: vi.fn(),
  },
}));
vi.mock("@/utils/clanWinrate", () => ({
  lookupClanWinrate: vi.fn(async () => 62),
}));

const { lookupClanWinrate } = await import("@/utils/clanWinrate");

function mockPlayer(overrides: Partial<PlayerStats> = {}): PlayerStats {
  return {
    accountId: 202_779_553_4,
    name: "tina_999_tian",
    battles: 100,
    winrate: 52,
    avgDamage: 60_000,
    pr: 1400,
    rankedBattles: 30,
    rankedWinrate: 55,
    rankedAvgDamage: 61_000,
    rankedPr: 1500,
    globalBattles: 130,
    globalWinrate: 53,
    globalAvgDamage: 60_200,
    globalPr: 1420,
    clanId: null,
    clanTag: null,
    realm: "asia",
    hidden: false,
    ...overrides,
  } as PlayerStats;
}

function mockShipList(): PlayerShipStats[] {
  return [
    {
      shipId: 4_185_386_512,
      name: "Yamato",
      battles: 40,
      wins: 22,
      damageCaused: 4_000_000,
      frags: 30,
      survivedBattles: 12,
      winrate: 55,
      avgDamage: 100_000,
      lastBattleTime: 1_700_000_000,
    },
  ];
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  // Ship scope on, so the one-shot attaches the per-ship lists.
  statsPrefsState.value.overlayShipScope = "ship";
  statsPrefsState.value.overlayBattleScope = "follow";
  statsPrefsState.value.overlaySoloScope = "all";
});

describe("fetchRosterStatsByNames cache isolation", () => {
  it("returns copies, attaches ship lists on warm re-runs, and keeps requests deduped", async () => {
    vi.mocked(api.lookupPlayersStatsBatch).mockResolvedValue([mockPlayer()]);
    vi.mocked(api.lookupPlayerShipStats).mockResolvedValue(mockShipList());

    const first = await fetchRosterStatsByNames(["tina_999_tian"], "asia");
    // The caller gets the attached list — the aggregation has its data.
    expect(first.get("tina_999_tian")?.ships).toEqual(mockShipList());
    expect(api.lookupPlayersStatsBatch).toHaveBeenCalledTimes(1);
    expect(api.lookupPlayerShipStats).toHaveBeenCalledTimes(1);

    // The warm second call (the post-battle dims watch's re-run) answers a
    // DIFFERENT object — the shared cache entry is never handed out — and
    // still attaches the list from the session cache: no new RPCs, and the
    // ship-scoped columns keep their numbers instead of dashing.
    const second = await fetchRosterStatsByNames(["tina_999_tian"], "asia");
    const a = first.get("tina_999_tian");
    const b = second.get("tina_999_tian");
    expect(b).not.toBe(a);
    expect(b?.ships).toEqual(mockShipList());
    expect(api.lookupPlayersStatsBatch).toHaveBeenCalledTimes(1);
    expect(api.lookupPlayerShipStats).toHaveBeenCalledTimes(1);
  });

  it("settles the hidden-profile clan verdict onto the returned copies", async () => {
    // A fresh name — the module statCache carries the previous test's
    // entry for tina (hidden false), and a cache hit would answer that.
    vi.mocked(api.lookupPlayersStatsBatch).mockResolvedValue([
      mockPlayer({ name: "ghost_rat", accountId: 1, hidden: true, clanId: 501, clanTag: "HOOD" }),
    ]);
    vi.mocked(api.lookupPlayerShipStats).mockResolvedValue([]);

    const out = await fetchRosterStatsByNames(["ghost_rat"], "asia");
    // The verdict lands asynchronously on the COPY — hidden rows never
    // attach ships, and the stamp gate reads the settled clan winrate.
    await vi.waitFor(() => {
      expect(out.get("ghost_rat")?.clanWinrate).toBe(62);
    });
    expect(lookupClanWinrate).toHaveBeenCalledWith("asia", 501);
  });
});

describe("fetchRosterStatsByNames progressive arrival", () => {
  it("sub-batches the misses and settles each chunk's names through onArrive", async () => {
    // Ship scope off — this test exercises the name phase only.
    statsPrefsState.value.overlayShipScope = "all";
    const calls: string[][] = [];
    vi.mocked(api.lookupPlayersStatsBatch).mockImplementation(async (names: string[]) => {
      calls.push(names);
      return names.map((name, i) => mockPlayer({ name, accountId: 9_000 + i }));
    });
    const arrived: string[] = [];
    const names = ["p01", "p02", "p03", "p04", "p05", "p06", "p07"];

    const out = await fetchRosterStatsByNames(names, "asia", (name) => {
      arrived.push(name);
    });

    // 7 misses → 6 + 1 chunks, dispatched in FIFO order.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(6);
    expect(calls[1]).toHaveLength(1);
    expect(out.size).toBe(7);
    expect([...arrived].sort()).toEqual([...names].sort());
  });

  it("marks the copy ships-loading, then re-settles onArrive when its list lands", async () => {
    // Ship scope on (the beforeEach default).
    vi.mocked(api.lookupPlayersStatsBatch).mockResolvedValue([
      mockPlayer({ name: "luna_sea", accountId: 77 }),
    ]);
    let resolveShips!: (v: PlayerShipStats[]) => void;
    vi.mocked(api.lookupPlayerShipStats).mockImplementation(
      () =>
        new Promise<PlayerShipStats[]>((r) => {
          resolveShips = r;
        }),
    );
    const events: Array<{ shipsLoading?: boolean; hasShips: boolean }> = [];
    const pending = fetchRosterStatsByNames(["luna_sea"], "asia", (_name, st) => {
      events.push({ shipsLoading: st.shipsLoading, hasShips: st.ships != null });
    });

    // Career settle first (no ship flag yet), then the pending flag the
    // moment the ship phase starts — the row spinner rides it.
    await vi.waitFor(() => {
      expect(events.some((e) => e.shipsLoading === true)).toBe(true);
    });
    expect(events[0]).toEqual({ shipsLoading: undefined, hasShips: false });

    resolveShips(mockShipList());
    const out = await pending;
    // The attach re-settles: list on, flag cleared.
    expect(events[events.length - 1]).toEqual({ shipsLoading: false, hasShips: true });
    expect(out.get("luna_sea")?.ships).toEqual(mockShipList());
    expect(out.get("luna_sea")?.shipsLoading).toBe(false);
  });

  it("leaves a failed sub-batch's names absent from the result", async () => {
    statsPrefsState.value.overlayShipScope = "all";
    let call = 0;
    vi.mocked(api.lookupPlayersStatsBatch).mockImplementation(async (names: string[]) => {
      call += 1;
      // The FIRST-dispatched chunk (6 names) fails; the second lands.
      if (call === 1) throw new Error("wg down");
      return names.map((name, i) => mockPlayer({ name, accountId: 8_000 + i }));
    });

    const out = await fetchRosterStatsByNames(
      ["fail_a", "fail_b", "ok_c", "ok_d", "ok_e", "ok_f", "ok_g"],
      "asia",
    );

    expect(out.size).toBe(1);
    expect(out.has("ok_g")).toBe(true);
    expect(out.has("fail_a")).toBe(false);
  });
});
