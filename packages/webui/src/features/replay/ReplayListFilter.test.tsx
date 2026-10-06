/**
 * Tests for the replay rail filter (ReplayListFilter):
 *  - pure helpers: mode option derivation (canonical order first, unknown
 *    keys appended, only modes actually present), mode filtering (an empty
 *    selection is the 全部模式 identity), the match-time sort (asc /
 *    desc, dateless entries always sink, ties keep their input order),
 *    and the date-range window (inclusive ISO bounds, dateless entries
 *    drop out once any bound is set);
 *  - the composable: persisted state round-trips through localStorage,
 *    corrupt / foreign blobs degrade to the default, the date range is
 *    session-only (never persisted), and the visible lists are the
 *    range-filtered + mode-filtered + sorted derivatives of both blocks;
 *  - the trigger: one icon-button FilterCategoryChip plus the date-range
 *    pair; the mode popup's options toggle the emitted Set (and carry the
 *    mode color dot), the 全部模式 pill resets a selection and — with
 *    nothing picked — flips the match-time direction its ↑/↓ arrow
 *    displays; the two HkDatePickers cross-link (min/max) and emit the
 *    from/to updates.
 *
 * The option popups render through hikari HkPopover: their DOM teleports
 * to document.body, so popup queries scope to body and each mount is
 * polled to let the popover machine's timer-driven enter settle (same
 * approach as ShipFilterBar.test).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { DOMWrapper, enableAutoUnmount, mount } from "@vue/test-utils";
import { HkDatePicker } from "@celestia-island/hikari";

import ReplayListFilter, {
  collectModeOptions,
  filterByDateRange,
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

function mountBar(selected: Set<string> = new Set(), sort: ReplaySortDir = "desc") {
  return mount(ReplayListFilter, {
    props: {
      modeOptions: [
        { value: "pvp", label: "Random" },
        { value: "ranked", label: "Ranked" },
      ],
      selectedModes: selected,
      sortDir: sort,
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
    });
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

  it("renders the date-range pair cross-linked and wired to the from/to updates", async () => {
    const wrapper = mountBar();
    const pickers = wrapper.findAllComponents(HkDatePicker);
    expect(pickers).toHaveLength(2);
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
});
