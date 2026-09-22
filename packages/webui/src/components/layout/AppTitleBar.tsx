import { defineComponent, onBeforeUnmount, onMounted, ref } from "vue";
import { HTitleBar } from "@celestia-island/hikari";
import { Menu } from "@lucide/vue";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useNavUiStore } from "@/stores/navUi";
import { isMobileApp } from "@/utils/platform";
import { t } from "@/i18n";
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
 * `customActions` (extra icon buttons left of minimize — the app puts the
 * settings gear there) pass through verbatim; their clicks surface as the
 * `action` emit with the button's id.
 *
 * The title block is provided through HTitleBar's `left` slot so a nav
 * hamburger can ride ahead of it — hidden above 767px (desktop is
 * pixel-identical to the upstream default) and toggling the phone-layout
 * nav drawer below. On the phone app build the window caption buttons
 * (minimize/maximize/close) are dropped: the Android shell manages its
 * own window, and dead caption buttons would only mislead.
 *
 * Self-guards: outside Tauri (plain browser) it renders the bar inert —
 * browser chrome already provides window controls.
 */
export default defineComponent({
  name: "AppTitleBar",
  props: {
    icon: { type: String, default: "" },
    title: { type: String, default: "WoWSP" },
    subtitle: { type: String, default: "" },
    showMaximize: { type: Boolean, default: true },
    customActions: {
      type: Array as () => { id: string; label: string; icon?: unknown }[],
      default: () => [],
    },
  },
  emits: {
    action: (_id: string) => true,
  },
  setup(props, { emit }) {
    const maximized = ref(false);
    const navUi = useNavUiStore();
    const mobileApp = isMobileApp();
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
        class={["app-titlebar", { "app-titlebar--maximized": maximized.value }]}
        onPointerdown={onPointerDown}
        onDblclick={onDblClick}
      >
        <HTitleBar
          icon={props.icon}
          title={props.title}
          subtitle={props.subtitle}
          maximized={maximized.value}
          showMaximize={props.showMaximize && !mobileApp}
          showMinimize={!mobileApp}
          showClose={!mobileApp}
          customActions={props.customActions}
          onMinimize={() => win?.minimize().catch(() => {})}
          onClose={() => win?.close().catch(() => {})}
          onAction={(id: string) => emit("action", id)}
          // upstream declares the emit as kebab-case "toggle-maximize";
          // under plain tsc the JSX key must match it verbatim (spread form,
          // since a quoted key is not a valid JSX attribute name).
          {...{ "onToggle-maximize": () => win?.toggleMaximize().catch(() => {}) }}
          v-slots={{
            // Hamburger + the upstream default title block (replicated
            // verbatim so desktop stays identical). The button borrows
            // hikari's caption-button chrome; CSS hides it ≥768px.
            left: () => (
              <>
                <button
                  type="button"
                  class="hk-titlebar-btn app-titlebar__menu"
                  title={t("nav.openMenu")}
                  aria-label={t("nav.openMenu")}
                  aria-expanded={navUi.open}
                  onClick={(e: MouseEvent) => {
                    e.stopPropagation();
                    navUi.toggle();
                  }}
                >
                  <Menu size={15} />
                </button>
                <span class="hk-titlebar-title">
                  {props.icon && <img class="hk-titlebar-icon" src={props.icon} alt="" />}
                  <span class="hk-titlebar-title-text">{props.title}</span>
                  {props.subtitle && (
                    <span class="hk-titlebar-subtitle">{props.subtitle}</span>
                  )}
                </span>
              </>
            ),
          }}
        />
      </div>
    );
  },
});
