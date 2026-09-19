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
  TextElement,
  Vec2,
} from "./types";
import {
  boundsOf,
  distToPolyline,
  distToSegment,
  pointInEllipse,
  pointNearRect,
  slicePolylineByFraction,
  sliceSegmentByFraction,
  simplifyRDP,
  smoothPolyline,
} from "./geometry";

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
): MarkerElement {
  return { id: newElementId(), kind: "marker", t0, at, heading, variant, color, label, size: 40 };
}

export function commitPath(
  entityId: number,
  look: StrokeLook,
  upTo: PathElement["upTo"],
  t0: number,
): PathElement {
  return { id: newElementId(), kind: "replayPath", t0, entityId, upTo, ...look };
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

/** World points an element occupies at time t (for hit-tests + selection
 *  outline). Freehand returns the SMOOTHED polyline (what the user sees). */
export function elementPoints(el: TacticalElement, t: number): Vec2[] {
  switch (el.kind) {
    case "freehand": {
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
    case "marker":
      return [el.at];
    case "replayPath":
      return [];
  }
}

/** Hit-test an element at world point p with `padWorld` slack (top-most
 *  wins in the caller by iterating in reverse). */
export function hitTestElement(el: TacticalElement, p: Vec2, padWorld: number, t: number): boolean {
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
    case "marker":
      return Math.hypot(p.x - el.at.x, p.z - el.at.z) <= padWorld * 2.2;
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
    case "marker":
      return { ...el, at: { x: el.at.x + dx, z: el.at.z + dz } };
    case "replayPath":
      return el;
  }
}

/** Bounding box for the selection outline (world coords). */
export function elementBounds(el: TacticalElement, t: number) {
  if (el.kind === "replayPath") return null;
  return boundsOf(elementPoints(el, t));
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
  return JSON.stringify(doc);
}

export function parseDoc(json: string): TacticalDoc | null {
  try {
    const d = JSON.parse(json) as TacticalDoc;
    if (d && d.version === 1 && Array.isArray(d.elements)) {
      // Sanitize + normalize: a corrupted/hand-edited localStorage entry
      // must neither brick the render loop nor degrade silently — drop
      // malformed elements and backfill safe defaults for optional fields.
      return { version: 1, elements: d.elements.flatMap(normalizeElement) };
    }
    return null;
  } catch {
    return null;
  }
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
