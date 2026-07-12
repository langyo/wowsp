import { computed, defineComponent, ref } from "vue";
import { RouterLink } from "vue-router";
import { BarChart3, Search, Ship, Film, Settings } from "lucide-vue-next";

import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import AccountSwitcherModal from "@/components/account/AccountSwitcherModal";
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
    const showSwitcher = ref(false);

    const accountLabel = computed(() => {
      const a = accounts.activeAccount;
      if (!a) return t("account.notBound");
      return `${a.nickname} [${a.realm.toUpperCase()}]`;
    });

    return () => (
      <aside class="sidebar">
        <div class="sidebar__brand">
          <img src="/logo.webp" alt="WoWSP" class="sidebar__brand-logo" />
          <span>{t("common.app.name")}</span>
        </div>

        <nav class="sidebar__nav">
          <RouterLink to="/" class="sidebar__link" activeClass="is-active" end>
            <BarChart3 size={16} class="sidebar__link-icon" />
            <span class="sidebar__link-text">{t("nav.dashboard")}</span>
          </RouterLink>
          <RouterLink to="/lookup" class="sidebar__link" activeClass="is-active">
            <Search size={16} class="sidebar__link-icon" />
            <span class="sidebar__link-text">{t("nav.lookup")}</span>
          </RouterLink>
          <RouterLink to="/ships" class="sidebar__link" activeClass="is-active">
            <Ship size={16} class="sidebar__link-icon" />
            <span class="sidebar__link-text">{t("nav.ships")}</span>
          </RouterLink>
          <RouterLink to="/replay" class="sidebar__link" activeClass="is-active">
            <Film size={16} class="sidebar__link-icon" />
            <span class="sidebar__link-text">{t("nav.replay")}</span>
          </RouterLink>
          <RouterLink to="/settings" class="sidebar__link" activeClass="is-active">
            <Settings size={16} class="sidebar__link-icon" />
            <span class="sidebar__link-text">{t("nav.settings")}</span>
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
          <div class="sidebar__account" onClick={() => (showSwitcher.value = true)}>
            <span class="sidebar__account-name">{accountLabel.value}</span>
          </div>
        </div>

        <AccountSwitcherModal
          modelValue={showSwitcher.value}
          onUpdate:modelValue={(v: boolean) => (showSwitcher.value = v)}
        />
      </aside>
    );
  },
});
