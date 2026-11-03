/**
 * StaticReportPanel — E25's shareable per-player decision report.
 *
 * One vertical column (the "long image" is exactly this DOM node exported
 * via html-to-image): header with the perspective picker and whole-game
 * scores, a coverage bar that paints the unresolvable segments instead of
 * papering over them, the instant-score timeline through hikari's own
 * HkTrendChart (with the coverage-gap / key-moment marks as a thin overlay
 * the chart's props cannot express), and one card per key decision —
 * situation, action, the models' verdict, and the realised outcome.
 * `onSeek` jumps the 3D board's playhead so the same report doubles as an
 * in-app step-through; the picker switches any roster perspective (the
 * Rust side reuses its scoring cache, so a switch is one IPC away).
 *
 * CHROMELESS: the replay view embeds this column in its hikari window and
 * renders the ONE window head itself (title/spinner/export/close); the
 * `chromeless` prop drops the panel's own title row and card frame and the
 * host drives the exposed exportPng through a component ref. The demo
 * route keeps the standalone chrome.
 */
import { computed, defineComponent, ref, type PropType } from "vue";
import {
  HkButton,
  HkScrollContainer,
  HkSpinner,
  HkTrendChart,
  TREND_CHART_GRID_BOTTOM,
  TREND_CHART_GRID_LEFT,
  TREND_CHART_GRID_RIGHT,
  TREND_CHART_GRID_TOP,
  TREND_CHART_WIDTH,
  type TrendPen,
} from "@celestia-island/hikari";

import AppTag from "@/components/base/AppTag";
import { Camera, Check, Download, Minus, Percent, X } from "@lucide/vue";
import { t as i18nT } from "@/i18n";
import type { StaticCoverage, StaticMoment, StaticReport, StaticRosterEntry } from "@/api";
import "./StaticReportPanel.scss";

const pct = (v: number): string => Math.round(v * 100).toString();

/** Compact damage/HP rendering (84.2k / 1.31M). Exported for vitest. */
export function formatHp(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return Math.round(v).toString();
}

/** Move-sector → relative bearing label ("+45°"; 16 = held). Vitest. */
export function sectorLabel(sector: number): string {
  if (sector === 16) return i18nT("replay.report.held");
  const deg = Math.round(((sector * 22.5 + 360) % 360));
  return `${deg}°`;
}

/** Coverage badge class: full / partial / none. Exported for vitest. */
export function coverageClass(c: { samples: number; completeness: number }): string {
  if (c.samples === 0) return "none";
  return c.completeness > 0.9 ? "full" : "partial";
}

/** Coverage badge face — one AppTag, tone picked by the coverage
 *  class, and the state glyph comes from the lucide set (Check / Percent /
 *  Minus) instead of a hand-rolled text glyph. Module-level so both picker
 *  teams paint exactly the same face. */
function coverageTag(coverage: StaticCoverage) {
  const kind = coverageClass(coverage);
  const variant = kind === "full" ? "success" : kind === "partial" ? "warning" : "danger";
  return (
    <AppTag tone={variant} class="srp-picker__badge">
      {kind === "full" ? (
        <Check size={11} aria-hidden="true" />
      ) : kind === "partial" ? (
        <>
          <Percent size={10} aria-hidden="true" />
          <span>{pct(coverage.completeness)}</span>
        </>
      ) : (
        <Minus size={11} aria-hidden="true" />
      )}
    </AppTag>
  );
}

/** The caption params per category; the localized sentence comes from
 * the i18n table keyed by `replay.report.cat_<category>`. */
/** Category → the AppTag tone (and marker class) it paints — one table
 * so the card badge and the timeline marker can never disagree. */
const CATEGORY_TONE: Record<
  StaticMoment["category"],
  { tone: string; tag: "success" | "danger" | "warning" | "info" }
> = {
  damageRealized: { tone: "good", tag: "success" },
  missedOpportunity: { tone: "bad", tag: "danger" },
  weakWindow: { tone: "bad", tag: "danger" },
  forcedShot: { tone: "warn", tag: "warning" },
  strongWindow: { tone: "ok", tag: "info" },
};
function categoryTone(category: StaticMoment["category"]): string {
  return CATEGORY_TONE[category].tone;
}

