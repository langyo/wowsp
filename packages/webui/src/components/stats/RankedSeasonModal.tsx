import { computed, defineComponent, nextTick, ref, watch } from "vue";

import { HkModal, HkSpinner } from "@celestia-island/hikari";

import { useRankedStore } from "@/stores/ranked";
import { t } from "@/i18n";
import { winrateColor } from "@/utils/winrate";
import { rankLeague, seasonNumber } from "@/utils/ranked";
import type { RankedSeasonStats } from "@/api";
import "./RankedSeasonModal.scss";

/**
 * Ranked-season timeline modal (Honor-of-Kings season style): the loaded
 * seasons render as one horizontal chronological strip — "S30" tags over
 * dots on a shared line, each dot tinted with the metal of that season's
 * best rank, per-season winrate under it. Clicking a node selects the
 * season; the detail strip below names its best rank and lays the per-
 * season KPIs out. The strip scrolls horizontally and snaps to the newest
 * end on open — and again when an arriving season list doesn't hold the
 * current selection (the store was still loading, or swapped players).
 *
 * Data comes straight from the shared ranked store — whatever player the
 * hosting view loaded last (the bound account on the dashboard, the
 * looked-up one on /lookup); `playerName` only labels the modal.
 */

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
    const strip = ref<HTMLElement | null>(null);

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
        const el = strip.value;
        if (el) el.scrollLeft = el.scrollWidth;
      });
    }

    watch(
      () => props.modelValue,
      (open) => {
        if (open) focusNewest();
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

    /** Per-season winrate (%) for a timeline node; null = no battles. */
    const seasonWr = (s: RankedSeasonStats) =>
      s.battles > 0 ? (s.wins / s.battles) * 100 : null;

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
              {/* ── Horizontal season timeline ── */}
              <div class="ranked-modal__strip" ref={strip}>
                <div class="ranked-modal__track">
                  {seasons.value.map((s) => {
                    const wr = seasonWr(s);
                    const league = rankLeague(s.bestRankDisplay);
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
                        <span class="ranked-modal__node-rank">{s.bestRankDisplay ?? "—"}</span>
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
              </div>

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
                            const league = rankLeague(selected.value?.bestRankDisplay);
                            return league ? `ranked-modal__detail-rank--${league}` : null;
                          })(),
                        ]}
                      >
                        {t("stats.bestRank")} · {selected.value.bestRankDisplay}
                      </span>
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
            </>
          )}
        </div>
      </HkModal>
    );
  },
});
