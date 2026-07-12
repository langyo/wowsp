import { defineComponent, onBeforeUnmount, onMounted, ref } from "vue";

import { useConfigStore } from "@/stores/config";
import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import { initTheme } from "@/theme/useTheme";
import SModal from "@/components/base/SModal";
import SButton from "@/components/base/SButton";
import SToast from "@/components/base/SToast";
import Sidebar from "./Sidebar";
import WallpaperRenderer from "./WallpaperRenderer";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { t } from "@/i18n";
import "./AppShell.scss";

/**
 * Root layout shell: sidebar (left) + main content (right). Loads accounts +
 * starts the game-status poller on mount. Listens for the Rust close-requested
 * event to show a quit-vs-minimize confirm dialog.
 */
export default defineComponent({
  name: "AppShell",
  setup() {
    const config = useConfigStore();
    const accounts = useAccountStore();
    const gameStatus = useGameStatusStore();

    // ── Close confirm dialog ──
    // When the user clicks the window close button, Rust emits
    // "close-requested" instead of closing. We show a modal asking whether to
    // quit the app or minimize to tray. The choice is remembered for the
    // session (stored in localStorage so it persists across restarts).
    const showCloseDialog = ref(false);
    const rememberChoice = ref(false);
    let unlistenClose: UnlistenFn | null = null;

    async function handleCloseChoice(action: "quit" | "minimize") {
      if (rememberChoice.value) {
        localStorage.setItem("wowsp-close-action", action);
      }
      showCloseDialog.value = false;
      const win = getCurrentWindow();
      if (action === "quit") {
        await win.destroy();
      } else {
        await win.hide();
      }
    }

    onMounted(async () => {
      void initTheme();
      void config.detect();
      void accounts.load();
      gameStatus.start();

      // Listen for the Rust close-requested event.
      unlistenClose = await listen("close-requested", () => {
        // Check if the user previously chose "remember".
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
          {/* Route transition: fade+slide between pages. Uses out-in mode so
              the old page leaves before the new one enters (no overlap).
              The key is the route path so Vue remounts on navigation. */}
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

        {/* Close confirm dialog */}
        <SModal
          modelValue={showCloseDialog.value}
          onUpdate:modelValue={(v: boolean) => (showCloseDialog.value = v)}
          title={t("tray.closeTitle")}
          width="24rem"
        >
          <div class="close-dialog">
            <p class="close-dialog__msg">{t("tray.closeMsg")}</p>
            <label class="close-dialog__remember">
              <input
                type="checkbox"
                checked={rememberChoice.value}
                onChange={(e) => (rememberChoice.value = (e.target as HTMLInputElement).checked)}
              />
              {t("tray.remember")}
            </label>
            <div class="close-dialog__actions">
              <SButton variant="ghost" size="sm" onClick={() => void handleCloseChoice("minimize")}>
                {t("tray.minimize")}
              </SButton>
              <SButton variant="danger" size="sm" onClick={() => void handleCloseChoice("quit")}>
                {t("tray.quit")}
              </SButton>
            </div>
          </div>
        </SModal>
      </div>
    );
  },
});
