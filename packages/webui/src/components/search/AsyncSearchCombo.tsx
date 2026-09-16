/**
 * AsyncSearchCombo — icon button that opens an anchored popup hosting a
 * debounced, race-safe ASYNC autocomplete. Same interaction shell as the
 * ship fuzzy-search popup (ShipFilterBar), but network-backed and generic:
 * the component knows nothing about players/clans/ships — callers pass a
 * `search` callback plus row renderers.
 *
 * Debounce + Enter-flush come from hikari's HSearchInput (`debounce` prop +
 * `search` event); the race token mirrors HkKeywordSearchModal's semantic
 * search (a stale in-flight response must never overwrite a newer one).
 * Numeric queries bypass the minimum-length gate (UID lookups).
 */
import {
  defineComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  type PropType,
  type VNodeChild,
} from "vue";

import { HSearchInput } from "@celestia-island/hikari";
import { Search } from "@lucide/vue";

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
    const query = ref("");
    const items = ref<unknown[]>([]);
    const loading = ref(false);
    const error = ref<string | null>(null);
    /** True once a query has completed (drives the "no results" state). */
    const searched = ref(false);
    const anchor = ref<HTMLElement | null>(null);
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

    function onDocMouseDown(e: MouseEvent) {
      if (!open.value) return;
      if (anchor.value && !anchor.value.contains(e.target as Node)) {
        open.value = false;
      }
    }
    onMounted(() => document.addEventListener("mousedown", onDocMouseDown));
    onBeforeUnmount(() => {
      document.removeEventListener("mousedown", onDocMouseDown);
      // Invalidate any in-flight query so its resolve can't touch the dead
      // component's state.
      seq++;
    });

    return () => (
      <div ref={anchor} class="async-search-combo">
        <button
          type="button"
          class={[
            "async-search-combo__btn",
            open.value || query.value.trim() ? "async-search-combo__btn--on" : "",
          ]}
          title={props.title || props.placeholder}
          aria-label={props.title || props.placeholder}
          onClick={() => {
            open.value = !open.value;
          }}
        >
          {/* Lucide icon: intrinsic width/height attrs keep flex from
              crushing a CSS-sized-only svg down to zero width. */}
          <Search size={14} />
        </button>
        {open.value ? (
          <div class={["async-search-combo__panel", `async-search-combo__panel--${props.align}`]}>
            {props.title ? (
              <div class="async-search-combo__panel-head">
                <span>{props.title}</span>
                <button
                  type="button"
                  class="async-search-combo__close"
                  onClick={() => (open.value = false)}
                >
                  ✕
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
        ) : null}
      </div>
    );
  },
});
