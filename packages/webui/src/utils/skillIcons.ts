/**
 * Crew-commander skill icon resolution.
 *
 * Icons are extracted from the game's `gui/crew_commander/skills/*.png`
 * (converted to webp) under `src/res/images/skills/<icon>.webp`. Since
 * `src/res` is Vite's publicDir, they are served at
 * `/images/skills/<icon>.webp`. We discover available icons lazily from
 * glob keys — no eager import.
 */
const _skillGlobKeys = Object.keys(
  import.meta.glob("../res/images/skills/*.{webp,png}"),
);
const skillIconStems = new Set<string>();
for (const path of _skillGlobKeys) {
  skillIconStems.add(
    path.split("/").pop()!.replace(/\.(webp|png)$/i, "").toLowerCase(),
  );
}

/** Resolve a skill icon public URL by its filename stem, or null if absent. */
export function resolveSkillIcon(icon: string | undefined): string | null {
  if (!icon) return null;
  const key = icon.toLowerCase();
  return skillIconStems.has(key) ? `/images/skills/${key}.webp` : null;
}
