import { defineComponent, nextTick, ref, watch } from "vue";

import "./LogPane.scss";

/**
 * Right-hand install log pane. Lines carry their own HH:MM:SS stamp;
 * ordering follows the manifest's `shell.log-order` (newest-first is the
 * Docker-Desktop-style default) with a per-run toggle, and the view snaps
 * to the fresh end — top when newest-first, tail when oldest-first.
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
  },
  setup(props) {
    const scroller = ref<HTMLElement | null>(null);

    // Snap to the fresh end on arrival: top when newest-first, tail when
    // oldest-first.
    watch(
      () => props.lines.length,
      async () => {
        await nextTick();
        const el = scroller.value;
        if (!el) return;
        el.scrollTop = props.order === "newest" ? 0 : el.scrollHeight;
      },
    );

    const ordered = () =>
      props.order === "newest" ? [...props.lines].reverse() : props.lines;

    return () => (
      <section class="log-pane">
        <header class="log-pane__bar">
          <span class="log-pane__title">
            {props.title} · {props.lines.length}
          </span>
          <button
            type="button"
            class="log-pane__order"
            title="切换日志排序"
            onClick={() => props.onToggleOrder?.()}
          >
            {props.order === "newest" ? "倒序 ↓" : "正序 ↑"}
          </button>
        </header>
        <div class="log-pane__body" ref={scroller}>
          {props.lines.length === 0 ? (
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
          )}
        </div>
      </section>
    );
  },
});
