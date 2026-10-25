/**
 * The water-table column editor: the configured roster columns as
 * DRAGGABLE CARDS in one wrapping row (1–5 cards; one shared row while
 * they fit, wrapped once they don't),
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
 * The widgets are hikari base components (HkPopover / HkTabs / HkButton /
 * HkIconButton), and the drag is hikari's OWN final list-drag design
 * (HkDraggableList), re-implemented for the horizontal one-row layout:
 * the pressed card arms after a 6px threshold, a translucent GHOST clone
 * (teleported to body, following the pointer 1:1, above page chrome but
 * below every popup band) carries the card while its origin slot dims to
 * a dashed placeholder, a 2px primary line on the drop target's edge
 * marks where the card lands, and the reorder commits ONCE at pointerup
 * — the cards themselves never move mid-drag.
 *
 * Every mutation writes the shared statsPrefs store (setOverlayColumns),
 * so the live panel, the post-battle panels and the Tab overlay apply it
 * immediately — the panels through the store's reactivity, the overlay
 * window through its broadcast.
 */
import { computed, defineComponent, nextTick, onBeforeUnmount, ref, watch, type PropType } from "vue";

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

/** Effective CSS `zoom` between a body-level element and the viewport
 *  root — hikari's runtime cssZoom.ancestorZoom, ported verbatim (it is
 *  not re-exported through the package's ./runtime entry): standardized
 *  zoom makes getBoundingClientRect() report the ROOT VISUAL space while
 *  fixed px assigned inside the zoomed subtree paint in local space, so
 *  the drag ghost's fixed-position writes must divide by the cumulative
 *  factor or they land zoom× off the pointer. */
function ancestorZoom(el: Element | null | undefined): number {
  if (typeof window === "undefined" || !el) return 1;
  let zoom = 1;
  let cur: Element | null = el;
  while (cur) {
    const raw = (window.getComputedStyle(cur) as CSSStyleDeclaration & {
      zoom?: string | number;
    }).zoom;
    const v =
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? Number.parseFloat(raw)
          : Number.NaN;
    if (Number.isFinite(v) && v > 0) zoom *= v;
    cur = cur.parentElement;
  }
  return zoom > 0 ? zoom : 1;
}

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

