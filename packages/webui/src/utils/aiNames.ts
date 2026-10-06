/**
 * Nicknames that have no Wargaming account and must sit out every stats
 * lookup:
 *
 * - bots render as `:Name:` (colon-wrapped) in every mode;
 * - scripted scenario units keep their client text key as nickname —
 *   classic operations (行动) carry `IDS_SCENARIO_...`-style keys, while
 *   the new-account battles field them too (tutorial `IDS_AL_01`/
 *   `IDS_EN_01`, escort op `IDS_OP_15_DUMMY_01`; in-game they render
 *   under localized names like `：舍尔：`, but the ARENA file keeps the
 *   raw key, which is what this regex sees);
 * - some scenario clients field the `#Name` style instead of a text key —
 *   an account nickname can never start with `#`, so it is safe to treat
 *   every `#`-prefixed nickname as a scripted unit.
 *
 * Verified against the vendored operation replays and live 360-server
 * arena files.
 *
 * Shared by the live panel, the replay views AND the overlay page (which
 * does not load Vue/pinia, so this stays a store-free plain module).
 */
export const AI_NAME = /^(?::.*:|IDS_.*|#.+)$/;

export function isAiName(name: string): boolean {
  return AI_NAME.test(name);
}

/**
 * The scripted-scenario half of `AI_NAME` (text key / `#Name`, WITHOUT the
 * `:Name:` colon-wrapped co-op bot fills).
 *
 * The two halves live different lives in the UI: a `:Name:` bot IS a listed
 * roster player (co-op fills the missing team slots with them — the game's
 * own Tab table renders them, so every roster here lists them too, with the
 * "bot" chip), while a scripted unit is a scenario NPC — the story-mode
 * flagship escorts (`IDS_OP_09_FLAGMAN_NAME`, `IDS_OP_17_ALLY_FLAGSHIP`),
 * operation dummy waves, tutorial fleets. The replay viewer treats them as
 * non-players: every player list filters them out (utils/rosterSides) and
 * their map labels read the ship name. The LIVE surfaces filter them
 * conditionally (utils/rosterSides's `splitLiveRosterSides`): real
 * operations (行动) render their human team only, so the scripted units
 * drop out there too, while the tutorial-family scripted battles field
 * them as real (localized-name) team rows and keep them listed.
 */
export const SCRIPTED_UNIT_NAME = /^(?:IDS_.*|#.+)$/;

export function isScriptedUnitName(name: string): boolean {
  return SCRIPTED_UNIT_NAME.test(name);
}
