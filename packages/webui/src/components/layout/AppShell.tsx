import { defineComponent, onBeforeUnmount, onMounted, ref } from "vue";

import { useConfigStore } from "@/stores/config";
import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import { initTheme } from "@/theme/useTheme";
import SModal from "@/components/base/SModal";
import SButton from "@/components/base/SButton";
import SCheckbox from "@/components/base/SCheckbox";
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
        >
          <p class="close-dialog__msg">{t("tray.closeMsg")}</p>
          <SCheckbox
            modelValue={rememberChoice.value}
            onUpdate:modelValue={(v: boolean) => (rememberChoice.value = v)}
            label={t("tray.remember")}
          />

          {/* Footer slot = action buttons */}
          {{
            footer: () => (
              <>
                <SButton
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleCloseChoice("minimize")}
                >
                  {t("tray.minimize")}
                </SButton>
                <SButton
                  variant="danger"
                  size="sm"
                  onClick={() => void handleCloseChoice("quit")}
                >
                  {t("tray.quit")}
                </SButton>
              </>
            ),
          }}
        </SModal>
      </div>
    );
  },
});
