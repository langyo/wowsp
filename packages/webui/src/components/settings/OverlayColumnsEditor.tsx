/**
 * The water-table column editor (settings → 游戏内水表 → 显示内容): the
 * configured roster columns as DRAGGABLE CARDS in one auto-splitting row
 * (1–5 cards, equal widths), plus the add-connector — a plus icon button
 * on the cluster header's right end opening a tooltip-style popover with
 * two segmented button groups (数据范围: 全局/仅单人/仅单船/仅当前舰种;
 * 指标: 场均/PR/胜率/场次) and a confirm-add button at the bottom right.
 *
 * The widgets are hikari base components (HkPopover / HkTabs / HkButton /
 * HkIconButton); the HORIZONTAL drag-to-reorder is the local adaptation —
 * hikari's own HkDraggableList is a vertical stack, so the pointer
 * contract (press-to-arm, adjacent-midpoint swaps, click-swallow after a
 * real drag — the same discipline the account manager's SortableList
 * uses) is re-implemented here for the one-row layout.
 *
 * Every mutation writes the shared statsPrefs store (setOverlayColumns),
 * so the live panel, the post-battle panels and the Tab overlay apply it
 * immediately — the panels through the store's reactivity, the overlay
 * window through its broadcast.
 */
import { computed, defineComponent, nextTick, onBeforeUnmount, ref, watch } from "vue";

import { Plus, Trash2, GripHorizontal } from "@lucide/vue";
import { HkButton, HkIconButton, HkPopover, HkTabs } from "@celestia-island/hikari";

import { t } from "@/i18n";
import {
  OVERLAY_COLUMN_LIMIT,
  useStatsPrefsStore,
  type OverlayColumn,
  type OverlayColumnMetric,
  type OverlayColumnScope,
} from "@/stores/statsPrefs";
import "./OverlayColumnsEditor.scss";

/** The add-menu's scope options, in the settings' canonical order. */
const SCOPE_TABS: Array<{ key: OverlayColumnScope; label: string }> = [
  { key: "global", label: t("settings.overlayContent.colScopeGlobal") },
  { key: "solo", label: t("settings.overlayContent.colScopeSolo") },
  { key: "ship", label: t("settings.overlayContent.colScopeShip") },
  { key: "class", label: t("settings.overlayContent.colScopeClass") },
];

/** The add-menu's metric options (the issue-1082 ordering: 场均/PR/胜率/
 *  场次). */
const METRIC_TABS: Array<{ key: OverlayColumnMetric; label: string }> = [
  { key: "damage", label: t("settings.overlayContent.colMetricDamage") },
  { key: "pr", label: t("settings.overlayContent.colMetricPr") },
  { key: "winrate", label: t("settings.overlayContent.colMetricWinrate") },
  { key: "battles", label: t("settings.overlayContent.colMetricBattles") },
];

const scopeLabel = (scope: OverlayColumnScope): string =>
  t(
    scope === "global"
      ? "settings.overlayContent.colScopeGlobal"
      : scope === "solo"
        ? "settings.overlayContent.colScopeSolo"
        : scope === "ship"
          ? "settings.overlayContent.colScopeShip"
          : "settings.overlayContent.colScopeClass",
  );

const metricLabel = (metric: OverlayColumnMetric): string =>
  t(
    metric === "winrate"
      ? "settings.overlayContent.colMetricWinrate"
      : metric === "pr"
        ? "settings.overlayContent.colMetricPr"
        : metric === "battles"
          ? "settings.overlayContent.colMetricBattles"
          : "settings.overlayContent.colMetricDamage",
  );

