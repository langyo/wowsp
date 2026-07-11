import { defineComponent } from "vue";
import { RouterLink, useRoute } from "vue-router";

import { t } from "@/i18n";
import "./App.scss";

/**
 * Root application shell. Hosts a top navigation bar (Home / Replay / Overlay)
 * above the router view. The overlay route hides the nav bar so the window can
 * be a clean transparent overlay in game.
 */
export default defineComponent({
  name: "App",
  setup() {
    const route = useRoute();
    return () => (
      <div class="wowsp-shell">
        {route.name !== "overlay" ? (
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
              <RouterLink to="/overlay" class="wowsp-nav__link" activeClass="is-active">
                {t("nav.overlay")}
              </RouterLink>
            </div>
          </nav>
        ) : null}
        <main class="wowsp-content">
          <router-view />
        </main>
      </div>
    );
  },
});
