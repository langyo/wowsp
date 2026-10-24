/**
 * Player-friendly carrier-aircraft specification extraction.
 *
 * The ship-detail Specifications tab normally renders the hull's params
 * (shipSpecs.ts). When the 3D stage's model dropdown is switched from the hull
 * to one of the ship's carrier aircraft, the same panel must show that
 * airframe instead: the raw GameParams fields a plane entity carries
 * (maxHealth, numPlanesInSquadron, hangarSettings, speedMoveWithBomb, the
 * carried projectile's damage formulas ...) mean nothing to a player and are
 * not even shaped like the ship profile the panel already renders.
 *
 * This module turns one baked plane_specs.json row into the same grouped,
 * labelled, unit-formatted SpecGroup tree the hull uses, so SpecsPanel can
 * render either source with a single template. The table is baked from the WG
 * GameParams dump (plus the Lesta dump for Lesta-only airframes) by
 * scripts/model_convert/extract_plane_specs.py; it is keyed by the airframe
 * index because that is what the picker and the baked GLBs use.
 *
 * Every label is an i18n key under ships.spec.* (resolved by the component
 * via t()), so this module emits keys + pre-formatted values only and stays
 * Vue-free and dependency-free - exactly like shipSpecs.ts.
 */
import type { SpecGroup, SpecRow } from "./shipSpecs";
import planeSpecsDb from "@/data/plane_specs.json";

/**
 * One baked airframe row (see packages/webui/src/data/plane_specs.json).
 * Every field is optional: ammunitionless airframes (scouts, some fighters)
 * have no weapon rows at all, and older bands of the table may predate a
 * field, so the builder below only renders what is actually present.
 */
export interface PlaneSpecEntry {
  /** Hit points of a single aircraft. */
  hp?: number;
  /** Aircraft in the squadron (deck capacity of the squadron). */
  squadron?: number;
  /** Aircraft in the attacking flight. */
  flight?: number;
  /** Aircraft carried on deck (hangar capacity). */
  deck?: number;
  /** Seconds to restore one aircraft, 1 decimal. */
  regen?: number;
  /** Preparation/aiming time in seconds, 1 decimal. */
  prep?: number;
  /** Attack cooldown in seconds, 1 decimal. */
  cooldown?: number;
  /** Cruise speed in knots. */
  cruise?: number;
  /** Maximum speed in knots (cruise × the entity's speedMax multiplier). */
  maxSpeed?: number;
  /** Detectability in km, 1 decimal. */
  detect?: number;
  /** Payload per attack: attackCount × projectilesPerAttack. */
  payload?: number;
  /** Ammunition family: "bomb" | "torpedo" | "rocket" | "skipBomb" | "depthcharge" | "mine"
   *  | "drop" (supply-drop airframes; metadata only, no weapon rows are rendered). */
  ammo?: string;
  /** Projectile ammoType ("HE" / "AP") when the ammunition carries one. */
  ammoType?: string;
  /** Damage per hit: HE/AP bombs + rockets use alphaDamage; torpedoes use
   *  alphaDamage / TORPEDO_DAMAGE_CONSTANT + the flooding portion. */
  damage?: number;
  /** HE armour penetration in mm (bombs / rockets, floored). */
  pen?: number;
  /** Fire chance in percent (bombs / rockets). */
  fire?: number;
  /** Torpedo speed in knots. */
  torpSpeed?: number;
  /** Torpedo range in km, 1 decimal. */
  torpRange?: number;
  /** Torpedo detectability in km, 1 decimal. */
  torpDetect?: number;
  /** Flood chance in percent (torpedoes). */
  flood?: number;
}

const PLANE_SPECS = planeSpecsDb as Record<string, PlaneSpecEntry | undefined>;

