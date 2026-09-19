/**
 * FilterCategoryChip — one collapsed filter category rendered as a chip that
 * opens a small popup of pill-style multi-select options. A PURE filter: no
 * sorting and no drag reorder, so — unlike ShipFilterBar's own chips — there
 * is no grip icon and no `--sort` state.
 *
 * The markup reuses ShipFilterBar's FLAT global classes so the chips look
 * identical to the 水表查询 filter bar. This module imports that SCSS itself:
 * views are lazy-loaded per route, and a component landing in the ships
 * chunk cannot rely on the LookupView chunk to carry the styles (Vite
 * dedupes the CSS module, so both surfaces stay in lockstep).
 */
import { computed, defineComponent, onBeforeUnmount, ref, watch, type PropType } from "vue";

import { t } from "@/i18n";
import "./ShipFilterBar.scss";

export default defineComponent({
  name: "FilterCategoryChip",
  props: {
    /** Popup head text. */
    title: { type: String, required: true },
    /** The 全部… label — chip label when nothing is selected + the reset pill. */
    allLabel: { type: String, required: true },
    /** Options in canonical display order; the chip label sorts by it. */
    options: {
      type: Array as PropType<{ value: string; label: string }[]>,
      default: () => [],
    },
    selected: { type: Object as PropType<Set<string>>, default: () => new Set<string>() },
    open: { type: Boolean, default: false },
    /** Right-most chip in a row — the popup opens leftwards (data-edge CSS hook). */
    edge: { type: Boolean, default: false },
  },
  emits: {
    "update:open": (_v: boolean) => true,
    toggle: (_value: string) => true,
    clear: () => true,
  },
  setup(props, { emit }) {
    // Root element for the outside-click test — NOT a class-based closest()
    // check: several chip anchors coexist on one page and each must close
    // only for events landing outside itself.
    const root = ref<HTMLElement | null>(null);

    function close() {
      emit("update:open", false);
    }

    function onDocPointerDown(e: PointerEvent) {
      if (root.value && !root.value.contains(e.target as Node)) close();
    }
    function onDocKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }

    // Listeners live exactly while the popup is open — a closed chip must
    // not intercept document events, and sibling chips each attach their own.
    watch(
      () => props.open,
      (open) => {
        if (open) {
          document.addEventListener("pointerdown", onDocPointerDown, true);
          document.addEventListener("keydown", onDocKeydown);
        } else {
          document.removeEventListener("pointerdown", onDocPointerDown, true);
          document.removeEventListener("keydown", onDocKeydown);
        }
      },
    );
    onBeforeUnmount(() => {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      document.removeEventListener("keydown", onDocKeydown);
    });

    // Chip label reads in canonical option order (not click order) so the
    // text never shuffles when selections are toggled back and forth.
    const chipLabel = computed(() => {
      const labels = props.options
        .filter((o) => props.selected.has(o.value))
        .map((o) => o.label);
      return labels.length > 0 ? labels.join("·") : props.allLabel;
    });

    return () => (
      <div ref={root} class="ship-filter-bar__chip-anchor" data-edge={props.edge || undefined}>
        <button
          type="button"
          class={[
            "ship-filter-bar__chip",
            props.selected.size ? "ship-filter-bar__chip--on" : "ship-filter-bar__chip--all",
          ]}
          onClick={() => emit("update:open", !props.open)}
        >
          <span>{chipLabel.value}</span>
        </button>
        {props.open ? (
          <div class="ship-filter-bar__pop">
            <div class="ship-filter-bar__pop-head">
              <span>{props.title}</span>
              <button type="button" class="ship-filter-bar__pop-close" onClick={close}>
                ✕
              </button>
            </div>
            {/* Wrap unconditionally: this component may host long option
                lists (13 nations) inside a narrow modal, unlike the short
                categories ShipFilterBar styles the track for. */}
            <div
              class="ship-filter-bar__opts"
              style={{ flexWrap: "wrap", justifyContent: "flex-start" }}
            >
              <button
                type="button"
                class="ship-filter-bar__opt"
                data-active={props.selected.size === 0 || undefined}
                onClick={() => emit("clear")}
              >
                <span>{props.allLabel}</span>
              </button>
              {props.options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  class="ship-filter-bar__opt"
                  data-active={props.selected.has(o.value) || undefined}
                  onClick={() => emit("toggle", o.value)}
                >
                  <span>{o.label}</span>
                </button>
              ))}
            </div>
            <div class="ship-filter-bar__pop-hint">{t("ships.filter.hintMulti")}</div>
          </div>
        ) : null}
      </div>
    );
  },
});
