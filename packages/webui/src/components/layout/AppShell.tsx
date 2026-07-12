import { defineComponent, onBeforeUnmount, onMounted } from "vue";

import { useConfigStore } from "@/stores/config";
import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import { initTheme } from "@/theme/useTheme";
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

    onMounted(() => {
      void initTheme();
      void config.detect();
      void accounts.load();
      gameStatus.start();
    });
    onBeforeUnmount(() => gameStatus.stop());

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
      </div>
    );
  },
});
