import { defineComponent } from "vue";
import { RouterLink } from "vue-router";

import { t } from "@/i18n";
import "./Sidebar.scss";

/**
 * Left sidebar: brand + nav links + spacer + account/game-status footer.
 * 240px wide; the account area at the bottom opens the switcher modal.
 */
export default defineComponent({
  name: "Sidebar",
  setup() {
    return () => (
      <aside class="sidebar">
        <div class="sidebar__brand">{t("common.app.name")}</div>

        <nav class="sidebar__nav">
          <RouterLink to="/" class="sidebar__link" activeClass="is-active" exact>
            <span class="sidebar__link-icon">📊</span>
            <span class="sidebar__link-text">{t("nav.dashboard")}</span>
          </RouterLink>
          <RouterLink to="/lookup" class="sidebar__link" activeClass="is-active">
            <span class="sidebar__link-icon">🔍</span>
            <span class="sidebar__link-text">{t("nav.lookup")}</span>
          </RouterLink>
          <RouterLink to="/replay" class="sidebar__link" activeClass="is-active">
            <span class="sidebar__link-icon">🎬</span>
            <span class="sidebar__link-text">{t("nav.replay")}</span>
          </RouterLink>
        </nav>

        <div class="sidebar__spacer" />

        {/* Account + game status footer — wired in the next step */}
        <div class="sidebar__footer">
          <div class="sidebar__game-status" id="sidebar-game-status">
            <span class="sidebar__status-dot sidebar__status-dot--off" />
            <span class="sidebar__status-text">{t("common.game.offline")}</span>
          </div>
          <div class="sidebar__account" id="sidebar-account">
            <span class="sidebar__account-name">{t("account.notBound")}</span>
          </div>
        </div>
      </aside>
    );
  },
});
