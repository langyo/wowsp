/**
 * Ship-build modifier pipeline for the shipyard. Takes the ship's base
 * `default_profile` + the current build (captain skills, signal flags,
 * modernization upgrades) + the current-HP percentage (for Adrenaline-Rush-type
 * trigger skills) and produces a set of recomputed display stats, so the
 * planner's stats panel can show "what your build actually does".
 *
 * The commander slot is display-only in v1 (unique-commander talents are
 * contextual triggers, not constant modifiers) and contributes nothing here.
 *
 * Modifier application rules (WoWS convention):
 *   - Modifier values are either scalars or per-class dicts keyed by the
 *     GameParams class name ("Battleship"/"Cruiser"/...); scalars always
 *     apply, missing classes are ignored. Multiple multipliers stack
 *     multiplicatively (stat *= coef for each).
 *   - Trigger-skill modifiers (skills.json `trigger.modifiers`, e.g.
 *     Adrenaline Rush's GMShotDelay 0.9) scale with current HP: at 100% HP the
 *     effect is dormant; it ramps linearly to full strength as HP drops:
 *     applied = 1 - (1 - coef) * (1 - hpFrac).
 *   - `healthPerLevel` (Survivability Expert) is the exception: it adds a flat
 *     `coef * shipTier` HP bonus instead of multiplying.
 *   - Modifier keys outside the stat map (pure-utility effects) are ignored.
 */
import type { Profile } from "./shipSpecs";
import skillsData from "../../data/skills.json";
import signalsData from "../../data/signals.json";
import modernizationsData from "../../data/modernizations.json";

/** The player-controlled parts of a build (commander is display-only). */
export interface BuildConfig {
  /** Selected skill codes → 1. */
  skills: Record<string, 1>;
  /** Selected signal indices (PCEF…). */
  signals: string[];
  /** Modernization slot number → modernization name (PCM…). */
  upgrades: Record<number, string>;
  /** Selected unique commander (commanders.json name) — display only. */
  commander: string | null;
}

/** Full planner state: a build + the current-HP slider (drives trigger skills). */
export interface PlannerBuild extends BuildConfig {
  /** Current HP as a fraction 0..1. */
  healthPct: number;
}

/** Empty build — also the reset target for the planner. */
export function emptyBuild(): PlannerBuild {
  return { skills: {}, signals: [], upgrades: {}, commander: null, healthPct: 1 };
}

export interface ModifiedStats {
  hp: number | null;
  reload: number | null;          // main-battery reload, seconds
  range: number | null;           // main-battery range, km
  traverse: number | null;        // turret traverse, s/180°
  concealmentShip: number | null; // surface detectability, km
  speed: number | null;           // top speed, knots
  torpedoSpeed: number | null;    // torpedo speed, knots
  torpedoReload: number | null;   // torpedo launcher reload, seconds
  rudderShift: number | null;     // rudder shift, seconds
  fireChanceOut: number | null;   // HE fire chance, % (base = burn_chance × 100)
  floodChanceOut: number | null;  // torpedo flood chance coefficient
  fireDurationTaken: number | null;   // fire duration on this ship, s
  floodDurationTaken: number | null;  // flooding duration on this ship, s
  aaDamage: number | null;        // AA aura/bubble damage coefficient
  healRate: number | null;        // HP regeneration speed coefficient
}

/** Modifier key → which ModifiedStats field it multiplies. */
const STAT_MAP: Record<string, keyof Omit<ModifiedStats, "hp"> | "hp"> = {
  GMShotDelay: "reload",
  GTShotDelay: "torpedoReload",
  GMRotationSpeed: "traverse",
  GMMaxDist: "range",
  visibilityDistCoeff: "concealmentShip",
  visibilityFactor: "concealmentShip",
  speedCoef: "speed",
  torpedoSpeedMultiplier: "torpedoSpeed",
  healthHullCoeff: "hp",
  SGRudderTime: "rudderShift",
  burnTime: "fireDurationTaken",
  floodTime: "floodDurationTaken",
  // Defensive fire/flood chance keys (burnProb, floodProb, vulnerability*)
  // have no displayed row and must not leak into the offensive chance.
  burnChanceGMGSMultiplier: "fireChanceOut",
  floodChanceFactor: "floodChanceOut",
  AAAuraDamage: "aaDamage",
  AABubbleDamage: "aaDamage",
  regenerationHPSpeed: "healRate",
};

