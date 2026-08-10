import { computed, defineComponent, type PropType } from "vue";
import type { HoloHudState } from "./types";
import "./HoloClock.scss";

export type ClockMode = "elapsed" | "remaining";

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * HoloClock — battle timestamp chip (elapsed / remaining / total, click to
 * cycle, same as the app). Shared by the app and the site sandbox.
 */
export default defineComponent({
  name: "HoloClock",
  props: {
    state: { type: Object as PropType<HoloHudState>, required: true },
    mode: { type: Number as PropType<0 | 1 | 2>, default: 0 }, // 0 elapsed · 1 remaining · 2 total
    interactive: { type: Boolean, default: false },
  },
  emits: { cycle: () => true },
  setup(props, { emit }) {
    const label = computed(() =>
      props.mode === 0 ? fmt(props.state.time)
        : props.mode === 1 ? `-${fmt(props.state.duration - props.state.time)}`
          : fmt(props.state.duration),
    );
    const pct = computed(() => {
      if (props.state.duration <= 0) return 0;
      return Math.max(0, Math.min(1, props.state.time / props.state.duration));
    });
    return () => (
      <button
        type="button"
        class="holo-clock"
        title={props.interactive ? "click to cycle" : undefined}
        onClick={() => props.interactive && emit("cycle")}
      >
        <span class="holo-clock__time">{label.value}</span>
        <span class="holo-clock__track">
          <span class="holo-clock__fill" style={{ width: `${pct.value * 100}%` }} />
        </span>
      </button>
    );
  },
});
