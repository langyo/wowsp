/**
 * Pure document logic: time gating, draw-on progress, element factories,
 * hit-testing and (immutable) edits. The composable (`useTactical`) wraps
 * this with reactive state + undo history; render.ts consumes the pure
 * predicates — keep DOM/canvas imports out of this file so it stays testable.
 */
import type {
  MarkerElement,
  PathElement,
  ShapeElement,
  StrokeLook,
  TacticalDoc,
  TacticalElement,
  TacticalStep,
  TextElement,
  Vec2,
} from "./types";
import { TACTICAL_DOC_VERSION } from "./types";
import {
  TACTICAL_MAX_SCALE,
  distToPolyline,
  distToSegment,
  pointInEllipse,
  pointAlongPolyline,
  pointNearRect,
  slicePolylineByFraction,
  sliceSegmentByFraction,
  simplifyRDP,
  smoothPolyline,
} from "./geometry";
import { ACTION_KINDS, isInterpolatedKind } from "./plan";

let _idSeq = 0;

/** Stable element ids (test-friendly: deterministic within a session). */
export function newElementId(): string {
  _idSeq += 1;
  return `tac-${Date.now().toString(36)}-${_idSeq}`;
}

/** Freehand commit: simplify the raw pointer samples, then keep the raw
 *  simplified points (smoothing happens at render time so dash/slicing work
 *  on a uniform polyline). `tolerance` is in world units — callers scale it
 *  from the on-screen pixel tolerance via their projection. */
export function commitFreehand(raw: Vec2[], look: StrokeLook, t0: number, tolerance: number): ShapeElement {
  const simple = simplifyKeepShape(raw, tolerance);
  return {
    id: newElementId(),
    kind: "freehand",
    t0,
    points: simple,
    drawIn: defaultDrawInSec(simple),
    ...look,
  };
}

/** Collinear-ish strokes still need ≥2 points to render. */
function simplifyKeepShape(raw: Vec2[], tolerance: number): Vec2[] {
  const out = simplifyRDP(raw, tolerance);
  return out.length >= 2 ? out : raw.slice();
}

/** Two-anchor shape (line / arrow / rect / ellipse). */
export function commitShape(
  kind: "line" | "arrow" | "rect" | "ellipse",
  from: Vec2,
  to: Vec2,
  look: StrokeLook,
  t0: number,
): ShapeElement {
  return {
    id: newElementId(),
    kind,
    t0,
    points: [from, to],
    drawIn: kind === "line" || kind === "arrow" ? 0.6 : 0.5,
    ...look,
  };
}

export function commitText(at: Vec2, text: string, color: string, t0: number): TextElement {
  return { id: newElementId(), kind: "text", t0, at, text, color, size: 18 };
}

export function commitMarker(
  at: Vec2,
  heading: number,
  variant: MarkerElement["variant"],
  color: string,
  t0: number,
  label = "",
  action?: MarkerElement["action"],
): MarkerElement {
  return {
    id: newElementId(),
    kind: "marker",
    t0,
    at,
    heading,
    variant,
    color,
    label,
    size: 40,
    ...(action ? { action } : {}),
  };
}

/** A scripted route marker: sails the (simplified) route from `t0` over
 *  `moveDur` battle seconds, heading along the local tangent. */
export function commitRouteMarker(
  rawRoute: Vec2[],
  color: string,
  t0: number,
  tolerance: number,
  moveDur = 30,
  variant: MarkerElement["variant"] = "ship",
): MarkerElement | null {
  const route = simplifyRDP(rawRoute, tolerance);
  if (route.length < 2) return null;
  const start = pointAlongPolyline(route, 0);
  return {
    id: newElementId(),
    kind: "marker",
    t0,
    at: start.at,
    heading: start.heading,
    variant,
    color,
    label: "",
    size: 40,
    route,
    moveDur,
  };
}

/** Where a marker sits at battle time t. Explicit motion wins over plan
 *  tweening: a scripted route interpolates along its smoothed polyline, else a
 *  `move` action with a tween target sails straight to the unit's next action
 *  (arriving exactly at its second) and holds there afterwards. */
