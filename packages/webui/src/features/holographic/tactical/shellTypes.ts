/**
 * Shell + plane encyclopedia lookups shared between the holographic map
 * (shell-flight tinting) and the tactical timeline (action markers).
 * Data is baked from GameParams by `scripts/model_convert/extract_shells.py`
 * and `extract_planes.py`.
 */
import shellTypesRaw from "../../../data/shell_types.json";
import planeTypesRaw from "../../../data/plane_types.json";

/** Shell encyclopedia (paramsId → ammo/tint), shared verbatim. */
export const SHELL_TYPES = shellTypesRaw as Record<
  string,
  { name: string; ammo: string; tint: number[] | null }
>;

/** squadron paramsId → baked GameParams plane info (index/name/type/count):
 *  `type` is the behavioural family (torpedo/dive/fighter/scout/bomber/
 *  attack) driving the in-game icon and the timeline's marker language. */
export const PLANE_TYPES = planeTypesRaw as Record<
  string,
  { index: string; name: string; type: string; count?: number }
>;

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

/** squadron paramsId → behavioural family ("torpedo" | "dive" | …). */
export function planeRoleOf(paramsId?: number): string {
  if (paramsId == null) return "unknown";
  return PLANE_TYPES[String(paramsId)]?.type ?? "unknown";
}
