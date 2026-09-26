/**
 * Editor-style timeline docked above the tactical toolbar: an adaptive time
 * ruler with step pennants, ship-action markers laid out in collision rows
 * (density histogram when zoomed too far out), a draggable playhead, and a
 * bottom overview strip — the stretchy scrollbar that scales the horizontal
 * view (zoom floor: one screen shows at least 15 s of battle). User-placed
 * markers (virtual ships, pinned paths) render alongside replay actions;
 * right-click deletes them.
 *
 * Plan boards swap the collision lanes for accordion unit rows (`tracks`):
 * one collapsible row per unit, its actions as keyframes, and an AE/Flash
 * style tween arrow spanning every interpolated leg. `tall` gives the strip
 * its plan-board proportions (deeper lanes, a fatter progress bar).
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
import { ChevronsLeft, Pause, Play, Plus, ZoomIn, ZoomOut } from "@lucide/vue";
import { HkIconButton, HkTooltip } from "@celestia-island/hikari";
import { i18n, t as i18nT } from "@/i18n";
import type { TacticalStep } from "./types";
import type { ShipAction } from "./actions";
import type { PlanTrack } from "./plan";
import {
  assignRows,
  clampWindow,
  fmtClock,
  fullWindow,
  layoutMarkers,
  layoutPlanRows,
  planBandHeight,
  rulerTicks,
  zoomWindow,
  type TimeWindow,
} from "./timelineModel";
import {
  drawPlane,
  drawPlanKeyframe,
  drawPlanTicks,
  drawPlanTween,
  drawShell,
  drawStepFlag,
  drawTorpedo,
  drawUserPin,
  drawUserShip,
  drawWaveDown,
  drawWaveStop,
  drawWaveUp,
  ICON_PX,
  PLAN_TRACK_COLORS,
  TL_COLORS,
} from "./timelineIcons";
import "./Timeline.scss";

/** A user-authored marker on the timeline (virtual ship / pinned path). */
export interface TimelineUserMarker {
  id: string;
  /** Battle seconds the marker appears at (element t0). */
  t0: number;
  color: string;
  label: string;
  kind: "marker" | "path";
  /** Standalone boards place solid markers; over a replay they are hollow. */
  solid: boolean;
}

const RULER_H = 20;
const LANES_H = 78;
/** Plan-board bands: room for accordion rows and a real progress bar. The
 *  lanes grow with the plan (one row per unit) up to the tall cap. */
const LANES_H_TALL = 172;
const LANES_H_TALL_MAX = 320;
const OVERVIEW_H = 18;
const OVERVIEW_H_TALL = 30;
const PAD = 4;
const MAX_ROWS = 6;
/** Above this many visible markers, icons give way to a density histogram. */
const DENSITY_LIMIT = 420;
/** Width of a track's clickable label chip (collapse toggle). */
const TRACK_CHIP_W = 108;

type Hit =
  | { kind: "user"; id: string; x: number; y: number; lines: string[] }
  | { kind: "step"; id: string; index: number; x: number; y: number; lines: string[] }
  | { kind: "action"; x: number; y: number; lines: string[]; time: number }
  | { kind: "track"; key: string; x: number; y: number; lines: string[] };

interface RowGeometry {
  track: PlanTrack;
  top: number;
  headerH: number;
  bodyH: number;
  collapsed: boolean;
}