export function markerPoseAt(
  el: MarkerElement,
  t: number,
  tween?: { at: Vec2; t: number } | null,
): { at: Vec2; heading: number } {
  if (el.route && el.route.length >= 2 && el.moveDur && el.moveDur > 0) {
    const frac = Math.max(0, Math.min(1, (t - el.t0) / el.moveDur));
    return pointAlongPolyline(el.route, frac);
  }
  if (tween && tween.t > el.t0 && el.action != null && isInterpolatedKind(el.action)) {
    const frac = Math.max(0, Math.min(1, (t - el.t0) / (tween.t - el.t0)));
    const dx = tween.at.x - el.at.x;
    const dz = tween.at.z - el.at.z;
    return {
      at: { x: el.at.x + dx * frac, z: el.at.z + dz * frac },
      // Keep the authored heading when there is nowhere to travel.
      heading: Math.hypot(dx, dz) > 1e-6 ? Math.atan2(dx, dz) : el.heading,
    };
  }
  return { at: el.at, heading: el.heading };
}

export function commitPath(
  entityId: number,
  look: StrokeLook,
  upTo: PathElement["upTo"],
  t0: number,
): PathElement {
  return { id: newElementId(), kind: "replayPath", t0, entityId, upTo, ...look };
}

export function commitStep(t: number, name?: string): TacticalStep {
  return { id: newElementId(), t: Math.max(0, t), name: name ?? "" };
}

/** Presentation auto-advance park decision: the step the show should park
 *  on RIGHT NOW (pause + dwell), or null. A step strictly ahead of `t`
 *  counts once the playhead is within 50 ms of it (playTick overshoots by
 *  one frame at 10× speed, so an exact `t >= s.t` test would skip parks).
 *  After parking on a step, `t === s.t` and the strict `>` excludes it, so
 *  resuming cannot immediately re-park the same step. */
export function presentParkTarget<T extends { t: number }>(steps: T[], t: number): T | null {
  const next = steps.find((s) => s.t > t);
  return next != null && t >= next.t - 0.05 ? next : null;
}

function defaultDrawInSec(points: Vec2[]): number {
  // Draw-on duration scales with path length so short flicks pop and long
  // sweeping arrows take ~2s — the "presenter draws on screen" feel.
  const len = points.reduce((acc, p, i) => (i === 0 ? 0 : acc + Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z)), 0);
  return Math.min(2, Math.max(0.3, len / 2000));
}

/** Visible at replay time t (elements with t0 = 0 are always visible). */
export function visibleAt(el: TacticalElement, t: number): boolean {
  return t >= el.t0;
}

/** Element reveal progress at time t: 0 → 1 over its draw-in window. */
export function elementProgress(el: TacticalElement, t: number): number {
  if (el.kind === "text" || el.kind === "marker") {
    return Math.max(0, Math.min(1, (t - el.t0) / 0.35));
  }
  if (el.kind === "replayPath") return t >= el.t0 ? 1 : 0;
  const drawIn = el.drawIn > 0 ? el.drawIn : 0;
  if (drawIn === 0) return t >= el.t0 ? 1 : 0;
  return Math.max(0, Math.min(1, (t - el.t0) / drawIn));
}

/** Full-progress smoothed freehand cache — hit-tests and the selection
 *  outline re-derive the polyline far more often than the render loop, so
 *  they share one memo per immutable element (edits replace the object,
 *  which invalidates naturally). */
const smoothHitCache = new WeakMap<object, Vec2[]>();

function smoothedFreehand(el: ShapeElement): Vec2[] {
  let out = smoothHitCache.get(el);
  if (!out) {
    out = smoothPolyline(el.points);
    smoothHitCache.set(el, out);
  }
  return out;
}

/** World points an element occupies at time t (for hit-tests + selection
 *  outline). Freehand returns the SMOOTHED polyline (what the user sees).
 *  `tween` is the plan action's tween target, when it has one. */
