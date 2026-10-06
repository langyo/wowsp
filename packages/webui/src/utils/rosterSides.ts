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
 * Deliberately NOT applied to the live surfaces (overlay/main.ts's row
 * inference, LiveBattlePanel's sink-attribution order): those map names
 * onto the GAME's actually-rendered Tab rows, and the game DOES render
 * scripted units as (localized-name) table rows — see overlay/inferredOrder's
 * module docs — so filtering there would misalign every chip below the
 * NPC's sort position. The replay viewer has no such alignment dependency.
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
