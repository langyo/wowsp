/**
 * Captain skill tree data — built from the in-game crew-commander skill icons
 * extracted under `src/res/images/skills/<icon>.webp`.
 *
 * Each ship class (BB / Cruiser / DD / CV / SS) has its own 4-tier tree. A
 * skill carries:
 *   - `icon`   — the in-game skill icon filename stem (matches a webp under
 *                res/images/skills). Resolution by `resolveSkillIcon`.
 *   - `name`   — short display name (i18n key: `ships.skills.name.<slug>`).
 *   - `tier`   — 1..4, the row it sits on. Unlock rules: tier-2 needs ≥1 pt
 *                 spent in tier-1; tier-3 needs ≥2 pts in tiers 1..2; tier-4
 *                 needs ≥3 pts in tiers 1..3.
 *   - `maxRank`— how many points can be invested (1, 2, 3, or 4).
 *
 * The icon names mirror the real game asset names (e.g. `ap_damage_bb`,
 * `gm_shell_reload`, `detection_visibility_range`). Names are descriptive so
 * the planner is readable even without per-skill i18n. The commander budget
 * is 21 pts, matching the in-game system. This is a *planning* aid — it does
 * not compute resulting stat deltas.
 */
export type SkillClass = "BB" | "CA" | "DD" | "CV" | "SS";

export interface Skill {
  icon: string;
  name: string;
  tier: 1 | 2 | 3 | 4;
  maxRank: number;
}

