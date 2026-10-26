/**
 * Generated asset declaration (scripts/extract_gameparam_ids.py).
 *
 * Numeric GameParams id -> top-level entity code (PCM030_MainWeapon_Mod_I,
 * PCEF019_JW1_SignalFlag, ...). Declared explicitly so tsc never infers the
 * 23 859-key literal type from the JSON.
 *
 * The exact "@/data/..." specifier is deliberate: a wildcard module
 * declaration (leading-star glob form) does NOT shadow a paths-aliased JSON
 * import under this repo's TypeScript (verified with typescript@7.0.2 — the
 * import keeps the full literal type), while the exact specifier does.
 */
declare module "@/data/gameparam_ids.json" {
  const gameparamIds: Record<string, string>;
  export default gameparamIds;
}
