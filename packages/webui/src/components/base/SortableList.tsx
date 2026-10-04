import { defineComponent, onBeforeUnmount, onMounted, ref, type PropType } from "vue";
import "./SortableList.scss";

/** Press-to-drag arm distance — a plain click on a handle never starts a
 *  drag. */
const ARM_PX = 5;

/**
 * Vertical list whose rows reorder by dragging a marked handle.
 *
 * The host renders each row through the default (function) child and marks
 * its drag affordance with a `data-sortable-handle` attribute — the list
 * itself stays layout-agnostic: container spacing comes from the host via
 * fallthrough class/attrs, row keys via `getKey`, and the new order is
 * reported as `reorder(from, to)` for the host's store to apply.
 *
 * Interaction: a press on the handle arms past a 5px threshold, the row
 * then tracks the pointer 1:1 (the offset lives on an inner wrapper, so row
 * rects stay pure layout for hit-testing), and the row swaps with a
 * neighbour as the pointer crosses its vertical midpoint. The click that
 * follows a completed drag is swallowed so a drop never re-activates the
 * card under the release point.
 *
 * ```tsx
 * <SortableList class="rows" items={rows} getKey={(r) => r.id}
 *   onReorder={(from, to) => store.reorder(from, to)}>
 *   {(s: { item: Row; index: number; dragging: boolean }) => (
 *     <span data-sortable-handle><GripVertical size={14} /></span>
 *     ...
 *   )}
 * </SortableList>
 * ```
 */