/** Format an integer display value; thousands separators above 999. */
function fmtInt(value: number | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** Seconds, always one decimal (shipSpecs.ts convention: times are 1 dp). */
function fmtSeconds(value: number | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `${value.toFixed(1)} s`;
}

/** Distances: km, one decimal. */
function fmtKm(value: number | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `${value.toFixed(1)} km`;
}

/** Speeds: knots, whole number (aircraft cruise/max and torpedo speed). */
function fmtKnots(value: number | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `${Math.round(value)} kn`;
}

/** Armour thickness: mm, whole number. */
function fmtMillimetres(value: number | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `${Math.round(value)} mm`;
}

/** Percentages (fire / flood chance). */
function fmtPercent(value: number | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `${Math.round(value)}%`;
}

/** Append a row when the formatted value exists (missing stats stay absent
 *  rather than rendering an empty "—" row). */
function pushRow(rows: SpecRow[], key: string, value: string | null): void {
  if (value != null) rows.push({ key, value });
}

/** Baked spec row for one airframe index (the 3D picker's model value), or
 *  null when the table has no entry for it (unbaked / unknown airframe). */
export function planeSpecEntry(index: string): PlaneSpecEntry | null {
  return PLANE_SPECS[index] ?? null;
}

/**
 * i18n key for the aircraft hint's guidance line — which control actually
 * switches the staged model, given how the stage is currently presented.
 * The model picker only renders on an EXPANDED 3D stage (ShipStage guards it
 * with `!hidden && viewMode === "3d"`; the portable build can never enable
 * 3D, and the caller hides the hint entirely there), so:
 *  - collapsed stage  → ask the user to expand the preview;
 *  - 2D portrait mode → ask the user to switch back to 3D;
 *  - expanded 3D      → the literal dropdown at the top of the 3D panel.
 */
export function aircraftNoticeSwitchKey(stageHidden: boolean, viewMode: "2d" | "3d"): string {
  if (stageHidden) return "ships.detail.aircraftNotice.switchExpand";
  if (viewMode === "2d") return "ships.detail.aircraftNotice.switchBack3d";
  return "ships.detail.aircraftNotice.switch3d";
}

/**
 * Build the player-friendly spec tree for one airframe index.
 * Returns groups in display order; groups without rows are omitted, so a
 * scout simply has no "Aircraft Armament" / "Attack" cards rather than
 * empty ones. Unknown indexes return [] (the panel shows its "no specs for
 * this aircraft" message).
 */
export function buildPlaneSpecs(index: string): SpecGroup[] {
  const entry = planeSpecEntry(index);
  if (!entry) return [];
  const groups: SpecGroup[] = [];

  // ── Survivability ─────────────────────────────────────────────────────
  const survivability: SpecRow[] = [];
  pushRow(survivability, "aircraftHp", fmtInt(entry.hp));
  pushRow(survivability, "aircraftSquadron", fmtInt(entry.squadron));
  pushRow(survivability, "aircraftOnDeck", fmtInt(entry.deck));
  pushRow(survivability, "aircraftRegen", fmtSeconds(entry.regen));
  if (survivability.length)
    groups.push({ group: "survivability", icon: "Shield", rows: survivability });

  // ── Mobility ──────────────────────────────────────────────────────────
  const mobility: SpecRow[] = [];
  pushRow(mobility, "aircraftCruiseSpeed", fmtKnots(entry.cruise));
  // Reuses the hull's "Maximum Speed" label (ships.spec.maxSpeed).
  pushRow(mobility, "maxSpeed", fmtKnots(entry.maxSpeed));
  if (mobility.length) groups.push({ group: "mobility", icon: "Gauge", rows: mobility });

  // ── Concealment ───────────────────────────────────────────────────────
  const concealment: SpecRow[] = [];
  pushRow(concealment, "aircraftDetect", fmtKm(entry.detect));
  if (concealment.length)
    groups.push({ group: "concealment", icon: "Eye", rows: concealment });

  // ── Aircraft Armament ─────────────────────────────────────────────────
  // The weapon rows depend on the ammunition family: bombs / rockets show
  // damage + HE pen + fire, torpedoes show damage + flood + speed / range /
  // detectability, and ammunitionless aircraft show no group at all.
  const weapon: SpecRow[] = [];
  if (entry.ammoType === "HE" || entry.ammoType === "AP")
    weapon.push({ key: "ammoType", value: entry.ammoType });
  pushRow(weapon, "aircraftDamage", fmtInt(entry.damage));
  pushRow(weapon, "aircraftPenetration", fmtMillimetres(entry.pen));
  pushRow(weapon, "aircraftFireChance", fmtPercent(entry.fire));
  pushRow(weapon, "aircraftFloodChance", fmtPercent(entry.flood));
  pushRow(weapon, "torpSpeed", fmtKnots(entry.torpSpeed));
  pushRow(weapon, "torpRange", fmtKm(entry.torpRange));
  pushRow(weapon, "torpDetect", fmtKm(entry.torpDetect));
  if (weapon.length) groups.push({ group: "aircraftWeapon", icon: "Crosshair", rows: weapon });

  // ── Attack ────────────────────────────────────────────────────────────
  const attack: SpecRow[] = [];
  pushRow(attack, "aircraftFlightSize", fmtInt(entry.flight));
  pushRow(attack, "aircraftPayload", fmtInt(entry.payload));
  pushRow(attack, "aircraftPrepTime", fmtSeconds(entry.prep));
  pushRow(attack, "aircraftCooldown", fmtSeconds(entry.cooldown));
  if (attack.length) groups.push({ group: "aircraftAttack", icon: "Target", rows: attack });

  return groups;
}
