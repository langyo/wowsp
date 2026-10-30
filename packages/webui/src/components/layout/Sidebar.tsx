import { computed, defineComponent, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { BarChart3, Search, Ship, Film, Video, Crosshair, Package, AlertTriangle, Smartphone } from "@lucide/vue";

import { HkSidebarRailToggle, HkTag, HkTooltip, useSidebarRail } from "@celestia-island/hikari";

import AccountAvatar from "@/components/base/AccountAvatar";
import PlayerBadge from "@/components/base/PlayerBadge";
import FullscreenModeHint from "@/components/layout/FullscreenModeHint";
import GatewayCaptchaHint from "@/components/layout/GatewayCaptchaHint";
import PluginUpdateHint from "@/components/layout/PluginUpdateHint";
import PlatformIcon from "@/components/base/PlatformIcon";
import { useConfigStore } from "@/stores/config";
import { useGameStatusStore } from "@/stores/gameStatus";
import { useGatewayStore } from "@/stores/gateway";
import { useSettingsUiStore } from "@/stores/settingsUi";
import { usePluginUpdatesStore } from "@/stores/pluginUpdates";
import { useStaleBinsStore } from "@/stores/staleBins";
import { useShownPlayer } from "@/composables/useShownPlayer";
import { useClipboard } from "@/composables/useClipboard";
import { t } from "@/i18n";
import { isMobileApp } from "@/utils/platform";
import { kindLabel } from "@/utils/installLabel";
import type { GameProcessInfo } from "@/api";
import "./Sidebar.scss";

/**
 * Left sidebar: nav links + spacer + footer.
 *
 * Nav links (top): Dashboard / Lookup / Ships / Live / Replay / Tactics /
 * Resources. Live keeps a phone presence too — the desktop watches the
 * local game install while the phone build renders the gateway live view.
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
 *
 * DESKTOP rail mode (hikari's sidebar-rail kit, session-only): the root
 * becomes the `.hk-sidebar-rail-host` LAYOUT box — a circular hover-reveal
 * chevron toggle (HkSidebarRailToggle) rides the panel's content-facing
 * edge and clicking it collapses the sidebar to a 56px icon rail. While
 * collapsed, resting the pointer on the rail for the peek delay opens the
 * FULL sidebar as an overlay drawer (`.hk-sidebar-rail-panel` slides over
 * the content; the layout box stays at rail width so the content area
 * never shifts), and leaving closes it after the grace. All timing lives
 * in hikari's useSidebarRail — the one implementation every host shares.
 * The drawer variant mounts NONE of this; its markup is unchanged.
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
    const config = useConfigStore();
    const gameStatus = useGameStatusStore();
    const gateway = useGatewayStore();
    const ui = useSettingsUiStore();
    const pluginUpdates = usePluginUpdatesStore();
    const staleBins = useStaleBinsStore();
    const router = useRouter();
    const { copy } = useClipboard();
    // The dashboard link must also read active while the section's sibling
    // view (游玩时间, /playtime) is open — the pill in the title bar
    // presents the two as one section, the sidebar agrees.
    const route = useRoute();

    // ── Desktop rail (hikari sidebar-rail kit) ─────────────────────────
    // The desktop variant is a BESPOKE host of the kit: useSidebarRail owns
    // the state machine (hover-dwell peek, leave-grace close, Escape, the
    // session-only collapsed flag — nothing is ever persisted) and the
    // hk-sidebar-rail-* geometry classes come from the granular stylesheet
    // @use'd in Sidebar.scss. The drawer variant never enters rail mode:
    // every computed below folds to false/undefined there.
    const isDrawer = computed(() => props.variant === "drawer");
    const rail = useSidebarRail();
    // Collapsed for LAYOUT (rail width footprint, also while peeking).
    const railCollapsed = computed(() => !isDrawer.value && rail.collapsed.value);
    // RAIL density (icon-only dress): collapsed AND not peeking — the peek
    // overlay renders the full sidebar unchanged, so the density rules must
    // not style it (hikari's [data-collapsed] carve-out, mirrored).
    const railDensity = computed(() => railCollapsed.value && !rail.peeking.value);
    const peeking = computed(() => !isDrawer.value && rail.peeking.value);

    // The host's inline width IS the layout footprint (the core contract:
    // the content area must never shift), the panel's inline width is the
    // slide lever that peeks the full sidebar out over the content.
    const EXPANDED_WIDTH = "var(--app-sidebar-w, 240px)";
    const RAIL_WIDTH = "56px";

    // The wallpaper-blur band under the main column (theme.scss body::after)
    // offsets by the sidebar's LAYOUT footprint; publish the live width so
    // the band follows the rail — the documentElement-notch precedent every
    // theme preference module sets (dpiPrefs, wallpaperBlur, …). Left empty
    // while expanded so the band's var() fallback keeps the theme default,
    // and removed on unmount so a later drawer-only mount never inherits a
    // stale rail width.
    watch(railCollapsed, (v) => {
      document.documentElement.style.setProperty(
        "--app-sidebar-live-w",
        v ? RAIL_WIDTH : "",
      );
    });
    onBeforeUnmount(() => {
      document.documentElement.style.removeProperty("--app-sidebar-live-w");
    });

    /** Icon-only rail dress for a nav tile: the label rides along as the
     *  hover hint (the global data-hint tooltip) and the accessible name
     *  while the text span is display:none'd by the [data-rail] rules. */
    const railTile = (label: string) =>
      railDensity.value
        ? { "data-hint": label, "data-hint-pos": "right", "aria-label": label }
        : {};

    // The account row's identity + emblem — the SHOWN player, shared with
    // the phone-layout title-bar avatar through one composable (single
    // source of truth; see composables/useShownPlayer.ts for the
    // resolution chain and the cache-only hydration policy).
    const { shownPlayer, dogTag } = useShownPlayer();

    // The account row's avatar: the real dog-tag emblem when the cached
    // stats carry one, else the neutral AccountAvatar disc. The old
    // service-record-tier fallback (a numbered ring) is gone — its number
    // read like a permission rank, and the 3px metallic ring shrank the
    // visible disc below the platform badge beside it.
    const accountAvatar = computed(() =>
      dogTag.value ? <PlayerBadge dogTag={dogTag.value} size={22} /> : <AccountAvatar size={22} />,
    );

    // Gateway push (desktop): the phone-status icon joins the footer while
    // the mobile service is enabled — its face reads the publish phase
    // (pending-captcha warning / online success / error), and while the
    // node demands an unsolved Turnstile the GatewayCaptchaHint card pins
    // open right of the game-status card.
    void gateway.loadConfig();
    const gatewayTone = computed(() => {
      switch (gateway.pubPhase) {
        case "captcha":
        case "resolving":
        case "connecting":
          return "pending";
        case "online":
          return "online";
        case "error":
          return "error";
        default:
          return "idle";
      }
    });
    const gatewayTip = computed(() => {
      switch (gatewayTone.value) {
        case "pending":
          return t("gateway.tipPending");
        case "online":
          return t("gateway.tipOnline");
        case "error":
          return t("gateway.tipError");
        default:
          return t("gateway.tipIdle");
      }
    });

    const proc = computed(() => gameStatus.process);

    // Multi-instance awareness: several game clients can run at once. The
    // card stays the ONE instance the app follows (the preferred one), and
    // a count badge under the status dot marks that OTHER games are also
    // running (the number is the total running instances, 2+ here).
    const runningCount = computed(() => gameStatus.processes.length);

    // The status dot's hover hint: the multi-instance count wins whenever
    // other games also run (the expanded card's badge text); in rail
    // density the dot is the whole card, so the plain online/offline label
    // rides the same channel. Expanded single-instance keeps the original
    // hintless dot (the card's text says it all).
    const statusDotHint = computed(() => {
      if (runningCount.value > 1)
        return t("common.game.multiRunning", { n: runningCount.value });
      if (railDensity.value)
        return t(proc.value.running ? "common.game.online" : "common.game.offline");
      return undefined;
    });

    /** "Steam · ASIA" or just "Steam" when realm is unknown. */
    const clientLabelOf = (p: { kind?: GameProcessInfo["kind"]; realm?: string | null }) => {
      const k = kindLabel(p.kind);
      const r = p.realm?.toUpperCase();
      return [k, r].filter(Boolean).join(" · ");
    };

    function copyPid(pid: number) {
      void copy(String(pid), t("common.copied"));
    }

    // Footer button: the ACTIVE install (what data reads use), not the
    // running process — they can differ while another client is playing.
    const activeInstall = computed(() => config.activeInstall ?? null);
    const activeInstallPath = computed(() => activeInstall.value?.path ?? "");

    // Rail density degrades the account row to its avatar alone; the shown
    // name rides the row as the hover hint (expanded it IS the visible
    // text, so no hint is wanted there).
    const accountHint = computed(() =>
      railDensity.value
        ? shownPlayer.value?.nickname ?? t("account.notBound")
        : undefined,
    );

    // The game-status card element — PluginUpdateHint anchors its popup
    // to the RIGHT of this card, vertically centered on it.
    const statusCardEl = ref<HTMLElement | null>(null);

    return () => {
      // The shared nav + footer body: the drawer variant hosts it directly
      // (its classic self-contained root), the desktop wraps it in the rail
      // composition below.
      const body = (
        <>
        {/* No brand row: the title bar above already carries the WoWSP
            identity — the nav's generous top padding keeps the first link
            off the rail's top edge instead. */}
        <nav class="sidebar__nav">
          <RouterLink
            to="/"
            class={["sidebar__link", { "is-active": route.path === "/playtime" }]}
            activeClass="is-active"
            exactActiveClass="is-active"
            {...railTile(t("nav.dashboard"))}
          >
            <BarChart3 size={16} class="sidebar__link-icon" />
            <span class="sidebar__link-text">{t("nav.dashboard")}</span>
          </RouterLink>
          <RouterLink to="/lookup" class="sidebar__link" activeClass="is-active" {...railTile(t("nav.lookup"))}>
            <Search size={16} class="sidebar__link-icon" />
            <span class="sidebar__link-text">{t("nav.lookup")}</span>
          </RouterLink>
          <RouterLink to="/ships" class="sidebar__link" activeClass="is-active" {...railTile(t("nav.ships"))}>
            <Ship size={16} class="sidebar__link-icon" />
            <span class="sidebar__link-text">{t("nav.ships")}</span>
          </RouterLink>
          {/* Live battle: the DESKTOP watches the local game install;
              the PHONE build renders the gateway live view instead (the
              pushed, same-account battle — see views/replay/LiveView's
              mobile branch). Tactics analysis works from the bundled map
              catalog with touch gestures, so phones get it too. */}
          <RouterLink to="/live" class="sidebar__link" activeClass="is-active" {...railTile(t("nav.live"))}>
            <Video size={16} class="sidebar__link-icon" />
            <span class="sidebar__link-text">{t("nav.live")}</span>
          </RouterLink>
          <RouterLink to="/replay" class="sidebar__link" activeClass="is-active" {...railTile(t("nav.replay"))}>
            <Film size={16} class="sidebar__link-icon" />
            <span class="sidebar__link-text">{t("nav.replay")}</span>
          </RouterLink>
          <RouterLink to="/tactics" class="sidebar__link" activeClass="is-active" {...railTile(t("nav.tactics"))}>
            <Crosshair size={16} class="sidebar__link-icon" />
            <span class="sidebar__link-text">{t("nav.tactics")}</span>
          </RouterLink>
          <RouterLink to="/resources" class="sidebar__link" activeClass="is-active" {...railTile(t("nav.resources"))}>
            <Package size={16} class="sidebar__link-icon" />
            <span class="sidebar__link-text">{t("nav.resources")}</span>
          </RouterLink>
        </nav>

        <div class="sidebar__spacer" />

        <div class="sidebar__footer">
          {/* Game status — an indicator, not a control. The card follows the
              ONE instance the app serves (the preferred running client);
              when OTHER clients also run, a count badge under the dot says
              how many are up (see the gameStatus store's plural report). */}
          {proc.value.running ? (
            <div ref={statusCardEl} class="sidebar__game-status is-running">
              <div class="sidebar__game-status-row">
                <span
                  class="sidebar__status-dot sidebar__status-dot--on"
                  data-hint={statusDotHint.value || undefined}
                  data-hint-pos="right"
                >
                  {runningCount.value > 1 ? (
                    <span class="sidebar__status-count">{runningCount.value}</span>
                  ) : null}
                </span>
                <span class="sidebar__status-text">{t("common.game.online")}</span>
              </div>
              <div class="sidebar__game-detail">
                {clientLabelOf(proc.value) ? (
                  <HkTooltip text={proc.value.exePath ?? ""} placement="right">
                    <span class="sidebar__game-client">{clientLabelOf(proc.value)}</span>
                  </HkTooltip>
                ) : null}
                {proc.value.pid != null ? (
                  <HkTooltip text={t("common.clickToCopy")} placement="right">
                    <span
                      class="sidebar__game-pid"
                      onClick={() => {
                        if (proc.value.pid != null) copyPid(proc.value.pid);
                      }}
                    >
                      {t("common.game.pid")}:{" "}
                      <span class="sidebar__game-pid-val">{proc.value.pid}</span>
                    </span>
                  </HkTooltip>
                ) : null}
              </div>
            </div>
          ) : (
            <div ref={statusCardEl} class="sidebar__game-status is-offline">
              <div class="sidebar__game-status-row">
                <span
                  class="sidebar__status-dot sidebar__status-dot--off"
                  data-hint={statusDotHint.value || undefined}
                  data-hint-pos="right"
                />
                <span class="sidebar__status-text">{t("common.game.offline")}</span>
              </div>
            </div>
          )}

          {/* exclusive-fullscreen warning — a passive bottom-left card
              floating ABOVE this status card while the RUNNING client owns
              the screen (the hold-Tab overlay cannot draw over exclusive
              fullscreen; the card asks the player to switch the in-game
              display mode). Only ever active on the desktop app — the
              process report is offline everywhere else. */}
          <FullscreenModeHint anchor={statusCardEl} />

          {/* Gateway push (desktop): the phone icon joins the footer
              beside the status card while the mobile service is enabled.
              Its hover surface is the GatewayCaptchaHint card — pinned
              while the node demands an unsolved Turnstile — anchored
              right of the status card like the plugin-update hint above.
              The phone build never mounts it (publish is desktop-only). */}
          {!isMobileApp() && gateway.config.enabled ? (
            <GatewayCaptchaHint class="sidebar__footer-slot" anchor={statusCardEl}>
              <span
                class={["sidebar__gateway-icon", "is-" + gatewayTone.value]}
                data-hint={gatewayTip.value}
                data-hint-pos="right"
              >
                <Smartphone size={22} />
              </span>
            </GatewayCaptchaHint>
          ) : null}

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
          // While ANY install's plugins await updates the selector wears
          // a count badge and the hover surface becomes PluginUpdateHint
          // (per-client stale-plugin list + one-click update across all
          // of them; pinned open while the running client's probe plugin
          // is stale); otherwise the plain path tooltip.
          pluginUpdates.totalCount > 0 ? (
          <PluginUpdateHint class="sidebar__footer-slot" anchor={statusCardEl}>
            <button
              type="button"
              class="sidebar__footer-btn"
              onClick={() => ui.show("gamePath")}
            >
              <span class="sidebar__footer-btn-key">{t("common.game.versionLabel")}</span>
              <span class="sidebar__footer-btn-value">
                {/* 22px matches the account avatar on the row below so the
                    two text columns share one left edge. */}
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
                {/* 22px matches the account avatar on the row below so the
                    two text columns share one left edge. */}
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
          <button
            type="button"
            class="sidebar__footer-btn"
            data-hint={accountHint.value || undefined}
            data-hint-pos="right"
            onClick={() => ui.show("account")}
          >
            <span class="sidebar__footer-btn-key">{t("settings.account")}</span>
            <span class="sidebar__footer-btn-value">
              {shownPlayer.value ? (
                <>
                  {shownPlayer.value.accountId != null ? (
                    accountAvatar.value
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
        </>
      );

      if (isDrawer.value) {
        return <aside class="sidebar sidebar--drawer">{body}</aside>;
      }

      // Desktop rail composition (hikari kit): the root is the LAYOUT box
      // (.hk-sidebar-rail-host — its inline width is the sidebar's layout
      // footprint and NEVER moves while a peek is open, so the content
      // column cannot shift); the full sidebar rides the absolutely
      // positioned .hk-sidebar-rail-panel overlay, whose inline width is
      // the slide lever between rail and full. The hover-reveal circular
      // chevron toggle sits on the panel's content-facing edge, and any
      // click inside the panel that navigates (nav link, footer button)
      // also dismisses an open peek — the shell kit's onNavigate
      // contract, delegated to the panel.
      return (
        <aside
          class="sidebar hk-sidebar-rail-host"
          data-rail={railDensity.value || undefined}
          data-peeking={peeking.value || undefined}
          style={{ width: railCollapsed.value ? RAIL_WIDTH : EXPANDED_WIDTH }}
          onPointerenter={rail.onPointerEnter}
          onPointerleave={rail.onPointerLeave}
          onKeydown={(e: KeyboardEvent) => {
            if (rail.onKeydown(e)) e.stopPropagation();
          }}
        >
          <div
            class="sidebar__panel hk-sidebar-rail-panel"
            style={{ width: railDensity.value ? RAIL_WIDTH : EXPANDED_WIDTH }}
            onClick={() => rail.closePeek()}
          >
            {body}
            <HkSidebarRailToggle expanded={!railCollapsed.value} onToggle={rail.toggle} />
          </div>
        </aside>
      );
    };
  },
});
