/**
 * Nicknames that have no Wargaming account and must sit out every stats
 * lookup:
 *
 * - bots render as `:Name:` (colon-wrapped) in every mode;
 * - operation scenario units (行动) keep their client ship/loc key as
 *   nickname — `IDS_OP_15_DUMMY_01`, `IDS_SCENARIO_...` — verified against
 *   the vendored operation replays.
 *
 * Shared by the live panel, the replay views AND the overlay page (which
 * does not load Vue/pinia, so this stays a store-free plain module).
 */
export const AI_NAME = /^(?::.*:|IDS_.*)$/;

export function isAiName(name: string): boolean {
  return AI_NAME.test(name);
}