export default defineComponent({
  name: "OverlayColumnsEditor",
  setup() {
    const prefs = useStatsPrefsStore();

    // ── Cards row ───────────────────────────────────────────────────────
    /** The rendered order — the store's list mirrored, so an in-flight
     *  drag can reorder locally and commit once at drop. */
    const order = ref<OverlayColumn[]>([...prefs.prefs.overlayColumns]);
    watch(
      () => prefs.prefs.overlayColumns,
      (v) => {
        if (dragFrom < 0) order.value = [...v];
      },
      { deep: true },
    );

    const rowEl = ref<HTMLElement | null>(null);
    /** The card currently under the pointer (dragging face); -1 = none. */
    const dragging = ref(-1);
    let dragFrom = -1;
    let armed = false;
    let startX = 0;

    /** Which card slot the pointer x falls into (the last whose midpoint
     *  it has passed — the adjacent-midpoint swap rule, horizontal). */
    function indexAtX(x: number): number {
      const cards = rowEl.value?.querySelectorAll<HTMLElement>(".overlay-columns__card");
      if (!cards || cards.length === 0) return -1;
      for (let i = 0; i < cards.length; i += 1) {
        const r = cards[i].getBoundingClientRect();
        if (x < r.left + r.width / 2) return i;
      }
      return cards.length - 1;
    }

    function onPointerMove(e: PointerEvent) {
      if (dragFrom < 0) return;
      if (!armed) {
        // Press-to-arm: a 6px threshold separates a drag from the taps
        // and hovers a settings row normally receives.
        if (Math.abs(e.clientX - startX) < 6) return;
        armed = true;
        dragging.value = dragFrom;
      }
      e.preventDefault();
      const target = indexAtX(e.clientX);
      if (target >= 0 && target !== dragFrom) {
        const next = [...order.value];
        const [moved] = next.splice(dragFrom, 1);
        next.splice(target, 0, moved);
        order.value = next;
        dragFrom = target;
        dragging.value = target;
      }
    }

    function detachDrag() {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    }

    function onPointerUp() {
      detachDrag();
      if (armed && dragFrom >= 0) {
        prefs.setOverlayColumns(order.value.map((c) => ({ ...c })));
      }
      dragFrom = -1;
      armed = false;
      dragging.value = -1;
    }

    // The settings surface can unmount mid-drag (a view flip while the
    // pointer is down) — the window listeners must not outlive the
    // component, or the dead handler would keep swallowing moves.
    onBeforeUnmount(detachDrag);

    function onCardPointerDown(e: PointerEvent, index: number) {
      if (e.button !== 0) return;
      // The delete button owns its presses; the drag owns the rest.
      if ((e.target as HTMLElement).closest("button")) return;
      dragFrom = index;
      armed = false;
      startX = e.clientX;
      window.addEventListener("pointermove", onPointerMove, { passive: false });
      window.addEventListener("pointerup", onPointerUp, { once: true });
      window.addEventListener("pointercancel", onPointerUp, { once: true });
    }

    function removeAt(index: number) {
      const next = [...order.value];
      next.splice(index, 1);
      prefs.setOverlayColumns(next);
    }

    // ── Add menu ────────────────────────────────────────────────────────
    const addOpen = ref(false);
    // The popover anchors (and focus returns) to the NATIVE wrapper span —
    // a ref on the HkIconButton component would hand HkPopover the
    // component instance, not an element (its anchorRef is HTMLElement).
    const addBtn = ref<HTMLElement | null>(null);
    const selScope = ref<OverlayColumnScope>("global");
    const selMetric = ref<OverlayColumnMetric>("winrate");

    const atLimit = computed(() => order.value.length >= OVERLAY_COLUMN_LIMIT);
    const comboExists = computed(() =>
      order.value.some((c) => c.scope === selScope.value && c.metric === selMetric.value),
    );
    const canAdd = computed(() => !atLimit.value && !comboExists.value);

    /** Opening the menu lands on the first FREE combo (scope-major), so
     *  the confirm button starts enabled whenever anything is addable. */
    function firstFreeCombo(): { scope: OverlayColumnScope; metric: OverlayColumnMetric } {
      for (const s of SCOPE_TABS) {
        for (const m of METRIC_TABS) {
          if (!order.value.some((c) => c.scope === s.key && c.metric === m.key)) {
            return { scope: s.key, metric: m.key };
          }
        }
      }
      return { scope: "global", metric: "winrate" };
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
      prefs.setOverlayColumns([
        ...order.value,
        { scope: selScope.value, metric: selMetric.value },
      ]);
      addOpen.value = false;
      // The popover tears down its content on close; refocusing the plus
      // keeps keyboard users on the connector they just used.
      void nextTick(() => addBtn.value?.querySelector("button")?.focus());
    }

    return () => (
      <div class="overlay-columns">
        {/* Cluster header: the label (+ live count) on the left, the add
            connector on the RIGHT END — the issue-1082 spec. */}
        <div class="overlay-columns__head">
          <span class="overlay-columns__label">
            {t("settings.overlayContent.columnsLabel")}
            <span class="overlay-columns__count">
              {order.value.length}/{OVERLAY_COLUMN_LIMIT}
            </span>
          </span>
          <span
            ref={addBtn}
            class="overlay-columns__add"
            data-hint={
              atLimit.value
                ? t("settings.overlayContent.colLimitHint")
                : t("settings.overlayContent.colAdd")
            }
          >
            <HkIconButton
              variant="primary"
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
            title={t("settings.overlayContent.colAdd")}
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
                  tabs={SCOPE_TABS}
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
                  tabs={METRIC_TABS}
                />
              </div>
              {/* The menu's own copy keeps up with the selection: what the
                  confirm button would add, or why it cannot. */}
              <div class="overlay-columns__menu-foot">
                <span class="overlay-columns__menu-hint">
                  {atLimit.value
                    ? t("settings.overlayContent.colLimitHint")
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
        {/* The cards row — one line, every card an equal slice of the
            whole width (flex: 1 1 0), 1 to 5 of them. */}
        <div ref={rowEl} class={{ "overlay-columns__row": true, "overlay-columns__row--dragging": dragging.value >= 0 }}>
          {order.value.map((col, i) => (
            <div
              key={`${col.scope}:${col.metric}`}
              class={{
                "overlay-columns__card": true,
                "overlay-columns__card--dragging": dragging.value === i,
              }}
              onPointerdown={(e: PointerEvent) => onCardPointerDown(e, i)}
            >
              <span class="overlay-columns__card-grip">
                <GripHorizontal size={13} />
              </span>
              <span class="overlay-columns__card-text">
                <span class="overlay-columns__card-metric">{metricLabel(col.metric)}</span>
                <span class="overlay-columns__card-scope">{scopeLabel(col.scope)}</span>
              </span>
              <span
                class="overlay-columns__del"
                data-hint={t("settings.overlayContent.colRemove")}
              >
                <HkIconButton
                  variant="ghost"
                  aria-label={t("settings.overlayContent.colRemove")}
                  onClick={() => removeAt(i)}
                >
                  <Trash2 size={14} />
                </HkIconButton>
              </span>
            </div>
          ))}
          {order.value.length === 0 ? (
            <div class="overlay-columns__empty">
              {t("settings.overlayContent.colEmpty")}
            </div>
          ) : null}
        </div>
      </div>
    );
  },
});
