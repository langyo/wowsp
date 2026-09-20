import { computed, defineComponent } from "vue";
import { RouterLink } from "vue-router";
import { BarChart3, Search, Ship, Film, Package } from "@lucide/vue";

import { HTooltip } from "@celestia-island/hikari";

import { useAccountStore } from "@/stores/account";
import { useConfigStore } from "@/stores/config";
import { useGameStatusStore } from "@/stores/gameStatus";
import { useSettingsUiStore } from "@/stores/settingsUi";
import { useClipboard } from "@/composables/useClipboard";
import { t } from "@/i18n";
import { installLabel, kindLabel } from "@/utils/installLabel";
import "./Sidebar.scss";

/**
 * Left sidebar: brand + nav links + spacer + footer.
 *
 * Nav links (top): Dashboard / Lookup / Ships / Replay / Resources.
 * Footer (bottom): game-status indicator, then two full-width buttons in
 * the same style — the active game client (opens settings on 游戏路径)
 * and the active account (opens settings on 账户). Management itself lives
 * in the settings modal; the footer only mirrors the current state.
 *
 * The active client is the app-wide context — the replay list, mod hub and
 * account auto-switching all follow it — so its tooltip shows the full
 * install path.
 */
export default defineComponent({
  name: "Sidebar",
  setup() {
    const accounts = useAccountStore();
    const config = useConfigStore();
    const gameStatus = useGameStatusStore();
    const ui = useSettingsUiStore();
    const { copy } = useClipboard();

    const accountLabel = computed(() => {
      const a = accounts.activeAccount;
      if (!a) return t("account.notBound");
      return `${a.nickname} [${a.realm.toUpperCase()}]`;
    });

    const running = computed(() => gameStatus.process.running);
    const proc = computed(() => gameStatus.process);

    // "Steam · ASIA" or just "Steam" when realm is unknown.
    const clientLabel = computed(() => {
      const k = kindLabel(proc.value.kind);
      const r = proc.value.realm?.toUpperCase();
      return [k, r].filter(Boolean).join(" · ");
    });

    // Footer button: the ACTIVE install (what data reads use), not the
    // running process — they can differ while another client is playing.
    const activeInstallLabel = computed(() => {
      const i = config.activeInstall;
      return i ? installLabel(i.kind, i.realm) : "";
    });
    const activeInstallPath = computed(() => config.activeInstall?.path ?? "");

    function copyPid() {
      if (proc.value.pid != null) {
        void copy(String(proc.value.pid), t("common.copied"));
      }
    }

    return () => (
      <aside class="sidebar">
        <div class="sidebar__brand">
          <img src="/logo.webp" alt="WoWSP" class="sidebar__brand-logo" />
          <span>{t("common.app.name")}</span>
        </div>

        <nav class="sidebar__nav">
          <RouterLink to="/" class="sidebar__link" activeClass="is-active" exactActiveClass="is-active">
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
          <RouterLink to="/resources" class="sidebar__link" activeClass="is-active">
            <Package size={16} class="sidebar__link-icon" />
            <span class="sidebar__link-text">{t("nav.resources")}</span>
          </RouterLink>
        </nav>

        <div class="sidebar__spacer" />

        <div class="sidebar__footer">
          {/* game status — an indicator, not a control */}
          <div class={["sidebar__game-status", running.value ? "is-running" : "is-offline"]}>
            <div class="sidebar__game-status-row">
              <span
                class={[
                  "sidebar__status-dot",
                  running.value ? "sidebar__status-dot--on" : "sidebar__status-dot--off",
                ]}
              />
              <span class="sidebar__status-text">
                {running.value ? t("common.game.online") : t("common.game.offline")}
              </span>
            </div>
            {running.value ? (
              <div class="sidebar__game-detail">
                {clientLabel.value ? (
                  <HTooltip
                    text={proc.value.exePath ?? ""}
                    placement="right"
                  >
                    <span class="sidebar__game-client">{clientLabel.value}</span>
                  </HTooltip>
                ) : null}
                {proc.value.pid != null ? (
                  <HTooltip text={t("common.clickToCopy")} placement="right">
                    <span
                      class="sidebar__game-pid"
                      onClick={(e: MouseEvent) => {
                        e.stopPropagation();
                        copyPid();
                      }}
                    >
                      {t("common.game.pid")}:{" "}
                      <span class="sidebar__game-pid-val">{proc.value.pid}</span>
                    </span>
                  </HTooltip>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* active client — same button style as the account below; opens
              settings on the 游戏路径 table where clients are switched */}
          <HTooltip text={activeInstallPath.value || t("common.gamePath.noneFound")} placement="right">
            <button
              type="button"
              class="sidebar__footer-btn"
              onClick={() => ui.show("gamePath")}
            >
              <span class="sidebar__footer-btn-label">
                {activeInstallLabel.value || t("replay.client")}
              </span>
            </button>
          </HTooltip>

          {/* active account — opens settings on the 账户 section */}
          <button type="button" class="sidebar__footer-btn" onClick={() => ui.show("account")}>
            <span class="sidebar__footer-btn-label">{accountLabel.value}</span>
          </button>
        </div>
      </aside>
    );
  },
});
