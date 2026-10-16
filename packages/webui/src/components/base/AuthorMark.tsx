import { defineComponent } from "vue";

import { openExternal } from "@/utils/openExternal";
import "./AuthorMark.scss";

/**
 * Shared author/attribution mark: a clickable name chip (opens the linked
 * page through the external-browser helper) plus an optional muted role/note
 * line. One look everywhere an artist or partner is credited (the settings
 * attributions list), so the styling can never drift apart.
 */
export default defineComponent({
  name: "AuthorMark",
  props: {
    name: { type: String, required: true },
    /** Link opened on click (external browser). Null = plain text chip. */
    url: { type: String, default: null },
    /** Role line under the name ("默认壁纸作者" etc.). */
    role: { type: String, default: null },
  },
  setup(props) {
    return () => (
      <span class="author-mark">
        {props.url ? (
          <button
            type="button"
            class="author-mark__name"
            data-hint={props.url}
            onClick={() => void openExternal(props.url!)}
          >
            {props.name}
          </button>
        ) : (
          <span class="author-mark__name">{props.name}</span>
        )}
        {props.role ? <span class="author-mark__role">{props.role}</span> : null}
      </span>
    );
  },
});
