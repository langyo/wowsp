/** Player markers settings section (玩家标记): ONE list — add/remove local
 *  colored markers (red = 消极作战, yellow = 疑似作弊, purple = 隐藏高手)
 *  and review them. The add form collapses into a top-right "+" button
 *  opening a dialog; the search box collapses into a search icon with a
 *  popover; a filter icon hosts the multi-select color group (all players
 *  + the three marks; nothing picked falls back to all). Rows carry the
 *  same configured stat columns as the live roster (the stats prefs own
 *  the column list) and sort by the first configured column, descending.
 *  Removal shows an undo toast. Strictly local data — no login, no sync,
 *  no upload. */
import { computed, defineComponent, ref, watch, type PropType } from "vue";
import type { VNode } from "vue";
import {
  HkButton,
  HkIconButton,
  HkInput,
  HkModal,
  HkPopover,
  HkScrollContainer,
  HkSettingsGroup,
  HkSettingsHint,
  HkTabs,
  useToast,
} from "@celestia-island/hikari";
import { Filter, Plus, Search, X } from "@lucide/vue";

import { t } from "@/i18n";
import { MARKER_COLORS, useMarkersStore } from "@/stores/markers";
import { useAccountStore } from "@/stores/account";
import { prAlgoForRequest, useStatsPrefsStore, type OverlayColumnMetric } from "@/stores/statsPrefs";
import type { MarkerColor, MarkerEntry } from "@/api";
import type { SettingsBodyCtx } from "@/components/settings/useSettingsBody";
import FilterCategoryChip from "@/components/ships/FilterCategoryChip";
import {
  rosterColumns,
  rosterStatCols,
  type RosterColumnSpec,
} from "@/features/replay/postBattleShare";
import { fetchRosterStatsByNames, type RosterStat } from "@/composables/useRosterStats";
import {
  overlayColumnDims,
  resolveRosterBattleScope,
  type RosterModeNumbers,
} from "@/utils/statView";
import { scopedRosterView } from "@/utils/shipStatsScope";
import { markerTintClass } from "@/features/markers/markerTint";
import { markerColorLabel } from "@/features/markers/playerContextMenu";
import { isAiName } from "@/utils/aiNames";
import "./MarkersSection.scss";

/** The color tabs, in the store's list order. */
const COLOR_TAB_LABEL_KEYS: Record<MarkerColor, string> = {
  red: "settings.markersColorRed",
  yellow: "settings.markersColorYellow",
  purple: "settings.markersColorPurple",
};

function colorLabel(color: MarkerColor): string {
  return t(COLOR_TAB_LABEL_KEYS[color]);
}

/** A settled "no stats" roster row: all numbers null, not hidden, not
 *  loading — the cells render their dash face instead of a spinner. */
const EMPTY_ROSTER_STAT: RosterStat = {
  winrate: null,
  pr: null,
  avgDamage: null,
  battles: null,
  kd: null,
  ranked: null,
  global: null,
  solo: null,
  accountId: null,
  clanId: null,
  clanTag: null,
  realm: null,
  hidden: false,
  loading: false,
};

/** The sortable number a column reads off one view. */
function metricValue(
  view: RosterModeNumbers | undefined,
  metric: OverlayColumnMetric,
): number | null {
  if (!view) return null;
  switch (metric) {
    case "winrate":
      return view.winrate;
    case "pr":
      return view.pr;
    case "battles":
      return view.battles;
    case "damage":
      return view.avgDamage;
    case "kd":
      return view.kd;
  }
}

