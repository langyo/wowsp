import { defineComponent, onMounted } from "vue";

import { useConfigStore } from "@/stores/config";
import { initTheme } from "@/theme/useTheme";
import Sidebar from "./Sidebar";
import "./AppShell.scss";

/**
 * Root layout shell: sidebar (left) + main content (right). Replaces the
 * old top-nav App. The sidebar hosts navigation + account area + game status.
 */
export default defineComponent({
  name: "AppShell",
  setup() {
    const config = useConfigStore();
    onMounted(() => {
      initTheme();
      void config.detect();
    });
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