export default defineComponent({
  name: "SortableList",
  props: {
    /** Row data in display order; the host reorders this array on
     *  `reorder` — the list never mutates its input itself. */
    items: { type: Array as PropType<readonly unknown[]>, required: true },
    /** Stable per-row key (drives DOM node reuse across swaps). Typed with
     *  `never` so hosts can pass `(row: ConcreteRow) => key` without a
     *  cast — `never` is assignable to every row type. */
    getKey: {
      type: Function as PropType<(item: never, index: number) => string | number>,
      required: true,
    },
    /** Freeze the order (e.g. while the host is busy). */
    disabled: { type: Boolean, default: false },
    /** Accessible label for the list container. */
    label: { type: String, default: undefined },
  },
  emits: ["reorder"],
  setup(props, { slots, emit }) {
    /** Positional index of the row being dragged (null when idle). Follows
     *  the swaps, not the press — it is always the dragged row's CURRENT
     *  index in `items`. */
    const dragIndex = ref<number | null>(null);
    /** Live translateY applied to the dragged row's inner wrapper. */
    const dragOffset = ref(0);

    const listEl = ref<HTMLElement | null>(null);

    // Per-press bookkeeping — never read during render.
    let pressIndex = -1;
    let pressX = 0;
    let pressY = 0;
    let armed = false;
    let lastY = 0;
    /** Timestamp of a completed drag: the release lands as a click on the
     *  row (press + up on the same element), which must not re-trigger the
     *  card's own click action. Time-boxed (rather than a sticky flag) so a
     *  drag released off-window can never eat a later keyboard activation,
     *  which has no pointerdown to reset it. */
    let swallowClickAt = 0;
    /** How long after a drop a trailing click is still recognized as the
     *  drag's own release click. */
    const SWALLOW_CLICK_MS = 300;

    /** A row's root element by index — direct children of the container.
     *  Root rects are layout-only: the drag transform sits on the inner
     *  wrapper, so hit-testing never sees the offset. */
    function rowEl(index: number): HTMLElement | null {
      const child = listEl.value?.children[index];
      return child instanceof HTMLElement ? child : null;
    }

    function onPointerDown(e: PointerEvent, index: number) {
      if (props.disabled || e.button !== 0) return;
      // Only a press on a marked handle starts a drag — rows themselves
      // stay plain clickable (both hosts activate on row click).
      if (!(e.target as Element).closest("[data-sortable-handle]")) return;
      pressIndex = index;
      pressX = e.clientX;
      pressY = e.clientY;
      armed = false;
      // Capture the pointer so a release outside the window (alt-tab
      // mid-drag) still delivers pointerup instead of leaving the row stuck
      // following a no-button pointer. Best-effort: the capture call can
      // only fail for an already-gone pointer, in which case the window
      // listeners still cover the gesture.
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // pointer already inactive — fall through to window listeners
      }
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp, { once: true });
      window.addEventListener("pointercancel", onPointerCancel, { once: true });
    }

    function onPointerMove(e: PointerEvent) {
      if (pressIndex < 0) return;
      if (!armed) {
        if (Math.abs(e.clientX - pressX) < ARM_PX && Math.abs(e.clientY - pressY) < ARM_PX) return;
        armed = true;
        dragIndex.value = pressIndex;
        dragOffset.value = 0;
        lastY = e.clientY;
        document.body.classList.add("sortable-list--dragging");
      }
      e.preventDefault();
      // Capture-failure safety net: a move with no button held means the
      // release was lost while unfocused — end the drag instead of letting
      // the row trail a buttonless pointer.
      if (e.buttons === 0) {
        finishPress(false);
        return;
      }
      dragOffset.value += e.clientY - lastY;
      lastY = e.clientY;

      // Adjacent swap when the pointer crosses a neighbour's vertical
      // midpoint (rects are layout positions — see rowEl).
      const from = dragIndex.value ?? pressIndex;
      if (from > 0) {
        const r = rowEl(from - 1)?.getBoundingClientRect();
        if (r && e.clientY < r.top + r.height / 2) {
          swap(from, from - 1);
          return;
        }
      }
      if (from >= 0 && from < props.items.length - 1) {
        const r = rowEl(from + 1)?.getBoundingClientRect();
        if (r && e.clientY > r.top + r.height / 2) swap(from, from + 1);
      }
    }

    /** Report the swap and keep the dragged row under the pointer: after the
     *  host reorders, the row's layout slot moves by the neighbour's slot
     *  distance, so pre-shift the offset by the same amount (measured before
     *  the emit, while the old layout is still on screen). */
    function swap(from: number, to: number) {
      const movedTop = rowEl(from)?.getBoundingClientRect().top ?? 0;
      const neighbourTop = rowEl(to)?.getBoundingClientRect().top ?? 0;
      dragIndex.value = to;
      emit("reorder", from, to);
      dragOffset.value += movedTop - neighbourTop;
    }

    function onPointerUp() {
      finishPress(true);
    }

    /** A cancelled drag leaves no click behind (the pointer was taken by the
     *  system — scroll, touch timeout), so nothing to swallow. */
    function onPointerCancel() {
      finishPress(false);
    }

    function finishPress(swallow: boolean) {
      if (armed) {
        if (swallow) swallowClickAt = Date.now();
        document.body.classList.remove("sortable-list--dragging");
      }
      armed = false;
      pressIndex = -1;
      dragIndex.value = null;
      dragOffset.value = 0;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointercancel", onPointerCancel);
    }

    /** Capture-phase click guard — runs before the row content's own
     *  handlers, so a drop-on-a-card never also activates that card. */
    function onClickCapture(e: MouseEvent) {
      if (Date.now() - swallowClickAt > SWALLOW_CLICK_MS) return;
      swallowClickAt = 0;
      e.preventDefault();
      e.stopPropagation();
    }

    // The capture click guard hangs off the container directly: Vue's JSX
    // typings have no onClickCapture attribute, so the listener is wired
    // imperatively instead.
    onMounted(() => listEl.value?.addEventListener("click", onClickCapture, true));
    onBeforeUnmount(() => {
      listEl.value?.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("pointermove", onPointerMove);
      document.body.classList.remove("sortable-list--dragging");
    });

    return () => (
      <div ref={listEl} class="sortable-list" role="list" aria-label={props.label}>
        {props.items.map((item, i) => {
          const dragging = dragIndex.value === i;
          return (
            <div
              key={props.getKey(item as never, i)}
              class={["sortable-list__item", dragging ? "sortable-list__item--dragging" : ""]}
              role="listitem"
              onPointerdown={(e: PointerEvent) => onPointerDown(e, i)}
            >
              <div
                class="sortable-list__drag"
                style={dragging ? { transform: `translateY(${dragOffset.value}px)` } : undefined}
              >
                {slots.default?.({ item, index: i, dragging })}
              </div>
            </div>
          );
        })}
      </div>
    );
  },
});
