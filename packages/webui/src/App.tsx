import { defineComponent } from "vue";
import { RouterLink } from "vue-router";

import { t } from "@/i18n";
import "./App.scss";

/**
 * Root component for the MAIN window. Hosts a top navigation bar (Home / Replay)
 * above the router view. The overlay window uses OverlayApp instead — it does
 * not mount this component, the router, or the title bar.
 */
export default defineComponent({
  name: "App",
  setup() {
    return () => (
      <div class="wowsp-shell">
        <nav class="wowsp-nav">
          <RouterLink to="/" class="wowsp-nav__brand">
            {t("common.app.name")}
          </RouterLink>
          <div class="wowsp-nav__links">
            <RouterLink to="/" class="wowsp-nav__link" activeClass="is-active" exact>
              {t("nav.home")}
            </RouterLink>
            <RouterLink to="/replay" class="wowsp-nav__link" activeClass="is-active">
              {t("nav.replay")}
            </RouterLink>
          </div>
        </nav>
        <main class="wowsp-content">
          <router-view />
        </main>
      </div>
    );
  },
});
