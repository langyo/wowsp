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
 *   raw key, which is what this regex sees).
 *
 * Verified against the vendored operation replays and live 360-server
 * arena files.
 *
 * Shared by the live panel, the replay views AND the overlay page (which
 * does not load Vue/pinia, so this stays a store-free plain module).
 */
export const AI_NAME = /^(?::.*:|IDS_.*)$/;

export function isAiName(name: string): boolean {
  return AI_NAME.test(name);
}
