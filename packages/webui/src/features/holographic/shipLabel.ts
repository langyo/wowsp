/**
 * Per-marker display info for the holographic map's floating HTML labels,
 * extracted verbatim from HolographicMap.tsx. Shared by the map component
 * (label list + per-frame screen projection) and the camera follow menu.
 */
import type { TeamRole } from "./teamColors";

/** Per-marker display info for the floating HTML labels. Rebuilt alongside
 *  the markers; positions are updated each frame by projecting the marker's
 *  world position into screen space. */
export interface ShipLabel {
  entityId: number;
  role: TeamRole;
  name: string;
  shipName: string;
  /** WG shipId (roster/trajectory join) — drives the hull silhouette. */
  shipId?: number;
  tier: number | null;
  type: string | null;
  hp: number | null;
  maxHp: number | null;
  /** "plane" renders the aircraft icon + carrier name instead of the ship glyph. */
  kind?: "ship" | "plane";
  /** Aircraft type name (fighter/dive/...) for plane labels. */
  planeType?: string | null;
  /** Ghost (unseen/sunk) state: label gets a dashed border and the HP bar
   *  is replaced by a "gone for N s" countdown text. */
  ghostText?: string | null;
  /** Screen-space left/top in px (relative to the canvas). Updated per-frame. */
  x: number;
  y: number;
  visible: boolean;
  dead: boolean;
}
