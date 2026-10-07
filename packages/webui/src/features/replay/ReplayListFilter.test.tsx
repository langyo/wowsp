/**
 * Tests for the replay rail filter (ReplayListFilter):
 *  - pure helpers: mode option derivation (canonical order first, unknown
 *    keys appended, only modes actually present), mode filtering (an empty
 *    selection is the 全部模式 identity), the match-time sort (asc /
 *    desc, dateless entries always sink, ties keep their input order),
 *    the date-range window (inclusive ISO bounds, dateless entries
 *    drop out once any bound is set), and the two single-select dimensions
 *    (player options ordered by occurrence with stale picks appended;
 *    client matching through sameGamePath with untagged entries excluded;
 *    player matching exact on the nickname);
 *  - the composable: persisted state round-trips through localStorage
 *    (modes/sort/client/player), corrupt / foreign blobs degrade to the
 *    default, the date range is session-only (never persisted), and the
 *    visible lists are the range-filtered + mode-filtered + client-filtered
 *    + player-filtered + sorted derivatives of both blocks;
 *  - the trigger: one icon-button FilterCategoryChip whose popup carries
 *    the mode multi-select, the direction-bearing 全部模式 pill, the two
 *    client/player HkSelects AND the date-range pair (its default slot);
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
import { HkDatePicker, HkSelect } from "@celestia-island/hikari";

import ReplayListFilter, {
  FILTER_ANY,
  collectModeOptions,
  collectPlayerOptions,
  filterByClient,
  filterByDateRange,
  filterByPlayer,
  filterReplays,
  replayDayKeyOf,
  replayModeKeyOf,
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

function meta(partial: Partial<ReplayMetaLite> & { path: string }): ReplayMetaLite {
  return { playerCount: 1, ...partial };
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

describe("collectPlayerOptions", () => {
  it("orders by descending occurrence, ties broken by locale compare", () => {
    // The user's own nickname usually dominates the rail, so the most-played
    // entry must lead; the tie between Kaga and Zulu resolves deterministically.
    expect(
      collectPlayerOptions([
        meta({ path: "a", playerName: "Zulu" }),
        meta({ path: "b", playerName: "Yamato" }),
        meta({ path: "c", playerName: "Yamato" }),
        meta({ path: "d", playerName: "Kaga" }),
        meta({ path: "e" }), // no nickname — never an option
        meta({ path: "f", playerName: null }),
        meta({ path: "g", playerName: "" }),
      ]),
    ).toEqual(["Yamato", "Kaga", "Zulu"]);
  });

  it("appends the persisted extras last, deduped and in their own order", () => {
    const live = [meta({ path: "a", playerName: "Yamato" })];
    // A stale pick absent from the data stays listed (and clearable);
    // duplicates and the empty sentinel are dropped.
    expect(collectPlayerOptions(live, ["Kaga", "", "Yamato", "Kaga"])).toEqual([
      "Yamato",
      "Kaga",
    ]);
    expect(collectPlayerOptions([], ["Kaga", "Yamato"])).toEqual(["Kaga", "Yamato"]);
    expect(collectPlayerOptions([])).toEqual([]);
  });
});

describe("filterByClient / filterByPlayer", () => {
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

  it("filterByPlayer: identity for 全部, else an EXACT nickname match", () => {
    const players = [
      meta({ path: "kaga", playerName: "Kaga" }),
      meta({ path: "KAGA", playerName: "KAGA" }),
      meta({ path: "anon" }), // no nickname
    ];
    expect(filterByPlayer(players, FILTER_ANY)).toBe(players);
    expect(filterByPlayer(players, "Kaga").map((r) => r.path)).toEqual(["kaga"]);
    // Nicknames are case-sensitive proper nouns — "kaga" is a different user.
    expect(filterByPlayer(players, "kaga")).toEqual([]);
    // Picking any nickname drops the entries without one.
    expect(filterByPlayer(players, "KAGA").map((r) => r.path)).toEqual(["KAGA"]);
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

  it("restores and re-persists the client + player picks, degrading junk to 全部", async () => {
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

  it("derives player options from both blocks, most-played first, keeping a stale pick", () => {
    const list = ref([
      meta({ path: "a", playerName: "Kaga" }),
      meta({ path: "b", playerName: "Kaga" }),
      meta({ path: "c", playerName: "Yamato" }),
      meta({ path: "d" }),
    ]);
    const f = useReplayListFilter(list, ref([meta({ path: "e", playerName: "Zulu" })]));
    expect(f.playerOptions.value).toEqual(["Kaga", "Yamato", "Zulu"]);

    // A persisted pick absent from the data stays listed (and clearable).
    f.selectedPlayer.value = "Gone";
    expect(f.playerOptions.value).toEqual(["Kaga", "Yamato", "Zulu", "Gone"]);
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
    expect(document.body.querySelectorAll(".replay-view__pop-dates .hk-dp")).toHaveLength(2);
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

  it("carries the client + player dropdowns above the date pair and emits their picks", async () => {
    const wrapper = mountBar(new Set(), "desc", {
      selectedClient: FILTER_ANY,
      clientOptions: [
        { value: "D:/Games/World_of_Warships", label: "Steam · ASIA" },
        { value: "D:/Lesta/WoWS", label: "Lesta · RU" },
      ],
      selectedPlayer: FILTER_ANY,
      playerOptions: ["Kaga", "Yamato"],
    });
    // Popup content mounts only while open (the chip mounts it into the
    // teleported panel).
    await wrapper.findAll(".ship-filter-bar__chip")[0]!.trigger("click");
    await vi.waitFor(() => {
      expect(document.body.querySelectorAll(".ship-filter-bar__opt")).toHaveLength(3);
    });
    const selects = wrapper.findAllComponents(HkSelect);
    expect(selects).toHaveLength(2);
    // Both rows sit inside their wrapper divs (the popup's slot), above the
    // date pair — the panel stacks them in slot order.
    expect(
      document.body.querySelectorAll(".replay-view__pop-select .hk-select-wrapper"),
    ).toHaveLength(2);
    // Client: the 全部 option leads, then the host's install options.
    expect(selects[0]!.props("label")).toBe(t("replay.filter.client"));
    expect(selects[0]!.props("placeholder")).toBe(t("replay.filter.allClients"));
    expect(selects[0]!.props("options")).toEqual([
      { value: FILTER_ANY, label: t("replay.filter.allClients") },
      { value: "D:/Games/World_of_Warships", label: "Steam · ASIA" },
      { value: "D:/Lesta/WoWS", label: "Lesta · RU" },
    ]);
    // Player: the 全部 option leads, then one row per nickname (verbatim).
    expect(selects[1]!.props("label")).toBe(t("replay.filter.player"));
    expect(selects[1]!.props("placeholder")).toBe(t("replay.filter.allPlayers"));
    expect(selects[1]!.props("options")).toEqual([
      { value: FILTER_ANY, label: t("replay.filter.allPlayers") },
      { value: "Kaga", label: "Kaga" },
      { value: "Yamato", label: "Yamato" },
    ]);
    // The selects are controlled by the host props; their picks ride out.
    selects[0]!.vm.$emit("update:modelValue", "D:/Lesta/WoWS");
    expect(wrapper.emitted("update:selectedClient")!.at(-1)![0]).toBe("D:/Lesta/WoWS");
    selects[1]!.vm.$emit("update:modelValue", "Kaga");
    expect(wrapper.emitted("update:selectedPlayer")!.at(-1)![0]).toBe("Kaga");
    // 全部 (FILTER_ANY) is an ordinary option value — picking it clears.
    selects[1]!.vm.$emit("update:modelValue", FILTER_ANY);
    expect(wrapper.emitted("update:selectedPlayer")!.at(-1)![0]).toBe(FILTER_ANY);
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
