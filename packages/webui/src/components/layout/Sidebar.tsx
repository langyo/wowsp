import { computed, defineComponent, ref } from "vue";
import { RouterLink } from "vue-router";
import { BarChart3, Search, Ship, Film, Settings, Package } from "lucide-vue-next";

import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import AccountSwitcherModal from "@/components/account/AccountSwitcherModal";
import { useClipboard } from "@/composables/useClipboard";
import { t } from "@/i18n";
import type { GameInstallKind } from "@/api";
import "./Sidebar.scss";

/** Map a client kind to its localized label (e.g. Steam / 官服 / Lesta / 国服). */
function kindLabel(kind: GameInstallKind | null | undefined): string {
  if (!kind) return "";
  return t(`common.game.kind.${kind}`);
}

/**
 * Left sidebar: brand + nav links + spacer + footer.
 *
 * Nav links (top): Dashboard / Lookup / Ships / Replay / Resources.
 * Footer (bottom): game-status dot + account button + settings icon button.
 *
 * "Resources" (资源配置) is a new page for managing game mods, custom skins,
 * and voice packs. "Settings" moved to a bottom-left icon button.
 */
export default defineComponent({
  name: "Sidebar",
  setup() {
    const accounts = useAccountStore();
    const gameStatus = useGameStatusStore();
    const { copy } = useClipboard();
    const showSwitcher = ref(false);

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
          <RouterLink to="/resources" class="sidebar__link" activeClass="is-active">
            <Package size={16} class="sidebar__link-icon" />
            <span class="sidebar__link-text">{t("nav.resources")}</span>
          </RouterLink>
        </nav>

        <div class="sidebar__spacer" />

        <div class="sidebar__footer">
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
                  <span class="sidebar__game-client" title={proc.value.exePath ?? undefined}>
                    {clientLabel.value}
                  </span>
                ) : null}
                {proc.value.pid != null ? (
                  <span
                    class="sidebar__game-pid"
                    title={t("common.copied")}
                    onClick={(e: MouseEvent) => {
                      e.stopPropagation();
                      copyPid();
                    }}
                  >
                    {t("common.game.pid")}:{" "}
                    <span class="sidebar__game-pid-val">{proc.value.pid}</span>
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <div class="sidebar__account-row">
            <div class="sidebar__account" onClick={() => (showSwitcher.value = true)}>
              <span class="sidebar__account-name">{accountLabel.value}</span>
            </div>
            {/* Settings as an icon button in the bottom-left */}
            <RouterLink to="/settings" class="sidebar__settings-btn" activeClass="is-active" title={t("nav.settings")}>
              <Settings size={18} />
            </RouterLink>
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
