import { defineComponent } from "vue";
import { HkSpinner } from "@celestia-island/hikari";

import "./LoadingNote.scss";

/**
 * Ring loading placeholder — the shared "this area is mid-fetch" note. A
 * bare status line (a "refreshing…"-style copy) reads as a dead end and
 * stars the ellipsis as the only "still working" cue; here hikari's spinner
 * ring carries the "in progress" signal and the copy drops the trailing
 * ellipsis entirely.
 *
 * Two layouts, chosen by the seat's geometry:
 *  - default (stacked): ring ABOVE the label, centered — list empty states,
 *    dropdown hints, overlay pills;
 *  - inline: ring BESIDE the copy on one line — compact row seats (pack
 *    meta/desc lines, hint paragraphs) where a stacked block would break
 *    the line rhythm.
 *
 * The root is a span so it nests legally inside hint/paragraph seats; call
 * sites keep their own seat (padding / background / position) and hand the
 * localized status line in via the 'text' prop.
 *
 * The rule is not local to this component: src/i18n/busyLabels.test.ts pins
 * it for every spinner-adjacent busy label (title-bar loading chips, busy
 * buttons) across the eight locales, so a regenerated translation cannot
 * reintroduce the dots the spinner already replaces (2026-11-16 sweep; the
 * report started as "正在解析录像后面有点点点，点点点不该有").
 */
export default defineComponent({
  name: "LoadingNote",
  props: {
    /** Localized status line, WITHOUT a trailing ellipsis. */
    text: { type: String, required: true },
    /** Row layout (ring beside the copy) for compact inline seats. */
    inline: { type: Boolean, default: false },
  },
  setup(props) {
    return () => (
      <span
        class={["loading-note", props.inline && "loading-note--inline"]}
        role="status"
      >
        <HkSpinner
          size={props.inline ? "xs" : "sm"}
          tone={props.inline ? "current" : "primary"}
        />
        <span class="loading-note__text">{props.text}</span>
      </span>
    );
  },
});
