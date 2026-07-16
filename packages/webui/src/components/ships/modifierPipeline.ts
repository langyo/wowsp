/**
 * Captain-skill modifier pipeline for the shipyard. Takes the ship's base
 * `default_profile` + a skill-point allocation + the current-HP percentage
 * (for Adrenaline-Rush-type trigger skills) and produces a set of recomputed
 * display stats, so the shipyard panel can show "what your skills actually do".
 *
 * This is a 浩舰-style first pass: skills only (equipment/upgrades/flags are
 * stubbed — the modifier application is already general enough to take them
 * later). Only stats we actually display are recomputed (HP, reload, range,
 * traverse, concealment, speed, torpedo speed).
 *
 * Modifier application rules (WoWS convention):
 *   - "mult" skills multiply the base value by a per-class coefficient.
 *     Multiple multipliers stack multiplicatively (stat *= coef for each).
 *   - "triggerHp" skills (Adrenaline Rush) scale with current HP: at 100% HP
 *     the effect is dormant; it ramps linearly to full strength as HP drops.
 *     The stored coefficient (e.g. GMShotDelay 0.9) is the FULL effect at the
 *     trigger threshold, so applied = base * (1 - (1-coef) * (1 - hpFrac)).
 */
import type { Profile } from "./shipSpecs";
import {
  SKILL_EFFECTS,
  GP_CLASS,
  resolveModifier,
  resolveTriggerModifier,
  type GpClass,
  type ModStat,
} from "./skillEffects";

export interface ModifiedStats {
  hp: number | null;
  reload: number | null;       // main-battery reload, seconds
  range: number | null;        // main-battery range, km
  traverse: number | null;     // turret traverse, s/180°
  concealmentShip: number | null; // surface detectability, km
  speed: number | null;        // top speed, knots
  torpedoSpeed: number | null; // torpedo speed, knots
}

/** Read the base stat values from a raw WG default_profile. Returns nulls for
 *  absent fields so the caller can fall back to "—". */
function readBase(profile: Profile): ModifiedStats {
  const p = (profile ?? {}) as Record<string, any>;
  const hull = p.hull as any;
  const artillery = p.artillery as any;
  const mobility = p.mobility as any;
  const concealment = p.concealment as any;
  const torpedoes = p.torpedoes as any;
  return {
    hp: num(hull?.health),
    reload: num(artillery?.shot_delay),
    range: num(artillery?.distance),
    traverse: num(artillery?.rotation_time),
    concealmentShip: num(concealment?.detect_distance_by_ship),
    speed: num(mobility?.max_speed),
    torpedoSpeed: num(torpedoes?.torpedo_speed),
  };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Recompute the displayed stats given a skill allocation and current HP.
 *
 * @param profile      The ship's raw WG `default_profile`.
 * @param skillClass   Our SkillClass ("BB"/"CA"/...) — selects the per-class
 *                     coefficient from GameParams.
 * @param skillAlloc   `{ skillDisplayName: rank }` — which skills are invested.
 *                     Only skills present in SKILL_EFFECTS contribute.
 * @param healthPct    Current HP as a fraction 0..1 (drives trigger skills).
 *                     Defaults to 1 (full HP = no trigger effect).
 */
export function recomputeStats(
  profile: Profile,
  skillClass: string,
  skillAlloc: Record<string, number>,
  healthPct: number = 1,
): { base: ModifiedStats; modified: ModifiedStats } {
  const base = readBase(profile);
  const modified: ModifiedStats = { ...base };
  const gpClass: GpClass = GP_CLASS[skillClass] ?? "Cruiser";
  const hpFrac = Math.max(0, Math.min(1, healthPct));

  // Per-stat multiplicative accumulators (start at 1.0 = no change).
  const mults: Record<ModStat, number> = {
    hp: 1, reload: 1, range: 1, traverse: 1, concealmentShip: 1,
    speed: 1, torpedoSpeed: 1, hePen: 1, apDamage: 1, heDamage: 1,
    fireChance: 1, aaDamage: 1,
  };
  // Flat HP bonus (Survivability Expert adds a flat amount per tier).
  let flatHp = 0;

  for (const [displayName, rank] of Object.entries(skillAlloc)) {
    if (!rank) continue;
    const fx = SKILL_EFFECTS[displayName];
    if (!fx) continue;
    if (fx.kind === "mult") {
      const coef = resolveModifier(fx.code, fx.modifierKey, gpClass);
      if (coef != null) {
        if (fx.stat === "hp" && fx.modifierKey === "healthPerLevel") {
          // Survivability Expert: flat HP per ship tier, not a multiplier.
          flatHp += coef * rank;
        } else {
          mults[fx.stat] *= coef;
        }
      }
    } else if (fx.kind === "triggerHp") {
      // Adrenaline Rush: GMShotDelay coef (e.g. 0.9) is the full-strength
      // reload multiplier at minimum HP. At HP fraction h, the applied
      // multiplier interpolates from 1.0 (h=1) to coef (h=0):
      //   applied = 1 - (1 - coef) * (1 - h)
      const coef = resolveTriggerModifier(fx.code, fx.modifierKey);
      if (coef != null) {
        const applied = 1 - (1 - coef) * (1 - hpFrac);
        mults[fx.stat] *= applied;
      }
    }
  }

  // Apply accumulated multipliers to the base values.
  if (modified.hp != null) modified.hp = modified.hp * mults.hp + flatHp;
  if (modified.reload != null) modified.reload *= mults.reload;
  if (modified.range != null) modified.range *= mults.range;
  if (modified.traverse != null) modified.traverse /= mults.traverse; // traverse is s/180° → higher coef = faster = LOWER seconds
  if (modified.concealmentShip != null) modified.concealmentShip *= mults.concealmentShip;
  if (modified.speed != null) modified.speed *= mults.speed;
  if (modified.torpedoSpeed != null) modified.torpedoSpeed *= mults.torpedoSpeed;

  return { base, modified };
}
