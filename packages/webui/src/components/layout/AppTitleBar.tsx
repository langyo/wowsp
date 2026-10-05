import { computed, defineComponent, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { HkTitleBar } from "@celestia-island/hikari";
import { BarChart3, Clock, Menu } from "@lucide/vue";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useNavUiStore } from "@/stores/navUi";
import TitlebarLoading from "@/components/layout/TitlebarLoading";
import { isMobileApp } from "@/utils/platform";
import { t } from "@/i18n";
import "./AppTitleBar.scss";

/**
 * WoWSP shell around hikari's HkTitleBar. The upstream component is
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
 * The title block is provided through HkTitleBar's `left` slot so a nav
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
    const route = useRoute();
    const router = useRouter();
    let win: ReturnType<typeof getCurrentWindow> | null = null;
    let unlistenResize: (() => void) | null = null;

    const isTauri =
      typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

    // The dashboard section's view switch (我的水表 ↔ 游玩时间) lives dead-
    // center in the bar and only while that section is open — the two views
    // are routes, so the switch is a plain router.push pair.
    const showViewSwitch = computed(
      () => route.path === "/" || route.path === "/playtime",
    );

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
        <HkTitleBar
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
                {/* Dashboard section's view switch, absolutely centered on
                    the bar (see AppTitleBar.scss). The wrapper is
                    pointer-events:none so the empty track stays draggable;
                    the buttons re-enable hits and satisfy the drag guard
                    (interactive() skips any click on a real <button>). */}
                {showViewSwitch.value ? (
                  <nav class="app-titlebar__views" aria-label={t("nav.viewSwitch")}>
                    <button
                      type="button"
                      class={{
                        "app-titlebar__view": true,
                        "is-active": route.path !== "/playtime",
                      }}
                      aria-current={route.path !== "/playtime" ? "page" : undefined}
                      onClick={() => void router.push("/")}
                    >
                      <BarChart3 size={13} />
                      <span>{t("nav.meterShort")}</span>
                    </button>
                    <button
                      type="button"
                      class={{
                        "app-titlebar__view": true,
                        "is-active": route.path === "/playtime",
                      }}
                      aria-current={route.path === "/playtime" ? "page" : undefined}
                      onClick={() => void router.push("/playtime")}
                    >
                      <Clock size={13} />
                      <span>{t("nav.playtime")}</span>
                    </button>
                  </nav>
                ) : null}
              </>
            ),
            // The loading chip rides HkTitleBar's `actions` slot, which
            // renders ahead of `customActions` — i.e. right-aligned,
            // immediately left of the settings gear. It replaces the
            // persistent loading toasts that used to squat the top-right
            // toast corner for the whole load (TitlebarLoading +
            // useLoadingTasksStore).
            actions: () => <TitlebarLoading />,
          }}
        />
      </div>
    );
  },
});
