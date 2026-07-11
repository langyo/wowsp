import { computed, defineComponent } from "vue";
import { RouterLink } from "vue-router";

import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import { t } from "@/i18n";
import "./Sidebar.scss";

/**
 * Left sidebar: brand + nav links + spacer + account/game-status footer.
 * 240px wide; the account area opens the switcher modal (wired next).
 */
export default defineComponent({
  name: "Sidebar",
  setup() {
    const accounts = useAccountStore();
    const gameStatus = useGameStatusStore();

    const accountLabel = computed(() => {
      const a = accounts.activeAccount;
      if (!a) return t("account.notBound");
      return `${a.nickname} [${a.realm.toUpperCase()}]`;
    });

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

        <div class="sidebar__footer">
          <div class="sidebar__game-status">
            <span
              class={[
                "sidebar__status-dot",
                gameStatus.running ? "sidebar__status-dot--on" : "sidebar__status-dot--off",
              ]}
            />
            <span class="sidebar__status-text">
              {gameStatus.running ? t("common.game.online") : t("common.game.offline")}
            </span>
          </div>
          <div class="sidebar__account">
            <span class="sidebar__account-name">{accountLabel.value}</span>
          </div>
        </div>
      </aside>
    );
  },
});
