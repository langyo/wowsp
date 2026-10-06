/**
 * The live roster's per-player stat strip (WR / PR / battles — the
 * chip-gated numbers of the row's resolved stats-source view, same line
 * builder the post-battle full cards share). Extracted from the full card
 * so it can own the card's BOTTOM row spanning all three tracks: it is the
 * one line long enough to outgrow the fixed 10rem name track, so it borrows
 * the middle ground's and the seal's width instead of ellipsizing.
 *
 * The panel hands over the row's resolved states (bot / loading / hidden /
 * numbers); the faces live here — spinner while the batch runs, the red
 * hidden-profile notice (never a fake "—"), the shared text line, a muted
 * dash when nothing applies.
 */
import { defineComponent } from "vue";
import { HkSpinner } from "@celestia-island/hikari";

import { t } from "@/i18n";
import type { RosterModeNumbers } from "@/utils/statView";
import { rosterStatLine } from "./postBattleShare";

export default defineComponent({
  name: "LiveStatLine",
  props: {
    /** Bot rows never carry numbers — the muted dash face. */
    ai: { type: Boolean, default: false },
    /** The roster batch (incl. the ship-scope per-ship lists) is still
     *  loading this row. */
    loading: { type: Boolean, default: false },
    /** Hidden profile: a red notice, not a fake "—" (the player could have
     *  stats — they chose to hide them). */
    hidden: { type: Boolean, default: false },
    /** The row's resolved stats-source numbers — rendered once the states
     *  above are clear; null values keep their "—" slots inside the line. */
    view: { type: Object as () => RosterModeNumbers | null, default: null },
  },
  setup(props) {
    return () => {
      if (props.ai) {
        return <span class="live-battle__player-stat">—</span>;
      }
      if (props.loading) {
        return (
          <span class="live-battle__player-stat">
            <HkSpinner size="xs" tone="current" />
          </span>
        );
      }
      if (props.hidden) {
        return (
          <span class="live-battle__player-stat live-battle__player-hidden">
            {t("replay.live.hiddenProfile")}
          </span>
        );
      }
      const line = props.view ? rosterStatLine(props.view) : null;
      return (
        <span class="live-battle__player-stat">
          {line != null ? (
            <span class="live-battle__player-statline">{line}</span>
          ) : (
            "—"
          )}
        </span>
      );
    };
  },
});
