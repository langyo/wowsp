import {
  computed,
  defineComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type PropType,
} from "vue";
import { ChevronDown, Check } from "lucide-vue-next";

import "./SSelect.scss";

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * WoWSP design-system select dropdown. Replaces the native <select> with a
 * themed, keyboard-navigable dropdown.
 *
 * The dropdown panel is **Teleported to <body>** and positioned via
 * getBoundingClientRect on each open. This is critical: without Teleport, the
 * panel would be clipped by any ancestor with `overflow: auto/hidden` (e.g.
 * SModal's scrollable body, which was causing the dropdown to be cut off when
 * the select lived inside a short modal). Teleporting escapes all ancestor
 * clipping contexts.
 *
 * Position is recomputed on open + on window resize/scroll while open. The
 * panel also flips above the trigger if there isn't room below.
 */
export default defineComponent({
  name: "SSelect",
  props: {
    modelValue: { type: String, required: true },
    options: { type: Array as PropType<SelectOption[]>, required: true },
    size: { type: String as PropType<"sm" | "md">, default: "md" },
    block: { type: Boolean, default: false },
    placeholder: { type: String, default: undefined },
  },
  emits: {
    "update:modelValue": (_v: string) => true,
  },
  setup(props, { emit }) {
    const open = ref(false);
    const rootRef = ref<HTMLElement | null>(null);
    const panelRef = ref<HTMLElement | null>(null);
    const highlightedIndex = ref(0);
    // Panel absolute position (set from getBoundingClientRect on open).
    const panelStyle = ref<Record<string, string>>({});
    // Whether the panel renders above the trigger (flipped).
    const flipUp = ref(false);
    // ResizeObserver watching the trigger so the panel tracks the trigger
    // during a modal's scale-in transition (when its rect changes every frame).
    let resizeObs: ResizeObserver | null = null;

    const selectedLabel = computed(() => {
      const opt = props.options.find((o) => o.value === props.modelValue);
      return opt?.label ?? props.placeholder ?? props.modelValue;
    });

    function toggle() {
      open.value = !open.value;
      if (open.value) {
        highlightedIndex.value = Math.max(
          0,
          props.options.findIndex((o) => o.value === props.modelValue),
        );
      }
    }

    function select(value: string) {
      emit("update:modelValue", value);
      open.value = false;
    }

    function onKeydown(e: KeyboardEvent) {
      if (!open.value) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
        return;
      }
      if (e.key === "Escape") {
        open.value = false;
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        highlightedIndex.value = Math.min(props.options.length - 1, highlightedIndex.value + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        highlightedIndex.value = Math.max(0, highlightedIndex.value - 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const opt = props.options[highlightedIndex.value];
        if (opt) select(opt.value);
      }
    }

    /** Compute panel position from the trigger's rect. Called on open + on
     *  viewport changes. Flips above if not enough room below.
     *
     *  Guards against zero-size rects (the trigger measures 0×0 while a
     *  containing modal is mid-scale-in transition) by deferring the
     *  computation to the next animation frame until the rect stabilizes. */
    function updatePosition() {
      const root = rootRef.value;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      // If the trigger isn't laid out yet (e.g. modal still scaling in), defer
      // to the next frame so we don't pin the panel to (0,0).
      if (rect.width === 0 && rect.height === 0) {
        void nextTick(() => requestAnimationFrame(updatePosition));
        return;
      }
      const viewportH = window.innerHeight;
      const spaceBelow = viewportH - rect.bottom;
      const PANEL_MAX = 240; // matches SCSS max-height
      const PANEL_GAP = 4;
      // Flip up if there's not enough room below but more above.
      flipUp.value = spaceBelow < PANEL_MAX + PANEL_GAP && rect.top > spaceBelow;
      const top = flipUp.value
        ? Math.max(8, rect.top - PANEL_GAP - Math.min(PANEL_MAX, rect.top - 16))
        : rect.bottom + PANEL_GAP;
      panelStyle.value = {
        position: "fixed",
        left: `${rect.left}px`,
        top: `${top}px`,
        width: `${rect.width}px`,
        minWidth: `${Math.max(rect.width, 140)}px`,
        zIndex: "var(--z-tooltip)",
      };
    }

    function onDocClick(e: MouseEvent) {
      // Close if click is outside both the trigger root and the teleported panel.
      const target = e.target as Node;
      if (rootRef.value?.contains(target)) return;
      if (panelRef.value?.contains(target)) return;
      open.value = false;
    }

    function onViewportChange() {
      if (open.value) updatePosition();
    }

    watch(open, (isOpen) => {
      if (isOpen) {
        // Position on next animation frame so the panel exists to measure and
        // any ancestor modal scale-in transition has settled.
        void nextTick(() => requestAnimationFrame(updatePosition));
        // Track trigger size changes (e.g. modal still animating) while open.
        if (rootRef.value && typeof ResizeObserver !== "undefined") {
          resizeObs?.disconnect();
          resizeObs = new ResizeObserver(() => {
            if (open.value) updatePosition();
          });
          resizeObs.observe(rootRef.value);
        }
      } else {
        resizeObs?.disconnect();
        resizeObs = null;
      }
    });

    onMounted(() => {
      document.addEventListener("mousedown", onDocClick);
      window.addEventListener("resize", onViewportChange);
      window.addEventListener("scroll", onViewportChange, true);
    });
    onBeforeUnmount(() => {
      resizeObs?.disconnect();
      resizeObs = null;
      document.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    });

    return () => (
      <div
        ref={rootRef}
        class={["s-select", `s-select-${props.size}`, props.block ? "s-select-block" : ""]}
        tabindex="0"
        onKeydown={onKeydown}
      >
        <button
          type="button"
          class={["s-select__trigger", open.value ? "s-select__trigger--open" : ""]}
          onClick={toggle}
        >
          <span class="s-select__value">{selectedLabel.value}</span>
          <ChevronDown size={14} class="s-select__chevron" />
        </button>
        <Teleport to="body">
          <Transition name="s-select-panel" appear>
            {open.value ? (
              <ul
                ref={panelRef}
                class={["s-select__panel", flipUp.value ? "s-select__panel--up" : ""]}
                style={panelStyle.value}
                role="listbox"
              >
                {props.options.map((opt, i) => (
                  <li
                    role="option"
                    class={[
                      "s-select__option",
                      i === highlightedIndex.value ? "s-select__option--hl" : "",
                      opt.value === props.modelValue ? "s-select__option--sel" : "",
                    ]}
                    onClick={() => select(opt.value)}
                    onMouseenter={() => (highlightedIndex.value = i)}
                  >
                    <span>{opt.label}</span>
                    {opt.value === props.modelValue ? <Check size={13} class="s-select__check" /> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </Transition>
        </Teleport>
      </div>
    );
  },
});
