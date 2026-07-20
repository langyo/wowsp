import { defineComponent, onBeforeUnmount, onMounted, ref } from "vue";

import { useConfigStore } from "@/stores/config";
import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import { initTheme } from "@/theme/useTheme";
import { initModelPack } from "@/features/holographic/modelLoader";
import { api } from "@/api";
import SModal from "@/components/base/SModal";
import SButton from "@/components/base/SButton";
import SCheckbox from "@/components/base/SCheckbox";
import SToast from "@/components/base/SToast";
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
 * event to show a quit-vs-minimize confirm dialog using standard SModal +
 * SButton components.
 */
export default defineComponent({
  name: "AppShell",
  setup() {
    const config = useConfigStore();
    const accounts = useAccountStore();
    const gameStatus = useGameStatusStore();

    const showCloseDialog = ref(false);
    const rememberChoice = ref(false);
    let unlistenClose: UnlistenFn | null = null;

    async function handleCloseChoice(action: "quit" | "minimize") {
      if (rememberChoice.value) {
        localStorage.setItem("wowsp-close-action", action);
      }
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
    }

    onMounted(async () => {
      void initTheme();
      // Download model pack on first launch (best-effort, non-blocking).
      void initModelPack(() => api.ensureModelPack()).catch(() => {});
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
          <router-view
            v-slots={{
              default: ({ Component, route }: { Component: unknown; route: { path: string } }) => (
                <Transition name="s-fade-slide" mode="out-in">
                  <div class="app-shell__page" key={route.path}>
                    {Component as JSX.Element}
                  </div>
                </Transition>
              ),
            }}
          />
        </main>
        <SToast />

        {/* Close confirm dialog — uses standard SModal + SButton */}
        <SModal
          modelValue={showCloseDialog.value}
          onUpdate:modelValue={(v: boolean) => (showCloseDialog.value = v)}
          title={t("tray.closeTitle")}
          width="24rem"
          v-slots={{
            default: () => (
              <div class="close-dialog__body">
                <p class="close-dialog__msg">{t("tray.closeMsg")}</p>
                <SCheckbox
                  modelValue={rememberChoice.value}
                  onUpdate:modelValue={(v: boolean) => (rememberChoice.value = v)}
                  label={t("tray.remember")}
                />
              </div>
            ),
            footer: () => [
              <SButton
                variant="secondary"
                size="sm"
                onClick={() => void handleCloseChoice("minimize")}
              >
                {t("tray.minimize")}
              </SButton>,
              <SButton
                variant="danger"
                size="sm"
                onClick={() => void handleCloseChoice("quit")}
              >
                {t("tray.quit")}
              </SButton>,
            ],
          }}
        />
      </div>
    );
  },
});
