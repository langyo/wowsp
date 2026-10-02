/**
 * ReplayListFilter — the replay rail's single filter trigger.
 *
 * The trigger is a funnel icon button living in the rail head's action row
 * (left of the open-external picker — FilterCategoryChip's `icon` anchor,
 * styled as the same ghost toolbar icon button family); its popup is the
 * 水表 filter-bar look (ShipFilterBar's flat classes): one-line pannable
 * option strip with the 全部模式 pill carrying the ↑/↓ direction arrow.
 *   - mode options — data-derived MULTI-select of the battle modes actually
 *     present in the rail, canonicalized through `modeKey`: the same key
 *     that colors the card pills, so chip options (which carry the mode's
 *     color dot) and cards share one vocabulary. Pure filter (picks never
 *     reorder); clicking a mode toggles it, clicking the 全部模式 pill
 *     clears the selection;
 *   - the ↑/↓ arrow on the 全部模式 pill IS the match-time order: ↓
 *     newest-first (the default, matching the historical mtime-desc scan
 *     order), ↑ oldest-first. With a selection the pill just resets; with
 *     none it flips the direction — one button, the arrow states the
 *     order, no separate sort chip.
 *
 * External picks (session-temporary files from outside the replays folder)
 * stay PINNED above the scanned list; the filter and the sort apply to both
 * blocks independently, so the pinning survives any selection. Selection
 * persists to localStorage; stored modes absent from the current list stay
 * listed (and clearable) in the chip until dropped — see
 * collectModeOptions.
 */
import { computed, defineComponent, ref, watch, type PropType, type Ref } from "vue";

import { Filter } from "@lucide/vue";

import { t } from "@/i18n";
import type { ReplayMetaLite } from "@/api";
import { MODE_KEY_ORDER, modeColorOfKey, modeKey } from "@/utils/modeColors";
import FilterCategoryChip from "@/components/ships/FilterCategoryChip";

const PERSIST_KEY = "wowsp.replayFilter.v1";

/** Canonical battle-mode key of a replay entry — the same resolution the
 *  card pill colour and label go through. */
export function replayModeKeyOf(r: ReplayMetaLite): string {
  return modeKey(r.matchGroup, r.scenario, r.eventType, r.botCount ?? 0, r.scriptedUnitCount ?? 0);
}

/** Localized label for an already-resolved mode key (unknown keys fall
 *  back to the generic battle label, same as the card pills). */
export function modeLabelOfKey(key: string): string {
  if (!key) return t("replay.mode._fallback");
  const i18nKey = `replay.mode.${key}`;
  const lbl = t(i18nKey);
  // t() returns the key when missing — fall back to the generic battle label.
  return lbl === i18nKey ? t("replay.mode._fallback") : lbl;
}

/** Mode options for the chip, derived from what the rail actually holds:
 *  canonical keys first (MODE_KEY_ORDER — random, ranked, clan, …), keys
 *  the colour table doesn't know yet appended after in stable
 *  alphabetical order. Dead options never render. `extras` (the persisted
 *  selection) forces absent-but-picked keys back into the list — a client
 *  switch / rescan must not leave the trigger wearing its engaged look over
 *  an empty selection; the stale pick stays visible and droppable. */
export function collectModeOptions(
  metas: Iterable<ReplayMetaLite>,
  extras: Iterable<string> = [],
): { value: string; label: string }[] {
  const present = new Set<string>();
  for (const m of metas) {
    const key = replayModeKeyOf(m);
    // "" is the no-identity key (a descriptor without matchGroup) — the
    // same never-a-pick rule as loadPersisted; skipping it here keeps the
    // degenerate option from ever being listed (a live pick of it could
    // not survive persistence). Those replays still show under 全部模式.
    if (key) present.add(key);
  }
  for (const k of extras) if (k) present.add(k);
  const unknown = [...present]
    .filter((k) => !MODE_KEY_ORDER.includes(k))
    .sort((a, b) => a.localeCompare(b));
  return [...MODE_KEY_ORDER.filter((k) => present.has(k)), ...unknown].map((key) => ({
    value: key,
    label: modeLabelOfKey(key),
  }));
}

/** Keep only replays whose canonical mode is selected. An empty selection
 *  is the 全部模式 state and passes the input through untouched. */
export function filterReplays<T extends ReplayMetaLite>(metas: T[], modes: Set<string>): T[] {
  if (modes.size === 0) return metas;
  return metas.filter((r) => modes.has(replayModeKeyOf(r)));
}

export type ReplaySortDir = "asc" | "desc";

/** Sort by match time (`YYYYMMDD[_HHMMSS]` — lexicographic IS numeric
 *  here). Entries without a parsable date always sink to the end,
 *  regardless of direction; equal keys keep their input order. */
