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
 *     order, no separate sort chip;
 *   - a date-range pair (时间段) lives INSIDE the popup, under the option
 *     strip (FilterCategoryChip's default slot): two hikari HkDatePicker
 *     inputs (from / to, inclusive on the local match day, cross-linked by
 *     min/max so an invalid range can never form). They narrow the SAME two
 *     blocks as the mode picks, which is what makes the versioned replay
 *     archives navigable — the scan lists every archived subfolder replay
 *     now, so a year-plus of history needs a time window to browse. With a
 *     window set and no mode picked, the funnel wears the engaged look
 *     (FilterCategoryChip's `engaged`); the inputs sit behind the popup, so
 *     an active window must not leave the trigger reading idle.
 *     Session-only by design (see useReplayListFilter).
 *   - ABOVE that date pair the popup carries the two single-select
 *     dimensions of the multi-client rail: 客户端 (the owning install, by
 *     installPath — the replay's server identity) and 玩家 (the recorder's
 *     nickname). Both are plain HkSelect dropdowns whose first option is
 *     the "" sentinel (FILTER_ANY): the rail lists replays from EVERY
 *     detected client, so "which install recorded this" and "which of my
 *     nicknames recorded this" are the two questions the mode/date
 *     dimensions cannot answer. The client options come from the HOST
 *     (installs are the host's data); the player options derive from the
 *     entries themselves (collectPlayerOptions). Both picks PERSIST —
 *     unlike the date window, they mean the same thing on the next visit —
 *     and both engage the funnel's look while set, same as the window.
 *
 * External picks (session-temporary files from outside the replays folder)
 * stay PINNED above the scanned list; the filter and the sort apply to both
 * blocks independently, so the pinning survives any selection. Selection
 * persists to localStorage; stored modes absent from the current list stay
 * listed (and clearable) in the chip until dropped — see
 * collectModeOptions; the same contract holds for a stale player pick.
 */
import { computed, defineComponent, ref, watch, type PropType, type Ref } from "vue";

import { Filter } from "@lucide/vue";
import { HkDatePicker, HkSelect } from "@celestia-island/hikari";

import { t } from "@/i18n";
import type { ReplayMetaLite } from "@/api";
import { sameGamePath } from "@/utils/gamePath";
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

/** The 全部 sentinel of the two single-select dimensions (client / player):
 *  "" narrows nothing on its dimension. It is exactly the value the
 *  persistence loader substitutes for a missing pick, so a cleared dropdown
 *  and a fresh session read the same state — no separate null sentinel. */
export const FILTER_ANY = "";

/** Player-nickname options for the filter's player dropdown: the distinct
 *  non-empty `playerName`s the rail actually holds, most-played FIRST
 *  (descending occurrence count — the user's own nickname usually wins),
 *  ties broken by locale compare so the row order is deterministic. The
 *  labels are the nicknames verbatim: a nickname is a proper noun and reads
 *  the same in every locale, so nothing is localized. `extras` (the
 *  persisted pick) are APPENDED LAST when absent from the data — a stale
 *  pick must stay listed (and clearable) instead of vanishing with its
 *  filter still engaged, the same contract as collectModeOptions. */
export function collectPlayerOptions(
  metas: Iterable<ReplayMetaLite>,
  extras: Iterable<string> = [],
): string[] {
  const counts = new Map<string, number>();
  for (const m of metas) {
    const name = m.playerName;
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
  const listed = new Set(names);
  for (const extra of extras) {
    if (!extra || listed.has(extra)) continue;
    listed.add(extra);
    names.push(extra);
  }
  return names;
}

/** Keep only replays whose owning install is `client` — the installPath the
 *  client dropdown carries. Path identity goes through `sameGamePath`
 *  (case- and separator-insensitive), never raw `===`: detection feeds the
 *  same folder through several spellings (registry casing, Steam's vdf
 *  separators), so a strict compare would silently drop a client's own
 *  files. `FILTER_ANY` (any empty / absent value) is the identity and
 *  passes everything, untagged entries under unowned roots included —
 *  only a concrete pick excludes those (they belong to no client). */
export function filterByClient<T extends ReplayMetaLite>(metas: T[], client: string): T[] {
  if (!client) return metas;
  return metas.filter((r) => sameGamePath(r.installPath, client));
}

/** Keep only replays recorded by `player` — an EXACT (case-sensitive)
 *  match on the recorder's nickname, the same vocabulary
 *  collectPlayerOptions lists. Nicknames are user-chosen proper nouns, so
 *  case-folding them here would merge distinct accounts. `FILTER_ANY` is
 *  the identity; once a nickname is picked, entries without a playerName
 *  cannot equal it and drop out. */
export function filterByPlayer<T extends ReplayMetaLite>(metas: T[], player: string): T[] {
  if (!player) return metas;
  return metas.filter((r) => r.playerName === player);
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

/** The replay's local calendar day as `YYYY-MM-DD` (null when the
 *  filename stamp is missing or not a real calendar date) — the bucket the
 *  date-range filter windows on. Same shape battleDayKey (battleBreakdown)
 *  emits for the playtime heatmap, reimplemented here so the replay chunk
 *  never pulls the playtime module (and its bundled ship DB) into its
 *  import graph. The Date round-trip rejects rolled-over junk such as a
 *  hypothetical 20260230. */
export function replayDayKeyOf(r: ReplayMetaLite): string | null {
  const dt = r.dateTime;
  if (!dt || !/^\d{8}/.test(dt)) return null;
  const y = Number(dt.slice(0, 4));
  const m = Number(dt.slice(4, 6));
  const d = Number(dt.slice(6, 8));
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null;
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Keep only replays whose local match day falls in [from, to] — both
 *  bounds inclusive ISO `YYYY-MM-DD` (lexicographic IS chronological for
 *  that shape, but ONLY for zero-padded keys: callers must pass padded
 *  dates, which every in-app bound is — HkDatePicker's model speaks ISO
 *  natively). Both bounds null is the identity and passes the input
 *  through untouched; with any bound set, entries without a parsable day
 *  cannot sit inside a calendar window and drop out (the same exclusion
 *  rule the playtime heatmap's battlesDaily applies). */
export function filterByDateRange<T extends ReplayMetaLite>(
  metas: T[],
  from: string | null,
  to: string | null,
): T[] {
  if (from === null && to === null) return metas;
  return metas.filter((r) => {
    const day = replayDayKeyOf(r);
    if (!day) return false;
    if (from !== null && day < from) return false;
    if (to !== null && day > to) return false;
    return true;
  });
}

interface PersistedFilter {
  modes: string[];
  sort: ReplaySortDir;
  /** Owning install's path — the client pick (FILTER_ANY = 全部客户端). */
  client: string;
  /** Recorder's nickname — the player pick (FILTER_ANY = 全部玩家). */
  player: string;
}

const DEFAULT_FILTER: PersistedFilter = {
  modes: [],
  sort: "desc",
  client: FILTER_ANY,
  player: FILTER_ANY,
};

/** Load the persisted filter, defending against missing / corrupt /
 *  future blobs: anything unparseable degrades to the session default.
 *  Unknown fields (the retired mode-group sort of wowsp.replayFilter.v1)
 *  are ignored on read and dropped on the next write. The blob KEEPS the
 *  v1 key: the two single-select dimensions are additive, so an old blob
 *  simply loads with them at FILTER_ANY. */
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
      // Wrong type (an old blob's number, a hand-edited object) degrades
      // to FILTER_ANY — never to a value that would filter: a pick must
      // only ever come from a dropdown, which writes strings.
      client: typeof v?.client === "string" ? v.client : FILTER_ANY,
      player: typeof v?.player === "string" ? v.player : FILTER_ANY,
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
  // The two single-select dimensions — the owning install (client) and the
  // recorder's nickname (player). Both PERSIST, unlike the date window
  // below: a client or nickname pick means the same thing on the next
  // visit (the same install is still there, the same nickname is still
  // yours), so restoring it keeps the rail where the user left it; an
  // absolute date window would instead greet the next visit as a stale
  // slice of history.
  const selectedClient = ref<string>(initial.client);
  const selectedPlayer = ref<string>(initial.player);
  // The date-range bounds — session-only by design: unlike the mode picks
  // and the sort direction (evergreen preferences worth restoring), an
  // absolute from/to window goes STALE by the next visit (last month's
  // "recent" slice would greet the user as an unexplained short list), so
  // the range never touches the persisted blob.
  const dateFrom = ref<string | null>(null);
  const dateTo = ref<string | null>(null);

  // Persist on every change; selections are always replaced as a whole Set
  // (never mutated in place), so the watch stays shallow.
  watch([selectedModes, sortDir, selectedClient, selectedPlayer], () => {
    try {
      localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({
          modes: [...selectedModes.value],
          sort: sortDir.value,
          client: selectedClient.value,
          player: selectedPlayer.value,
        } satisfies PersistedFilter),
      );
    } catch {
      // Storage unavailable (private mode…) — the filter lives for the session.
    }
  });

  /** One block's visible order: mode → date window → client → player, then
   *  the match-time sort. Every narrowing is a pure filter, so the order
   *  among them is immaterial — it is fixed HERE once so both blocks (the
   *  external pin and the scanned list) run the exact same pipeline. */
  function visibleOf(block: readonly ReplayMetaLite[]): ReplayMetaLite[] {
    const byMode = filterReplays([...block], selectedModes.value);
    const byDate = filterByDateRange(byMode, dateFrom.value, dateTo.value);
    const byClient = filterByClient(byDate, selectedClient.value);
    return sortReplays(filterByPlayer(byClient, selectedPlayer.value), sortDir.value);
  }

  const modeOptions = computed(() =>
    collectModeOptions([...external.value, ...list.value], selectedModes.value),
  );
  // Nickname options span BOTH blocks (an external pick carries a nickname
  // too), with the persisted pick as an extra so a stale one stays listed.
  const playerOptions = computed(() =>
    collectPlayerOptions([...external.value, ...list.value], [selectedPlayer.value]),
  );
  const visibleExternal = computed(() => visibleOf(external.value));
  const visibleList = computed(() => visibleOf(list.value));
  const filterActive = computed(
    () =>
      selectedModes.value.size > 0 ||
      dateFrom.value !== null ||
      dateTo.value !== null ||
      selectedClient.value !== FILTER_ANY ||
      selectedPlayer.value !== FILTER_ANY,
  );

  return {
    selectedModes,
    sortDir,
    dateFrom,
    dateTo,
    selectedClient,
    selectedPlayer,
    modeOptions,
    playerOptions,
    visibleExternal,
    visibleList,
    filterActive,
  };
}

/**
 * The filter trigger itself: a view over the composable's state (the
 * hosting view owns the state so it can also consume the visible lists).
 * Renders the funnel icon button for the rail head's action row — the
 * popup (mode multi-select + the direction-bearing 全部模式 pill + the
 * client/player single-selects + the date-range pair in the chip's
 * default slot) opens anchored to it.
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
    /** Inclusive ISO `YYYY-MM-DD` bounds of the date window (null = open). */
    dateFrom: { type: String as PropType<string | null>, default: null },
    dateTo: { type: String as PropType<string | null>, default: null },
    /** The client (owning install) pick; FILTER_ANY = 全部客户端. The
     *  options are the HOST's — installs are the host's data, so the
     *  filter module stays install-agnostic and only compares paths. */
    selectedClient: { type: String, default: FILTER_ANY },
    clientOptions: {
      type: Array as PropType<{ value: string; label: string }[]>,
      default: () => [],
    },
    /** The recorder-nickname pick; FILTER_ANY = 全部玩家. */
    selectedPlayer: { type: String, default: FILTER_ANY },
    playerOptions: { type: Array as PropType<string[]>, default: () => [] },
  },
  emits: {
    "update:selectedModes": (_modes: Set<string>) => true,
    "update:sortDir": (_dir: ReplaySortDir) => true,
    "update:dateFrom": (_v: string | null) => true,
    "update:dateTo": (_v: string | null) => true,
    "update:selectedClient": (_v: string) => true,
    "update:selectedPlayer": (_v: string) => true,
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
        engaged={
          props.dateFrom !== null ||
          props.dateTo !== null ||
          props.selectedClient !== FILTER_ANY ||
          props.selectedPlayer !== FILTER_ANY
        }
        renderOptionIcon={(value: string) => (
          <span
            class="replay-view__mode-dot"
            style={{ background: modeColorOfKey(value).color }}
          />
        )}
      >
        {/* The two single-select rows lead the slot, above the date pair:
            the owning client (install) and the recorder's nickname. The
            rail lists replays from EVERY detected client, so these are the
            questions mode/date cannot answer. Each is one HkSelect — it
            renders its own label, so the rows carry no extra label span
            (unlike the date row, whose pickers have none). A pick rides
            out as the host-level update event; the FILTER_ANY sentinel is
            both the 全部 option's value and the "cleared" state. */}
        <div class="replay-view__pop-select">
          <HkSelect
            label={t("replay.filter.client")}
            options={[
              { value: FILTER_ANY, label: t("replay.filter.allClients") },
              ...props.clientOptions,
            ]}
            placeholder={t("replay.filter.allClients")}
            modelValue={props.selectedClient}
            onUpdate:modelValue={(v: string) => emit("update:selectedClient", v)}
          />
        </div>
        <div class="replay-view__pop-select">
          <HkSelect
            label={t("replay.filter.player")}
            options={[
              { value: FILTER_ANY, label: t("replay.filter.allPlayers") },
              ...props.playerOptions.map((n) => ({ value: n, label: n })),
            ]}
            placeholder={t("replay.filter.allPlayers")}
            modelValue={props.selectedPlayer}
            onUpdate:modelValue={(v: string) => emit("update:selectedPlayer", v)}
          />
        </div>
        {/* The date-range pair — living INSIDE the mode popup (labeled row
            under the option strip) so the action row stays one square
            icon-button family. Each picker still opens its OWN calendar
            popup: it teleports to body level like the panel itself, and
            the chip's outside-close lets presses inside any open
            .hk-popover-panel through (FilterCategoryChip's slot
            contract), so the two never fight. min/max cross-link so an
            invalid from > to window can never form; each input clears
            itself. */}
        <div class="replay-view__pop-dates">
          <span class="replay-view__pop-dates-label">
            {t("replay.filter.dateRange")}
          </span>
          <HkDatePicker
            size="sm"
            modelValue={props.dateFrom}
            onUpdate:modelValue={(v: string | null) => emit("update:dateFrom", v)}
            placeholder={t("replay.filter.dateFrom")}
            max={props.dateTo ?? undefined}
          />
          <HkDatePicker
            size="sm"
            modelValue={props.dateTo}
            onUpdate:modelValue={(v: string | null) => emit("update:dateTo", v)}
            placeholder={t("replay.filter.dateTo")}
            min={props.dateFrom ?? undefined}
          />
        </div>
      </FilterCategoryChip>
    );
  },
});
