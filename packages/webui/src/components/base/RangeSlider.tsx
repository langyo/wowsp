/**
 * RangeSlider — the dual-thumb range slider. Hikari's own HkSlider is
 * single-thumb only (one `modelValue: Number`, ticks as bare dots), so this
 * local base component completes the family on the library's terms: same
 * interaction model (pointerdown on the track jumps the NEAREST thumb and
 * drags it, window-level listeners keep tracking past the element bounds,
 * values snap to the `step` grid), same look (--color-primary thumb/fill on
 * a muted rail, optional tick dots per stop) and the same keyboard reach —
 * here per THUMB: each handle is its own focusable role="slider" whose
 * arrows walk the step grid inside the corridor the other thumb allows, so
 * the pair can never cross.
 *
 * Tick labels: stops can carry text or arbitrary nodes (an icon, a styled
 * glyph) through EITHER the `tickLabel` function prop or the scoped `tick`
 * slot (slot wins) — the component itself stays domain-free, hosts decide
 * what a stop reads as. Labels center under their stops; the end labels
 * are allowed to overhang the control box (hosts give the row side room).
 */
import { computed, defineComponent, onBeforeUnmount, onMounted, ref, type PropType, type VNodeChild } from "vue";

import { asPropType } from "@/utils/typing";

import "./RangeSlider.scss";

/** Ordered pair [lo, hi]; an out-of-order input normalizes silently. */
type RangeValue = [number, number];
type ThumbKey = "lo" | "hi";

