/**
 * Map the mod-hub guards' known English sentences onto their localized
 * message keys.
 *
 * Both guards (safe-mode quarantine, game client running) are backend
 * anyhow Display strings. The webui normally intercepts them with its own
 * pre-checks before any RPC, but that is not a guarantee: a stale
 * boot-time game-status snapshot can let the real refusal through, and a
 * race between the pre-check and the command can do the same. The shared
 * error contract (see tError) is key-or-raw — a message KEY renders
 * localized, a sentence renders verbatim — and tauri_shared/src/error.rs
 * explicitly leaves room for the webui to string-match parts of this text,
 * so recognizing the two known guard sentences here closes that gap
 * without touching the backend.
 *
 * The mapping is deliberately narrow: ONLY these two known sentences. A
 * loose match would swallow unrelated backend errors into a misleading
 * localized line, and an honest English sentence is still better than a
 * wrong localized one. Everything unrecognized returns null and stays raw.
 */

/** The two known mod-hub guard sentences and their message keys. */
const GUARD_SENTENCES: ReadonlyArray<readonly [needle: string, key: string]> = [
  // commands/mod_hub/mod.rs `ensure_res_mods_active` — res_mods is
  // quarantined by safe mode, so every mutation is refused.
  ["safe mode is active", "resources.safeModeBlock"],
  // The shared "game client running" refusal (ensure_game_closed): the
  // sentence names the install the client runs from.
  ["is running from", "resources.gameRunningBlock"],
];

/**
 * The localized message key for a recognized mod-hub guard refusal, or
 * null when the text is not one of the two known sentences (the caller
 * keeps it raw per the key-or-raw contract).
 */
export function guardRefusalKey(text: string): string | null {
  // Case-insensitive on purpose: the sentences are assembled from several
  // anyhow contexts, and a capitalized variant must not slip through as an
  // untranslated English line. The needles stay narrow enough that this
  // cannot swallow an unrelated error.
  const lower = text.toLowerCase();
  for (const [needle, key] of GUARD_SENTENCES) {
    if (lower.includes(needle)) return key;
  }
  return null;
}
