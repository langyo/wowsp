/**
 * @wowsp/holo — shared types for the holographic replay HUD.
 * Pure data contracts, no stores / no Tauri — the app and the site both
 * map their own state onto these.
 */

/** World-space bounds of a battle map (same frame as replay positions). */
export interface HoloBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export type HoloRole = "self" | "ally" | "enemy";

/** One ship on the minimap / scoreboard. */
export interface HoloShip {
  x: number;
  z: number;
  yaw: number;
  role: HoloRole;
  dead: boolean;
  name?: string;
  /** WG ship type (Battleship / Cruiser / …) — drives the game icon. */
  shipType?: string;
  /** Screen-space heading for the icon (0 = up, clockwise), from motion. */
  heading?: number;
  /** Recent trail (world coords, oldest → newest). */
  trail?: { x: number; z: number }[];
}

/** Capture zone state for the scorebar letters. */
export interface HoloCapZone {
  letter: string; // "A" | "B" | "C" | …
  owner: "ally" | "enemy" | "neutral";
  /** 0..1 capture progress (0 = none, 1 = owned). */
  progress: number;
  capturing?: boolean;
  /** Both teams inside the ring — progress paused (in-game "contested"). */
  contested?: boolean;
  /** Optional tooltip for the letter chip. */
  hint?: string;
}

/** Capture zone on the minimap (world position + current owner). */
export interface HoloCap {
  letter: string;
  x: number;
  z: number;
  owner: "ally" | "enemy" | "neutral";
}

/** Everything the scorebar / clock / minimap need each frame. */
export interface HoloHudState {
  scoreAlly: number;
  scoreEnemy: number;
  aliveAlly: number;
  aliveEnemy: number;
  time: number; // battle seconds
  duration: number;
  caps: HoloCapZone[];
  ships: HoloShip[];
}

/** Minimap base art + projection metadata. */
export interface HoloMinimapArt {
  url: string;
  /** World bounds of the art (minimaps.json frame). */
  bounds: HoloBounds;
  /** Optional crop — the "active battle area" when the map restricts it. */
  activeBounds?: HoloBounds;
}
