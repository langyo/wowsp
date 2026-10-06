/**
 * Roster side splits that keep scripted scenario NPCs out of every player
 * list.
 *
 * PvE story/operation descriptors (剧情/行动) carry the scenario's scripted
 * allies right inside the roster with `relation = 1` — the story-mode
 * flagship escorts (`IDS_OP_09_FLAGMAN_NAME`, `IDS_OP_17_ALLY_FLAGSHIP`,
 * the escort-op `IDS_OP_15_DUMMY_01` waves). They are not players, so the
 * replay viewer's lists exclude them: the Tab scoreboard, the post-battle
 * matrices, the scorebar strip and the player-count label all read the
 * game's own team size (7 humans on a 7x7 story team, no NPC row). The
 * `:Name:` colon-wrapped co-op bot fills STAY listed — co-op really does
 * field them as team slots and the game's Tab table renders them (with the
 * "bot" chip here).
 *
 * The LIVE surfaces (the live panel, the in-game overlay) re-filter through
 * {@link splitLiveRosterSides} instead — conditionally on the operation
 * classifier, because the two battle families render scripted units
 * differently in-game (both verified against real Tab captures):
 *
 * - real operations (行动, `isOperationBattle` true — the PCVO / _op_ /
 *   _hl_ fingerprints) render the human team ONLY: the story-table capture
 *   of PCVO011_OP_10_s10_USS_CL shows exactly its 7 players in one column,
 *   while the roster carries 2 scripted allies (`IDS_OP_10_09_GAMBLE`,
 *   `IDS_OP_10_10_BREEZE`) the table never draws — so the live lists drop
 *   them there (they used to leak as untranslated-key rows at the end of
 *   the teammates column and mis-slice the overlay's Tab row blocks);
 * - the tutorial-family scripted battles (`low_lvl_operation` /
 *   `first_battle` / the `IDS_OP_15_*` escort op — exactly the shapes
 *   `isOperationBattle` returns false for) field their scripted units as
 *   REAL team rows, rendered under localized names (`IDS_AL_01` → zh
 *   `：舍尔：`) — so the live lists keep them there, and filtering them
 *   would misalign every chip below their sort position.
 *
 * This filter is display-layer ONLY: the raw `vehicles` array must keep the
 * scripted entries, because the mode classifiers
 * (`isOperationBattle` / `modeKey`) scan the roster's `IDS_OP_*` names to
 * fingerprint operation battles in the first place.
 */
import { isScriptedUnitName } from "@/utils/aiNames";

/** Whether a roster entry renders as a listed player row — every entry
 * except the scripted scenario NPCs (`IDS_*` text keys, `#Name`). */
export function isListedPlayer(entry: { name: string }): boolean {
  return !isScriptedUnitName(entry.name);
}

/** A roster entry with the side fields the relation split needs. */
export interface SideCarryingEntry {
  /** 0 = recorder, 1 = ally, 2 = enemy (the WG relation convention). */
  relation: number;
  name: string;
}

export interface RosterSides<T extends SideCarryingEntry> {
  allies: T[];
  enemies: T[];
}

/**
 * Split a roster into ally/enemy lists, dropping the scripted scenario NPCs
 * from both sides. Operations (行动) additionally return an empty enemy
 * list — their enemy block is all scripted spawns, a list nobody reads (the
 * same rule every surface applied before this helper existed). The recorder
 * (relation 0) always lands in `allies` and is never scripted, so `allies`
 * is never empty for a non-empty roster.
 */
export function splitRosterSides<T extends SideCarryingEntry>(
  vehicles: readonly T[],
  operation: boolean,
): RosterSides<T> {
  const listed = vehicles.filter(isListedPlayer);
  return {
    allies: listed.filter((v) => v.relation <= 1),
    enemies: operation ? [] : listed.filter((v) => v.relation > 1),
  };
}

/**
 * The LIVE variant the panel and the in-game overlay resolve against — the
 * side split that mirrors what the game's own Tab table actually renders
 * (see the module docs for the two verified families):
 *
 * - a real operation (行动) renders its human team only, so the scripted
 *   NPCs drop out exactly like in {@link splitRosterSides} and the enemy
 *   side reads empty;
 * - every other battle (PvP, co-op, and the tutorial-family scripted
 *   layouts where the game DOES field the scripted units as team rows)
 *   keeps the RAW relation split — the live row inference, the sink
 *   solver's ally block (Rust `note_arena_seen` mirrors this exact rule)
 *   and the game's rendered rows stay index-aligned.
 *
 * The replay viewer does NOT use this variant — its lists are unconditional
 * ({@link isListedPlayer}): a scripted unit is never a listed player there,
 * whatever the game renders.
 */
export function splitLiveRosterSides<T extends SideCarryingEntry>(
  vehicles: readonly T[],
  operation: boolean,
): RosterSides<T> {
  if (operation) return splitRosterSides(vehicles, true);
  return {
    allies: vehicles.filter((v) => v.relation <= 1),
    enemies: vehicles.filter((v) => v.relation > 1),
  };
}
