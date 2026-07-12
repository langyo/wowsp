import { defineComponent, onBeforeUnmount, onMounted } from "vue";
import { useRouter } from "vue-router";

import { useConfigStore } from "@/stores/config";
import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import { initTheme } from "@/theme/useTheme";
import { exposeAutoTest, startAutoTest } from "@/dev/autoTest";
import Sidebar from "./Sidebar";
import WallpaperRenderer from "./WallpaperRenderer";
import "./AppShell.scss";

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

      // Auto-test mode: drive real interactions (clicks, input, tab switches,
      // theme toggles) and capture screenshots after each. Triggered by
      // ?autotest=1 URL param OR the Rust trigger_autotest command (which
      // calls window.__wowspAutoTest__()).
      exposeAutoTest(router); // always expose, so Rust can trigger it
      const params = new URLSearchParams(window.location.search);
      const urlFlag = params.get("autotest") === "1";
      if (urlFlag) {
        startAutoTest(router);
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
