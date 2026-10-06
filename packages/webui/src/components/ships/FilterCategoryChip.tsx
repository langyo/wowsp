/**
 * FilterCategoryChip — one collapsed filter category rendered as a chip that
 * opens a small popup of pill-style multi-select options. A PURE filter by
 * default: no sorting of its own — hosts whose category DOES carry a
 * direction (the replay rail's mode chip) pass `dir`, and an allSort-engaged
 * chip wears the intermediate `--sort` style. The popup then shows the ↑/↓
 * arrow after the 全部… pill and after picked concrete options (unless
 * `pure`), exactly like the 水表 bar's popups — the arrow itself stays dumb,
 * the host owns the semantics behind the `all` event. An `icon` anchor
 * swaps the collapsed text chip for a ghost toolbar icon button (hosts that
 * keep the trigger inside a button row instead of a chip strip).
 *
 * The markup reuses ShipFilterBar's FLAT global classes so the chips look
 * identical to the 水表查询 filter bar. This module imports that SCSS itself:
 * views are lazy-loaded per route, and a component landing in the ships
 * chunk cannot rely on the LookupView chunk to carry the styles (Vite
 * dedupes the CSS module, so both surfaces stay in lockstep).
 *
 * The option track is the shared one-line pannable strip (`__opts--scroll`,
 * optionStrip composable): HkPopover sizes its panel to max-content, so a
 * wrapping track always measured as ONE long line that ran off-screen —
 * the strip caps the panel instead and pans the overflow (wheel / mouse
 * drag / native touch), with the edges fading while content hides. The
 * phone sheet relaxes the track back into a wrapping group (SCSS).
 *
 * The popup renders through hikari HkPopover: it teleports to body level and
 * positions against the chip button, so an overflow ancestor (the ship
 * picker's HkModal body is a scroll container) can never clip it.
 *
 * Hosts that need more controls inside the popup render them through the
 * DEFAULT SLOT (between the option strip and the hint line — the replay
 * rail's date-range pair lives there). A nested popup opened from slot
 * content (an embedded HkDatePicker's calendar also teleports to body)
 * survives the outside-close: presses inside any open `.hk-popover-panel`
 * other than this panel's own count as inside, which is safe — an unrelated
 * popup can never be open alongside, its opening press would have closed
 * this panel first.
 */
import { computed, defineComponent, onBeforeUnmount, ref, watch, type PropType, type VNode } from "vue";

import { HkPopover, useBreakpoint } from "@celestia-island/hikari";
import { ArrowDown, ArrowUp } from "@lucide/vue";

