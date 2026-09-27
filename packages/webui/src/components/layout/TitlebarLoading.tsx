import { computed, defineComponent } from "vue";
import { HkSpinner } from "@celestia-island/hikari";

import { useLoadingTasksStore } from "@/stores/loadingTasks";
import "./TitlebarLoading.scss";

/**
 * Title-bar loading chip — the compact replacement for the persistent
 * "加载战绩中…"-style loading toasts (see useLoadingTasksStore). Rendered
 * inside HkTitleBar's `actions` slot (AppTitleBar.tsx), i.e. right-aligned,
 * immediately left of the settings gear. Shows the newest active load's
 * label next to a spinner; concurrent loads collapse into a "+N" count.
 *
 * The live region is ALWAYS mounted (the pill inside is conditional) — a
 * live region that unmounts with its content cannot announce the
 * "finished" transition, and each remount would be a brand-new region.
 */
export default defineComponent({
  name: "TitlebarLoading",
  setup() {
    const loadingTasks = useLoadingTasksStore();
    const current = computed(
      () => loadingTasks.tasks[loadingTasks.tasks.length - 1] ?? null,
    );
    const extra = computed(() => Math.max(0, loadingTasks.tasks.length - 1));

    return () => {
      const task = current.value;
      return (
        <span class="titlebar-loading-slot" role="status" aria-live="polite">
          {task ? (
            <span class="titlebar-loading">
              <HkSpinner size={13} />
              <span class="titlebar-loading__label">{task.label}</span>
              {extra.value > 0 ? (
                <span class="titlebar-loading__extra">+{extra.value}</span>
              ) : null}
            </span>
          ) : null}
        </span>
      );
    };
  },
});
