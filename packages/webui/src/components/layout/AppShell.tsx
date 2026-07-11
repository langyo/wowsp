import { defineComponent, onBeforeUnmount, onMounted } from "vue";

import { useConfigStore } from "@/stores/config";
import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import { initTheme } from "@/theme/useTheme";
import Sidebar from "./Sidebar";
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

    onMounted(() => {
      initTheme();
      void config.detect();
      void accounts.load();
      gameStatus.start();
    });
    onBeforeUnmount(() => gameStatus.stop());

    return () => (
      <div class="app-shell">
        <Sidebar />
        <main class="app-shell__main">
          <router-view />
        </main>
      </div>
    );
  },
});