/** Lead-in before battle-second 0 in HkTrendChart's window (seconds): the
 *  window is [newest - timeWindowMs, newest], and the newest sample is the
 *  battle end, so the headroom keeps battle-second 0 one step inside the
 *  left edge. The marks overlay maps battle time with the same frame. */
const TREND_HEADROOM_S = 2;
/** Frame height handed to HkTrendChart. A px height lifts into the SVG
 *  viewBox (trendHeightPx), so this box is pixel-true vertically. */
const TREND_HEIGHT_PX = 160;
const TREND_HEIGHT = `${TREND_HEIGHT_PX}px`;

/** HkTrendChart stretches its 640-wide viewBox across the container
 *  (preserveAspectRatio="none"), so its exported horizontal grid insets are
 *  fractions of that viewBox; the vertical insets are px because the px
 *  height equals the viewBox height. Both are derived from the exported
 *  TREND_CHART_GRID_* constants so this overlay can never drift from the
 *  chart's own plot rectangle. */
const TREND_PLOT_LEFT_PCT = (TREND_CHART_GRID_LEFT / TREND_CHART_WIDTH) * 100;
const TREND_PLOT_RIGHT_PCT = (TREND_CHART_GRID_RIGHT / TREND_CHART_WIDTH) * 100;
/** The thin marks/ticks overlay boxes: the chart's plot rectangle and its
 *  (empty) label bands. */
const TREND_PLOT_STYLE = {
  left: `${TREND_PLOT_LEFT_PCT}%`,
  right: `${TREND_PLOT_RIGHT_PCT}%`,
  top: `${TREND_CHART_GRID_TOP}px`,
  bottom: `${TREND_CHART_GRID_BOTTOM}px`,
};
const TREND_AXIS_STYLE = {
  left: `${TREND_PLOT_LEFT_PCT}%`,
  right: `${TREND_PLOT_RIGHT_PCT}%`,
  bottom: "0",
  height: `${TREND_CHART_GRID_BOTTOM}px`,
};
/** The chart paints neither axis labels nor a legend — the top grid band is
 *  empty, so the report's own pen label sits there. */
const TREND_LEGEND_STYLE = {
  left: `${TREND_PLOT_LEFT_PCT}%`,
  right: `${TREND_PLOT_RIGHT_PCT}%`,
  top: "0",
  height: `${TREND_CHART_GRID_TOP}px`,
};

/**
 * The instant-score timeline, rendered through hikari's own HkTrendChart —
 * the dependency-free SVG chart (no canvas, no animation: the first render
 * is the finished frame). Its time axis is plain numbers, so the report feeds
 * BATTLE time directly and omits the optional `now` prop: the window then
 * freezes at the newest sample (the battle end), making a mounted chart and
 * its html-to-image export deterministically identical with no wall clock
 * anywhere. Whatever the chart's props cannot express — the coverage gaps,
 * the key-moment marks and battle-time axis labels — rides a thin overlay
 * derived from the chart's exported grid constants (see .srp-trend in the
 * stylesheet).
 */
