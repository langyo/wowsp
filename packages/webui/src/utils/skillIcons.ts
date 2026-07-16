/**
 * Crew-commander skill icon resolution.
 *
 * Icons are extracted from the game's `gui/crew_commander/skills/*.png`
 * (converted to webp) under `src/res/images/skills/<icon>.webp`. We discover
 * them via Vite's glob import keyed by filename stem so a missing asset falls
 * back gracefully to the letter-badge in the UI.
 */
const skillIconModules = import.meta.glob("../res/images/skills/*.{webp,png}", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

const skillIconUrls = new Map<string, string>();
for (const [path, url] of Object.entries(skillIconModules)) {
  const stem = path.split("/").pop()!.replace(/\.(webp|png)$/i, "");
  skillIconUrls.set(stem.toLowerCase(), url);
}

/** Resolve a skill icon URL by its filename stem, or null if absent. */
export function resolveSkillIcon(icon: string | undefined): string | null {
  if (!icon) return null;
  return skillIconUrls.get(icon.toLowerCase()) ?? null;
}
