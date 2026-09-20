/**
 * Tactical-board Canvas2D renderer. Pure given (ctx, doc, projection, time):
 * draws every element at its reveal progress, the in-progress preview
 * stroke, the selection outline and the export region mask. The layer
 * component owns the canvas + RAF; nothing here touches the DOM itself.
 *
 * All drawing happens in the 760-unit logical map space — the caller has
 * already applied the HiDPI transform (same contract as `drawMinimap`).
 */
import { drawShipGlyph } from "@wowsp/holo";
import type { EntityTrajectory } from "@/api/client";
import type { MapBounds } from "../modelLoader";
import type {
  DashStyle,
  LogicalRect,
  TacticalElement,
  Vec2,
} from "./types";
import {
  elementPoints,
  elementProgress,
  visibleAt,
} from "./model";
import {
  pointAlongPolyline,
  slicePolylineByFraction,
  sliceSegmentByFraction,
  smoothPolyline,
} from "./geometry";
import { trajectoryPolylines } from "./replayPath";

/** Logical map space the enlarged 2D view draws in (matches zoomCanvas). */
export const TACTICAL_SIZE = 760;

export interface TacticalProjection {
  /** Logical size (760). */
  size: number;
  toPx(p: Vec2): { x: number; y: number };
  toWorld(px: number, py: number): Vec2;
  /** World units per logical px — converts px tolerances to world. */
  worldPerPx: number;
}

/** Build the world ⇄ logical projection from full-map world bounds (the same
 *  `full` rect drawMinimap uses: minimap bounds when known, else fitted). */
export function makeProjection(bounds: MapBounds, size = TACTICAL_SIZE): TacticalProjection {
  const w = bounds.maxX - bounds.minX || 1;
  const h = bounds.maxZ - bounds.minZ || 1;
  return {
    size,
    worldPerPx: Math.max(w, h) / size,
    toPx(p) {
      return {
        x: ((p.x - bounds.minX) / w) * size,
        y: ((bounds.maxZ - p.z) / h) * size,
      };
    },
    toWorld(px, py) {
      return {
        x: bounds.minX + (px / size) * w,
        z: bounds.maxZ - (py / size) * h,
      };
    },
  };
}

// Viewport window math lives in geometry.ts (pure, test-friendly); it is
// re-exported here because HolographicMap already imports from this module.
export { viewWindow, TACTICAL_MAX_SCALE } from "./geometry";
export type { TacticalView } from "./geometry";

function applyDash(ctx: CanvasRenderingContext2D, dash: DashStyle, width: number): void {
  const w = Math.max(1, width);
  if (dash === "dashed") ctx.setLineDash([w * 3.2, w * 2.4]);
  else if (dash === "dotted") ctx.setLineDash([Math.max(1, w * 0.35), w * 1.9]);
  else ctx.setLineDash([]);
}

