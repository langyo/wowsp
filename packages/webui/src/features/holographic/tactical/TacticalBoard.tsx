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
import Timeline, { type TimelineUserMarker } from "./Timeline";
import { useTactical } from "./useTactical";
import type { ShipAction } from "./actions";
import {
  makeProjection,
  renderTactical,
  TACTICAL_SIZE,
  type TacticalProjection,
  type TacticalView,
} from "./render";
import {
  commitFreehand,
  commitMarker,
  commitPath,
  commitRouteMarker,
  commitShape,
  commitText,
  hitTestElement,
  markerPoseAt,
  moveElement,
  parseDoc,
  presentParkTarget,
  serializeDoc,
} from "./model";
import type { LogicalRect, TacticalElement, Vec2 } from "./types";
import {
  canvasToBlob,
  composeExportCanvas,
  drawTimestampChip,
  formatBattleClock,
  frameTimes,
  pickRecorderMime,
  renderVideoOffline,
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
  | { kind: "region"; from: Vec2; to: Vec2 }
  | { kind: "pan"; lastLx: number; lastLy: number }
  | { kind: "route"; raw: Vec2[] }
  | { kind: "erase" };

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
    /** Pause + jump the battle clock AND repaint markers + the 2D map
     *  synchronously (step navigation + offline frame rendering). */
    seekTo: { type: Function as PropType<(t: number) => void>, required: true },
    /** Pan/zoom handle for the enlarged 2D viewport (wheel zoom, hand pan,
     *  step camera tweens). Owned by HolographicMap. */
    viewApi: {
      type: Object as PropType<{
        snapshot(): TacticalView;
        zoomAt(lx: number, ly: number, factor: number): void;
        panByLogical(dxL: number, dyL: number): void;
        reset(): void;
        tweenTo(target: TacticalView, durMs?: number): void;
      }>,
      required: true,
    },
    trajectories: { type: Function as PropType<() => EntityTrajectory[]>, required: true },
    /** Replay-action markers for the timeline (shells / torpedoes / planes /
     *  speed changes). Empty on hosts that don't supply one. */
    actions: { type: Array as PropType<ShipAction[]>, default: () => [] },
    /** Entity id → display label (ship name) for timeline tooltips. */
    labelOf: {
      type: Function as PropType<(entityId: number) => string>,
      default: (id: number) => String(id),
    },
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

    // Offline (faster-than-realtime) export state.
    const offlineRendering = ref(false);
    const offlineProgress = ref({ done: 0, total: 0 });
    const offlineCancel: { cancelled: boolean } = { cancelled: false };

    // Presentation mode: auto-advance playback that pauses at each step.
    const presentMode = ref(false);
    let presentDwellTimer: ReturnType<typeof setTimeout> | null = null;
    /** Space held = temporary hand tool (pan), Photoshop-style. */
    const spacePanning = ref(false);

    // Export settings owned here; the toolbar mutates them via its settings prop.
    const exportSettings = ref({
      format: "png" as "png" | "webp",
      scale: 1 as 1 | 2,
      timestamp: false,
      offlineFps: 30 as 30 | 60,
      offlineFrom: "now" as "now" | "start",
    });

    const trajMap = computed(() => {
      const m = new Map<number, EntityTrajectory>();
      for (const tr of props.trajectories()) m.set(tr.entityId, tr);
      return m;
    });

    /** User-authored markers on the timeline: virtual ships/planes and
     *  pinned real paths, anchored at their reveal time. Over a replay
     *  context these render hollow (they are plans, not observed events). */
    const userMarkers = computed<TimelineUserMarker[]>(() =>
      store.elements.value
        .filter((el) => el.kind === "marker" || el.kind === "replayPath")
        .map((el) =>
          el.kind === "marker"
            ? {
                id: el.id,
                t0: el.t0,
                color: el.color,
                label: el.label,
                kind: "marker" as const,
                solid: false,
              }
            : {
                id: el.id,
                t0: el.t0,
                color: el.color,
                label: props.labelOf(el.entityId),
                kind: "path" as const,
                solid: false,
              },
        ),
    );
    function removeUserMarkerById(id: string): void {
      store.removeElement(id);
    }

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
      // While recording, drop the crop mask from the live overlay too — the
      // recorder composes this very canvas, so the dim rectangle would burn
      // into the video (WYSIWYG: live view == recorded frames).
      renderNow(recorder?.recording ? null : undefined);
      if (recorder?.recording) {
        recorder.tick();
        const dur = props.getDuration();
        if (dur > 0 && props.getTime() >= dur - 0.08) void stopRecording();
      }
      // Presentation auto-advance: playing crosses a step boundary → park
      // exactly on it, dwell, then continue toward the next step.
      if (presentMode.value && props.getPlaying()) {
        const t = props.getTime();
        const park = presentParkTarget(store.stepsSorted.value, t);
        if (park) {
          props.seekTo(park.t);
          if (park.view) props.viewApi.tweenTo(park.view);
          props.pause();
          schedulePresentDwell();
        } else if (props.getDuration() > 0 && t >= props.getDuration() - 0.1) {
          exitPresentMode();
        }
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
        // The board always runs over a replay: virtual units are plans, so
        // their glyphs render hollow (standalone boards would own solids).
        hollowMarkers: true,
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
        case "route":
          return {
            id: "preview",
            kind: "marker",
            t0: 0,
            at: d.raw[0],
            heading: 0,
            variant: "ship",
            color: look.color,
            label: "",
            size: 40,
            route: d.raw,
            moveDur: 30,
          };
        default:
          return null;
      }
    });

    // ── Pointer interactions ─────────────────────────────────────────────
    function onPointerDown(e: PointerEvent): void {
      // Never let the click bubble to the mmzoom overlay (it closes on click).
      e.stopPropagation();
      if (e.button !== 0) return;
      const hit = eventWorld(e);
      if (!hit) return;
      // View-only mode still pans/zooms the camera (annotations are read).
      // Edit mode pans via the hand tool or while Space is held.
      const wantPan = !props.editMode || spacePanning.value || store.tool.value === "hand";
      if (wantPan) {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.value = { kind: "pan", lastLx: hit.lx, lastLy: hit.ly };
        return;
      }
      if (!props.editMode) return;
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
        case "markerRoute":
          drag.value = { kind: "route", raw: [hit.p] };
          break;
        case "eraser":
          drag.value = { kind: "erase" };
          eraseAt(hit.p, hit.p2);
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

    /** Eraser hit: delete the topmost element under the point (each removal
     *  is its own undo entry — matches Delete-key semantics). The radius is
     *  a fixed screen size, independent of the current stroke width. */
    function eraseAt(p: Vec2, pr: TacticalProjection): void {
      const t = props.getTime();
      const padWorld = 10 * pr.worldPerPx * 1.6;
      for (let i = store.elements.value.length - 1; i >= 0; i--) {
        const el = store.elements.value[i];
        if (hitTestElement(el, p, padWorld, t)) {
          store.removeElement(el.id);
          return;
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
        case "pan":
          props.viewApi.panByLogical(hit.lx - d.lastLx, hit.ly - d.lastLy);
          d.lastLx = hit.lx;
          d.lastLy = hit.ly;
          break;
        case "draw": {
          const last = d.raw[d.raw.length - 1];
          if (!last || Math.hypot(last.x - hit.p.x, last.z - hit.p.z) > hit.p2.worldPerPx * 1.2) {
            d.raw.push(hit.p);
          }
          break;
        }
        case "route": {
          const last = d.raw[d.raw.length - 1];
          if (!last || Math.hypot(last.x - hit.p.x, last.z - hit.p.z) > hit.p2.worldPerPx * 1.2) {
            d.raw.push(hit.p);
          }
          break;
        }
        case "erase":
          eraseAt(hit.p, hit.p2);
          break;
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
        case "pan":
        case "erase":
          break;
        case "draw":
          if (d.raw.length >= 2) {
            store.commit(
              commitFreehand(d.raw, store.style.value, anchorT0(), (pr?.worldPerPx ?? 1) * 2.2),
            );
          }
          break;
        case "route": {
          if (d.raw.length >= 2) {
            const el = commitRouteMarker(
              d.raw,
              store.style.value.color,
              anchorT0(),
              (pr?.worldPerPx ?? 1) * 2.2,
            );
            if (el) store.commit(el);
          }
          break;
        }
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

    /** Wheel = cursor-anchored zoom of the 2D viewport (any mode). */
    function onWheel(e: WheelEvent): void {
      e.stopPropagation();
      e.preventDefault();
      const cvs = canvasRef.value;
      if (!cvs) return;
      const rect = cvs.getBoundingClientRect();
      if (rect.width === 0) return;
      const lx = ((e.clientX - rect.left) / rect.width) * TACTICAL_SIZE;
      const ly = ((e.clientY - rect.top) / rect.height) * TACTICAL_SIZE;
      const factor = e.deltaY < 0 ? 1.22 : 1 / 1.22;
      props.viewApi.zoomAt(lx, ly, factor);
    }

    function onDoubleClick(e: MouseEvent): void {
      e.stopPropagation();
      if (!props.editMode) return;
      const hit = eventWorld(e);
      if (!hit) return;
      const target = hitTest(hit.p, hit.p2);
      if (!target) return;
      if (target.kind === "text") openTextEditor(target.at, target.id);
      else if (target.kind === "marker") {
        // Anchor at the marker's pose right now (a scripted one may be
        // anywhere along its route, not at its route start).
        openTextEditor(markerPoseAt(target, props.getTime()).at, target.id);
      }
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
        at,
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
      m: "markerRoute",
      g: "pinPath",
      e: "eraser",
    };

    /** Any hikari modal/frame stacked above the map — while one is open the
     *  board's shortcuts (tool letters, [ ] seeks, Ctrl+Z) must stay dead
     *  instead of acting on an invisible surface. */
    function otherModalOpen(): boolean {
      return document.querySelector(".hk-modal-content") != null;
    }

    function onKeydown(e: KeyboardEvent): void {
      if (!props.editMode) return;
      if (otherModalOpen()) return;
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
        if (presentMode.value) {
          exitPresentMode();
          return;
        }
        store.selectedId.value = null;
        return;
      }
      if (typing) return;
      // Space = temporary hand tool (hold to pan, release to restore) — but
      // never steal it from a focused button/select (keyboard activation).
      if (e.key === " ") {
        const tag = target?.tagName;
        if (tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA") return;
        e.preventDefault();
        spacePanning.value = true;
        return;
      }
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
          return;
        }
        if (e.key === "[") {
          e.preventDefault();
          stepPrev();
        } else if (e.key === "]") {
          e.preventDefault();
          stepNext();
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
        // Only a crop export consumes the crop — a full-view snapshot keeps
        // the pending region for further cropped exports.
        if (crop != null) pendingRegion.value = null;
      } catch (e) {
        toast.error(String((e as Error)?.message ?? e));
      } finally {
        busy.value = false;
      }
    }

    /** Compose one finished frame (base map + annotations + battle clock)
     *  onto an export ctx at `size`. Used by both the realtime recorder and
     *  the offline renderer — the battle time is passed explicitly so the
     *  offline path stamps the frame it just painted, not the live clock. */
    function composePaintedFrame(ctx: CanvasRenderingContext2D, size: number, t: number): void {
      const base = props.baseCanvas();
      if (!base) return;
      ctx.clearRect(0, 0, size, size);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(base, 0, 0, base.width, base.height, 0, 0, size, size);
      const overlay = canvasRef.value;
      if (overlay) ctx.drawImage(overlay, 0, 0, overlay.width, overlay.height, 0, 0, size, size);
      drawTimestampChip(ctx, size, formatBattleClock(t));
    }

    async function startRecording(): Promise<void> {
      if (!props.baseCanvas() || busy.value) return;
      if (!recorderSupported) {
        toast.error(i18nT("replay.tactical.record.unsupported"));
        return;
      }
      pendingRegion.value = null; // a crop box must not record into the take
      regionMode.value = false;
      drag.value = null;
      const rec = new TacticalRecorder(
        (ctx, size) => composePaintedFrame(ctx, size, props.getTime()),
        1280,
      );
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

    // ── Presentation mode (step timeline) ────────────────────────────────
    const stepsSorted = computed(() => store.stepsSorted.value);
    /** Index of the last step at or before the playhead (-1 = before the
     *  first step). */
    const currentStepIndex = computed(() => {
      const t = props.getTime();
      let idx = -1;
      for (let i = 0; i < stepsSorted.value.length; i++) {
        if (stepsSorted.value[i].t <= t + 0.05) idx = i;
        else break;
      }
      return idx;
    });

    function goToStep(i: number): void {
      if (offlineRendering.value) return;
      // Manual navigation takes control from the auto-advance dwell.
      if (presentDwellTimer != null) {
        clearTimeout(presentDwellTimer);
        presentDwellTimer = null;
        if (presentMode.value) props.pause();
      }
      const s = stepsSorted.value[i];
      if (!s) return;
      props.seekTo(s.t);
      // Step camera ("运镜"): eased viewport tween to the captured view.
      if (s.view) props.viewApi.tweenTo(s.view);
    }
    function stepPrev(): void {
      goToStep(Math.max(0, currentStepIndex.value));
    }
    function stepNext(): void {
      goToStep(Math.min(stepsSorted.value.length - 1, currentStepIndex.value + 1));
    }
    function addStepHere(): void {
      if (offlineRendering.value) return;
      const ok = store.addStep(props.getTime(), props.viewApi.snapshot());
      if (!ok) toast.info(i18nT("replay.tactical.steps.duplicate"));
    }
    function removeStepById(id: string): void {
      store.removeStep(id);
    }

    function schedulePresentDwell(): void {
      if (presentDwellTimer != null) clearTimeout(presentDwellTimer);
      presentDwellTimer = setTimeout(() => {
        presentDwellTimer = null;
        if (!presentMode.value) return;
        // More steps ahead → keep playing toward the next one; otherwise the
        // show is over.
        const hasFurther = stepsSorted.value.some((s) => s.t > props.getTime() + 0.05);
        if (hasFurther) props.play();
        else exitPresentMode();
      }, 1400);
    }
    function enterPresentMode(): void {
      if (offlineRendering.value) return;
      if (stepsSorted.value.length === 0) {
        toast.info(i18nT("replay.tactical.steps.empty"));
        return;
      }
      presentMode.value = true;
      props.play();
    }
    function exitPresentMode(): void {
      if (!presentMode.value) return;
      presentMode.value = false;
      if (presentDwellTimer != null) {
        clearTimeout(presentDwellTimer);
        presentDwellTimer = null;
      }
      props.pause();
    }
    function togglePresent(): void {
      if (presentMode.value) exitPresentMode();
      else enterPresentMode();
    }

    // ── Offline (faster-than-realtime) video export ──────────────────────
    function cancelOfflineExport(): void {
      offlineCancel.cancelled = true;
    }

    async function runOfflineExport(): Promise<void> {
      const base = props.baseCanvas();
      const dur = props.getDuration();
      if (!base || dur <= 0 || busy.value || offlineRendering.value) return;
      // The offline render seeks the live clock frame by frame — it cannot
      // share the stage with a realtime recording or presentation playback.
      if (recording.value) {
        toast.info(i18nT("replay.tactical.record.recording"));
        return;
      }
      exitPresentMode();
      const s = exportSettings.value;
      const from = s.offlineFrom === "start" ? 0 : props.getTime();
      const times = frameTimes(from, dur, s.offlineFps);
      if (times.length < 2) {
        toast.info(i18nT("replay.tactical.toast.empty"));
        return;
      }
      props.pause();
      const resumeAt = props.getTime();
      offlineCancel.cancelled = false;
      offlineRendering.value = true;
      offlineProgress.value = { done: 0, total: times.length };
      busy.value = true;
      try {
        const result = await renderVideoOffline({
          fps: s.offlineFps,
          times,
          size: 1280,
          paintAt: (t, ctx, size) => {
            // Step the whole live 2D map (base + ships + caps + smoke +
            // planes) to t, repaint annotations, then compose one frame.
            props.seekTo(t);
            renderNow(null);
            composePaintedFrame(ctx, size, t);
          },
          onProgress: (done, total) => {
            offlineProgress.value = { done, total };
          },
          cancelToken: offlineCancel,
        });
        if (!result) {
          toast.error(i18nT("replay.tactical.record.unsupported"));
        } else if (result.cancelled && result.blob.size === 0) {
          // User cancelled before anything encoded — stay quiet.
        } else if (result.blob.size > 0) {
          const saved = await saveExportBlob(result.blob, defaultName(result.ext), "Video", result.ext);
          if (saved) toast.info(i18nT("replay.tactical.toast.saved", { path: saved }));
        } else {
          toast.info(i18nT("replay.tactical.toast.empty"));
        }
      } catch (e) {
        toast.error(String((e as Error)?.message ?? e));
      } finally {
        offlineRendering.value = false;
        busy.value = false;
        props.seekTo(resumeAt);
      }
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
        if (textEdit.value) commitTextEdit();
        exitPresentMode();
        if (recorder) {
          const rec = recorder;
          recorder = null;
          void finalizeRecording(rec);
        }
      },
    );

    // ── Annotation-doc JSON import / export ──────────────────────────────
    function exportDocJson(): void {
      const json = serializeDoc({
        version: 1,
        elements: store.elements.value,
        steps: store.steps.value,
      });
      const blob = new Blob([json], { type: "application/json" });
      void saveExportBlob(blob, `wowsp-tactical-${props.mapTag || "map"}.json`, "JSON", "json").then(
        (saved) => {
          if (saved) toast.info(i18nT("replay.tactical.toast.saved", { path: saved }));
        },
      );
    }

    const jsonInput = ref<HTMLInputElement | null>(null);
    function importDocJson(e: Event): void {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      void file
        .text()
        .then((text) => {
          const doc = parseDoc(text);
          if (!doc) {
            toast.error(i18nT("replay.tactical.toast.importBad"));
            return;
          }
          store.applyDoc(doc);
          toast.info(i18nT("replay.tactical.toast.imported"));
        })
        .catch(() => toast.error(i18nT("replay.tactical.toast.importBad")));
    }

    onMounted(() => {
      raf = requestAnimationFrame(frame);
      window.addEventListener("keydown", onKeydown, true);
      window.addEventListener("keyup", onKeyUp, true);
    });
    onBeforeUnmount(() => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      exitPresentMode();
      // Stop the offline render at the next frame boundary; whatever was
      // encoded so far still gets saved by the finally-block in the runner.
      offlineCancel.cancelled = true;
      // Unmounting (overlay closed / replay switched) mid-take still saves.
      if (recorder) {
        const rec = recorder;
        recorder = null;
        void finalizeRecording(rec);
      }
    });

    function onKeyUp(e: KeyboardEvent): void {
      if (e.key === " ") spacePanning.value = false;
    }

    const cursorClass = computed(() => {
      if (drag.value?.kind === "pan" || spacePanning.value || !props.editMode) {
        return "tac-layer__canvas--grab";
      }
      if (store.tool.value === "hand") return "tac-layer__canvas--grab";
      if (store.tool.value === "eraser") return "tac-layer__canvas--point";
      if (regionMode.value) return "tac-layer__canvas--cross";
      switch (store.tool.value) {
        case "pen":
        case "line":
        case "arrow":
        case "rect":
        case "ellipse":
        case "markerShip":
        case "markerPlane":
        case "markerRoute":
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
            onPointerdown={onPointerDown}
            onPointermove={onPointerMove}
            onPointerup={onPointerUp}
            onWheel={onWheel}
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
          {offlineRendering.value ? (
            <div class="tac-layer__rec-chip" onClick={(e: MouseEvent) => e.stopPropagation()}>
              <span class="tac-layer__rec-dot" />
              {i18nT("replay.tactical.export.offlineRunning")}
              <b class="tac-layer__rec-count">
                {offlineProgress.value.done}/{offlineProgress.value.total}
              </b>
              <button class="tac-layer__rec-cancel" onClick={cancelOfflineExport}>
                {i18nT("replay.tactical.export.cancel")}
              </button>
            </div>
          ) : null}
          {regionMode.value ? (
            <div class="tac-layer__hint" onClick={(e: MouseEvent) => e.stopPropagation()}>
              {i18nT("replay.tactical.hint.region")}
            </div>
          ) : null}
          {edit ? (
            <div
              class={["tac-dock", offlineRendering.value ? "tac-dock--busy" : ""]}
              onClick={(e: MouseEvent) => e.stopPropagation()}
            >
              <Timeline
                getTime={props.getTime}
                getDuration={props.getDuration}
                getPlaying={props.getPlaying}
                play={() => { if (!props.getPlaying()) props.play(); }}
                pause={() => { if (props.getPlaying()) props.pause(); }}
                seekTo={props.seekTo}
                actions={props.actions}
                labelOf={props.labelOf}
                steps={stepsSorted.value}
                currentStepIndex={currentStepIndex.value}
                userMarkers={userMarkers.value}
                presentMode={presentMode.value}
                addStep={addStepHere}
                stepPrev={stepPrev}
                stepNext={stepNext}
                togglePresent={togglePresent}
                goToStep={goToStep}
                removeStep={removeStepById}
                removeUserMarker={removeUserMarkerById}
              />
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
                  offlineExport: () => void runOfflineExport(),
                  exportJson: exportDocJson,
                  importJson: () => jsonInput.value?.click(),
                  resetView: () => props.viewApi.reset(),
                }}
              />
            </div>
          ) : null}
          <input
            ref={jsonInput}
            class="tac-layer__file-input"
            type="file"
            accept=".json,application/json"
            onChange={importDocJson}
          />
        </div>
      );
    };
  },
});

// Re-export for the toolbar's prop typing.
export type { TacticalStore } from "./useTactical";
