/**
 * Nation flag (in-game faction emblem) resolution.
 *
 * Ship nation emblems are *game faction crests*, not real-world national
 * flags. There are two variants, both extracted from the game client:
 *
 *   crest  — the large vertical faction crest (700×915) from
 *            `/gui/nation_flag_tree/`. Used in the tech-tree view's nation
 *            switcher and the ship-detail header.
 *   flag   — the small rectangular list-view flag (~150-266 KB) from
 *            `/gui/nation_flags/small/`. Used on compact ship cards.
 *
 * Both live under `src/res/images/` (Vite publicDir), served at runtime from
 * `${BASE_URL}images/...`. Existence is handled by `<NationFlag>`'s image
 * `onerror`, which swaps to the letter fallback.
 */
export type NationFlagVariant = "crest" | "flag";

/** Build the public URL for a nation's flag of the given variant. */
export function resolveNationFlag(
  nation: string | undefined,
  variant: NationFlagVariant = "crest",
): string | null {
  if (!nation) return null;
  const dir = variant === "crest" ? "nations" : "nations_small";
  return `${import.meta.env.BASE_URL}images/${dir}/${encodeURIComponent(nation)}.webp`;
}

/**
 * A short (1-2 char) glyph for the circular fallback when no flag PNG is
 * installed. Uses the nation's i18n label initial when available, else the
 * first letter of the WG code.
 */
export function nationInitial(code: string, label: string): string {
  const trimmed = (label || code || "?").trim();
  return trimmed.charAt(0).toUpperCase();
}
