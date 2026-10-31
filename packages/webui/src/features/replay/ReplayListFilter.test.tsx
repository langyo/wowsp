/**
 * Tests for the replay rail filter (ReplayListFilter):
 *  - pure helpers: mode option derivation (canonical order first, unknown
 *    keys appended, only modes actually present), mode filtering (an empty
 *    selection is the 全部模式 identity), the match-time sort (asc /
 *    desc, dateless entries always sink, ties keep their input order),
 *    the date-range window (inclusive ISO bounds, dateless entries
 *    drop out once any bound is set), and the two single-select dimensions
 *    (client matching through sameGamePath with untagged entries excluded;
 *    the player SEARCH matching any participant's nickname by
 *    case-insensitive substring, degrading to the recorder alone when a
 *    row carries no roster, and a blank query being the identity);
 *  - the composable: persisted state round-trips through localStorage
 *    (modes/sort/client/player), corrupt / foreign blobs degrade to the
 *    default, the date range is session-only (never persisted), and the
 *    visible lists are the range-filtered + mode-filtered + client-filtered
 *    + player-filtered + sorted derivatives of both blocks;
 *  - the trigger: one icon-button FilterCategoryChip whose popup carries
 *    the mode multi-select, the direction-bearing 全部模式 pill, the
 *    client HkSelect + the player search HkInput AND the date-range pair
 *    (its default slot);
 *    the mode popup's options toggle the emitted Set (and carry the mode
 *    color dot), the 全部模式 pill resets a selection and — with nothing
 *    picked — flips the match-time direction its ↑/↓ arrow displays; the
 *    two HkDatePickers cross-link (min/max) and emit the from/to updates; a
 *    nested popup panel (the pickers' own calendars) never trips the
 *    outside-close.
 *
 * The option popups render through hikari HkPopover: their DOM teleports
 * to document.body, so popup queries scope to body and each mount is
 * polled to let the popover machine's timer-driven enter settle (same
 * approach as ShipFilterBar.test).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { DOMWrapper, enableAutoUnmount, mount } from "@vue/test-utils";
import { HkDatePicker, HkInput, HkSelect } from "@celestia-island/hikari";

import ReplayListFilter, {
  FILTER_ANY,
  collectModeOptions,
  filterByClient,
  filterByDateRange,
  filterByPlayer,
  filterReplays,
  replayDayKeyOf,
  replayModeKeyOf,
  replaySearchableNamesOf,
  sortReplays,
  useReplayListFilter,
  type ReplaySortDir,
} from "./ReplayListFilter";
import { initLocaleMessages, t } from "@/i18n";
import type { ReplayMetaLite } from "@/api";

const PERSIST_KEY = "wowsp.replayFilter.v1";

// A popover left open by one test must not leak into the next test's
// body-level queries — unmount every wrapper after each test.
enableAutoUnmount(afterEach);

beforeAll(async () => {
  await initLocaleMessages();
});

beforeEach(() => {
  localStorage.clear();
});

/** Lite replay fixture. `enemyCount` defaults to a two-side roster: a
 *  literal 0 enemy count would read as the single-team story-operation
 *  shape (see modeColors singleTeamRosterFromCounts) and flip pve rows to
 *  operation. */
function meta(partial: Partial<ReplayMetaLite> & { path: string }): ReplayMetaLite {
  return { playerCount: 1, enemyCount: 5, ...partial };
}

/** Click an option pill inside the (single) teleported popup. */
async function clickPopOption(index: number) {
  await vi.waitFor(() => {
    expect(document.body.querySelectorAll(".ship-filter-bar__opt").length).toBeGreaterThan(index);
  });
  const el = document.body.querySelectorAll<HTMLElement>(".ship-filter-bar__opt")[index]!;
  await new DOMWrapper(el).trigger("click");
}

function mountBar(
  selected: Set<string> = new Set(),
  sort: ReplaySortDir = "desc",
  extra: Record<string, unknown> = {},
) {
  return mount(ReplayListFilter, {
    props: {
      modeOptions: [
        { value: "pvp", label: "Random" },
        { value: "ranked", label: "Ranked" },
      ],
      selectedModes: selected,
      sortDir: sort,
      ...extra,
    },
  });
}

describe("collectModeOptions", () => {
  it("derives only present modes, canonical order first, unknown keys after", () => {
    const opts = collectModeOptions([
      meta({ path: "c", matchGroup: "pve" }), // → cooperative
      meta({ path: "a", matchGroup: "pvp" }),
      meta({ path: "b", scenario: "ranked_kids" }), // scenario level → ranked
      meta({ path: "d", matchGroup: "space" }), // unknown to the colour table
      meta({ path: "e" }), // no identity → "" key, never an option
    ]);
    expect(opts.map((o) => o.value)).toEqual(["pvp", "ranked", "cooperative", "space"]);
    expect(opts[0]!.label).toBe(t("replay.mode.pvp"));
  });

  it("labels unknown keys through the generic fallback and empty input yields none", () => {
    expect(collectModeOptions([])).toEqual([]);
    const [unknown] = collectModeOptions([meta({ path: "x", matchGroup: "space" })]);
    expect(unknown!.label).toBe(t("replay.mode._fallback"));
  });

  it("keeps stale persisted picks listed (visible + droppable), known order first", () => {
    const live = [meta({ path: "a", matchGroup: "pvp" })];
    const opts = collectModeOptions(live, new Set(["pvp", "clan", "space"]));
    expect(opts.map((o) => o.value)).toEqual(["pvp", "clan", "space"]);
  });
});

