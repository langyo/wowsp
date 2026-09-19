/**
 * Column-oriented stat extraction for the batch ship-compare table
 * (浩舰-style: pick a stat group, every ship contributes one column value).
 *
 * The WG `/encyclopedia/ships/` `default_profile` uses internal snake_case
 * field names; extraction idioms (the HE-pen estimate, unit formatting)
 * mirror `components/ships/shipSpecs.ts` — keep the two in sync
 * conceptually, but this module formats to plain display strings (no i18n
 * here beyond the label keys, resolved by the component via `t()`).
 *
 * Data-shape notes verified against the live WG API (v15.5): AA slot
 * `avg_damage` is always null and armour sub-objects are always {-1,-1}, so
 * those dead columns were removed; `artillery` no longer carries a caliber
 * field (parsed from the first gun-slot name instead); HE `burn_probability`
 * is already a percentage. Groups the hull can never carry (torpedo tubes,
 * ASW, aircraft) are collapsed into one gray "not applicable" cell by
 * `groupApplies`.
 */
export interface CompareColumn {
  /** Stable column key (React-style key + lookup). */
  key: string;
  /** FULL i18n key path — the component renders t(labelKey). */
  labelKey: string;
  /**
   * Pre-formatted display value, or null when the ship lacks the stat.
   * `nation` rides along because estimates like the German HE pen live on
   * the ShipInfo, not inside the profile subtree.
   */
  get: (p: Record<string, any> | null | undefined, nation?: string) => string | null;
}