export interface SkillTree {
  cls: SkillClass;
  skills: Skill[];
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

export const SKILL_TREES: Record<SkillClass, Skill[]> = {
  // Battleship
  BB: [
    { icon: "gm_turn", name: "Grease the Gears", tier: 1, maxRank: 1 },
    { icon: "he_fire_probability", name: "Pyrotechnician", tier: 1, maxRank: 1 },
    { icon: "defence_fire_probability", name: "Incoming Fire Alert", tier: 1, maxRank: 1 },
    { icon: "detection_direction", name: "Priority Target", tier: 1, maxRank: 1 },
    { icon: "maneuverability", name: "Gun Feeder", tier: 1, maxRank: 1 },
    { icon: "gm_shell_reload", name: "Adrenaline Rush", tier: 2, maxRank: 1 },
    { icon: "consumables_crashcrew_reload", name: "High Alert", tier: 2, maxRank: 1 },
    { icon: "defense_hp", name: "Enhanced VT Fuse", tier: 2, maxRank: 1 },
    { icon: "he_sap_damage", name: "Heavy HE/SAP", tier: 3, maxRank: 1 },
    { icon: "ap_damage_bb", name: "Super-Heavy AP", tier: 3, maxRank: 1 },
    { icon: "gm_range_aa_damage_bubbles", name: "Long-Range Firing", tier: 3, maxRank: 1 },
    { icon: "consumables_duration", name: "Improved FEeds", tier: 3, maxRank: 1 },
    { icon: "defence_crit_fire_flooding", name: "Fire Prevention", tier: 4, maxRank: 1 },
    { icon: "detection_visibility_range", name: "Concealment Expert", tier: 4, maxRank: 1 },
    { icon: "gm_shell_reload", name: "Dead Eye", tier: 4, maxRank: 1 },
    { icon: "consumables_crashcrew_regencrew_upgrade", name: "Emergency Repair Expert", tier: 4, maxRank: 1 },
  ],
  // Cruiser
  CA: [
    { icon: "gm_turn", name: "Grease the Gears", tier: 1, maxRank: 1 },
    { icon: "he_fire_probability", name: "Pyrotechnician", tier: 1, maxRank: 1 },
    { icon: "defence_fire_probability", name: "Incoming Fire Alert", tier: 1, maxRank: 1 },
    { icon: "detection_direction", name: "Priority Target", tier: 1, maxRank: 1 },
    { icon: "maneuverability", name: "Gun Feeder", tier: 1, maxRank: 1 },
    { icon: "aa_prioritysector_damage_constant", name: "AA Marksman", tier: 2, maxRank: 1 },
    { icon: "gm_shell_reload", name: "Adrenaline Rush", tier: 2, maxRank: 1 },
    { icon: "consumables_crashcrew_reload", name: "High Alert", tier: 2, maxRank: 1 },
    { icon: "he_penetration", name: "Demolition Expert", tier: 3, maxRank: 1 },
    { icon: "ap_damage_ca", name: "Super-Heavy AP", tier: 3, maxRank: 1 },
    { icon: "he_sap_damage", name: "Heavy HE/SAP", tier: 3, maxRank: 1 },
    { icon: "consumables_duration", name: "Improved Feeds", tier: 3, maxRank: 1 },
    { icon: "defence_crit_fire_flooding", name: "Fire Prevention", tier: 4, maxRank: 1 },
    { icon: "detection_visibility_range", name: "Concealment Expert", tier: 4, maxRank: 1 },
    { icon: "gm_range_aa_damage_bubbles", name: "Close-Quarters Expert", tier: 4, maxRank: 1 },
    { icon: "consumables_crashcrew_regencrew_upgrade", name: "Emergency Repair Expert", tier: 4, maxRank: 1 },
  ],
  // Destroyer
  DD: [
    { icon: "gm_turn", name: "Grease the Gears", tier: 1, maxRank: 1 },
    { icon: "torpedo_flooding_probability", name: "Liquidator", tier: 1, maxRank: 1 },
    { icon: "defence_fire_probability", name: "Incoming Fire Alert", tier: 1, maxRank: 1 },
    { icon: "detection_direction", name: "Priority Target", tier: 1, maxRank: 1 },
    { icon: "maneuverability", name: "Gun Feeder", tier: 1, maxRank: 1 },
    { icon: "defense_hp", name: "Last Stand", tier: 2, maxRank: 1 },
    { icon: "torpedo_speed", name: "Swift Fish", tier: 2, maxRank: 1 },
    { icon: "gm_shell_reload", name: "Adrenaline Rush", tier: 2, maxRank: 1 },
    { icon: "consumables_duration", name: "Smoke Screen Expert", tier: 2, maxRank: 1 },
    { icon: "consumables_additional", name: "Superintendent", tier: 3, maxRank: 1 },
    { icon: "torpedo_speed", name: "Torpedo Acceleration", tier: 3, maxRank: 1 },
    { icon: "consumables_duration", name: "Improved Feeds", tier: 3, maxRank: 1 },
    { icon: "gm_shell_reload", name: "Fearless Brawler", tier: 3, maxRank: 1 },
    { icon: "detection_visibility_range", name: "Concealment Expert", tier: 4, maxRank: 1 },
    { icon: "maneuverability", name: "Swift in Silence", tier: 4, maxRank: 1 },
    { icon: "consumables_crashcrew_regencrew_upgrade", name: "Emergency Engine Power", tier: 4, maxRank: 1 },
  ],
  // Aircraft Carrier
  CV: [
    { icon: "planes_aiming_boost", name: "Air Supremacy", tier: 1, maxRank: 1 },
    { icon: "planes_speed", name: "Improved Engines", tier: 1, maxRank: 1 },
    { icon: "planes_consumables_callfighters_additional", name: "Direction Center", tier: 1, maxRank: 1 },
    { icon: "detection_direction", name: "Priority Target", tier: 1, maxRank: 1 },
    { icon: "planes_forsage_duration", name: "Engine Boost", tier: 2, maxRank: 1 },
    { icon: "planes_torpedo_speed", name: "Torpedo Bomber", tier: 2, maxRank: 1 },
    { icon: "planes_divebomber_speed", name: "Dive Bomber", tier: 2, maxRank: 1 },
    { icon: "planes_hp", name: "Survivability Expert", tier: 2, maxRank: 1 },
    { icon: "he_fire_probability", name: "Demolition Expert", tier: 3, maxRank: 1 },
    { icon: "planes_speed", name: "Improved Engines+", tier: 3, maxRank: 1 },
    { icon: "planes_ap_damage", name: "Armor-Piercing", tier: 3, maxRank: 1 },
    { icon: "planes_aiming_boost", name: "Sight Stabilization", tier: 3, maxRank: 1 },
    { icon: "detection_visibility_range", name: "Concealment Expert", tier: 4, maxRank: 1 },
    { icon: "planes_torpedo_armingrange", name: "Proportional Fuses", tier: 4, maxRank: 1 },
    { icon: "planes_forsage_renewal", name: "Emergency Power", tier: 4, maxRank: 1 },
    { icon: "planes_hp", name: "Heavy Aircraft", tier: 4, maxRank: 1 },
  ],
  // Submarine
  SS: [
    { icon: "consumables_crashcrew_regencrew_reload", name: "Empathic Repair", tier: 1, maxRank: 1 },
    { icon: "submarine_battery_capacity", name: "Improved Battery", tier: 1, maxRank: 1 },
    { icon: "detection_direction", name: "Priority Target", tier: 1, maxRank: 1 },
    { icon: "defence_fire_probability", name: "Incoming Fire Alert", tier: 1, maxRank: 1 },
    { icon: "submarine_speed", name: "Enhanced Impulse", tier: 2, maxRank: 1 },
    { icon: "detection_torpedo_range", name: "Sonarman", tier: 2, maxRank: 1 },
    { icon: "armament_reload_submarine", name: "Adrenaline Rush", tier: 2, maxRank: 1 },
    { icon: "submarine_torpedo_ping_damage", name: "Thunderous Volley", tier: 2, maxRank: 1 },
    { icon: "submarine_speed", name: "Enlarged Propeller Shaft", tier: 3, maxRank: 1 },
    { icon: "consumables_additional", name: "Fleet Auxiliary", tier: 3, maxRank: 1 },
    { icon: "consumables_duration", name: "Improved Feeds", tier: 3, maxRank: 1 },
    { icon: "gm_shell_reload", name: "Outnumbered", tier: 3, maxRank: 1 },
    { icon: "detection_visibility_range", name: "Concealment Expert", tier: 4, maxRank: 1 },
    { icon: "detection_torpedo_range", name: "Anti-Submarine", tier: 4, maxRank: 1 },
    { icon: "torpedo_damage", name: "Heavy Homing Torps", tier: 4, maxRank: 1 },
    { icon: "submarine_battery_burn_down", name: "Emergency Diesel", tier: 4, maxRank: 1 },
  ],
};

/** Get a skill's display name (falls back to the stored name). */
export function skillDisplayName(name: string): string {
  return name;
}