export default defineComponent({
  name: "RangeSlider",
  props: {
    /** Controlled [lo, hi]; every emitted pair lands snapped and clamped. */
    modelValue: {
      type: asPropType<RangeValue>(Array),
      required: true,
    },
    min: { type: Number, default: 0 },
    max: { type: Number, default: 100 },
    /** Snap step — emitted values are `min + n * step`. */
    step: { type: Number, default: 1 },
    disabled: { type: Boolean, default: false },
    /** Render one tick dot per stop (kept sane for modest stop counts). */
    showTicks: { type: Boolean, default: false },
    /** Render the label row under the stops (needs `tickLabel` or the
     *  `tick` slot; silently skips when neither is supplied). */
    showTickLabels: { type: Boolean, default: false },
    size: { type: String as () => "sm" | "md", default: "md" },
    ariaLabelLo: { type: String, default: undefined },
    ariaLabelHi: { type: String, default: undefined },
    /** Optional aria-valuetext formatter (e.g. `v => `${v}%``). */
    formatValue: {
      type: Function as PropType<(value: number, thumb: ThumbKey) => string>,
      default: undefined,
    },
    /** Per-stop label content — text or nodes; the `tick` slot wins. */
    tickLabel: {
      type: Function as PropType<(value: number) => VNodeChild>,
      default: undefined,
    },
  },
  emits: {
    "update:modelValue": (_value: RangeValue) => true,
  },
  setup(props, { emit, slots }) {
    const trackRef = ref<HTMLElement | null>(null);
    let dragging: ThumbKey | null = null;

    const safeStep = computed(() => (props.step > 0 ? props.step : 1));

    /** Snap to the step grid and clamp into [min, max]; kills float drift. */
    function snap(value: number): number {
      const steps = Math.round((value - props.min) / safeStep.value);
      const snapped = props.min + steps * safeStep.value;
      const fixed = Number(snapped.toFixed(6));
      return Math.min(props.max, Math.max(props.min, fixed));
    }

    /** The model normalized into an ordered, snapped, clamped pair. */
    const range = computed<RangeValue>(() => {
      const a = snap(Math.min(props.max, Math.max(props.min, props.modelValue[0] ?? props.min)));
      const b = snap(Math.min(props.max, Math.max(props.min, props.modelValue[1] ?? props.min)));
      return a <= b ? [a, b] : [b, a];
    });

    const pct = (v: number) => {
      const span = props.max - props.min;
      return span > 0 ? ((v - props.min) / span) * 100 : 0;
    };
    const loPct = computed(() => pct(range.value[0]));
    const hiPct = computed(() => pct(range.value[1]));

    const stopCount = computed(() => Math.round((props.max - props.min) / safeStep.value));
    const stops = computed<number[]>(() => {
      // Degenerate ranges and unreadable density render no stops.
      if (stopCount.value < 2 || stopCount.value > 32) return [];
      return Array.from({ length: stopCount.value + 1 }, (_, i) => snap(props.min + i * safeStep.value));
    });

    const hasTickContent = computed(() => props.showTickLabels && (slots.tick != null || props.tickLabel != null));

    function commit(next: RangeValue) {
      const [a, b] = next[0] <= next[1] ? next : [next[1], next[0]];
      if (a !== range.value[0] || b !== range.value[1]) emit("update:modelValue", [a, b]);
    }

    /** Move one thumb inside its corridor — the pair never crosses. */
    function moveThumb(which: ThumbKey, value: number) {
      const [lo, hi] = range.value;
      const v = snap(value);
      commit(which === "lo" ? [Math.min(v, hi), hi] : [lo, Math.max(v, lo)]);
    }

    function valueFrom(clientX: number): number {
      const el = trackRef.value;
      if (!el) return range.value[0];
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return range.value[0];
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return snap(props.min + ratio * (props.max - props.min));
    }

    /** The thumb a press belongs to: the nearer one, ties broken by side
     *  (a press between two coincident handles grabs the one it sits on the
     *  outer side of — past hi it drags hi, before lo it drags lo). */
    function thumbFor(v: number): ThumbKey {
      const [lo, hi] = range.value;
      const dLo = Math.abs(v - lo);
      const dHi = Math.abs(v - hi);
      if (dLo !== dHi) return dLo < dHi ? "lo" : "hi";
      return v <= lo ? "lo" : "hi";
    }

    function onDown(e: PointerEvent) {
      if (props.disabled) return;
      dragging = thumbFor(valueFrom(e.clientX));
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      moveThumb(dragging, valueFrom(e.clientX));
    }
    function onMove(e: PointerEvent) {
      if (dragging && !props.disabled) moveThumb(dragging, valueFrom(e.clientX));
    }
    function onUp() {
      dragging = null;
    }

    /** Keyboard per thumb — HkSlider's grid walk, corridor-clamped. */
    function onKey(e: KeyboardEvent, which: ThumbKey) {
      if (props.disabled) return;
      const [lo, hi] = range.value;
      const cur = which === "lo" ? lo : hi;
      const lower = which === "lo" ? props.min : lo;
      const upper = which === "lo" ? hi : props.max;
      const big = safeStep.value * 4;
      let next: number;
      switch (e.key) {
        case "ArrowRight":
        case "ArrowUp":
          next = cur + safeStep.value;
          break;
        case "ArrowLeft":
        case "ArrowDown":
          next = cur - safeStep.value;
          break;
        case "PageUp":
          next = cur + big;
          break;
        case "PageDown":
          next = cur - big;
          break;
        case "Home":
          next = lower;
          break;
        case "End":
          next = upper;
          break;
        default:
          return;
      }
      e.preventDefault();
      moveThumb(which, Math.min(upper, Math.max(lower, next)));
    }

    onMounted(() => {
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });
    onBeforeUnmount(() => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    });

    const thumb = (which: ThumbKey) => {
      const [lo, hi] = range.value;
      const value = which === "lo" ? lo : hi;
      return (
        <div
          key={which}
          class="range-slider__thumb"
          data-thumb={which}
          role="slider"
          tabindex={props.disabled ? -1 : 0}
          aria-label={which === "lo" ? props.ariaLabelLo : props.ariaLabelHi}
          aria-valuemin={which === "lo" ? props.min : lo}
          aria-valuemax={which === "hi" ? props.max : hi}
          aria-valuenow={value}
          aria-valuetext={props.formatValue ? props.formatValue(value, which) : String(value)}
          aria-disabled={props.disabled || undefined}
          style={{ left: `${which === "lo" ? loPct.value : hiPct.value}%` }}
          onKeydown={(e: KeyboardEvent) => onKey(e, which)}
        />
      );
    };

    return () => (
      <div
        class={["range-slider", props.disabled ? "is-disabled" : ""].filter(Boolean).join(" ")}
        data-size={props.size}
      >
        <div
          ref={trackRef}
          class="range-slider__track"
          onPointerdown={onDown}
        >
          {props.showTicks
            ? stops.value.map((v) => (
                <span
                  key={v}
                  class="range-slider__tick"
                  data-active={(v >= range.value[0] && v <= range.value[1]) || undefined}
                  style={{ left: `${pct(v)}%` }}
                  aria-hidden="true"
                />
              ))
            : null}
          <div
            class="range-slider__fill"
            style={{ left: `${loPct.value}%`, width: `${hiPct.value - loPct.value}%` }}
          />
          {thumb("lo")}
          {thumb("hi")}
        </div>
        {hasTickContent.value && stops.value.length > 0 ? (
          <div class="range-slider__labels" aria-hidden="true">
            {stops.value.map((v) => (
              <span
                key={v}
                class="range-slider__label"
                data-active={(v >= range.value[0] && v <= range.value[1]) || undefined}
                style={{ left: `${pct(v)}%` }}
              >
                {slots.tick ? slots.tick({ value: v }) : props.tickLabel?.(v)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    );
  },
});
