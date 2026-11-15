import { computed, defineComponent } from "vue";
import { HkPersistentToast, HkPersistentToastGroup } from "@celestia-island/hikari";

import { useLoadingTasksStore } from "@/stores/loadingTasks";
import "./TitlebarLoading.scss";

/** One title-bar chip: a load label plus how many in-flight loads carry it. */
interface LoadingChip {
  /** The load's label — also the chip's identity (identical loads merge). */
  label: string;
  /** In-flight loads carrying this label (1 for a lone load). */
  count: number;
}

/**
 * Title-bar loading chip — the persistent "加载战绩中"-style progress
 * indicator (see useLoadingTasksStore), rendered on hikari's
 * HkPersistentToast family. Lives inside HkTitleBar's `actions` slot
 * (AppTitleBar.tsx), right-aligned, immediately left of the settings
 * gear — beside the upstream-fault chip (TitlebarUpstreamFault), which
 * shares the slot.
 *
 * ONE chip per DISTINCT label: identical concurrent loads (three refreshes
 * all reporting "加载战绩中") merge onto one chip whose label carries the
 * count suffix ("加载战绩中 ×3") instead of tiling three identical chips
 * across the bar. Distinct labels keep the group contract — the newest
 * load's chip first, each further distinct label folded into the "+N"
 * counter — so the bar never grows past one chip plus that pill
 * (maxVisible={1}). The suffix rides the chip's ellipsizing label, so an
 * extreme label length can truncate it (the short operational labels this
 * chip carries do not).
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

    /** Chips in display order: newest-first, one entry per distinct
     *  label with its in-flight multiplicity. */
    const chips = computed<LoadingChip[]>(() => {
      const merged: LoadingChip[] = [];
      // Walk newest → oldest: the first sighting of a label fixes the
      // chip's position (the group renders its FIRST child), and every
      // later sighting only bumps that chip's count.
      for (let i = loadingTasks.tasks.length - 1; i >= 0; i -= 1) {
        const { label } = loadingTasks.tasks[i];
        const chip = merged.find((entry) => entry.label === label);
        if (chip) chip.count += 1;
        else merged.push({ label, count: 1 });
      }
      return merged;
    });

    /** The chip's visible label: the load's own text, plus a count suffix
     *  when several in-flight loads share it ("加载战绩中 ×3" — one chip
     *  and a number instead of three indistinguishable chips). */
    function chipLabel(chip: LoadingChip): string {
      return chip.count > 1 ? `${chip.label} ×${chip.count}` : chip.label;
    }

    return () => {
      if (chips.value.length === 0) {
        return <span class="titlebar-loading-slot" role="status" aria-live="polite" />;
      }
      return (
        <span class="titlebar-loading-slot" role="status" aria-live="polite">
          <HkPersistentToastGroup maxVisible={1}>
            {/* A slots OBJECT, not the mapped array as the child: an array
                child reaches the group as ONE fragment vnode, so its
                maxVisible/"+N" fold counted a single child and painted
                every chip — the tiled identical chips the merge replaces. */}
            {{
              default: () =>
                chips.value.map((chip) => (
                  <HkPersistentToast
                    key={chip.label}
                    tone="loading"
                    label={chipLabel(chip)}
                  />
                )),
            }}
          </HkPersistentToastGroup>
        </span>
      );
    };
  },
});
