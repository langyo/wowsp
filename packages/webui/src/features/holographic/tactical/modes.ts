/**
 * Battle-mode presets for the plan board (the map-setup wizard's step 2).
 *
 * One map serves several battle shapes: the SAME space hosts random-battle
 * dominations with 1–4 capture points, ranked / clan variants with their own
 * layouts, and operations whose points appear only mid-battle (station-gated
 * caps that regen when the station heals). The game files the app unpacks do
 * not carry per-(map, mode) cap coordinates, so a preset is a TEMPLATE in
 * normalised map fractions (0..1, origin south-west) that the author can
 * drag into the true position on the board afterwards — honest about being
 * an approximation, unlike fabricated coordinates.
 *
 * Presets also fix the plan clock's duration (ranked runs 20:00 like random;
 * operations vary — the preset carries the value the board starts from).
 */
import type { Vec2 } from "./types";

/** How one capture point of a template sits on the map. Positions are
 *  fractions of the playable rect: x 0 = west, z 0 = south. */
export interface CapSpec {
  /** Display letter (A, B, C …); the plan board shows it on the ring. */
  letter: string;
  at: Vec2;
  /** Ring radius in world units (WoWS standard cap ~ 700 m ≈ 23.3 units). */
  radius: number;
  /** Owning side at t0 (null = neutral). Base caps of a symmetric layout
   *  belong to their side of the map. */
  team?: "ally" | "enemy" | null;
  /** Battle second the point APPEARS at (operations with conditional
   *  objectives); 0 = present from the start. */
  appearT?: number;
  /** Station-gated point (operations): the linked observation station must
   *  be destroyed before the point is capturable; while the station regens
   *  back to full the point hides again. Modelled, not simulated. */
  station?: boolean;
}

export type ModeFamily = "random" | "ranked" | "clan" | "pve";

export interface ModePreset {
  id: string;
  family: ModeFamily;
  /** i18n key suffix under `tactics.mode.*`. */
  labelKey: string;
  /** One-line description key (cap layout / special rules). */
  descKey: string;
  /** Plan clock length in seconds. */
  durationS: number;
  /** Capture-point template (normalised fractions of the playable rect). */
  caps: CapSpec[];
}

/** Standard WoWS cap ring radius in world units (700 m / 30). */
export const CAP_RADIUS_UNITS = 700 / 30;

/** 20-minute battle clock — the random / ranked / clan default. */
export const BATTLE_DURATION_S = 20 * 60;

function cap(letter: string, x: number, z: number, extra?: Partial<CapSpec>): CapSpec {
  return { letter, at: { x, z }, radius: CAP_RADIUS_UNITS, team: null, ...extra };
}

/**
 * Fraction orientation: z 0 = SOUTH = the ally spawn edge (spawnPoses puts
 * the ally fleet at z-fraction 0.09 heading north) — a side's home cap sits
 * in ITS half, so `team: "ally"` templates live below z 0.5 and enemies
 * above it.
 *
 * The four-point domination shape: two home caps near each spawn, two
 * contestable caps on the mid flanks (the classic A-B-C-D diamond). */
const CAPS_4: CapSpec[] = [
  cap("A", 0.24, 0.3, { team: "ally" }),
  cap("B", 0.38, 0.5),
  cap("C", 0.62, 0.5),
  cap("D", 0.76, 0.7, { team: "enemy" }),
];

/** Three-point domination: one home cap per side + one centre objective. */
const CAPS_3: CapSpec[] = [
  cap("A", 0.3, 0.34, { team: "ally" }),
  cap("B", 0.5, 0.5),
  cap("C", 0.7, 0.66, { team: "enemy" }),
];

/** Two-point domination (ranked sprint shape): symmetric flanks. */
const CAPS_2: CapSpec[] = [cap("A", 0.35, 0.62), cap("B", 0.65, 0.38)];

/** Single objective (epicentre-like): one centre ring. */
const CAPS_1: CapSpec[] = [cap("A", 0.5, 0.5)];

/** Encounter / standard battle: no capture points at all. */
const CAPS_0: CapSpec[] = [];

/** All presets, in the wizard's listing order. */
export const MODE_PRESETS: readonly ModePreset[] = [
  {
    id: "random-4",
    family: "random",
    labelKey: "dom4",
    descKey: "dom4Desc",
    durationS: BATTLE_DURATION_S,
    caps: CAPS_4,
  },
  {
    id: "random-3",
    family: "random",
    labelKey: "dom3",
    descKey: "dom3Desc",
    durationS: BATTLE_DURATION_S,
    caps: CAPS_3,
  },
  {
    id: "random-2",
    family: "random",
    labelKey: "dom2",
    descKey: "dom2Desc",
    durationS: BATTLE_DURATION_S,
    caps: CAPS_2,
  },
  {
    id: "random-1",
    family: "random",
    labelKey: "dom1",
    descKey: "dom1Desc",
    durationS: BATTLE_DURATION_S,
    caps: CAPS_1,
  },
  {
    id: "random-0",
    family: "random",
    labelKey: "encounter",
    descKey: "encounterDesc",
    durationS: BATTLE_DURATION_S,
    caps: CAPS_0,
  },
  {
    id: "ranked",
    family: "ranked",
    labelKey: "ranked",
    descKey: "rankedDesc",
    durationS: BATTLE_DURATION_S,
    caps: CAPS_3,
  },
  {
    id: "clan",
    family: "clan",
    labelKey: "clan",
    descKey: "clanDesc",
    durationS: BATTLE_DURATION_S,
    caps: CAPS_4,
  },
  {
    id: "pve-op",
    family: "pve",
    labelKey: "operation",
    descKey: "operationDesc",
    durationS: BATTLE_DURATION_S,
    caps: [
      cap("A", 0.3, 0.34, { team: "ally" }),
      cap("B", 0.5, 0.5, { station: true, appearT: 120 }),
      cap("C", 0.7, 0.66, { station: true, appearT: 240 }),
    ],
  },
];

export function modePresetOf(id: string | null | undefined): ModePreset | null {
  if (!id) return null;
  return MODE_PRESETS.find((m) => m.id === id) ?? null;
}

/** Instantiate a preset's template onto a concrete playable rect: fractions
 *  become world points. Returns the caps the plan board renders/edits. */
export function instantiateCaps(
  preset: ModePreset,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
): CapSpec[] {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxZ - bounds.minZ;
  return preset.caps.map((c) => ({
    ...c,
    at: { x: bounds.minX + c.at.x * w, z: bounds.minZ + c.at.z * h },
  }));
}

/** Point-reflect a cap set through the map's centre (both axes) with the
 *  sides swapping — the same symmetry the two spawns carry (each fleet
 *  starts on its own edge), so a rotated layout is what "the other end of
 *  the matchup" means here. */
export function mirrorCaps(
  caps: CapSpec[],
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
): CapSpec[] {
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midZ = (bounds.minZ + bounds.maxZ) / 2;
  return caps.map((c) => ({
    ...c,
    at: { x: 2 * midX - c.at.x, z: 2 * midZ - c.at.z },
    team: c.team === "ally" ? "enemy" : c.team === "enemy" ? "ally" : c.team,
  }));
}
