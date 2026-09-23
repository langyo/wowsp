/**
 * Map-mode buckets for the tactics view.
 *
 * `modeKey()` (utils/modeColors) resolves a battle's fine-grained mode key
 * from its layered identity (matchGroup / scenario / eventType / bots); the
 * tactics rail instead groups MAPS into four coarse buckets — random /
 * ranked / clan / pve — derived from the modes actually played on them
 * (replay history) and from static space-id fingerprints (scenario /
 * special-mode spaces).
 */

export type MapModeBucket = "random" | "ranked" | "clan" | "pve";

/** Collapse a `modeKey()` result into one of the four tactics buckets.
 *  Ranked variants (solo / sprint) stay ranked; clan wars and brawl form
 *  the "clan" family; every PvE-flavoured key (co-op, operations, events,
 *  halloween, training rooms vs bots, sandbox) is pve; everything else
 *  (pvp / squad / armsrace / convoy / asymmetric / unknown) rides
 *  "random" — the same default the replay cards use for unmatched modes. */
export function bucketOf(modeKey: string): MapModeBucket {
  const key = (modeKey ?? "").toLowerCase();
  if (key === "ranked" || key === "ranked_solo" || key === "ranked_sprint") {
    return "ranked";
  }
  if (key === "clan" || key === "brawl") return "clan";
  if (
    key === "cooperative" ||
    key === "pve" ||
    key === "operation" ||
    key === "pve_event" ||
    key === "halloween" ||
    key === "training" ||
    key === "room_bots" ||
    key === "sandbox"
  ) {
    return "pve";
  }
  return "random";
}

/** Static space-id fingerprints of scenario / special-mode maps — those
 *  ship no regular-battle terrain overlay data, so the tactics view flags
 *  them as "incomplete support" regardless of what the replay history
 *  observed. Matches: scenario spaces (`s01_`…`s99_`), operation spaces
 *  (`*_op_*`), halloween spaces, naval-mission spaces, and the
 *  combat-training ocean (`00_co_*`). */
export function isPveSpace(spaceId: string): boolean {
  const id = spaceId ?? "";
  return (
    /^s\d{2}_/i.test(id) ||
    /_op_/i.test(id) ||
    /halloween/i.test(id) ||
    /naval_mission/i.test(id) ||
    /^00_co_/i.test(id)
  );
}
