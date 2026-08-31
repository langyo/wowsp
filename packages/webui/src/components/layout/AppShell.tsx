import { defineComponent, onBeforeUnmount, onMounted, ref } from "vue";

import { HCheckbox, HErrorBoundary, HModal, HToast } from "@celestia-island/hikari";

import { useConfigStore } from "@/stores/config";
import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import { initModelPack } from "@/features/holographic/modelLoader";
import { api } from "@/api";
import Sidebar from "./Sidebar";
import WallpaperRenderer from "./WallpaperRenderer";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { t } from "@/i18n";
import "./AppShell.scss";

/**
 * Root layout shell: sidebar (left) + main content (right). Loads accounts +
 * starts the game-status poller on mount. Listens for the Rust close-requested
 * event to show a quit-vs-minimize confirm dialog (HModal with a footer
 * action group). Mounts the shared hikari service containers: the toast host
 * and an error boundary around the routed content.
 */
export default defineComponent({
  name: "AppShell",
  setup() {
    const config = useConfigStore();
    const accounts = useAccountStore();
    const gameStatus = useGameStatusStore();

    const showCloseDialog = ref(false);
    const rememberChoice = ref(false);
    const closing = ref<"quit" | "minimize" | null>(null);
    let unlistenClose: UnlistenFn | null = null;

    async function handleCloseChoice(action: "quit" | "minimize") {
      if (rememberChoice.value) {
        localStorage.setItem("wowsp-close-action", action);
      }
      closing.value = action;
      showCloseDialog.value = false;
      if (action === "quit") {
        // Use Rust-side process exit for a hard kill (bypasses any JS-side
        // promise queuing issues). The drain controller handles graceful
        // shutdown of background tasks before the process terminates.
        await invoke("quit_app");
      } else {
        const win = getCurrentWindow();
        await win.hide();
      }
      closing.value = null;
    }

    onMounted(async () => {
      // Download model pack on first launch (production only; dev uses publicDir).
      if (!import.meta.env.DEV) {
        void initModelPack(() => api.ensureModelPack()).catch(() => {});
      }
      // Restore the previously-selected client path before detecting, so a
      // rescan keeps the user's choice instead of always picking installs[0].
      void config.load().then(() => config.detect());
      void accounts.load();
      gameStatus.start();

      unlistenClose = await listen("close-requested", () => {
        const saved = localStorage.getItem("wowsp-close-action");
        if (saved === "quit" || saved === "minimize") {
          void handleCloseChoice(saved);
        } else {
          showCloseDialog.value = true;
        }
      });
    });
    onBeforeUnmount(() => {
      gameStatus.stop();
      unlistenClose?.();
    });

    return () => (
      <div class="app-shell">
        <WallpaperRenderer />
        <Sidebar />
        <main class="app-shell__main">
          <HErrorBoundary name="AppShell" retryLabel={t("common.reload")}>
            <router-view
              v-slots={{
                default: ({ Component, route }: { Component: unknown; route: { path: string } }) => (
                  <div class="app-shell__page" key={route.path}>
                    {Component as JSX.Element}
                  </div>
                ),
              }}
            />
          </HErrorBoundary>
        </main>
        <HToast />

        {/* Close confirm dialog — footer carries the action button group. */}
        <HModal
          modelValue={showCloseDialog.value}
          onUpdate:modelValue={(v: boolean) => (showCloseDialog.value = v)}
          title={t("tray.closeTitle")}
          width="24rem"
          footerActions={[
            {
              label: t("tray.minimize"),
              variant: "secondary",
              loading: closing.value === "minimize",
              onClick: () => void handleCloseChoice("minimize"),
            },
            {
              label: t("tray.quit"),
              variant: "danger",
              loading: closing.value === "quit",
              onClick: () => void handleCloseChoice("quit"),
            },
          ]}
        >
          {{
            default: () => (
              <div class="close-dialog__body">
                <p class="close-dialog__msg">{t("tray.closeMsg")}</p>
                <HCheckbox
                  modelValue={rememberChoice.value}
                  onUpdate:modelValue={(v: boolean) => (rememberChoice.value = v)}
                  label={t("tray.remember")}
                />
              </div>
            ),
          }}
        </HModal>
      </div>
    );
  },
});
