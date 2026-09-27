/** Loading-tasks store: begin/end pairing, start-order tracking and
 *  tolerance for unknown / double releases. */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import { useLoadingTasksStore } from "./loadingTasks";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("loadingTasks store", () => {
  it("tracks begin/end pairs in start order", () => {
    const tasks = useLoadingTasksStore();
    expect(tasks.tasks).toHaveLength(0);

    const a = tasks.begin("A");
    const b = tasks.begin("B");
    expect(tasks.tasks.map((task) => task.label)).toEqual(["A", "B"]);

    tasks.end(b);
    expect(tasks.tasks.map((task) => task.label)).toEqual(["A"]);

    tasks.end(a);
    expect(tasks.tasks).toHaveLength(0);
  });

  it("ignores unknown and double releases", () => {
    const tasks = useLoadingTasksStore();
    const id = tasks.begin("load");
    tasks.end(id);
    tasks.end(id); // double release
    tasks.end(999); // unknown handle
    expect(tasks.tasks).toHaveLength(0);
  });

  it("hands out distinct handles", () => {
    const tasks = useLoadingTasksStore();
    const ids = Array.from({ length: 5 }, () => tasks.begin("x"));
    expect(new Set(ids).size).toBe(5);
  });
});