/**
 * Additive percentage-point modifiers. burnChanceFactorBig/Small store the
 * plain additive fraction (0.01 = +1pp to HE fire chance), not a multiplier;
 * fireChanceOut is carried in percent units, hence the ×100.
 */
const STAT_ADDS: Record<string, { stat: keyof ModifiedStats; scale: number; minCaliber?: number; maxCaliber?: number }> = {
  burnChanceFactorBig: { stat: "fireChanceOut", scale: 100, minCaliber: 160 },
  burnChanceFactorSmall: { stat: "fireChanceOut", scale: 100, maxCaliber: 160 },
};

/** Flat skills.json skill entry (per-class dicts or scalars). */
interface SkillJsonEntry {
  modifiers: Record<string, unknown>;
  trigger: { type: string; modifiers: Record<string, unknown> } | null;
}
interface SignalJsonEntry {
  index: string;
  modifiers: Record<string, unknown>;
}
interface ModernizationJsonEntry {
  name: string;
  modifiers: Record<string, unknown>;
}

const SKILLS = skillsData as Record<string, SkillJsonEntry>;
const SIGNALS = new Map<string, SignalJsonEntry>(
  (signalsData as SignalJsonEntry[]).map((s) => [s.index, s]),
);
const MODERNIZATIONS = new Map<string, ModernizationJsonEntry>(
  (modernizationsData as ModernizationJsonEntry[]).map((m) => [m.name, m]),
);

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
    torpedoReload: num(torpedoes?.shot_delay) ?? num(torpedoes?.reload_time),
    rudderShift: num(mobility?.rudder_time),
    fireChanceOut: pct(num(artillery?.shells?.HE?.burn_chance) ?? num(artillery?.shells?.HE?.burn_probability)),
    floodChanceOut: null,
    fireDurationTaken: null,
    floodDurationTaken: null,
    aaDamage: null,
    healRate: null,
  };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Fraction → percent (e.g. 0.43 → 43), or null. */
function pct(v: number | null): number | null {
  return v == null ? null : v * 100;
}

/**
 * Resolve a modifier value for a ship class. Scalars apply to every class;
 * per-class dicts are looked up by the WG class name and ignored when the
 * class is absent.
 */
function resolveCoef(value: unknown, shipType: string): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value && typeof value === "object") {
    const perClass = value as Record<string, unknown>;
    return num(perClass[shipType]);
  }
  return null;
}

/**
 * Recompute the displayed stats given a build and current HP.
 *
 * @param profile   The ship's raw WG `default_profile`.
 * @param shipType  The WG class name ("Battleship"/"Cruiser"/…) — selects
 *                  per-class coefficients and gates the fire-chance caliber.
 * @param shipTier  Ship tier 1..11 — scales the flat `healthPerLevel` bonus.
 * @param build     Selected skills / signals / upgrades (commander ignored).
 * @param healthPct Current HP as a fraction 0..1 (drives trigger skills).
 */
