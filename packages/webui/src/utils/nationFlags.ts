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

/**
 * WG's encyclopedia and GameParams use inconsistent nation codes — PascalCase
 * (`Russia`, `United_Kingdom`, `Pan_America`), while the extracted flag files
 * are lowercase with a different rename (`ussr`, `uk`, `pan_america`). This
 * maps any WG code to the on-disk filename stem so the flag resolves.
 */
const NATION_FILE_MAP: Record<string, string> = {
  // direct lowercase matches
  commonwealth: "commonwealth",
  france: "france",
  germany: "germany",
  italy: "italy",
  japan: "japan",
  netherlands: "netherlands",
  spain: "spain",
  usa: "usa",
  // renames (WG code → on-disk stem)
  russia: "ussr",
  ussr: "ussr",
  europe: "pan_europe",
  pan_europe: "pan_europe",
  united_kingdom: "uk",
  uk: "uk",
  pan_america: "pan_america",
  pan_asia: "pan_asia",
};

/** Normalize a WG nation code to the on-disk filename stem (lowercase). */
function nationFileStem(nation: string): string {
  const key = nation.trim().toLowerCase();
  return NATION_FILE_MAP[key] ?? key;
}

/** Build the public URL for a nation's flag of the given variant. */
export function resolveNationFlag(
  nation: string | undefined,
  variant: NationFlagVariant = "crest",
): string | null {
  if (!nation) return null;
  const stem = nationFileStem(nation);
  const dir = variant === "crest" ? "nations" : "nations_small";
  return `${import.meta.env.BASE_URL}images/${dir}/${encodeURIComponent(stem)}.webp`;
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
