/**
 * The water-table column editor: the configured roster columns as
 * DRAGGABLE CARDS in one never-wrapping row (1–5 cards; the popover
 * widens to the row's natural width before any label has to shrink),
 * plus the add-connector — a plus icon button on the cluster header's
 * right end opening a tooltip-style popover with two segmented button
 * groups (数据范围: 全局/仅单排/仅单船/仅单船单排/仅当前舰种; 指标: 场均/PR/胜率/
 * 场次) and a confirm-add button at the bottom right.
 *
 * Mounted TWICE on the store's own columns: the settings page's 显示内容
 * section, and the live panel head's stats-source chip popover
 * (LiveStatsModeChip — the very filter that used to host the retired
 * three-row dimension groups), so the columns are editable right where
 * they render. An external mount can supply its list through the
 * `columns`/`limit`/`allowedScopes`/`onChange` props instead, getting
 * the identical drag/edit experience without a second editor.
 *
 * The drag rides hikari's OWN HkDraggableList primitive with
 * axis="horizontal" (hikari #1063, shipped in 0.55.276): the pressed card
 * arms past the primitive's 5px |dx| threshold (the hand-rolled port this
 * replaces armed at 6px), a translucent GHOST clone teleports to <body>
 * and follows the pointer on BOTH axes with ancestorZoom applied inside
 * the primitive (imported from @celestia-island/hikari/runtime there —
 * this editor's verbatim copy of that helper retired with the port), a
 * 2px primary line on the drop slot's leading/trailing edge
 * (data-placeholder="before"/"after") marks where the card lands, and the
 * primitive emits reorder(from, to) ONCE at pointerup into the splice +
 * commit path below — the cards themselves never move mid-drag.
 *
 * ACCEPTED CONTRACT DELTA (#1736): the primitive's horizontal axis NEVER
 * wraps — one flex-nowrap line whose slots shrink via min-width: 0, with
 * the plain single-line midpoint walk for the placeholder. The old
 * port's sub-767px wrapped-row band targeting has no primitive equivalent
 * and retires: on phones the row stays ONE line and the card labels
 * ellipsize instead of folding onto a second row (the popover docks as a
 * bottom sheet there, and #1256's max-content sizing still widens the
 * panel to the row's natural width wherever the viewport allows).
 *
 * Every mutation writes the shared statsPrefs store (setOverlayColumns),
 * so the live panel, the post-battle panels and the Tab overlay apply it
 * immediately — the panels through the store's reactivity, the overlay
 * window through its broadcast.
 */
import { computed, defineComponent, nextTick, ref, watch, type PropType } from "vue";

import { Plus, Trash2, GripHorizontal } from "@lucide/vue";
import {
  HkButton,
  HkDraggableList,
  HkIconButton,
  HkPopover,
  HkTabs,
  useBreakpoint,
  type DragListItem,
} from "@celestia-island/hikari";

import { t } from "@/i18n";
import {
  OVERLAY_COLUMN_LIMIT,
  useStatsPrefsStore,
  type OverlayColumn,
  type OverlayColumnMetric,
  type OverlayColumnScope,
} from "@/stores/statsPrefs";
import "./OverlayColumnsEditor.scss";

/** scope value → its option's i18n key (render-time `t()` — the label
 *  must follow the loaded locale, never the module-import-time one). */
const SCOPE_KEY: Record<OverlayColumnScope, string> = {
  global: "settings.overlayContent.colScopeGlobal",
  solo: "settings.overlayContent.colScopeSolo",
  ship: "settings.overlayContent.colScopeShip",
  shipSolo: "settings.overlayContent.colScopeShipSolo",
  class: "settings.overlayContent.colScopeClass",
};

/** metric value → its option's i18n key. */
const METRIC_KEY: Record<OverlayColumnMetric, string> = {
  winrate: "settings.overlayContent.colMetricWinrate",
  pr: "settings.overlayContent.colMetricPr",
  battles: "settings.overlayContent.colMetricBattles",
  damage: "settings.overlayContent.colMetricDamage",
  kd: "settings.overlayContent.colMetricKd",
};

/** The add-menu's metric options (the issue-1082 ordering: 场均/PR/胜率/
 *  场次, 击杀比 appended when it joined the set), render-time for the same
 *  reason. */
const metricTabs = () =>
  (["damage", "pr", "winrate", "battles", "kd"] as OverlayColumnMetric[]).map((key) => ({
    key,
    label: t(METRIC_KEY[key]),
  }));

const scopeLabel = (scope: OverlayColumnScope): string => t(SCOPE_KEY[scope]);

const metricLabel = (metric: OverlayColumnMetric): string => t(METRIC_KEY[metric]);

/** The primitive's row identity: the composite `scope:metric` key (the
 *  same string the add guard dedupes against), with the column's fields
 *  riding along so the item slot reads them without re-parsing. */
type ColumnDragItem = DragListItem & OverlayColumn;

