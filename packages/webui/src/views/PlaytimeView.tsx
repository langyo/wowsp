import { computed, defineComponent, onMounted, onUnmounted, ref, watch } from "vue";
import { HkTabs } from "@celestia-island/hikari";

import PlaytimeTrendChart from "@/components/playtime/PlaytimeTrendChart";
import PlaytimeHeatmap from "@/components/playtime/PlaytimeHeatmap";
import {
  bucketDaily,
  fmtDuration,
  parseDayKey,
  type TrendRange,
} from "@/components/playtime/playtimeAgg";
import { usePlaytimeStore } from "@/stores/playtime";
import { useLanguage } from "@/i18n/useLanguage";
import { t } from "@/i18n";
import "./PlaytimeView.scss";

/**
 * 游玩时间 — WoWSP's own playtime statistics (the water-meter page's
 * sibling view, switched from the title-bar center group). Layout mirrors
 * the reference sheet: a six-card record strip (career total, daily
 * average, longest streak / session / day, last launch), then the trend
 * bars over 15 days / 12 weeks / 12 months, then the GitHub-style
 * activity heatmap for the last year.
 *
 * Data comes from the Rust-side ledger (commands/playtime.rs) via the
 * playtime store: the tracker observes the game client in the background,
 * so this view only reads — on mount, then on a slow poll while mounted.
 * A Steam-imported career total is footnoted, never charted (it is
 * undated).
 */
