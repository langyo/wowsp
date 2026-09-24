/**
 * Editor-style timeline docked above the tactical toolbar: an adaptive time
 * ruler with step pennants, ship-action markers laid out in collision rows
 * (density histogram when zoomed too far out), a draggable playhead, and a
 * bottom overview strip — the stretchy scrollbar that scales the horizontal
 * view (zoom floor: one screen shows at least 15 s of battle). User-placed
 * markers (virtual ships, pinned paths) render alongside replay actions;
 * right-click deletes them.
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
import { HIconButton, HTooltip } from "@celestia-island/hikari";
import { t as i18nT } from "@/i18n";
import type { TacticalStep } from "./types";
import type { ShipAction } from "./actions";
import {
  assignRows,
  clampWindow,
  fmtClock,
  fullWindow,
  layoutMarkers,
  rulerTicks,
  zoomWindow,
  type TimeWindow,
} from "./timelineModel";
import {
  drawPlane,
  drawShell,
  drawStepFlag,
  drawTorpedo,
  drawUserPin,
  drawUserShip,
  drawWaveDown,
  drawWaveStop,
  drawWaveUp,
  ICON_PX,
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
const OVERVIEW_H = 18;
const PAD = 4;
const CANVAS_H = RULER_H + LANES_H + OVERVIEW_H + PAD;
const MAX_ROWS = 6;
/** Above this many visible markers, icons give way to a density histogram. */
const DENSITY_LIMIT = 420;

