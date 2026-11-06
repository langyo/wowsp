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
 * (the waterfall of annotations), with the score track kept underneath.
 * Same DOM, same data, no hover needed.
 *
 * The axis ends at the SELECTED PLAYER's data horizon — their death time when
 * sunk, the last scored row for a survivor whose tail was censored, and
 * never past the battle — so the curve and the callouts fill the width to
 * the last sample. Pinning the timeline to the whole battle left a dead
 * right third on the curve whenever the player sank early.
 *
 * The score track is TWO overlaid envelopes, one per evaluation model: the
 * fire model (scored only on can-fire rows) and the move model (every row),
 * drawn as one hand-drawn full-width SVG. The same time mapping drives the
 * ruler, the lane and both paths, and the SVG stretches edge to edge with
 * non-scaling strokes — no chart grid gutters, no canvas, deterministic in
 * the html-to-image export.
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
import { HkButton } from "@celestia-island/hikari";
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
/** The score track: two hand-drawn model envelopes in ONE full-width SVG
 *  (preserveAspectRatio="none", non-scaling strokes). Authored against this
 *  viewBox; the path stretches to the card width, so the envelopes, the
 *  ruler and the keyframe lane share the timeline EDGE TO EDGE — the old
 *  chart's 50/20 px grid gutters were the dead left/right bands the
 *  2026-11-06 screenshot report called out. */
const TRACK_HEIGHT_PX = 158;
const TRACK_PAD_TOP_PX = 8;
const TRACK_PAD_BOTTOM_PX = 8;
const TRACK_VIEW_WIDTH = 1000;
/** The score track's y-axis gutter: percentage labels, tick marks and the
 *  vertical "model agreement" caption. The whole timeline body (ruler, lane,
 *  callouts, track) is inset by the same width, so the time mapping stays
 *  shared across the gutter. */
const AXIS_WIDTH_PX = 50;
/** Labelled ticks on the 0–1 score scale (top to bottom). */
const AXIS_TICKS = [1, 0.75, 0.5, 0.25, 0];
/** The two score models the report dissects: the fire model (only scored on
 *  can-fire rows) and the move model (every row). */
