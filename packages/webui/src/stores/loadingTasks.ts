import { defineStore } from "pinia";
import { ref } from "vue";

/** Registry of long-running loads ("加载战绩中…"-style persistent progress).
 *
 *  Persistent loading feedback used to ride the global toast slot — a
 *  top-right stack that squatted the corner for the whole load. This store
 *  moves that feedback into the title bar: callers begin(label) when a
 *  load starts and end(id) when it settles, and the TitlebarLoading chip
 *  (left of the settings gear) shows the newest label, collapsing
 *  concurrent loads into "+N". Transient result toasts (success / error /
 *  warning / info) are NOT affected — they keep their auto-dismissing
 *  toast slots. */
export const useLoadingTasksStore = defineStore("loadingTasks", () => {
  /** Active tasks in start order (the chip renders the newest). */
  const tasks = ref<{ id: number; label: string }[]>([]);
  let nextId = 0;

  /** Register a load; returns the handle to pass to end(). */
  function begin(label: string): number {
    const id = ++nextId;
    tasks.value.push({ id, label });
    return id;
  }

  /** Release a handle from begin(). Unknown ids are a no-op, so a double
   *  release (e.g. a catch path racing a finally block) stays harmless. */
  function end(id: number): void {
    const idx = tasks.value.findIndex((task) => task.id === id);
    if (idx !== -1) tasks.value.splice(idx, 1);
  }

  return { tasks, begin, end };
});