describe("replayModeKeyOf / filterReplays", () => {
  it("canonicalizes through modeKey (layered identity)", () => {
    expect(replayModeKeyOf(meta({ path: "a", matchGroup: "pvp" }))).toBe("pvp");
    expect(replayModeKeyOf(meta({ path: "b", matchGroup: "pve", scriptedUnitCount: 3 }))).toBe(
      "operation",
    );
  });

  it("labels the WW2 operation row by its scenario / single-team counts", () => {
    // The user's 2026-10-26 WW2 replay: matchGroup pve + scenario
    // WW2_OPERATION_1_1011LVL, seven listed players, no enemy side.
    expect(
      replayModeKeyOf(
        meta({
          path: "ww2",
          matchGroup: "pve",
          scenario: "WW2_OPERATION_1_1011LVL",
          eventType: "",
          playerCount: 7,
          enemyCount: 0,
        }),
      ),
    ).toBe("operation");
    // No scenario fingerprint: the single-team counts alone classify it.
    expect(
      replayModeKeyOf(meta({ path: "story", matchGroup: "pve", playerCount: 7, enemyCount: 0 })),
    ).toBe("operation");
    // A normal co-op row (enemy side present) stays co-op.
    expect(
      replayModeKeyOf(meta({ path: "coop", matchGroup: "pve", playerCount: 9, enemyCount: 9 })),
    ).toBe("cooperative");
  });

  it("empty selection passes the input through untouched (identity)", () => {
    const arr = [meta({ path: "a", matchGroup: "pvp" })];
    expect(filterReplays(arr, new Set())).toBe(arr);
  });

  it("keeps only the selected modes (OR within the selection)", () => {
    const arr = [
      meta({ path: "a", matchGroup: "pvp" }),
      meta({ path: "b", scenario: "ranked_kids" }),
      meta({ path: "c", matchGroup: "pve" }),
    ];
    const kept = filterReplays(arr, new Set(["pvp", "ranked"]));
    expect(kept.map((r) => r.path)).toEqual(["a", "b"]);
  });
});

describe("replaySearchableNamesOf / filterByPlayer (participant search)", () => {
  it("searches the full human roster when the row carries one", () => {
    const row = meta({
      path: "a",
      playerName: "Kaga",
      playerNames: ["Kaga", "Yamato", "zuLu"],
    });
    expect(replaySearchableNamesOf(row)).toEqual(["Kaga", "Yamato", "zuLu"]);
    // The search matches ANY participant — not only the recording account —
    // case-insensitively, on a SUBSTRING (a fragment finds the player).
    expect(filterByPlayer([row], "yam").map((r) => r.path)).toEqual(["a"]);
    expect(filterByPlayer([row], "YAM").map((r) => r.path)).toEqual(["a"]);
    expect(filterByPlayer([row], "zulu").map((r) => r.path)).toEqual(["a"]);
    expect(filterByPlayer([row], "kag").map((r) => r.path)).toEqual(["a"]);
    expect(filterByPlayer([row], "nobody")).toEqual([]);
  });

  it("falls back to the recorder alone when the roster is absent / empty / null", () => {
    const rows = [
      meta({ path: "no-field", playerName: "Kaga" }),
      meta({ path: "empty-roster", playerName: "Yamato", playerNames: [] }),
      meta({ path: "null-roster", playerName: "Hood", playerNames: null }),
      meta({ path: "anon", playerName: null }),
    ];
    expect(filterByPlayer(rows, "kag").map((r) => r.path)).toEqual(["no-field"]);
    expect(filterByPlayer(rows, "yam").map((r) => r.path)).toEqual(["empty-roster"]);
    expect(filterByPlayer(rows, "hoo").map((r) => r.path)).toEqual(["null-roster"]);
    // An anonymous row (no roster, no recorder) matches nothing.
    expect(filterByPlayer(rows, "zzz")).toEqual([]);
  });

  it("empty query is the identity (same reference)", () => {
    const rows = [meta({ path: "a", playerName: "Kaga" })];
    expect(filterByPlayer(rows, FILTER_ANY)).toBe(rows);
    expect(filterByPlayer(rows, "")).toBe(rows);
  });

  it("whitespace-only query is the identity (same reference)", () => {
    const rows = [meta({ path: "a", playerName: "Kaga" })];
    expect(filterByPlayer(rows, "   ")).toBe(rows);
    expect(filterByPlayer(rows, " \t ")).toBe(rows);
  });
});

