import { computed, defineComponent, nextTick, ref, watch } from "vue";

import { HkModal, HkScrollContainer, HkSpinner } from "@celestia-island/hikari";

import { useRankedStore } from "@/stores/ranked";
import { t } from "@/i18n";
import { winrateColor } from "@/utils/winrate";
import { leagueFromNumber, rankLeague, seasonNumber } from "@/utils/ranked";
import type { RankedSeasonStats } from "@/api";
import RankedShipTable from "./RankedShipTable";
import "./RankedSeasonModal.scss";

/**
 * Ranked-season timeline modal (Honor-of-Kings season style): the loaded
 * seasons render as one horizontal chronological strip — "S30" tags over
 * dots on a shared line, each dot tinted with the metal of that season's
 * best rank, per-season winrate under it. Nodes are CONSTANT-SIZE: sparse
 * histories center on the line, long ones scroll. Clicking a node selects
 * the season; the detail strip below names its best rank (localized),
 * spans the season's date range on the right, and lays the per-season
 * KPIs out; the ship breakdown under the card lists what that season was
 * played with (RankedShipTable). The strip scrolls horizontally and snaps
 * to the newest end on open — and again when an arriving season list
 * doesn't hold the current selection (the store was still loading, or
 * swapped players).
 *
 * Data comes straight from the shared ranked store — whatever player the
 * hosting view loaded last (the bound account on the dashboard, the
 * looked-up one on /lookup); `playerName` only labels the modal. The
 * per-ship rows load lazily per open (their own store slot) so the hosts'
 * season loads never pay for the breakdown.
 */

/** Consumed slice of HkScrollContainer's exposed component ref (the ref
 *  yields the exposed handle, not an element — see the strip below). */
interface ScrollHandle {
  getScrollElement(): HTMLElement | undefined;
}

/** The ship breakdown's re-query window per open. */
const SHIPS_TTL_MS = 60_000;

