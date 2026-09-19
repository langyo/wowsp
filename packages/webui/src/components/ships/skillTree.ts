/**
 * Captain skill tree — data-driven view over `src/data/skilltree.json`
 * (extracted from the game's Crew table by
 * `scripts/extract/build_planner_data.py`).
 *
 * Each ship class (BB / CA / DD / CV / SS) has its own 4-tier tree. A skill
 * carries:
 *   - `code`   — the GameParams skill code (e.g. `GmShellReload`); doubles as
 *                the key into `data/skills.json` for numeric effects.
 *   - `tier`   — 1..4, the row it sits on. Unlock rules: tier-2 needs ≥1 pt
 *                spent in tier-1; tier-3 needs ≥2 pts in tiers 1..2; tier-4
 *                needs ≥3 pts in tiers 1..3.
 *   - `column` — horizontal position within the tier row.
 *   - `name` / `desc` — localized display strings keyed by language
 *                (`en` / `ja` / `zh` / `tw`); either may be blank.
 *
 * Icons are the real in-game skill art under `src/res/images/skills/<icon>.webp`,
 * named with the snake_case form of the skill code; resolved by `skillIconUrl`.
 * The commander budget is 21 pts, matching the in-game system.
 */
import skilltreeData from "../../data/skilltree.json";

export type SkillClass = "BB" | "CA" | "DD" | "CV" | "SS";

export interface Skill {
  /** GameParams skill code (key into skills.json / icon stem). */
  code: string;
  tier: number;
  /** Horizontal slot within the tier row. */
  column: number;
  /** Localized short names, keyed by language code (en / ja / zh / tw). */
  name: Record<string, string>;
  /** Localized descriptions, same keys; may be blank. */
  desc: Record<string, string>;
}

/** Map a WG ship `type` to a skill-class. Auxiliaries fall back to cruiser. */
export function skillClassFor(shipType: string): SkillClass {
  switch (shipType) {
    case "Battleship":
      return "BB";
    case "Cruiser":
      return "CA";
    case "Destroyer":
      return "DD";
    case "AirCarrier":
      return "CV";
    case "Submarine":
      return "SS";
    default:
      return "CA";
  }
}

/** Points required in tiers below N to unlock tier N. */
export const TIER_UNLOCK: Record<2 | 3 | 4, number> = { 2: 1, 3: 2, 4: 3 };

/** Total commander budget. */
export const SKILL_BUDGET = 21;

/** Per-class skill list from skilltree.json (tier-ascending, stable order). */
const CLASS_SKILLS = skilltreeData as Record<SkillClass, Skill[]>;

/** Get a class's skill list. Unknown classes yield an empty list. */
export function classSkills(cls: SkillClass): Skill[] {
  return CLASS_SKILLS[cls] ?? [];
}

// ── Icon resolution ───────────────────────────────────────────────────────
// `src/res` is Vite's publicDir, so skill art is served at
// `/images/skills/<stem>.webp`. We discover available icons lazily from glob
// keys — no eager import — and convert skill codes to their snake_case stems.
const _skillGlobKeys = Object.keys(
  import.meta.glob("../../res/images/skills/*.{webp,png}"),
);
const skillIconStems = new Set<string>();
for (const path of _skillGlobKeys) {
  skillIconStems.add(path.split("/").pop()!.replace(/\.(webp|png)$/i, "").toLowerCase());
}

/** PascalCase skill code → snake_case icon stem (`GmShellReload` →
 *  `gm_shell_reload`; uppercase runs like `Aa` collapse to `aa`). */
function codeToStem(code: string): string {
  return code.split(/(?=[A-Z])/).join("_").toLowerCase();
}

/** Resolve a skill's real icon public URL, or null if the art is absent.
 *  Some skills share one art family across classes with a per-class variant
 *  file (`<stem>_<bb|ca|dd|cv|ss>.webp`) instead of a base image — try the
 *  base stem first, then the class variant. */
export function skillIconUrl(code: string, cls?: SkillClass): string | null {
  const stem = codeToStem(code);
  if (skillIconStems.has(stem)) return `/images/skills/${stem}.webp`;
  if (cls) {
    const variant = `${stem}_${cls.toLowerCase()}`;
    if (skillIconStems.has(variant)) return `/images/skills/${variant}.webp`;
  }
  return null;
}

// ── Hull-gated skills ─────────────────────────────────────────────────────
// A few skills only make sense on hulls that carry the matching armament;
// picking them on a hull without it would be a wasted point. The table is
// deliberately small: consumable-gated skills like ConsumablesSpotterUpgrade
// (空中之眼) depend on catapult-aircraft loadouts the WG API does not expose,
// so they stay enabled rather than being wrongly banned.
export type SkillRequirement = "torpedoes" | "aa" | "aaOrAsw";

const SKILL_REQUIREMENTS: Record<string, SkillRequirement> = {
  TorpedoSpeed: "torpedoes",
  TorpedoReload: "torpedoes",
  TorpedoFloodingProbability: "torpedoes",
  TorpedoDamage: "torpedoes",
  AaPrioritysectorDamageConstant: "aa",
  AaDamageConstantBubbles: "aaOrAsw",
};

/** Which hull capability a skill needs, or null when it is always pickable. */
export function skillUnavailable(
  skillCode: string,
  profile: Record<string, any> | null | undefined,
): SkillRequirement | null {
  const req = SKILL_REQUIREMENTS[skillCode];
  if (!req) return null;
  // profile is the raw WG snake_case default_profile (same reads as
  // shipCompare's groupApplies).
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const has = (v: unknown): boolean => v != null && typeof v === "object";
  switch (req) {
    case "torpedoes":
      return (num(profile?.hull?.torpedoes_barrels) ?? 0) > 0 || has(profile?.torpedoes)
        ? null
        : "torpedoes";
    case "aa":
      return (num(profile?.anti_aircraft?.defense) ?? 0) > 0 ? null : "aa";
    case "aaOrAsw":
      return (num(profile?.anti_aircraft?.defense) ?? 0) > 0 || has(profile?.depth_charge)
        ? null
        : "aaOrAsw";
  }
}
