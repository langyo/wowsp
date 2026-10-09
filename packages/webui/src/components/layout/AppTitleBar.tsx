import { computed, defineComponent, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { HkTabs, HkTitleBar } from "@celestia-island/hikari";
import {
  ArrowLeftRight,
  BarChart3,
  Clock,
  GitBranch,
  List,
  Menu,
  Swords,
  Users,
} from "@lucide/vue";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useNavUiStore } from "@/stores/navUi";
import { useShipsUiStore, type ShipsViewMode } from "@/stores/shipsUi";
import { useLiveUiStore, type LiveViewMode } from "@/stores/liveUi";
import TitlebarLoading from "@/components/layout/TitlebarLoading";
import { watchChromeInsets } from "@/composables/popupChrome";
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
    const shipsUi = useShipsUiStore();
    const liveUi = useLiveUiStore();
    const mobileApp = isMobileApp();
    const route = useRoute();
    const router = useRouter();
    let win: ReturnType<typeof getCurrentWindow> | null = null;
    let unlistenResize: (() => void) | null = null;

    const isTauri =
      typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

    // Section view switches live dead-center in the bar, each only while
    // its own section is open: the dashboard's 我的水表 ↔ 游玩时间 pair
    // (two routes, so a plain router.push pair), the ship encyclopedia's
    // 科技树 / 列表 / 对比 view modes (page state — shared through shipsUi
    // so the bar switch and the page body render from one source), and the
    // live page's 全员战绩 ↔ 我的战绩 pair (same shared-store shape as
    // shipsUi — the mine panel is a second body of the same /live route).
    const centerSwitch = computed(() => {
      if (route.path === "/" || route.path === "/playtime") return "dashboard";
      if (route.path === "/ships") return "ships";
      if (route.path === "/live") return "live";
      return null;
    });

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

    // Declare the caption strip as the app's popup chrome band: every
    // floating surface (the data-hint tooltip, popovers, selects)
    // positions itself below the bar instead of over it. Mounted here —
    // the shell owns the band; popups never re-measure the bar.
    const chromeEl = ref<HTMLElement | null>(null);
    let stopChromeInsets: (() => void) | null = null;
    onMounted(() => {
      const bar = chromeEl.value?.querySelector<HTMLElement>(".hk-titlebar") ?? null;
      if (bar) stopChromeInsets = watchChromeInsets(bar);
    });

    onBeforeUnmount(() => {
      unlistenResize?.();
      stopChromeInsets?.();
      stopChromeInsets = null;
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
        ref={(el) => (chromeEl.value = el as HTMLElement | null)}
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
                {/* Section view switches, absolutely centered on the bar
                    (see AppTitleBar.scss) — hikari's own segmented HkTabs
                    (the dashboard date-range control), compacted for the
                    caption so the sliding-indicator motion and the tactile
                    press feedback come for free. The wrapper keeps the
                    switch off the bar's JS drag path via stopPropagation
                    (the CSS no-drag pair covers engines honoring
                    app-region). */}
                {centerSwitch.value === "dashboard" ? (
                  <nav
                    class="app-titlebar__views"
                    aria-label={t("nav.viewSwitch")}
                    onPointerdown={(e: PointerEvent) => e.stopPropagation()}
                    onDblclick={(e: MouseEvent) => e.stopPropagation()}
                  >
                    <HkTabs
                      variant="segmented"
                      scrollable={false}
                      modelValue={route.path === "/playtime" ? "playtime" : "meter"}
                      onUpdate:modelValue={(v: string) =>
                        void router.push(v === "playtime" ? "/playtime" : "/")
                      }
                      tabs={[
                        {
                          key: "meter",
                          label: t("nav.meterShort"),
                          icon: <BarChart3 size={13} />,
                        },
                        {
                          key: "playtime",
                          label: t("nav.playtime"),
                          icon: <Clock size={13} />,
                        },
                      ]}
                    />
                  </nav>
                ) : centerSwitch.value === "live" ? (
                  <nav
                    class="app-titlebar__views"
                    aria-label={t("nav.viewSwitch")}
                    onPointerdown={(e: PointerEvent) => e.stopPropagation()}
                    onDblclick={(e: MouseEvent) => e.stopPropagation()}
                  >
                    <HkTabs
                      variant="segmented"
                      scrollable={false}
                      modelValue={liveUi.viewMode}
                      onUpdate:modelValue={(v: string) =>
                        (liveUi.viewMode = v as LiveViewMode)
                      }
                      tabs={[
                        {
                          key: "roster",
                          label: t("nav.liveRoster"),
                          icon: <Users size={13} />,
                        },
                        {
                          key: "mine",
                          label: t("nav.liveMine"),
                          icon: <Swords size={13} />,
                        },
                      ]}
                    />
                  </nav>
                ) : centerSwitch.value === "ships" ? (
                  <nav
                    class="app-titlebar__views"
                    aria-label={t("nav.viewSwitch")}
                    onPointerdown={(e: PointerEvent) => e.stopPropagation()}
                    onDblclick={(e: MouseEvent) => e.stopPropagation()}
                  >
                    <HkTabs
                      variant="segmented"
                      scrollable={false}
                      modelValue={shipsUi.viewMode}
                      onUpdate:modelValue={(v: string) =>
                        (shipsUi.viewMode = v as ShipsViewMode)
                      }
                      tabs={[
                        {
                          key: "tree",
                          label: t("ships.viewMode.tree"),
                          icon: <GitBranch size={13} />,
                        },
                        {
                          key: "grid",
                          label: t("ships.viewMode.grid"),
                          icon: <List size={13} />,
                        },
                        {
                          key: "compare",
                          label: t("ships.viewMode.compare"),
                          icon: <ArrowLeftRight size={13} />,
                        },
                      ]}
                    />
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
