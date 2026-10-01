import { computed, defineComponent, onBeforeUnmount, onMounted, watch } from "vue";
import { Eye, EyeOff, LogOut } from "@lucide/vue";

import { HkTag } from "@celestia-island/hikari";

import PlayerBadge from "@/components/base/PlayerBadge";
import PlatformIcon from "@/components/base/PlatformIcon";
import { useSessionStore } from "@/stores/session";
import { useStatsStore } from "@/stores/stats";
import { api, type PlayerStats } from "@/api";
import { t } from "@/i18n";
import { kindLabel } from "@/utils/installLabel";
import "./TrayPanel.scss";

/**
 * The tray panel body — what a left click on the tray icon shows.
 *
 * Two zones, both mirroring the main window's bottom-left footer:
 *  - session status: running client (dot + kind · realm + PID) and the
 *    resolved player (the identity the battle roster pinned, falling back
 *    to the active selection) with its emblem;
 *  - the old native tray menu's actions (show / hide / quit), routed
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

    session.start();

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
    onMounted(() => window.addEventListener("keydown", onKey));
    onBeforeUnmount(() => {
      window.removeEventListener("keydown", onKey);
      session.stop();
    });

    return () => (
      <div class="tray-panel">
          <div class="tray-panel__brand">
            <img src="/logo.webp" alt="WoWSP" class="tray-panel__brand-logo" />
            <span class="tray-panel__brand-name">{t("common.app.name")}</span>
            {running.value ? (
              <span class="tray-panel__brand-dot tray-panel__brand-dot--on" />
            ) : (
              <span class="tray-panel__brand-dot tray-panel__brand-dot--off" />
            )}
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
                  {display.value.accountId != null ? (
                    <PlayerBadge
                      tier={displayStats.value?.levelingTier ?? 0}
                      dogTag={displayStats.value?.dogTag ?? null}
                      size={22}
                    />
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
            <button type="button" class="tray-panel__menu-item" onClick={() => act("hide")}>
              <EyeOff size={15} class="tray-panel__menu-icon" />
              <span>{t("tray.hide")}</span>
            </button>
            <button
              type="button"
              class="tray-panel__menu-item tray-panel__menu-item--danger"
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
