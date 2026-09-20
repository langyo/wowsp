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
  | "pinPath";

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

/** Extra unit marker the author places on top of the replay (wave-1: static
 *  position + heading; scripted movement is a wave-2 timeline feature). */
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
