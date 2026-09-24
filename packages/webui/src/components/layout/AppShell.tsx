import { defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import {
  HkBlockingToast,
  HkCheckbox,
  HkDrawer,
  HkErrorBoundary,
  HkModal,
  HkScrollContainer,
  HkToast,
  useBreakpoint,
} from "@celestia-island/hikari";

import { useConfigStore } from "@/stores/config";
import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import { useUpdaterStore } from "@/stores/updater";
import { useCacheStore } from "@/stores/cache";
import { useNavUiStore } from "@/stores/navUi";
import { useSettingsUiStore } from "@/stores/settingsUi";
import { useCloseBehaviorStore } from "@/stores/closeBehavior";
import { initModelPack } from "@/features/holographic/modelLoader";
import { initDogtagPack } from "@/utils/dogtagAssets";
import { api } from "@/api";
import { isMobileApp, isTauri } from "@/utils/platform";
import OnboardingWizard from "./OnboardingWizard";
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
 * event to show a quit-vs-minimize confirm dialog (HkModal with a footer
 * action group), unless a choice was already remembered in the closeBehavior
 * store (the same one the settings' closeBehavior section edits) — then that
 * action runs straight away. On first launch (until completed) it also runs
 * the four-step onboarding wizard, whose first step carries the mandatory
 * free & open-source notice. Mounts the shared hikari service
 * containers: the toast host and an error boundary around the routed
 * content.
 *
 * Phone LAYOUT (viewport < 768px, hikari useBreakpoint): the persistent
 * sidebar becomes a left nav DRAWER (hamburger in the title bar toggles
 * it; hikari's back guard pushes a history entry so the Android back
 * gesture closes it; route changes close it too) and the settings modal
 * is not mounted — settingsUi.show() navigates to the /settings page
 * instead. The phone APP build (isMobileApp) additionally skips the
 * game-path setup prompt, the desktop updater and its toast surfaces.
 */
export default defineComponent({
  name: "AppShell",
  setup() {
    const config = useConfigStore();
    const accounts = useAccountStore();
    const gameStatus = useGameStatusStore();
    const updater = useUpdaterStore();
    const cacheStore = useCacheStore();
    const navUi = useNavUiStore();
    const settingsUi = useSettingsUiStore();
    const closeBehavior = useCloseBehaviorStore();
    const route = useRoute();
    const router = useRouter();
    // Phone LAYOUT (viewport width — NOT the phone-app platform gate):
    // drawer nav + settings page instead of sidebar + modal.
    const { isMobile } = useBreakpoint();
    // Phone APP build gate (see utils/platform): desktop-only features
    // (game-path prompt, updater, its toasts) stay off there.
    const mobileApp = isMobileApp();

    const showCloseDialog = ref(false);
    const rememberChoice = ref(false);
    const closing = ref<"quit" | "minimize" | null>(null);
    // First-launch setup wizard (notice ack → prefs → theme → wallpaper).
    // Runs until completed — its absence includes pre-wizard installs, who
    // walk it once to adopt the new preference system. The wizard itself
    // also writes the legacy notice ack so older builds stay quiet.
    const showOnboarding = ref(
      localStorage.getItem("wowsp-onboarding-completed") === null,
    );
    // Game-path setup: pops on any launch where detection ends without an
    // active install (first launch, moved/unplugged library) so the user is
    // asked to locate the game right away instead of discovering it through
    // a failed armor load later — but never while the onboarding wizard is
    // up (it would cover the wizard); completing the wizard releases it.
    // The phone app build has no local game install to locate — never pops.
    const gamePathMissing = ref(false);
    const showGamePathSetup = ref(false);
    let unlistenClose: UnlistenFn | null = null;

    function syncGamePathSetup() {
      showGamePathSetup.value = gamePathMissing.value && !showOnboarding.value;
    }

    watch(showOnboarding, () => syncGamePathSetup());

    // Drawer hygiene: any navigation (nav link, footer button, settings
    // gear) closes the phone-layout drawer.
    watch(
      () => route.fullPath,
      () => navUi.close(),
    );

    // Layout flip while the desktop settings modal is open (e.g. a narrow
    // desktop window squeezed under 768px): hand the surface over to the
    // settings page instead of the modal vanishing mid-interaction.
    watch(isMobile, (phone) => {
      if (phone && settingsUi.visible) {
        settingsUi.hide();
        void router.push({
          path: "/settings",
          query: { section: settingsUi.section },
        });
      }
    });

    async function handleCloseChoice(action: "quit" | "minimize") {
      // "Remember my choice" writes the SAME slot the settings' closeBehavior
      // radio edits, so a remembered close is always reversible there.
      if (rememberChoice.value) {
        closeBehavior.setAction(action);
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
      // Resource pack (production only; dev uses publicDir). APP UPDATES
      // GO FIRST: this pass waits for the updater's delayed probe, so a
      // pending app update (whose installer restarts the app) always
      // precedes a ~1.2 GB pack pull — the pack catches up after the
      // restart. The pack auto-downloads ONLY when entirely missing (lite
      // install / wiped cache); an outdated-but-present pack is surfaced
      // in Settings → updates instead of silently re-pulling. The phone
      // app build skips the updater entirely (update commands are
      // unsupported there — failures stay quiet); its pack ships INSIDE
      // the APK, so it never downloads either — the updates panel is the
      // only mobile download path.
      if (!import.meta.env.DEV) {
        void cacheStore.init();
        void (async () => {
          // Phone build: bundled pack + optional downloaded update. Report
          // the bundled baseline first (same-origin /wowsp-res.json → the
          // shell's res commands), then wire the model/dogtag loaders to
          // the cache ONLY when a downloaded update is serving — otherwise
          // the loaders keep their default same-origin bundled URLs. No
          // ensure/download on startup, ever.
          if (mobileApp) {
            try {
              await cacheStore.reportBundledBaseline();
              const root = await api.resCacheRoot();
              if (root) {
                void initDogtagPack(async () => root).catch(() => {});
                void initModelPack(async () => root).catch(() => {});
              }
            } catch {
              // Older shell — bundled same-origin assets serve.
            }
            return;
          }
          try {
            await updater.init().then(() => updater.waitForCheck());
            if (updater.available) {
              // A newer build is pending and its prompt is up — the pack
              // waits for the post-update restart.
              return;
            }
            // Dog-tag assets prefer the cached pack (models + dogtags ship
            // as one content-addressed pack); the bundled snapshot serves
            // while the pack is absent.
            void initDogtagPack(() => api.ensureResPack()).catch(() => {});
            const status = await api.getResStatus();
            // Ship GLBs are pruned from the production dist, so every
            // model URL resolves through the pack cache root — wire it
            // even when the pack is present (local-only, no manifest
            // fetch; missing packs wire through the ensure flow below).
            void api
              .resCacheRoot()
              .then((root) => (root ? initModelPack(async () => root) : undefined))
              .catch(() => {});
            if (!status.present) {
              await initModelPack(() => api.ensureResPack());
              return;
            }
            // Present (or status unavailable): refresh the remote manifest
            // so the updates panel's banner is ready when it opens.
            await cacheStore.refreshUpdates();
          } catch {
            // Older shell / offline — fall back to the unconditional
            // ensure so the pack still wires up (it serves whatever is on
            // disk when the network is unreachable).
            void initModelPack(() => api.ensureResPack()).catch(() => {});
          }
        })();
      }
      // Restore the previously-selected client path before detecting, so a
      // rescan keeps the user's choice instead of always picking installs[0].
      // When detection completes WITHOUT an active install, ask for a manual
      // location once the onboarding wizard is out of the way (the armor /
      // ballistics loader needs a game root). A transient detection failure
      // does not pop the modal — only a resolved-but-empty scan does.
      void config
        .load()
        .then(async () => {
          let detected = false;
          await config.detect().then(
            () => (detected = true),
            () => (detected = false),
          );
          gamePathMissing.value = detected && !config.activeInstall && !mobileApp;
          syncGamePathSetup();
        })
        .catch(() => {});
      void accounts.load();
      gameStatus.start();

      // Shun auto-update: probe portable mode, then a delayed version check.
      // The check itself is silent — failures live in the store for
      // AboutModal only; a newer version raises the hikari blocking-toast
      // prompt from the store. Browser dev mode has no updater, and the
      // phone app build has no desktop updater at all (updates ship through
      // the store pipeline there — keep it quiet).
      if (isTauri() && !mobileApp) {
        void updater.init().then(() => updater.scheduleAutoCheck());
      }

      // The close-requested event only exists inside the Tauri shell; in a
      // plain browser tab listen() would throw at mount, so guard it (the
      // close dialog is desktop-app-only anyway).
      if (isTauri()) {
        unlistenClose = await listen("close-requested", () => {
          // The remembered action (AppShell's dialog checkbox / the settings'
          // closeBehavior radio — one store, one slot). "ask" is the stored
          // absence of a choice, and the store's loader already swept any
          // junk value on import, so no heal-write is needed here.
          const saved = closeBehavior.action;
          if (saved !== "ask") {
            void handleCloseChoice(saved);
          } else {
            // Fresh ask: the checkbox writes the SAME slot the settings'
            // closeBehavior radio edits, so a tick left over from an earlier
            // close would silently re-arm an action the user just cleared.
            rememberChoice.value = false;
            showCloseDialog.value = true;
          }
        });
      }
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
        {isMobile.value ? (
          // Phone-layout nav: the sidebar lives in a left drawer behind
          // the title-bar hamburger. hikari's back guard pushes a history
          // entry on open, so the Android back gesture (and the desktop
          // browser's back) closes it before anything else; route changes
          // close it via the watcher above.
          <HkDrawer
            modelValue={navUi.open}
            onUpdate:modelValue={(v: boolean) => (navUi.open = v)}
            side="left"
            title={t("nav.menu")}
            size="min(18.75rem, 84vw)"
          >
            <Sidebar variant="drawer" />
          </HkDrawer>
        ) : (
          <Sidebar />
        )}
        <main class="app-shell__main">
          {/* Shared page scroll region: the hikari scroll container owns the
              scrollbar (auto-hiding overlay track on the window's right edge)
              and every routed page scrolls inside its viewport. */}
          <HkScrollContainer class="app-shell__scroll">
            <HkErrorBoundary name="AppShell" retryLabel={t("common.reload")}>
              <router-view
                v-slots={{
                  default: ({ Component, route }: { Component: unknown; route: { path: string } }) => (
                    <div class="app-shell__page" key={route.path}>
                      {Component as JSX.Element}
                    </div>
                  ),
                }}
              />
            </HkErrorBoundary>
          </HkScrollContainer>
        </main>
        <HkToast />
        {/* Blocking-toast host: mounts right after the transient stack so
            the update prompt card paints above it (hikari's shell
            convention — the two share one top-right column). */}
        <HkBlockingToast />
        {/* Updater pass card (download / install progress): renders nothing
            while the store is idle, so it mounts unconditionally next to
            the blocking host in the same top-right column. */}
        <UpdateToast />

        {/* Close confirm dialog — footer carries the action button group. */}
        <HkModal
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
                <HkCheckbox
                  modelValue={rememberChoice.value}
                  onUpdate:modelValue={(v: boolean) => (rememberChoice.value = v)}
                  label={t("tray.remember")}
                />
              </div>
            ),
          }}
        </HkModal>

        {/* First-launch setup wizard — a non-closable window on the shared
            modal shell; the only way forward is finishing it (its first step
            carries the old notice's countdown-gated ack). */}
        <OnboardingWizard
          modelValue={showOnboarding.value}
          onUpdate:modelValue={(v: boolean) => (showOnboarding.value = v)}
        />

        {/* Game-path first-launch prompt — fires whenever the detect pass
            ends without an active install; also reachable from the
            ship-detail armor-error banner. Never on the phone app build
            (no local game install to locate — the flag itself stays
            false there, this is a belt-and-braces render guard). */}
        {!mobileApp ? (
          <GamePathSetupModal
            modelValue={showGamePathSetup.value}
            onUpdate:modelValue={(v: boolean) => (showGamePathSetup.value = v)}
          />
        ) : null}

        {/* Settings modal — the DESKTOP-layout surface of the shared
            settings body, app-singleton, opened from the title-bar gear or
            the sidebar's client / account buttons (optionally landing on a
            section); state lives in the settingsUi store. Phone layout
            never mounts it — settingsUi.show() routes to /settings there
            (a full page with the same body). */}
        {!isMobile.value ? <SettingsModal /> : null}
      </div>
    );
  },
});
