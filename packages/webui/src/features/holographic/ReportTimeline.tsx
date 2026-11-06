/**
 * ReportTimeline — the AI report's editor-style keyframe timeline.
 *
 * Replaces the old wall of key-moment CARDS: battle time is a horizontal
 * ruler, every key moment is a keyframe diamond on the lane, and the detail
 * lives behind the interaction. Hovering (or keyboard-focusing) a keyframe
 * floats its full situation card; clicking pins it (touch included) and the
 * card carries the jump action that seeks the 3D board to the moment. The
 * axis itself reports the position under the cursor — battle time, instant
 * score, whether the player was unresolvable there, and the nearest
 * keyframe — so "what happened around here" is one hover away.
 *
 * The long image has no pointer: `capturing` swaps the interaction for a
 * static annotation band — each keyframe pulls a leader line down to a
 * compact detail callout, staggered into lanes so callouts never overlap
 * (the waterfall of annotations), with the instant-score curve kept as the
 * timeline's media track underneath. Same DOM, same data, no hover needed.
 *
 * The score curve IS hikari's HkTrendChart (dependency-free, deterministic,
 * no canvas): the `now` window is pinned to the report's battle horizon, so
 * the curve, the ruler labels and the keyframe positions all share one
 * exact time mapping (the chart's own grid insets are the only geometry the
 * overlays derive from — see the exported TREND_CHART_GRID_* constants).
 */
import {
  computed,
  defineComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type PropType,
} from "vue";
import {
  HkButton,
  HkTrendChart,
  TREND_CHART_GRID_LEFT,
  TREND_CHART_GRID_RIGHT,
  TREND_CHART_WIDTH,
  type TrendPen,
} from "@celestia-island/hikari";
import { Camera } from "@lucide/vue";

import AppTag from "@/components/base/AppTag";
import { t } from "@/i18n";
import type { StaticMoment, StaticReport, StaticRosterEntry } from "@/api";
import {
  CATEGORY_TONE,
  categoryLabel,
  categoryTone,
  coverageGaps,
  formatClock,
  formatHp,
  pct,
  sectorLabel,
} from "./reportFormat";
import "./StaticReportPanel.scss";

/** Lead-in before battle-second 0: the first sample sits one step inside the
 *  plot instead of on its edge (the same frame the old sparkline used). */
const HEADROOM_S = 2;
/** The score track's rendered height. HkTrendChart lifts this px height
 *  into its viewBox, so its grid bands are pixel-true; the track frame is
 *  CLIPPED to the plot's bottom edge (the chart's 40 px bottom band is
 *  empty — the report's ruler lives above the lane instead), which keeps
 *  the card from carrying a dead strip under the curve. */
const CHART_HEIGHT_PX = 190;
const CHART_HEIGHT = CHART_HEIGHT_PX + "px";
const CHART_PLOT_HEIGHT_PX = CHART_HEIGHT_PX - 40;
/** HkTrendChart stretches its 640-wide viewBox across the host
 *  (preserveAspectRatio="none"), so its exported grid insets are fractions
 *  of that viewBox. The ruler, the keyframe lane and the annotation band
 *  all ride the SAME plot rectangle, so the time mapping can never drift
 *  from the curve beneath it. */
const PLOT_LEFT_PCT = (TREND_CHART_GRID_LEFT / TREND_CHART_WIDTH) * 100;
const PLOT_RIGHT_PCT = (TREND_CHART_GRID_RIGHT / TREND_CHART_WIDTH) * 100;
const PLOT_INSET_STYLE = {
  marginLeft: PLOT_LEFT_PCT + "%",
  marginRight: PLOT_RIGHT_PCT + "%",
};
/** Annotation callouts (capture mode): fixed card box, vertical pitch and
 *  the leader segment that reaches from the lane's centre line. */
export const CALLOUT_WIDTH_PX = 220;
/** The band's fixed card box. Tall enough for the seven detail rows plus
 *  the head AND for the longer EN/ES/RU labels wrapping a value onto a
 *  second line — a fixed box is what lets the lane packer guarantee that
 *  cards never overlap, so it must be sized for the worst locale. */
export const CALLOUT_HEIGHT_PX = 200;
const CALLOUT_GAP_PX = 10;
/** Lane centre (20) + the flex gap above the callout band (10): the leader
 *  line starts this far above the band so it visibly leaves the keyframe
 *  lane's centre line. */