export default defineComponent({
  name: "PlaytimeView",
  setup() {
    const store = usePlaytimeStore();
    const { uiLocale } = useLanguage();
    const range = ref<TrendRange>("15d");
    // The clock the charts bucket against — refreshed alongside each
    // overview fetch so "today" moves with the data.
    const now = ref(new Date());
    watch(
      () => store.overview,
      () => {
        now.value = new Date();
      },
    );

    onMounted(() => store.start());
    onUnmounted(() => store.stop());

    const rangeOptions = [
      { key: "15d", label: t("playtime.range15d") },
      { key: "12w", label: t("playtime.range12w") },
      { key: "12m", label: t("playtime.range12m") },
    ];

    const overview = computed(() => store.overview);
    const daily = computed(() => overview.value?.daily ?? []);
    const buckets = computed(() =>
      bucketDaily(daily.value, range.value, now.value, uiLocale.value),
    );
    const rangeTotal = computed(() =>
      buckets.value.reduce((acc, b) => acc + b.seconds, 0),
    );
    const hasAnyData = computed(() => {
      const o = overview.value;
      return !!o && (o.localTotalSeconds > 0 || o.importedTotalSeconds > 0);
    });
    const importNote = computed(() => {
      const o = overview.value;
      if (!o || o.source !== "steam" || o.importedTotalSeconds <= 0) return null;
      return t("playtime.importNote", {
        hours: (o.importedTotalSeconds / 3600).toFixed(1),
        date: fmtStamp(o.importedAt ?? 0, true),
      });
    });

    function fmtDay(key: string | null): string {
      if (!key) return "—";
      const d = parseDayKey(key);
      return d ? d.toLocaleDateString(uiLocale.value) : key;
    }

    /** Compact month/day for the streak card's range — a full
     *  `2026/8/26 ~ 2026/10/4` does not fit a record card without
     *  ellipsizing. */
    function fmtDayShort(key: string | null): string {
      if (!key) return "—";
      const d = parseDayKey(key);
      return d ? `${d.getMonth() + 1}/${d.getDate()}` : key;
    }

    /** `YYYY-MM-DD HH:mm` for launch stamps; date-only when `dateOnly`. */
    function fmtStamp(unixSec: number, dateOnly = false): string {
      const d = new Date(unixSec * 1000);
      const p = (n: number) => String(n).padStart(2, "0");
      const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      return dateOnly ? day : `${day} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    const cards = computed(() => {
      const o = overview.value;
      if (!o) return [];
      const avgDaily =
        o.daysPlayed > 0 ? Math.round(o.localTotalSeconds / o.daysPlayed) : 0;
      return [
        {
          label: t("playtime.cards.total"),
          value: fmtDuration(o.totalSeconds),
          sub: t("playtime.cards.launched", { n: o.launchCount }),
          running: false,
        },
        {
          label: t("playtime.cards.dailyAvg"),
          value: fmtDuration(avgDaily),
          sub: t("playtime.cards.daysPlayed", { n: o.daysPlayed }),
          running: false,
        },
        {
          label: t("playtime.cards.streak"),
          value: t("playtime.cards.days", { n: o.longestStreakDays }),
          sub:
            o.longestStreakStart && o.longestStreakEnd
              ? `${fmtDayShort(o.longestStreakStart)} ~ ${fmtDayShort(o.longestStreakEnd)}`
              : "—",
          running: false,
        },
        {
          label: t("playtime.cards.longestSession"),
          value: fmtDuration(o.longestSessionSeconds),
          sub: fmtDay(o.longestSessionDate),
          running: false,
        },
        {
          label: t("playtime.cards.longestDay"),
          value: fmtDuration(o.longestDaySeconds),
          sub: fmtDay(o.longestDayDate),
          running: false,
        },
        {
          label: t("playtime.cards.lastLaunch"),
          value: o.lastLaunch ? fmtDuration(o.lastLaunch.durationSeconds) : "—",
          sub: o.lastLaunch ? fmtStamp(o.lastLaunch.start) : "—",
          running: o.lastLaunch?.running ?? false,
        },
      ];
    });

    return () => (
      <div class="playtime-view">
        <div class="playtime-view__content">
          {!hasAnyData.value ? (
            <div class="playtime-view__empty">
              <h2 class="playtime-view__title">{t("playtime.emptyTitle")}</h2>
              <p class="playtime-view__hint">{t("playtime.emptyHint")}</p>
            </div>
          ) : (
            <>
              {/* ── Record cards ─────────────────────────────────────── */}
              <div class="playtime-cards">
                {cards.value.map((card) => (
                  <div class="playtime-card" key={card.label}>
                    <span class="playtime-card__label">{card.label}</span>
                    <span class="playtime-card__value">
                      {card.value}
                      {card.running ? (
                        <span
                          class="playtime-card__pulse"
                          title={t("playtime.cards.running")}
                        />
                      ) : null}
                    </span>
                    <span class="playtime-card__sub">{card.sub}</span>
                  </div>
                ))}
              </div>

              {importNote.value ? (
                <p class="playtime-view__note">{importNote.value}</p>
              ) : null}

              {/* ── Trend bars ───────────────────────────────────────── */}
              <section class="play-section">
                <div class="play-section__head">
                  <h3>{t("playtime.trendTitle")}</h3>
                </div>
                <div class="play-section__controls">
                  <HkTabs
                    variant="segmented"
                    modelValue={range.value}
                    onUpdate:modelValue={(v: string) => (range.value = v as TrendRange)}
                    tabs={rangeOptions.map((o) => ({ key: o.key, label: o.label }))}
                  />
                  <span class="play-section__total">
                    {t("playtime.rangeTotal", { v: fmtDuration(rangeTotal.value) })}
                  </span>
                </div>
                <PlaytimeTrendChart buckets={buckets.value} />
              </section>

              {/* ── Activity heatmap ─────────────────────────────────── */}
              <section class="play-section">
                <div class="play-section__head">
                  <h3>{t("playtime.heatTitle")}</h3>
                  <div class="play-heat-legend">
                    <span>{t("playtime.heatLess")}</span>
                    {[1, 2, 3, 4].map((level) => (
                      <span key={level} class={`play-heat-legend__swatch is-${level}`} />
                    ))}
                    <span>{t("playtime.heatMore")}</span>
                  </div>
                </div>
                <PlaytimeHeatmap daily={daily.value} now={now.value} locale={uiLocale.value} />
              </section>
            </>
          )}
        </div>
      </div>
    );
  },
});
