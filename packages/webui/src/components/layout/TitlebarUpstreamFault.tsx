import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { HkPersistentToast } from "@celestia-island/hikari";

import { t } from "@/i18n";
import { faultKey, hostIsFailing, useUpstreamHealthStore } from "@/stores/upstreamHealth";
import "./TitlebarUpstreamFault.scss";

/** How often the chip re-evaluates staleness (the 15-minute stand-down
 *  is a time rule — re-reading the clock, not the network). */
const NOW_TICK_MS = 30_000;
/** Slow refresh of the health table while the chip is visible — recovery
 *  is normally reported by the next settled lookup instead (see the
 *  scheduleRefresh hooks in stats/shipStats); this poll only covers an
 *  idle app whose episode ages out or heals in the background. */
const VISIBLE_POLL_MS = 60_000;

/**
 * TitlebarUpstreamFault — the "upstream service fault" chip in the
 * title bar's actions slot, squeezed in beside the loading chip (it
 * never replaces it; both can show at once).
 *
 * Visible while any recorded upstream host is failing (≥2 consecutive
 * transport failures, no success since, episode still fresh — the
 * verdict lives in stores/upstreamHealth). The chip is hikari's
 * HkPersistentToast (error tone); its hover card DISCLOSES the failing
 * domains by name with what they serve and when they last failed — the
 * point being that "查询超时" during a vendor-side outage is
 * distinguishable from a wowsp bug. Dismissing silences exactly the
 * current episode; a new host failing (or a dismissed one breaking
 * again after a success) re-rings the bell.
 *
 * Renders null when everything is healthy — the actions slot stays
 * untouched.
 */
export default defineComponent({
  name: "TitlebarUpstreamFault",
  setup() {
    const health = useUpstreamHealthStore();
    const nowSec = ref(Math.floor(Date.now() / 1000));
    let nowTimer: number | undefined;
    let pollTimer: number | undefined;

    const failing = computed(() =>
      health.entries.filter((e) => hostIsFailing(e, nowSec.value)),
    );
    const episodeKey = computed(() => faultKey(failing.value));
    const visible = computed(
      () => failing.value.length > 0 && health.dismissedKey !== episodeKey.value,
    );

    function realmNames(realms: string[]): string {
      return realms.map((r) => t(`replay.realm.${r}`)).join("/");
    }

    function relTime(ts?: number | null): string {
      if (!ts) return "";
      const minutes = Math.max(0, Math.floor((nowSec.value - ts) / 60));
      if (minutes < 1) return t("upstream.time.justNow");
      if (minutes < 60) return t("upstream.time.minAgo", { m: minutes });
      return t("upstream.time.hourAgo", { h: Math.floor(minutes / 60) });
    }

    onMounted(() => {
      void health.refresh();
      nowTimer = window.setInterval(() => {
        nowSec.value = Math.floor(Date.now() / 1000);
      }, NOW_TICK_MS);
    });
    watch(visible, (v) => {
      if (v && pollTimer === undefined) {
        pollTimer = window.setInterval(() => void health.refresh(), VISIBLE_POLL_MS);
      } else if (!v && pollTimer !== undefined) {
        window.clearInterval(pollTimer);
        pollTimer = undefined;
      }
    });
    onBeforeUnmount(() => {
      if (nowTimer !== undefined) window.clearInterval(nowTimer);
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
    });

    return () => {
      if (!visible.value) return null;
      return (
        <HkPersistentToast
          class="titlebar-upstream-fault"
          tone="error"
          label={t("upstream.fault.short")}
          detailLabel={t("upstream.fault.tooltipTitle")}
          dismissible
          onDismiss={() => health.dismiss(failing.value)}
        >
          {{
            detail: () => (
              <div class="titlebar-upstream-fault__card">
                <p class="titlebar-upstream-fault__title">
                  {t("upstream.fault.tooltipTitle")}
                </p>
                <ul class="titlebar-upstream-fault__list">
                  {failing.value.map((e) => (
                    <li key={e.id} class="titlebar-upstream-fault__host">
                      <span class="titlebar-upstream-fault__domain">{e.host}</span>
                      <span class="titlebar-upstream-fault__use">
                        {t(`upstream.purpose.${e.purpose}`)}
                        {e.realms.length > 0 ? ` · ${realmNames(e.realms)}` : ""}
                      </span>
                      <span class="titlebar-upstream-fault__meta">
                        {t("upstream.fault.lastFail", { time: relTime(e.lastFailureTs) })}
                        {e.lastError ? ` · ${e.lastError}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
                <p class="titlebar-upstream-fault__hint">{t("upstream.fault.hint")}</p>
              </div>
            ),
          }}
        </HkPersistentToast>
      );
    };
  },
});