interface DragState {
  fromIndex: number;
  placeholderIndex: number;
  grabOffsetX: number;
  grabOffsetY: number;
}

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

    // ── Cards row: hikari's list-drag contract, horizontal ──────────────
    const cardEls = ref<(HTMLElement | null)[]>([]);
    /** Reactive drag snapshot (renders the source/placeholder faces);
     *  null while at rest. */
    const drag = ref<DragState | null>(null);
    /** Render bump for the non-reactive cardEls writes (same trick
     *  hikari's HkDraggableList uses). */
    const tick = ref(0);

    let armed = false;
    let startX = 0;
    let ghost: HTMLElement | null = null;

    function setCardEl(index: number, el: unknown) {
      cardEls.value[index] = (el as HTMLElement | null) ?? null;
    }

    /** The translucent clone riding under the pointer — teleported to
     *  <body> (inside any root CSS zoom subtree, so its px are LOCAL
     *  while getBoundingClientRect reports the VISUAL space; divide at
     *  the write layer or the ghost paints zoom× too large and zoom× off
     *  the pointer). Pointer-events off: the ghost is a visual, never a
     *  hit target. */
    function attachGhost(source: HTMLElement) {
      detachGhost();
      const rect = source.getBoundingClientRect();
      const snapshot = source.outerHTML.replace(
        /\s(data-dragging|data-placeholder)="[^"]*"/g,
        "",
      );
      const z = ancestorZoom(document.body);
      const node = document.createElement("div");
      node.className = "overlay-columns__ghost";
      node.innerHTML = snapshot;
      node.style.width = `${rect.width / z}px`;
      node.style.transform = `translate3d(${rect.left / z}px, ${rect.top / z}px, 0)`;
      node.style.pointerEvents = "none";
      document.body.appendChild(node);
      ghost = node;
    }

    function detachGhost() {
      ghost?.remove();
      ghost = null;
    }

    function moveGhost(s: DragState, e: PointerEvent) {
      if (!ghost) return;
      const z = ancestorZoom(document.body);
      const gx = (e.clientX - s.grabOffsetX) / z;
      const gy = (e.clientY - s.grabOffsetY) / z;
      ghost.style.transform = `translate3d(${gx}px, ${gy}px, 0)`;
    }

    /** Which slot the pointer marks as the drop target — hikari's
     *  adjacent-midpoint rule, horizontal, scoped to the pointer's LINE:
     *  the first card whose midpoint the pointer has not yet passed, the
     *  last card past every midpoint, with the same fallback wrinkle
     *  (resting between cards resolves to the last candidate, never back
     *  onto the source). The line scoping matters because the row wraps —
     *  a same-x card on the other line must never light up. The line is
     *  the band of cards whose top-edge row contains clientY; between
     *  lines the nearest band center wins; a one-line row reduces to the
     *  plain rule over every card. */
    function recomputePlaceholder(s: DragState, clientX: number, clientY: number) {
      const rects = new Map<number, DOMRect>();
      for (let i = 0; i < cardEls.value.length; i += 1) {
        if (i === s.fromIndex) continue;
        const el = cardEls.value[i];
        if (el) rects.set(i, el.getBoundingClientRect());
      }
      const bands = new Map<number, { top: number; bottom: number; cards: number[] }>();
      for (const [i, rect] of rects) {
        const key = Math.round(rect.top);
        const band = bands.get(key) ?? { top: key, bottom: Math.round(rect.bottom), cards: [] };
        band.bottom = Math.max(band.bottom, Math.round(rect.bottom));
        band.cards.push(i);
        bands.set(key, band);
      }
      let line: number[] | null = null;
      let nearest = Infinity;
      for (const band of bands.values()) {
        if (clientY >= band.top && clientY <= band.bottom) {
          line = band.cards;
          break;
        }
        const center = (band.top + band.bottom) / 2;
        const dist = Math.abs(clientY - center);
        if (dist < nearest) {
          nearest = dist;
          line = band.cards;
        }
      }
      if (!line) return;
      let target = s.fromIndex;
      let fallback = s.fromIndex;
      for (const i of line) {
        const rect = rects.get(i)!;
        const mid = rect.left + rect.width / 2;
        fallback = i;
        if (clientX < mid) {
          target = i;
          break;
        }
        target = i;
      }
      if (target === s.fromIndex && fallback !== s.fromIndex) {
        target = fallback;
      }
      if (target !== s.placeholderIndex) {
        s.placeholderIndex = target;
        tick.value += 1;
      }
    }

    function onPointerMove(e: PointerEvent) {
      const s = drag.value;
      if (!s) return;
      if (!armed) {
        // Press-to-arm: a 6px threshold separates a drag from the taps
        // and hovers a settings row normally receives.
        if (Math.abs(e.clientX - startX) < 6) return;
        armed = true;
        const source = cardEls.value[s.fromIndex];
        // The ghost lands next frame (hikari's onceFrame cadence) — the
        // drag may already be over (a fast flick) or the surface unmounted;
        // both leave nothing to attach.
        if (source) {
          requestAnimationFrame(() => {
            if (drag.value === s) attachGhost(source);
          });
        }
      }
      e.preventDefault();
      moveGhost(s, e);
      recomputePlaceholder(s, e.clientX, e.clientY);
    }

    function detachDrag() {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      detachGhost();
    }

    function onPointerUp() {
      const s = drag.value;
      detachDrag();
      if (s && armed && s.placeholderIndex !== s.fromIndex) {
        // The one commit — the cards never moved mid-drag, so the list
        // reorders exactly once, where the placeholder line sat.
        const next = [...columns.value];
        const [moved] = next.splice(s.fromIndex, 1);
        next.splice(s.placeholderIndex, 0, moved);
        commit(next);
      }
      armed = false;
      drag.value = null;
      tick.value += 1;
    }

    // The surface can unmount mid-drag (a view flip while the pointer is
    // down) — the window listeners and any live ghost must not outlive
    // the component.
    onBeforeUnmount(detachDrag);

    function onCardPointerDown(e: PointerEvent, index: number) {
      if (e.button !== 0) return;
      if (drag.value) return;
      // The delete button owns its presses; the drag owns the rest.
      if ((e.target as HTMLElement).closest("button")) return;
      const el = cardEls.value[index];
      if (!el) return;
      const rect = el.getBoundingClientRect();
      drag.value = {
        fromIndex: index,
        placeholderIndex: index,
        grabOffsetX: e.clientX - rect.left,
        grabOffsetY: e.clientY - rect.top,
      };
      armed = false;
      startX = e.clientX;
      window.addEventListener("pointermove", onPointerMove, { passive: false });
      window.addEventListener("pointerup", onPointerUp, { once: true });
      window.addEventListener("pointercancel", onPointerUp, { once: true });
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
      void tick.value;
      const s = drag.value;
      const cards = columns.value.map((col, index) => {
        const isSource = s != null && s.fromIndex === index;
        const placeholderDir =
          s != null && !isSource && s.placeholderIndex === index
            ? s.placeholderIndex < s.fromIndex
              ? "before"
              : "after"
            : null;
        return (
          <div
            key={`${col.scope}:${col.metric}`}
            ref={(el: unknown) => setCardEl(index, el)}
            class="overlay-columns__card"
            data-dragging={isSource || undefined}
            data-placeholder={placeholderDir || undefined}
            onPointerdown={(e: PointerEvent) => onCardPointerDown(e, index)}
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
                onClick={() => removeAt(index)}
              >
                <Trash2 size={14} />
              </HkIconButton>
            </span>
          </div>
        );
      });
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
          {/* The cards row — 1 to 5 cards sharing the width while they
              fit, wrapping once they don't (a card never shrinks under
              its label). */}
          <div
            class="overlay-columns__row"
            data-dragging={s ? "" : undefined}
          >
            {cards}
            {columns.value.length === 0 ? (
              <div class="overlay-columns__empty">
                {t("settings.overlayContent.colEmpty")}
              </div>
            ) : null}
          </div>
        </div>
      );
    };
  },
});