export function elementPoints(
  el: TacticalElement,
  t: number,
  tween?: { at: Vec2; t: number } | null,
): Vec2[] {
  switch (el.kind) {
    case "freehand": {
      if (elementProgress(el, t) >= 1) return smoothedFreehand(el);
      const partial = slicePolylineByFraction(el.points, elementProgress(el, t));
      return partial.length >= 2 ? smoothPolyline(partial) : partial;
    }
    case "line":
    case "arrow": {
      const frac = elementProgress(el, t);
      const [a, b] = el.points;
      return [a, sliceSegmentByFraction(a, b, frac)];
    }
    case "rect":
    case "ellipse":
      return el.points;
    case "text":
      return [el.at];
    case "marker": {
      const pose = markerPoseAt(el, t, tween);
      // Selection outline spans the whole scripted route, not just the
      // marker's current position.
      if (el.route && el.route.length >= 2) {
        return [pose.at, el.route[0], el.route[el.route.length - 1]];
      }
      return [pose.at];
    }
    case "replayPath":
      return [];
  }
}

/** Hit-test an element at world point p with `padWorld` slack (top-most
 *  wins in the caller by iterating in reverse). */
export function hitTestElement(
  el: TacticalElement,
  p: Vec2,
  padWorld: number,
  t: number,
  tween?: { at: Vec2; t: number } | null,
): boolean {
  if (!visibleAt(el, t)) return false;
  switch (el.kind) {
    case "freehand":
      return distToPolyline(p, elementPoints(el, t)) <= padWorld;
    case "line":
    case "arrow":
      return distToSegment(p, el.points[0], el.points[1]) <= padWorld;
    case "rect":
      return pointNearRect(p, el.points[0], el.points[1], padWorld);
    case "ellipse":
      return pointInEllipse(p, el.points[0], el.points[1], padWorld);
    case "text":
      return Math.hypot(p.x - el.at.x, p.z - el.at.z) <= padWorld * 2.2;
    case "marker": {
      const pose = markerPoseAt(el, t, tween);
      if (
        Math.hypot(p.x - pose.at.x, p.z - pose.at.z) <= padWorld * 2.2 ||
        // The scripted route line is clickable too (select/move the marker
        // by grabbing its route, not just the moving glyph).
        (el.route != null &&
          el.route.length >= 2 &&
          distToPolyline(p, el.route) <= padWorld)
      ) {
        return true;
      }
      return false;
    }
    case "replayPath":
      return false; // not directly selectable in wave 1
  }
}

/** Translate an element by a world delta (drag-move). Returns a NEW element
 *  of the same kind. */
export function moveElement<T extends TacticalElement>(el: T, dx: number, dz: number): T {
  switch (el.kind) {
    case "freehand":
    case "line":
    case "arrow":
    case "rect":
    case "ellipse":
      return { ...el, points: el.points.map((p) => ({ x: p.x + dx, z: p.z + dz })) };
    case "text":
      return { ...el, at: { x: el.at.x + dx, z: el.at.z + dz } };
    case "marker":
      return {
        ...el,
        at: { x: el.at.x + dx, z: el.at.z + dz },
        route: el.route?.map((p) => ({ x: p.x + dx, z: p.z + dz })),
      };
    case "replayPath":
      return el;
  }
}

// ── Persistence ─────────────────────────────────────────────────────────

/** FNV-1a over the replay path — stable, non-crypto, CJK-safe localStorage key. */
export function docStorageKey(replayPath: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < replayPath.length; i++) {
    h ^= replayPath.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `wowsp:tactical:v1:${(h >>> 0).toString(36)}`;
}

export function serializeDoc(doc: TacticalDoc): string {
  return JSON.stringify({ ...doc, version: TACTICAL_DOC_VERSION });
}