export default defineComponent({
  name: "SettingsMarkersSection",
  props: {
    ctx: { type: Object as PropType<SettingsBodyCtx>, required: true },
  },
  setup() {
    const store = useMarkersStore();
    void store.ensureLoaded();
    const prefs = useStatsPrefsStore();
    const account = useAccountStore();
    const toast = useToast();

    // ── add dialog ────────────────────────────────────────────────────
    const addOpen = ref(false);
    const nameInput = ref("");
    const noteInput = ref("");
    const color = ref<MarkerColor>("red");
    const adding = ref(false);

    function colorTabs() {
      return MARKER_COLORS.map((key) => ({ key, label: colorLabel(key) }));
    }

    async function addMarker(): Promise<void> {
      const nickname = nameInput.value.trim();
      if (!nickname || adding.value) return;
      adding.value = true;
      try {
        await store.add(nickname, color.value, noteInput.value.trim() || null);
        nameInput.value = "";
        noteInput.value = "";
        addOpen.value = false;
      } finally {
        adding.value = false;
      }
    }

    // ── search (icon + popover) ───────────────────────────────────────
    const search = ref("");
    const searchOpen = ref(false);
    const searchBtn = ref<HTMLElement | null>(null);

    // ── color filter (icon + multi-select group) ──────────────────────
    const filterOpen = ref(false);
    const filterColors = ref<Set<string>>(new Set());
    const colorOptions = computed(() =>
      MARKER_COLORS.map((key) => ({ value: key as string, label: colorLabel(key) })),
    );
    function toggleColor(value: string): void {
      const next = new Set(filterColors.value);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      filterColors.value = next;
    }
    /** The 全部玩家 pill: nothing picked shows every player (the default). */
    function resetColors(): void {
      filterColors.value = new Set();
    }

    // ── stats columns (shared with the live roster's prefs) ───────────
    const columns = computed<RosterColumnSpec[]>(() => rosterColumns());
    const battleScope = computed(() => resolveRosterBattleScope(prefs.prefs.overlayBattleScope, {}));
    const viewOf = (st: RosterStat, scope: RosterColumnSpec["scope"]): RosterModeNumbers =>
      scopedRosterView(
        st,
        null,
        overlayColumnDims(scope, prefs.prefs.overlayBattleScope),
        battleScope.value,
        prAlgoForRequest() ?? "winrate",
      );

    const statsMap = ref<Map<string, RosterStat>>(new Map());
    const statsLoading = ref(false);
    // activeRealm defaults to "asia" before an account is bound — the
    // list still shows numbers (other surfaces read the same realm).
    const realm = computed(() => account.activeRealm);
    let fetchSeq = 0;
    async function refreshStats(): Promise<void> {
      const seq = ++fetchSeq;
      const names = store.entries.map((e) => e.nickname).filter((n) => !isAiName(n));
      const rl = realm.value;
      if (!rl || names.length === 0) {
        statsMap.value = new Map();
        return;
      }
      statsLoading.value = true;
      try {
        const map = await fetchRosterStatsByNames(names, rl, (name, entry) => {
          if (seq !== fetchSeq) return;
          const next = new Map(statsMap.value);
          next.set(name, entry);
          statsMap.value = next;
        });
        if (seq === fetchSeq) {
          // Names the batch could not resolve get a settled all-null
          // entry: rosterStatCols renders a dash for a present-but-empty
          // stat and a forever-spinner for a missing one.
          const settled = new Map(map);
          for (const name of names) {
            if (!settled.has(name)) settled.set(name, EMPTY_ROSTER_STAT);
          }
          statsMap.value = settled;
        }
      } catch {
        // A rejected batch must not leave rows spinning forever: settle
        // every name into its dash face.
        if (seq === fetchSeq) {
          const settled = new Map<string, RosterStat>();
          for (const name of names) settled.set(name, EMPTY_ROSTER_STAT);
          statsMap.value = settled;
        }
      } finally {
        if (seq === fetchSeq) statsLoading.value = false;
      }
    }
    watch(
      () => [store.entries.map((e) => e.nickname).join("\n"), realm.value] as const,
      () => void refreshStats(),
      { immediate: true },
    );

    // ── rows: search + color filter, sorted by the first column ───────
    const filtered = computed<MarkerEntry[]>(() => {
      const q = search.value.trim().toLowerCase();
      return store.entries
        .filter(
          (entry) => filterColors.value.size === 0 || filterColors.value.has(entry.color),
        )
        .filter(
          (entry) =>
            !q ||
            entry.nickname.toLowerCase().includes(q) ||
            (entry.note ?? "").toLowerCase().includes(q) ||
            String(entry.accountId ?? "").includes(q),
        );
    });

    /** The first configured column's number for one entry (the list's sort). */
    function sortValue(entry: MarkerEntry, column: RosterColumnSpec): number | null {
      const st = statsMap.value.get(entry.nickname);
      if (!st) return null;
      return metricValue(viewOf(st, column.scope), column.metric);
    }
    const rows = computed<MarkerEntry[]>(() => {
      const list = [...filtered.value];
      const first = columns.value[0];
      if (first) {
        list.sort((a, b) => {
          const va = sortValue(a, first);
          const vb = sortValue(b, first);
          if (va == null && vb == null) return a.nickname.localeCompare(b.nickname);
          if (va == null) return 1; // unknown / hidden stats sink
          if (vb == null) return -1;
          // Equal numbers tie-break by nickname (stable, locale-aware).
          return vb - va || a.nickname.localeCompare(b.nickname);
        });
      }
      return list;
    });

    const countText = computed(() =>
      t("settings.markersCount", { n: store.entries.length }),
    );

    /** Remove + an undo toast (restoring the exact entry) so a misclick
     *  never loses a mark. */
    async function removeEntry(entry: MarkerEntry): Promise<void> {
      const { nickname, color: entryColor, note, accountId } = entry;
      await store.remove(nickname);
      toast.show(t("settings.markersRemoved", { name: nickname }), {
        type: "success",
        duration: 8000,
        action: {
          label: t("settings.markersUndo"),
          onClick: () => {
            void store.add(nickname, entryColor, note ?? null, accountId ?? null);
          },
        },
      });
    }

    const statCells = (entry: MarkerEntry): VNode[] =>
      rosterStatCols(
        entry.nickname,
        statsMap.value,
        statsLoading.value,
        (st, scope) => viewOf(st, scope),
      ) as unknown as VNode[];

    return () => (
      <HkSettingsGroup title={t("settings.markersTitle")}>
        <HkSettingsHint>{t("settings.markersHint")}</HkSettingsHint>
        <div class="markers-section__toolbar">
          {/* Search collapses to an icon; the field lives in the popover. */}
          <button
            type="button"
            ref={searchBtn}
            class={[
              "markers-section__icon-btn",
              searchOpen.value || search.value.trim() ? "markers-section__icon-btn--on" : "",
            ]}
            aria-label={t("settings.markersSearchPlaceholder")}
            data-hint={t("settings.markersSearchPlaceholder")}
            onClick={() => {
              filterOpen.value = false;
              searchOpen.value = !searchOpen.value;
            }}
          >
            <Search size={14} />
          </button>
          <HkPopover
            modelValue={searchOpen.value}
            onUpdate:modelValue={(v: boolean) => {
              if (!v) searchOpen.value = false;
            }}
            anchorRef={searchBtn.value}
            placement="bottom-end"
            padding="lg"
            title={t("settings.markersSearchPlaceholder")}
          >
            <div class="markers-section__pop">
              <HkInput
                modelValue={search.value}
                onUpdate:modelValue={(v: string) => (search.value = v)}
                placeholder={t("settings.markersSearchPlaceholder")}
              />
            </div>
          </HkPopover>
          {/* Filter collapses to the funnel; the popover hosts the
              multi-select color pills (全部玩家 + the three marks). */}
          <FilterCategoryChip
            title={t("settings.markersFilterTitle")}
            allLabel={t("settings.markersFilterAll")}
            options={colorOptions.value}
            selected={filterColors.value}
            open={filterOpen.value}
            onUpdate:open={(v: boolean) => {
              if (v) searchOpen.value = false;
              filterOpen.value = v;
            }}
            onToggle={(value: string) => toggleColor(value)}
            onAll={() => resetColors()}
            icon={<Filter size={14} /> as unknown as VNode}
            hint={t("settings.markersFilterHint")}
            engaged={filterColors.value.size > 0}
          />
          <span class="markers-section__muted">{countText.value}</span>
          <HkIconButton
            class="markers-section__add-btn"
            variant="ghost"
            aria-label={t("settings.markersAddTitle")}
            data-hint={t("settings.markersAddTitle")}
            onClick={() => (addOpen.value = true)}
          >
            <Plus size={15} />
          </HkIconButton>
        </div>
        <HkScrollContainer class="markers-section__list">
          <div class="markers-section__list-inner">
            {rows.value.length === 0 ? (
              <p class="markers-section__muted">{t("settings.markersEmpty")}</p>
            ) : (
              rows.value.map((entry) => (
                <div
                  class="markers-section__entry"
                  key={entry.nickname}
                  data-player-name={entry.nickname}
                  data-player-account={
                    entry.accountId != null ? String(entry.accountId) : undefined
                  }
                >
                  <span
                    class={["markers-section__dot", `markers-section__dot--${entry.color}`]}
                    title={colorLabel(entry.color)}
                  />
                  <span
                    class={["markers-section__entry-name", markerTintClass(entry.color)]}
                    title={markerColorLabel(entry.color)}
                  >
                    {entry.nickname}
                  </span>
                  {entry.note ? (
                    <span class="markers-section__entry-note">{entry.note}</span>
                  ) : null}
                  <span class="markers-section__entry-id">
                    {entry.accountId ?? ""}
                  </span>
                  <span class="markers-section__stats">{statCells(entry)}</span>
                  <HkIconButton
                    class="markers-section__remove-btn"
                    variant="ghost"
                    aria-label={t("settings.markersRemove")}
                    data-hint={t("settings.markersRemove")}
                    onClick={() => void removeEntry(entry)}
                  >
                    <X size={14} />
                  </HkIconButton>
                </div>
              ))
            )}
          </div>
        </HkScrollContainer>
        <HkModal
          modelValue={addOpen.value}
          onUpdate:modelValue={(v: boolean) => (addOpen.value = v)}
          title={t("settings.markersAddTitle")}
          width="28rem"
        >
          <div class="markers-section__add">
            <div class="markers-section__add-row">
              <div class="markers-section__add-input">
                <HkInput
                  modelValue={nameInput.value}
                  onUpdate:modelValue={(v: string) => (nameInput.value = v)}
                  placeholder={t("settings.markersNamePlaceholder")}
                  submitOnEnter={() => void addMarker()}
                />
              </div>
              <div class="markers-section__add-input">
                <HkInput
                  modelValue={noteInput.value}
                  onUpdate:modelValue={(v: string) => (noteInput.value = v)}
                  placeholder={t("settings.markersNotePlaceholder")}
                  submitOnEnter={() => void addMarker()}
                />
              </div>
            </div>
            <HkTabs
              block
              variant="segmented"
              modelValue={color.value}
              onUpdate:modelValue={(v: string) => (color.value = v as MarkerColor)}
              tabs={colorTabs()}
            />
            <div class="markers-section__add-actions">
              <HkButton
                size="sm"
                disabled={!nameInput.value.trim() || adding.value}
                onClick={() => void addMarker()}
              >
                {t("settings.markersAdd")}
              </HkButton>
            </div>
          </div>
        </HkModal>
      </HkSettingsGroup>
    );
  },
});
