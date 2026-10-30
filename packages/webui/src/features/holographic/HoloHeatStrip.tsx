/**
 * HoloHeatStrip — the E22 AI analysis timeline heatmap. A narrow vertical
 * strip on the 3D view's right edge showing every ship's instant AI score
 * across the whole battle (one column per ship, one row per 4 s decision
 * sample). Colour encodes the score (dim → bright = low → high model
 * agreement); the playhead line tracks the current time.
 *
 * Only renders while the AI analysis layer is on and a debug report has
 * landed — no report, no strip (the loading state is the button's badge).
 */
import { computed, defineComponent, type PropType } from "vue";
import type { DecisionDebugReport } from "@/api";

/** Score → colour ramp: 0 → dim blue, 0.5 → teal, 1 → bright cyan.
 *  Matches the holo palette's accent family. */
function scoreColor(v: number): string {
  const r = Math.round(20 + v * 40);
  const g = Math.round(60 + v * 160);
  const b = Math.round(120 + v * 120);
  return `rgb(${r},${g},${b})`;
}

export default defineComponent({
  name: "HoloHeatStrip",
  props: {
    report: { type: Object as PropType<DecisionDebugReport | null>, default: null },
    /** Current playhead in battle seconds. */
    playhead: { type: Number, default: 0 },
    /** Total battle duration in seconds (for the time scale). */
    duration: { type: Number, default: 0 },
  },
  setup(props) {
    /** Per-ship sample series aligned for rendering: each ship gets a
     *  column of coloured cells, one per 4 s sample. */
    const columns = computed(() => {
      const report = props.report;
      if (!report) return [];
      const maxT = props.duration || 1200;
      return report.scores.perShip.map((ship) => {
        const cells = ship.samples.map((s) => ({
          t: s.t,
          inst: s.inst,
          conf: s.confidence,
        }));
        return { entityId: ship.entityId, isRecorder: ship.isRecorder, cells };
      });
    });
    const playheadPct = computed(() =>
      props.duration > 0 ? Math.min(1, props.playhead / props.duration) * 100 : 0,
    );

    return () => (
      <div class="holo-heat-strip" role="img" aria-label="AI score timeline">
        {columns.value.length > 0 ? (
          <>
            <div class="holo-heat-strip__grid">
              {columns.value.map((col) => (
                <div
                  key={col.entityId}
                  class={["holo-heat-strip__col", col.isRecorder ? "holo-heat-strip__col--self" : ""].filter(Boolean).join(" ")}
                >
                  {col.cells.map((cell, i) => (
                    <div
                      key={i}
                      class="holo-heat-strip__cell"
                      style={{
                        backgroundColor: scoreColor(cell.inst),
                        top: `${(cell.t / (props.duration || 1200)) * 100}%`,
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
            <div class="holo-heat-strip__cursor" style={{ top: `${playheadPct.value}%` }} />
          </>
        ) : null}
      </div>
    );
  },
});
