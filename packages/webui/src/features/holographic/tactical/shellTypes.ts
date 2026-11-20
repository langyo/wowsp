/**
 * Shell + plane encyclopedia lookups shared between the holographic map
 * (shell-flight tinting) and the tactical timeline (action markers).
 * Data is baked from GameParams by `scripts/model_convert/extract_plane_types.py`
 * (+ the Lesta/WG table mergers `extract_lesta_planes.py` / `extract_wg_planes.py`).
 */
import shellTypesRaw from "../../../data/shell_types.json";
import planeTypesRaw from "../../../data/plane_types.json";

/** Shell encyclopedia (paramsId → ammo/tint), shared verbatim. */
export const SHELL_TYPES = shellTypesRaw as Record<
  string,
  { name: string; ammo: string; tint: number[] | null }
>;

/** One baked `plane_types.json` row. */
export interface PlaneTypeRow {
  index: string;
  name: string;
  type: string;
  count?: number;
  /** GameParams ammo/role family — the fine-grained label the squadron
   *  panel shows (torpedo / rocket / heBomber / apBomber / asw / mine /
   *  scout / dive / ...). `type` stays the coarse icon family. */
  role?: string;
  /** Row belongs to the Lesta client's table merge (extract_lesta_planes.py). */
  lesta?: boolean;
}

/** The coarse battle-HUD family for one baked row.
 *
 *  A torpedo squadron's GameParams species is literally "Bomber" — the
 *  airframe entity is a bomber whose carried ammunition is a torpedo
 *  (`bombName` → a projectile with `planeAmmoType`/`ammoType` "torpedo").
 *  The bakers project species+ammo into the icon family and already know
 *  that: `scripts/model_convert/extract_lesta_planes.py` `plane_type()` maps
 *  species "Bomber" + role "torpedo" → "torpedo" (extract_wg_planes.py reuses
 *  the same function). The LEGACY rows baked before that rule kept the
 *  species-derived "bomber": 91 of the 152 `role: "torpedo"` rows, so those
 *  airframes painted the AP-bomber icon (planeIcons.ts `bomber`) and the
 *  "AP bombers" hover label (MinimapHoverTip PLANE_TYPE_KEY `bomber`) while
 *  their ammo-derived role already said torpedo. Reported on the VIII
 *  Shokaku, whose FIRST-launched squadrons are torpedo bombers (PJAB108 /
 *  PJAB208: species "Bomber", ammo "torpedo"; the 14.5.0.0 reference replay
 *  `20250708_192303_PJSA108-Shokaku_37_Ridge` opens with paramsId 4076830416
 *  at t=30.7 s) that showed up as bombers. Re-project the family from the
 *  ammo-derived role here so every row — legacy, freshly baked, or Lesta —
 *  answers the same way; `index` / `name` / `count` / `role` stay verbatim. */
function planeTypeFamily(row: PlaneTypeRow): string {
  return row.role === "torpedo" && row.type === "bomber" ? "torpedo" : row.type;
}

/** squadron paramsId → baked GameParams plane info (index/name/type/count):
 *  `type` is the behavioural family (torpedo/dive/fighter/scout/bomber/
 *  attack) driving the in-game icon and the timeline's marker language,
 *  normalised by planeTypeFamily above. */
export const PLANE_TYPES: Record<string, PlaneTypeRow> = Object.fromEntries(
  Object.entries(planeTypesRaw as Record<string, PlaneTypeRow>).map(([id, row]) => [
    id,
    { ...row, type: planeTypeFamily(row) },
  ]),
);

/** The airframe's FULL squadron strength: the GameParams `count` on the
 *  plane_types row — the same number plane_specs calls `squadron`, i.e. the
 *  wing size the airframe launches at a full deck. This is the HUD's
 *  denominator and the panel's slot count, NOT the launched count, which is
 *  lower when the hangar is depleted (2026-11-12 review: 全部按满编组来，
 *  而且是按该机种的角度). Returns null for an unknown paramsId so callers
 *  fall back to the decoded launch size. */
export function planeFullStrength(paramsId: number | undefined): number | null {
  if (paramsId == null) return null;
  const n = PLANE_TYPES[String(paramsId)]?.count;
  return typeof n === "number" && n > 0 ? n : null;
}

/** Shell-flight colors per ammo family: HE yellow, AP silver, SAP grey. */
export const SHELL_COLORS: Record<string, number> = {
  HE: 0xffcc33,
  AP: 0xc8d0e0,
  SAP: 0x9aa0a8,
  CS: 0xffa07a,
  unknown: 0xffe08a,
};

/** Resolve a shell's ammo family (+ hex tint) from its GameParams id. SAP
 *  shells are stored as AP in the game data — detect them by name. */
export function shellAmmoOf(paramsId?: number): { ammo: string; color: number } {
  if (paramsId == null) return { ammo: "unknown", color: SHELL_COLORS.unknown };
  const info = SHELL_TYPES[String(paramsId)];
  if (!info) return { ammo: "unknown", color: SHELL_COLORS.unknown };
  const ammo =
    info.ammo === "AP" && info.name.toUpperCase().includes("SAP") ? "SAP" : info.ammo;
  return { ammo, color: SHELL_COLORS[ammo] ?? SHELL_COLORS.unknown };
}

/** Reverse of the SHELL_COLORS tint map: flight states store only the
 *  resolved color, and the below-hull status rows want the ammo family. */
export function ammoOfColor(color: number): string {
  for (const [ammo, hex] of Object.entries(SHELL_COLORS)) {
    if (hex === color) return ammo;
  }
  return "unknown";
}

/** squadron paramsId → behavioural family ("torpedo" | "dive" | …). */
export function planeRoleOf(paramsId?: number): string {
  if (paramsId == null) return "unknown";
  return PLANE_TYPES[String(paramsId)]?.type ?? "unknown";
}
