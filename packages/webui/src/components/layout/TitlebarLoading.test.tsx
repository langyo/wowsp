/**
 * Tests for the title-bar loading chip. The chip area is the ONLY place a
 * persistent load is announced (the store moved that feedback out of the
 * toast corner), so its display contract is pinned here:
 *
 *   - identical in-flight loads MERGE onto one chip with a count suffix
 *     (three refreshes all reporting "加载战绩中" must not tile three
 *     indistinguishable chips across the bar — the reported bug),
 *   - distinct labels keep hikari's group contract: the newest load's chip
 *     first, the rest folded into the "+N" counter (the pre-existing fold
 *     silently never ran: an array child made the group see ONE node),
 *   - the live region stays mounted while idle (its announcing property).
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount, type VueWrapper } from "@vue/test-utils";

import { useLoadingTasksStore } from "@/stores/loadingTasks";
import TitlebarLoading from "./TitlebarLoading";

enableAutoUnmount(afterEach);

beforeEach(() => {
  setActivePinia(createPinia());
});

/** Visible chip labels, in DOM order. */
function labels(wrapper: VueWrapper): string[] {
  return wrapper.findAll(".hk-persistent-toast__label").map((node) => node.text());
}

/** The "+N" overflow pill's text, or null when nothing is folded away. */
function overflow(wrapper: VueWrapper): string | null {
  const pill = wrapper.find(".hk-persistent-toast-group__extra");
  return pill.exists() ? pill.text() : null;
}

describe("TitlebarLoading", () => {
  it("keeps the live region mounted with no chip while idle", () => {
    const wrapper = mount(TitlebarLoading);
    expect(wrapper.find(".titlebar-loading-slot").exists()).toBe(true);
    expect(wrapper.findAll(".hk-persistent-toast")).toHaveLength(0);
    expect(overflow(wrapper)).toBeNull();
  });

  it("renders a lone load verbatim, with no count suffix", () => {
    useLoadingTasksStore().begin("加载战绩中");
    const wrapper = mount(TitlebarLoading);
    expect(labels(wrapper)).toEqual(["加载战绩中"]);
    expect(overflow(wrapper)).toBeNull();
  });

  it("merges identical loads onto ONE chip carrying the count", () => {
    const tasks = useLoadingTasksStore();
    tasks.begin("加载战绩中");
    tasks.begin("加载战绩中");
    tasks.begin("加载战绩中");
    const wrapper = mount(TitlebarLoading);
    // ONE chip, not three tiled copies (the reported tiling bug).
    expect(wrapper.findAll(".hk-persistent-toast")).toHaveLength(1);
    expect(labels(wrapper)).toEqual(["加载战绩中 ×3"]);
    // Nothing hides behind "+N" — the suffix accounts for every load.
    expect(overflow(wrapper)).toBeNull();
  });

  it("tracks the live count as loads start and settle", async () => {
    const tasks = useLoadingTasksStore();
    const first = tasks.begin("加载战绩中");
    const second = tasks.begin("加载战绩中");
    const wrapper = mount(TitlebarLoading);
    expect(labels(wrapper)).toEqual(["加载战绩中 ×2"]);

    tasks.end(second);
    await nextTick();
    // Back to a lone load: the bare label, no empty "×1".
    expect(labels(wrapper)).toEqual(["加载战绩中"]);

    const third = tasks.begin("加载战绩中");
    await nextTick();
    expect(labels(wrapper)).toEqual(["加载战绩中 ×2"]);

    tasks.end(first);
    tasks.end(third);
    await nextTick();
    expect(wrapper.findAll(".hk-persistent-toast")).toHaveLength(0);
    expect(wrapper.find(".titlebar-loading-slot").exists()).toBe(true);
  });

  it("keeps the newest label on the chip and folds the rest into +N", () => {
    const tasks = useLoadingTasksStore();
    tasks.begin("加载 A 全局战绩");
    tasks.begin("加载 B 全局战绩");
    const wrapper = mount(TitlebarLoading);
    expect(wrapper.findAll(".hk-persistent-toast")).toHaveLength(1);
    expect(labels(wrapper)).toEqual(["加载 B 全局战绩"]);
    expect(overflow(wrapper)).toBe("+1");
  });

  it("folds every further distinct label into a growing +N", () => {
    const tasks = useLoadingTasksStore();
    tasks.begin("加载 A 全局战绩");
    tasks.begin("加载 B 全局战绩");
    tasks.begin("加载 C 全局战绩");
    const wrapper = mount(TitlebarLoading);
    expect(wrapper.findAll(".hk-persistent-toast")).toHaveLength(1);
    expect(labels(wrapper)).toEqual(["加载 C 全局战绩"]);
    expect(overflow(wrapper)).toBe("+2");
  });

  it("merges only byte-identical labels", () => {
    const tasks = useLoadingTasksStore();
    tasks.begin("加载 A 全局战绩");
    tasks.begin("加载 B 全局战绩");
    tasks.begin("加载 B 全局战绩");
    const wrapper = mount(TitlebarLoading);
    expect(labels(wrapper)).toEqual(["加载 B 全局战绩 ×2"]);
    // The A chip is a DIFFERENT label — folded, never merged into the count.
    expect(overflow(wrapper)).toBe("+1");
  });

  it("merges duplicates that are not adjacent in the task list", () => {
    const tasks = useLoadingTasksStore();
    tasks.begin("加载战绩中");
    tasks.begin("加载 A 全局战绩");
    tasks.begin("加载战绩中");
    const wrapper = mount(TitlebarLoading);
    // The newest load's label leads with BOTH sightings counted, even
    // though another label started in between.
    expect(labels(wrapper)).toEqual(["加载战绩中 ×2"]);
    expect(overflow(wrapper)).toBe("+1");
  });

  it("leads with the newest label even when an older one merged", () => {
    const tasks = useLoadingTasksStore();
    for (let i = 0; i < 4; i += 1) tasks.begin("加载战绩中");
    tasks.begin("加载 A 全局战绩");
    const wrapper = mount(TitlebarLoading);
    expect(labels(wrapper)).toEqual(["加载 A 全局战绩"]);
    expect(overflow(wrapper)).toBe("+1");
  });
});