function strokePolylineWorld(ctx: CanvasRenderingContext2D, pts: Vec2[], proj: TacticalProjection): void {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const p = proj.toPx(pts[i]);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  fromPx: { x: number; y: number },
  toPx: { x: number; y: number },
  width: number,
  color: string,
): void {
  const angle = Math.atan2(toPx.y - fromPx.y, toPx.x - fromPx.x);
  const size = Math.max(9, Math.min(22, width * 3.4));
  ctx.save();
  ctx.translate(toPx.x, toPx.y);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.45, size * 0.5);
  ctx.lineTo(-size * 0.45, -size * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Simple vector plane silhouette pointing RIGHT (+x) at rotation 0 — the
 *  same rest orientation as the ship glyph, so one shared heading rotation
 *  (`heading − π/2`, heading 0 = north) fits both variants. */
function drawPlaneGlyph(ctx: CanvasRenderingContext2D, size: number, color: string): void {
  const s = size / 24;
  ctx.fillStyle = color;
  ctx.beginPath();
  // Fuselage + swept wings + tail, one polygon in a 24px box, nose at +x.
  ctx.moveTo(12 * s, 0);
  ctx.lineTo(7 * s, 1.6 * s);
  ctx.lineTo(1 * s, 11 * s); // top wingtip (screen up = world north when heading 0)
  ctx.lineTo(-1.6 * s, 11 * s);
  ctx.lineTo(-1.2 * s, 1.6 * s);
  ctx.lineTo(-8 * s, 1.4 * s); // tail
  ctx.lineTo(-10.6 * s, 4.6 * s);
  ctx.lineTo(-12 * s, 4.6 * s);
  ctx.lineTo(-10.8 * s, 0);
  ctx.lineTo(-12 * s, -4.6 * s);
  ctx.lineTo(-10.6 * s, -4.6 * s);
  ctx.lineTo(-8 * s, -1.4 * s);
  ctx.lineTo(-1.2 * s, -1.6 * s);
  ctx.lineTo(-1.6 * s, -11 * s);
  ctx.lineTo(1 * s, -11 * s);
  ctx.lineTo(7 * s, -1.6 * s);
  ctx.closePath();
  ctx.fill();
}

function drawLabelChip(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(5, 8, 15, 0.72)";
  ctx.beginPath();
  ctx.roundRect(x, y, w + 10, 16, 8);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 5, y + 8.5);
}

export interface RenderOptions {
  elements: TacticalElement[];
  proj: TacticalProjection;
  /** Replay seconds to render at. */
  time: number;
  /** Trajectories by entityId — for replayPath elements. */
  trajectories: Map<number, EntityTrajectory>;
  selectedId: string | null;
  /** Element being drawn right now (no time gate, 80% alpha). */
  preview: TacticalElement | null;
  /** Region-crop rect being dragged (logical px) — dims everything outside. */
  regionRect: LogicalRect | null;
  /** Dim elements whose t0 is in the future (scrubbed before appearance). */
  showGhostFuture?: boolean;
}

export function renderTactical(ctx: CanvasRenderingContext2D, opts: RenderOptions): void {
  const { proj } = opts;
  ctx.clearRect(0, 0, proj.size, proj.size);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const el of opts.elements) {
    const future = !visibleAt(el, opts.time);
    if (future && !opts.showGhostFuture) continue;
    drawElement(ctx, el, opts, future ? "ghost" : "normal");
  }
  if (opts.preview) drawElement(ctx, opts.preview, opts, "preview");
  if (opts.selectedId) {
    const sel = opts.elements.find((e) => e.id === opts.selectedId);
    if (sel) drawSelection(ctx, sel, opts);
  }
  if (opts.regionRect) drawRegionMask(ctx, opts.regionRect, proj.size);
}

type DrawMode = "normal" | "preview" | "ghost";

// ── Per-frame cost guards ────────────────────────────────────────────────
// The layer repaints every RAF; heavy derived geometry (Catmull-Rom smoothing
// of committed strokes, replay-trajectory slicing) is memoized against the
// immutable source it was derived from so steady-state frames are draws only.
// Elements are replaced (never mutated) on every edit, which invalidates the
// WeakMap entry naturally.

const smoothCache = new WeakMap<object, { src: unknown; out: Vec2[] }>();

function cachedSmooth(owner: object, src: unknown, make: () => Vec2[]): Vec2[] {
  const hit = smoothCache.get(owner);
  if (hit && hit.src === src) return hit.out;
  const out = make();
  smoothCache.set(owner, { src, out });
  return out;
}

interface PathCacheEntry {
  src: EntityTrajectory;
  /** 0.5 s time bucket for "now" paths (-1 for full); cache granularity. */
  bucket: number;
  polys: Vec2[][];
}
const pathCache = new WeakMap<object, PathCacheEntry>();