describe("filterByClient", () => {
  const steam = "C:\\Games\\World_of_Warships";
  const rows = [
    meta({ path: "steam", installPath: steam, installKind: "steam", installRealm: "asia" }),
    meta({ path: "steam-forward", installPath: "C:/Games/World_of_Warships/" }),
    meta({ path: "lesta", installPath: "D:\\Lesta\\WoWS", installKind: "lesta" }),
    meta({ path: "phone" }), // untagged: under an unowned root
  ];

  it("the empty pick is the identity, untagged entries included (same reference)", () => {
    expect(filterByClient(rows, FILTER_ANY)).toBe(rows);
    expect(filterByClient(rows, "")).toBe(rows);
  });

  it("matches installPath case- and separator-insensitively (sameGamePath)", () => {
    // Detection feeds the same folder through several spellings — a raw
    // === compare would silently drop the client's own files.
    expect(filterByClient(rows, "c:/games/world_of_warships").map((r) => r.path)).toEqual([
      "steam",
      "steam-forward",
    ]);
    expect(filterByClient(rows, "D:\\Lesta\\WoWS\\").map((r) => r.path)).toEqual(["lesta"]);
  });

  it("excludes untagged entries once a concrete client is picked", () => {
    const kept = filterByClient(rows, steam).map((r) => r.path);
    expect(kept).toEqual(["steam", "steam-forward"]);
    expect(kept).not.toContain("phone");
  });
});

describe("sortReplays", () => {
  const a = meta({ path: "a", dateTime: "20260101_010101" });
  const b = meta({ path: "b", dateTime: "20260203" });
  const c = meta({ path: "c", dateTime: "20250505_080000" });
  const none = meta({ path: "n", dateTime: null });

  it("desc = newest first (the default, matching the mtime-desc scan)", () => {
    expect(sortReplays([c, none, a, b], "desc").map((r) => r.path)).toEqual(["b", "a", "c", "n"]);
  });

  it("asc = oldest first; dateless entries sink either way", () => {
    expect(sortReplays([b, none, c, a], "asc").map((r) => r.path)).toEqual(["c", "a", "b", "n"]);
    expect(sortReplays([b, none, c, a], "desc").map((r) => r.path)).toEqual(["b", "a", "c", "n"]);
  });

  it("never mutates the input and keeps ties stable", () => {
    const x = meta({ path: "x", dateTime: "20260101" });
    const y = meta({ path: "y", dateTime: "20260101" });
    const input = [x, y];
    expect(sortReplays(input, "desc").map((r) => r.path)).toEqual(["x", "y"]);
    expect(input.map((r) => r.path)).toEqual(["x", "y"]);
  });
});

describe("replayDayKeyOf / filterByDateRange", () => {
  it("derives the local day from the filename stamp, rejecting junk", () => {
    expect(replayDayKeyOf(meta({ path: "a", dateTime: "20250622_152405" }))).toBe("2025-06-22");
    expect(replayDayKeyOf(meta({ path: "b", dateTime: "20250622" }))).toBe("2025-06-22");
    expect(replayDayKeyOf(meta({ path: "n", dateTime: null }))).toBeNull();
    expect(replayDayKeyOf(meta({ path: "j", dateTime: "replay_final" }))).toBeNull();
    // Feb 30 rolls over to March 2 — not a real calendar day.
    expect(replayDayKeyOf(meta({ path: "r", dateTime: "20250230_120000" }))).toBeNull();
  });

  it("both bounds null is the identity (same reference, dateless kept)", () => {
    const arr = [meta({ path: "a", dateTime: "20250622_152405" }), meta({ path: "n" })];
    expect(filterByDateRange(arr, null, null)).toBe(arr);
  });

  it("windows inclusively on the local day; dateless drop out once a bound is set", () => {
    const arr = [
      meta({ path: "before", dateTime: "20250601_000000" }),
      meta({ path: "from", dateTime: "20250622_152405" }),
      meta({ path: "inside", dateTime: "20250815_080000" }),
      meta({ path: "to", dateTime: "20250930_235959" }),
      meta({ path: "after", dateTime: "20251001_000000" }),
      meta({ path: "dateless", dateTime: null }),
    ];
    expect(filterByDateRange(arr, "2025-06-22", "2025-09-30").map((r) => r.path)).toEqual([
      "from",
      "inside",
      "to",
    ]);
    // Open bounds: from-only and to-only windows.
    expect(filterByDateRange(arr, "2025-08-01", null).map((r) => r.path)).toEqual([
      "inside",
      "to",
      "after",
    ]);
    expect(filterByDateRange(arr, null, "2025-07-01").map((r) => r.path)).toEqual([
      "before",
      "from",
    ]);
  });
});

