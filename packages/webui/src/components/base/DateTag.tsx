/** DateTag — the date/time capsule tag for data-table date columns.
 *
 *  LOCAL STOPGAP: an in-tree copy of hikari's HkDateTag business part
 *  (upstreamed as "Add a locale-aware date tag capsule", publishing in
 *  @celestia-island/hikari 0.55.245). The upgrade commit that picks up
 *  the release swaps consumers onto the kit export and deletes this
 *  file — the same route the sidebar focus-handoff copy took before
 *  #1624. Keep the markup and class names EXACTLY the kit's so the
 *  swap is an import-path change only.
 *
 *  The capsule stacks the locale's date fields one per row, each
 *  horizontally centered, ordered by the ACTIVE APP LOCALE — the order
 *  comes straight from Intl's formatToParts, never a hardcoded
 *  locale→order map: zh-CN reads 年/月/日 top-down while en-US puts
 *  the year last (10/06/2024). The optional time row appends the
 *  locale's hour/minute below the date, muted.
 */
import { computed, defineComponent, type PropType } from "vue";

import { i18n } from "@/i18n";
import "./DateTag.scss";

export default defineComponent({
  name: "DateTag",
  props: {
    /** Date to render — Date, ISO string or epoch MILLISECONDS (the
     *  stats feed carries epoch seconds; multiply at the call site).
     *  Unparseable input renders nothing: the caller owns the empty
     *  state (the tables fall back to an em-dash). */
    value: {
      type: [String, Number, Date] as PropType<string | number | Date>,
      required: true,
    },
    /** Append the locale time (hour/minute) as a trailing muted row. */
    time: { type: Boolean, default: false },
  },
  setup(props) {
    // Reading i18n.global.locale inside the computed keeps the capsule
    // live on language switches — the row ORDER re-derives from the new
    // locale's Intl format instead of shuffling stored strings.
    const rows = computed(() => {
      const d = new Date(props.value);
      if (Number.isNaN(d.getTime())) return [];
      const locale = i18n.global.locale.value;
      const parts = new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(d);
      const dateRows = parts
        .filter((p) => p.type === "year" || p.type === "month" || p.type === "day")
        .map((p) => ({ kind: p.type, text: p.value }));
      if (!props.time) return dateRows;
      const time = new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
      }).format(d);
      return [...dateRows, { kind: "time", text: time }];
    });

    return () => (
      <span class="hk-date-tag">
        {rows.value.map((row) => (
          <span
            key={row.kind}
            class={row.kind === "time" ? "hk-date-tag__row hk-date-tag__row--time" : `hk-date-tag__row hk-date-tag__row--${row.kind}`}
          >
            {row.text}
          </span>
        ))}
      </span>
    );
  },
});