export function sortReplays<T extends ReplayMetaLite>(metas: T[], dir: ReplaySortDir): T[] {
  return [...metas].sort((a, b) => {
    const ad = a.dateTime;
    const bd = b.dateTime;
    if (!ad && !bd) return 0;
    if (!ad) return 1;
    if (!bd) return -1;
    const asc = ad < bd ? -1 : ad > bd ? 1 : 0;
    return dir === "asc" ? asc : -asc;
  });
}

interface PersistedFilter {
  modes: string[];
  sort: ReplaySortDir;
}

const DEFAULT_FILTER: PersistedFilter = {
  modes: [],
  sort: "desc",
};

/** Load the persisted filter, defending against missing / corrupt /
 *  future blobs: anything unparseable degrades to the session default.
 *  Unknown fields (the retired mode-group sort of wowsp.replayFilter.v1)
 *  are ignored on read and dropped on the next write. */
function loadPersisted(): PersistedFilter {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return { ...DEFAULT_FILTER };
    const v = JSON.parse(raw) as Partial<PersistedFilter> | null;
    return {
      // "" is the no-identity key (a descriptor without matchGroup) —
      // never a valid pick: stale, it couldn't be listed (see
      // collectModeOptions' extras guard) yet would still filter.
      modes: Array.isArray(v?.modes)
        ? v.modes.filter((m): m is string => typeof m === "string" && m.length > 0)
        : [],
      sort: v?.sort === "asc" ? "asc" : "desc",
    };
  } catch {
    return { ...DEFAULT_FILTER };
  }
}

/** Filter + sort state of the replay rail. `list`/`external` are the two
 *  store refs the rail renders; the returned visible pairs are their
 *  filtered, sorted derivatives (external stays a separate block — see the
 *  module doc). */
export function useReplayListFilter(
  list: Ref<readonly ReplayMetaLite[]>,
  external: Ref<readonly ReplayMetaLite[]>,
) {
  const initial = loadPersisted();
  const selectedModes = ref(new Set<string>(initial.modes));
  const sortDir = ref<ReplaySortDir>(initial.sort);

  // Persist on every change; selections are always replaced as a whole Set
  // (never mutated in place), so the watch stays shallow.
  watch([selectedModes, sortDir], () => {
    try {
      localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({
          modes: [...selectedModes.value],
          sort: sortDir.value,
        } satisfies PersistedFilter),
      );
    } catch {
      // Storage unavailable (private mode…) — the filter lives for the session.
    }
  });

  const modeOptions = computed(() =>
    collectModeOptions([...external.value, ...list.value], selectedModes.value),
  );
  const visibleExternal = computed(() =>
    sortReplays(filterReplays([...external.value], selectedModes.value), sortDir.value),
  );
  const visibleList = computed(() =>
    sortReplays(filterReplays([...list.value], selectedModes.value), sortDir.value),
  );
  const filterActive = computed(() => selectedModes.value.size > 0);

  return {
    selectedModes,
    sortDir,
    modeOptions,
    visibleExternal,
    visibleList,
    filterActive,
  };
}

/**
 * The filter trigger itself: a view over the composable's state (the
 * hosting view owns the state so it can also consume the visible lists).
 * Renders the funnel icon button for the rail head's action row — the
 * popup (mode multi-select + the direction-bearing 全部模式 pill) opens
 * anchored to it.
 */
export default defineComponent({
  name: "ReplayListFilter",
  props: {
    modeOptions: {
      type: Array as PropType<{ value: string; label: string }[]>,
      default: () => [],
    },
    selectedModes: { type: Object as PropType<Set<string>>, required: true },
    sortDir: { type: String as PropType<ReplaySortDir>, default: "desc" },
  },
  emits: {
    "update:selectedModes": (_modes: Set<string>) => true,
    "update:sortDir": (_dir: ReplaySortDir) => true,
  },
  setup(props, { emit }) {
    // Popover open flag is pure UI state — the trigger manages its own.
    const modeOpen = ref(false);

    function toggleMode(value: string) {
      const next = new Set(props.selectedModes);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      emit("update:selectedModes", next);
    }

    /** The 全部模式 pill: with a selection it resets; without one it
     *  flips the match-time direction the arrow displays. */
    function modeAllClick() {
      if (props.selectedModes.size > 0) {
        emit("update:selectedModes", new Set<string>());
      } else {
        emit("update:sortDir", props.sortDir === "desc" ? "asc" : "desc");
      }
    }

    return () => (
      <FilterCategoryChip
        title={t("replay.filter.mode")}
        allLabel={t("replay.filter.allModes")}
        options={props.modeOptions}
        selected={props.selectedModes}
        open={modeOpen.value}
        onUpdate:open={(v: boolean) => (modeOpen.value = v)}
        onToggle={toggleMode}
        onAll={modeAllClick}
        dir={props.sortDir}
        pure
        icon={<Filter size={14} />}
        hint={t("replay.filter.modeHint")}
        renderOptionIcon={(value: string) => (
          <span
            class="replay-view__mode-dot"
            style={{ background: modeColorOfKey(value).color }}
          />
        )}
      />
    );
  },
});
