import { computed, defineComponent, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { BarChart3, Search, Ship, Film, Video, Crosshair, Package, AlertTriangle } from "@lucide/vue";

import { HkTag, HkTooltip } from "@celestia-island/hikari";

import PlayerBadge from "@/components/base/PlayerBadge";
import PluginUpdateHint from "@/components/layout/PluginUpdateHint";
import PlatformIcon from "@/components/base/PlatformIcon";
import { useAccountStore } from "@/stores/account";
import { useConfigStore } from "@/stores/config";
import { useGameStatusStore } from "@/stores/gameStatus";
import { useSessionStore } from "@/stores/session";
import { useSettingsUiStore } from "@/stores/settingsUi";
import { usePluginUpdatesStore } from "@/stores/pluginUpdates";
import { useStaleBinsStore } from "@/stores/staleBins";
import { useStatsStore } from "@/stores/stats";
import { useClipboard } from "@/composables/useClipboard";
import { t } from "@/i18n";
import { isMobileApp } from "@/utils/platform";
import { kindLabel } from "@/utils/installLabel";
import type { PlayerStats, SessionPlayer } from "@/api";
import "./Sidebar.scss";

/**
 * Left sidebar: nav links + spacer + footer.
 *
 * Nav links (top): Dashboard / Lookup / Ships / Live / Replay / Tactics /
 * Resources. Live watch the local game install, so they hide on
 * the phone app build (no local game / install there).
 * Footer (bottom): game-status indicator, a conditional game-upgrade
 * prompt (stranded-mod migration, deep-links into the mod hub's wizard),
 * then two full-width key/value buttons in the same style — the active
 * game client (opens settings on 游戏路径) and the active account (opens
 * settings on 账户). Management itself lives in the settings surface; the
 * footer only mirrors the current state.
 *
 * The active client is the app-wide context — the replay list, mod hub and
 * account auto-switching all follow it — so its tooltip shows the full
 * install path.
 *
 * `variant="drawer"` re-hosts the same nav inside the phone-layout nav
 * drawer (AppShell's HkDrawer): the footer keeps the safe-area breathing
 * room there.
 * On the phone APP build the client button is hidden (its settings section
 * is unavailable there).
 */
export default defineComponent({
  name: "Sidebar",
  props: {
    variant: {
      type: String as () => "sidebar" | "drawer",
      default: "sidebar",
    },
  },
  setup(props) {
    const accounts = useAccountStore();
    const config = useConfigStore();
    const gameStatus = useGameStatusStore();
    const session = useSessionStore();
    const stats = useStatsStore();
    const ui = useSettingsUiStore();
    const pluginUpdates = usePluginUpdatesStore();
    const staleBins = useStaleBinsStore();
    const router = useRouter();
    const { copy } = useClipboard();
    // The dashboard link must also read active while the section's sibling
    // view (游玩时间, /playtime) is open — the pill in the title bar
    // presents the two as one section, the sidebar agrees.
    const route = useRoute();

    // The account row's player: the session hub's RESOLVED identity when
    // the hub is reachable — it carries the actually-playing account (the
    // battle roster's local player, matched against the bound profiles, so
    // same-realm alts are told apart) and even unregistered alts the store
    // cannot represent. Falls back to the store's active selection (browser
    // dev / older shell, where the hub snapshot stays null).
    const shownPlayer = computed<SessionPlayer | null>(() => {
      if (session.display) return session.display;
      const a = accounts.activeAccount;
      return a
        ? {
            accountId: a.accountId,
            nickname: a.nickname,
            realm: a.realm,
            registered: true,
            playing: false,
          }
        : null;
    });

    // Cached stats for the displayed account — only the emblem (dog tag /
    // service-record tier) feeds the sidebar avatar. READ THROUGH the
    // shared stats store's cache — the same reactive snapshot the
    // dashboard header renders — so a dashboard refresh (or any other
    // lookup) updates the sidebar live instead of diverging into a stale
    // local copy. Hydration below stays cache-only (loadCached), never
    // the API (same policy as the account cards).
    const activeStats = computed<PlayerStats | null>(() => {
      const a = shownPlayer.value;
      return a?.accountId != null
        ? stats.cache.get(`${a.realm}_${a.accountId}`) ?? null
        : null;
    });
    watch(
      () => shownPlayer.value,
      async (a) => {
        // Warm the shared cache from disk so the emblem is there on cold
        // start; the computed above reacts when the map fills.
        if (a?.accountId != null) await stats.loadCached(a.realm, a.accountId);
      },
      { immediate: true },
    );

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
    const activeInstall = computed(() => config.activeInstall ?? null);
    const activeInstallPath = computed(() => activeInstall.value?.path ?? "");

    function copyPid() {
      if (proc.value.pid != null) {
        void copy(String(proc.value.pid), t("common.copied"));
      }
    }

    return () => (
      <aside class={["sidebar", props.variant === "drawer" ? "sidebar--drawer" : ""]}>
        {/* No brand row: the title bar above already carries the WoWSP
            identity — the nav's generous top padding keeps the first link
            off the rail's top edge instead. */}
        <nav class="sidebar__nav">
          <RouterLink
            to="/"
            class={["sidebar__link", { "is-active": route.path === "/playtime" }]}
            activeClass="is-active"
            exactActiveClass="is-active"
          >
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
          {/* Live battle watches the LOCAL game install — desktop app
              territory (same guard as the footer client button; one branch
              covers the drawer variant too). Tactics analysis works from the
              bundled map catalog with touch gestures, so phones get it too. */}
          {!isMobileApp() ? (
            <RouterLink to="/live" class="sidebar__link" activeClass="is-active">
              <Video size={16} class="sidebar__link-icon" />
              <span class="sidebar__link-text">{t("nav.live")}</span>
            </RouterLink>
          ) : null}
          <RouterLink to="/replay" class="sidebar__link" activeClass="is-active">
            <Film size={16} class="sidebar__link-icon" />
            <span class="sidebar__link-text">{t("nav.replay")}</span>
          </RouterLink>
          <RouterLink to="/tactics" class="sidebar__link" activeClass="is-active">
            <Crosshair size={16} class="sidebar__link-icon" />
            <span class="sidebar__link-text">{t("nav.tactics")}</span>
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
                  <HkTooltip
                    text={proc.value.exePath ?? ""}
                    placement="right"
                  >
                    <span class="sidebar__game-client">{clientLabel.value}</span>
                  </HkTooltip>
                ) : null}
                {proc.value.pid != null ? (
                  <HkTooltip text={t("common.clickToCopy")} placement="right">
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
                  </HkTooltip>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* game upgrade — the ACTIVE install still holds mods (and
              possibly the in-game probe) stranded in an old bin/. The
              client-version row below is where the user looks for "what's
              my game", so the migration prompt rides right above it and
              deep-links into the mod hub's wizard (?migrate=1 auto-opens
              it on the confirm step). Desktop-app territory, like the row
              below: the phone build has no local installs to migrate. */}
          {!isMobileApp() && staleBins.hasStale && activeInstallPath.value ? (
            <HkTooltip
              class="sidebar__footer-slot"
              text={t("resources.staleSidebarTip")}
              placement="right"
            >
              <button
                type="button"
                class="sidebar__footer-btn sidebar__footer-btn--migrate"
                onClick={() => router.push("/resources?migrate=1")}
              >
                <span class="sidebar__footer-btn-key">
                  {t("resources.staleSidebarKey")}
                </span>
                <span class="sidebar__footer-btn-value">
                  <AlertTriangle size={16} class="sidebar__migrate-icon" />
                  <span class="sidebar__footer-btn-text">
                    {t(
                      staleBins.probeStranded
                        ? "resources.staleSidebarTextProbe"
                        : "resources.staleSidebarText",
                      { count: staleBins.totalFiles },
                    )}
                  </span>
                </span>
              </button>
            </HkTooltip>
          ) : null}

          {/* active client — same button style as the account below; opens
              settings on the 游戏路径 table where clients are switched.
              Phone app build: no local installs to switch — the whole row
              (and its settings section) is desktop-app territory. */}
          {!isMobileApp() ? (
          // While plugins await updates the selector wears a count badge
          // and the hover surface becomes PluginUpdateHint (stale-plugin
          // list + one-click update); otherwise the plain path tooltip.
          pluginUpdates.activeCount > 0 ? (
          <PluginUpdateHint class="sidebar__footer-slot">
            <button
              type="button"
              class="sidebar__footer-btn"
              onClick={() => ui.show("gamePath")}
            >
              <span class="sidebar__footer-btn-key">{t("common.game.versionLabel")}</span>
              <span class="sidebar__footer-btn-value">
                {/* 22px matches the PlayerBadge on the account row below so
                    the two text columns share one left edge. */}
                <PlatformIcon kind={activeInstall.value?.kind} size={22} />
                <span class="sidebar__footer-btn-text">
                  {activeInstall.value
                    ? kindLabel(activeInstall.value.kind)
                    : t("common.gamePath.unset")}
                </span>
                {activeInstall.value?.realm ? (
                  <HkTag variant="default" size="sm">
                    {activeInstall.value.realm.toUpperCase()}
                  </HkTag>
                ) : null}
              </span>
            </button>
          </PluginUpdateHint>
          ) : (
          <HkTooltip
            class="sidebar__footer-slot"
            text={activeInstallPath.value || t("common.gamePath.noneFound")}
            placement="right"
          >
            <button
              type="button"
              class="sidebar__footer-btn"
              onClick={() => ui.show("gamePath")}
            >
              <span class="sidebar__footer-btn-key">{t("common.game.versionLabel")}</span>
              <span class="sidebar__footer-btn-value">
                {/* 22px matches the PlayerBadge on the account row below so
                    the two text columns share one left edge. */}
                <PlatformIcon kind={activeInstall.value?.kind} size={22} />
                <span class="sidebar__footer-btn-text">
                  {activeInstall.value
                    ? kindLabel(activeInstall.value.kind)
                    : t("common.gamePath.unset")}
                </span>
                {activeInstall.value?.realm ? (
                  <HkTag variant="default" size="sm">
                    {activeInstall.value.realm.toUpperCase()}
                  </HkTag>
                ) : null}
              </span>
            </button>
          </HkTooltip>
          )) : null}

          {/* active account — opens settings on the 账户 section. Shows the
              session-resolved identity: when a battle identified the
              actually-playing account it is tagged (and unregistered alts
              say so — the settings modal is where they get bound). */}
          <button type="button" class="sidebar__footer-btn" onClick={() => ui.show("account")}>
            <span class="sidebar__footer-btn-key">{t("settings.account")}</span>
            <span class="sidebar__footer-btn-value">
              {shownPlayer.value ? (
                <>
                  {shownPlayer.value.accountId != null ? (
                    <PlayerBadge
                      tier={activeStats.value?.levelingTier ?? 0}
                      dogTag={activeStats.value?.dogTag ?? null}
                      size={22}
                    />
                  ) : null}
                  <span class="sidebar__footer-btn-text">
                    {shownPlayer.value.nickname}
                  </span>
                  <HkTag variant="default" size="sm">
                    {shownPlayer.value.realm.toUpperCase()}
                  </HkTag>
                  {shownPlayer.value.playing ? (
                    <HkTag variant="primary" size="sm">
                      {t("tray.playing")}
                    </HkTag>
                  ) : shownPlayer.value.registered ? null : (
                    <HkTag variant="warning" size="sm">
                      {t("tray.notRegistered")}
                    </HkTag>
                  )}
                </>
              ) : (
                <span class="sidebar__footer-btn-text">{t("account.notBound")}</span>
              )}
            </span>
          </button>
        </div>
      </aside>
    );
  },
});