export default defineComponent({
  name: "RankedSeasonModal",
  props: {
    modelValue: { type: Boolean, default: false },
    /** Whose seasons the store holds — shown under the title. */
    playerName: { type: String, default: "" },
  },
  emits: {
    "update:modelValue": (_v: boolean) => true,
  },
  setup(props, { emit }) {
    const ranked = useRankedStore();

    /** Selected season id — defaults to the newest whenever the modal
     *  opens or the store swaps to a season list without it. */
    const selectedId = ref<number | null>(null);
    /** The horizontal strip — a COMPONENT ref: it exposes the scrolling
     *  viewport (for the snap-to-newest pass), not an element. */
    const strip = ref<ScrollHandle | null>(null);

    // Chronological order (oldest first) for the left→right timeline; the
    // store serves newest-first.
    const seasons = computed(() => [...ranked.seasons].reverse());
    const selected = computed(
      () => seasons.value.find((s) => s.seasonId === selectedId.value) ?? null,
    );

    /** Point the selection at the newest season and snap the strip to the
     *  right end so the latest season is the first thing seen. */
    function focusNewest() {
      selectedId.value = seasons.value.at(-1)?.seasonId ?? null;
      void nextTick(() => {
        const el = strip.value?.getScrollElement();
        if (el) el.scrollLeft = el.scrollWidth;
      });
    }

    /** Fetch the per-ship rows for the slot's player (no-op while the
     *  season aggregates haven't landed yet — the identity watch below
     *  retries when they do). */
    function loadShips() {
      if (ranked.accountId != null && ranked.realm != null) {
        void ranked.loadShips(ranked.accountId, ranked.realm, { ttlMs: SHIPS_TTL_MS });
      }
    }

    watch(
      () => props.modelValue,
      (open) => {
        if (open) {
          focusNewest();
          loadShips();
        }
      },
      { immediate: true },
    );
    // Seasons often land AFTER the modal opens (the store is still
    // loading) — adopt them once they arrive; also covers a player swap
    // while the modal stays open.
    watch(
      () => ranked.seasons,
      () => {
        if (props.modelValue && !seasons.value.some((s) => s.seasonId === selectedId.value)) {
          focusNewest();
        }
      },
    );
    // A player swap re-targets the ship slot too (the selection watch
    // above only re-points the season).
    watch([() => ranked.accountId, () => ranked.realm], () => {
      if (props.modelValue) loadShips();
    });

    /** Per-season winrate (%) for a timeline node; null = no battles. */
    const seasonWr = (s: RankedSeasonStats) =>
      s.battles > 0 ? (s.wins / s.battles) * 100 : null;

    /** A season's best-rank league — the numeric field first, the raw
     *  display's prefix as the fallback for older store contents. */
    const leagueOf = (s: RankedSeasonStats) =>
      leagueFromNumber(s.bestLeague) ?? rankLeague(s.bestRankDisplay);

    /** Localized rank label ("青铜 4"); falls back to the backend's raw
     *  English display when neither the numeric league nor the rank
     *  survived. */
    const rankLabel = (s: RankedSeasonStats) => {
      const lg = leagueOf(s);
      if (lg != null && s.bestRank != null) return `${t(`stats.league.${lg}`)} ${s.bestRank}`;
      return s.bestRankDisplay ?? "—";
    };

    /** "2026/7/16 – 2026/9/9" for the detail head's right end; null when
     *  the season's metadata never arrived (CN without the fallback
     *  fetch). */
    const dateRange = computed(() => {
      const s = selected.value;
      if (!s?.startAt || !s?.finishAt) return null;
      const fmt = (ts: number) => new Date(ts * 1000).toLocaleDateString();
      return `${fmt(s.startAt)} – ${fmt(s.finishAt)}`;
    });

    return () => (
      <HkModal
        modelValue={props.modelValue}
        onUpdate:modelValue={(v: boolean) => emit("update:modelValue", v)}
        title={t("stats.rankedSeasons")}
        width="42rem"
      >
        <div class="ranked-modal">
          {props.playerName ? (
            <p class="ranked-modal__who">{props.playerName}</p>
          ) : null}

          {ranked.loading ? (
            <div class="ranked-modal__state">
              <HkSpinner size="sm" />
            </div>
          ) : ranked.error ? (
            <p class="ranked-modal__state ranked-modal__state--error">{ranked.error}</p>
          ) : seasons.value.length === 0 ? (
            <p class="ranked-modal__state">{t("stats.noRankedSeasons")}</p>
          ) : (
            <>
              {/* ── Horizontal season timeline — hikari's scroll container
                  owns the scrollbar (auto-hiding overlay track under the
                  strip); the track scrolls inside its viewport. Nodes are
                  fixed-size: few seasons center, many scroll. ── */}
              <HkScrollContainer class="ranked-modal__strip" axis="horizontal" ref={strip}>
                <div class="ranked-modal__track">
                  {seasons.value.map((s) => {
                    const wr = seasonWr(s);
                    const league = leagueOf(s);
                    const isSel = s.seasonId === selectedId.value;
                    return (
                      <button
                        type="button"
                        key={s.seasonId}
                        class={[
                          "ranked-modal__node",
                          isSel ? "ranked-modal__node--sel" : null,
                          league ? `ranked-modal__node--${league}` : null,
                        ]}
                        onClick={() => (selectedId.value = s.seasonId)}
                      >
                        <span class="ranked-modal__node-tag">S{seasonNumber(s)}</span>
                        <span class="ranked-modal__node-dot" />
                        <span class="ranked-modal__node-rank">{rankLabel(s)}</span>
                        <span
                          class="ranked-modal__node-wr"
                          style={wr != null ? { color: winrateColor(wr) } : undefined}
                        >
                          {wr != null ? `${wr.toFixed(1)}%` : "—"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </HkScrollContainer>

              {/* ── Selected season detail ── */}
              {selected.value ? (
                <div class="ranked-modal__detail" key={selected.value.seasonId}>
                  <div class="ranked-modal__detail-head">
                    <span class="ranked-modal__detail-name">{selected.value.seasonName}</span>
                    {selected.value.bestRankDisplay ? (
                      <span
                        class={[
                          "ranked-modal__detail-rank",
                          (() => {
                            const league = leagueOf(selected.value);
                            return league ? `ranked-modal__detail-rank--${league}` : null;
                          })(),
                        ]}
                      >
                        {t("stats.bestRank")} · {rankLabel(selected.value)}
                      </span>
                    ) : null}
                    {dateRange.value ? (
                      <span class="ranked-modal__detail-dates">{dateRange.value}</span>
                    ) : null}
                  </div>
                  <div class="ranked-modal__kpis">
                    {(() => {
                      const s = selected.value!;
                      const wr = seasonWr(s);
                      const survived =
                        s.battles > 0 ? (s.survivedBattles / s.battles) * 100 : null;
                      return (
                        [
                          {
                            label: t("stats.battles"),
                            value: s.battles.toLocaleString(),
                          },
                          {
                            label: t("stats.winrate"),
                            value: wr != null ? `${wr.toFixed(1)}%` : "—",
                            color: wr != null ? winrateColor(wr) : undefined,
                          },
                          {
                            label: t("stats.avgDamage"),
                            value:
                              s.battles > 0
                                ? Math.round(s.damageDealt / s.battles).toLocaleString()
                                : "—",
                          },
                          {
                            label: t("stats.avgFrags"),
                            value:
                              s.battles > 0 ? (s.frags / s.battles).toFixed(2) : "—",
                          },
                          {
                            label: t("stats.survivalRate"),
                            value: survived != null ? `${survived.toFixed(0)}%` : "—",
                          },
                          {
                            label: t("stats.maxDamage"),
                            value: s.maxDamage > 0 ? s.maxDamage.toLocaleString() : "—",
                          },
                        ] as { label: string; value: string; color?: string }[]
                      ).map((k) => (
                        <div class="ranked-modal__kpi" key={k.label}>
                          <span class="ranked-modal__kpi-label">{k.label}</span>
                          <span
                            class="ranked-modal__kpi-value"
                            style={k.color ? { color: k.color } : undefined}
                          >
                            {k.value}
                          </span>
                        </div>
                      ));
                    })()}
                  </div>
                </div>
              ) : null}

              {/* ── The season's ships, water-table style ── */}
              {selected.value && ranked.accountId != null ? (
                <RankedShipTable
                  key={`${ranked.accountId}:${selected.value.seasonId}`}
                  season={selected.value}
                />
              ) : null}
            </>
          )}
        </div>
      </HkModal>
    );
  },
});
