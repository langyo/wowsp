import { defineComponent, onBeforeUnmount, onMounted } from "vue";
import { useRouter } from "vue-router";

import { useConfigStore } from "@/stores/config";
import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import { api } from "@/api";
import { initTheme } from "@/theme/useTheme";
import Sidebar from "./Sidebar";
import WallpaperRenderer from "./WallpaperRenderer";
import "./AppShell.scss";

/**
 * Auto-screenshot harness: navigate to each route, wait for render, capture.
 * Triggered by `?autoscreenshot=1` in the URL — used by the dev workflow to
 * get real runtime screenshots of every page for visual verification.
 */
async function autoScreenshot(router: ReturnType<typeof useRouter>): Promise<void> {
  const pages: { path: string; name: string }[] = [
    { path: "/", name: "dashboard" },
    { path: "/lookup", name: "lookup" },
    { path: "/ships", name: "ships" },
    { path: "/replay", name: "replay" },
    { path: "/settings", name: "settings" },
  ];
  // Give the app a moment to settle (theme apply, sidebar render).
  await sleep(2500);
  for (const page of pages) {
    await router.push(page.path);
    await sleep(2000); // let the page render
    try {
      const savedPath = await api.captureMainWindow("");
      // eslint-disable-next-line no-console
      console.log(`[screenshot] ${page.name} → ${savedPath}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[screenshot] ${page.name} failed:`, e);
    }
    await sleep(300);
  }
  // eslint-disable-next-line no-console
  console.log("[screenshot] done — all pages captured");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Root layout shell: sidebar (left) + main content (right). Loads accounts +
 * starts the game-status poller on mount.
 */
export default defineComponent({
  name: "AppShell",
  setup() {
    const config = useConfigStore();
    const accounts = useAccountStore();
    const gameStatus = useGameStatusStore();
    const router = useRouter();

    onMounted(() => {
      void initTheme();
      void config.detect();
      void accounts.load();
      gameStatus.start();

      // Auto-screenshot mode: when launched with ?autoscreenshot=1, navigate
      // through each route and capture a screenshot for visual verification.
      const params = new URLSearchParams(window.location.search);
      if (params.get("autoscreenshot") === "1") {
        void autoScreenshot(router);
      }
    });
    onBeforeUnmount(() => gameStatus.stop());

    return () => (
      <div class="app-shell">
        <WallpaperRenderer />
        <Sidebar />
        <main class="app-shell__main">
          <router-view />
        </main>
      </div>
    );
  },
});
