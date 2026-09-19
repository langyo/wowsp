/**
 * Tactical-board interaction layer over the enlarged 2D map: the annotation
 * canvas (same HiDPI / logical-760 contract as zoomCanvas), pointer tools
 * (pen/shapes/text/markers/path-pin/select), keyboard shortcuts, the
 * region-crop picker and the image/video export runners. Pure drawing lives
 * in render.ts; state lives in useTactical.
 */
import {
  computed,
  defineComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  toRef,
  watch,
  type PropType,
} from "vue";
import { useToast } from "@celestia-island/hikari";
import { t as i18nT } from "@/i18n";
import type { EntityTrajectory } from "@/api/client";
import type { MapBounds } from "../modelLoader";
import TacticalToolbar from "./TacticalToolbar";
import { useTactical } from "./useTactical";
import {
  makeProjection,
  renderTactical,
  TACTICAL_SIZE,
  type TacticalProjection,
} from "./render";
import {
  commitFreehand,
  commitMarker,
  commitPath,
  commitShape,
  commitText,
  hitTestElement,
  moveElement,
} from "./model";
import type { LogicalRect, TacticalElement, Vec2 } from "./types";
import {
  canvasToBlob,
  composeExportCanvas,
  drawTimestampChip,
  formatBattleClock,
  pickRecorderMime,
  saveExportBlob,
  TacticalRecorder,
} from "./exporters";
import "./TacticalBoard.scss";

/** Ship hit from the host map (HolographicMap's live marker positions). */
export interface ShipPick {
  entityId: number;
  label: string;
}

type Drag =
  | { kind: "draw"; raw: Vec2[] }
  | { kind: "shape"; from: Vec2; to: Vec2 }
  | { kind: "marker"; at: Vec2; heading: number; moved: boolean }
  | { kind: "move"; id: string; grab: Vec2; last: Vec2; pushed: boolean }
  | { kind: "region"; from: Vec2; to: Vec2 };

/** Min drag extents (logical px) below which a gesture is treated as a click. */
const MIN_SHAPE_PX = 8;
const MIN_REGION_PX = 24;

