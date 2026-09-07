import { defineComponent, onBeforeUnmount, onMounted, ref } from "vue";
import { HTitleBar } from "@celestia-island/hikari";
import { getCurrentWindow } from "@tauri-apps/api/window";

import "./AppTitleBar.scss";

/**
 * WoWSP shell around hikari's HTitleBar. The upstream component is
 * deliberately shell-agnostic — it renders the bar and emits caption
 * events; this wrapper wires them to the Tauri window (webui talks to the
 * npm `@tauri-apps/api`), tracks the maximized state for the restore
 * glyph, and drives window dragging / double-click maximize from pointer
 * events since WebView2 does not honor CSS `app-region` in plain
 * frameless windows.
 *
 * Self-guards: outside Tauri (plain browser) it renders the bar inert —
 * browser chrome already provides window controls.
 */
export default defineComponent({
  name: "AppTitleBar",
  props: {
    icon: { type: String, default: "" },
    title: { type: String, default: "WoWSP" },
    showMaximize: { type: Boolean, default: true },
  },
  setup(props) {
    const maximized = ref(false);
    let win: ReturnType<typeof getCurrentWindow> | null = null;
    let unlistenResize: (() => void) | null = null;

    const isTauri =
      typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

    onMounted(async () => {
      if (!isTauri) return;
      win = getCurrentWindow();
      const refresh = async () => {
        try {
          maximized.value = await win!.isMaximized();
        } catch {
          /* ignore — may fail during tear-down */
        }
      };
      await refresh();
      try {
        unlistenResize = await win!.onResized(() => refresh());
      } catch {
        /* ignore */
      }
    });

    onBeforeUnmount(() => {
      unlistenResize?.();
    });

    function interactive(target: EventTarget | null): boolean {
      return (target as HTMLElement | null)?.closest("button") != null;
    }

    function onPointerDown(e: PointerEvent) {
      if (!win || e.button !== 0 || interactive(e.target)) return;
      win.startDragging().catch(() => {});
    }

    function onDblClick(e: MouseEvent) {
      if (!win || !props.showMaximize || interactive(e.target)) return;
      win.toggleMaximize().catch(() => {});
    }

    return () => (
      <div
        class="app-titlebar"
        onPointerdown={onPointerDown}
        onDblclick={onDblClick}
      >
        <HTitleBar
          icon={props.icon}
          title={props.title}
          maximized={maximized.value}
          showMaximize={props.showMaximize}
          onMinimize={() => win?.minimize().catch(() => {})}
          onClose={() => win?.close().catch(() => {})}
          // upstream declares the emit as kebab-case "toggle-maximize";
          // under plain tsc the JSX key must match it verbatim (spread form,
          // since a quoted key is not a valid JSX attribute name).
          {...{ "onToggle-maximize": () => win?.toggleMaximize().catch(() => {}) }}
        />
      </div>
    );
  },
});