function cachedPathPolys(
  owner: object,
  traj: EntityTrajectory,
  upTo: number | null,
): Vec2[][] {
  const bucket = upTo == null ? -1 : Math.floor(upTo * 2) / 2;
  const hit = pathCache.get(owner);
  if (hit && hit.src === traj && hit.bucket === bucket) return hit.polys;
  // Slice at the bucketed time (not the raw playhead) so the cached result
  // always matches its key.
  const polys = trajectoryPolylines(traj, bucket < 0 ? null : bucket);
  pathCache.set(owner, { src: traj, bucket, polys });
  return polys;
}

function drawElement(
  ctx: CanvasRenderingContext2D,
  el: TacticalElement,
  opts: RenderOptions,
  mode: DrawMode,
): void {
  const { proj } = opts;
  const t = opts.time;
  const alpha = mode === "preview" ? 0.85 : mode === "ghost" ? 0.22 : 1;
  const progress = mode === "normal" ? elementProgress(el, t) : 1;
  ctx.save();
  ctx.globalAlpha = alpha;
  switch (el.kind) {
    case "freehand": {
      const src = el.points;
      // Live previews recompute every frame — the in-flight points array is
      // mutated in place, so its identity never changes and a cache keyed on
      // it would freeze at the first frame. Only steady-state (normal)
      // strokes take the memoized path.
      const pts =
        mode === "normal"
          ? progress < 1
            ? smoothPolyline(slicePolylineByFraction(src, progress))
            : cachedSmooth(el, src, () => smoothPolyline(src))
          : smoothPolyline(src);
      ctx.strokeStyle = el.color;
      ctx.lineWidth = el.width;
      applyDash(ctx, el.dash, el.width);
      strokePolylineWorld(ctx, pts, proj);
      break;
    }
    case "line": {
      const [a, b] = el.points;
      const end = sliceSegmentByFraction(a, b, progress);
      ctx.strokeStyle = el.color;
      ctx.lineWidth = el.width;
      applyDash(ctx, el.dash, el.width);
      strokePolylineWorld(ctx, [a, end], proj);
      break;
    }
    case "arrow": {
      const [a, b] = el.points;
      const end = sliceSegmentByFraction(a, b, progress);
      ctx.strokeStyle = el.color;
      ctx.lineWidth = el.width;
      applyDash(ctx, el.dash, el.width);
      strokePolylineWorld(ctx, [a, end], proj);
      const pa = proj.toPx(a);
      const pe = proj.toPx(end);
      ctx.setLineDash([]);
      drawArrowHead(ctx, pa, pe, el.width, el.color);
      break;
    }
    case "rect": {
      const [a, b] = el.points;
      const pa = proj.toPx(a);
      const pb = proj.toPx(b);
      // Grow from the first anchor as the reveal plays.
      const bx = pa.x + (pb.x - pa.x) * progress;
      const by = pa.y + (pb.y - pa.y) * progress;
      ctx.strokeStyle = el.color;
      ctx.lineWidth = el.width;
      applyDash(ctx, el.dash, el.width);
      ctx.beginPath();
      ctx.rect(Math.min(pa.x, bx), Math.min(pa.y, by), Math.abs(bx - pa.x), Math.abs(by - pa.y));
      ctx.stroke();
      break;
    }
    case "ellipse": {
      const [a, b] = el.points;
      const pa = proj.toPx(a);
      const pb = proj.toPx(b);
      const bx = pa.x + (pb.x - pa.x) * progress;
      const by = pa.y + (pb.y - pa.y) * progress;
      ctx.strokeStyle = el.color;
      ctx.lineWidth = el.width;
      applyDash(ctx, el.dash, el.width);
      ctx.beginPath();
      ctx.ellipse(
        (pa.x + bx) / 2,
        (pa.y + by) / 2,
        Math.abs(bx - pa.x) / 2,
        Math.abs(by - pa.y) / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;
    }
    case "text": {
      const p = proj.toPx(el.at);
      ctx.globalAlpha = alpha * progress;
      ctx.font = `600 ${el.size}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const lines = el.text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const y = p.y + i * el.size * 1.25;
        ctx.strokeStyle = "rgba(5, 8, 15, 0.85)";
        ctx.lineWidth = Math.max(3, el.size / 5);
        ctx.strokeText(lines[i], p.x, y);
        ctx.fillStyle = el.color;
        ctx.fillText(lines[i], p.x, y);
      }
      break;
    }
    case "marker": {
      // Scripted routes: dashed guide line + the marker sailing along it.
      if (el.route != null && el.route.length >= 2) {
        const routePts = cachedSmooth(el, el.route, () => smoothPolyline(el.route!));
        const lw = Math.max(1.2, el.size / 28);
        ctx.strokeStyle = el.color;
        ctx.lineWidth = lw;
        ctx.globalAlpha = alpha * 0.55;
        applyDash(ctx, "dashed", lw);
        strokePolylineWorld(ctx, routePts, proj);
        ctx.setLineDash([]);
        ctx.globalAlpha = alpha;
      }
      const scripted = el.route != null && el.route.length >= 2 && !!el.moveDur && el.moveDur > 0;
      const pose = scripted
        ? pointAlongPolyline(
            cachedSmooth(el, el.route!, () => smoothPolyline(el.route!)),
            mode === "normal"
              ? Math.max(0, Math.min(1, (t - el.t0) / (el.moveDur || 1)))
              : 0, // previews sit at the route start
          )
        : { at: el.at, heading: el.heading };
      const p = proj.toPx(pose.at);
      ctx.globalAlpha = alpha * progress;
      ctx.save();
      ctx.translate(p.x, p.y);
      // Heading 0 = north (up); glyph art points right at rest → −90°.
      ctx.rotate(pose.heading - Math.PI / 2);
      if (el.variant === "ship") {
        drawShipGlyph(ctx, undefined, 0, 0, el.size, el.color);
      } else {
        drawPlaneGlyph(ctx, el.size, el.color);
      }
      ctx.restore();
      if (el.label) {
        ctx.globalAlpha = alpha;
        drawLabelChip(ctx, el.label, p.x + el.size * 0.55, p.y + el.size * 0.35, el.color);
      }
      break;
    }
    case "replayPath": {
      const traj = opts.trajectories.get(el.entityId);
      if (!traj) break;
      const polys = cachedPathPolys(el, traj, el.upTo === "now" ? t : null);
      ctx.strokeStyle = el.color;
      ctx.lineWidth = el.width;
      applyDash(ctx, el.dash, el.width);
      for (const poly of polys) strokePolylineWorld(ctx, poly, proj);
      break;
    }
  }
  ctx.restore();
}

function drawSelection(ctx: CanvasRenderingContext2D, el: TacticalElement, opts: RenderOptions): void {
  if (el.kind === "replayPath") return;
  const pts = elementPoints(el, opts.time);
  if (pts.length === 0) return;
  const padPx = 7;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    const q = opts.proj.toPx(p);
    if (q.x < minX) minX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.x > maxX) maxX = q.x;
    if (q.y > maxY) maxY = q.y;
  }
  ctx.save();
  ctx.strokeStyle = "rgba(0, 195, 255, 0.95)";
  ctx.lineWidth = 1.4;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(minX - padPx, minY - padPx, maxX - minX + padPx * 2, maxY - minY + padPx * 2);
  ctx.restore();
}

function drawRegionMask(ctx: CanvasRenderingContext2D, rect: LogicalRect, size: number): void {
  ctx.save();
  ctx.fillStyle = "rgba(3, 8, 18, 0.5)";
  ctx.beginPath();
  ctx.rect(0, 0, size, size);
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.fill("evenodd");
  ctx.strokeStyle = "rgba(0, 195, 255, 0.95)";
  ctx.lineWidth = 1.6;
  ctx.setLineDash([7, 5]);
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  ctx.restore();
}