export function recomputeStats(
  profile: Profile,
  shipType: string,
  shipTier: number,
  build: BuildConfig,
  healthPct: number,
): { base: ModifiedStats; modified: ModifiedStats } {
  const base = readBase(profile);
  const modified: ModifiedStats = { ...base };
  const hpFrac = Math.max(0, Math.min(1, healthPct));
  const caliber = num((profile as Record<string, any>)?.artillery?.max_caliber);

  // Per-stat multiplicative accumulators (start at 1.0 = no change).
  const mults: Record<string, number> = {};
  // Additive percentage-point accumulators (fire chance flags).
  const adds: Record<string, number> = {};
  // Flat HP bonus (Survivability Expert adds a flat amount per ship tier).
  let flatHp = 0;

  function accumulate(mods: Record<string, unknown>, triggered: boolean): void {
    for (const [key, value] of Object.entries(mods ?? {})) {
      if (key === "healthPerLevel") {
        const coef = resolveCoef(value, shipType);
        if (coef != null) flatHp += coef * shipTier;
        continue;
      }
      const add = STAT_ADDS[key];
      if (add) {
        if (add.minCaliber != null && !(caliber != null && caliber >= add.minCaliber)) continue;
        if (add.maxCaliber != null && !(caliber != null && caliber < add.maxCaliber)) continue;
        const coef = resolveCoef(value, shipType);
        if (coef != null) adds[add.stat] = (adds[add.stat] ?? 0) + coef * add.scale;
        continue;
      }
      const stat = STAT_MAP[key];
      if (!stat) continue; // utility effect — no displayed stat hit
      let coef = resolveCoef(value, shipType);
      if (coef == null) continue;
      if (triggered) coef = 1 - (1 - coef) * (1 - hpFrac);
      mults[stat] = (mults[stat] ?? 1) * coef;
    }
  }

  // ── Source 1: captain skills (passive modifiers + HP-scaled triggers) ──
  for (const code of Object.keys(build?.skills ?? {})) {
    const entry = SKILLS[code];
    if (!entry) continue;
    accumulate(entry.modifiers, false);
    if (entry.trigger) accumulate(entry.trigger.modifiers, true);
  }
  // ── Source 2: signal flags ─────────────────────────────────────────────
  for (const index of build?.signals ?? []) {
    const sig = SIGNALS.get(index);
    if (sig) accumulate(sig.modifiers, false);
  }
  // ── Source 3: modernization upgrades ───────────────────────────────────
  for (const name of Object.values(build?.upgrades ?? {})) {
    const mod = MODERNIZATIONS.get(name);
    if (mod) accumulate(mod.modifiers, false);
  }

  // Apply accumulated multipliers to the base values.
  if (modified.hp != null) modified.hp = modified.hp * (mults.hp ?? 1) + flatHp;
  if (modified.reload != null) modified.reload *= mults.reload ?? 1;
  if (modified.range != null) modified.range *= mults.range ?? 1;
  // traverse is s/180° → higher rotation coefficient = LOWER seconds.
  if (modified.traverse != null) modified.traverse /= mults.traverse ?? 1;
  if (modified.concealmentShip != null) modified.concealmentShip *= mults.concealmentShip ?? 1;
  if (modified.speed != null) modified.speed *= mults.speed ?? 1;
  if (modified.torpedoSpeed != null) modified.torpedoSpeed *= mults.torpedoSpeed ?? 1;
  if (modified.torpedoReload != null) modified.torpedoReload *= mults.torpedoReload ?? 1;
  if (modified.rudderShift != null) modified.rudderShift *= mults.rudderShift ?? 1;
  if (modified.fireChanceOut != null) {
    modified.fireChanceOut = modified.fireChanceOut * (mults.fireChanceOut ?? 1) + (adds.fireChanceOut ?? 0);
  }
  if (modified.floodChanceOut != null) modified.floodChanceOut *= mults.floodChanceOut ?? 1;
  if (modified.fireDurationTaken != null) modified.fireDurationTaken *= mults.fireDurationTaken ?? 1;
  if (modified.floodDurationTaken != null) modified.floodDurationTaken *= mults.floodDurationTaken ?? 1;
  if (modified.aaDamage != null) modified.aaDamage *= mults.aaDamage ?? 1;
  if (modified.healRate != null) modified.healRate *= mults.healRate ?? 1;

  return { base, modified };
}