const LEADER_TOP_PX = 30;
/** Pointer slop for "hovering a keyframe" (its click target is 28 px). */
const MARKER_HIT_PX = 12;
/** Floating card width (hover/pinned) and the edge gutter it keeps. */
const TIP_WIDTH_PX = 300;
const READOUT_WIDTH_PX = 186;
/** Ruler steps (battle seconds): the smallest step that keeps the label
 *  count at or below six, then the battle end is always pinned. */
const RULER_STEPS = [15, 30, 60, 120, 300, 600, 900];

/** Battle second → % across the shared time window (chart, ruler, lane and
 *  annotations all use it). Exported for vitest. */
export function timelineFrac(tSec: number, durationS: number): number {
  const span = Math.max(1, durationS) + HEADROOM_S;
  return ((tSec + HEADROOM_S) / span) * 100;
}

/** The ruler's labelled ticks: round battle steps up to six labels, plus
 *  the battle end. Exported for vitest. */
export function rulerTicks(durationS: number): { t: number; label: string }[] {
  const duration = Math.max(1, Math.round(durationS));
  const step =
    RULER_STEPS.find((candidate) => duration / candidate <= 6) ??
    RULER_STEPS[RULER_STEPS.length - 1];
  const ticks: { t: number; label: string }[] = [];
  for (let at = 0; at <= duration - step * 0.3; at += step) {
    ticks.push({ t: at, label: formatClock(at) });
  }
  // The horizon is always labelled — the last sample / the death point.
  ticks.push({ t: duration, label: formatClock(duration) });
  return ticks;
}

/** Index of the sample nearest to tSec (null for an empty series).
 *  Exported for vitest. */
