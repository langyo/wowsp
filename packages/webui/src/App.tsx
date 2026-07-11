import { defineComponent } from "vue";

import "./App.scss";

/**
 * Root application shell. WoWSP has a single shell that hosts the router view;
 * the holographic map and overlay features mount as router pages, and the
 * overlay mode reuses the same shell with a transparent window.
 */
export default defineComponent({
  name: "App",
  setup() {
    return () => (
      <div class="wowsp-shell">
        <router-view />
      </div>
    );
  },
});