type Hit =
  | { kind: "user"; id: string; x: number; y: number; lines: string[] }
  | { kind: "step"; id: string; index: number; x: number; y: number; lines: string[] }
  | { kind: "action"; x: number; y: number; lines: string[]; time: number };

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
    presentMode: { type: Boolean, default: false },
    addStep: { type: Function as PropType<() => void>, required: true },
    stepPrev: { type: Function as PropType<() => void>, required: true },
    stepNext: { type: Function as PropType<() => void>, required: true },
    togglePresent: { type: Function as PropType<() => void>, required: true },
    goToStep: { type: Function as PropType<(i: number) => void>, required: true },
    removeStep: { type: Function as PropType<(id: string) => void>, required: true },
    removeUserMarker: { type: Function as PropType<(id: string) => void>, required: true },
  },
  setup(props) {
    const wrapRef = ref<HTMLDivElement | null>(null);
    const canvasRef = ref<HTMLCanvasElement | null>(null);
    const width = ref(600);
    const win = ref<TimeWindow>(fullWindow(props.getDuration()));
    const tooltip = ref<Hit | null>(null);

    // Re-fit when a new battle (different duration) mounts.
    watch(
      () => props.getDuration(),
      (d) => {
        win.value = fullWindow(d);
      },
    );

    const duration = computed(() => Math.max(0.001, props.getDuration()));
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
    const dense = computed(() => laidActions.value.length > DENSITY_LIMIT);

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
    watch([() => props.actions, () => props.steps, () => props.userMarkers], () => {
      lastKey = "";
    });
    function frame(): void {
      raf = requestAnimationFrame(frame);
      const t = props.getTime();
      const key = `${t.toFixed(2)}|${win.value.start.toFixed(2)}|${win.value.end.toFixed(2)}|${width.value}|${laidActions.value.length}|${props.steps.length}|${props.userMarkers.length}|${props.currentStepIndex}|${props.getPlaying()}`;
      if (key === lastKey) return;
      lastKey = key;
      draw();
    }

    function draw(): void {
      const cvs = canvasRef.value;
      if (!cvs) return;
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const px = Math.round(width.value * dpr);
      if (cvs.width !== px) {
        cvs.width = px;
        cvs.height = Math.round(CANVAS_H * dpr);
      }
      const ctx = cvs.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width.value, CANVAS_H);
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
        lanesTop + 10 + row * ((LANES_H - 20) / Math.max(1, MAX_ROWS - 1));
      if (dense.value) {
        const buckets = Math.max(1, Math.floor(W / 3));
        const counts = new Array<number>(buckets).fill(0);
        for (const lm of laidActions.value) {
          counts[Math.min(buckets - 1, Math.max(0, Math.floor(lm.x / 3)))]++;
        }
        const max = Math.max(...counts, 1);
        ctx.fillStyle = "rgba(0, 195, 255, 0.5)";
        for (let b = 0; b < buckets; b++) {
          if (!counts[b]) continue;
          const h = Math.max(2, (counts[b] / max) * (LANES_H - 8));
          ctx.fillRect(b * 3, lanesTop + (LANES_H - h) / 2, 2, h);
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

      // Overview strip: full battle + viewport window + density.
      const ovY = RULER_H + LANES_H + PAD / 2;
      ctx.fillStyle = "rgba(148, 163, 184, 0.14)";
      ctx.beginPath();
      ctx.roundRect(0, ovY, W, OVERVIEW_H, 4);
      ctx.fill();
      const dur = duration.value;
      const buckets = Math.max(1, Math.floor(W / 2));
      const counts = new Array<number>(buckets).fill(0);
      for (const a of props.actions) {
        const b = Math.floor((a.time / Math.max(1e-6, dur)) * buckets);
        if (b >= 0 && b < buckets) counts[b]++;
      }
      const max = Math.max(...counts, 1);
      ctx.fillStyle = "rgba(148, 163, 184, 0.4)";
      for (let b = 0; b < buckets; b++) {
        if (!counts[b]) continue;
        const h = Math.max(1, (counts[b] / max) * (OVERVIEW_H - 4));
        ctx.fillRect(b * 2, ovY + (OVERVIEW_H - h) / 2, 1.4, h);
      }
      const wx0 = (win.value.start / dur) * W;
      const wx1 = (win.value.end / dur) * W;
      ctx.fillStyle = "rgba(0, 195, 255, 0.16)";
      ctx.strokeStyle = "rgba(0, 195, 255, 0.85)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(wx0 + 0.5, ovY + 0.5, Math.max(10, wx1 - wx0) - 1, OVERVIEW_H - 1, 4);
      ctx.fill();
      ctx.stroke();

      // Playhead across everything.
      const px2 = timeToX(props.getTime());
      ctx.strokeStyle = TL_COLORS.accent;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(px2, 2);
      ctx.lineTo(px2, RULER_H + LANES_H);
      ctx.stroke();
      ctx.fillStyle = TL_COLORS.accent;
      ctx.beginPath();
      ctx.moveTo(px2 - 4, 0);
      ctx.lineTo(px2 + 4, 0);
      ctx.lineTo(px2, 7);
      ctx.closePath();
      ctx.fill();
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
        RULER_H + 10 + row * ((LANES_H - 20) / Math.max(1, MAX_ROWS - 1));
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
      if (!dense.value) {
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
      return bestStep;
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
      const ovY = RULER_H + LANES_H + PAD / 2;
      const dur = duration.value;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      if (y >= ovY && y <= ovY + OVERVIEW_H) {
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
            <HTooltip text={i18nT("replay.tactical.steps.prev")} placement="top">
              <HIconButton size={24} onClick={() => props.stepPrev()}>
                <ChevronsLeft size={13} />
              </HIconButton>
            </HTooltip>
            <HTooltip text={i18nT("replay.tactical.steps.add")} placement="top">
              <HIconButton size={24} variant="primary" onClick={() => props.addStep()}>
                <Plus size={13} />
              </HIconButton>
            </HTooltip>
            <HTooltip
              text={i18nT(props.presentMode ? "replay.tactical.steps.presentStop" : "replay.tactical.steps.present")}
              placement="top"
            >
              <HIconButton size={24} variant={props.presentMode ? "danger" : "ghost"} onClick={() => props.togglePresent()}>
                {props.presentMode ? <Pause size={13} /> : <Play size={13} />}
              </HIconButton>
            </HTooltip>
            <HTooltip text={i18nT("replay.tactical.steps.next")} placement="top">
              <HIconButton size={24} onClick={() => props.stepNext()}>
                <ChevronsLeft size={13} style={{ transform: "scaleX(-1)" }} />
              </HIconButton>
            </HTooltip>
          </div>
          <span class="tac-timeline__clock">
            T+{fmtClock(props.getTime())} / {fmtClock(duration.value)}
          </span>
          <div class="tac-timeline__zoom">
            <HTooltip text={i18nT("replay.tactical.timeline.zoomOut")} placement="top">
              <HIconButton size={24} onClick={() => zoomStep(1 / 1.6)}>
                <ZoomOut size={13} />
              </HIconButton>
            </HTooltip>
            <HTooltip text={i18nT("replay.tactical.timeline.zoomIn")} placement="top">
              <HIconButton size={24} onClick={() => zoomStep(1.6)}>
                <ZoomIn size={13} />
              </HIconButton>
            </HTooltip>
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
            onPointerdown={onPointerDown}
            onPointermove={onPointerMove}
            onPointerup={onPointerUp}
            onPointercancel={onPointerUp}
            onWheel={onWheel}
            onContextmenu={onContextmenu}
            onPointerleave={() => {
              tooltip.value = null;
            }}
          />
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
