import { computed, defineComponent, watch } from "vue";

import { HButton, HSpinner } from "@celestia-island/hikari";

import { useTrendsStore } from "@/stores/trends";
import { t } from "@/i18n";
import { damageColor, winrateColor } from "@/utils/winrate";
import "./ServerTrendPanel.scss";

/** Player-side numbers for the server-vs-player comparison table. */
export interface ServerCompareStats {
  winrate: number;
  avgDamage: number;
  avgFrags: number;
}

/**
 * "Server Trend" tab of the ship detail modal — server-wide per-ship averages
 * really fetched from wows-numbers' public expected-values dataset (Rust side
 * fetches + caches for 7 days): mean win rate / damage / frags across the
 * tracked population, plus a side-by-side against the player's own numbers on
 * this ship when they have them.
 */
export default defineComponent({
  name: "ServerTrendPanel",
  props: {
    shipId: { type: Number, required: true },
    /** The viewed player's numbers on this ship (null = none / hidden). */
    compare: { type: Object as () => ServerCompareStats | null, default: null },
  },
  setup(props) {
    const trends = useTrendsStore();

    watch(
      () => props.shipId,
      (id) => void trends.loadServerStats(id),
      { immediate: true },
    );

    const meta = computed(() => {
      const s = trends.serverStats;
      if (!s) return null;
      return {
        date: s.generatedAt > 0 ? new Date(s.generatedAt * 1000).toLocaleDateString() : null,
        cached: s.fromCache,
      };
    });

    /** Server vs player comparison rows. */
    const compareRows = computed(() => {
      const s = trends.serverStats;
      const p = props.compare;
      if (!s || !p) return [];
      return [
        {
          label: t("stats.winrate"),
          server: `${s.winrate.toFixed(2)}%`,
          player: `${p.winrate.toFixed(1)}%`,
          playerColor: winrateColor(p.winrate),
        },
        {
          label: t("stats.avgDamage"),
          server: Math.round(s.avgDamage).toLocaleString(),
          // compare only exists when the player has battles on this ship, so
          // a zero here is broken snapshot data — same flag as the KPI tile.
          player:
            p.avgDamage <= 0
              ? t("stats.dataAnomaly")
              : Math.round(p.avgDamage).toLocaleString(),
          playerColor: damageColor(p.avgDamage),
        },
        {
          label: t("ships.detail.server.avgFrags"),
          server: s.avgFrags.toFixed(2),
          player: p.avgFrags.toFixed(2),
        },
      ];
    });

    return () => (
      <div class="server-trend">
        <h4 class="server-trend__title">{t("ships.detail.server.title")}</h4>

        {trends.serverLoading ? (
          <div class="server-trend__loading">
            <HSpinner center size="md" />
          </div>
        ) : trends.serverError ? (
          <div class="server-trend__error">
            <span class="server-trend__error-msg">
              {t("ships.detail.server.failed", { error: trends.serverError })}
            </span>
            <HButton size="sm" variant="secondary" onClick={() => void trends.loadServerStats(props.shipId)}>
              {t("common.retry")}
            </HButton>
          </div>
        ) : trends.serverStats ? (
          <>
            {/* Averages report cards */}
            <div class="server-trend__cards">
              <div class="server-trend__card">
                <span class="server-trend__card-label">{t("ships.detail.server.winrate")}</span>
                <span
                  class="server-trend__card-value"
                  style={{ color: winrateColor(trends.serverStats.winrate) }}
                >
                  {trends.serverStats.winrate.toFixed(2)}%
                </span>
              </div>
              <div class="server-trend__card">
                <span class="server-trend__card-label">{t("ships.detail.server.avgDamage")}</span>
                <span
                  class="server-trend__card-value"
                  style={{ color: damageColor(trends.serverStats.avgDamage) }}
                >
                  {Math.round(trends.serverStats.avgDamage).toLocaleString()}
                </span>
              </div>
              <div class="server-trend__card">
                <span class="server-trend__card-label">{t("ships.detail.server.avgFrags")}</span>
                <span class="server-trend__card-value">{trends.serverStats.avgFrags.toFixed(2)}</span>
              </div>
            </div>

            {/* Source meta line */}
            <p class="server-trend__meta">
              {t("ships.detail.server.source")}
              {meta.value?.date ? ` · ${t("ships.detail.server.updatedAt", { date: meta.value.date })}` : ""}
              {meta.value?.cached ? ` · ${t("ships.detail.server.cached")}` : ""}
            </p>

            {/* Server vs the viewed player — one full-width card per metric,
                server and player values side by side. */}
            {compareRows.value.length > 0 ? (
              <div class="server-trend__compare">
                <div class="server-trend__compare-title">{t("ships.detail.server.compareTitle")}</div>
                <div class="server-trend__vsgrid">
                  {compareRows.value.map((r) => (
                    <div class="server-trend__vs" key={r.label}>
                      <span class="server-trend__vs-label">{r.label}</span>
                      <div class="server-trend__vs-row">
                        <span class="server-trend__vs-side">{t("ships.detail.server.colServer")}</span>
                        <span class="server-trend__vs-value">{r.server}</span>
                      </div>
                      <div class="server-trend__vs-row">
                        <span class="server-trend__vs-side">{t("ships.detail.server.colPlayer")}</span>
                        <span
                          class="server-trend__vs-value"
                          style={r.playerColor ? { color: r.playerColor } : undefined}
                        >
                          {r.player}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <p class="ship-detail__empty">{t("ships.detail.server.notFound")}</p>
        )}
      </div>
    );
  },
});