type TrackModel = "fire" | "move";
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
const READOUT_WIDTH_PX = 268;
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

    const moments = computed(() => props.report.moments ?? []);
    const samples = computed(() => props.report.timeline ?? []);
    const me = computed<StaticRosterEntry | undefined>(() =>
      props.report.roster.find((row) => row.entityId === props.report.entityId),
    );
    const gaps = computed(() => coverageGaps(me.value?.coverage));

    /** The axis ends where the selected player's DATA ends — their death
     *  time for a sunk ship, the replay horizon for a survivor. Pinning the
     *  timeline to the battle horizon instead left a dead empty right third
     *  on the curve whenever the player sank early (2026-11-06 screenshot
     *  report: "右边空一大块"). */
    const horizon = computed(() => {
      const battle = Math.max(1, props.report.durationS);
      const series = props.report.timeline ?? [];
      const last = series.length ? series[series.length - 1].t : 0;
      const aliveTo = me.value?.coverage.aliveTo;
      let end = battle;
      // The last SCORED row wins over the death time: the score grid is not
      // aligned with the trajectory, so capping at the death sample alone
      // could still leave up to one grid step of dead tail.
      if (aliveTo != null && aliveTo > 0) end = Math.min(end, aliveTo);
      if (last > 0) end = Math.min(end, last);
      return Math.max(1, end);
    });

    const frac = (tSec: number): number => timelineFrac(tSec, horizon.value);
    const ticks = computed(() => rulerTicks(horizon.value));

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
      fire: number | null;
      move: number | null;
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
        horizon.value,
        moments.value,
        rect.width,
      );
      hoverIndex.value = hit;
      if (hit != null) {
        readout.value = null;
        return;
      }
      const tSec = (xPct / 100) * (horizon.value + HEADROOM_S) - HEADROOM_S;
      const sampleIndex = nearestSampleIndex(samples.value, tSec);
      const nearestSample = sampleIndex == null ? null : samples.value[sampleIndex];
      readout.value = {
        xPct,
        tSec,
        inst: nearestSample == null ? null : nearestSample.inst,
        fire: nearestSample == null ? null : nearestSample.fire,
        move: nearestSample == null ? null : nearestSample.move,
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

    // ── score track: the two model envelopes, edge to edge ──
    /** Track geometry in viewBox units: the whole width IS the timeline, so
     *  the horizon sample lands exactly on the right edge. */
    const trackX = (tSec: number): number =>
      (timelineFrac(tSec, horizon.value) / 100) * TRACK_VIEW_WIDTH;
    const trackY = (value: number): number => {
      const clamped = Math.max(0, Math.min(1, value));
      return (
        TRACK_HEIGHT_PX -
        TRACK_PAD_BOTTOM_PX -
        clamped * (TRACK_HEIGHT_PX - TRACK_PAD_TOP_PX - TRACK_PAD_BOTTOM_PX)
      );
    };
    /** A model's scored samples in time order. The fire model only exists on
     *  can-fire rows; the envelope bridges the unscored rows (dashed stroke
     *  in CSS) so it still reads as a curve, and the dots mark the rows the
     *  model actually evaluated. */
    function modelPoints(model: TrackModel): { t: number; value: number }[] {
      return samples.value.flatMap((sample) => {
        const value = model === "fire" ? sample.fire : sample.move;
        return value == null ? [] : [{ t: sample.t, value }];
      });
    }
    function modelPath(model: TrackModel): string {
      return modelPoints(model)
        .map(
          (point, index) =>
            (index === 0 ? "M " : "L ") +
            trackX(point.t).toFixed(2) +
            " " +
            trackY(point.value).toFixed(2),
        )
        .join(" ");
    }
    const movePath = computed(() => modelPath("move"));
    const firePath = computed(() => modelPath("fire"));
    /** The fire key is only meaningful when the model scored at least one
     *  row (a report without can-fire windows is a legitimate run). */
    const hasFire = computed(() =>
      samples.value.some((sample) => sample.fire != null),
    );
    /** A one-row move series draws no segment either — mark the point. */
    const moveDots = computed(() => {
      const points = modelPoints("move");
      if (points.length !== 1) return [];
      const [point] = points;
      if (!point) return [];
      return [
        {
          left: (trackX(point.t) / TRACK_VIEW_WIDTH) * 100,
          top: (trackY(point.value) / TRACK_HEIGHT_PX) * 100,
        },
      ];
    });
    /** Dots only where the fire model's scored rows are ISOLATED (no scored
     *  neighbour on either side): single unmarked vertices of the dashed
     *  envelope. Inside a run the envelope already carries the sample, so no
     *  bead chain is laid over it. DOM dots rather than SVG circles: the
     *  stretched viewBox would flatten them. */
    const fireDots = computed(() => {
      const series = samples.value;
      const scored = series.map((sample) => sample.fire != null);
      return series.flatMap((sample, index) => {
        if (!scored[index]) return [];
        const left = scored[index - 1] === true;
        const right = scored[index + 1] === true;
        if (left || right) return [];
        const value = sample.fire;
        if (value == null) return [];
        return [
          {
            left: (trackX(sample.t) / TRACK_VIEW_WIDTH) * 100,
            top: (trackY(value) / TRACK_HEIGHT_PX) * 100,
          },
        ];
      });
    });
    /** Readability guides at 25/50/75% (the track is a 0–100% score axis). */
    const TRACK_GRID = [0.25, 0.5, 0.75];
    /** Keyframe hairlines through the track: the editor marker lines that tie
     *  the lane above to the envelopes below. */
    const trackMarks = computed(() =>
      moments.value.map((moment) => ({
        x: trackX(moment.t),
        tone: categoryTone(moment.category),
      })),
    );

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
        <div class={"srp-tl__gaps " + extraClass} aria-hidden="true">
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

        <div
          class="srp-tl__plot"
          style={{ paddingLeft: AXIS_WIDTH_PX + "px" }}
        >
          <div class="srp-tl__top">
            {renderGaps("srp-tl__gaps--top")}
            <div class="srp-tl__ruler" aria-hidden="true">
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
                  <span
                    class="srp-tl__readout-model"
                    aria-label={
                      t("replay.report.moveModel") +
                      " " +
                      (readout.value.move == null
                        ? "—"
                        : pct(readout.value.move) + "%")
                    }
                  >
                    <i class="srp-tl__track-dot srp-tl__track-dot--move" />
                    {readout.value.move == null
                      ? "—"
                      : pct(readout.value.move) + "%"}
                  </span>
                  <span
                    class="srp-tl__readout-model"
                    aria-label={
                      t("replay.report.fireModel") +
                      " " +
                      (readout.value.fire == null
                        ? "—"
                        : pct(readout.value.fire) + "%")
                    }
                  >
                    <i class="srp-tl__track-dot srp-tl__track-dot--fire" />
                    {readout.value.fire == null
                      ? "—"
                      : pct(readout.value.fire) + "%"}
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
              style={{ height: calloutBandHeight.value + "px" }}
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

          <div class="srp-tl__track" style={{ height: TRACK_HEIGHT_PX + "px" }}>
            {renderGaps("srp-tl__gaps--track")}
            <svg
              class="srp-tl__score"
              viewBox={"0 0 " + TRACK_VIEW_WIDTH + " " + TRACK_HEIGHT_PX}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {TRACK_GRID.map((value) => (
                <line
                  key={value}
                  class={
                    "srp-tl__score-grid" +
                    (value === 0.5 ? " srp-tl__score-grid--mid" : "")
                  }
                  x1="0"
                  x2={TRACK_VIEW_WIDTH}
                  y1={trackY(value)}
                  y2={trackY(value)}
                  vector-effect="non-scaling-stroke"
                />
              ))}
              {trackMarks.value.map((mark, index) => (
                <line
                  key={index}
                  class={"srp-tl__score-mark srp-tl__score-mark--" + mark.tone}
                  x1={mark.x}
                  x2={mark.x}
                  y1="0"
                  y2={TRACK_HEIGHT_PX}
                  vector-effect="non-scaling-stroke"
                />
              ))}
              <path
                class="srp-tl__score-line srp-tl__score-line--move"
                d={movePath.value}
                vector-effect="non-scaling-stroke"
              />
              <path
                class="srp-tl__score-line srp-tl__score-line--fire"
                d={firePath.value}
                vector-effect="non-scaling-stroke"
              />
            </svg>
            {moveDots.value.map((dot, index) => (
              <span
                key={"move-" + index}
                class="srp-tl__score-dot srp-tl__score-dot--move"
                style={{ left: dot.left + "%", top: dot.top + "%" }}
              />
            ))}
            {fireDots.value.map((dot, index) => (
              <span
                key={index}
                class="srp-tl__score-dot"
                style={{ left: dot.left + "%", top: dot.top + "%" }}
              />
            ))}
            <span class="srp-tl__track-legend">
              <span class="srp-tl__track-key">
                <i class="srp-tl__track-dot srp-tl__track-dot--move" />
                {t("replay.report.moveModel")}
              </span>
              {hasFire.value ? (
                <span class="srp-tl__track-key">
                  <i class="srp-tl__track-dot srp-tl__track-dot--fire" />
                  {t("replay.report.fireModel")}
                </span>
              ) : null}
              <span class="srp-tl__track-hint">{t("replay.report.axisHint")}</span>
            </span>
          </div>
          <div
            class="srp-tl__yaxis"
            aria-hidden="true"
            style={{
              width: AXIS_WIDTH_PX + "px",
              height: TRACK_HEIGHT_PX + "px",
            }}
          >
            <span class="srp-tl__yaxis-title">
              {t("replay.report.modelAxis")}
            </span>
            {AXIS_TICKS.map((value) => (
              <span
                key={value}
                class="srp-tl__yaxis-mark"
                style={{ top: trackY(value) + "px" }}
              >
                {Math.round(value * 100)}%
                <i class="srp-tl__yaxis-tick" />
              </span>
            ))}
          </div>
        </div>
      </section>
    );
  },
});
