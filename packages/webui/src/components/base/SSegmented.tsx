import { computed, defineComponent, type PropType } from "vue";

import "./SSegmented.scss";

export interface SegmentedOption {
  value: string;
  label: string;
}

/**
 * iOS-style segmented control with a sliding highlight indicator. Ported from
 * shittim-chest's SMorphingTabs trigger bar — the slide mechanism is pure CSS:
 * the indicator's width is `1/count` of the track and it translates by
 * `index × 100%` of its own width. Both are CSS custom properties set from JS,
 * so there's no DOM measurement; clicking an option updates `modelValue`, the
 * computed index changes, and `transition: transform` slides the pill.
 *
 * Use for equal-width option groups (date ranges, mode toggles, view switches).
 */
export default defineComponent({
  name: "SSegmented",
  props: {
    modelValue: { type: String, required: true },
    options: { type: Array as PropType<SegmentedOption[]>, required: true },
    block: { type: Boolean, default: false },
  },
  emits: {
    "update:modelValue": (_v: string) => true,
  },
  setup(props, { emit }) {
    const count = computed(() => props.options.length);
    const index = computed(() => {
      const idx = props.options.findIndex((o) => o.value === props.modelValue);
      return idx >= 0 ? idx : 0;
    });
    const indicatorStyle = computed(() => ({
      "--seg-count": count.value,
      "--seg-index": index.value,
    }) as Record<string, string | number>);

    return () => (
      <div
        class={["s-segmented", props.block ? "s-segmented--block" : ""]}
        role="tablist"
        style={indicatorStyle.value}
      >
        <div class="s-segmented__indicator" />
        {props.options.map((opt) => {
          const active = props.modelValue === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={active}
              class={[
                "s-segmented__option",
                active ? "s-segmented__option--active" : "",
              ]}
              onClick={() => emit("update:modelValue", opt.value)}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    );
  },
});
