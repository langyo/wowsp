/**
 * HoloScorePanel — the E18 AI score sidebar of the holographic map. Shown
 * while the movement-advice layer is on: one row per scored ship with the
 * WHOLE-GAME model agreement (0–100), its fire/move component bars and the
 * INSTANT score + confidence at the playhead (binary-searched over the
 * per-ship sample series the `decision_debug_report` RPC embedded — no
 * further IPC while sliding).
 *
 * E17's negative result is a UI contract here: the whole system is MODEL
 * AGREEMENT, not skill or battle result (wholeGame vs damage ρ=+0.011 on
 * the preregistered validation). The disclaimer banner is part of the
 * panel, not an optional tooltip — the numbers must never read as a
 * "player rating".
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
        .sort((a, b) => b.wholeGame - a.wholeGame)
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
            a player rating (see the component doc). */}
        <div class="holo-score-panel__disclaimer">{i18nT("replay.scores.disclaimer")}</div>
        {/* Layer glyph legend: the 2D/3D hold marker + the pale second arrow. */}
        <div class="holo-score-panel__legend">
          <span>{i18nT("replay.moveAdvice.holdMark")}</span>
          <span>{i18nT("replay.moveAdvice.second")}</span>
        </div>
        <div class="holo-score-panel__cols">
          <span>{i18nT("replay.scores.whole")}</span>
          <span>{i18nT("replay.scores.instant")}</span>
        </div>
        <div class="holo-score-panel__rows">
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
                    <span class="holo-score-panel__name" title={props.labelOf(entry.entityId)}>
                      {props.labelOf(entry.entityId)}
                    </span>
                  </span>
                  <span class="holo-score-panel__whole">
                    <b>{pct(entry.wholeGame)}</b>
                    <span class="holo-score-panel__bars">
                      <i
                        class="holo-score-panel__bar holo-score-panel__bar--fire"
                        style={{ width: `${(entry.wholeFire ?? 0) * 100}%` }}
                        title={
                          entry.wholeFire == null
                            ? i18nT("replay.scores.noFire")
                            : `${i18nT("replay.scores.fire")} ${pct(entry.wholeFire)}`
                        }
                      />
                      <i
                        class="holo-score-panel__bar holo-score-panel__bar--move"
                        style={{ width: `${entry.wholeMove * 100}%` }}
                        title={`${i18nT("replay.scores.move")} ${pct(entry.wholeMove)}`}
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
          <div class="holo-score-panel__foot" title={`${props.report.fireModel} · ${props.report.moveModel}`}>
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