export default defineComponent({
  name: "TacticalBoard",
  props: {
    replayPath: { type: String, required: true },
    /** Filename fragment for export defaults (map name). */
    mapTag: { type: String, default: "map" },
    /** Toolbar + interactions visible; off = view-only annotations. */
    editMode: { type: Boolean, default: false },
    getBounds: { type: Function as PropType<() => MapBounds | null>, required: true },
    getTime: { type: Function as PropType<() => number>, required: true },
    getDuration: { type: Function as PropType<() => number>, required: true },
    getPlaying: { type: Function as PropType<() => boolean>, required: true },
    play: { type: Function as PropType<() => void>, required: true },
    pause: { type: Function as PropType<() => void>, required: true },
    trajectories: { type: Function as PropType<() => EntityTrajectory[]>, required: true },
    pickShipAt: {
      type: Function as PropType<(x: number, z: number) => ShipPick | null>,
      required: true,
    },
    baseCanvas: {
      type: Function as PropType<() => HTMLCanvasElement | null>,
      required: true,
    },
  },
  setup(props) {
    const canvasRef = ref<HTMLCanvasElement | null>(null);
    const inputRef = ref<HTMLInputElement | null>(null);
    const store = useTactical(toRef(props, "replayPath"));
    const toast = useToast();

    const drag = ref<Drag | null>(null);
    /** Waiting for the user to drag the export-crop rectangle. */
    const regionMode = ref(false);
    /** Finished crop rectangle, kept highlighted until exported/cancelled. */
    const pendingRegion = ref<LogicalRect | null>(null);
    const textEdit = ref<{ at: Vec2; value: string; id: string | null } | null>(null);
    const recording = ref(false);
    const busy = ref(false);
    const recorderSupported = pickRecorderMime() != null;
    let recorder: TacticalRecorder | null = null;
    let autoPlayedOnRecord = false;

    // Export settings owned here; the toolbar mutates them via its settings prop.
    const exportSettings = ref({ format: "png" as "png" | "webp", scale: 1 as 1 | 2, timestamp: false });

    const trajMap = computed(() => {
      const m = new Map<number, EntityTrajectory>();
      for (const tr of props.trajectories()) m.set(tr.entityId, tr);
      return m;
    });

    function proj(): TacticalProjection | null {
      const b = props.getBounds();
      return b ? makeProjection(b) : null;
    }

    /** Pointer event → world coords (null when the projection isn't ready). */
    function eventWorld(e: MouseEvent): { p: Vec2; lx: number; ly: number; p2: TacticalProjection } | null {
      const pr = proj();
      const cvs = canvasRef.value;
      if (!pr || !cvs) return null;
      const rect = cvs.getBoundingClientRect();
      if (rect.width === 0) return null;
      const lx = ((e.clientX - rect.left) / rect.width) * TACTICAL_SIZE;
      const ly = ((e.clientY - rect.top) / rect.height) * TACTICAL_SIZE;
      return { p: pr.toWorld(lx, ly), lx, ly, p2: pr };
    }

    function anchorT0(): number {
      return store.anchorToTime.value ? props.getTime() : 0;
    }

    // ── Render loop ──────────────────────────────────────────────────────
    let raf = 0;
    function frame(): void {
      raf = requestAnimationFrame(frame);
      renderNow();
      if (recorder?.recording) {
        recorder.tick();
        const dur = props.getDuration();
        if (dur > 0 && props.getTime() >= dur - 0.08) void stopRecording();
      }
    }

    /** Paint one frame of the annotation layer now. `regionOverride` lets the
     *  exporters compose WITHOUT the crop mask burned in (a full-map export
     *  must not ship with everything outside the pending crop dimmed). */
    function renderNow(regionOverride?: LogicalRect | null): void {
      const cvs = canvasRef.value;
      const bounds = props.getBounds();
      if (!cvs || !bounds) return;
      const rect = cvs.getBoundingClientRect();
      if (rect.width === 0) return;
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const px = Math.round(rect.width * dpr);
      if (cvs.width !== px) {
        cvs.width = px;
        cvs.height = px;
      }
      const ctx = cvs.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(px / TACTICAL_SIZE, 0, 0, px / TACTICAL_SIZE, 0, 0);
      const p = makeProjection(bounds);
      const regionRect: LogicalRect | null =
        regionOverride !== undefined
          ? regionOverride
          : drag.value?.kind === "region"
            ? worldRectToLogical(drag.value.from, drag.value.to, p)
            : pendingRegion.value;
      renderTactical(ctx, {
        elements: store.elements.value,
        proj: p,
        time: props.getTime(),
        trajectories: trajMap.value,
        selectedId: store.selectedId.value,
        preview: previewElement.value,
        regionRect,
        showGhostFuture: store.showGhostFuture.value,
      });
      // Keep the text editor glued to its world anchor.
      if (textEdit.value && inputRef.value) {
        const q = p.toPx(textEdit.value.at);
        inputRef.value.style.left = `${(q.x / TACTICAL_SIZE) * 100}%`;
        inputRef.value.style.top = `${(q.y / TACTICAL_SIZE) * 100}%`;
      }
    }

    function worldRectToLogical(a: Vec2, b: Vec2, p: TacticalProjection): LogicalRect {
      const q1 = p.toPx(a);
      const q2 = p.toPx(b);
      return {
        x: Math.min(q1.x, q2.x),
        y: Math.min(q1.y, q2.y),
        w: Math.abs(q2.x - q1.x),
        h: Math.abs(q2.y - q1.y),
      };
    }

    // ── Preview element while a gesture is in flight ─────────────────────
    const previewElement = computed<TacticalElement | null>(() => {
      const d = drag.value;
      const look = store.style.value;
      if (!d) return null;
      switch (d.kind) {
        case "draw":
          return {
            id: "preview",
            kind: "freehand",
            t0: 0,
            points: d.raw,
            drawIn: 0,
            ...look,
          };
        case "shape":
          return {
            id: "preview",
            kind: store.tool.value === "arrow"
              ? "arrow"
              : store.tool.value === "rect"
                ? "rect"
                : store.tool.value === "ellipse"
                  ? "ellipse"
                  : "line",
            t0: 0,
            points: [d.from, d.to],
            drawIn: 0,
            ...look,
          };
        case "marker":
          return {
            id: "preview",
            kind: "marker",
            t0: 0,
            at: d.at,
            heading: d.heading,
            variant: store.tool.value === "markerPlane" ? "plane" : "ship",
            color: look.color,
            label: "",
            size: 40,
          };
        default:
          return null;
      }
    });

    // ── Pointer interactions ─────────────────────────────────────────────
    function onPointerDown(e: PointerEvent): void {
      // Never let the click bubble to the mmzoom overlay (it closes on click).
      e.stopPropagation();
      if (!props.editMode || e.button !== 0) return;
      const hit = eventWorld(e);
      if (!hit) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const tool = store.tool.value;
      if (regionMode.value) {
        drag.value = { kind: "region", from: hit.p, to: hit.p };
        return;
      }
      switch (tool) {
        case "pen":
          drag.value = { kind: "draw", raw: [hit.p] };
          break;
        case "line":
        case "arrow":
        case "rect":
        case "ellipse":
          drag.value = { kind: "shape", from: hit.p, to: hit.p };
          break;
        case "markerShip":
        case "markerPlane":
          drag.value = { kind: "marker", at: hit.p, heading: 0, moved: false };
          break;
        case "text":
          openTextEditor(hit.p, null);
          break;
        case "pinPath": {
          const ship = props.pickShipAt(hit.p.x, hit.p.z);
          if (ship) {
            store.commit(commitPath(ship.entityId, store.style.value, "now", anchorT0()));
            toast.info(i18nT("replay.tactical.toast.pinned", { name: ship.label }));
          } else {
            toast.info(i18nT("replay.tactical.hint.pin"));
          }
          break;
        }
        case "select": {
          const target = hitTest(hit.p, hit.p2);
          store.selectedId.value = target?.id ?? null;
          if (target && target.kind !== "replayPath") {
            drag.value = { kind: "move", id: target.id, grab: hit.p, last: hit.p, pushed: false };
          }
          break;
        }
      }
    }

    function onPointerMove(e: PointerEvent): void {
      if (!drag.value) return;
      e.stopPropagation();
      const hit = eventWorld(e);
      if (!hit) return;
      const d = drag.value;
      switch (d.kind) {
        case "draw": {
          const last = d.raw[d.raw.length - 1];
          if (!last || Math.hypot(last.x - hit.p.x, last.z - hit.p.z) > hit.p2.worldPerPx * 1.2) {
            d.raw.push(hit.p);
          }
          break;
        }
        case "shape":
          d.to = hit.p;
          break;
        case "marker": {
          const dx = hit.p.x - d.at.x;
          const dz = hit.p.z - d.at.z;
          if (Math.hypot(dx, dz) > hit.p2.worldPerPx * 4) {
            d.heading = Math.atan2(dx, dz); // clockwise from north
            d.moved = true;
          }
          break;
        }
        case "move": {
          if (!d.pushed) {
            store.pushHistory();
            d.pushed = true;
          }
          const el = store.elements.value.find((x) => x.id === d.id);
          if (el) {
            store.replaceElement(d.id, moveElement(el, hit.p.x - d.last.x, hit.p.z - d.last.z));
          }
          d.last = hit.p;
          break;
        }
        case "region":
          d.to = hit.p;
          break;
      }
    }

    function onPointerUp(e: PointerEvent): void {
      e.stopPropagation();
      if (e.button !== 0) return; // only the primary button ends a gesture
      const d = drag.value;
      drag.value = null;
      if (!d) return;
      const pr = proj();
      switch (d.kind) {
        case "draw":
          if (d.raw.length >= 2) {
            store.commit(
              commitFreehand(d.raw, store.style.value, anchorT0(), (pr?.worldPerPx ?? 1) * 2.2),
            );
          }
          break;
        case "shape": {
          const r = pr ? worldRectToLogical(d.from, d.to, pr) : null;
          if (r && (r.w >= MIN_SHAPE_PX || r.h >= MIN_SHAPE_PX)) {
            const kind =
              store.tool.value === "line" || store.tool.value === "arrow"
                ? store.tool.value
                : store.tool.value === "ellipse"
                  ? "ellipse"
                  : "rect";
            store.commit(commitShape(kind, d.from, d.to, store.style.value, anchorT0()));
          }
          break;
        }
        case "marker":
          store.commit(
            commitMarker(
              d.at,
              d.heading,
              store.tool.value === "markerPlane" ? "plane" : "ship",
              store.style.value.color,
              anchorT0(),
            ),
          );
          break;
        case "move":
          break;
        case "region": {
          const r = pr ? worldRectToLogical(d.from, d.to, pr) : null;
          regionMode.value = false;
          if (r && r.w >= MIN_REGION_PX && r.h >= MIN_REGION_PX) {
            pendingRegion.value = r;
          } else {
            pendingRegion.value = null;
          }
          break;
        }
      }
    }

    function onDoubleClick(e: MouseEvent): void {
      e.stopPropagation();
      if (!props.editMode) return;
      const hit = eventWorld(e);
      if (!hit) return;
      const target = hitTest(hit.p, hit.p2);
      if (!target) return;
      if (target.kind === "text") openTextEditor(target.at, target.id);
      else if (target.kind === "marker") openTextEditor(target.at, target.id);
    }

    /** Topmost element under a world point at the current time. */
    function hitTest(p: Vec2, pr: TacticalProjection): TacticalElement | null {
      const t = props.getTime();
      const padWorld = Math.max(6, store.style.value.width) * pr.worldPerPx;
      for (let i = store.elements.value.length - 1; i >= 0; i--) {
        const el = store.elements.value[i];
        if (hitTestElement(el, p, padWorld, t)) return el;
      }
      return null;
    }

    // ── Text editing ─────────────────────────────────────────────────────
    function openTextEditor(at: Vec2, id: string | null): void {
      const el = id ? store.elements.value.find((x) => x.id === id) : null;
      textEdit.value = {
        at: el?.kind === "text" || el?.kind === "marker" ? el.at : at,
        value: el?.kind === "text" ? el.text : el?.kind === "marker" ? el.label : "",
        id,
      };
      requestAnimationFrame(() => inputRef.value?.focus());
    }

    function commitTextEdit(): void {
      const ed = textEdit.value;
      textEdit.value = null;
      if (!ed) return;
      const value = ed.value.trim();
      const el = ed.id ? store.elements.value.find((x) => x.id === ed.id) : null;
      if (el && el.kind === "text") {
        if (!value) {
          store.removeElement(el.id);
        } else if (value !== el.text) {
          store.pushHistory();
          store.replaceElement(el.id, { ...el, text: value });
        }
      } else if (el && el.kind === "marker") {
        if (value !== el.label) {
          store.pushHistory();
          store.replaceElement(el.id, { ...el, label: value });
        }
      } else if (value) {
        store.commit(commitText(ed.at, value, store.style.value.color, anchorT0()));
      }
    }

    function onTextInputKeydown(e: KeyboardEvent): void {
      e.stopPropagation();
      if (e.key === "Enter") commitTextEdit();
      else if (e.key === "Escape") {
        textEdit.value = null;
      }
    }

    // ── Keyboard shortcuts ───────────────────────────────────────────────
    const TOOL_KEYS: Record<string, string> = {
      v: "select",
      p: "pen",
      l: "line",
      a: "arrow",
      r: "rect",
      o: "ellipse",
      t: "text",
      h: "markerShip",
      i: "markerPlane",
      g: "pinPath",
    };

    function onKeydown(e: KeyboardEvent): void {
      if (!props.editMode) return;
      const target = e.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;
      if (e.key === "Escape") {
        if (textEdit.value) return; // the input handles its own Escape
        if (drag.value) {
          drag.value = null;
          return;
        }
        if (regionMode.value || pendingRegion.value) {
          regionMode.value = false;
          pendingRegion.value = null;
          return;
        }
        store.selectedId.value = null;
        return;
      }
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === "z") {
          e.preventDefault();
          if (e.shiftKey) store.redo();
          else store.undo();
        } else if (key === "y") {
          e.preventDefault();
          store.redo();
        }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (store.selectedId.value) {
          e.preventDefault();
          store.removeElement(store.selectedId.value);
        }
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const tool = TOOL_KEYS[e.key.toLowerCase()];
        if (tool) {
          store.tool.value = tool as typeof store.tool.value;
          regionMode.value = false;
        }
      }
    }

    // ── Exports ──────────────────────────────────────────────────────────
    function defaultName(ext: string): string {
      const clock = formatBattleClock(props.getTime()).replace("T+", "").replace(":", "");
      return `wowsp-tactical-${props.mapTag || "map"}-${clock}.${ext}`;
    }

    async function runImageExport(crop: LogicalRect | null): Promise<void> {
      const base = props.baseCanvas();
      if (!base || busy.value) return;
      busy.value = true;
      try {
        const s = exportSettings.value;
        const native = base.width / TACTICAL_SIZE;
        const edgeW = crop ? crop.w : TACTICAL_SIZE;
        const edgeH = crop ? crop.h : TACTICAL_SIZE;
        // Repaint the overlay without the crop mask so exports stay clean.
        renderNow(null);
        const canvas = composeExportCanvas(
          base,
          canvasRef.value,
          { format: s.format, scale: s.scale, crop, timestamp: s.timestamp },
          Math.round(edgeW * native * s.scale),
          Math.round(edgeH * native * s.scale),
          s.timestamp ? formatBattleClock(props.getTime()) : null,
        );
        const blob = await canvasToBlob(canvas, s.format === "webp" ? "image/webp" : "image/png");
        const saved = await saveExportBlob(blob, defaultName(s.format), "Image", s.format);
        if (saved) toast.info(i18nT("replay.tactical.toast.saved", { path: saved }));
        pendingRegion.value = null;
      } catch (e) {
        toast.error(String((e as Error)?.message ?? e));
      } finally {
        busy.value = false;
      }
    }

    function composeRecordFrame(ctx: CanvasRenderingContext2D, size: number): void {
      const base = props.baseCanvas();
      if (!base) return;
      ctx.clearRect(0, 0, size, size);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(base, 0, 0, base.width, base.height, 0, 0, size, size);
      const overlay = canvasRef.value;
      if (overlay) ctx.drawImage(overlay, 0, 0, overlay.width, overlay.height, 0, 0, size, size);
      drawTimestampChip(ctx, size, formatBattleClock(props.getTime()));
    }

    async function startRecording(): Promise<void> {
      if (!props.baseCanvas() || busy.value) return;
      if (!recorderSupported) {
        toast.error(i18nT("replay.tactical.record.unsupported"));
        return;
      }
      const rec = new TacticalRecorder(composeRecordFrame, 1280);
      if (!rec.start()) {
        toast.error(i18nT("replay.tactical.record.unsupported"));
        return;
      }
      recorder = rec;
      autoPlayedOnRecord = !props.getPlaying();
      if (autoPlayedOnRecord) props.play();
      recording.value = true;
    }

    /** Stop + save a recorder take (shared by the manual stop button, the
     *  editMode toggle and component unmount — closing the overlay mid-take
     *  must not silently discard the video). */
    async function finalizeRecording(rec: TacticalRecorder): Promise<void> {
      recording.value = false;
      if (autoPlayedOnRecord && props.getPlaying()) props.pause();
      busy.value = true;
      try {
        const blob = await rec.stop();
        if (blob.size === 0) {
          toast.info(i18nT("replay.tactical.toast.empty"));
          return;
        }
        const saved = await saveExportBlob(blob, defaultName(rec.ext), "Video", rec.ext);
        if (saved) toast.info(i18nT("replay.tactical.toast.saved", { path: saved }));
      } catch (e) {
        toast.error(String((e as Error)?.message ?? e));
      } finally {
        busy.value = false;
      }
    }

    async function stopRecording(): Promise<void> {
      const rec = recorder;
      recorder = null;
      if (!rec) return;
      await finalizeRecording(rec);
    }

    // ── Toolbar actions ──────────────────────────────────────────────────
    function beginRegionMode(): void {
      pendingRegion.value = null;
      regionMode.value = true;
      store.tool.value = "select";
    }

    function toggleRecording(): void {
      if (recording.value) void stopRecording();
      else void startRecording();
    }

    // Leaving edit mode hides the toolbar (the only stop button) — end any
    // in-flight gesture and recording instead of stranding it.
    watch(
      () => props.editMode,
      (on) => {
        if (on) return;
        drag.value = null;
        regionMode.value = false;
        pendingRegion.value = null;
        textEdit.value = null;
        if (recorder) {
          const rec = recorder;
          recorder = null;
          void finalizeRecording(rec);
        }
      },
    );

    onMounted(() => {
      raf = requestAnimationFrame(frame);
      window.addEventListener("keydown", onKeydown, true);
    });
    onBeforeUnmount(() => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeydown, true);
      // Unmounting (overlay closed / replay switched) mid-take still saves.
      if (recorder) {
        const rec = recorder;
        recorder = null;
        void finalizeRecording(rec);
      }
    });

    const cursorClass = computed(() => {
      if (regionMode.value) return "tac-layer__canvas--cross";
      switch (store.tool.value) {
        case "pen":
        case "line":
        case "arrow":
        case "rect":
        case "ellipse":
        case "markerShip":
        case "markerPlane":
        case "text":
          return "tac-layer__canvas--cross";
        case "pinPath":
          return "tac-layer__canvas--point";
        default:
          return "";
      }
    });

    return () => {
      const edit = props.editMode;
      return (
        <div class="tac-layer">
          <canvas
            ref={canvasRef}
            class={["tac-layer__canvas", cursorClass.value]}
            style={{ pointerEvents: edit ? "auto" : "none" }}
            onPointerdown={onPointerDown}
            onPointermove={onPointerMove}
            onPointerup={onPointerUp}
            onPointercancel={(e: PointerEvent) => {
              // Lost pointer capture mid-gesture — drop the stroke, don't
              // leave a frozen preview on screen.
              e.stopPropagation();
              drag.value = null;
            }}
            onPointerleave={(e: PointerEvent) => {
              if (drag.value && e.buttons === 0) {
                drag.value = null;
                e.stopPropagation();
              }
            }}
            onClick={(e: MouseEvent) => e.stopPropagation()}
            onDblclick={onDoubleClick}
            onContextmenu={(e: MouseEvent) => e.stopPropagation()}
          />
          {textEdit.value ? (
            <input
              ref={inputRef}
              class="tac-layer__text-input"
              value={textEdit.value.value}
              placeholder={i18nT("replay.tactical.text.placeholder")}
              onInput={(e: Event) => {
                if (textEdit.value) textEdit.value.value = (e.target as HTMLInputElement).value;
              }}
              onKeydown={onTextInputKeydown}
              onBlur={commitTextEdit}
            />
          ) : null}
          {recording.value ? (
            <div class="tac-layer__rec-chip" onClick={(e: MouseEvent) => e.stopPropagation()}>
              <span class="tac-layer__rec-dot" />
              {i18nT("replay.tactical.record.recording")}
            </div>
          ) : null}
          {regionMode.value ? (
            <div class="tac-layer__hint" onClick={(e: MouseEvent) => e.stopPropagation()}>
              {i18nT("replay.tactical.hint.region")}
            </div>
          ) : null}
          {edit ? (
            <TacticalToolbar
              store={store}
              regionActive={regionMode.value}
              pendingRegion={pendingRegion.value != null}
              recording={recording.value}
              recordingSupported={recorderSupported}
              busy={busy.value}
              exportSettings={exportSettings.value}
              hasSelection={store.selected.value != null}
              actions={{
                exportFull: () => void runImageExport(null),
                exportRegion: () => {
                  if (pendingRegion.value) void runImageExport(pendingRegion.value);
                  else beginRegionMode();
                },
                recordToggle: toggleRecording,
              }}
            />
          ) : null}
        </div>
      );
    };
  },
});

// Re-export for the toolbar's prop typing.
export type { TacticalStore } from "./useTactical";
