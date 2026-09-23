/**
 * AsyncSearchCombo — icon button that opens an anchored popup hosting a
 * debounced, race-safe ASYNC autocomplete. Same interaction shell as the
 * ship fuzzy-search popup (ShipFilterBar), but network-backed and generic:
 * the component knows nothing about players/clans/ships — callers pass a
 * `search` callback plus row renderers. The panel renders through hikari
 * HPopover (body-level teleport) so overflow ancestors can never clip it.
 *
 * Debounce + Enter-flush come from hikari's HSearchInput (`debounce` prop +
 * `search` event); the race token mirrors HkKeywordSearchModal's semantic
 * search (a stale in-flight response must never overwrite a newer one).
 * Numeric queries bypass the minimum-length gate (UID lookups).
 */
import {
  computed,
  defineComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  type PropType,
  type VNodeChild,
} from "vue";

import { HPopover, HSearchInput, useBreakpoint } from "@celestia-island/hikari";
import { Search, X } from "@lucide/vue";

import "./AsyncSearchCombo.scss";

export default defineComponent({
  name: "AsyncSearchCombo",
  props: {
    /** Async query — receives the trimmed input, returns the candidates. */
    search: {
      type: Function as PropType<(query: string) => Promise<unknown[]>>,
      required: true,
    },
    /** Stable v-for key for one candidate. */
    itemKey: { type: Function as PropType<(item: unknown) => string | number>, required: true },
    /** Render one candidate row's content. */
    renderItem: { type: Function as PropType<(item: unknown) => VNodeChild>, required: true },
    /** Candidate picked → navigate. */
    onSelect: { type: Function as PropType<(item: unknown) => void>, required: true },
    placeholder: { type: String, default: "" },
    /** Panel header (the search target label). */
    title: { type: String, default: "" },
    /** Hint shown while the query is below the minimum length. */
    minCharsHint: { type: String, default: "" },
    /** Empty-state text after a completed search with no hits. */
    noResultsText: { type: String, default: "" },
    /** Loading text. */
    searchingText: { type: String, default: "" },
    /** Minimum trimmed length that triggers a query (UIDs exempt). */
    minChars: { type: Number, default: 3 },
    /** Passed straight to HSearchInput's debounce (ms). */
    debounceMs: { type: Number, default: 300 },
    /** Popup horizontal anchor relative to the button. */
    align: { type: String as PropType<"left" | "right">, default: "left" },
  },
  setup(props) {
    const open = ref(false);
    // Phone layout signal for the HPopover sheet dock (sheetOnMobile +
    // scrim-rendering closeOnBackdrop, mirroring ShipFilterBar's chips).
    const { isMobile } = useBreakpoint();
    const query = ref("");
    const items = ref<unknown[]>([]);
    const loading = ref(false);
    const error = ref<string | null>(null);
    /** True once a query has completed (drives the "no results" state). */
    const searched = ref(false);
    const anchor = ref<HTMLElement | null>(null);
    // The BUTTON anchors the teleported HPopover panel; the panel element
    // joins the outside-close test — it renders at body level, outside
    // `anchor`, so a press inside it must not count as an outside press.
    const btnEl = ref<HTMLButtonElement | null>(null);
    const panelEl = ref<HTMLElement | null>(null);
    /** Race token: only the newest in-flight query may write state. */
    let seq = 0;

    function gateOk(q: string): boolean {
      return /^\d+$/.test(q) || q.length >= props.minChars;
    }

    async function run(q: string) {
      const token = ++seq;
      if (!q || !gateOk(q)) {
        items.value = [];
        searched.value = false;
        loading.value = false;
        error.value = null;
        return;
      }
      loading.value = true;
      error.value = null;
      try {
        const res = await props.search(q);
        if (token !== seq) return;
        items.value = res;
        searched.value = true;
      } catch (e) {
        if (token !== seq) return;
        items.value = [];
        searched.value = false;
        error.value = (e as Error).message ?? String(e);
      } finally {
        if (token === seq) loading.value = false;
      }
    }

    function select(item: unknown) {
      open.value = false;
      props.onSelect(item);
    }

    /** HPopover placement — the align prop's popup-side choice, expressed
     *  as the anchored placement (left = panel grows rightwards). */
    const placement = computed(() =>
      props.align === "right" ? ("bottom-end" as const) : ("bottom-start" as const),
    );

    function onDocPointerDown(e: PointerEvent) {
      if (!open.value) return;
      const target = e.target as Node;
      if (anchor.value?.contains(target)) return;
      if (panelEl.value?.contains(target)) return;
      open.value = false;
    }
    onMounted(() => document.addEventListener("pointerdown", onDocPointerDown, true));
    onBeforeUnmount(() => {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      // Invalidate any in-flight query so its resolve can't touch the dead
      // component's state.
      seq++;
    });

    return () => (
      <div ref={anchor} class="async-search-combo">
        <button
          type="button"
          ref={btnEl}
          class={[
            "async-search-combo__btn",
            open.value || query.value.trim() ? "async-search-combo__btn--on" : "",
          ]}
          data-hint={props.title || props.placeholder}
          aria-label={props.title || props.placeholder}
          onClick={() => {
            open.value = !open.value;
          }}
        >
          {/* Lucide icon: intrinsic width/height attrs keep flex from
              crushing a CSS-sized-only svg down to zero width. */}
          <Search size={14} />
        </button>
        {/* Desktop keeps closeOnBackdrop off: HPopover's own document
            listener would close on the re-click of the open trigger before
            that click re-opens it; the pointerdown listener above is the
            outside-close and Escape rides closeOnEscape. Phones dock the
            panel as a bottom sheet (sheetOnMobile — hikari convention:
            nothing floats anchored on phones), where the sheet branch
            renders its dismissal scrim from closeOnBackdrop; tapping the
            scrim also trips the listener above (same close, one path). */}
        <HPopover
          modelValue={open.value}
          onUpdate:modelValue={(v: boolean) => {
            if (!v) open.value = false;
          }}
          anchorRef={btnEl.value}
          placement={placement.value}
          closeOnBackdrop={isMobile.value}
          sheetOnMobile
          title={props.title || props.placeholder}
        >
          <div ref={panelEl} class="async-search-combo__panel">
            {props.title ? (
              <div class="async-search-combo__panel-head">
                <span>{props.title}</span>
                <button
                  type="button"
                  class="async-search-combo__close"
                  onClick={() => (open.value = false)}
                >
                  <X size={12} />
                </button>
              </div>
            ) : null}
            <HSearchInput
              modelValue={query.value}
              onUpdate:modelValue={(v: string) => (query.value = v)}
              onSearch={(v: string) => void run(v.trim())}
              placeholder={props.placeholder}
              debounce={props.debounceMs}
            />
            {error.value ? (
              <div class="async-search-combo__hint async-search-combo__hint--error">
                {error.value}
              </div>
            ) : loading.value ? (
              <div class="async-search-combo__hint">{props.searchingText}</div>
            ) : query.value.trim() && !gateOk(query.value.trim()) ? (
              <div class="async-search-combo__hint">{props.minCharsHint}</div>
            ) : items.value.length > 0 ? (
              <div class="async-search-combo__candidates">
                {items.value.map((item) => (
                  <button
                    key={props.itemKey(item)}
                    type="button"
                    class="async-search-combo__candidate"
                    onClick={() => select(item)}
                  >
                    {props.renderItem(item)}
                  </button>
                ))}
              </div>
            ) : searched.value ? (
              <div class="async-search-combo__hint">{props.noResultsText}</div>
            ) : null}
          </div>
        </HPopover>
      </div>
    );
  },
});
