/**
 * Player-friendly ship specification extraction.
 *
 * The WG `/encyclopedia/ships/` `default_profile` object uses internal field
 * names (`anti_aircraft_barrels`, `gun_rate`, `detect_distance_by_ship`,
 * `shot_delay`, etc.) that no normal player understands. This module turns a
 * raw `default_profile` into a structured, grouped, labelled, unit-formatted
 * spec tree that the UI can render directly — modelled on how 浩舰
 * (iwarship.net) presents ships: groups of Survivability / Firepower /
 * Torpedoes / Anti-Air / Mobility / Concealment, each with a handful of
 * human-readable rows.
 *
 * Every label is an i18n key (resolved by the component via `t()`), so this
 * module emits keys + raw values; formatting (units, rounding) is done here
 * so the component stays declarative.
 */
export interface SpecRow {
  /** i18n key under `ships.spec.*`, e.g. "hp" → "ships.spec.hp". */
  key: string;
  /** Pre-formatted display value (units applied). */
  value: string;
  /** Optional i18n key for a help tooltip explaining what this stat means. */
  hint?: string;
}

export interface SpecGroup {
  /** i18n key under `ships.spec.group.*`, e.g. "survivability". */
  group: string;
  /** lucide icon name for the group header. */
  icon: string;
  rows: SpecRow[];
}

export type Profile = Record<string, unknown> | null | undefined;

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

/** Per-shell row: damage, fire chance, muzzle velocity, HE pen estimate.
 *  Returns one row per available shell (HE / SAP / AP / Cruise). */
function shellRows(shells: Record<string, any> | undefined): SpecRow[] {
  if (!shells || typeof shells !== "object") return [];
  const rows: SpecRow[] = [];
  // Order: HE, SAP, AP, Cruise (readable priority for players).
  const order: Array<[string, string, string]> = [
    ["HE", "heShell", "heShellHint"],
    ["CS", "sapShell", "sapShellHint"],
    ["AP", "apShell", "apShellHint"],
    ["Cruise", "cruiseShell", undefined],
  ];
  for (const [key, rowKey, hint] of order) {
    const sh = shells[key];
    if (!sh || typeof sh !== "object") continue;
    const parts: string[] = [];
    const dmg = fmtNum(sh.damage);
    if (dmg) parts.push(dmg);
    // HE / SAP carry a fire / pen affordance.
    if (key === "HE") {
      const fp = num(sh.burn_probability);
      if (fp != null) parts.push(`${fp}% ${fireLabel()}`);
    }
    const spd = num(sh.bullet_speed);
    if (spd != null) parts.push(`${spd} ${speedUnit()}`);
    const rowValue = parts.join(" · ");
    if (rowValue) rows.push({ key: rowKey, value: rowValue, hint });
  }
  return rows;
}

// Tiny locale-aware suffix helpers so the module stays free-format.
function fireLabel(): string {
  return "fire";
}
function speedUnit(): string {
  return "m/s";
}

/** Estimated HE penetration (mm). Germans use caliber/4, others caliber/6. */
function hePenFromCaliber(caliberMm: number | null, nation: string | undefined): number | null {
  if (caliberMm == null || caliberMm <= 0) return null;
  const div = nation === "germany" ? 4 : 6;
  return Math.round(caliberMm / div);
}

/** Extract the main-gun caliber (mm) from the artillery sub-tree.
 *  WG stores barrel diameter under several keys depending on schema; try the
 *  common ones. */
function mainGunCaliber(art: any): number | null {
  if (!art || typeof art !== "object") return null;
  // `barrelDiameter` (mm) on some profiles, or under the first turret.
  const direct = num(art.barrelDiameter) ?? num(art.barrel_diameter) ?? num(art.caliber);
  if (direct != null) return direct;
  return null;
}

/**
 * Build the player-friendly spec tree from a raw WG `default_profile`.
 * Returns groups in display order; empty groups (no rows) are omitted so a
 * destroyer simply has no "Anti-Air" group rather than showing "—".
 */
