import { computed, defineComponent, onBeforeUnmount, onMounted, watch } from "vue";
import { Eye, LogOut, Smartphone } from "@lucide/vue";

import { HkTag } from "@celestia-island/hikari";

import AccountAvatar from "@/components/base/AccountAvatar";
import PlayerBadge from "@/components/base/PlayerBadge";
import PlatformIcon from "@/components/base/PlatformIcon";
import { useGatewayStore } from "@/stores/gateway";
import { useSessionStore } from "@/stores/session";
import { useStatsStore } from "@/stores/stats";
import { api, type PlayerStats } from "@/api";
import { t } from "@/i18n";
import { kindLabel } from "@/utils/installLabel";
import "./TrayPanel.scss";

/**
 * The tray panel body — what a left click on the tray icon shows.
 *
 * Three zones, all mirroring the main window's bottom-left footer:
 *  - the PHONE LINK: the mobile-service toggle, the publisher's phase and
 *    the live phone count (the worker's host-only `subs` telemetry), so a
 *    glance at the tray says whether a phone is linked;
 *  - session status: running client (dot + kind · realm + PID) and the
 *    resolved player (the identity the battle roster pinned, falling back
 *    to the active selection) with its emblem;
 *  - the old native tray menu's actions (show / quit), routed
 *    through the Rust handler (`tray_panel_action`) so quit still runs the
 *    graceful drain.
 *
 * The panel closes on Esc and on focus loss (the Rust window handler hides
 * it on `Focused(false)`); clicking any action closes it too.
 */