export function parseDoc(json: string): TacticalDoc | null {
  try {
    const d = JSON.parse(json) as Partial<TacticalDoc>;
    if (d && d.version === TACTICAL_DOC_VERSION && Array.isArray(d.elements)) {
      // Sanitize + normalize: a corrupted/hand-edited localStorage entry
      // must neither brick the render loop nor degrade silently — drop
      // malformed elements and backfill safe defaults for optional fields.
      // (Docs from wave 1 have no `steps` — backfill an empty list.)
      const steps = normalizeSteps(d.steps);
      return { version: 1, elements: d.elements.flatMap(normalizeElement), steps };
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeSteps(raw: unknown): TacticalStep[] {
  if (!Array.isArray(raw)) return [];
  const out: TacticalStep[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const e = s as Record<string, unknown>;
    if (typeof e.id !== "string") continue;
    const t = fin(e.t, Number.NaN);
    if (!Number.isFinite(t)) continue;
    const v = e.view as Record<string, unknown> | undefined;
    const cx = v ? fin(v.cx, Number.NaN) : Number.NaN;
    const cz = v ? fin(v.cz, Number.NaN) : Number.NaN;
    const scale = v ? fin(v.scale, Number.NaN) : Number.NaN;
    const view =
      Number.isFinite(cx) && Number.isFinite(cz) && Number.isFinite(scale)
        ? { cx, cz, scale: Math.max(1, Math.min(TACTICAL_MAX_SCALE, scale)) }
        : undefined;
    out.push({
      id: e.id,
      t: Math.max(0, t),
      name: typeof e.name === "string" ? e.name : "",
      ...(view ? { view } : {}),
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

const ELEMENT_KINDS = new Set([
  "freehand",
  "line",
  "arrow",
  "rect",
  "ellipse",
  "text",
  "marker",
  "replayPath",
]);
const DASH_KINDS = new Set(["solid", "dashed", "dotted"]);

function isFiniteVec(v: unknown): v is Vec2 {
  return (
    !!v &&
    typeof (v as Vec2).x === "number" &&
    typeof (v as Vec2).z === "number" &&
    Number.isFinite((v as Vec2).x) &&
    Number.isFinite((v as Vec2).z)
  );
}

function fin(v: unknown, def: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : def;
}

function str(v: unknown, def: string): string {
  return typeof v === "string" && v.length > 0 ? v : def;
}

function normDash(v: unknown): "solid" | "dashed" | "dotted" {
  return typeof v === "string" && DASH_KINDS.has(v) ? (v as "solid" | "dashed" | "dotted") : "solid";
}

function normalizeElement(el: unknown): TacticalElement[] {
  if (!el || typeof el !== "object") return [];
  const e = el as Record<string, unknown>;
  if (typeof e.id !== "string" || !ELEMENT_KINDS.has(String(e.kind))) return [];
  const base = { id: e.id, t0: fin(e.t0, 0) };
  switch (e.kind) {
    case "freehand":
    case "line":
    case "arrow":
    case "rect":
    case "ellipse": {
      const pts = (Array.isArray(e.points) ? e.points : []).filter(isFiniteVec);
      if (pts.length < 2) return [];
      return [
        {
          ...base,
          kind: e.kind,
          points: pts,
          color: str(e.color, "#f43f5e"),
          width: fin(e.width, 4),
          dash: normDash(e.dash),
          drawIn: fin(e.drawIn, 0),
        },
      ];
    }
    case "text": {
      if (!isFiniteVec(e.at) || typeof e.text !== "string") return [];
      return [
        {
          ...base,
          kind: "text",
          at: e.at,
          text: e.text,
          color: str(e.color, "#ffffff"),
          size: fin(e.size, 18),
        },
      ];
    }
    case "marker": {
      if (!isFiniteVec(e.at) || (e.variant !== "ship" && e.variant !== "plane")) return [];
      const route = (Array.isArray(e.route) ? e.route : []).filter(isFiniteVec);
      const moveDur = fin(e.moveDur, Number.NaN);
      const action = ACTION_KINDS.find((k) => k === e.action);
      return [
        {
          ...base,
          kind: "marker",
          at: e.at,
          heading: fin(e.heading, 0),
          variant: e.variant,
          color: str(e.color, "#ffffff"),
          label: typeof e.label === "string" ? e.label : "",
          size: fin(e.size, 40),
          ...(route.length >= 2 && moveDur > 0 ? { route, moveDur } : {}),
          ...(action ? { action } : {}),
        },
      ];
    }
    case "replayPath": {
      if (
        typeof e.entityId !== "number" ||
        !Number.isFinite(e.entityId) ||
        (e.upTo !== "now" && e.upTo !== "full")
      ) {
        return [];
      }
      return [
        {
          ...base,
          kind: "replayPath",
          entityId: e.entityId,
          upTo: e.upTo,
          color: str(e.color, "#4ade80"),
          width: fin(e.width, 4),
          dash: normDash(e.dash),
        },
      ];
    }
    default:
      return [];
  }
}
