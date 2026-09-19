/**
 * True-engine-scale ship sizing, shared by the app's replay viewer and the
 * site's baked demo so both render ships at the same size.
 *
 * The WoWS replay world is compressed: 1 world unit ≈ 4.5 m, calibrated from
 * real replays (follow cameras sit ~13 u behind / ~6 u above own ships; ships
 * sustain 3–4.8 u/s ≈ 25–40 kn). Exported GLB units do NOT match world
 * units, so every ship model must be scaled so its hull axis hits the class
 * target below — never a uniform multiplier.
 */

/** Class-average hull lengths in scene units at true engine scale. */
export const SHIP_CLASS_LEN: Record<string, number> = {
  battleship: 50, // ≈ 225 m
  aircarrier: 55, // ≈ 250 m
  cruiser: 40, // ≈ 180 m
  destroyer: 27, // ≈ 120 m
  submarine: 19, // ≈ 85 m
};

/** Target hull length for a WG ship-type string (case-insensitive substring
 *  match, cruiser fallback for unknown/auxiliary types). */
export function shipClassTargetLen(type: string | null | undefined): number {
  const t = (type ?? "").toLowerCase();
  const key = Object.keys(SHIP_CLASS_LEN).find((k) => t.includes(k));
  return SHIP_CLASS_LEN[key ?? "cruiser"];
}