export default defineComponent({
  name: "TrayPanel",
  setup() {
    const session = useSessionStore();
    const stats = useStatsStore();
    const gateway = useGatewayStore();

    session.start();
    // The tray window may open long after the publisher's transitions, so
    // read the snapshot on mount — `wowsp://gateway-state` supplies the
    // live updates from there (the store's own listener is already wired).
    void gateway.loadConfig();
    void gateway.refreshPublishStatus();

    /** Phone-link voice: the service toggle, the live socket and the
     *  count of subscribed phones. The icon itself only exists while the
     *  service is ON (the sidebar's phone-icon rule) and its tone follows
     *  the same state grammar. */
    const phoneLinked = computed(() => gateway.pubSubscribers > 0);
    const phonePhase = computed(() => gateway.pubPhase);
    const phoneTone = computed(() => {
      if (phoneLinked.value) return "is-linked";
      switch (phonePhase.value) {
        case "captcha":
          return "is-warning";
        case "error":
          return "is-error";
        case "online":
          return "is-on";
        default:
          return "";
      }
    });
    const phoneLabel = computed(() => {
      if (!gateway.config.enabled) return t("tray.phoneServiceOff");
      switch (phonePhase.value) {
        case "online":
          return phoneLinked.value
            ? t("tray.phoneLinked", { n: gateway.pubSubscribers })
            : t("tray.phoneWaiting");
        case "captcha":
          return t("tray.phoneCaptcha");
        case "error":
          return t("tray.phoneError");
        case "connecting":
        case "resolving":
          return t("tray.phoneConnecting");
        default:
          return t("tray.phoneStopped");
      }
    });

    const running = computed(() => session.process?.running ?? false);
    const proc = computed(() => session.process);
    const display = computed(() => session.display);

    /** "Steam · ASIA" — same composition as the sidebar footer. */
    const clientLabel = computed(() => {
      const k = kindLabel(proc.value?.kind ?? null);
      const r = proc.value?.realm?.toUpperCase();
      return [k, r].filter(Boolean).join(" · ");
    });

    /** Emblem (dog tag / tier) for the DISPLAYED player — cache-only
     *  warming from disk, exactly like the sidebar avatar policy. */
    const displayStats = computed<PlayerStats | null>(() => {
      const d = display.value;
      return d?.accountId != null
        ? stats.cache.get(`${d.realm}_${d.accountId}`) ?? null
        : null;
    });
    watch(
      () => display.value,
      (d) => {
        if (d?.accountId != null) void stats.loadCached(d.realm, d.accountId);
      },
      { immediate: true },
    );

    function act(action: "show" | "hide" | "quit") {
      void api.trayPanelAction(action).catch(() => undefined);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        void api.trayPanelAction("dismiss").catch(() => undefined);
      }
    }
    /** The Rust side shows/hides the WINDOW; the document's visibility
     *  flips with it — that is the "panel just opened" signal. */
    function onVisibility() {
      if (document.visibilityState === "visible") void gateway.refreshPublishStatus();
    }
    onMounted(() => {
      window.addEventListener("keydown", onKey);
      // The panel webview stays MOUNTED across show/hide (only the window
      // toggles), so each OPEN re-reads the link snapshot: a toggle made in
      // the settings window while the panel was hidden must still land.
      window.addEventListener("visibilitychange", onVisibility);
    });
    onBeforeUnmount(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("visibilitychange", onVisibility);
      session.stop();
    });

    return () => (
      <div class="tray-panel">
          <div class="tray-panel__brand">
            <img src="/logo.webp" alt="WoWSP" class="tray-panel__brand-logo" />
            <span class="tray-panel__brand-name">{t("common.app.name")}</span>
          </div>

          {/* session status — the running client */}
          <div class={["tray-panel__status", running.value ? "is-running" : "is-offline"]}>
            <div class="tray-panel__status-row">
              <span
                class={[
                  "tray-panel__status-dot",
                  running.value ? "tray-panel__status-dot--on" : "tray-panel__status-dot--off",
                ]}
              />
              <span class="tray-panel__status-text">
                {running.value ? t("common.game.online") : t("common.game.offline")}
              </span>
              {gateway.config.enabled ? (
                <span
                  class={["tray-panel__status-phone", phoneTone.value]}
                  data-hint={phoneLabel.value}
                  aria-label={phoneLabel.value}
                >
                  <Smartphone size={14} />
                  {phoneLinked.value ? (
                    <span class="tray-panel__status-phone-count" aria-hidden="true">
                      {gateway.pubSubscribers}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </div>
            {running.value ? (
              <div class="tray-panel__status-detail">
                <PlatformIcon kind={proc.value?.kind ?? null} size={18} />
                {clientLabel.value ? (
                  <span class="tray-panel__status-client">{clientLabel.value}</span>
                ) : null}
                {proc.value?.pid != null ? (
                  <span class="tray-panel__status-pid">
                    {t("common.game.pid")}: {proc.value.pid}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* session status — the resolved player */}
          <div class="tray-panel__player">
            {display.value ? (
              <>
                <div class="tray-panel__player-row">
                  {/* Emblem when the cached stats carry a dog tag, else the
                      neutral disc — same policy as the sidebar footer; the
                      numbered tier fallback is gone there too. */}
                  {display.value.accountId != null ? (
                    displayStats.value?.dogTag ? (
                      <PlayerBadge
                        dogTag={displayStats.value.dogTag}
                        size={22}
                      />
                    ) : (
                      <AccountAvatar size={22} />
                    )
                  ) : null}
                  <span class="tray-panel__player-name">{display.value.nickname}</span>
                  <HkTag variant="default" size="sm">
                    {display.value.realm.toUpperCase()}
                  </HkTag>
                  {display.value.playing ? (
                    <HkTag variant="primary" size="sm">
                      {t("tray.playing")}
                    </HkTag>
                  ) : display.value.registered ? null : (
                    <HkTag variant="warning" size="sm">
                      {t("tray.notRegistered")}
                    </HkTag>
                  )}
                </div>
              </>
            ) : (
              <div class="tray-panel__player-row">
                <span class="tray-panel__player-none">{t("account.notBound")}</span>
              </div>
            )}
          </div>

          {/* menu actions — the old native tray menu, as rows */}
          <div class="tray-panel__menu" role="menu">
            <button type="button" class="tray-panel__menu-item" onClick={() => act("show")}>
              <Eye size={15} class="tray-panel__menu-icon" />
              <span>{t("tray.show")}</span>
            </button>
            <button
              type="button"
              class="tray-panel__menu-item"
              data-danger
              onClick={() => act("quit")}
            >
              <LogOut size={15} class="tray-panel__menu-icon" />
              <span>{t("tray.quit")}</span>
            </button>
        </div>
      </div>
    );
  },
});