export function nearestSampleIndex(
  samples: readonly { t: number }[],
  tSec: number,
): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  samples.forEach((sample, index) => {
    const distance = Math.abs(sample.t - tSec);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** Index of the key moment nearest to tSec (null when there is none).
 *  Exported for vitest. */
export function nearestMomentIndex(
  moments: readonly { t: number }[],
  tSec: number,
): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  moments.forEach((moment, index) => {
    const distance = Math.abs(moment.t - tSec);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** Whether tSec falls inside one of the player's unresolvable segments.
 *  Exported for vitest. */
export function inCoverageGap(
  gaps: readonly [number, number][],
  tSec: number,
): boolean {
  return gaps.some(([from, to]) => tSec >= from && tSec <= to);
}

/** Keyframe index under a pointer at xPct (percent of the plot), or null
 *  when the nearest keyframe is further away than hitPx. Exported for
 *  vitest. */
export function markerHitIndex(
  xPct: number,
  durationS: number,
  moments: readonly { t: number }[],
  plotWidthPx: number,
  hitPx = MARKER_HIT_PX,
): number | null {
  let best: number | null = null;
  let bestDistance = hitPx;
  moments.forEach((moment, index) => {
    const markerPx = (timelineFrac(moment.t, durationS) / 100) * plotWidthPx;
    const pointerPx = (Math.max(0, Math.min(100, xPct)) / 100) * plotWidthPx;
    const distance = Math.abs(markerPx - pointerPx);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** Left edges + lane rows of the annotation callouts: cards are centred on
 *  their keyframe (clamped inside the plot) and packed into the first lane
 *  where they clear the previous card by gapPx. Exported for vitest. */
export function assignCalloutLanes(
  xPx: readonly number[],
  plotWidthPx: number,
  cardWidthPx: number,
  gapPx = 8,
): { left: number; lane: number }[] {
  const laneRight: number[] = [];
  return xPx.map((x) => {
    const left = Math.min(
      Math.max(0, x - cardWidthPx / 2),
      Math.max(0, plotWidthPx - cardWidthPx),
    );
    const right = left + cardWidthPx;
    let lane = laneRight.findIndex((lastRight) => lastRight + gapPx <= left);
    if (lane === -1) {
      lane = laneRight.length;
      laneRight.push(right);
    } else {
      laneRight[lane] = right;
    }
    return { left, lane };
  });
}

/** One key moment's detail body — the tooltip card and the capture callouts
 *  render the exact same rows, so the shared image never says less than the
 *  hover card. */
function MomentRows(props: { moment: StaticMoment }) {
  const moment = props.moment;
  const enemy = moment.nearestEnemy;
  return (
    <div class="srp-tl__rows">
      <div class="srp-tl__row">
        <span class="srp-tl__row-label">{t("replay.report.hp")}</span>
        <span class="srp-tl__row-value">
          {moment.hpFrac != null ? pct(moment.hpFrac) + "%" : "—"}
          {moment.hpFrac != null && moment.hpFracAfter != null ? (
            <span class="srp-tl__row-sub">
              → {pct(moment.hpFracAfter)}% ({t("replay.report.after20")})
            </span>
          ) : null}
        </span>
      </div>
      <div class="srp-tl__row">
        <span class="srp-tl__row-label">{t("replay.report.speed")}</span>
        <span class="srp-tl__row-value">
          {moment.speedKt != null ? Math.round(moment.speedKt) + "kt" : "—"}
          <span class="srp-tl__row-sub">
            {t("replay.report.observed")} {moment.enemiesObserved}
          </span>
        </span>
      </div>
      <div class="srp-tl__row">
        <span class="srp-tl__row-label">{t("replay.report.nearestEnemy")}</span>
        <span class="srp-tl__row-value">
          {enemy ? (
            <>
              {formatHp(enemy.distM)}m
              <span class={"srp-tl__range " + (enemy.inRange ? "in" : "out")}>
                {t(
                  enemy.inRange
                    ? "replay.report.inRange"
                    : "replay.report.outOfRange",
                )}
              </span>
            </>
          ) : (
            "—"
          )}
        </span>
      </div>
      <div class="srp-tl__row">
        <span class="srp-tl__row-label">{t("replay.report.fireAction")}</span>
        <span class="srp-tl__row-value">
          {moment.fired == null
            ? "—"
            : moment.fired
              ? t("replay.report.fired")
              : t("replay.report.held")}
          {moment.fireProb != null ? (
            <span class="srp-tl__row-sub">p={pct(moment.fireProb)}%</span>
          ) : null}
        </span>
      </div>
      <div class="srp-tl__row">
        <span class="srp-tl__row-label">{t("replay.report.moveAdvice")}</span>
        <span class="srp-tl__row-value">
          {sectorLabel(moment.advisedSector)} ({pct(moment.advisedProb)}%)
          <span class="srp-tl__row-sub">
            {t("replay.report.actual")} {sectorLabel(moment.moveSector)}
          </span>
        </span>
      </div>
      <div class="srp-tl__row">
        <span class="srp-tl__row-label">{t("replay.report.instScore")}</span>
        <span class="srp-tl__row-value">
          {pct(moment.inst)}%
          <span class="srp-tl__row-sub">κ={pct(moment.confidence)}%</span>
        </span>
      </div>
      <div class="srp-tl__row">
        <span class="srp-tl__row-label">{t("replay.report.outcome")}</span>
        <span class="srp-tl__row-value srp-tl__row-value--outcome">
          {moment.hpLostWindow != null && moment.hpLostWindow > 0
            ? t("replay.report.hpLost", { v: formatHp(moment.hpLostWindow) })
            : t("replay.report.noAttributed")}
        </span>
      </div>
    </div>
  );
}

/** Head shared by the tooltip card and the callout: "#3 03:45 [伤害兑现]". */
function MomentHead(props: { moment: StaticMoment; index: number }) {
  const moment = props.moment;
  return (
    <div class="srp-tl__moment-head">
      <span class="srp-tl__moment-idx">#{props.index + 1}</span>
      <span class="srp-tl__moment-time">{formatClock(moment.t)}</span>
      <AppTag tone={CATEGORY_TONE[moment.category].tag}>
        {categoryLabel(moment.category)}
      </AppTag>
    </div>
  );
}

export default defineComponent({
  name: "ReportTimeline",
  props: {
    report: { type: Object as PropType<StaticReport>, required: true },
    /** Export mode: render the annotation band, drop every hover surface. */
    capturing: { type: Boolean, default: false },
    /** Battle-time seek (the 3D board playhead); the tooltip's jump action
     *  and the host's own prop both ride it. */
    onSeek: { type: Function as PropType<(t: number) => void>, default: null },
  },
  setup(props) {
    const laneRef = ref<HTMLElement | null>(null);
    /** Plot width in px — the annotation lane math needs real pixels (the
     *  chart itself stretches, but the leader lines must land on its
     *  vertices). Re-measured on every resize. */
    const laneWidth = ref(0);
    let resizeObserver: ResizeObserver | null = null;

    onMounted(() => {
      const el = laneRef.value;
      if (!el) return;
      laneWidth.value = el.clientWidth;
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          laneWidth.value = el.clientWidth;
        });
        resizeObserver.observe(el);
      }
    });
    onBeforeUnmount(() => {
      resizeObserver?.disconnect();
      resizeObserver = null;
    });

    const duration = computed(() => Math.max(1, props.report.durationS));
    const moments = computed(() => props.report.moments ?? []);
    const samples = computed(() => props.report.timeline ?? []);
    const me = computed<StaticRosterEntry | undefined>(() =>
      props.report.roster.find((row) => row.entityId === props.report.entityId),
    );
    const gaps = computed(() => coverageGaps(me.value?.coverage));

    const frac = (tSec: number): number => timelineFrac(tSec, duration.value);
    const ticks = computed(() => rulerTicks(duration.value));

    /** Legend entries for the categories actually present, in the fixed
     *  category order (one table drives marker, legend, badge and card). */
    const legend = computed(() => {
      const present = new Set(moments.value.map((moment) => moment.category));
      return (Object.keys(CATEGORY_TONE) as StaticMoment["category"][])
        .filter((category) => present.has(category))
        .map((category) => ({
          category,
          tone: categoryTone(category),
          label: categoryLabel(category),
        }));
    });

    // ── interaction: hover card, pinned card, axis readout ──
    const hoverIndex = ref<number | null>(null);
    const pinnedIndex = ref<number | null>(null);
    const readout = ref<{
      xPct: number;
      tSec: number;
      inst: number | null;
      inGap: boolean;
      nearest: number | null;
    } | null>(null);
    /** The card on screen: a pin outranks the transient hover. */
    const activeIndex = computed(() => pinnedIndex.value ?? hoverIndex.value);
    const activeMoment = computed(() => {
      const index = activeIndex.value;
      return index == null ? null : (moments.value[index] ?? null);
    });

    function onPointerMove(event: PointerEvent) {
      if (props.capturing) return;
      const el = laneRef.value;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const xPx = event.clientX - rect.left;
      const xPct = Math.max(0, Math.min(100, (xPx / rect.width) * 100));
      const hit = markerHitIndex(
        xPct,
        duration.value,
        moments.value,
        rect.width,
      );
      hoverIndex.value = hit;
      if (hit != null) {
        readout.value = null;
        return;
      }
      const tSec = (xPct / 100) * (duration.value + HEADROOM_S) - HEADROOM_S;
      const sampleIndex = nearestSampleIndex(samples.value, tSec);
      readout.value = {
        xPct,
        tSec,
        inst: sampleIndex == null ? null : samples.value[sampleIndex].inst,
        inGap: inCoverageGap(gaps.value, tSec),
        nearest: nearestMomentIndex(moments.value, tSec),
      };
    }

    function clearHover() {
      hoverIndex.value = null;
      readout.value = null;
    }

    /** Entering capture mode drops every interaction surface: a card pinned
     *  by keyboard (no pointerdown to unpin it) must never be cloned into
     *  the long image. */
    watch(
      () => props.capturing,
      (capturing) => {
        if (capturing) {
          hoverIndex.value = null;
          pinnedIndex.value = null;
          readout.value = null;
        }
      },
    );

    function onMarkerClick(index: number) {
      if (props.capturing) return;
      pinnedIndex.value = pinnedIndex.value === index ? null : index;
    }

    /** Clicking anywhere else (or Escape) dismisses a pinned card. */
    function onDocumentPointerDown(event: PointerEvent) {
      if (pinnedIndex.value == null) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".srp-tl__kf, .srp-tl__tip")
      ) {
        return;
      }
      pinnedIndex.value = null;
    }
    /** Escape dismisses the pinned card and only the card: the listener
     *  runs in the CAPTURE phase and swallows the key, so the hosting
     *  HkModal's own Escape (close the window) never sees it while a card
     *  is pinned. */
    function onDocumentKeydown(event: KeyboardEvent) {
      if (event.key === "Escape" && pinnedIndex.value != null) {
        event.stopPropagation();
        pinnedIndex.value = null;
      }
    }
    onMounted(() => {
      document.addEventListener("pointerdown", onDocumentPointerDown, true);
      document.addEventListener("keydown", onDocumentKeydown, true);
    });
    onBeforeUnmount(() => {
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onDocumentKeydown, true);
    });

    /** Floating card horizontal placement: centred on the keyframe, clamped
     *  inside the plot so it never leaves the sheet. */
    const tipStyle = computed(() => {
      const moment = activeMoment.value;
      if (!moment) return {};
      const half = TIP_WIDTH_PX / 2;
      return {
        left:
          "clamp(4px, calc(" +
          frac(moment.t) +
          "% - " +
          half +
          "px), calc(100% - " +
          (TIP_WIDTH_PX + 4) +
          "px))",
      };
    });
    const readoutStyle = computed(() => {
      const position = readout.value;
      if (!position) return {};
      const half = READOUT_WIDTH_PX / 2;
      return {
        left:
          "clamp(4px, calc(" +
          position.xPct +
          "% - " +
          half +
          "px), calc(100% - " +
          (READOUT_WIDTH_PX + 4) +
          "px))",
      };
    });

    // ── score track ──
    const pens = computed<TrendPen[]>(() => [
      {
        label: t("replay.report.instScore"),
        data: samples.value.map((sample) => ({
          // Battle seconds ride the chart's numeric time axis directly as
          // battle-time ms; `now` below pins the window to the horizon.
          time: sample.t * 1000,
          value: sample.inst * 100,
        })),
      },
    ]);
    const windowMs = computed(() => (duration.value + HEADROOM_S) * 1000);
    const nowMs = computed(() => duration.value * 1000);

    // ── capture-mode annotation band ──
    const callouts = computed(() => {
      if (!props.capturing) return [];
      const width = laneWidth.value > 0 ? laneWidth.value : 1000;
      const xs = moments.value.map((moment) => (frac(moment.t) / 100) * width);
      const placement = assignCalloutLanes(
        xs,
        width,
        CALLOUT_WIDTH_PX,
        CALLOUT_GAP_PX,
      );
      return moments.value.map((moment, index) => ({
        moment,
        index,
        xPx: xs[index],
        ...placement[index],
      }));
    });
    const calloutBandHeight = computed(() => {
      const lanes = callouts.value.reduce(
        (max, callout) => Math.max(max, callout.lane + 1),
        0,
      );
      return lanes === 0
        ? 0
        : lanes * (CALLOUT_HEIGHT_PX + CALLOUT_GAP_PX) - CALLOUT_GAP_PX;
    });

    function renderGaps(extraClass: string) {
      return (
        <div class={"srp-tl__gaps " + extraClass} style={PLOT_INSET_STYLE} aria-hidden="true">
          {gaps.value.map(([from, to], index) => (
            <span
              key={index}
              class="srp-tl__gap"
              style={{
                left: frac(from) + "%",
                width: Math.max(0.25, frac(to) - frac(from)) + "%",
              }}
            />
          ))}
        </div>
      );
    }

    return () => (
      <section class={["srp-tl", props.capturing ? "srp-tl--capturing" : ""]}>
        <header class="srp-tl__head">
          <span class="srp-tl__title">{t("replay.report.timeline")}</span>
          <span class="srp-tl__count">
            {t("replay.report.keyframes", { n: moments.value.length })}
          </span>
          <div class="srp-tl__legend">
            {legend.value.map((entry) => (
              <span key={entry.category} class="srp-tl__legend-item">
                <i
                  class={
                    "srp-tl__legend-dot srp-tl__legend-dot--" + entry.tone
                  }
                />
                {entry.label}
              </span>
            ))}
          </div>
          {props.capturing ? null : (
            <span class="srp-tl__hint">{t("replay.report.timelineHint")}</span>
          )}
        </header>

        <div class="srp-tl__top">
          {renderGaps("srp-tl__gaps--top")}
          <div class="srp-tl__ruler" style={PLOT_INSET_STYLE} aria-hidden="true">
            {ticks.value.map((tick, index) => (
              <span
                key={tick.t}
                class={[
                  "srp-tl__tick",
                  index === 0 ? "srp-tl__tick--start" : "",
                  index === ticks.value.length - 1 ? "srp-tl__tick--end" : "",
                ]}
                style={{ left: frac(tick.t) + "%" }}
              >
                {tick.label}
              </span>
            ))}
          </div>
          <div
            ref={laneRef}
            class="srp-tl__lane"
            style={PLOT_INSET_STYLE}
            onPointermove={onPointerMove}
            onPointerleave={clearHover}
          >
            <span class="srp-tl__axis" aria-hidden="true" />
            {moments.value.map((moment, index) => (
              <button
                key={moment.t}
                type="button"
                class={[
                  "srp-tl__kf",
                  activeIndex.value === index ? "srp-tl__kf--active" : "",
                  pinnedIndex.value === index ? "srp-tl__kf--pinned" : "",
                ]}
                style={{ left: frac(moment.t) + "%" }}
                aria-label={t("replay.report.momentAria", {
                  n: index + 1,
                  t: formatClock(moment.t),
                })}
                aria-haspopup="dialog"
                aria-expanded={pinnedIndex.value === index}
                onClick={() => onMarkerClick(index)}
                onFocus={() => {
                  if (!props.capturing) hoverIndex.value = index;
                }}
                onBlur={() => {
                  hoverIndex.value = null;
                }}
              >
                <i
                  class={
                    "srp-tl__kf-glyph srp-tl__kf-glyph--" +
                    categoryTone(moment.category)
                  }
                />
              </button>
            ))}
            {moments.value.length === 0 ? (
              <span class="srp-tl__empty">{t("replay.report.noMoments")}</span>
            ) : null}
            {readout.value && !activeMoment.value ? (
              <div
                class="srp-tl__readout"
                style={readoutStyle.value}
                role="status"
              >
                <span class="srp-tl__readout-time">
                  {formatClock(readout.value.tSec)}
                </span>
                <span class="srp-tl__readout-sep">·</span>
                <span>
                  {t("replay.report.instScore")}{" "}
                  {readout.value.inst == null
                    ? "—"
                    : pct(readout.value.inst) + "%"}
                </span>
                {readout.value.inGap ? (
                  <span class="srp-tl__readout-gap">
                    {t("replay.report.unresolved")}
                  </span>
                ) : null}
                {readout.value.nearest != null ? (
                  <span class="srp-tl__readout-near">
                    {t("replay.report.nearestEvent")} #
                    {readout.value.nearest + 1}{" "}
                    {formatClock(moments.value[readout.value.nearest].t)}
                  </span>
                ) : null}
              </div>
            ) : null}
            {activeMoment.value ? (
              <div
                class="srp-tl__tip"
                style={tipStyle.value}
                role="dialog"
                aria-label={t("replay.report.momentAria", {
                  n: (activeIndex.value ?? 0) + 1,
                  t: formatClock(activeMoment.value.t),
                })}
              >
                <MomentHead
                  moment={activeMoment.value}
                  index={activeIndex.value ?? 0}
                />
                <MomentRows moment={activeMoment.value} />
                <div class="srp-tl__tip-actions">
                  {props.onSeek ? (
                    <HkButton
                      variant="secondary"
                      size="xs"
                      aria-label={t("replay.report.seekHint")}
                      onClick={() => props.onSeek?.(activeMoment.value!.t)}
                    >
                      <Camera size={12} />
                      <span>{t("replay.report.seek")}</span>
                    </HkButton>
                  ) : null}
                  {pinnedIndex.value != null ? (
                    <button
                      type="button"
                      class="srp-tl__tip-close"
                      onClick={() => {
                        pinnedIndex.value = null;
                      }}
                    >
                      {t("replay.report.close")}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {props.capturing ? (
          <div
            class="srp-tl__callouts"
            style={{
              ...PLOT_INSET_STYLE,
              height: calloutBandHeight.value + "px",
            }}
          >
            {callouts.value.map((callout) => (
              <span
                key={"leader-" + callout.index}
                class={
                  "srp-tl__leader srp-tl__leader--" +
                  categoryTone(callout.moment.category)
                }
                style={{
                  left: callout.xPx + "px",
                  top: -LEADER_TOP_PX + "px",
                  height:
                    LEADER_TOP_PX +
                    callout.lane * (CALLOUT_HEIGHT_PX + CALLOUT_GAP_PX) +
                    "px",
                }}
                aria-hidden="true"
              />
            ))}
            {callouts.value.map((callout) => (
              <div
                key={"callout-" + callout.index}
                class={
                  "srp-tl__callout srp-tl__callout--" +
                  categoryTone(callout.moment.category)
                }
                style={{
                  left: callout.left + "px",
                  top:
                    callout.lane * (CALLOUT_HEIGHT_PX + CALLOUT_GAP_PX) + "px",
                  width: CALLOUT_WIDTH_PX + "px",
                  height: CALLOUT_HEIGHT_PX + "px",
                }}
              >
                <MomentHead moment={callout.moment} index={callout.index} />
                <MomentRows moment={callout.moment} />
              </div>
            ))}
          </div>
        ) : null}

        <div class="srp-tl__track" style={{ height: CHART_PLOT_HEIGHT_PX + "px" }}>
          {renderGaps("srp-tl__gaps--track")}
          <HkTrendChart
            pens={pens.value}
            height={CHART_HEIGHT}
            timeWindowMs={windowMs.value}
            now={nowMs.value}
            showThresholds={false}
          />
          <span class="srp-tl__track-legend">
            <i class="srp-tl__track-dot" />
            {t("replay.report.instScore")}
          </span>
        </div>
      </section>
    );
  },
});
