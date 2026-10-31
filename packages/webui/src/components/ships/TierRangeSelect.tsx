/**
 * TierRangeSelect — the ONE shared ship-tier range filter (the dual-thumb
 * slider with the 1–11 tick rail). Before this component the tier filter
 * existed as three hand-rolled variants — the 水表 bar's four bracket
 * pills (I–V / VI–VII / VIII–IX / X–★), the compare picker's per-tier
 * multi-select and the encyclopedia grid's numbered chip row — and they
 * had drifted apart (the grid's row even stopped at tier 10, silently
 * locking superships out of its own filter). Every surface now mounts
 * this slider instead: drag either end (or walk it with the keyboard)
 * to carve a contiguous tier corridor; ★ marks tier 11, the superships.
 *
 * Hosts:
 *  - ShipFilterBar's tier popup (which adds its own 全部/sort action row
 *    below and hides this one via showReset=false);
 *  - ShipPickerModal's tier chip (FilterCategoryChip bare mode);
 *  - ShipsView's inline filter row;
 *  - the playtime PR trend's ship popup (replacing its bracket pills).
 */
import { computed, defineComponent } from "vue";

import RangeSlider from "@/components/base/RangeSlider";
import { tierLabel } from "@/utils/shipCompare";
import { t } from "@/i18n";
import { asPropType } from "@/utils/typing";
import "./TierRangeSelect.scss";

/** Ordered tier pair [lo, hi] on the 1–11 axis. */
export type TierRange = [number, number];

export const TIER_MIN = 1;
export const TIER_MAX = 11;

/** "VI – ★" (or "VIII" when the corridor is one tier); null while the
 *  pair spans every tier — hosts fall back to their 全部… label. */
export function tierRangeText(lo: number, hi: number): string | null {
  if (lo <= TIER_MIN && hi >= TIER_MAX) return null;
  return lo === hi ? tierLabel(lo) : `${tierLabel(lo)} – ${tierLabel(hi)}`;
}

/** True while the pair actually filters something. */
export function tierRangeNarrowed(range: TierRange): boolean {
  return range[0] > TIER_MIN || range[1] < TIER_MAX;
}

export default defineComponent({
  name: "TierRangeSelect",
  props: {
    modelValue: {
      type: asPropType<TierRange>(Array),
      required: true,
    },
    disabled: { type: Boolean, default: false },
    /** The readout row's 全部… reset button. Hosts that carry their own
     *  reset (the 水表 bar's sort-aware 全部 pill) turn it off. */
    showReset: { type: Boolean, default: true },
    size: { type: String as () => "sm" | "md", default: "md" },
  },
  emits: {
    "update:modelValue": (_value: TierRange) => true,
  },
  setup(props, { emit }) {
    const range = computed<TierRange>(() => {
      const [a, b] = props.modelValue;
      const lo = Math.min(TIER_MAX, Math.max(TIER_MIN, Math.round(a)));
      const hi = Math.min(TIER_MAX, Math.max(TIER_MIN, Math.round(b)));
      return lo <= hi ? [lo, hi] : [hi, lo];
    });

    const readout = computed(
      () => tierRangeText(range.value[0], range.value[1]) ?? t("ships.filter.tierAll"),
    );

    return () => (
      <div class="tier-range">
        <div class="tier-range__head">
          <span class="tier-range__value">{readout.value}</span>
          {props.showReset && tierRangeNarrowed(range.value) ? (
            <button
              type="button"
              class="tier-range__reset"
              disabled={props.disabled || undefined}
              onClick={() => emit("update:modelValue", [TIER_MIN, TIER_MAX])}
            >
              {t("ships.filter.tierAll")}
            </button>
          ) : null}
        </div>
        <RangeSlider
          class="tier-range__slider"
          modelValue={range.value}
          onUpdate:modelValue={(v: [number, number]) => emit("update:modelValue", v)}
          min={TIER_MIN}
          max={TIER_MAX}
          step={1}
          showTicks
          showTickLabels
          disabled={props.disabled}
          size={props.size}
          ariaLabelLo={t("ships.filter.tierLoAria")}
          ariaLabelHi={t("ships.filter.tierHiAria")}
          formatValue={(v) => `${t("ships.filter.tierTitle")} ${tierLabel(v)}`}
          v-slots={{
            tick: ({ value }: { value: number }) =>
              value === TIER_MAX ? (
                <span class="tier-range__star" data-hint={t("ships.filter.tierSupership")}>★</span>
              ) : (
                <span>{tierLabel(value)}</span>
              ),
          }}
        />
      </div>
    );
  },
});
