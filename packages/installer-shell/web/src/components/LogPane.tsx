import { defineComponent, nextTick, ref, watch } from "vue";
import { ChevronDown, ChevronUp } from "lucide-vue-next";

import "./LogPane.scss";

/**
 * Right-hand install log pane, folded into a collapsible drawer. The bar
 * stays visible at all times (title + line count + a truncated preview of
 * the newest entry) and clicking it toggles the 240px body below. While
 * collapsed the body content is not rendered; error lines force the drawer
 * open. Ordering follows the manifest's `shell.log-order` (newest-first is
 * the Docker-Desktop-style default) with a per-run toggle that only shows
 * while expanded, and the view snaps to the fresh end — top when
 * newest-first, tail when oldest-first — on arrival and after expanding.
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
    title: { type: String, default: "安装日志" },
    order: { type: String as () => "newest" | "oldest", default: "newest" },
    onToggleOrder: { type: Function, default: undefined },
    expanded: { type: Boolean, default: false },
    onToggleExpanded: { type: Function, default: undefined },
  },
  setup(props) {
    const scroller = ref<HTMLElement | null>(null);

    // Snap to the fresh end on arrival: top when newest-first, tail when
    // oldest-first.
    const snapToFreshEnd = async () => {
      await nextTick();
      const el = scroller.value;
      if (!el) return;
      el.scrollTop = props.order === "newest" ? 0 : el.scrollHeight;
    };

    watch(() => props.lines.length, snapToFreshEnd);

    // Re-snap right after the drawer opens so the fresh end is in view the
    // moment the body becomes scrollable.
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
      <section class={`log-pane${props.expanded ? " is-expanded" : ""}`}>
        <header class="log-pane__bar" onClick={() => props.onToggleExpanded?.()}>
          <span class="log-pane__title">
            {props.title} · {props.lines.length}
          </span>
          <span class="log-pane__preview">{previewText()}</span>
          {props.expanded && (
            <button
              type="button"
              class="log-pane__order"
              title="切换日志排序"
              onClick={(event) => {
                event.stopPropagation();
                props.onToggleOrder?.();
              }}
            >
              {props.order === "newest" ? "倒序 ↓" : "正序 ↑"}
            </button>
          )}
          <button
            type="button"
            class="log-pane__order log-pane__toggle"
            title={props.expanded ? "收起安装日志" : "展开安装日志"}
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
