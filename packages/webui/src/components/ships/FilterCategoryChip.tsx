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
 *
 * The popup renders through hikari HPopover: it teleports to body level and
 * positions against the chip button, so an overflow ancestor (the ship
 * picker's HModal body is a scroll container) can never clip it.
 */
import { computed, defineComponent, onBeforeUnmount, ref, watch, type PropType } from "vue";

import { HPopover } from "@celestia-island/hikari";
import { X } from "@lucide/vue";

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
    /** Right-most chip in a row — the popup opens leftwards (bottom-end). */
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
    // The chip BUTTON anchors the teleported HPopover panel. The panel
    // content element rides along in the outside-close test: it renders at
    // body level, outside `root`, so a press on an option must not count as
    // an outside press (it would kill the panel before the option's click).
    const chipBtn = ref<HTMLButtonElement | null>(null);
    const panelEl = ref<HTMLElement | null>(null);

    function close() {
      emit("update:open", false);
    }

    function onDocPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (root.value?.contains(target)) return;
      if (panelEl.value?.contains(target)) return;
      close();
    }

    // The outside-close listener lives exactly while the popup is open — a
    // closed chip must not intercept document events, and sibling chips each
    // attach their own. Escape close is HPopover's own (closeOnEscape).
    watch(
      () => props.open,
      (open) => {
        if (open) {
          document.addEventListener("pointerdown", onDocPointerDown, true);
        } else {
          document.removeEventListener("pointerdown", onDocPointerDown, true);
        }
      },
    );
    onBeforeUnmount(() => {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
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
      <div ref={root} class="ship-filter-bar__chip-anchor">
        <button
          type="button"
          ref={chipBtn}
          class={[
            "ship-filter-bar__chip",
            props.selected.size ? "ship-filter-bar__chip--on" : "ship-filter-bar__chip--all",
          ]}
          onClick={() => emit("update:open", !props.open)}
        >
          <span>{chipLabel.value}</span>
        </button>
        {/* closeOnBackdrop stays off: HPopover's own document listener would
            close on the re-click of the open chip before that click re-opens
            it, making the open chip impossible to dismiss. The pointerdown
            listener above is the outside-close; Escape rides closeOnEscape. */}
        <HPopover
          modelValue={props.open}
          onUpdate:modelValue={(v: boolean) => {
            if (!v) close();
          }}
          anchorRef={chipBtn.value}
          placement={props.edge ? "bottom-end" : "bottom-start"}
          closeOnBackdrop={false}
          title={props.title}
        >
          <div ref={panelEl} class="ship-filter-bar__pop">
            <div class="ship-filter-bar__pop-head">
              <span>{props.title}</span>
              <button type="button" class="ship-filter-bar__pop-close" onClick={close}>
                <X size={12} />
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
        </HPopover>
      </div>
    );
  },
});