export function buildShipSpecs(profile: Profile, nation?: string): SpecGroup[] {
  if (!profile || typeof profile !== "object") return [];
  const p = profile as Record<string, any>;
  const groups: SpecGroup[] = [];

  // ── Survivability ─────────────────────────────────────────────────────
  const survRows: SpecRow[] = [];
  const hull = p.hull as object | undefined;
  const armour = p.armour as object | undefined;
  const hp = fmtNum((hull as any)?.health);
  if (hp) survRows.push({ key: "hp", value: hp, hint: "hpHint" });
  const flood = num((armour as any)?.flood_damage);
  if (flood != null)
    survRows.push({ key: "torpProtection", value: `${flood}%`, hint: "torpProtectionHint" });
  const citadel = armourThickness((armour as any)?.citadel);
  if (citadel != null)
    survRows.push({ key: "citadelArmor", value: `${citadel} mm`, hint: "citadelArmorHint" });
  const deck = armourThickness((armour as any)?.deck);
  if (deck != null) survRows.push({ key: "deckArmor", value: `${deck} mm` });
  const extremities = armourThickness((armour as any)?.extremities);
  if (extremities != null)
    survRows.push({ key: "bowArmor", value: `${extremities} mm`, hint: "bowArmorHint" });
  if (survRows.length) groups.push({ group: "survivability", icon: "Shield", rows: survRows });

  // ── Main Battery (Firepower) ──────────────────────────────────────────
  const art = p.artillery as object | undefined;
  const artRows: SpecRow[] = [];
  const dist = fmtNum((art as any)?.distance, 1);
  if (dist) artRows.push({ key: "mainGunRange", value: `${dist} km`, hint: "mainGunRangeHint" });
  const reload = num((art as any)?.shot_delay);
  if (reload != null)
    artRows.push({ key: "mainGunReload", value: `${reload.toFixed(1)} s`, hint: "mainGunReloadHint" });
  const barrels = num((hull as any)?.artillery_barrels);
  if (barrels != null) artRows.push({ key: "mainGunBarrels", value: String(barrels) });
  const caliber = mainGunCaliber(art);
  if (caliber != null)
    artRows.push({ key: "mainGunCaliber", value: `${caliber} mm`, hint: "mainGunCaliberHint" });
  // Sigma: WG puts it at artillery.sigma (top-level of the artillery block).
  const sigma = num((art as any)?.sigma);
  if (sigma != null)
    artRows.push({ key: "mainGunSigma", value: sigma.toFixed(1), hint: "mainGunSigmaHint" });
  const rot = num((art as any)?.rotation_time);
  if (rot != null)
    artRows.push({ key: "turretTraverse", value: `${rot.toFixed(1)} s / 180°`, hint: "turretTraverseHint" });
  const disp = num((art as any)?.max_dispersion);
  if (disp != null)
    artRows.push({ key: "maxDispersion", value: `${disp} m`, hint: "maxDispersionHint" });
  // HE penetration estimate (mm) — only meaningful if there's an HE shell.
  const shells = (art as any)?.shells as Record<string, any> | undefined;
  const heShell = shells?.HE;
  const hePen = heShell
    ? num(heShell.penetration) ?? hePenFromCaliber(caliber, nation)
    : null;
  if (hePen != null)
    artRows.push({ key: "hePenetration", value: `${hePen} mm`, hint: "hePenetrationHint" });
  // Per-shell rows (damage / fire / muzzle velocity for each shell type).
  artRows.push(...shellRows(shells));
  // DPM (best of HE / AP), computed as perShellDamage × barrels / reload.
  if (barrels != null && reload != null && reload > 0 && shells) {
    const heDmg = num(shells.HE?.damage) ?? null;
    const apDmg = num(shells.AP?.damage) ?? null;
    if (heDmg != null)
      artRows.push({ key: "heDpm", value: fmtNum((heDmg * barrels) / reload)! });
    if (apDmg != null)
      artRows.push({ key: "apDpm", value: fmtNum((apDmg * barrels) / reload)! });
  }
  if (artRows.length) groups.push({ group: "artillery", icon: "Crosshair", rows: artRows });

  // ── Torpedoes ─────────────────────────────────────────────────────────
  const torp = p.torpedoes as object | undefined;
  const torpRows: SpecRow[] = [];
  if (torp && typeof torp === "object") {
    const tDist = fmtNum((torp as any).distance, 1);
    if (tDist) torpRows.push({ key: "torpRange", value: `${tDist} km` });
    const tSpeed = num((torp as any).torpedo_speed);
    if (tSpeed != null) torpRows.push({ key: "torpSpeed", value: `${tSpeed} kn` });
    const tDmg = fmtNum((torp as any).max_damage);
    if (tDmg) torpRows.push({ key: "torpDamage", value: tDmg });
    const tReload = num((torp as any).reload_time);
    if (tReload != null) torpRows.push({ key: "torpReload", value: `${tReload.toFixed(1)} s` });
    const tVis = num((torp as any).visibility_dist);
    if (tVis != null)
      torpRows.push({ key: "torpDetect", value: `${tVis.toFixed(1)} km`, hint: "torpDetectHint" });
    const tBarrels = num((hull as any)?.torpedoes_barrels);
    if (tBarrels != null && tBarrels > 0)
      torpRows.push({ key: "torpLaunchers", value: String(tBarrels) });
  }
  if (torpRows.length) groups.push({ group: "torpedoes", icon: "Target", rows: torpRows });

  // ── Anti-Aircraft ─────────────────────────────────────────────────────
  const aa = p.anti_aircraft as object | undefined;
  const aaRows: SpecRow[] = [];
  if (aa && typeof aa === "object") {
    const rating = num((aa as any).defense);
    if (rating != null && rating > 0) aaRows.push({ key: "aaRating", value: String(rating) });
    // WG slots are keyed by range bucket; split into short/mid/long by distance.
    const slots = (aa as any).slots as Record<string, any> | undefined;
    if (slots && typeof slots === "object") {
      const slotList = Object.values(slots)
        .map((s) => ({
          dist: num((s as any).distance),
          dmg: num((s as any).avg_damage),
          guns: num((s as any).guns),
        }))
        .filter((s) => s.dist != null && s.dist > 0 && s.dmg != null);
      slotList.sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0));
      // <3.0 short, 3.0–5.0 mid, >5.0 long (rough aura split).
      const bandOf = (d: number): "short" | "mid" | "long" =>
        d <= 3.0 ? "short" : d <= 5.0 ? "mid" : "long";
      const bands: Record<string, { dmg: number; dist: number }> = {};
      for (const s of slotList) {
        const b = bandOf(s.dist!);
        if (!bands[b] || s.dist! > bands[b].dist) bands[b] = { dmg: s.dmg!, dist: s.dist! };
      }
      if (bands.long)
        aaRows.push({ key: "aaLongRange", value: `${bands.long.dmg.toFixed(0)} DPS · ${bands.long.dist} km` });
      if (bands.mid)
        aaRows.push({ key: "aaMidRange", value: `${bands.mid.dmg.toFixed(0)} DPS · ${bands.mid.dist} km` });
      if (bands.short)
        aaRows.push({ key: "aaShortRange", value: `${bands.short.dmg.toFixed(0)} DPS · ${bands.short.dist} km` });
    }
  }
  if (aaRows.length) groups.push({ group: "antiAir", icon: "Plane", rows: aaRows });

  // ── Mobility ──────────────────────────────────────────────────────────
  const mob = p.mobility as object | undefined;
  const mobRows: SpecRow[] = [];
  if (mob && typeof mob === "object") {
    const speed = num((mob as any).max_speed);
    if (speed != null) mobRows.push({ key: "maxSpeed", value: `${speed.toFixed(1)} kn` });
    const rudder = num((mob as any).rudder_time);
    if (rudder != null)
      mobRows.push({ key: "rudderShift", value: `${rudder.toFixed(1)} s`, hint: "rudderShiftHint" });
    const radius = num((mob as any).turning_radius);
    if (radius != null)
      mobRows.push({ key: "turningRadius", value: `${radius} m`, hint: "turningRadiusHint" });
  }
  if (mobRows.length) groups.push({ group: "mobility", icon: "Gauge", rows: mobRows });

  // ── Concealment ───────────────────────────────────────────────────────
  const con = p.concealment as object | undefined;
  const conRows: SpecRow[] = [];
  if (con && typeof con === "object") {
    const byShip = num((con as any).detect_distance_by_ship);
    if (byShip != null)
      conRows.push({ key: "surfaceDetect", value: `${byShip.toFixed(1)} km`, hint: "surfaceDetectHint" });
    const byPlane = num((con as any).detect_distance_by_plane);
    if (byPlane != null)
      conRows.push({ key: "airDetect", value: `${byPlane.toFixed(1)} km`, hint: "airDetectHint" });
    const bySub = num((con as any).detect_distance_by_submarine);
    if (bySub != null) conRows.push({ key: "subDetect", value: `${bySub.toFixed(1)} km` });
  }
  if (conRows.length) groups.push({ group: "concealment", icon: "Eye", rows: conRows });

  return groups;
}
