/**
 * HoloScorePanel — the AI score sidebar of the holographic map. Shown
 * while the movement-advice layer is on: one row per scored ship with two
 * INDEPENDENT whole-game dimensions — the E21 contribution (enemy HP lost
 * in the fired decision windows, attributed to that ship's impacts; the
 * validated outcome-grounded semantic, confirmation ρ=+0.477) and the
 * E17/E18 model agreement (0–100 with its fire/move component bars) —
 * plus the INSTANT score + confidence at the playhead (binary-searched
 * over the per-ship sample series the `decision_debug_report` RPC
 * embedded — no further IPC while sliding).
 *
 * Rows sort by contribution (never-fired ships fall back to agreement
 * order at the list tail). The disclaimer banner stays: agreement is
 * still NOT a player rating, and contribution measures realized damage,
 * not decision elegance — two different questions, both shown.
 */
import { computed, defineComponent, type PropType } from "vue";
import { X } from "@lucide/vue";
import { t as i18nT } from "@/i18n";
import type { DecisionDebugReport, ShipScoreEntry, ShipScoreSample } from "@/api";
import { shipIconUrl } from "./shipIcons";
import "./HoloScorePanel.scss";

/** Last sample at or before `t` (series are t-sorted) — the instant score
 * the panel reads at the playhead. Null before the ship's first decision
 * point (the battle has not reached it yet). Exported for vitest. */
