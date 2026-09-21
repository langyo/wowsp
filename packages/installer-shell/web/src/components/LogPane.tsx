import { defineComponent, nextTick, ref, watch, type PropType } from "vue";
import { ChevronDown, ChevronUp } from "lucide-vue-next";

import type { LogPaneStrings } from "../i18n";

import "./LogPane.scss";

/**
 * Right-hand install log pane — a borderless activity strip. The bar stays
 * visible at all times (title + line count + a truncated preview of the
 * newest entry) and clicking it toggles the 240px body below; error lines
 * force the drawer open. There is intentionally no scrollbar: the body
 * clips its overflow while the fresh end stays pinned (top when
 * newest-first, tail when oldest-first) and lines fade with distance from
 * that end, so the pane reads as "latest activity" rather than a
 * scrollback. Ordering follows the manifest's `shell.log-order` and has no
 * runtime toggle.
 */
export interface LogLine {
  time: string;
  kind: "echo" | "step" | "ok" | "error";
  text: string;
}

export default defineComponent({
  name: "LogPane",
  props: {
    lines: { type: Array<LogLine>, required: true },
    /** Localized chrome (title + toggle tooltips), resolved by the host
     *  from the wizard locale each render. */
    labels: { type: Object as PropType<LogPaneStrings>, required: true },
    order: { type: String as () => "newest" | "oldest", default: "newest" },
    expanded: { type: Boolean, default: false },
    onToggleExpanded: { type: Function, default: undefined },
  },
  setup(props) {
    const scroller = ref<HTMLElement | null>(null);

    // Pin the fresh end on arrival: top when newest-first, tail when
    // oldest-first. The body never scrolls interactively (overflow is
    // clipped, no scrollbar) — programmatic pinning is all it needs.
    const snapToFreshEnd = async () => {
      await nextTick();
      const el = scroller.value;
      if (!el) return;
      el.scrollTop = props.order === "newest" ? 0 : el.scrollHeight;
    };

    watch(() => props.lines.length, snapToFreshEnd);

    // Re-snap right after the drawer opens so the fresh end is in view the
    // moment the body appears.
    watch(
      () => props.expanded,
      (open) => {
        if (open) void snapToFreshEnd();
      },
    );

    const ordered = () =>
      props.order === "newest" ? [...props.lines].reverse() : props.lines;

    // The entry currently shown at the top of the list under the active
    // ordering: the last pushed line when newest-first, the first otherwise.
    const previewText = () => {
      if (props.lines.length === 0) return "";
      return props.order === "newest"
        ? props.lines[props.lines.length - 1].text
        : props.lines[0].text;
    };

    return () => (
      <section class={`log-pane log-pane--${props.order}`}>
        <header class="log-pane__bar" onClick={() => props.onToggleExpanded?.()}>
          <span class="log-pane__title">
            {props.labels.title} · {props.lines.length}
          </span>
          <span class="log-pane__preview">{previewText()}</span>
          <button
            type="button"
            class="log-pane__toggle"
            title={props.expanded ? props.labels.collapse : props.labels.expand}
            onClick={(event) => {
              event.stopPropagation();
              props.onToggleExpanded?.();
            }}
          >
            {props.expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </header>
        <div class={`log-pane__collapse${props.expanded ? " is-open" : ""}`}>
          <div class="log-pane__body-clip">
            <div class="log-pane__body" ref={scroller}>
              {props.expanded &&
                (props.lines.length === 0 ? (
                  <span class="log-pane__line log-pane__line--echo">…</span>
                ) : (
                  ordered().map((line, index) => (
                    <span
                      key={index}
                      class={`log-pane__line log-pane__line--${line.kind}`}
                    >
                      <time class="log-pane__time">{line.time}</time>
                      {line.text}
                    </span>
                  ))
                ))}
            </div>
          </div>
        </div>
      </section>
    );
  },
});