import { t } from "@/i18n";
import { useOptionStrip } from "./optionStrip";
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
    /** Optional leading icon per option value (e.g. a nation flag before
     *  the nation name). Undefined (default) keeps the text-only rows, so
     *  existing callers are unaffected. */
    renderOptionIcon: {
      type: Function as PropType<(value: string) => VNode>,
      default: undefined,
    },
    /** Icon-only anchor: the collapsed chip renders this glyph instead of
     *  the label text, styled as a ghost toolbar icon button (the replay
     *  rail's funnel). `title` doubles as the button's aria-label. */
    icon: {
      type: Object as PropType<VNode>,
      default: undefined,
    },
    /** Bottom hint line. Defaults to the ships filter's multi-select hint;
     *  hosts with other semantics (e.g. the replay sort chip's radio)
     *  override it. */
    hint: { type: String, default: undefined },
    /** The category's shared sort direction. Undefined (default) renders a
     *  direction-free popup; set, the 全部… pill and picked concrete
     *  options carry the ↑/↓ arrow (picked options skip it when `pure`). */
    dir: {
      type: String as PropType<"asc" | "desc">,
      default: undefined,
    },
    /** Pure-filter categories (types/nations/modes): a concrete pick carries
     *  no direction, so only the 全部… pill shows the arrow. */
    pure: { type: Boolean, default: false },
    /** 全部…-sort engaged while nothing is picked — the chip wears the
     *  intermediate `--sort` style (sorting without filtering). */
    allSort: { type: Boolean, default: false },
    /** Engaged look with an empty selection: hosts whose slot content adds
     *  filter state of its own (the replay date-range pair) report it here
     *  — the icon anchor must not read idle while a window is set. */
    engaged: { type: Boolean, default: false },
  },
  emits: {
    "update:open": (_v: boolean) => true,
    toggle: (_value: string) => true,
    /** The 全部… pill was clicked — the HOST decides what it means (reset,
     *  or engage/flip the 全部…-sort; the ships-bar contract). */
    all: () => true,
  },
  setup(props, { emit, slots }) {
    // Phone layout signal for the HkPopover sheet dock (sheetOnMobile +
    // scrim-rendering closeOnBackdrop — hikari convention: on phones
    // nothing floats anchored, not even popups over a modal sheet).
    const { isMobile } = useBreakpoint();
    // Root element for the outside-click test — NOT a class-based closest()
    // check: several chip anchors coexist on one page and each must close
    // only for events landing outside itself.
    const root = ref<HTMLElement | null>(null);
    // The chip BUTTON anchors the teleported HkPopover panel. The panel
    // content element rides along in the outside-close test: it renders at
    // body level, outside `root`, so a press on an option must not count as
    // an outside press (it would kill the panel before the option's click).
    const chipBtn = ref<HTMLButtonElement | null>(null);
    const panelEl = ref<HTMLElement | null>(null);
    // The pannable option track (wheel / drag / touch + edge fades).
    const strip = useOptionStrip();

    function close() {
      emit("update:open", false);
    }

    function onDocPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (root.value?.contains(target)) return;
      if (panelEl.value?.contains(target)) return;
      // A popup nested in the default slot (the replay rail's embedded
      // date pickers open their own HkPopover calendars) teleports to body
      // level — visible to neither `root` nor `panelEl`. A press inside
      // any OTHER open .hk-popover-panel therefore belongs to this panel's
      // own nested content: the only way a second panel can be open at all
      // is opened from inside this one (an unrelated popup's opening press
      // would have landed outside and closed this panel first).
      for (const panel of document.querySelectorAll<HTMLElement>(".hk-popover-panel")) {
        if (panel !== panelEl.value && panel.contains(target)) return;
      }
      close();
    }

    // The outside-close listener lives exactly while the popup is open — a
    // closed chip must not intercept document events, and sibling chips each
    // attach their own. Escape close is HkPopover's own (closeOnEscape).
    watch(
      () => props.open,
      (open) => {
        if (open) {
          document.addEventListener("pointerdown", onDocPointerDown, true);
        } else {
          document.removeEventListener("pointerdown", onDocPointerDown, true);
        }
        // A popup that closed before a pan's trailing click (window blur
        // mid-drag — pointerup lost) must not carry the swallow flag into
        // the reopened panel.
        strip.resetDragged();
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

    const dirIcon = (d: "asc" | "desc") =>
      d === "desc" ? (
        <ArrowDown size={11} class="ship-filter-bar__dir" />
      ) : (
        <ArrowUp size={11} class="ship-filter-bar__dir" />
      );

    return () => (
      <div ref={root} class="ship-filter-bar__chip-anchor">
        <button
          type="button"
          ref={chipBtn}
          class={[
            "ship-filter-bar__chip",
            props.icon ? "ship-filter-bar__chip--icon" : "",
            props.selected.size || props.engaged
              ? "ship-filter-bar__chip--on"
              : props.allSort
                ? "ship-filter-bar__chip--sort"
                : "ship-filter-bar__chip--all",
          ]}
          aria-label={props.icon ? props.title : undefined}
          onClick={() => emit("update:open", !props.open)}
        >
          {props.icon ?? <span>{chipLabel.value}</span>}
        </button>
        {/* Desktop keeps closeOnBackdrop off: HkPopover's own document
            listener would close on the re-click of the open chip before
            that click re-opens it, making the open chip impossible to
            dismiss; the pointerdown listener above is the outside-close and
            Escape rides closeOnEscape. Phones dock the panel as a bottom
            sheet (sheetOnMobile), where the sheet branch renders its
            dismissal scrim from closeOnBackdrop; tapping the scrim also
            trips the listener above (same close, one path). Sheet-mode
            chrome reuse comes free: the panel reuses ShipFilterBar's flat
            classes, and ShipFilterBar.scss already restyles
            .hk-popover-panel.hk-is-sheet for this exact markup. */}
        <HkPopover
          modelValue={props.open}
          onUpdate:modelValue={(v: boolean) => {
            if (!v) close();
          }}
          anchorRef={chipBtn.value}
          placement={props.edge ? "bottom-end" : "bottom-start"}
          closeOnBackdrop={isMobile.value}
          sheetOnMobile
          title={props.title}
        >
          <div ref={panelEl} class="ship-filter-bar__pop">
            <div class="ship-filter-bar__pop-head">
              <span>{props.title}</span>
            </div>
            {/* One-line pannable strip, shared with the 水表 bar's nation
                popup: capped by the panel, panned by wheel / drag / touch,
                fading where content still hides (optionStrip senses the
                overflow sides onto data-h-overflow). The phone sheet
                relaxes the track back into a wrapping group (SCSS). */}
            <div
              ref={strip.stripEl}
              class="ship-filter-bar__opts ship-filter-bar__opts--scroll"
              data-panning={strip.panning.value || undefined}
              onPointerdown={strip.onPointerDown}
            >
              <button
                type="button"
                class="ship-filter-bar__opt"
                data-active={props.selected.size === 0 || undefined}
                onClick={() => emit("all")}
              >
                <span>{props.allLabel}</span>
                {props.dir ? dirIcon(props.dir) : null}
              </button>
              {props.options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  class="ship-filter-bar__opt"
                  data-active={props.selected.has(o.value) || undefined}
                  onClick={() => emit("toggle", o.value)}
                >
                  {props.renderOptionIcon ? props.renderOptionIcon(o.value) : null}
                  <span>{o.label}</span>
                  {props.dir && !props.pure && props.selected.has(o.value)
                    ? dirIcon(props.dir)
                    : null}
                </button>
              ))}
            </div>
            {/* Slot content rides between the strip and the hint — the
                replay rail's date-range pair lives here. */}
            {slots.default?.()}
            <div class="ship-filter-bar__pop-hint">{props.hint ?? t("ships.filter.hintMulti")}</div>
          </div>
        </HkPopover>
      </div>
    );
  },
});
