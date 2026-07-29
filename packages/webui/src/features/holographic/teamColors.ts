/**
 * Team role colors for the replay holographic map.
 *
 * Each ship on the map is tinted by its team role (self / ally / enemy) rather
 * than the old binary ally-vs-enemy split. The numeric colors mirror the app's
 * design tokens (`theme.scss`): green = success, blue = primary, yellow =
 * warning. Three.js materials consume `0xRRGGBB` integers, so the tokens are
 * baked to numbers here once.
 *
 * `holoColorsFor(role)` pairs each role with a {baseColor, fresnelColor} tuned
 * for the holographic shader (`holoShader.ts`): baseColor is the darker body
 * tint, fresnelColor the brighter rim/scanline accent. Both are derived from
 * the role's primary color.
 */

/** Team role of a ship on the map. `self` = the recorder; `ally`/`enemy` the rest. */
export type TeamRole = "self" | "ally" | "enemy";

/** Numeric (Three.js) team colors. */
export const TEAM_COLOR: Record<TeamRole, number> = {
  self: 0xffffff, // white
  ally: 0x3cb478, // green
  enemy: 0xcc3333, // red
};

/** Per-role holographic tint pairs. */
const HOLO_PAIRS: Record<TeamRole, HoloColorPair> = {
  self: { baseColor: 0x555555, fresnelColor: 0xffffff },
  ally: { baseColor: 0x0e5a3a, fresnelColor: 0x4fff95 },
  enemy: { baseColor: 0x4a1515, fresnelColor: 0xff4444 },
};

/** Resolve the holographic color pair for a team role. */
export function holoColorsFor(role: TeamRole): HoloColorPair {
  return HOLO_PAIRS[role];
}

/** Classify a roster `relation` value into a team role.
 *  relation 0 = self (the recorder), 1 = ally, 2+ = enemy. */
export function roleFromRelation(relation: number): TeamRole {
  if (relation <= 0) return "self";
  if (relation === 1) return "ally";
  return "enemy";
}
