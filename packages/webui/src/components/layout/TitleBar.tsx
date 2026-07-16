import { defineComponent, onMounted, onBeforeUnmount, ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import "./TitleBar.scss";

/**
 * Tauri custom title bar — Window caption buttons (Minimize / Maximize /
 * Close) plus app branding, rendered as a Vue component that participates
 * in the normal build pipeline, theme system, and component lifecycle.
 *
 * Only renders inside Tauri (self-guards via __TAURI_INTERNALS__). In a
 * plain browser dev session the bar is absent — browser chrome already
 * provides window controls.
 */

const MinimizeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round">
    <path d="M5 12h14" />
  </svg>
);

const MaximizeIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
    <rect x="4" y="4" width="16" height="16" rx="2" />
  </svg>
);

const RestoreIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
    <rect x="3" y="8" width="13" height="13" rx="2" />
    <path d="M8 8V5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3" />
  </svg>
);

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export default defineComponent({
  name: "TitleBar",
  setup() {
    const isMaximized = ref(false);
    let unlistenResize: UnlistenFn | null = null;
    let win: ReturnType<typeof getCurrentWindow> | null = null;

    const isTauri =
      typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

    async function refreshMaximized() {
      if (!win) return;
      try {
        isMaximized.value = await win.isMaximized();
      } catch {
        /* ignore — isMaximized may fail during tear-down */
      }
    }

    onMounted(async () => {
      if (!isTauri) return;
      win = getCurrentWindow();
      await refreshMaximized();
      try {
        unlistenResize = await win.onResized(() => refreshMaximized());
      } catch {
        /* ignore */
      }
    });

    onBeforeUnmount(() => {
      unlistenResize?.();
    });

    function onDblClick(e: MouseEvent) {
      if (!win) return;
      const target = e.target as HTMLElement;
      if (target.closest(".titlebar__btn")) return;
      win.toggleMaximize().catch(() => {});
    }

    function onMinimize() {
      win?.minimize().catch(() => {});
    }
    function onToggleMaximize() {
      win?.toggleMaximize().catch(() => {});
    }
    function onClose() {
      win?.close().catch(() => {});
    }

    return () => {
      if (!isTauri) return null;

      const maxTitle = isMaximized.value ? "Restore" : "Maximize";
      const maxLabel = isMaximized.value ? "Restore" : "Maximize";

      return (
        <div class="titlebar" onDblclick={onDblClick}>
          <span class="titlebar__brand">
            <img class="titlebar__logo" src="/logo.webp" alt="" />
            <span class="titlebar__name">WoWSP</span>
          </span>
          <span class="titlebar__spacer" />
          <div class="titlebar__btns">
            <button
              class="titlebar__btn"
              onClick={onMinimize}
              title="Minimize"
              aria-label="Minimize"
            >
              <MinimizeIcon />
            </button>
            <button
              class="titlebar__btn"
              onClick={onToggleMaximize}
              title={maxTitle}
              aria-label={maxLabel}
            >
              {isMaximized.value ? <RestoreIcon /> : <MaximizeIcon />}
            </button>
            <button
              class="titlebar__btn titlebar__btn--close"
              onClick={onClose}
              title="Close"
              aria-label="Close"
            >
              <CloseIcon />
            </button>
          </div>
        </div>
      );
    };
  },
});
