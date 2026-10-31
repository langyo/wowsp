/** TypeSummaryChips — the per-ship-class summary chip row shared by the
 *  dashboard's and the lookup's water tables.
 *
 *  One implementation so the two surfaces cannot drift again: the grey
 *  chip body is the lookup's, the content format ("CV 1,181 51.8%" —
 *  colored class code, battles, colored winrate) is the dashboard's.
 *  Each chip carries the class briefing hint card on itself (see
 *  shipTypeHint.ts), exactly as the per-view chips did.
 */
import { defineComponent, type PropType } from "vue";

import { shipTypeHintCard } from "./shipTypeHint";
import { winrateColor } from "@/utils/winrate";
import "./TypeSummaryChips.scss";

export interface TypeSummaryItem {
  /** Short badge code — "BB" / "CA" / "CA/CL"; also the hint-card key. */
  code: string;
  battles: number;
  winrate: number;
}

export default defineComponent({
  name: "TypeSummaryChips",
  props: {
    items: { type: Array as PropType<TypeSummaryItem[]>, required: true },
  },
  setup(props) {
    return () => (
      <div class="type-summary-chips">
        {props.items.map((ts) => (
          <div
            class="type-summary-chips__chip"
            key={ts.code}
            data-hint-card={shipTypeHintCard(ts.code)}
          >
            <span class="type-summary-chips__code">{ts.code}</span>
            <span class="type-summary-chips__battles">{ts.battles.toLocaleString()}</span>
            <span class="type-summary-chips__wr" style={{ color: winrateColor(ts.winrate) }}>
              {ts.winrate.toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    );
  },
});
