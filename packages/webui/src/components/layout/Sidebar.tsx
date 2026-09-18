import { computed, defineComponent, ref } from "vue";
import { RouterLink } from "vue-router";
import { BarChart3, Search, Ship, Film, Settings, Package } from "@lucide/vue";

import { HSelect, HTooltip, useToast } from "@celestia-island/hikari";

import { useAccountStore } from "@/stores/account";
import { useGameStatusStore } from "@/stores/gameStatus";
import { useGameDetect } from "@/features/gamedetect/useGameDetect";
import AccountSwitcherModal from "@/components/account/AccountSwitcherModal";
import SettingsModal from "@/components/layout/SettingsModal";
import { useClipboard } from "@/composables/useClipboard";
import { t } from "@/i18n";
import { api, type GameInstallKind } from "@/api";
import "./Sidebar.scss";

/** Option value that opens the native game-folder picker instead of picking
 *  an install — never becomes the select's model value. */
const MANUAL_PATH_VALUE = "__pick__";

/** Map a client kind to its localized label (e.g. Steam / 官服 / Lesta / 国服). */
function kindLabel(kind: GameInstallKind | null | undefined): string {
  if (!kind) return "";
  return t(`common.game.kind.${kind}`);
}

/** Short label for a client option: "Steam · ASIA" (kind only when the realm
 *  is unknown). */
function installLabel(kind: GameInstallKind, realm?: string | null): string {
  const parts = [kindLabel(kind)];
  if (realm) parts.push(realm.toUpperCase());
  return parts.join(" · ");
}

/**
 * Left sidebar: brand + nav links + spacer + footer.
 *
 * Nav links (top): Dashboard / Lookup / Ships / Replay / Resources.
 * Footer (bottom): server (client-install) selector + game-status dot +
 * account button + settings icon button.
 *
 * The server selector is the app-wide client context — the replay list, mod
 * hub and account auto-switching all follow it. Switching to a server with a
 * bound account activates that realm's preferred account; the "选择游戏路径…"
 * option opens the native folder picker for installs auto-detection missed.
 */
export default defineComponent({
  name: "Sidebar",
  setup() {
    const accounts = useAccountStore();
    const gameStatus = useGameStatusStore();
    const gd = useGameDetect();
    const toast = useToast();
    const { copy } = useClipboard();
    const showSwitcher = ref(false);
    const showSettings = ref(false);
    const pickingPath = ref(false);

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

    // Server-selector options: one per detected install + the manual picker.
    const serverOptions = computed(() => [
      ...gd.config.installs.map((i) => ({
        value: i.path,
        label: installLabel(i.kind, i.realm),
      })),
      { value: MANUAL_PATH_VALUE, label: t("common.gamePath.pick") },
    ]);
    const activePath = computed(() => gd.config.activeInstall?.path ?? "");

    /** Follow a server change to that realm's preferred account. */
    async function followRealm(realm?: string | null) {
      if (!realm) return;
      const switched = await accounts.autoSwitchRealm(realm);
      if (switched) {
        toast.info(t("account.autoSwitched", { name: switched.nickname }));
      }
    }

    async function onSelectServer(value: string) {
      if (value === MANUAL_PATH_VALUE) {
        await pickInstallFolder();
        return;
      }
      const install = gd.config.installs.find((i) => i.path === value);
      await gd.config.selectInstall(value);
      if (install) await followRealm(install.realm);
    }

    /** Native folder picker → validate → pin as the active install. */
    async function pickInstallFolder() {
      if (pickingPath.value) return;
      pickingPath.value = true;
      try {
        const picked = await api.pickGameFolder();
        if (!picked) return;
        await gd.config.setManualPath(picked.path);
        await followRealm(picked.realm);
        toast.info(t("common.gamePath.applied"));
      } catch (e) {
        toast.error(`${t("common.gamePath.invalid")}\n${(e as Error).message || e}`);
      } finally {
        pickingPath.value = false;
      }
    }

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
          <HTooltip
            text={activePath.value || t("common.gamePath.noneFound")}
            placement="right"
          >
            <div class="sidebar__server">
              <HSelect
                modelValue={activePath.value}
                onUpdate:modelValue={(v: string) => void onSelectServer(v)}
                options={serverOptions.value}
                placeholder={t("replay.client")}
                disabled={pickingPath.value}
              />
            </div>
          </HTooltip>
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
          <div class="sidebar__account-row">
            <div class="sidebar__account" onClick={() => (showSwitcher.value = true)}>
              <span class="sidebar__account-name">{accountLabel.value}</span>
            </div>
            {/* Settings as an icon button in the bottom-left — opens the
                settings modal instead of routing to a dedicated page */}
            <HTooltip text={t("nav.settings")} placement="right">
              <button
                type="button"
                class="sidebar__settings-btn"
                onClick={() => (showSettings.value = true)}
              >
                <Settings size={18} />
              </button>
            </HTooltip>
          </div>
        </div>

        <AccountSwitcherModal
          modelValue={showSwitcher.value}
          onUpdate:modelValue={(v: boolean) => (showSwitcher.value = v)}
        />
        <SettingsModal
          modelValue={showSettings.value}
          onUpdate:modelValue={(v: boolean) => (showSettings.value = v)}
        />
      </aside>
    );
  },
});
