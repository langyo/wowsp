/**
 * Tactical board data model (wave 1).
 *
 * Everything an author draws lives in WORLD coordinates (WoWS planar space:
 * x = east, z = north — the same frame as `PositionSample`), so annotations
 * stay pinned to terrain regardless of canvas size, DPR or export scale.
 * Elements are time-anchored: `t0` is the replay second at which the element
 * appears (scrubbing before it hides it), which is also what powers the
 * lightweight "slide deck" playback: annotations draw themselves on as the
 * battle clock passes their anchor.
 */

/** World-space point (WoWS planar coords: x = east, z = north). */
export interface Vec2 {
  x: number;
  z: number;
}

export type TacticalToolId =
  | "select"
  | "pen"
  | "line"
  | "arrow"
  | "rect"
  | "ellipse"
  | "text"
  | "markerShip"
  | "markerPlane"
  | "markerRoute"
  | "pinPath"
  | "eraser"
  | "hand";

export type DashStyle = "solid" | "dashed" | "dotted";

/** Stroke look shared by drawn shapes and pinned replay paths. */
export interface StrokeLook {
  color: string;
  width: number;
  dash: DashStyle;
}

interface BaseElement {
  id: string;
  /** Replay seconds at which the element appears (0 = always visible). */
  t0: number;
}

export interface ShapeElement extends BaseElement, StrokeLook {
  kind: "freehand" | "line" | "arrow" | "rect" | "ellipse";
  /** Freehand: simplified world points. Two-point shapes: [from, to]. */
  points: Vec2[];
  /** Seconds of draw-on animation after t0 (0 = appear instantly). */
  drawIn: number;
}

export interface TextElement extends BaseElement {
  kind: "text";
  at: Vec2;
  text: string;
  color: string;
  /** Font px in the 760-unit logical map space. */
  size: number;
}

export type MarkerVariant = "ship" | "plane";

/** What a plan-board marker DOES at its anchored second. `move` is the
 *  interpolatable kind: it carries the unit from its own position to the
 *  unit's NEXT action over the seconds between the two — the auto-tween the
 *  timeline draws an arrow for. `attack` / `spot` are instantaneous events
 *  parked at the unit's position for that moment. */
export type TacticalActionKind = "move" | "attack" | "spot";

/** Extra unit marker the author places on top of the replay. Static (at +
 *  heading) unless a `route` is scripted, in which case the marker sails the
 *  smoothed route from t0 over `moveDur` seconds, heading along the tangent.
 *
 *  On a plan board (`action` set) the marker becomes one keyframe of a unit's
 *  timeline: markers sharing a variant and label are the same unit, and a
 *  `move` action's position tweens toward the unit's next action (plan.ts). */
export interface MarkerElement extends BaseElement {
  kind: "marker";
  at: Vec2;
  /** Radians clockwise from north (matches WoWS yaw convention). */
  heading: number;
  variant: MarkerVariant;
  color: string;
  label: string;
  /** Glyph length in 760-unit logical map space. */
  size: number;
  /** Optional scripted route (world points, ≥2); rendered dashed while the
   *  marker advances along its smoothed curve. A scripted route wins over an
   *  `action` tween — the hand-drawn path is the more specific instruction. */
  route?: Vec2[];
  /** Travel time in battle seconds (default 30). */
  moveDur?: number;
  /** Plan-board action kind. Absent on the replay annotation board, whose
   *  markers stay static unless a `route` is scripted. (A plan document
   *  IMPORTED onto the replay board still animates — the renderer honors
   *  `action` on every host; only the toolbar stops stamping it off-plan.) */
  action?: TacticalActionKind;
}

/** A pinned REAL trajectory from the replay, restyled as an annotation.
 *  `upTo: "now"` grows live with the playhead (only what has been "seen");
 *  `"full"` always shows the complete recorded path. */
export interface PathElement extends BaseElement, StrokeLook {
  kind: "replayPath";
  entityId: number;
  upTo: "now" | "full";
}

export type TacticalElement = ShapeElement | TextElement | MarkerElement | PathElement;

/** A presentation step: a battle-time bookmark the author uses to walk an
 *  audience through the fight (seek targets for prev/next + auto-advance
 *  playback, which also replays every annotation's draw-on reveal). */
export interface TacticalStep {
  id: string;
  /** Battle seconds the step jumps to. */
  t: number;
  /** Reserved for custom names; wave 2 derives `#<index>` at display time
   *  (stored as "" so deleting a step renumbers the rest automatically). */
  name: string;
  /** Camera captured when the step was bookmarked: seeking to the step
   *  tweens the 2D viewport here (the "运镜" flyover). */
  view?: { cx: number; cz: number; scale: number };
}

export interface TacticalDoc {
  version: 1;
  elements: TacticalElement[];
  /** Ordered by `t` (normalizeDoc enforces it). */
  steps: TacticalStep[];
}

/** Rect in 760-unit logical canvas space (region crop for exports). */
export interface LogicalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageExportOptions {
  format: "png" | "webp";
  /** Output multiplier against the logical 760 map space (1 or 2). */
  scale: 1 | 2;
  /** Crop rect in logical units; null = full map. */
  crop: LogicalRect | null;
  /** Burn "T+MM:SS" into the corner (battle clock at capture time). */
  timestamp: boolean;
}

export const TACTICAL_DOC_VERSION = 1;