describe("useReplayListFilter", () => {
  it("defaults to all modes + newest-first with nothing persisted", () => {
    const f = useReplayListFilter(ref([]), ref([]));
    expect(f.filterActive.value).toBe(false);
    expect(f.sortDir.value).toBe("desc");
    expect([...f.selectedModes.value]).toEqual([]);
    expect(f.selectedClient.value).toBe(FILTER_ANY);
    expect(f.selectedPlayer.value).toBe(FILTER_ANY);
  });

  it("restores a persisted selection and re-persists every change", async () => {
    localStorage.setItem(PERSIST_KEY, JSON.stringify({ modes: ["pvp"], sort: "asc" }));
    const f = useReplayListFilter(ref([]), ref([]));
    expect([...f.selectedModes.value]).toEqual(["pvp"]);
    expect(f.sortDir.value).toBe("asc");
    expect(f.filterActive.value).toBe(true);

    f.selectedModes.value = new Set(["pvp", "ranked"]);
    f.sortDir.value = "desc";
    await nextTick();
    expect(JSON.parse(localStorage.getItem(PERSIST_KEY)!)).toEqual({
      modes: ["pvp", "ranked"],
      sort: "desc",
      client: FILTER_ANY,
      player: FILTER_ANY,
    });
  });

  it("restores and re-persists the client pick + the player query, degrading junk to 全部", async () => {
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        modes: [],
        sort: "desc",
        client: "C:\\Games\\World_of_Warships",
        player: "Kaga",
      }),
    );
    const f = useReplayListFilter(ref([]), ref([]));
    expect(f.selectedClient.value).toBe("C:\\Games\\World_of_Warships");
    expect(f.selectedPlayer.value).toBe("Kaga");
    expect(f.filterActive.value).toBe(true);

    f.selectedClient.value = FILTER_ANY;
    f.selectedPlayer.value = "Yamato";
    await nextTick();
    expect(JSON.parse(localStorage.getItem(PERSIST_KEY)!)).toEqual({
      modes: [],
      sort: "desc",
      client: FILTER_ANY,
      player: "Yamato",
    });

    // Wrong types degrade to 全部 — never to a value that would filter
    // (only the dropdowns write picks, and they write strings).
    localStorage.setItem(PERSIST_KEY, JSON.stringify({ client: 7, player: { n: "x" } }));
    const g = useReplayListFilter(ref([]), ref([]));
    expect(g.selectedClient.value).toBe(FILTER_ANY);
    expect(g.selectedPlayer.value).toBe(FILTER_ANY);
    expect(g.filterActive.value).toBe(false);
  });

  it("degrades corrupt or foreign blobs to the default", () => {
    localStorage.setItem(PERSIST_KEY, "{oops");
    expect(useReplayListFilter(ref([]), ref([])).sortDir.value).toBe("desc");

    localStorage.setItem(PERSIST_KEY, JSON.stringify({ modes: "pvp", sort: "weird" }));
    const f = useReplayListFilter(ref([]), ref([]));
    expect([...f.selectedModes.value]).toEqual([]);
    expect(f.sortDir.value).toBe("desc");
  });

  it("drops the retired mode-group-sort fields of an old blob on the next write", async () => {
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({ modes: ["pvp"], sort: "asc", modeAllSort: true, modeDir: "desc" }),
    );
    const f = useReplayListFilter(ref([]), ref([]));
    expect([...f.selectedModes.value]).toEqual(["pvp"]);
    expect(f.sortDir.value).toBe("asc");

    f.sortDir.value = "desc";
    await nextTick();
    expect(JSON.parse(localStorage.getItem(PERSIST_KEY)!)).toEqual({
      modes: ["pvp"],
      sort: "desc",
      client: FILTER_ANY,
      player: FILTER_ANY,
    });
  });

  it("drops the empty-string no-identity key from a persisted selection", () => {
    localStorage.setItem(PERSIST_KEY, JSON.stringify({ modes: ["", "pvp"], sort: "desc" }));
    expect([...useReplayListFilter(ref([]), ref([])).selectedModes.value]).toEqual(["pvp"]);
  });

  it("the date range narrows the same blocks, stacks with the modes, and stays session-only", async () => {
    const list = ref([
      meta({ path: "jun-pvp", matchGroup: "pvp", dateTime: "20250622_152405" }),
      meta({ path: "aug-pvp", matchGroup: "pvp", dateTime: "20250815_080000" }),
      meta({ path: "aug-ranked", scenario: "ranked_kids", dateTime: "20250820_080000" }),
    ]);
    const f = useReplayListFilter(list, ref([]));

    f.dateFrom.value = "2025-07-01";
    f.dateTo.value = "2025-08-31";
    expect(f.filterActive.value).toBe(true);
    expect(f.visibleList.value.map((r) => r.path)).toEqual(["aug-ranked", "aug-pvp"]);

    // Session-only: the range alone never touches the persisted blob (the
    // mode pick below does — modes are evergreen preferences).
    await nextTick();
    expect(localStorage.getItem(PERSIST_KEY)).toBeNull();

    // Stacks with the mode picks (AND semantics).
    f.selectedModes.value = new Set(["pvp"]);
    expect(f.visibleList.value.map((r) => r.path)).toEqual(["aug-pvp"]);

    // Clearing both bounds reopens the window (modes still apply, so both
    // pvp replays — August first, newest-first — come back).
    f.dateFrom.value = null;
    f.dateTo.value = null;
    expect(f.visibleList.value.map((r) => r.path)).toEqual(["aug-pvp", "jun-pvp"]);
    expect(f.filterActive.value).toBe(true); // the mode pick still engages it
  });

  it("derives the visible blocks: filter + sort, external stays its own block", () => {
    const list = ref([
      meta({ path: "new-pvp", matchGroup: "pvp", dateTime: "20260301_000000" }),
      meta({ path: "old-ranked", scenario: "ranked_kids", dateTime: "20250101_000000" }),
      meta({ path: "new-ranked", scenario: "ranked_kids", dateTime: "20260201_000000" }),
    ]);
    const external = ref([
      meta({ path: "ext-pvp", matchGroup: "pvp", dateTime: "20240101_000000" }),
    ]);
    const f = useReplayListFilter(list, external);

    // Default: everything, newest first.
    expect(f.visibleList.value.map((r) => r.path)).toEqual([
      "new-pvp",
      "new-ranked",
      "old-ranked",
    ]);

    f.selectedModes.value = new Set(["ranked"]);
    expect(f.visibleList.value.map((r) => r.path)).toEqual(["new-ranked", "old-ranked"]);
    expect(f.visibleExternal.value).toEqual([]);

    f.sortDir.value = "asc";
    expect(f.visibleList.value.map((r) => r.path)).toEqual(["old-ranked", "new-ranked"]);

    // Stale picks (absent from both blocks) stay listed, hence droppable.
    f.selectedModes.value = new Set(["clan"]);
    expect(f.modeOptions.value.map((o) => o.value)).toContain("clan");
  });

  it("the client + player picks narrow both blocks, stacked over modes and the window", () => {
    const steam = "C:\\Games\\World_of_Warships";
    const lesta = "D:\\Lesta\\WoWS";
    const list = ref([
      meta({
        path: "steam-kaga",
        matchGroup: "pvp",
        playerName: "Kaga",
        // The roster carries teammates the recorder row alone would never
        // surface — the search's whole point.
        playerNames: ["Kaga", "Teammate"],
        installPath: steam,
        installKind: "steam",
        dateTime: "20260301_000000",
      }),
      meta({
        path: "steam-yamato",
        matchGroup: "pvp",
        playerName: "Yamato",
        installPath: steam,
        installKind: "steam",
        dateTime: "20260201_000000",
      }),
      meta({
        path: "lesta-kaga",
        matchGroup: "pvp",
        playerName: "Kaga",
        installPath: lesta,
        installKind: "lesta",
        dateTime: "20260101_000000",
      }),
      meta({ path: "phone-untagged", matchGroup: "pvp", dateTime: "20260115_000000" }),
    ]);
    const external = ref([
      // Untagged (picked from outside the game folder) with a nickname.
      meta({ path: "ext-kaga", playerName: "Kaga", dateTime: "20241231_000000" }),
    ]);
    const f = useReplayListFilter(list, external);

    expect(f.visibleList.value).toHaveLength(4); // identity by default
    expect(f.visibleExternal.value.map((r) => r.path)).toEqual(["ext-kaga"]);

    f.selectedClient.value = lesta;
    expect(f.filterActive.value).toBe(true);
    // Path identity is separator/case-insensitive; untagged entries drop out.
    expect(f.visibleList.value.map((r) => r.path)).toEqual(["lesta-kaga"]);
    expect(f.visibleExternal.value).toEqual([]);

    f.selectedClient.value = "c:/games/world_of_warships";
    expect(f.visibleList.value.map((r) => r.path)).toEqual(["steam-kaga", "steam-yamato"]);
    f.selectedPlayer.value = "Kaga";
    expect(f.visibleList.value.map((r) => r.path)).toEqual(["steam-kaga"]);
    // A roster-only name (never the recorder) finds the same battle…
    f.selectedPlayer.value = "team";
    expect(f.visibleList.value.map((r) => r.path)).toEqual(["steam-kaga"]);
    // …and the recorder fragment keeps matching on the way out (the later
    // assertions below rely on the query matching ext-kaga's recorder).
    f.selectedPlayer.value = "Kaga";
    // The external pick carries no install tag, so while the client dim is
    // engaged it stays filtered out; clearing THAT dim lets the nickname
    // pick alone bring it back (the two dimensions AND independently).
    expect(f.visibleExternal.value).toEqual([]);
    f.selectedClient.value = FILTER_ANY;
    expect(f.visibleExternal.value.map((r) => r.path)).toEqual(["ext-kaga"]);

    // The date window still ANDs on top of both single-selects: the one
    // surviving row (2026-03-01) falls before a 2026-03-15 lower bound.
    f.selectedClient.value = "c:/games/world_of_warships";
    f.dateFrom.value = "2026-03-15";
    expect(f.visibleList.value).toEqual([]);
    f.dateFrom.value = null;

    // Clearing both picks reopens the rail but leaves nothing engaged.
    f.selectedClient.value = FILTER_ANY;
    f.selectedPlayer.value = FILTER_ANY;
    expect(f.filterActive.value).toBe(false);
    expect(f.visibleList.value).toHaveLength(4);
    expect(f.visibleExternal.value.map((r) => r.path)).toEqual(["ext-kaga"]);
  });

  it("a persisted stale query survives the load and still narrows the blocks", () => {
    // An old v1 blob's exact-nickname pick degrades to a fuzzy query: the
    // same string is restored as the search text and keeps engaging the
    // funnel even when the rail's data no longer matches it.
    localStorage.setItem(PERSIST_KEY, JSON.stringify({ player: "GonePlayer" }));
    const list = ref([
      meta({ path: "kaga", playerName: "Kaga" }),
      meta({ path: "yamato", playerName: "Yamato" }),
    ]);
    const f = useReplayListFilter(list, ref([]));
    expect(f.selectedPlayer.value).toBe("GonePlayer");
    expect(f.filterActive.value).toBe(true);
    expect(f.visibleList.value).toEqual([]);

    // Clearing the query (the sentinel) reopens the rail and disengages.
    f.selectedPlayer.value = FILTER_ANY;
    expect(f.filterActive.value).toBe(false);
    expect(f.visibleList.value.map((r) => r.path)).toEqual(["kaga", "yamato"]);
  });
});