const TrendChart = defineComponent({
  name: "StaticReportTrendChart",
  props: {
    report: { type: Object as PropType<StaticReport>, required: true },
  },
  setup(props) {
    const duration = computed(() => Math.max(1, props.report.durationS));
    const windowMs = computed(() => (duration.value + TREND_HEADROOM_S) * 1000);
    /** Battle-second t -> % across the chart's time window. */
    const frac = (tSec: number): number =>
      ((tSec + TREND_HEADROOM_S) / (duration.value + TREND_HEADROOM_S)) * 100;

    const pens = computed<TrendPen[]>(() => [
      {
        label: i18nT("replay.report.instScore"),
        data: props.report.timeline.map((s) => ({
          // Battle seconds ride the chart's numeric time axis directly as
          // battle-time ms (the chart's documented unit), and the window
          // freezes at the newest sample because `now` is omitted.
          time: s.t * 1000,
          value: s.inst * 100,
        })),
      },
    ]);
    const gaps = computed(() => {
      const me = props.report.roster.find((r) => r.entityId === props.report.entityId);
      return (me?.coverage.gapSegments ?? []).map(([a, b], i) => ({
        key: `gap-${i}`,
        left: frac(a),
        // Keep a hairline width for the shortest unresolvable segment.
        width: Math.max(0.2, frac(b) - frac(a)),
      }));
    });
    const markers = computed(() =>
      props.report.moments.map((m) => ({
        key: m.t,
        left: frac(m.t),
        tone: categoryTone(m.category),
      })),
    );
    /** X-axis labels painted by the overlay in BATTLE time: the chart has no
     *  axis-label layer of its own, so this is its only time axis (and it is
     *  deterministic — the window is frozen at the battle end). */
    const ticks = computed(() =>
      [0, 0.25, 0.5, 0.75, 1].map((f, i) => {
        const tSec = f * duration.value;
        const mins = Math.floor(tSec / 60);
        const secs = Math.floor(tSec % 60);
        return {
          key: `tick-${i}`,
          left: frac(tSec),
          anchor: i === 0 ? "start" : i === 4 ? "end" : "center",
          label: `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`,
        };
      }),
    );
    return () => (
      <div class="srp-trend">
        {/* No `now`: the window freezes at the newest sample (battle end).
            The width is passed explicitly so the SVG viewBox the overlay's
            percentage insets are derived from is pinned, not a default. */}
        <HkTrendChart
          pens={pens.value}
          height={TREND_HEIGHT}
          width={TREND_CHART_WIDTH}
          timeWindowMs={windowMs.value}
          showThresholds={false}
        />
        {/* Chart-unexpressible annotations only: HkTrendChart renders no
            x-axis marks/bands and no axis labels, so the coverage gaps, the
            key-moment marks and the battle-time ticks/legend live here, in
            boxes derived from its exported grid constants. */}
        <div class="srp-trend__overlay" style={TREND_PLOT_STYLE} aria-hidden="true">
          {gaps.value.map((g) => (
            <span
              key={g.key}
              class="srp-trend__gap"
              style={{ left: `${g.left}%`, width: `${g.width}%` }}
            />
          ))}
          {markers.value.map((m) => (
            <span
              key={m.key}
              class={`srp-trend__mark srp-trend__mark--${m.tone}`}
              style={{ left: `${m.left}%` }}
            />
          ))}
        </div>
        <div class="srp-trend__axis" style={TREND_AXIS_STYLE} aria-hidden="true">
          {ticks.value.map((tick) => (
            <span
              key={tick.key}
              class={`srp-trend__xtick srp-trend__xtick--${tick.anchor}`}
              style={{ left: `${tick.left}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>
        <div class="srp-trend__legend" style={TREND_LEGEND_STYLE} aria-hidden="true">
          <span class="srp-trend__legend-dot" />
          <span>{i18nT("replay.report.instScore")}</span>
        </div>
      </div>
    );
  },
});

export default defineComponent({
  name: "StaticReportPanel",
  props: {
    report: { type: Object as PropType<StaticReport>, required: true },
    loading: { type: Boolean, default: false },
    /** Battle-time seek (the 3D board playhead); optional so the demo
     * route can render the panel without a map. */
    onSeek: { type: Function as PropType<(t: number) => void>, default: null },
    /** Perspective switch (refetch from the Rust cache). */
    onPick: { type: Function as PropType<(entityId: number) => void>, required: true },
    /** Optional close affordance (the replay view's in-app modal passes
     *  one; the demo route renders without it). */
    onClose: { type: Function as PropType<() => void>, default: null },
    /** Embedded in a host window that renders the ONE chrome (the replay
     *  view's hikari modal head): hides this panel's own title/action row
     *  and outer card frame so the host head is the only window chrome.
     *  The export pipeline stays here — the host calls the exposed
     *  `exportPng` from its head button. */
    chromeless: { type: Boolean, default: false },
  },
  setup(props, { expose }) {
    const exporting = ref(false);
    const me = computed<StaticRosterEntry | undefined>(() =>
      props.report.roster.find((r) => r.entityId === props.report.entityId),
    );
    const rosterByTeam = computed(() => {
      const allies = props.report.roster.filter((r) => r.teamId === 0);
      const enemies = props.report.roster.filter((r) => r.teamId === 1);
      return { allies, enemies };
    });

    const exportPng = async () => {
      const node = document.querySelector<HTMLElement>(".static-report-panel__export-root");
      if (!node || exporting.value) return;
      exporting.value = true;
      try {
        const { toPng } = await import("html-to-image");
        // skipFonts: embedding the app webfonts fetches every font URL,
        // which hangs behind proxies / offline; the panel's own stack is
        // self-contained dark-surface CSS, so the system fallback is fine.
        // The race keeps the button from sticking if embedding stalls.
        const render = toPng(node, {
          backgroundColor: "#0d1117",
          // The panel scrolls inside the modal; capture the full column.
          height: node.scrollHeight,
          pixelRatio: 2,
          skipFonts: true,
          style: { maxHeight: "none", overflow: "visible" },
        });
        const url = await Promise.race([
          render,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("report export render timed out")), 20000),
          ),
        ]);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${props.report.replayId}_${props.report.entityId}_report.png`;
        a.click();
      } catch (err) {
        console.warn("[report] export failed", err);
      } finally {
        exporting.value = false;
      }
    };

    // Chromeless hosts render the window head themselves; expose the capture
    // pipeline for the host's export action (the standalone/demo chrome keeps
    // its own button below). NOTE: the setup-context expose, not the
    // `defineExpose` compiler macro — the latter is a runtime no-op outside
    // an SFC `<script setup>`, silently leaving the host ref without the
    // method.
    expose({ exportPng });

    return () => (
      <div
        class={["static-report-panel", props.chromeless ? "static-report-panel--chromeless" : ""]}
        role={props.chromeless ? undefined : "dialog"}
      >
        {props.chromeless ? null : (
          <div class="static-report-panel__chrome">
            <span class="static-report-panel__title">{i18nT("replay.report.title")}</span>
            {props.loading ? <HkSpinner size={14} /> : null}
            <div class="static-report-panel__actions">
              <HkButton
                variant="secondary"
                size="sm"
                disabled={exporting.value}
                onClick={() => void exportPng()}
              >
                {exporting.value ? null : <Download size={13} />}
                <span>{i18nT(exporting.value ? "replay.report.exporting" : "replay.report.export")}</span>
              </HkButton>
              {props.onClose ? (
                <HkButton
                  variant="ghost"
                  size="sm"
                  onClick={() => props.onClose()}
                  aria-label={i18nT("replay.report.close")}
                >
                  <X size={14} />
                </HkButton>
              ) : null}
            </div>
          </div>
        )}

        <HkScrollContainer class="static-report-panel__scroll">
        <div class="static-report-panel__export-root">
          {/* ── perspective picker (both teams, coverage-badged) ── */}
          <div class="srp-picker">
            <div class="srp-picker__team">
              <span class="srp-picker__label">{i18nT("replay.report.allies")}</span>
              <div class="srp-picker__row">
                {rosterByTeam.value.allies.map((r) => (
                  <button
                    key={r.entityId}
                    class={[
                      "srp-picker__chip",
                      r.entityId === props.report.entityId ? "srp-picker__chip--self" : "",
                    ]}
                    onClick={() => r.entityId !== props.report.entityId && props.onPick(r.entityId)}
                    disabled={r.coverage.samples === 0}
                    data-hint={
                      r.coverage.samples === 0
                        ? i18nT("replay.report.noData")
                        : `${i18nT("replay.report.coverage")}: ${pct(r.coverage.completeness)}%`
                    }
                  >
                    <span class="srp-picker__dot" />
                    <span class="srp-picker__name">{r.name ?? r.entityId}</span>
                    {coverageTag(r.coverage)}
                  </button>
                ))}
              </div>
            </div>
            <div class="srp-picker__team">
              <span class="srp-picker__label">{i18nT("replay.report.enemies")}</span>
              <div class="srp-picker__row">
                {rosterByTeam.value.enemies.map((r) => (
                  <button
                    key={r.entityId}
                    class={[
                      "srp-picker__chip",
                      "srp-picker__chip--enemy",
                      r.entityId === props.report.entityId ? "srp-picker__chip--self" : "",
                    ]}
                    onClick={() => r.entityId !== props.report.entityId && props.onPick(r.entityId)}
                    disabled={r.coverage.samples === 0}
                    data-hint={
                      r.coverage.samples === 0
                        ? i18nT("replay.report.noData")
                        : `${i18nT("replay.report.coverage")}: ${pct(r.coverage.completeness)}%`
                    }
                  >
                    <span class="srp-picker__dot srp-picker__dot--enemy" />
                    <span class="srp-picker__name">{r.name ?? r.entityId}</span>
                    {coverageTag(r.coverage)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ── header: who, whole-game scores, coverage ── */}
          <div class="srp-head">
            <div class="srp-head__id">
              <span class="srp-head__name">{me.value?.name ?? props.report.entityId}</span>
              {me.value?.isRecorder ? (
                <AppTag tone="info">{i18nT("replay.report.recorder")}</AppTag>
              ) : null}
              {me.value?.diedAt != null ? (
                <AppTag tone="danger">
                  {i18nT("replay.report.diedAt", { t: Math.round(me.value.diedAt) })}
                </AppTag>
              ) : (
                <AppTag tone="success">{i18nT("replay.report.survived")}</AppTag>
              )}
              <span class="srp-head__map">
                {props.report.mapName?.replace("spaces/", "") ?? ""} ·{" "}
                {i18nT("replay.report.duration", { t: Math.round(props.report.durationS) })}
              </span>
            </div>
            <div class="srp-head__scores">
              <div class="srp-head__score">
                <span class="srp-head__score-label">{i18nT("replay.report.contribution")}</span>
                <b>{me.value?.whole?.contribution != null ? formatHp(me.value.whole.contribution) : "—"}</b>
                {me.value?.whole?.contributionShots ? (
                  <span class="srp-head__score-sub">
                    {i18nT("replay.report.perShot", {
                      v: formatHp(me.value.whole.contribution! / me.value.whole.contributionShots),
                    })}
                  </span>
                ) : null}
              </div>
              <div class="srp-head__score">
                <span class="srp-head__score-label">{i18nT("replay.report.wholeGame")}</span>
                <b>{me.value ? pct(me.value.whole!.wholeGame) : "—"}%</b>
                <span class="srp-head__score-sub">
                  {i18nT("replay.report.fireMove", {
                    f: me.value?.whole?.wholeFire != null ? pct(me.value.whole.wholeFire) : "—",
                    m: me.value ? pct(me.value.whole!.wholeMove) : "—",
                  })}
                </span>
              </div>
            </div>
            <div class="srp-head__coverage">
              <span class="srp-head__coverage-label">
                {i18nT("replay.report.coverage")}: {me.value ? pct(me.value.coverage.completeness) : "—"}%
                {me.value && me.value.coverage.gapSeconds > 12 ? (
                  <span class="srp-head__coverage-note">
                    {i18nT("replay.report.gapNote", { s: Math.round(me.value.coverage.gapSeconds) })}
                  </span>
                ) : null}
              </span>
              <div class="srp-coverage-bar">
                {(me.value?.coverage.gapSegments ?? []).map(([a, b], i) => (
                  <div
                    key={i}
                    class="srp-coverage-bar__gap"
                    style={{
                      left: `${(a / Math.max(1, props.report.durationS)) * 100}%`,
                      width: `${((b - a) / Math.max(1, props.report.durationS)) * 100}%`,
                    }}
                  />
                ))}
              </div>
            </div>
          </div>

          <TrendChart report={props.report} />

          {/* ── moment cards ── */}
          <div class="srp-moments">
            {props.report.moments.length === 0 ? (
              <div class="srp-moments__empty">{i18nT("replay.report.noMoments")}</div>
            ) : (
              props.report.moments.map((m, i) => (
                <div key={m.t} class={`srp-moment srp-moment--${categoryTone(m.category)}`}>
                  <div class="srp-moment__head">
                    <span class="srp-moment__idx">#{i + 1}</span>
                    <span class="srp-moment__time">
                      {String(Math.floor(m.t / 60)).padStart(2, "0")}:
                      {String(Math.floor(m.t % 60)).padStart(2, "0")}
                    </span>
                    <AppTag tone={CATEGORY_TONE[m.category].tag}>
                      {i18nT(`replay.report.cat_${m.category}`)}
                    </AppTag>
                    {props.onSeek ? (
                      <HkButton
                        variant="secondary"
                        size="xs"
                        onClick={() => props.onSeek?.(m.t)}
                        aria-label={i18nT("replay.report.seekHint")}
                      >
                        <Camera size={12} />
                        <span>{i18nT("replay.report.seek")}</span>
                      </HkButton>
                    ) : null}
                  </div>
                  <div class="srp-moment__body">
                    <div class="srp-moment__stat">
                      <span>{i18nT("replay.report.hp")}</span>
                      <b>{m.hpFrac != null ? `${pct(m.hpFrac)}%` : "—"}</b>
                      {m.hpFracAfter != null && m.hpFrac != null ? (
                        <span class="srp-moment__delta">
                          → {pct(m.hpFracAfter)}% ({i18nT("replay.report.after20")})
                        </span>
                      ) : null}
                    </div>
                    <div class="srp-moment__stat">
                      <span>{i18nT("replay.report.speed")}</span>
                      <b>{m.speedKt != null ? `${Math.round(m.speedKt)}kt` : "—"}</b>
                    </div>
                    <div class="srp-moment__stat">
                      <span>{i18nT("replay.report.nearestEnemy")}</span>
                      {m.nearestEnemy ? (
                        <b>
                          {formatHp(m.nearestEnemy.distM)}m
                          <span class={`srp-moment__range ${m.nearestEnemy.inRange ? "in" : "out"}`}>
                            {i18nT(
                              m.nearestEnemy.inRange
                                ? "replay.report.inRange"
                                : "replay.report.outOfRange",
                            )}
                          </span>
                        </b>
                      ) : (
                        <b>—</b>
                      )}
                    </div>
                    <div class="srp-moment__stat">
                      <span>{i18nT("replay.report.observed")}</span>
                      <b>{m.enemiesObserved}</b>
                    </div>
                    <div class="srp-moment__stat">
                      <span>{i18nT("replay.report.fireAction")}</span>
                      <b>
                        {m.fired == null
                          ? "—"
                          : m.fired
                            ? i18nT("replay.report.fired")
                            : i18nT("replay.report.held")}
                        {m.fireProb != null ? (
                          <span class="srp-moment__prob">p={pct(m.fireProb)}%</span>
                        ) : null}
                      </b>
                    </div>
                    <div class="srp-moment__stat">
                      <span>{i18nT("replay.report.moveAdvice")}</span>
                      <b>
                        {sectorLabel(m.advisedSector)} ({pct(m.advisedProb)}%)
                        <span class="srp-moment__actual">
                          {i18nT("replay.report.actual")} {sectorLabel(m.moveSector)}
                        </span>
                      </b>
                    </div>
                    <div class="srp-moment__stat">
                      <span>{i18nT("replay.report.instScore")}</span>
                      <b>
                        {pct(m.inst)}%
                        <span class="srp-moment__prob">κ={pct(m.confidence)}%</span>
                      </b>
                    </div>
                    <div class="srp-moment__stat srp-moment__stat--outcome">
                      <span>{i18nT("replay.report.outcome")}</span>
                      <b>
                        {m.hpLostWindow != null && m.hpLostWindow > 0
                          ? i18nT("replay.report.hpLost", { v: formatHp(m.hpLostWindow) })
                          : i18nT("replay.report.noAttributed")}
                      </b>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <div class="srp-foot">
            {i18nT("replay.report.modelNote")} · {props.report.modelSources.fire.split(/[\\/]/).pop()} ·{" "}
            {props.report.modelSources.moveModel.split(/[\\/]/).pop()}
          </div>
        </div>
        </HkScrollContainer>
      </div>
    );
  },
});
