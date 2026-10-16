import { defineComponent } from "vue";
import { HkPersistentToast, HkPersistentToastGroup } from "@celestia-island/hikari";

import { useLoadingTasksStore } from "@/stores/loadingTasks";
import "./TitlebarLoading.scss";

/**
 * Title-bar loading chip — the persistent "加载战绩中…"-style progress
 * indicator (see useLoadingTasksStore), rendered on hikari's
 * HkPersistentToast family: the newest load's label on a loading chip,
 * concurrent loads collapsed into the group's "+N" counter. Lives
 * inside HkTitleBar's `actions` slot (AppTitleBar.tsx), right-aligned,
 * immediately left of the settings gear — beside the upstream-fault
 * chip (TitlebarUpstreamFault), which shares the slot.
 *
 * The live region is ALWAYS mounted (the chips inside are conditional)
 * — a live region that unmounts with its content cannot announce the
 * "finished" transition, and each remount would be a brand-new region.
 * Chrome, not a control: pointer-events pass off the whole slot (the
 * loading chips are non-interactive; the sibling fault chip manages
 * its own interactivity and lives OUTSIDE this wrapper).
 */
export default defineComponent({
  name: "TitlebarLoading",
  setup() {
    const loadingTasks = useLoadingTasksStore();

    return () => {
      if (loadingTasks.tasks.length === 0) {
        return <span class="titlebar-loading-slot" role="status" aria-live="polite" />;
      }
      // Newest load first — the group renders its first maxVisible
      // children and folds the rest into "+N".
      const newestFirst = [...loadingTasks.tasks].reverse();
      return (
        <span class="titlebar-loading-slot" role="status" aria-live="polite">
          <HkPersistentToastGroup maxVisible={1}>
            {newestFirst.map((task) => (
              <HkPersistentToast key={task.id} tone="loading" label={task.label} />
            ))}
          </HkPersistentToastGroup>
        </span>
      );
    };
  },
});