export default defineComponent({
  name: "OverlayColumnsEditor",
  props: {
    /** An EXTERNALLY-owned column list — when omitted (every current
     *  mount) the editor drives the statsPrefs store's overlayColumns
     *  itself. An external mount passes its own list + commit callback
     *  here, so the exact same drag/edit surface serves both owners. */
    columns: { type: Array as PropType<OverlayColumn[]>, default: undefined },
    /** The list's cardinality cap (defaults to OVERLAY_COLUMN_LIMIT). */
    limit: { type: Number, default: undefined },
    /** When given, the add-menu's scope group offers ONLY these scopes.
     *  Undefined = every scope. */
    allowedScopes: { type: Array as PropType<OverlayColumnScope[]>, default: undefined },
    /** The commit path for an externally-owned list — every mutation
     *  (reorder / remove / add) funnels through here, exactly once per
     *  gesture (the drag commits at pointerup only). Ignored (the store
     *  writes instead) when `columns` is omitted. */
    onChange: {
      type: Function as PropType<(cols: OverlayColumn[]) => void>,
      default: undefined,
    },
  },
  setup(props) {
    const prefs = useStatsPrefsStore();
    // Phone LAYOUT (viewport) — drives the popover's sheet docking flag.
    const { isMobile: phoneLayout } = useBreakpoint();
    // The list under edit: the caller's when props.columns is given, the
    // store's overlayColumns otherwise — identical either way downstream.
    const columns = computed(() => props.columns ?? prefs.prefs.overlayColumns);
    const limit = computed(() => props.limit ?? OVERLAY_COLUMN_LIMIT);
    /** The one commit path — the store for the legacy mounts, the
     *  caller's callback for an externally-owned list. */
    function commit(next: OverlayColumn[]) {
      if (props.columns != null) {
        props.onChange?.(next);
      } else {
        prefs.setOverlayColumns(next);
      }
    }
    /** The add-menu's scope options — the settings' canonical order,
     *  filtered down to allowedScopes when the mount restricts them;
     *  built at RENDER time so the labels follow the loaded locale. */
    const scopeTabs = () =>
      (Object.keys(SCOPE_KEY) as OverlayColumnScope[])
        .filter((key) => !props.allowedScopes || props.allowedScopes.includes(key))
        .map((key) => ({ key, label: t(SCOPE_KEY[key]) }));

    // ── Cards row: HkDraggableList axis="horizontal" ────────────────────
    // The primitive owns the whole pointer model (arm / ghost /
    // placeholder walk / commit-once-at-pointerup); the host maps its
    // items onto the columns and lands the emitted reorder in the same
    // splice the retired hand-rolled pointerup used.
    const dragItems = computed<ColumnDragItem[]>(() =>
      columns.value.map((col) => ({
        key: `${col.scope}:${col.metric}`,
        scope: col.scope,
        metric: col.metric,
      })),
    );

    /** The primitive's ONE reorder emit — from/to indexes straight into
     *  the list positions (the cards never moved mid-drag). */
    function onReorder(from: number, to: number) {
      const next = [...columns.value];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      commit(next);
    }

    function removeAt(index: number) {
      const next = [...columns.value];
      next.splice(index, 1);
      commit(next);
    }

    // ── Add menu ────────────────────────────────────────────────────────
    const addOpen = ref(false);
    // The popover anchors (and focus returns) to the NATIVE wrapper span —
    // a ref on the HkIconButton component would hand HkPopover the
    // component instance, not an element (its anchorRef is HTMLElement).
    const addBtn = ref<HTMLElement | null>(null);
    const selScope = ref<OverlayColumnScope>("global");
    const selMetric = ref<OverlayColumnMetric>("winrate");

    const atLimit = computed(() => columns.value.length >= limit.value);
    const comboExists = computed(() =>
      columns.value.some(
        (c) => c.scope === selScope.value && c.metric === selMetric.value,
      ),
    );
    const canAdd = computed(() => !atLimit.value && !comboExists.value);

    /** Opening the menu lands on the first FREE combo (scope-major), so
     *  the confirm button starts enabled whenever anything is addable.
     *  Both walks honor allowedScopes; when EVERYTHING is taken the
     *  fallback lands on the first allowed scope (the confirm button is
     *  disabled there anyway — at the limit or a dup). */
    function firstFreeCombo(): {
      scope: OverlayColumnScope;
      metric: OverlayColumnMetric;
    } {
      const scopes = scopeTabs();
      for (const s of scopes) {
        for (const m of metricTabs()) {
          if (!columns.value.some((c) => c.scope === s.key && c.metric === m.key)) {
            return { scope: s.key, metric: m.key };
          }
        }
      }
      return { scope: scopes[0]?.key ?? "global", metric: "winrate" };
    }
    watch(addOpen, (open) => {
      if (open) {
        const free = firstFreeCombo();
        selScope.value = free.scope;
        selMetric.value = free.metric;
      }
    });

    function confirmAdd() {
      if (!canAdd.value) return;
      commit([...columns.value, { scope: selScope.value, metric: selMetric.value }]);
      addOpen.value = false;
      // The popover tears down its content on close; refocusing the plus
      // keeps keyboard users on the connector they just used.
      void nextTick(() => addBtn.value?.querySelector("button")?.focus());
    }

    return () => {
      const cards = columns.value.length > 0;
      return (
        <div class="overlay-columns">
          {/* Cluster header: the label (+ live count) on the left, the add
              connector on the RIGHT END — the issue-1082 spec. */}
          <div class="overlay-columns__head">
            <span class="overlay-columns__label">
              {t("settings.overlayContent.columnsLabel")}
              <span class="overlay-columns__count">
                {columns.value.length}/{limit.value}
              </span>
            </span>
            <span
              ref={addBtn}
              class="overlay-columns__add"
              data-hint={
                atLimit.value
                  ? t("settings.overlayContent.colLimitHint", { limit: limit.value })
                  : t("settings.overlayContent.colAdd")
              }
            >
              <HkIconButton
                variant="ghost"
                size={24}
                disabled={atLimit.value}
                aria-label={t("settings.overlayContent.colAdd")}
                onClick={() => (addOpen.value = !addOpen.value)}
              >
                <Plus size={16} />
              </HkIconButton>
            </span>
            <HkPopover
              modelValue={addOpen.value}
              onUpdate:modelValue={(v: boolean) => {
                if (!v) addOpen.value = false;
              }}
              anchorRef={addBtn.value}
              placement="bottom-end"
              padding="lg"
              title={t("settings.overlayContent.colAdd")}
              /* Phones never float anchored menus (repo convention): the
               * add-column panel docks as a bottom sheet. */
              sheetOnMobile
              closeOnBackdrop={phoneLayout.value}
            >
              <div class="overlay-columns__menu">
                <div class="overlay-columns__menu-group">
                  <span class="overlay-columns__menu-label">
                    {t("settings.overlayContent.colScope")}
                  </span>
                  <HkTabs
                    variant="segmented"
                    modelValue={selScope.value}
                    onUpdate:modelValue={(v: string) =>
                      (selScope.value = v as OverlayColumnScope)
                    }
                    tabs={scopeTabs()}
                  />
                </div>
                <div class="overlay-columns__menu-group">
                  <span class="overlay-columns__menu-label">
                    {t("settings.overlayContent.colMetric")}
                  </span>
                  <HkTabs
                    variant="segmented"
                    modelValue={selMetric.value}
                    onUpdate:modelValue={(v: string) =>
                      (selMetric.value = v as OverlayColumnMetric)
                    }
                    tabs={metricTabs()}
                  />
                </div>
                {/* The menu's own copy keeps up with the selection: what the
                    confirm button would add, or why it cannot. */}
                <div class="overlay-columns__menu-foot">
                  <span class="overlay-columns__menu-hint">
                    {atLimit.value
                      ? t("settings.overlayContent.colLimitHint", { limit: limit.value })
                      : comboExists.value
                        ? t("settings.overlayContent.colDupHint")
                        : `${scopeLabel(selScope.value)} · ${metricLabel(selMetric.value)}`}
                  </span>
                  <HkButton
                    variant="primary"
                    size="sm"
                    disabled={!canAdd.value}
                    onClick={confirmAdd}
                  >
                    {t("settings.overlayContent.colAddConfirm")}
                  </HkButton>
                </div>
              </div>
            </HkPopover>
          </div>
          {/* The cards row — HkDraggableList axis="horizontal": one line,
              always (1 to 5 cards). The primitive owns the drag; the host
              slots dress its lanes — handle = the card grip, item = the
              label pair, actions = the delete. The popover sizes to the
              row's natural width first (that is what widens the popup,
              #1256); only a viewport-capped panel lets the cards shrink
              and ellipsize — the row itself never wraps (accepted delta:
              on phones too, see the docblock). */}
          {cards ? (
            <HkDraggableList
              items={dragItems.value}
              axis="horizontal"
              label={t("settings.overlayContent.columnsLabel")}
              onReorder={onReorder}
            >
              {{
                handle: () => (
                  <span class="overlay-columns__card-grip">
                    <GripHorizontal size={13} />
                  </span>
                ),
                item: ({ item }: { item: ColumnDragItem }) => (
                  <span class="overlay-columns__card-text">
                    <span class="overlay-columns__card-metric">
                      {metricLabel(item.metric)}
                    </span>
                    <span class="overlay-columns__card-scope">
                      {scopeLabel(item.scope)}
                    </span>
                  </span>
                ),
                actions: ({ index }: { index: number }) => (
                  <span
                    class="overlay-columns__del"
                    data-hint={t("settings.overlayContent.colRemove")}
                  >
                    <HkIconButton
                      variant="ghost"
                      aria-label={t("settings.overlayContent.colRemove")}
                      onClick={() => removeAt(index)}
                    >
                      <Trash2 size={14} />
                    </HkIconButton>
                  </span>
                ),
              }}
            </HkDraggableList>
          ) : (
            <div class="overlay-columns__empty">
              {t("settings.overlayContent.colEmpty")}
            </div>
          )}
        </div>
      );
    };
  },
});
