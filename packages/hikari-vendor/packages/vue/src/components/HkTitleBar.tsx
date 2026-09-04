import { defineComponent, onBeforeUnmount, onMounted, ref } from "vue";

import "./HkTitleBar.scss";

/**
 * Shared window chrome for frameless (decorations: false) Tauri windows —
 * brand (logo + name) plus Minimize / Maximize / Close caption buttons, as a
 * normal hikari component that joins the host app's build pipeline and theme
 * system ([data-mode] attribute on <html>).
 *
 * Self-guards: renders nothing outside Tauri (browser chrome already provides
 * window controls). Window access goes through the `withGlobalTauri` global
 * (every WoWSP Tauri window enables it) so the library carries no
 * @tauri-apps/api dependency.
 */

interface HostWindow {
  isMaximized(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function hostWindow(): HostWindow | null {
  if (!inTauri()) return null;
  const tauri = (
    window as unknown as {
      __TAURI__?: { window?: { getCurrentWindow?(): HostWindow } };
    }
  ).__TAURI__;
  return tauri?.window?.getCurrentWindow?.() ?? null;
}

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
  name: "HkTitleBar",
  props: {
    logoSrc: { type: String, default: undefined },
    appName: { type: String, default: "WoWSP" },
    maximizable: { type: Boolean, default: true },
  },
  setup(props) {
    const isMaximized = ref(false);
    let win: HostWindow | null = null;
    let unlistenResize: (() => void) | null = null;

    async function refreshMaximized() {
      if (!win) return;
      try {
        isMaximized.value = await win.isMaximized();
      } catch {
        /* ignore — isMaximized may fail during tear-down */
      }
    }

    onMounted(async () => {
      win = hostWindow();
      if (!win) return;
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

    return () => {
      if (!inTauri()) return null;

      const maxLabel = isMaximized.value ? "Restore" : "Maximize";

      return (
        <div class="hk-titlebar" data-tauri-drag-region>
          <span class="hk-titlebar__brand" data-tauri-drag-region>
            {props.logoSrc && (
              <img class="hk-titlebar__logo" src={props.logoSrc} alt="" />
            )}
            <span class="hk-titlebar__name">{props.appName}</span>
          </span>
          <span class="hk-titlebar__spacer" />
          <div class="hk-titlebar__btns">
            <button
              class="hk-titlebar__btn"
              onClick={() => win?.minimize().catch(() => {})}
              title="Minimize"
              aria-label="Minimize"
            >
              <MinimizeIcon />
            </button>
            {props.maximizable && (
              <button
                class="hk-titlebar__btn"
                onClick={() => win?.toggleMaximize().catch(() => {})}
                title={maxLabel}
                aria-label={maxLabel}
              >
                {isMaximized.value ? <RestoreIcon /> : <MaximizeIcon />}
              </button>
            )}
            <button
              class="hk-titlebar__btn hk-titlebar__btn--close"
              onClick={() => win?.close().catch(() => {})}
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
