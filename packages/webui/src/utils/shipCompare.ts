/**
 * Column-oriented stat extraction for the batch ship-compare table
 * (浩舰-style: pick a stat group, every ship contributes one column value).
 *
 * The WG `/encyclopedia/ships/` `default_profile` uses internal snake_case
 * field names; extraction idioms (the {max,min} armour helper, the HE-pen
 * estimate, the AA slot banding, unit formatting) mirror
 * `components/ships/shipSpecs.ts` — keep the two in sync conceptually, but
 * this module formats to plain display strings (no i18n here beyond the
 * label keys, resolved by the component via `t()`).
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

/** Hard cap on the compare list — keeps the sticky-column table readable. */
export const MAX_COMPARE_SHIPS = 10;

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

/** WG armour sub-objects use {max, min} where -1 / 0 means "not applicable".
 *  Return the meaningful value or null. */
function armourThickness(v: unknown): number | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as { max?: number; min?: number };
  const m = num(o.max);
  if (m == null || m <= 0) return null;
  return m;
}

/** Nation-aware HE pen estimate: germany caliber/4, everyone else caliber/6. */
function hePenEstimate(caliberMm: number | null, nation: string | undefined): number | null {
  if (caliberMm == null || caliberMm <= 0) return null;
  const div = nation === "germany" ? 4 : 6;
  return Math.round(caliberMm / div);
}

/** Extract the main-gun caliber (mm) from the artillery sub-tree.
 *  WG stores barrel diameter under several keys depending on schema; try the
 *  common ones. */
function mainGunCaliber(art: any): number | null {
  if (!art || typeof art !== "object") return null;
  return num(art.barrelDiameter) ?? num(art.barrel_diameter) ?? num(art.caliber);
}

/** WG AA slots are keyed by range bucket; band them into short/mid/long by
 *  distance (<3.0 short, 3.0–5.0 mid, >5.0 long — rough aura split). */
function aaBands(p: Record<string, any> | null | undefined): Record<string, { dmg: number; dist: number }> | null {
  const slots = p?.anti_aircraft?.slots;
  if (!slots || typeof slots !== "object") return null;
  const slotList = Object.values(slots)
    .map((s) => ({
      dist: num((s as any).distance),
      dmg: num((s as any).avg_damage),
    }))
    .filter((s) => s.dist != null && s.dist > 0 && s.dmg != null);
  if (slotList.length === 0) return null;
  slotList.sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0));
  const bandOf = (d: number): "short" | "mid" | "long" =>
    d <= 3.0 ? "short" : d <= 5.0 ? "mid" : "long";
  const bands: Record<string, { dmg: number; dist: number }> = {};
  for (const s of slotList) {
    const b = bandOf(s.dist!);
    if (!bands[b] || s.dist! > bands[b].dist) bands[b] = { dmg: s.dmg!, dist: s.dist! };
  }
  return bands;
}

const aaAura = (b: { dmg: number; dist: number } | undefined): string | null =>
  b ? `${b.dmg.toFixed(0)} DPS · ${b.dist} km` : null;

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
    key: "citadelArmor",
    labelKey: "ships.spec.citadelArmor",
    get: (p) => {
      const m = armourThickness(p?.armour?.citadel);
      return m != null ? `${m} mm` : null;
    },
  },
  {
    key: "deckArmor",
    labelKey: "ships.spec.deckArmor",
    get: (p) => {
      const m = armourThickness(p?.armour?.deck);
      return m != null ? `${m} mm` : null;
    },
  },
  {
    key: "bowArmor",
    labelKey: "ships.spec.bowArmor",
    get: (p) => {
      const m = armourThickness(p?.armour?.extremities);
      return m != null ? `${m} mm` : null;
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
    key: "mainGunSigma",
    labelKey: "ships.spec.mainGunSigma",
    get: (p) => {
      const v = num(p?.artillery?.sigma);
      return v != null ? v.toFixed(1) : null;
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
      // WG stores the fire chance as a fraction (0..1) — shipSpecs formats
      // the same stat (heFireChance) as a rounded percentage.
      const burn = num(he.burn_chance) ?? num(he.burn_probability);
      return burn != null ? `${Math.round(burn * 100)}%` : null;
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
const ANTI_AIR_COLUMNS: CompareColumn[] = [
  {
    key: "aaRating",
    labelKey: "ships.spec.aaRating",
    get: (p) => {
      const v = num(p?.anti_aircraft?.defense);
      return v != null && v > 0 ? String(v) : null;
    },
  },
  {
    key: "aaLongRange",
    labelKey: "ships.spec.aaLongRange",
    get: (p) => aaAura(aaBands(p)?.long),
  },
  {
    key: "aaMidRange",
    labelKey: "ships.spec.aaMidRange",
    get: (p) => aaAura(aaBands(p)?.mid),
  },
  {
    key: "aaShortRange",
    labelKey: "ships.spec.aaShortRange",
    get: (p) => aaAura(aaBands(p)?.short),
  },
];

export const COMPARE_GROUPS: CompareGroup[] = [
  { key: "hull", labelKey: "ships.compare.group.hull", columns: HULL_COLUMNS },
  { key: "artillery", labelKey: "ships.spec.group.artillery", columns: ARTILLERY_COLUMNS },
  { key: "torpedoes", labelKey: "ships.spec.group.torpedoes", columns: TORPEDO_COLUMNS },
  { key: "antiAir", labelKey: "ships.spec.group.antiAir", columns: ANTI_AIR_COLUMNS },
];
