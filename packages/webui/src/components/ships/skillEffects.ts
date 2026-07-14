/**
 * Captain-skill → stat-effect mapping for the shipyard's recomputation pipeline.
 *
 * `skillTree.ts` lists skills by human-readable display name (e.g. "Adrenaline
 * Rush"). GameParams stores the actual numeric effects under internal skill
 * codes (e.g. `TriggerGmReload`) in `res/data/skills.json` (extracted from the
 * Crew table). This module bridges the two: it maps each display name to the
 * internal code + how the effect applies (flat multiplier, per-class multiplier,
 * or HP-curve trigger), so `modifierPipeline.ts` can look the modifiers up.
 *
 * Coverage: the surface-ship-relevant skills whose effects land on stats we
 * actually display (HP, reload, range, traverse, concealment, speed, torpedo).
 * Pure-utility skills (Priority Target, Incoming Fire Alert) have no stat delta
 * and are intentionally absent — they simply contribute nothing to the recompute.
 *
 * Effect application kinds:
 *   - "mult"      — multiply the base stat by a coefficient (e.g. traverse ×1.2)
 *   - "triggerHp" — scales with current HP via the Adrenaline-Rush curve:
 *                   at 100% HP the effect is off; it ramps to full at low HP.
 *
 * The internal codes and the per-class coefficient values live in skills.json;
 * this file only records WHICH code each named skill uses and WHICH stat it hits.
 */
import skillData from "../../res/data/skills.json";

/** WoWS ship-class names as they appear in GameParams per-class modifier dicts. */
export type GpClass =
  | "Battleship"
  | "Cruiser"
  | "Destroyer"
  | "AirCarrier"
  | "Submarine"
  | "Auxiliary";

/** Map our SkillClass → GameParams class name. */
export const GP_CLASS: Record<string, GpClass> = {
  BB: "Battleship",
  CA: "Cruiser",
  DD: "Destroyer",
  CV: "AirCarrier",
  SS: "Submarine",
};

/** The display stats a skill can modify (keys into ModifiedStats). */
export type ModStat =
  | "hp"
  | "reload"
  | "range"
  | "traverse"
  | "concealmentShip"
  | "speed"
  | "torpedoSpeed"
  | "hePen"
  | "apDamage"
  | "heDamage"
  | "fireChance"
  | "aaDamage";

export interface SkillEffect {
  /** GameParams internal skill code (key into skills.json). */
  code: string;
  /** Which display stat this skill modifies. */
  stat: ModStat;
  /** How the effect applies. */
  kind: "mult" | "triggerHp";
  /**
   * For "mult" skills: the GameParams modifier key whose value (a per-class
   * dict or a scalar) is the coefficient. For "triggerHp": the modifier key
   * inside the LogicTrigger block (e.g. GMShotDelay for Adrenaline Rush).
   */
  modifierKey: string;
}

/**
 * Display-name → effect mapping. Skills absent here have no recomputable stat
 * effect (pure info/utility skills). Names must match skillTree.ts exactly.
 *
 * The icon column in skillTree.ts hints at the effect but is not unique (e.g.
 * "gm_shell_reload" is reused for Adrenaline Rush AND Dead Eye), so the display
 * name is the authoritative key.
 */
export const SKILL_EFFECTS: Record<string, SkillEffect> = {
  // ── tier 1 ──────────────────────────────────────────────────────────────
  "Grease the Gears": { code: "GmTurn", stat: "traverse", kind: "mult", modifierKey: "GMRotationSpeed" },
  "Gun Feeder": { code: "GmShellReload", stat: "reload", kind: "mult", modifierKey: "switchAmmoReloadCoef" },
  Pyrotechnician: { code: "HeFireProbability", stat: "fireChance", kind: "mult", modifierKey: "artilleryBurnChanceBonus" },
  // ── tier 2 ──────────────────────────────────────────────────────────────
  "Adrenaline Rush": { code: "TriggerGmReload", stat: "reload", kind: "triggerHp", modifierKey: "GMShotDelay" },
  "Swift Fish": { code: "TorpedoSpeed", stat: "torpedoSpeed", kind: "mult", modifierKey: "torpedoSpeedMultiplier" },
  "Survivability Expert": { code: "DefenseHp", stat: "hp", kind: "mult", modifierKey: "healthPerLevel" },
  // ── tier 3 ──────────────────────────────────────────────────────────────
  "Heavy HE/SAP": { code: "HeSapDamage", stat: "heDamage", kind: "mult", modifierKey: "GMHECSDamageCoeff" },
  "Super-Heavy AP": { code: "ApDamageBb", stat: "apDamage", kind: "mult", modifierKey: "GMAPDamageCoeff" },
  "Demolition Expert": { code: "HePenetration", stat: "hePen", kind: "mult", modifierKey: "GMPenetrationCoeffHE" },
  "Long-Range Firing": { code: "GmRangeAaDamageBubbles", stat: "range", kind: "mult", modifierKey: "GMMaxDist" },
  "Close-Quarters Expert": { code: "GmRangeAaDamageBubbles", stat: "range", kind: "mult", modifierKey: "GMMaxDist" },
  // ── tier 4 ──────────────────────────────────────────────────────────────
  "Concealment Expert": { code: "DetectionVisibilityRange", stat: "concealmentShip", kind: "mult", modifierKey: "visibilityDistCoeff" },
  // CV / sub-specific (mapped but only active on those classes)
  "Improved Engines": { code: "PlanesSpeed", stat: "speed", kind: "mult", modifierKey: "planeSpeedMultiplier" },
  "Torpedo Bomber": { code: "PlanesTorpedoSpeed", stat: "torpedoSpeed", kind: "mult", modifierKey: "planeTorpedoSpeedMultiplier" },
};

/** Shape of a skills.json entry. */
interface SkillJsonEntry {
  modifiers: Record<string, unknown>;
  trigger: { type: string; modifiers: Record<string, unknown> } | null;
}

const SKILLS = skillData as Record<string, SkillJsonEntry>;

/**
 * Resolve a per-class modifier value. GameParams stores modifiers either as a
 * scalar (applies to all classes) or a `{ClassName: coeff}` dict. Returns null
 * if the modifier/class isn't present.
 */
export function resolveModifier(
  code: string,
  modifierKey: string,
  gpClass: GpClass,
): number | null {
  const entry = SKILLS[code];
  if (!entry) return null;
  const mods = entry.modifiers;
  if (!(modifierKey in mods)) return null;
  const v = mods[modifierKey];
  if (typeof v === "number") return v;
  if (v && typeof v === "object") {
    const perClass = v as Record<string, number>;
    if (gpClass in perClass) return perClass[gpClass];
  }
  return null;
}

/** Resolve a trigger-skill's full-strength coefficient (e.g. Adrenaline Rush's
 *  GMShotDelay at minimum HP). The actual applied value scales with HP via the
 *  curve in modifierPipeline.ts. */
export function resolveTriggerModifier(
  code: string,
  modifierKey: string,
): number | null {
  const entry = SKILLS[code];
  if (!entry?.trigger) return null;
  const v = entry.trigger.modifiers[modifierKey];
  return typeof v === "number" ? v : null;
}

/** Does a named skill have a recomputable stat effect? */
export function hasSkillEffect(displayName: string): boolean {
  return displayName in SKILL_EFFECTS;
}