export default defineComponent({
  name: "TacticalTimeline",
  props: {
    getTime: { type: Function as PropType<() => number>, required: true },
    getDuration: { type: Function as PropType<() => number>, required: true },
    getPlaying: { type: Function as PropType<() => boolean>, required: true },
    play: { type: Function as PropType<() => void>, required: true },
    pause: { type: Function as PropType<() => void>, required: true },
    seekTo: { type: Function as PropType<(t: number) => void>, required: true },
    actions: { type: Array as PropType<ShipAction[]>, required: true },
    labelOf: { type: Function as PropType<(entityId: number) => string>, required: true },
    steps: { type: Array as PropType<TacticalStep[]>, required: true },
    currentStepIndex: { type: Number, default: -1 },
    userMarkers: { type: Array as PropType<TimelineUserMarker[]>, required: true },
    /** Plan-board unit rows; non-empty switches the lanes band to accordion
     *  tracks (replay-action icons stay out of that band). */
    tracks: { type: Array as PropType<PlanTrack[]>, default: () => [] },
    /** Plan-board proportions: deeper lanes + a fatter progress bar. */
    tall: { type: Boolean, default: false },
    presentMode: { type: Boolean, default: false },
    addStep: { type: Function as PropType<() => void>, required: true },
    stepPrev: { type: Function as PropType<() => void>, required: true },
    stepNext: { type: Function as PropType<() => void>, required: true },
    togglePresent: { type: Function as PropType<() => void>, required: true },
    goToStep: { type: Function as PropType<(i: number) => void>, required: true },
    removeStep: { type: Function as PropType<(id: string) => void>, required: true },
    removeUserMarker: { type: Function as PropType<(id: string) => void>, required: true },
    /** Double-click a plan unit's header chip → inline rename. Absent on
     *  hosts that don't own the document (read-only timelines). */
    onRenameUnit: {
      type: Function as PropType<(track: PlanTrack, name: string) => void>,
      default: undefined,
    },
  },
  setup(props) {
    const wrapRef = ref<HTMLDivElement | null>(null);
    const canvasRef = ref<HTMLCanvasElement | null>(null);
    const width = ref(600);
    const win = ref<TimeWindow>(fullWindow(props.getDuration()));
    const tooltip = ref<Hit | null>(null);
    /** Collapsed accordion rows, by track key (survives doc edits). */
    const collapsed = ref<ReadonlySet<string>>(new Set<string>());

    // Re-fit when a new battle (different duration) mounts.
    watch(
      () => props.getDuration(),
      (d) => {
        win.value = fullWindow(d);
      },
    );

    const duration = computed(() => Math.max(0.001, props.getDuration()));
    /** Expanded (visible-body) unit count, for the band sizing below. */
    const expandedUnits = computed(
      () => props.tracks.filter((t) => !collapsed.value.has(t.key)).length,
    );
    const lanesH = computed(() =>
      props.tall
        ? planBandHeight(props.tracks.length, expandedUnits.value, LANES_H_TALL, LANES_H_TALL_MAX)
        : LANES_H,
    );
    const overviewH = computed(() => (props.tall ? OVERVIEW_H_TALL : OVERVIEW_H));
    const canvasH = computed(() => RULER_H + lanesH.value + overviewH.value + PAD);
    const overviewTop = computed(() => RULER_H + lanesH.value + PAD / 2);
    const planMode = computed(() => props.tracks.length > 0);
    /** Accordion rows: position + height of every unit, in track order. */
    const rows = computed(() =>
      layoutPlanRows(
        props.tracks.map((t) => t.key),
        collapsed.value,
        lanesH.value,
      ),
    );
    const timeToX = (t: number): number =>
      ((t - win.value.start) / Math.max(1e-6, win.value.end - win.value.start)) * width.value;
    const xToTime = (x: number): number =>
      win.value.start + (x / Math.max(1, width.value)) * (win.value.end - win.value.start);

    const laidActions = computed(() =>
      layoutMarkers(props.actions, win.value.start, win.value.end, width.value, ICON_PX, MAX_ROWS),
    );
    const laidUsers = computed(() => {
      const laid = assignRows(
        props.userMarkers.map((m) => m.t0),
        win.value.start,
        win.value.end,
        width.value,
        ICON_PX,
        MAX_ROWS,
      );
      return props.userMarkers
        .map((m, i) => ({ marker: m, x: laid[i].x, row: laid[i].row }))
        .filter((um) => um.marker.t0 >= win.value.start && um.marker.t0 <= win.value.end);
    });
    const dense = computed(() => !planMode.value && laidActions.value.length > DENSITY_LIMIT);

    /** Row band geometry (header on top, keyframe body below it); null for a
     *  row the band had no room for. */
    function rowGeometry(index: number): RowGeometry | null {
      const row = rows.value[index];
      const track = props.tracks[index];
      if (!row || !track || row.hidden) return null;
      return {
        track,
        top: RULER_H + row.top,
        headerH: row.headerH,
        bodyH: row.bodyH,
        collapsed: row.collapsed,
      };
    }
    /** Units the band could not host at all (drawn as a "+N" count). */
    const hiddenUnits = computed(() => rows.value.filter((r) => r.hidden).length);
    /** Y a track's keyframes and tween arrows sit on (header centre when the
     *  row is collapsed and has no body). */
    function rowCenterY(geo: RowGeometry): number {
      return geo.collapsed ? geo.top + geo.headerH / 2 : geo.top + geo.headerH + geo.bodyH / 2;
    }
    function kindLabel(kind: PlanTrack["actions"][number]["kind"]): string {
      return i18nT(`replay.tactical.plan.act.${kind}`);
    }
    /** Unit name shown on the row: the authored label, else "Unit N" counted
     *  over the unlabelled units in row order. */
    function displayLabel(index: number): string {
      const track = props.tracks[index];
      if (!track) return "";
      if (track.label) return track.label;
      let n = 0;
      for (let i = 0; i <= index; i++) {
        if (!props.tracks[i]?.label) n++;
      }
      return i18nT("replay.tactical.plan.unitN", { n });
    }
    function toggleRow(key: string): void {
      const next = new Set(collapsed.value);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      collapsed.value = next;
    }

    function actionLines(a: ShipAction): string[] {
      const label = props.labelOf(a.entityId);
      const kind = i18nT(`replay.tactical.timeline.act.${a.kind}`);
      const detail =
        a.kind === "shell"
          ? a.ammo ?? ""
          : a.kind === "planeDrop"
            ? `${a.dropKind === "torpedo" ? "" : a.ammo ?? ""}`
            : a.planeRole ?? "";
      return [label || "—", detail ? `${kind} · ${detail}` : kind, `T+${fmtClock(a.time)}`];
    }

    // ── Painting ─────────────────────────────────────────────────────────
    let raf = 0;
    let lastKey = "";
    // Data swaps (replay reload, doc import) invalidate the repaint key even
    // when lengths/playhead are unchanged.
    watch(
      [() => props.actions, () => props.steps, () => props.userMarkers, () => props.tracks],
      () => {
        lastKey = "";
      },
    );
    function frame(): void {
      raf = requestAnimationFrame(frame);
      const t = props.getTime();
      // The locale belongs in the key: canvas strings (unit labels, action
      // counts) are painted outside any reactive effect, so a language switch
      // would otherwise keep the old wording until the next scrub.
      const key = `${t.toFixed(2)}|${win.value.start.toFixed(2)}|${win.value.end.toFixed(2)}|${width.value}|${laidActions.value.length}|${props.steps.length}|${props.userMarkers.length}|${props.tracks.length}|${collapsed.value.size}|${lanesH.value}|${props.currentStepIndex}|${props.getPlaying()}|${i18n.global.locale.value}`;
      if (key === lastKey) return;
      lastKey = key;
      draw();
    }

    function draw(): void {
      const cvs = canvasRef.value;
      if (!cvs) return;
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const px = Math.round(width.value * dpr);
      if (cvs.width !== px || cvs.height !== Math.round(canvasH.value * dpr)) {
        cvs.width = px;
        cvs.height = Math.round(canvasH.value * dpr);
      }
      const ctx = cvs.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width.value, canvasH.value);
      const W = width.value;

      // Ruler band.
      const ticks = rulerTicks(win.value.start, win.value.end, W, 64, fmtClock);
      ctx.strokeStyle = "rgba(148, 163, 184, 0.4)";
      ctx.fillStyle = "rgba(203, 213, 225, 0.75)";
      ctx.lineWidth = 1;
      ctx.font = "500 9px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.beginPath();
      ctx.moveTo(0, RULER_H - 0.5);
      ctx.lineTo(W, RULER_H - 0.5);
      ctx.stroke();
      for (const tick of ticks) {
        const x = Math.round(timeToX(tick.t)) + 0.5;
        if (x < -1 || x > W + 1) continue;
        ctx.beginPath();
        ctx.moveTo(x, tick.major ? RULER_H - 9 : RULER_H - 5);
        ctx.lineTo(x, RULER_H - 1);
        ctx.stroke();
        if (tick.major && x > 14 && x < W - 14) ctx.fillText(tick.label, x, 1);
      }
      // Step pennants on the ruler.
      props.steps.forEach((s, i) => {
        drawStepFlag(ctx, timeToX(s.t), RULER_H - 3, i === props.currentStepIndex);
      });

      // Lanes band.
      const lanesTop = RULER_H;
      const rowY = (row: number): number =>
        lanesTop + 10 + row * ((lanesH.value - 20) / Math.max(1, MAX_ROWS - 1));
      if (planMode.value) {
        for (let i = 0; i < props.tracks.length; i++) drawTrack(ctx, W, i);
        if (hiddenUnits.value > 0) {
          // Rows the band could not host: said out loud instead of clipped
          // (and never hit-tested — rowGeometry returns null for them).
          const label = i18nT("replay.tactical.plan.hiddenUnits", { n: hiddenUnits.value });
          ctx.font = "600 9px ui-sans-serif, system-ui, sans-serif";
          const tw = ctx.measureText(label).width;
          const bx = W - tw - 12;
          const by = RULER_H + lanesH.value - 16;
          ctx.fillStyle = "rgba(5, 8, 15, 0.78)";
          ctx.beginPath();
          ctx.roundRect(bx, by, tw + 8, 14, 7);
          ctx.fill();
          ctx.fillStyle = PLAN_TRACK_COLORS.headerText;
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(label, bx + 4, by + 7.5);
        }
      } else if (dense.value) {
        const buckets = Math.max(1, Math.floor(W / 3));
        const counts = new Array<number>(buckets).fill(0);
        for (const lm of laidActions.value) {
          counts[Math.min(buckets - 1, Math.max(0, Math.floor(lm.x / 3)))]++;
        }
        const max = Math.max(...counts, 1);
        ctx.fillStyle = "rgba(0, 195, 255, 0.5)";
        for (let b = 0; b < buckets; b++) {
          if (!counts[b]) continue;
          const h = Math.max(2, (counts[b] / max) * (lanesH.value - 8));
          ctx.fillRect(b * 3, lanesTop + (lanesH.value - h) / 2, 2, h);
        }
      } else {
        for (const lm of laidActions.value) drawAction(ctx, lm.action, lm.x, rowY(lm.row));
      }
      // User markers always render as icons — even in density mode they are
      // few, and they are the author's own edits (right-click to remove).
      for (const um of laidUsers.value) {
        const m = um.marker;
        if (m.kind === "path") drawUserPin(ctx, um.x, rowY(um.row), m.color);
        else drawUserShip(ctx, um.x, rowY(um.row), m.color, m.solid);
      }

      drawOverview(ctx, W);

      // Playhead across everything.
      const handX = timeToX(props.getTime());
      ctx.strokeStyle = TL_COLORS.accent;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(handX, 2);
      ctx.lineTo(handX, RULER_H + lanesH.value);
      ctx.stroke();
      ctx.fillStyle = TL_COLORS.accent;
      ctx.beginPath();
      ctx.moveTo(handX - 4, 0);
      ctx.lineTo(handX + 4, 0);
      ctx.lineTo(handX, 7);
      ctx.closePath();
      ctx.fill();
    }

    /** Overview strip: the played-progress fill, marker density, and the
     *  viewport window (the stretchy part of the bar). */
    function drawOverview(ctx: CanvasRenderingContext2D, W: number): void {
      const ovY = overviewTop.value;
      const ovH = overviewH.value;
      ctx.fillStyle = "rgba(148, 163, 184, 0.14)";
      ctx.beginPath();
      ctx.roundRect(0, ovY, W, ovH, 4);
      ctx.fill();
      const dur = duration.value;
      const buckets = Math.max(1, Math.floor(W / 2));
      const counts = new Array<number>(buckets).fill(0);
      const bump = (t: number): void => {
        const b = Math.floor((t / Math.max(1e-6, dur)) * buckets);
        if (b >= 0 && b < buckets) counts[b]++;
      };
      for (const a of props.actions) bump(a.time);
      for (const m of props.userMarkers) bump(m.t0);
      for (const track of props.tracks) for (const a of track.actions) bump(a.t);
      const max = Math.max(...counts, 1);
      // Played progress under the density: on the PLAN board the strip is the
      // progress bar itself, so it reads as a real one. (The replay strip
      // keeps its master look.)
      if (props.tall) {
        const playedX = (props.getTime() / Math.max(1e-6, dur)) * W;
        ctx.fillStyle = "rgba(0, 195, 255, 0.18)";
        ctx.beginPath();
        ctx.roundRect(0, ovY, Math.max(0, playedX), ovH, 4);
        ctx.fill();
      }
      ctx.fillStyle = "rgba(148, 163, 184, 0.4)";
      for (let b = 0; b < buckets; b++) {
        if (!counts[b]) continue;
        const h = Math.max(1, (counts[b] / max) * (ovH - 4));
        ctx.fillRect(b * 2, ovY + (ovH - h) / 2, 1.4, h);
      }
      const wx0 = (win.value.start / dur) * W;
      const wx1 = (win.value.end / dur) * W;
      ctx.fillStyle = "rgba(0, 195, 255, 0.16)";
      ctx.strokeStyle = "rgba(0, 195, 255, 0.85)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(wx0 + 0.5, ovY + 0.5, Math.max(10, wx1 - wx0) - 1, ovH - 1, 4);
      ctx.fill();
      ctx.stroke();
    }

    /** One accordion row: header (caret + unit chip + action count), then —
     *  unless collapsed — the unit's tween arrows and keyframes. */
    function drawTrack(ctx: CanvasRenderingContext2D, W: number, index: number): void {
      const geo = rowGeometry(index);
      if (!geo) return;
      const { track, top, headerH, bodyH, collapsed: isCollapsed } = geo;
      const cy = top + headerH / 2;
      ctx.save();
      ctx.fillStyle = PLAN_TRACK_COLORS.headerBg;
      ctx.beginPath();
      ctx.roundRect(2, top + 1, Math.max(0, W - 4), Math.max(0, headerH - 2), 3);
      ctx.fill();
      // Caret mark (the collapse toggle sits at the row's left edge).
      ctx.fillStyle = PLAN_TRACK_COLORS.headerText;
      ctx.beginPath();
      if (isCollapsed) {
        ctx.moveTo(8, cy - 3.2);
        ctx.lineTo(13, cy);
        ctx.lineTo(8, cy + 3.2);
      } else {
        ctx.moveTo(6.4, cy - 2);
        ctx.lineTo(11.4, cy - 2);
        ctx.lineTo(8.9, cy + 2.4);
      }
      ctx.closePath();
      ctx.fill();
      // Unit chip.
      ctx.fillStyle = track.color;
      ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(displayLabel(index), 18, cy, TRACK_CHIP_W - 24);
      ctx.fillStyle = PLAN_TRACK_COLORS.headerText;
      ctx.font = "500 9px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(
        i18nT("replay.tactical.plan.actionCount", { n: track.actions.length }),
        TRACK_CHIP_W,
        cy,
      );
      ctx.restore();

      if (isCollapsed) {
        // Collapsed: fold the row's shape into its header as ticks.
        drawPlanTicks(
          ctx,
          track.actions.map((a) => timeToX(a.t)),
          top + headerH - 3.5,
          track.color,
        );
        return;
      }
      const bodyY = top + headerH + bodyH / 2;
      const t = props.getTime();
      // Connectors first: a dotted hairline where the unit JUMPS (two marks
      // with no leg between them — the author left out the travel), then the
      // tween arrows, then the keyframes on top of both.
      for (const a of track.actions) {
        if (a.nextT == null || a.tweenEndT != null) continue;
        const x0 = timeToX(a.t);
        const x1 = timeToX(a.nextT);
        if (x1 < -20 || x0 > W + 20) continue;
        ctx.save();
        ctx.strokeStyle = track.color;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(x0, bodyY);
        ctx.lineTo(x1, bodyY);
        ctx.stroke();
        ctx.restore();
      }
      // Tween arrows.
      for (const a of track.actions) {
        if (a.tweenEndT == null) continue;
        const x0 = timeToX(a.t);
        const x1 = timeToX(a.tweenEndT);
        if (x1 < -20 || x0 > W + 20) continue;
        const head = t >= a.t && t <= a.tweenEndT ? timeToX(t) : null;
        drawPlanTween(ctx, x0, x1, bodyY, track.color, head);
      }
      for (const a of track.actions) {
        const x = timeToX(a.t);
        if (x < -8 || x > W + 8) continue;
        drawPlanKeyframe(ctx, x, bodyY, track.color, a.kind);
      }
    }

    function drawAction(ctx: CanvasRenderingContext2D, a: ShipAction, x: number, y: number): void {
      switch (a.kind) {
        case "speedUp":
          drawWaveUp(ctx, x, y);
          break;
        case "speedDown":
          drawWaveDown(ctx, x, y);
          break;
        case "stop":
          drawWaveStop(ctx, x, y);
          break;
        case "shell":
          drawShell(ctx, x, y, a.ammo ?? "unknown");
          break;
        case "torpedo":
          drawTorpedo(ctx, x, y);
          break;
        case "planeTakeoff":
          drawPlane(ctx, x, y, { attack: false, role: a.planeRole });
          break;
        case "planeDrop":
          drawPlane(ctx, x, y, { attack: true, role: a.planeRole, dropKind: a.dropKind, ammo: a.ammo });
          break;
      }
    }

    // ── Hit testing (hover tooltip / right-click delete) ─────────────────
    function hitAt(mx: number, my: number): Hit | null {
      const rowY = (row: number): number =>
        RULER_H + 10 + row * ((lanesH.value - 20) / Math.max(1, MAX_ROWS - 1));
      // User markers and step flags stay hit-testable in every mode — the
      // density histogram only condenses the replay-action icons.
      let best: Hit | null = null;
      let bestD = 9;
      for (const um of laidUsers.value) {
        const d = Math.hypot(um.x - mx, rowY(um.row) - my);
        if (d < bestD) {
          const m = um.marker;
          bestD = d;
          best = {
            kind: "user",
            id: m.id,
            x: um.x,
            y: rowY(um.row),
            lines: [
              m.label || i18nT(m.kind === "path" ? "replay.tactical.timeline.act.path" : "replay.tactical.timeline.act.marker"),
              `T+${fmtClock(m.t0)}`,
            ],
          };
        }
      }
      if (best) return best;
      // Plan tracks: keyframes first, then the tween spans under them.
      for (let i = 0; i < props.tracks.length; i++) {
        const geo = rowGeometry(i);
        if (!geo) continue;
        const cy = rowCenterY(geo);
        const name = displayLabel(i);
        for (const a of geo.track.actions) {
          const x = timeToX(a.t);
          if (a.t >= win.value.start - 1 && a.t <= win.value.end + 1 && Math.hypot(x - mx, cy - my) < 8) {
            return {
              kind: "user",
              id: a.id,
              x,
              y: cy,
              lines: [name, kindLabel(a.kind), `T+${fmtClock(a.t)}`],
            };
          }
        }
        for (const a of geo.track.actions) {
          if (a.tweenEndT == null) continue;
          const x0 = Math.min(timeToX(a.t), timeToX(a.tweenEndT));
          const x1 = Math.max(timeToX(a.t), timeToX(a.tweenEndT));
          if (mx >= x0 - 2 && mx <= x1 + 2 && Math.abs(my - cy) <= 5) {
            return {
              kind: "user",
              id: a.id,
              x: mx,
              y: cy,
              lines: [
                name,
                `${i18nT("replay.tactical.plan.tween")} · ${kindLabel(a.kind)}`,
                `T+${fmtClock(a.t)} → T+${fmtClock(a.tweenEndT)}`,
              ],
            };
          }
        }
      }
      if (!dense.value && !planMode.value) {
        for (const lm of laidActions.value) {
          const d = Math.hypot(lm.x - mx, rowY(lm.row) - my);
          if (d < bestD) {
            bestD = d;
            best = { kind: "action", x: lm.x, y: rowY(lm.row), lines: actionLines(lm.action), time: lm.action.time };
          }
        }
        if (best) return best;
      }
      // Step flags on the ruler.
      let bestStep: Hit | null = null;
      let bestD2 = 8;
      props.steps.forEach((s, i) => {
        const d = Math.hypot(timeToX(s.t) - mx, RULER_H - 3 - my);
        if (d < bestD2) {
          bestD2 = d;
          bestStep = {
            kind: "step",
            id: s.id,
            index: i,
            x: timeToX(s.t),
            y: RULER_H - 3,
            lines: [`${i18nT("replay.tactical.timeline.step")} ${s.name}`, `T+${fmtClock(s.t)}`],
          };
        }
      });
      if (bestStep) return bestStep;
      // Track header chips last — they span the row's left edge.
      const key = trackHeaderKeyAt(mx, my);
      if (key != null) {
        const index = props.tracks.findIndex((t) => t.key === key);
        const geo = rowGeometry(index);
        if (geo) {
          return {
            kind: "track",
            key,
            x: mx,
            y: geo.top + geo.headerH / 2,
            lines: [
              displayLabel(index),
              i18nT("replay.tactical.plan.actionCount", { n: geo.track.actions.length }),
              i18nT(
                geo.collapsed ? "replay.tactical.plan.expand" : "replay.tactical.plan.collapse",
              ),
            ],
          };
        }
      }
      return null;
    }

    /** Track header chip under the pointer (click = collapse/expand). */
    function trackHeaderKeyAt(mx: number, my: number): string | null {
      for (let i = 0; i < props.tracks.length; i++) {
        const geo = rowGeometry(i);
        if (!geo) continue;
        if (my >= geo.top && my <= geo.top + geo.headerH && mx <= TRACK_CHIP_W) {
          return geo.track.key;
        }
      }
      return null;
    }

    function localXY(e: MouseEvent): { x: number; y: number } {
      const rect = canvasRef.value!.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    // ── Pointer interaction ──────────────────────────────────────────────
    type DragKind =
      | { kind: "scrub" }
      | { kind: "ovMove"; grabX: number; start: number }
      | { kind: "ovLeft" }
      | { kind: "ovRight" };
    let drag: DragKind | null = null;

    function onPointerDown(e: PointerEvent): void {
      e.stopPropagation();
      if (e.button === 2) return;
      const { x, y } = localXY(e);
      const ovY = overviewTop.value;
      const dur = duration.value;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      if (y >= ovY && y <= ovY + overviewH.value) {
        const wx0 = (win.value.start / dur) * width.value;
        const wx1 = (win.value.end / dur) * width.value;
        if (Math.abs(x - wx0) <= 5) drag = { kind: "ovLeft" };
        else if (Math.abs(x - wx1) <= 5) drag = { kind: "ovRight" };
        else if (x > wx0 && x < wx1) drag = { kind: "ovMove", grabX: x - wx0, start: win.value.start };
        else {
          // Jump: centre the window at the clicked battle time.
          const span = win.value.end - win.value.start;
          const centre = (x / width.value) * dur;
          win.value = clampWindow({ start: centre - span / 2, end: centre + span / 2 }, dur);
          drag = { kind: "ovMove", grabX: Math.min(Math.max(10, (x - wx0)), Math.max(10, wx1 - wx0)), start: win.value.start };
        }
        return;
      }
      // Accordion header chip → collapse/expand, never a scrub.
      const headerKey = trackHeaderKeyAt(x, y);
      if (headerKey != null) {
        toggleRow(headerKey);
        drag = null;
        return;
      }
      // Step flag click → step navigation; anything else scrubs.
      const hit = hitAt(x, y);
      if (hit?.kind === "step") {
        props.goToStep(hit.index);
        drag = null;
        return;
      }
      drag = { kind: "scrub" };
      props.seekTo(xToTime(x));
    }

    function onPointerMove(e: PointerEvent): void {
      const { x, y } = localXY(e);
      if (!drag) {
        tooltip.value = hitAt(x, y);
        return;
      }
      e.stopPropagation();
      const dur = duration.value;
      if (drag.kind === "scrub") {
        props.seekTo(xToTime(x));
        return;
      }
      const span = win.value.end - win.value.start;
      if (drag.kind === "ovMove") {
        const anchor = (x - drag.grabX) / width.value * dur;
        win.value = clampWindow({ start: anchor, end: anchor + span }, dur);
      } else if (drag.kind === "ovLeft") {
        const end = win.value.end;
        const start = (x / width.value) * dur;
        win.value = clampWindow({ start, end }, dur);
      } else {
        const start = win.value.start;
        const end = (x / width.value) * dur;
        win.value = clampWindow({ start, end }, dur);
      }
      tooltip.value = null;
    }

    function onPointerUp(e: PointerEvent): void {
      e.stopPropagation();
      drag = null;
    }

    function onWheel(e: WheelEvent): void {
      e.stopPropagation();
      e.preventDefault();
      const { x } = localXY(e);
      const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
      win.value = zoomWindow(win.value, duration.value, factor, xToTime(x));
    }

    function onContextmenu(e: MouseEvent): void {
      e.stopPropagation();
      e.preventDefault();
      const { x, y } = localXY(e);
      const hit = hitAt(x, y);
      if (hit?.kind === "user") props.removeUserMarker(hit.id);
      else if (hit?.kind === "step") props.removeStep(hit.id);
      tooltip.value = null;
    }

    // ── Inline unit rename (double-click a plan row's header chip) ──────
    const renameEdit = ref<{ key: string; value: string; top: number } | null>(null);
    const renameInput = ref<HTMLInputElement | null>(null);

    function onDblClick(e: MouseEvent): void {
      e.stopPropagation();
      if (!props.onRenameUnit) return;
      const { x, y } = localXY(e);
      const key = trackHeaderKeyAt(x, y);
      if (key == null) return;
      const geo = rowGeometry(props.tracks.findIndex((t) => t.key === key));
      if (!geo) return;
      renameEdit.value = { key, value: geo.track.label, top: geo.top };
      requestAnimationFrame(() => renameInput.value?.focus());
    }
    function commitRename(): void {
      const ed = renameEdit.value;
      renameEdit.value = null;
      if (!ed || !props.onRenameUnit) return;
      const track = props.tracks.find((t) => t.key === ed.key);
      if (track) props.onRenameUnit(track, ed.value);
    }
    function onRenameKeydown(e: KeyboardEvent): void {
      e.stopPropagation();
      if (e.key === "Enter") commitRename();
      else if (e.key === "Escape") renameEdit.value = null;
    }

    function zoomStep(factor: number): void {
      win.value = zoomWindow(win.value, duration.value, factor, props.getTime());
    }
    function zoomFit(): void {
      win.value = fullWindow(duration.value);
    }

    let ro: ResizeObserver | null = null;
    onMounted(() => {
      ro = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width ?? 0;
        if (w > 0) width.value = w;
      });
      if (wrapRef.value) ro.observe(wrapRef.value);
      raf = requestAnimationFrame(frame);
    });
    onBeforeUnmount(() => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    });

    const tooltipStyle = computed(() => {
      const hit = tooltip.value;
      if (!hit) return null;
      const flip = hit.x > width.value - 130;
      return {
        left: `${flip ? hit.x - 8 : hit.x + 8}px`,
        top: `${hit.y + 10}px`,
        transform: flip ? "translateX(-100%)" : undefined,
      };
    });

    return () => (
      <div class="tac-timeline" onClick={(e: MouseEvent) => e.stopPropagation()}>
        <div class="tac-timeline__head">
          <div class="tac-timeline__transport">
            <HkTooltip text={i18nT("replay.tactical.steps.prev")} placement="top">
              <HkIconButton size={24} onClick={() => props.stepPrev()}>
                <ChevronsLeft size={13} />
              </HkIconButton>
            </HkTooltip>
            <HkTooltip text={i18nT("replay.tactical.steps.add")} placement="top">
              <HkIconButton size={24} variant="primary" onClick={() => props.addStep()}>
                <Plus size={13} />
              </HkIconButton>
            </HkTooltip>
            <HkTooltip
              text={i18nT(props.presentMode ? "replay.tactical.steps.presentStop" : "replay.tactical.steps.present")}
              placement="top"
            >
              <HkIconButton size={24} variant={props.presentMode ? "danger" : "ghost"} onClick={() => props.togglePresent()}>
                {props.presentMode ? <Pause size={13} /> : <Play size={13} />}
              </HkIconButton>
            </HkTooltip>
            <HkTooltip text={i18nT("replay.tactical.steps.next")} placement="top">
              <HkIconButton size={24} onClick={() => props.stepNext()}>
                <ChevronsLeft size={13} style={{ transform: "scaleX(-1)" }} />
              </HkIconButton>
            </HkTooltip>
          </div>
          <span class="tac-timeline__clock">
            T+{fmtClock(props.getTime())} / {fmtClock(duration.value)}
          </span>
          <div class="tac-timeline__zoom">
            <HkTooltip text={i18nT("replay.tactical.timeline.zoomOut")} placement="top">
              <HkIconButton size={24} onClick={() => zoomStep(1 / 1.6)}>
                <ZoomOut size={13} />
              </HkIconButton>
            </HkTooltip>
            <HkTooltip text={i18nT("replay.tactical.timeline.zoomIn")} placement="top">
              <HkIconButton size={24} onClick={() => zoomStep(1.6)}>
                <ZoomIn size={13} />
              </HkIconButton>
            </HkTooltip>
            <button
              class="tac-timeline__fit"
              title={i18nT("replay.tactical.timeline.zoomFit")}
              onClick={zoomFit}
            >
              {i18nT("replay.tactical.timeline.fit")}
            </button>
          </div>
        </div>
        <div ref={wrapRef} class="tac-timeline__wrap">
          <canvas
            ref={canvasRef}
            class="tac-timeline__canvas"
            style={{ height: `${canvasH.value}px` }}
            onPointerdown={onPointerDown}
            onPointermove={onPointerMove}
            onPointerup={onPointerUp}
            onPointercancel={onPointerUp}
            onWheel={onWheel}
            onContextmenu={onContextmenu}
            onDblclick={onDblClick}
            onPointerleave={() => {
              tooltip.value = null;
            }}
          />
          {renameEdit.value ? (
            <input
              ref={renameInput}
              class="tac-timeline__rename"
              style={{ top: `${renameEdit.value.top}px` }}
              value={renameEdit.value.value}
              title={i18nT("replay.tactical.plan.rename")}
              onInput={(e: Event) => {
                if (renameEdit.value) renameEdit.value.value = (e.target as HTMLInputElement).value;
              }}
              onKeydown={onRenameKeydown}
              onBlur={commitRename}
              onClick={(e: MouseEvent) => e.stopPropagation()}
            />
          ) : null}
          {tooltip.value && tooltipStyle.value ? (
            <div class="tac-timeline__tip" style={tooltipStyle.value}>
              {tooltip.value.lines.map((line, i) => (
                <span key={i} class={i === 0 ? "tac-timeline__tip-name" : undefined}>
                  {line}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  },
});
