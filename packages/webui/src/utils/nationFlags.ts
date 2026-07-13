/**
 * Nation flag (in-game faction emblem) resolution.
 *
 * Ship nation emblems are *game faction crests*, not real-world national
 * flags — e.g. the US "eagle + shield" badge, IJN rising-sun-with-anchor,
 * Pan-Asia's dragon. The user supplies these as PNGs unpacked from the game
 * client, dropped into `src/res/images/nations/<nation>.png` using the same
 * WG `nation` code strings the encyclopedia returns (usa, japan, ussr, …).
 *
 * This mirrors `resolveShipImage`'s Vite glob pattern: discover every PNG
 * under the nations folder at build time, key by filename stem, and expose a
 * resolver. When a flag is absent we return null and the caller renders a
 * graceful initial-letter fallback so the UI is never broken by a missing
 * asset.
 */
// Accept both .webp (preferred, smaller) and legacy .png so adding the webp
// set never breaks a checkout that still has the old PNGs around.
const flagModules = import.meta.glob("/src/res/images/nations/*.{webp,png}", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Map: nation code (WG string, e.g. "usa") → local flag URL. */
const flagUrls = new Map<string, string>();
for (const [path, url] of Object.entries(flagModules)) {
  const stem = path.split("/").pop()!.replace(/\.png$/i, "");
  flagUrls.set(stem.toLowerCase(), url);
}

/** Resolve a nation's emblem URL, or null if no asset exists. */
export function resolveNationFlag(nation: string | undefined): string | null {
  if (!nation) return null;
  return flagUrls.get(nation.toLowerCase()) ?? null;
}

/** Whether a flag asset is available for a nation. */
export function hasNationFlag(nation: string | undefined): boolean {
  if (!nation) return false;
  return flagUrls.has(nation.toLowerCase());
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
