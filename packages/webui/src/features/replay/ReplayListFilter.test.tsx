/**
 * Tests for the replay rail filter (ReplayListFilter):
 *  - pure helpers: mode option derivation (canonical order first, unknown
 *    keys appended, only modes actually present), mode filtering (an empty
 *    selection is the 全部模式 identity), and the match-time sort (asc /
 *    desc, dateless entries always sink, ties keep their input order);
 *  - the composable: persisted state round-trips through localStorage,
 *    corrupt / foreign blobs degrade to the default, and the visible
 *    lists are the filtered + sorted derivatives of both blocks;
 *  - the chip strip: two FilterCategoryChips; the mode popup's options
 *    toggle the emitted Set (and carry the mode color dot), 全部 clears,
 *    and the sort chip flips desc → asc → desc through its single
 *    concrete option.
 *
 * The option popups render through hikari HkPopover: their DOM teleports
 * to document.body, so popup queries scope to body and each mount is
 * polled to let the popover machine's timer-driven enter settle (same
 * approach as ShipFilterBar.test).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { DOMWrapper, enableAutoUnmount, mount } from "@vue/test-utils";

import ReplayListFilter, {
  collectModeOptions,
  filterReplays,
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
  extra: { modeAllSort?: boolean; modeDir?: ReplaySortDir } = {},
) {
  return mount(ReplayListFilter, {
    props: {
      modeOptions: [
        { value: "pvp", label: "Random" },
        { value: "ranked", label: "Ranked" },
      ],
      selectedModes: selected,
      sortDir: sort,
      modeAllSort: extra.modeAllSort ?? false,
      modeDir: extra.modeDir ?? "asc",
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

  it("an engaged mode 全部…-sort groups by the canonical mode order first", () => {
    const rows = [
      meta({ path: "ranked-new", scenario: "ranked_kids", dateTime: "20260301_000000" }),
      meta({ path: "pvp-old", matchGroup: "pvp", dateTime: "20250101_000000" }),
      meta({ path: "pvp-new", matchGroup: "pvp", dateTime: "20260201_000000" }),
      meta({ path: "unknown", matchGroup: "space", dateTime: "20260401_000000" }),
    ];
    // Canonical order first (pvp before ranked, unknown keys last); within
    // a group the match-time order still applies (asc here).
    expect(
      sortReplays(rows, "asc", { dir: "asc" }).map((r) => r.path),
    ).toEqual(["pvp-old", "pvp-new", "ranked-new", "unknown"]);
    // The direction flips the group order, not the time order within it.
    expect(
      sortReplays(rows, "desc", { dir: "desc" }).map((r) => r.path),
    ).toEqual(["unknown", "ranked-new", "pvp-new", "pvp-old"]);
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
      modeAllSort: false,
      modeDir: "asc",
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

  it("defaults the mode 全部…-sort to disengaged ascending", () => {
    const f = useReplayListFilter(ref([]), ref([]));
    expect(f.modeAllSort.value).toBe(false);
    expect(f.modeDir.value).toBe("asc");
  });

  it("persists the mode 全部…-sort state and restores it", async () => {
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({ modes: [], sort: "desc", modeAllSort: true, modeDir: "desc" }),
    );
    const f = useReplayListFilter(ref([]), ref([]));
    expect(f.modeAllSort.value).toBe(true);
    expect(f.modeDir.value).toBe("desc");

    // An old blob without the fields degrades to the defaults…
    localStorage.setItem(PERSIST_KEY, JSON.stringify({ modes: [], sort: "asc" }));
    const fresh = useReplayListFilter(ref([]), ref([]));
    expect(fresh.modeAllSort.value).toBe(false);
    expect(fresh.modeDir.value).toBe("asc");

    // …and every change re-persists the full shape.
    fresh.modeAllSort.value = true;
    await nextTick();
    expect(JSON.parse(localStorage.getItem(PERSIST_KEY)!)).toEqual({
      modes: [],
      sort: "asc",
      modeAllSort: true,
      modeDir: "asc",
    });
  });

  it("applies the engaged mode sort to the visible blocks", () => {
    const list = ref([
      meta({ path: "ranked-new", scenario: "ranked_kids", dateTime: "20260301_000000" }),
      meta({ path: "pvp-old", matchGroup: "pvp", dateTime: "20250101_000000" }),
    ]);
    const f = useReplayListFilter(list, ref([]));
    f.modeAllSort.value = true;
    expect(f.visibleList.value.map((r) => r.path)).toEqual(["pvp-old", "ranked-new"]);
    f.modeDir.value = "desc";
    expect(f.visibleList.value.map((r) => r.path)).toEqual(["ranked-new", "pvp-old"]);
  });

  it("drops the empty-string no-identity key from a persisted selection", () => {
    localStorage.setItem(PERSIST_KEY, JSON.stringify({ modes: ["", "pvp"], sort: "desc" }));
    expect([...useReplayListFilter(ref([]), ref([])).selectedModes.value]).toEqual(["pvp"]);
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

describe("ReplayListFilter chip strip", () => {
  it("renders the mode + sort chips with their resting labels", () => {
    const wrapper = mountBar();
    const chips = wrapper.findAll(".ship-filter-bar__chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]!.text()).toBe(t("replay.filter.allModes"));
    expect(chips[1]!.text()).toBe(t("replay.filter.sortNewest"));
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

    await clickPopOption(0); // 全部 with a selection → reset (sort off too)
    expect(wrapper.emitted("update:selectedModes")!.at(-1)![0]).toEqual(new Set());
    expect(wrapper.emitted("update:modeAllSort")!.at(-1)![0]).toBe(false);
  });

  it("the mode 全部… pill engages and flips the mode sort (ships-bar contract)", async () => {
    const wrapper = mountBar();
    await wrapper.findAll(".ship-filter-bar__chip")[0]!.trigger("click");
    // Empty selection: first click engages in the displayed (asc) direction.
    await clickPopOption(0);
    expect(wrapper.emitted("update:modeAllSort")!.at(-1)![0]).toBe(true);

    // Engaged: re-click flips the direction…
    wrapper.unmount();
    const engaged = mountBar(new Set(), "desc", { modeAllSort: true, modeDir: "asc" });
    await engaged.findAll(".ship-filter-bar__chip")[0]!.trigger("click");
    await clickPopOption(0);
    expect(engaged.emitted("update:modeDir")!.at(-1)![0]).toBe("desc");
    // …and the chip wears the intermediate --sort look while unpicked.
    expect(
      engaged.findAll(".ship-filter-bar__chip")[0]!.classes().includes("ship-filter-bar__chip--sort"),
    ).toBe(true);
  });

  it("popup arrows: the 全部… pill always carries one; pure picks never do", async () => {
    const wrapper = mountBar();
    await wrapper.findAll(".ship-filter-bar__chip")[0]!.trigger("click");
    await vi.waitFor(() => {
      expect(document.body.querySelectorAll(".ship-filter-bar__opt")).toHaveLength(3);
    });
    // Mode chip is pure: only the 全部模式 pill shows the direction arrow.
    const opts = document.body.querySelectorAll(".ship-filter-bar__opt");
    expect(opts[0]!.querySelectorAll(".ship-filter-bar__dir")).toHaveLength(1);
    expect(opts[1]!.querySelectorAll(".ship-filter-bar__dir")).toHaveLength(0);
    expect(opts[2]!.querySelectorAll(".ship-filter-bar__dir")).toHaveLength(0);
  });

  it("the sort chip's picked concrete option carries its direction arrow", async () => {
    const wrapper = mountBar(new Set(), "asc");
    await wrapper.findAll(".ship-filter-bar__chip")[1]!.trigger("click");
    await vi.waitFor(() => {
      expect(document.body.querySelectorAll(".ship-filter-bar__opt")).toHaveLength(2);
    });
    const opts = document.body.querySelectorAll(".ship-filter-bar__opt");
    // 最新优先 (the 全部 pill) always shows the arrow; 最早优先 shows it
    // while picked (asc) — the single-select-with-direction grammar.
    expect(opts[0]!.querySelectorAll(".ship-filter-bar__dir")).toHaveLength(1);
    expect(opts[1]!.querySelectorAll(".ship-filter-bar__dir")).toHaveLength(1);
  });

  it("sort chip flips desc → asc → desc through its single concrete option", async () => {
    const wrapper = mountBar();
    await wrapper.findAll(".ship-filter-bar__chip")[1]!.trigger("click");
    await clickPopOption(1); // 最早优先
    expect(wrapper.emitted("update:sortDir")!.at(-1)![0]).toBe("asc");

    wrapper.unmount();
    const flipped = mountBar(new Set(), "asc");
    // Resting label flips to the picked direction.
    expect(flipped.findAll(".ship-filter-bar__chip")[1]!.text()).toBe(
      t("replay.filter.sortOldest"),
    );
    await flipped.findAll(".ship-filter-bar__chip")[1]!.trigger("click");
    await clickPopOption(1); // re-click 最早优先 → back to newest-first
    expect(flipped.emitted("update:sortDir")!.at(-1)![0]).toBe("desc");

    await clickPopOption(0); // the 最新优先 pill (allLabel) → clear → desc
    expect(flipped.emitted("update:sortDir")!.at(-1)![0]).toBe("desc");
  });
});
