/**
 * Nation flag (in-game faction emblem) resolution.
 *
 * Ship nation emblems are *game faction crests*, not real-world national
 * flags — e.g. the US "eagle + shield" badge, IJN rising-sun-with-anchor,
 * Pan-Asia's dragon. They live under `src/res/images/nations/<nation>.webp`,
 * which (because `src/res` is Vite's publicDir) is served at runtime from
 * `${BASE_URL}images/nations/<nation>.webp`.
 *
 * Because publicDir assets aren't processed by `import.meta.glob` (and globing
 * `/src/res/...` triggers a Vite warning), we resolve URLs directly from the
 * public root. Existence is handled by the `<NationFlag>` component's image
 * `onerror`, which swaps to the letter fallback.
 */

/** Build the public URL for a nation's flag. */
export function resolveNationFlag(nation: string | undefined): string | null {
  if (!nation) return null;
  return `${import.meta.env.BASE_URL}images/nations/${encodeURIComponent(nation)}.webp`;
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
