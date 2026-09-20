import { defineComponent, onBeforeUnmount, onMounted, ref } from "vue";

import {
  HBlockingToast,
  HCheckbox,
  HErrorBoundary,
  HModal,
  HScrollContainer,
  HToast,
} from "@celestia-island/hikari";

import { useConfigStore } from "@/stores/config";
import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import { useUpdaterStore } from "@/stores/updater";
import { useCacheStore } from "@/stores/cache";
import { initModelPack } from "@/features/holographic/modelLoader";
import { initDogtagPack } from "@/utils/dogtagAssets";
import { api } from "@/api";
import { isTauri } from "@/transport";
import AnnouncementDialog from "./AnnouncementDialog";
import GamePathSetupModal from "@/components/gamedetect/GamePathSetupModal";
import SettingsModal from "./SettingsModal";
import Sidebar from "./Sidebar";
import UpdateToast from "./UpdateToast";
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
 * action group). On first launch (until acknowledged) it also forces the
 * free & open-source notice dialog. Mounts the shared hikari service
 * containers: the toast host and an error boundary around the routed
 * content.
 */
export default defineComponent({
  name: "AppShell",
  setup() {
    const config = useConfigStore();
    const accounts = useAccountStore();
    const gameStatus = useGameStatusStore();
    const updater = useUpdaterStore();
    const cacheStore = useCacheStore();

    const showCloseDialog = ref(false);
    const rememberChoice = ref(false);
    const closing = ref<"quit" | "minimize" | null>(null);
    // Mandatory free & open-source notice: pops until the user acknowledges
    // it through the dialog's own (countdown-gated) button.
    const showNotice = ref(false);
    // Game-path setup: pops on any launch where detection ends without an
    // active install (first launch, moved/unplugged library) so the user is
    // asked to locate the game right away instead of discovering it through
    // a failed armor load later.
    const showGamePathSetup = ref(false);
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
      // Production builds feel like a desktop app: no WebView2 context menu
      // on right-click. Editable elements keep the native menu (paste etc.),
      // and dev mode keeps everything for debugging.
      if (!import.meta.env.DEV) {
        document.addEventListener("contextmenu", (event) => {
          const target = event.target as HTMLElement | null;
          const editable = target?.closest(
            "input, textarea, select, [contenteditable]",
          );
          if (!editable) event.preventDefault();
        });
      }
      // Resource packs (production only; dev uses publicDir). The model pack
      // auto-downloads ONLY when entirely missing (lite install / wiped
      // cache) — an outdated-but-present pack is surfaced as an update in
      // Settings → cache management instead of silently re-pulling ~1.2 GB
      // on every launch. The dog-tag pack is tiny and still auto-refreshes.
      if (!import.meta.env.DEV) {
        void cacheStore.init();
        void (async () => {
          try {
            const status = await api.getPackStatus();
            const models = status.find((p) => p.id === "models");
            if (models && !models.present) {
              await initModelPack(() => api.ensureModelPack());
              return;
            }
            // Present (or status unavailable): refresh the remote stamps so
            // the cache panel's update banner is ready when it opens.
            await cacheStore.refreshUpdates();
          } catch {
            // Older shell without the status command — fall back to the
            // historical unconditional ensure so the pack still wires up.
            void initModelPack(() => api.ensureModelPack()).catch(() => {});
          }
        })();
        // Dog-tag pack overlays the bundled medals snapshot (small; its own
        // release asset so it refreshes without re-downloading the models).
        void initDogtagPack(() => api.ensureDogtagPack()).catch(() => {});
      }
      // Restore the previously-selected client path before detecting, so a
      // rescan keeps the user's choice instead of always picking installs[0].
      // When detection completes WITHOUT an active install, immediately ask
      // for a manual location (the armor/ballistics loader needs a game
      // root). A transient detection failure does not pop the modal — only
      // a resolved-but-empty scan does.
      void config
        .load()
        .then(async () => {
          let detected = false;
          await config.detect().then(
            () => (detected = true),
            () => (detected = false),
          );
          if (detected && !config.activeInstall) {
            showGamePathSetup.value = true;
          }
        })
        .catch(() => {});
      void accounts.load();
      gameStatus.start();

      // Forced notice on first launch (or any launch without a prior ack).
      showNotice.value = localStorage.getItem("wowsp-oss-notice-acked") === null;

      // Shun auto-update: probe portable mode, then a delayed version check.
      // The check itself is silent — failures live in the store for
      // AboutModal only; a newer version raises the hikari blocking-toast
      // prompt from the store. Browser dev mode has no updater.
      if (isTauri()) {
        void updater.init().then(() => updater.scheduleAutoCheck());
      }

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
        {/* Update prompting lives entirely in top-right toast surfaces —
            the updater store raises a blocking toast prompt (立即更新 /
            稍后), then the dedicated UpdateToast pass card (spinner,
            progress bar, 取消); nothing renders inline here. */}
        <Sidebar />
        <main class="app-shell__main">
          {/* Shared page scroll region: the hikari scroll container owns the
              scrollbar (auto-hiding overlay track on the window's right edge)
              and every routed page scrolls inside its viewport. */}
          <HScrollContainer class="app-shell__scroll">
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
          </HScrollContainer>
        </main>
        <HToast />
        {/* Blocking-toast host: mounts right after the transient stack so
            the update prompt card paints above it (hikari's shell
            convention — the two share one top-right column). */}
        <HBlockingToast />
        {/* Updater pass card (download / install progress): renders nothing
            while the store is idle, so it mounts unconditionally next to
            the blocking host in the same top-right column. */}
        <UpdateToast />

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

        {/* Free & open-source notice — the only dismissal is its own ack
            button (closable={false}: no X, no Escape, no backdrop click). */}
        <AnnouncementDialog
          modelValue={showNotice.value}
          onUpdate:modelValue={(v: boolean) => (showNotice.value = v)}
        />

        {/* Game-path first-launch prompt — fires whenever the detect pass
            ends without an active install; also reachable from the
            ship-detail armor-error banner. */}
        <GamePathSetupModal
          modelValue={showGamePathSetup.value}
          onUpdate:modelValue={(v: boolean) => (showGamePathSetup.value = v)}
        />

        {/* Settings modal — app-singleton, opened from the title-bar gear or
            the sidebar's client / account buttons (optionally landing on a
            section); state lives in the settingsUi store. */}
        <SettingsModal />
      </div>
    );
  },
});
