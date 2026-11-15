/**
 * Modernization effect rows + Research-Bureau metadata for the 装备槽位
 * hover cards (BuildPlanner). Vue-free and i18n-free by contract — the
 * caller resolves labels via the returned key — so the semantics stay
 * unit-testable in isolation, mirroring upgradeChainRows.ts.
 *
 * The modifiers themselves are the SAME battleSignals family the signal
 * flags carry (BuildPlanner's flagEffects formats those), so the value
 * grammar matches: multipliers read (v−1)·100, per-class dicts resolve by
 * the ship's own class (a dict without the class means the effect does not
 * apply to this ship — the row is dropped), additive counts show +N. The
 * modernization catalog just adds a few shapes the flags never use
 * (additive-second aiming penalties, raw-meter distances, fraction-of-1
 * regeneration rates), encoded in the key sets below.
 *
 * Research-Bureau items: the `unique`-tagged upgrades in slot 5/6 (0-based
 * 4/5) are the Tier-X "legendary" set bought in the Armory's Research
 * Bureau. Every one of them costs the same 19,200 Research Points (WG wiki,
 * "Ship:Upgrades": "To obtain a unique upgrade, each can be purchased for
 * 19,200 RP in the Research Bureau section of the Armory") — a stable game
 * constant the GameParams dump does NOT carry, embedded here as the vetted
 * constant this repo uses for such prices elsewhere (demount cost, retrain
 * formula). The other `unique` entries (the Siegfried-event PXM*, the
 * "modern"-ship PCM107-118 armory sets) sit in slots 1-3 and must NOT get
 * the Research-Bureau line.
 */

/** Every unique upgrade costs this many Research Points in the Research
 *  Bureau (WG wiki "Ship:Upgrades", Unique Upgrades section). */
export const RB_UNIQUE_UPGRADE_RP = 19200;

/** Whether a modernization catalog entry is a Research-Bureau (legendary)
 *  upgrade: the unique tag AND a slot-5/6 placement (0-based 4/5). */
export function isResearchBureauUpgrade(entry: {
  slot: number;
  tags?: string[] | null;
}): boolean {
  const slotOk = entry.slot === 4 || entry.slot === 5;
  const tagged = Array.isArray(entry.tags) && entry.tags.includes("unique");
  return slotOk && tagged;
}

/** Additive-count keys (+N charges / packs, may be negative). */
const COUNT_KEYS = new Set([
  "additionalConsumables",
  "smokeGeneratorAdditionalConsumables",
  "dcNumPacksBonus",
  "planeExtraHangarSize",
  "asAdditionalChargesCombined",
  "AAExtraBubbles",
]);

/** Additive-second keys (aiming-time penalties the CV uniques trade away). */
const SECOND_KEYS = new Set([
  "fighterAimingTime",
  "torpedoBomberAimingTime",
  "skipBomberAimingTime",
]);

/** Raw-meter keys (the sub uniques' hydrophone torpedo-spotting distance). */
const METER_KEYS = new Set(["visionXRayTorpedoDist"]);

/** Fraction-of-1 regeneration keys (0.15 = +15%), signed like multipliers
 *  but WITHOUT the (v−1) shift. */
const RATE_KEYS = new Set(["healthRegenPercent", "regeneratedHPPartCoef"]);

/** Additive fraction-of-1 keys (0.08 = +8% boost speed) — no (v−1) shift. */
const PP_KEYS = new Set(["boostCoeffForsage"]);

/** Keys where BELOW 1 helps the player (repair/crit/reload/visibility/
 *  damage-taken reductions). Everything unlisted reads higher-is-better —
 *  verified against the catalog's own values (traverse-speed cuts are the
 *  trade, range/damage/charge boosts the perk). */
const LOWER_IS_BETTER = new Set([
  "GMCritProb",
  "GTCritProb",
  "SGCritProb",
  "engineCritProb",
  "pingerCritProb",
  "GMRepairTime",
  "GTRepairTime",
  "SGRepairTime",
  "engineRepairTime",
  "pingerRepairTime",
  "GMShotDelay",
  "GSShotDelay",
  "GTShotDelay",
  "GMIdealRadius",
  "GSIdealRadius",
  "GMSIdealRadius",
  "visibilityDistCoeff",
  "visibilityFactor",
  "visibilityFactorByPlane",
  "visibilityFactorInSmoke",
  "visibilityForSubmarineCoeff",
  "vulnerabilityAll",
  "vulnerabilityBurn",
  "vulnerabilityDc",
  "vulnerabilityFlood",
  "vulnerabilityMissile",
  "burnProb",
  "floodProb",
  "allConsumableReloadTime",
  "smokeGeneratorReloadCoeff",
  "planeSpawnTime",
  "planeTorpedoArmingTimeCoeff",
  "prioritySectorCooldownMultiplier",
  "SGRudderTime",
  "buoyancyRudderTimeCoeff",
  "buoyancyRudderResetTimeCoeff",
  "engineForwardUpTime",
  "engineBackwardUpTime",
  "fighterAimingTime",
  "torpedoBomberAimingTime",
  "skipBomberAimingTime",
  "lastChanceReloadCoefficient",
  "asReloadTimeCoeff",
  "missileReloadCoeff",
  "missileTimeBetweenShotsCoeff",
  "planeSpreadMultiplier",
  "burnChanceGMGSMultiplier",
]);