describe("ReplayListFilter trigger", () => {
  it("renders a single icon-button trigger (no text chip, no sort chip)", () => {
    const wrapper = mountBar();
    const chips = wrapper.findAll(".ship-filter-bar__chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.classes()).toContain("ship-filter-bar__chip--icon");
    expect(chips[0]!.find("svg").exists()).toBe(true);
    expect(chips[0]!.text()).toBe("");
  });

  it("renders the date-range pair inside the popup, cross-linked and wired to the from/to updates", async () => {
    const wrapper = mountBar();
    // The pair lives in the chip popup's slot — HkPopover mounts nothing
    // while closed, so open the popup before querying the pickers.
    await wrapper.findAll(".ship-filter-bar__chip")[0]!.trigger("click");
    await vi.waitFor(() => {
      expect(document.body.querySelectorAll(".ship-filter-bar__opt")).toHaveLength(3);
    });
    const pickers = wrapper.findAllComponents(HkDatePicker);
    expect(pickers).toHaveLength(2);
    expect(document.body.querySelectorAll(".replay-view__pop-row .replay-view__pop-date .hk-dp")).toHaveLength(2);
    expect(pickers[0]!.props("placeholder")).toBe(t("replay.filter.dateFrom"));
    expect(pickers[1]!.props("placeholder")).toBe(t("replay.filter.dateTo"));
    // The cross-link engages only while the opposite bound is set.
    expect(pickers[0]!.props("max")).toBeUndefined();
    await wrapper.setProps({ dateFrom: "2025-06-01", dateTo: "2025-09-30" });
    expect(wrapper.findAllComponents(HkDatePicker)[0]!.props("max")).toBe("2025-09-30");
    expect(wrapper.findAllComponents(HkDatePicker)[1]!.props("min")).toBe("2025-06-01");
    // A picker's emission rides out as the host-level from/to update.
    wrapper.findAllComponents(HkDatePicker)[0]!.vm.$emit("update:modelValue", "2025-07-01");
    expect(wrapper.emitted("update:dateFrom")!.at(-1)![0]).toBe("2025-07-01");
  });

  it("the funnel wears the engaged look while a window is set with no mode picked", async () => {
    const wrapper = mountBar();
    const chip = wrapper.findAll(".ship-filter-bar__chip")[0]!;
    expect(chip.classes()).not.toContain("ship-filter-bar__chip--on");
    await wrapper.setProps({ dateFrom: "2025-06-01" });
    expect(chip.classes()).toContain("ship-filter-bar__chip--on");
    await wrapper.setProps({ dateFrom: null });
    expect(chip.classes()).not.toContain("ship-filter-bar__chip--on");
  });

  it("keeps the popup open across presses inside a nested popup panel (the calendars)", async () => {
    const wrapper = mountBar();
    await wrapper.findAll(".ship-filter-bar__chip")[0]!.trigger("click");
    await vi.waitFor(() => {
      expect(document.body.querySelectorAll(".ship-filter-bar__pop")).toHaveLength(1);
    });
    // The date pickers' calendars teleport to body as sibling
    // .hk-popover-panel elements — shape them by hand: a press inside one
    // must NOT close the mode popup (the outside-close contract would
    // otherwise kill the panel mid date-pick).
    const calendar = document.createElement("div");
    calendar.className = "hk-popover-panel";
    const day = document.createElement("span");
    calendar.appendChild(day);
    document.body.appendChild(calendar);
    day.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(document.body.querySelectorAll(".ship-filter-bar__pop")).toHaveLength(1);
    calendar.remove();
    // A press outside both the anchor and the panel still closes.
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.body.querySelectorAll(".ship-filter-bar__pop")).toHaveLength(0);
    });
  });

  it("keeps the popup open across presses inside a nested select surface (the client/player dropdowns)", async () => {
    const wrapper = mountBar();
    await wrapper.findAll(".ship-filter-bar__chip")[0]!.trigger("click");
    await vi.waitFor(() => {
      expect(document.body.querySelectorAll(".ship-filter-bar__pop")).toHaveLength(1);
    });
    // HkSelect's option list teleports to body under its own surface class
    // family — NOT .hk-popover-panel — on desktop (.hk-select-popout-host)
    // and on phones (.hk-select-sheet-panel). Shape both by hand: a press on
    // an option must not close the popup mid-pick, or the selection that
    // press started is lost together with the panel.
    for (const className of ["hk-select-popout-host", "hk-select-sheet-panel"]) {
      const select = document.createElement("div");
      select.className = className;
      const option = document.createElement("button");
      select.appendChild(option);
      document.body.appendChild(select);
      option.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      expect(document.body.querySelectorAll(".ship-filter-bar__pop")).toHaveLength(1);
      select.remove();
    }
    // The phone sheet's SCRIM stays outside on purpose: dismissing the sheet
    // dismisses the popup behind it, which is what tapping the backdrop
    // means there.
    const scrim = document.createElement("div");
    scrim.className = "hk-select-sheet-scrim";
    document.body.appendChild(scrim);
    scrim.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.body.querySelectorAll(".ship-filter-bar__pop")).toHaveLength(0);
    });
    scrim.remove();
    expect(wrapper).toBeTruthy();
  });

  it("mode popup options toggle the emitted Set and carry the mode color dot", async () => {
    const wrapper = mountBar();
    await wrapper.findAll(".ship-filter-bar__chip")[0]!.trigger("click");

    // Popup option order: 全部 pill, then the two passed options.
    await vi.waitFor(() => {
      expect(document.body.querySelectorAll(".ship-filter-bar__opt")).toHaveLength(3);
    });
    const dots = document.body.querySelectorAll(".replay-view__mode-dot");
    expect(dots).toHaveLength(2);
    // pvp pink (#e756a3) on the first concrete option.
    expect(dots[0]!.getAttribute("style")).toContain("#e756a3");

    await clickPopOption(1); // pvp
    expect(wrapper.emitted("update:selectedModes")!.at(-1)![0]).toEqual(new Set(["pvp"]));
    // The bar is controlled — the host feeds the last emission back in
    // before the next toggle builds on it.
    await wrapper.setProps({ selectedModes: new Set(["pvp"]) });
    await clickPopOption(2); // ranked
    expect(wrapper.emitted("update:selectedModes")!.at(-1)![0]).toEqual(
      new Set(["pvp", "ranked"]),
    );

    await clickPopOption(0); // 全部 with a selection → reset only
    expect(wrapper.emitted("update:selectedModes")!.at(-1)![0]).toEqual(new Set());
    expect(wrapper.emitted("update:sortDir")).toBeUndefined();
  });

  it("the 全部模式 pill flips the match-time direction while nothing is picked", async () => {
    const wrapper = mountBar();
    await wrapper.findAll(".ship-filter-bar__chip")[0]!.trigger("click");
    // desc (newest first, the arrow shows ↓): the pill flips to asc…
    await clickPopOption(0);
    expect(wrapper.emitted("update:sortDir")!.at(-1)![0]).toBe("asc");

    // …and an engaged asc flips back to desc.
    wrapper.unmount();
    const flipped = mountBar(new Set(), "asc");
    await flipped.findAll(".ship-filter-bar__chip")[0]!.trigger("click");
    await clickPopOption(0);
    expect(flipped.emitted("update:sortDir")!.at(-1)![0]).toBe("desc");
  });

  it("a selection pick never flips the direction (pure filter)", async () => {
    const wrapper = mountBar();
    await wrapper.findAll(".ship-filter-bar__chip")[0]!.trigger("click");
    await clickPopOption(1); // pvp
    expect(wrapper.emitted("update:sortDir")).toBeUndefined();
  });

  it("popup arrows: the 全部模式 pill carries the current direction; pure picks never do", async () => {
    const wrapper = mountBar();
    await wrapper.findAll(".ship-filter-bar__chip")[0]!.trigger("click");
    await vi.waitFor(() => {
      expect(document.body.querySelectorAll(".ship-filter-bar__opt")).toHaveLength(3);
    });
    // Only the 全部模式 pill shows the direction arrow (↓ = newest first).
    const opts = document.body.querySelectorAll(".ship-filter-bar__opt");
    expect(opts[0]!.querySelectorAll(".ship-filter-bar__dir")).toHaveLength(1);
    expect(opts[1]!.querySelectorAll(".ship-filter-bar__dir")).toHaveLength(0);
    expect(opts[2]!.querySelectorAll(".ship-filter-bar__dir")).toHaveLength(0);
  });

  it("carries the client select + the player search above the date pair and emits their values", async () => {
    const wrapper = mountBar(new Set(), "desc", {
      selectedClient: FILTER_ANY,
      clientOptions: [
        { value: "D:/Games/World_of_Warships", label: "Steam · ASIA" },
        { value: "D:/Lesta/WoWS", label: "Lesta · RU" },
      ],
      selectedPlayer: "kag",
    });
    // Popup content mounts only while open (the chip mounts it into the
    // teleported panel).
    await wrapper.findAll(".ship-filter-bar__chip")[0]!.trigger("click");
    await vi.waitFor(() => {
      expect(document.body.querySelectorAll(".ship-filter-bar__opt")).toHaveLength(3);
    });
    // One select (client) + one search field (player) above the date pair —
    // the trigger renders an INPUT for the player dimension, not a select:
    // a fuzzy match over every participant's roster has no options list.
    const selects = wrapper.findAllComponents(HkSelect);
    expect(selects).toHaveLength(1);
    const inputs = wrapper.findAllComponents(HkInput);
    expect(inputs).toHaveLength(1);
    expect(
      document.body.querySelectorAll(".replay-view__pop-select .hk-select-wrapper"),
    ).toHaveLength(1);
    expect(
      document.body.querySelectorAll(".replay-view__pop-date .hk-input-wrapper"),
    ).toHaveLength(1);
    // Client: the 全部 option leads, then the host's install options.
    expect(selects[0]!.props("label")).toBe(t("replay.filter.client"));
    expect(selects[0]!.props("placeholder")).toBe(t("replay.filter.allClients"));
    expect(selects[0]!.props("options")).toEqual([
      { value: FILTER_ANY, label: t("replay.filter.allClients") },
      { value: "D:/Games/World_of_Warships", label: "Steam · ASIA" },
      { value: "D:/Lesta/WoWS", label: "Lesta · RU" },
    ]);
    // Player: a controlled search field carrying the search placeholder
    // and the persisted query verbatim (it is the initial search text).
    expect(inputs[0]!.props("placeholder")).toBe(t("replay.filter.playerSearch"));
    expect(inputs[0]!.props("modelValue")).toBe("kag");
    // Typing rides out as the host-level query update (live filter); the
    // raw value passes through — trimming is the filter's job.
    inputs[0]!.vm.$emit("update:modelValue", "kaga ");
    expect(wrapper.emitted("update:selectedPlayer")!.at(-1)![0]).toBe("kaga ");
    // A non-empty query grows the × affix; activating it clears back to
    // the FILTER_ANY sentinel.
    expect(document.body.querySelectorAll(".replay-view__pop-player-clear")).toHaveLength(1);
    const clearBtn = document.body.querySelector<HTMLElement>(".replay-view__pop-player-clear")!;
    await new DOMWrapper(clearBtn).trigger("click");
    expect(wrapper.emitted("update:selectedPlayer")!.at(-1)![0]).toBe(FILTER_ANY);
    // The cleared state (controlled prop) drops the affordance again.
    await wrapper.setProps({ selectedPlayer: FILTER_ANY });
    expect(document.body.querySelectorAll(".replay-view__pop-player-clear")).toHaveLength(0);
    // …and the client pick still rides out as before.
    selects[0]!.vm.$emit("update:modelValue", "D:/Lesta/WoWS");
    expect(wrapper.emitted("update:selectedClient")!.at(-1)![0]).toBe("D:/Lesta/WoWS");
  });

  it("the funnel wears the engaged look while only a client / player pick is set", async () => {
    const wrapper = mountBar(new Set(), "desc", { selectedClient: "D:/Lesta/WoWS" });
    const chip = wrapper.findAll(".ship-filter-bar__chip")[0]!;
    expect(chip.classes()).toContain("ship-filter-bar__chip--on");
    await wrapper.setProps({ selectedClient: FILTER_ANY, selectedPlayer: "Kaga" });
    expect(chip.classes()).toContain("ship-filter-bar__chip--on");
    await wrapper.setProps({ selectedPlayer: FILTER_ANY });
    expect(chip.classes()).not.toContain("ship-filter-bar__chip--on");
  });
});