export interface CompareGroup {
  key: string;
  labelKey: string;
  columns: CompareColumn[];
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtNum(v: unknown, digits = 0): string | null {
  const n = num(v);
  if (n == null) return null;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Nation-aware HE pen estimate: germany caliber/4, everyone else caliber/6. */
function hePenEstimate(caliberMm: number | null, nation: string | undefined): number | null {
  if (caliberMm == null || caliberMm <= 0) return null;
  const div = nation === "germany" ? 4 : 6;
  return Math.round(caliberMm / div);
}

/** WG API dropped the caliber field — parse it from the first gun-slot
 *  name ("406 mm/45 Mk.6 in a turret" → 406). Falls back to the legacy
 *  barrelDiameter keys when present. */
function mainGunCaliber(art: any): number | null {
  if (!art || typeof art !== "object") return null;
  const direct = num(art.barrelDiameter) ?? num(art.barrel_diameter) ?? num(art.caliber);
  if (direct != null) return direct;
  const slots = art.slots as Record<string, any> | undefined;
  const first = slots ? Object.values(slots)[0] as any : undefined;
  const m = typeof first?.name === "string" ? first.name.match(/(\d+(?:\.\d+)?)\s*mm/i) : null;
  return m ? Number(m[1]) : null;
}

const TIER_ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
/** Standard tier notation — Roman numerals for I–X, a star for superships. */
export function tierLabel(tier: number): string {
  return tier >= 1 && tier <= 10 ? (TIER_ROMAN[tier - 1] ?? String(tier)) : "★";
}

// ── hull ─────────────────────────────────────────────────────────────────
const HULL_COLUMNS: CompareColumn[] = [
  {
    key: "hp",
    labelKey: "ships.spec.hp",
    get: (p) => fmtNum(p?.hull?.health),
  },
  {
    key: "torpProtection",
    labelKey: "ships.spec.torpProtection",
    get: (p) => {
      const flood = num(p?.armour?.flood_damage);
      return flood != null ? `${flood}%` : null;
    },
  },
  {
    key: "maxSpeed",
    labelKey: "ships.spec.maxSpeed",
    get: (p) => {
      const v = num(p?.mobility?.max_speed);
      return v != null ? `${v.toFixed(1)} kn` : null;
    },
  },
  {
    key: "rudderShift",
    labelKey: "ships.spec.rudderShift",
    get: (p) => {
      const v = num(p?.mobility?.rudder_time);
      return v != null ? `${v.toFixed(1)} s` : null;
    },
  },
  {
    key: "turningRadius",
    labelKey: "ships.spec.turningRadius",
    get: (p) => {
      const v = num(p?.mobility?.turning_radius);
      return v != null ? `${v} m` : null;
    },
  },
  {
    key: "surfaceDetect",
    labelKey: "ships.spec.surfaceDetect",
    get: (p) => {
      const v = num(p?.concealment?.detect_distance_by_ship);
      return v != null ? `${v.toFixed(1)} km` : null;
    },
  },
  {
    key: "airDetect",
    labelKey: "ships.spec.airDetect",
    get: (p) => {
      const v = num(p?.concealment?.detect_distance_by_plane);
      return v != null ? `${v.toFixed(1)} km` : null;
    },
  },
];

// ── artillery ────────────────────────────────────────────────────────────
/** HE per-shell row shared by the heShell/hePenetration/fireChance/DPM
 *  columns — null when the profile carries no HE shell. */
function heShellOf(p: Record<string, any> | null | undefined): Record<string, any> | null {
  const sh = p?.artillery?.shells?.HE;
  return sh && typeof sh === "object" ? sh : null;
}

const ARTILLERY_COLUMNS: CompareColumn[] = [
  {
    key: "mainGunRange",
    labelKey: "ships.spec.mainGunRange",
    get: (p) => {
      const v = fmtNum(p?.artillery?.distance, 1);
      return v ? `${v} km` : null;
    },
  },
  {
    key: "mainGunReload",
    labelKey: "ships.spec.mainGunReload",
    get: (p) => {
      const v = num(p?.artillery?.shot_delay);
      return v != null ? `${v.toFixed(1)} s` : null;
    },
  },
  {
    key: "mainGunBarrels",
    labelKey: "ships.spec.mainGunBarrels",
    get: (p) => {
      const v = num(p?.hull?.artillery_barrels);
      return v != null ? String(v) : null;
    },
  },
  {
    key: "mainGunCaliber",
    labelKey: "ships.spec.mainGunCaliber",
    get: (p) => {
      const v = mainGunCaliber(p?.artillery);
      return v != null ? `${v} mm` : null;
    },
  },
  {
    key: "turretTraverse",
    labelKey: "ships.spec.turretTraverse",
    get: (p) => {
      const v = num(p?.artillery?.rotation_time);
      return v != null ? `${v.toFixed(1)} s / 180°` : null;
    },
  },
  {
    key: "maxDispersion",
    labelKey: "ships.spec.maxDispersion",
    get: (p) => {
      const v = num(p?.artillery?.max_dispersion);
      return v != null ? `${v} m` : null;
    },
  },
  {
    key: "shellSpeed",
    labelKey: "ships.spec.shellSpeed",
    get: (p) => {
      const v = num(heShellOf(p)?.bullet_speed);
      return v != null ? `${v} m/s` : null;
    },
  },
  {
    key: "hePenetration",
    labelKey: "ships.spec.hePenetration",
    get: (p, nation) => {
      const he = heShellOf(p);
      if (!he) return null;
      const pen = num(he.penetration) ?? hePenEstimate(mainGunCaliber(p?.artillery), nation);
      return pen != null ? `${pen} mm` : null;
    },
  },
  {
    key: "heShell",
    labelKey: "ships.spec.heShell",
    get: (p) => fmtNum(heShellOf(p)?.damage),
  },
  {
    key: "fireChance",
    labelKey: "ships.spec.fireChance",
    get: (p) => {
      const he = heShellOf(p);
      if (!he) return null;
      // WG's burn_probability is ALREADY a percentage (NC 406 mm HE = 36.0)
      // — multiplying by 100 would render 3600%.
      const burn = num(he.burn_chance) ?? num(he.burn_probability);
      return burn != null ? `${Math.round(burn)}%` : null;
    },
  },
  {
    key: "heDpm",
    labelKey: "ships.spec.heDpm",
    get: (p) => {
      const dmg = num(heShellOf(p)?.damage);
      const barrels = num(p?.hull?.artillery_barrels);
      const reload = num(p?.artillery?.shot_delay);
      if (dmg == null || barrels == null || reload == null || reload <= 0) return null;
      return fmtNum((dmg * barrels) / reload);
    },
  },
  {
    key: "apShell",
    labelKey: "ships.spec.apShell",
    get: (p) => {
      const ap = p?.artillery?.shells?.AP;
      return ap && typeof ap === "object" ? fmtNum(ap.damage) : null;
    },
  },
  {
    key: "apDpm",
    labelKey: "ships.spec.apDpm",
    get: (p) => {
      const ap = p?.artillery?.shells?.AP;
      const dmg = ap && typeof ap === "object" ? num(ap.damage) : null;
      const barrels = num(p?.hull?.artillery_barrels);
      const reload = num(p?.artillery?.shot_delay);
      if (dmg == null || barrels == null || reload == null || reload <= 0) return null;
      return fmtNum((dmg * barrels) / reload);
    },
  },
];

// ── torpedoes ────────────────────────────────────────────────────────────
const TORPEDO_COLUMNS: CompareColumn[] = [
  {
    key: "torpRange",
    labelKey: "ships.spec.torpRange",
    get: (p) => {
      const v = fmtNum(p?.torpedoes?.distance, 1);
      return v ? `${v} km` : null;
    },
  },
  {
    key: "torpSpeed",
    labelKey: "ships.spec.torpSpeed",
    get: (p) => {
      const v = num(p?.torpedoes?.torpedo_speed);
      return v != null ? `${v} kn` : null;
    },
  },
  {
    key: "torpDamage",
    labelKey: "ships.spec.torpDamage",
    get: (p) => fmtNum(p?.torpedoes?.max_damage),
  },
  {
    key: "torpReload",
    labelKey: "ships.spec.torpReload",
    get: (p) => {
      const v = num(p?.torpedoes?.reload_time);
      return v != null ? `${v.toFixed(1)} s` : null;
    },
  },
  {
    key: "torpDetect",
    labelKey: "ships.spec.torpDetect",
    get: (p) => {
      const v = num(p?.torpedoes?.visibility_dist);
      return v != null ? `${v.toFixed(1)} km` : null;
    },
  },
  {
    key: "torpLaunchers",
    labelKey: "ships.spec.torpLaunchers",
    get: (p) => {
      const v = num(p?.hull?.torpedoes_barrels);
      // Only gunless-for-torps hulls carry the stat; 0 means "no tubes".
      return v != null && v > 0 ? String(v) : null;
    },
  },
];

// ── anti-air ─────────────────────────────────────────────────────────────
// Only the aggregate rating survives: the live API's AA slots always carry
// avg_damage = null / distance = -1, so per-band aura columns could never
// fill.
const ANTI_AIR_COLUMNS: CompareColumn[] = [
  {
    key: "aaRating",
    labelKey: "ships.spec.aaRating",
    get: (p) => {
      const v = num(p?.anti_aircraft?.defense);
      return v != null && v > 0 ? String(v) : null;
    },
  },
];

// ── ASW (depth charges) ──────────────────────────────────────────────────
const ASW_COLUMNS: CompareColumn[] = [
  {
    key: "depthChargeDamage",
    labelKey: "ships.spec.depthChargeDamage",
    get: (p) => fmtNum(p?.depth_charge?.bomb_max_damage),
  },
  {
    key: "depthChargePacks",
    labelKey: "ships.spec.depthChargePacks",
    get: (p) => {
      const v = num(p?.depth_charge?.max_packs);
      return v != null ? String(v) : null;
    },
  },
  {
    key: "depthChargeBombs",
    labelKey: "ships.spec.depthChargeBombs",
    get: (p) => {
      const v = num(p?.depth_charge?.num_bombs_in_pack);
      return v != null ? String(v) : null;
    },
  },
  {
    key: "depthChargeReload",
    labelKey: "ships.spec.depthChargeReload",
    get: (p) => {
      const v = num(p?.depth_charge?.reload_time);
      return v != null ? `${v.toFixed(1)} s` : null;
    },
  },
];

// ── aircraft (torpedo bombers) ───────────────────────────────────────────
const AIRCRAFT_COLUMNS: CompareColumn[] = [
  {
    key: "torpBomberDamage",
    labelKey: "ships.spec.torpBomberDamage",
    get: (p) => fmtNum(p?.torpedo_bomber?.torpedo_damage),
  },
  {
    key: "torpBomberRange",
    labelKey: "ships.spec.torpBomberRange",
    get: (p) => {
      const v = fmtNum(p?.torpedo_bomber?.torpedo_distance, 1);
      return v ? `${v} km` : null;
    },
  },
  {
    key: "torpBomberSpeed",
    labelKey: "ships.spec.torpBomberSpeed",
    get: (p) => {
      const v = num(p?.torpedo_bomber?.torpedo_max_speed);
      return v != null ? `${v} kn` : null;
    },
  },
];

export const COMPARE_GROUPS: CompareGroup[] = [
  { key: "hull", labelKey: "ships.compare.group.hull", columns: HULL_COLUMNS },
  { key: "artillery", labelKey: "ships.spec.group.artillery", columns: ARTILLERY_COLUMNS },
  { key: "torpedoes", labelKey: "ships.spec.group.torpedoes", columns: TORPEDO_COLUMNS },
  { key: "antiAir", labelKey: "ships.spec.group.antiAir", columns: ANTI_AIR_COLUMNS },
  { key: "asw", labelKey: "ships.compare.group.asw", columns: ASW_COLUMNS },
  { key: "aircraft", labelKey: "ships.compare.group.aircraft", columns: AIRCRAFT_COLUMNS },
];

/** Whether the ship carries this weapon system at all — drives the merged
 *  gray "not applicable" cell for groups the hull can never have. */
export function groupApplies(group: CompareGroup, p: Record<string, any> | null | undefined): boolean {
  const has = (v: unknown) => v != null && typeof v === "object";
  switch (group.key) {
    case "torpedoes":
      return has(p?.torpedoes) || (num(p?.hull?.torpedoes_barrels) ?? 0) > 0;
    case "antiAir":
      return (num(p?.anti_aircraft?.defense) ?? 0) > 0;
    case "artillery":
      // Direct null check instead of has(): TS 5.5 infers `v is object` for
      // that helper, which would narrow p?.artillery to plain `object` and
      // hide distance/shot_delay from the follow-up reads.
      return (
        p?.artillery != null &&
        (num(p.artillery.distance) != null || num(p.artillery.shot_delay) != null)
      );
    case "asw":
      return has(p?.depth_charge);
    case "aircraft":
      return num(p?.torpedo_bomber?.torpedo_damage) != null;
    default:
      return true; // hull — every ship has one
  }
}