export function scoreSampleAt(
  samples: ShipScoreSample[],
  t: number,
): ShipScoreSample | null {
  let lo = 0;
  let hi = samples.length - 1;
  let best: ShipScoreSample | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) {
      best = samples[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** One panel row's display model (joined by the parent against its roster
 * label/icon resolution — the panel itself never touches the map ctx). */
export interface ScoreRowMeta {
  /** Ship class key for the HUD icon (battleship/cruiser/…), null = dot. */
  type: string | null;
  /** Allegiance for the icon variant + row tint. */
  role: "self" | "ally" | "enemy";
  dead: boolean;
}

/** Compact damage rendering for the contribution column: 84.2k / 1.31M,
 * raw numbers below 1000 (WoWS whole-game contributions rarely reach M).
 * Exported for vitest. */
export function formatContribution(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return Math.round(v).toString();
}

const pct = (v: number): string => Math.round(v * 100).toString();

export default defineComponent({
  name: "HoloScorePanel",
  props: {
    /** The latest debug report (null while the first call is in flight or
     *  failed — the parent shows the loading/empty state). */
    report: { type: Object as PropType<DecisionDebugReport | null>, default: null },
    /** First-call / refresh indicator (the cold call takes seconds). */
    loading: { type: Boolean, default: false },
    /** Playhead in battle seconds (the parent passes a 1 s-quantized
     *  clock — the instant column slides at 1 Hz, plenty for a 4 s sample
     *  grid). */
    playhead: { type: Number, default: 0 },
    /** entity id → display name (the map's own label resolution). */
    labelOf: { type: Function as PropType<(id: number) => string>, required: true },
    /** entity id → icon/role/dead row metadata. */
    metaOf: {
      type: Function as PropType<(id: number) => ScoreRowMeta | null>,
      required: true,
    },
    onClose: { type: Function as PropType<() => void>, required: true },
  },
  setup(props) {
    const rows = computed<{ entry: ShipScoreEntry; meta: ScoreRowMeta | null }[]>(() => {
      const report = props.report;
      if (!report) return [];
      return [...report.scores.perShip]
        .sort((a, b) => {
          const ca = a.contribution ?? -1;
          const cb = b.contribution ?? -1;
          if (ca !== cb) return cb - ca;
          return b.wholeGame - a.wholeGame;
        })
        .map((entry) => ({ entry, meta: props.metaOf(entry.entityId) }));
    });
    return () => (
      <div class="holo-score-panel" role="complementary">
        <div class="holo-score-panel__head">
          <span class="holo-score-panel__title">{i18nT("replay.scores.title")}</span>
          {props.loading ? (
            <span class="holo-score-panel__loading">{i18nT("replay.moveAdvice.loading")}</span>
          ) : null}
          <button
            class="holo-score-panel__close"
            onClick={() => props.onClose()}
            aria-label={i18nT("replay.scores.close")}
          >
            <X size={13} />
          </button>
        </div>
        {/* The E17 honesty banner — this panel shows MODEL AGREEMENT, never
            a player rating (see the component doc). hk-selectable: the
            banner prose is content (hikari 0.55.224 selection policy). */}
        <div class="hk-selectable holo-score-panel__disclaimer">{i18nT("replay.scores.disclaimer")}</div>
        {/* Layer glyph legend: the 2D/3D hold marker + the pale second arrow. */}
        <div class="holo-score-panel__legend">
          <span>{i18nT("replay.moveAdvice.holdMark")}</span>
          <span>{i18nT("replay.moveAdvice.second")}</span>
        </div>
        <div class="holo-score-panel__cols">
          <span>{i18nT("replay.scores.contribution")}</span>
          <span>{i18nT("replay.scores.whole")}</span>
          <span>{i18nT("replay.scores.instant")}</span>
        </div>
        {/* hk-selectable: ship names + model-agreement scores are the
            values users copy (hikari 0.55.224 selection policy). */}
        <div class="hk-selectable holo-score-panel__rows">
          {rows.value.length === 0 ? (
            <div class="holo-score-panel__empty">{i18nT("replay.scores.noData")}</div>
          ) : (
            rows.value.map(({ entry, meta }) => {
              const now = scoreSampleAt(entry.samples, props.playhead);
              const role = entry.isRecorder ? "self" : meta?.role ?? (entry.teamId === 0 ? "ally" : "enemy");
              const icon =
                meta?.type
                  ? shipIconUrl(meta.type, role === "enemy" ? "enemy" : "ally")
                  : null;
              return (
                <div
                  key={entry.entityId}
                  class={[
                    "holo-score-panel__row",
                    entry.isRecorder ? "holo-score-panel__row--self" : "",
                    meta?.dead || (now === null && props.playhead > 30) ? "holo-score-panel__row--dead" : "",
                  ]}
                >
                  <span class="holo-score-panel__ident">
                    {icon ? (
                      <img src={icon} alt="" draggable={false} />
                    ) : (
                      <span class={`holo-score-panel__dot holo-score-panel__dot--${role}`} />
                    )}
                    <span class="holo-score-panel__name" data-hint={props.labelOf(entry.entityId)}>
                      {props.labelOf(entry.entityId)}
                    </span>
                  </span>
                  <span
                    class="holo-score-panel__contrib"
                    data-hint={
                      entry.contribution != null && entry.contributionShots
                        ? i18nT("replay.scores.perShot", {
                            value: formatContribution(
                              entry.contribution / Math.max(1, entry.contributionShots),
                            ),
                          })
                        : undefined
                    }
                  >
                    {entry.contribution != null ? (
                      <b>{formatContribution(entry.contribution)}</b>
                    ) : (
                      <span class="holo-score-panel__conf">—</span>
                    )}
                  </span>
                  <span class="holo-score-panel__whole">
                    <b>{pct(entry.wholeGame)}</b>
                    <span class="holo-score-panel__bars">
                      <i
                        class="holo-score-panel__bar holo-score-panel__bar--fire"
                        style={{ width: `${(entry.wholeFire ?? 0) * 100}%` }}
                        data-hint={
                          entry.wholeFire == null
                            ? i18nT("replay.scores.noFire")
                            : `${i18nT("replay.scores.fire")} ${pct(entry.wholeFire)}`
                        }
                      />
                      <i
                        class="holo-score-panel__bar holo-score-panel__bar--move"
                        style={{ width: `${entry.wholeMove * 100}%` }}
                        data-hint={`${i18nT("replay.scores.move")} ${pct(entry.wholeMove)}`}
                      />
                    </span>
                  </span>
                  <span class="holo-score-panel__inst">
                    {now ? (
                      <>
                        <b>{pct(now.inst)}</b>
                        <span class="holo-score-panel__conf">
                          {i18nT("replay.scores.confidence")} {pct(now.confidence)}
                        </span>
                      </>
                    ) : (
                      <span class="holo-score-panel__conf">—</span>
                    )}
                  </span>
                </div>
              );
            })
          )}
        </div>
        {props.report ? (
          <div class="holo-score-panel__foot" data-hint={`${props.report.fireModel} · ${props.report.moveModel}`}>
            {i18nT("replay.scores.samples", {
              ships: props.report.scores.perShip.length,
              rows: props.report.scores.stats.rowsScored,
            })}
          </div>
        ) : null}
      </div>
    );
  },
});