/** One rendered row of the modernization hover card. */
export interface UpgradeEffect {
  /** Raw modifier key (the row's Vue key). */
  key: string;
  /** i18n key resolving the row label — ships.flags.effect.* first (the
   *  flag catalog already covers the shared battleSignals family), else
   *  ships.upgrades.effect.*; null → the caller shows the raw key. */
  labelKey: string | null;
  /** Pre-formatted signed value ("+10%", "−25%", "+2", "+1800 m"). */
  text: string;
  /** True when the change helps (green), false when it hurts (red). */
  good: boolean;
}

/** Signed percentage text, game-style: "+10%" / "−25%" / "±0%". */
function signedPct(v: number): string {
  if (v === 0) return "±0%";
  const abs = Number.isInteger(v) ? String(Math.abs(v)) : String(Number(Math.abs(v).toFixed(1)));
  return (v > 0 ? "+" : "−") + abs + "%";
}

/** Signed integer text: "+2" / "−1" / "+0". */
function signedCount(v: number): string {
  return (v > 0 ? "+" : v < 0 ? "−" : "") + String(Math.abs(v));
}

/** Resolve one modifier value for THIS ship — per-class dicts resolve by
 *  the WG class name; a dict missing the ship's class means the effect does
 *  not apply to this ship (the same rule BuildPlanner's flagEffects and
 *  modifierPipeline apply), so the row is dropped rather than showing
 *  another class's number. */
export function upgradeEffectValue(raw: unknown, shipType: string): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (raw && typeof raw === "object") {
    const own = (raw as Record<string, unknown>)[shipType];
    if (typeof own === "number" && Number.isFinite(own)) return own;
  }
  return null;
}

/** Text + direction of one resolved value, per the key's grammar.
 *
 *  Two value grammars carry their direction in the SIGN of a delta, not in
 *  a ratio around 1: additive buckets (counts / rates / boost percents /
 *  metres) help when positive, aim-time seconds hurt when positive.
 *  Multiplier keys read around 1 instead — a decrease (v<1) is a reduction,
 *  which helps exactly when the key is in LOWER_IS_BETTER. */
function effectText(key: string, v: number): { text: string; good: boolean } {
  if (COUNT_KEYS.has(key)) {
    return { text: signedCount(v), good: v > 0 };
  }
  if (SECOND_KEYS.has(key)) {
    const abs = Number.isInteger(v) ? String(Math.abs(v)) : String(Number(Math.abs(v).toFixed(1)));
    return { text: (v > 0 ? "+" : v < 0 ? "−" : "") + abs + " s", good: v < 0 };
  }
  if (METER_KEYS.has(key)) {
    return { text: signedCount(v) + " m", good: v > 0 };
  }
  if (RATE_KEYS.has(key) || PP_KEYS.has(key)) {
    return { text: signedPct(v * 100), good: v > 0 };
  }
  const lowerIsBetter = LOWER_IS_BETTER.has(key);
  return {
    text: signedPct((v - 1) * 100),
    good: v === 1 ? true : (v > 1) !== lowerIsBetter,
  };
}

/** One hover-card row per modifier of a modernization, i18n-key attached.
 *  Flags-catalog labels win (the shared battleSignals family), then the
 *  upgrades catalog; keys missing from both still render, with the raw key
 *  as the label (labelKey null) instead of dropping data silently. */
export function upgradeEffectRows(
  modifiers: Record<string, unknown> | null | undefined,
  shipType: string,
  hasMsg: (key: string) => boolean,
): UpgradeEffect[] {
  const out: UpgradeEffect[] = [];
  for (const [key, raw] of Object.entries(modifiers ?? {})) {
    const v = upgradeEffectValue(raw, shipType);
    if (v == null) continue;
    let labelKey: string | null = null;
    if (hasMsg("ships.flags.effect." + key)) labelKey = "ships.flags.effect." + key;
    else if (hasMsg("ships.upgrades.effect." + key)) labelKey = "ships.upgrades.effect." + key;
    const { text, good } = effectText(key, v);
    out.push({ key, labelKey, text, good });
  }
  return out;
}
