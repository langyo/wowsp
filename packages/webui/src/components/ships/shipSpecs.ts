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
 *
 * Anti-Air needs the raw GameParams entry: WG's default_profile only carries
 * the opaque `anti_aircraft.defense` rating (slot DPS/range always null/-1),
 * so the per-band rows come from `buildAntiAirRows(gameparams)` when the
 * caller has unpacked one.
 *
 * Submarines read the raw GameParams entry harder still: the sonar (pinger)
 * group prefers the top-configuration `A_PingerGun` block (falling back to
 * WG's stock `submarine_sonar` profile block), and per-TYPE torpedo detail
 * (a Surcouf-style sub fields two torpedo types at once) comes from the
 * `__torpedoAmmo` entities the desktop/materializer embeds into the slice
 * (slice shape v2 — per-type damage, `distanceOfDamage` falloff tiers and
 * the `SubmarineTorpedoParams` ping-response homing numbers; the WG profile
 * carries none of it). Groups with multiple weapons of one kind (shell
 * types, torpedo types) carry `sections` — labelled row blocks the panel
 * renders with internal divider lines.
 */
import { buildAntiAirRows } from "./antiAir";
import { mainCaliberMm, resolveShipParts, roleHpSlots } from "./shipParts";
export interface SpecRow {
  /** i18n key under `ships.spec.*`, e.g. "hp" → "ships.spec.hp". */
  key: string;
  /** Pre-formatted display value (units applied). */
  value: string;
  /** Optional i18n key for a help tooltip explaining what this stat means. */
  hint?: string;
}

/**
 * One labelled block of rows inside a group. A group carrying several
 * weapons of one kind (main battery HE + AP shells, a sub's homing +
 * straight-running torpedo types) splits into sections so the panel can
 * divide them with internal separator lines instead of interleaving rows.
 */
export interface SpecSection {
  /** i18n key for the block label, resolved under `ships.spec.*`. */
  labelKey: string;
  /** Optional i18n key for a help tooltip explaining the section. */
  hintKey?: string;
  /** Optional raw suffix appended to the label (e.g. " · 10.0 km" to tell
   * two same-type torpedo sections apart). */
  suffix?: string;
  rows: SpecRow[];
}

export interface SpecGroup {
  /** i18n key under `ships.spec.group.*`, e.g. "survivability". */
  group: string;
  /** lucide icon name for the group header. */
  icon: string;
  /** Group-level rows (shared by every weapon of the group). */
  rows: SpecRow[];
  /** Per-weapon row blocks; when present the panel renders these under the
   * group rows, divided by separator lines. */
  sections?: SpecSection[];
}

export type Profile = Record<string, unknown> | null | undefined;

/**
 * Minimal views of the raw WG data this module reads. Fields stay `unknown`
 * on purpose — missing / null / mis-typed entries are the norm (see module
 * header) — and every read still flows through `num()` / `fmtNum()` /
 * `armourThickness()`, which defend at runtime. These shapes assert one
 * step at a time off an `unknown` value, never across two hops.
 */
interface ShellEntry {
  damage?: unknown;
  burn_probability?: unknown;
  burn_chance?: unknown;
  bullet_speed?: unknown;
  penetration?: unknown;
}

interface HullBlock {
  health?: unknown;
  artillery_barrels?: unknown;
  torpedoes_barrels?: unknown;
}

interface ArmourBlock {
  flood_damage?: unknown;
  citadel?: unknown;
  deck?: unknown;
  extremities?: unknown;
}

interface ArtilleryBlock {
  distance?: unknown;
  shot_delay?: unknown;
  sigma?: unknown;
  rotation_time?: unknown;
  max_dispersion?: unknown;
  shells?: Record<string, ShellEntry | undefined>;
}

interface TorpedoesBlock {
  distance?: unknown;
  torpedo_speed?: unknown;
  max_damage?: unknown;
  reload_time?: unknown;
  visibility_dist?: unknown;
}

interface MobilityBlock {
  max_speed?: unknown;
  rudder_time?: unknown;
  turning_radius?: unknown;
}

/** WG stock sonar block (`submarine_sonar`) — the GameParams-less fallback. */
interface SubmarineSonarBlock {
  wave_max_dist?: unknown;
  wave_shot_delay?: unknown;
  wave_speed_max?: unknown;
  wave_width?: unknown;
  wave_duration_0?: unknown;
  wave_duration_1?: unknown;
}

/** WG battery block (`submarine_battery`). */
interface SubmarineBatteryBlock {
  max_capacity?: unknown;
  consumption_rate?: unknown;
  regen_rate?: unknown;
}

/** WG underwater-mobility block (`submarine_mobility`). */
interface SubmarineMobilityBlock {
  max_speed_under_water?: unknown;
  buoyancy_rudder_time?: unknown;
  max_buoyancy_speed?: unknown;
}

interface ConcealmentBlock {
  detect_distance_by_ship?: unknown;
  detect_distance_by_plane?: unknown;
  detect_distance_by_submarine?: unknown;
}

/**
 * A torpedo Projectile entity out of the slice's embedded `__torpedoAmmo`
 * (shape v2). `distanceOfDamage` tiers and the homing params only exist on
 * submarine torpedoes; surface ships render sections too, limited to their
 * top-configuration launchers' mounted types.
 */
interface TorpedoAmmoEntry {
  alphaDamage?: unknown;
  speed?: unknown;
  /** ×0.03 → km (the GameParams distance scale: 466.7 → 14.0 km). */
  maxDist?: unknown;
  visibilityFactor?: unknown;
  uwCritical?: unknown;
  damageCoeffMaxPing?: unknown;
  /** [dist, coeff] pairs, dist in the same ×0.03 km scale. */
  distanceOfDamage?: unknown;
  ammoType?: unknown;
  SubmarineTorpedoParams?: {
    yawChangeSpeed?: unknown;
    maxYaw?: unknown;
    dropTargetAtDistance?: Record<string, unknown> | undefined;
  } | undefined;
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

/** WG armour sub-objects use {max, min} where -1 / 0 means "not applicable".
 *  Return the meaningful value or null. */
function armourThickness(v: unknown): number | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as { max?: number; min?: number };
  const m = num(o.max);
  if (m == null || m <= 0) return null;
  return m;
}

/** First finite number of a possibly-nested array (`waveSpeed[0]`,
 *  `sectorParams[0].width` — GameParams loves redundant per-wave arrays). */
function firstNum(...path: unknown[]): number | null {
  let cur: unknown[] = path;
  while (cur.length > 0) {
    const head = cur[0];
    if (typeof head === "number") return Number.isFinite(head) ? head : null;
    if (head == null) return null;
    if (Array.isArray(head)) {
      cur = head;
      continue;
    }
    if (typeof head === "object") {
      // Take the FIRST numeric-valued property in key order (defensive:
      // these are single-value dicts in practice).
      const vals = Object.values(head as Record<string, unknown>);
      if (vals.length === 0) return null;
      cur = [vals[0]];
      continue;
    }
    return null;
  }
  return null;
}

/** GameParams distance scale → km (maxDist 466.7 renders as 14.0 km, the
 *  encyclopedia's `torpedoes.distance` for the same launcher). */
function gpDistKm(v: unknown): number | null {
  const n = num(v);
  if (n == null || n <= 0) return null;
  return n * 0.03;
}

// Tiny locale-aware suffix helper so the module stays free-format.
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
function mainGunCaliber(art: unknown): number | null {
  if (!art || typeof art !== "object") return null;
  const o = art as {
    barrelDiameter?: unknown;
    barrel_diameter?: unknown;
    caliber?: unknown;
  };
  // `barrelDiameter` (mm) on some profiles, or under the first turret.
  const direct = num(o.barrelDiameter) ?? num(o.barrel_diameter) ?? num(o.caliber);
  if (direct != null) return direct;
  return null;
}

/** Per-shell section: damage / muzzle velocity / fire chance / pen / DPM for
 *  one shell type — the main battery splits per shell so the panel can
 *  divide same-group weapon types with separator lines. */
function shellSections(
  shells: Record<string, unknown> | undefined,
  barrels: number | null,
  reload: number | null,
  caliber: number | null,
  nation?: string,
): SpecSection[] {
  if (!shells || typeof shells !== "object") return [];
  const order: Array<[string, string, string | undefined]> = [
    ["HE", "heShell", "heShellHint"],
    ["CS", "sapShell", "sapShellHint"],
    ["AP", "apShell", "apShellHint"],
    ["Cruise", "cruiseShell", undefined],
  ];
  const out: SpecSection[] = [];
  for (const [key, labelKey, hintKey] of order) {
    const sh = shells[key];
    if (!sh || typeof sh !== "object" || !labelKey) continue;
    const e = sh as ShellEntry;
    const rows: SpecRow[] = [];
    const dmg = fmtNum(e.damage);
    if (dmg) rows.push({ key: "shellDamage", value: dmg, hint: "shellDamageHint" });
    // HE fire chance in percent. WG's burn_probability is ALREADY a
    // percentage (NC 406 mm HE = 36.0) — multiplying by 100 rendered
    // 1000%-style values across the whole fleet.
    if (key === "HE") {
      const burn = num(e.burn_probability) ?? num(e.burn_chance);
      if (burn != null) rows.push({ key: "fireChance", value: `${Math.round(burn)}%` });
      const pen = num(e.penetration) ?? hePenFromCaliber(caliber, nation);
      if (pen != null)
        rows.push({ key: "hePenetration", value: `${pen} mm`, hint: "hePenetrationHint" });
    }
    const spd = num(e.bullet_speed);
    if (spd != null) rows.push({ key: "shellSpeed", value: `${spd} ${speedUnit()}` });
    // DPM = perShellDamage × barrels × 60 / reload — reload is seconds, so
    // the ×60 converts to per-minute (a plain damage × barrels / reload
    // silently showed damage per SECOND). Only HE/AP carry DPM rows (the
    // historic set); SAP / Cruise sections stay without one.
    if ((key === "HE" || key === "AP") && barrels != null && reload != null && reload > 0 && dmg) {
      const dpm = (Number(dmg.replace(/[^0-9.-]/g, "")) * barrels * 60) / reload;
      rows.push({ key: key === "AP" ? "apDpm" : "heDpm", value: fmtNum(dpm)! });
    }
    if (rows.length) out.push({ labelKey, hintKey, rows });
  }
  return out;
}

/**
 * Submarine sonar (the pinger weapon) rows. The raw GameParams block wins —
 * it is the TOP-configuration module the rest of the panel agrees on — and
 * WG's `submarine_sonar` profile block (stock numbers) answers when the
 * slice is unavailable, so every submarine still gets a sonar group.
 *
 * The two mark durations are separate rows (single-ping / double-ping): a
 * first ping marks the target for the shorter duration, a second ping
 * (double ping) extends it. GameParams carries them per sector
 * (`sectorParams[i].lifetime`, one entry per ping tier); WG's profile splits
 * them into `wave_duration_0` / `wave_duration_1`. The Lesta client's
 * schema instead ships one `sectorLifetime` per ship (no tier split), which
 * renders as a single neutral mark-duration row.
 */
function sonarRows(gameparams: unknown, profile: Profile): SpecRow[] {
  const rows: SpecRow[] = [];
  const gp = gameparams as Record<string, unknown> | null | undefined;
  let pg: Record<string, unknown> | null = null;
  if (gp && typeof gp === "object") {
    const resolved = resolveShipParts(gp, "top").pinger;
    pg = (resolved && resolved.length > 0 ? resolved[0] : null) as Record<string, unknown> | null;
  }
  if (pg) {
    const range = num(pg.waveDistance);
    if (range != null && range > 0)
      rows.push({ key: "sonarRange", value: `${(range / 1000).toFixed(1)} km`, hint: "sonarRangeHint" });
    const reload = num(pg.waveReloadTime);
    if (reload != null && reload > 0)
      rows.push({ key: "sonarReload", value: `${reload.toFixed(1)} s`, hint: "sonarReloadHint" });
    // waveParams: [{ startWaveWidth, endWaveWidth, waveSpeed: [500×5], … }]
    const wp = Array.isArray(pg.waveParams) ? (pg.waveParams[0] as Record<string, unknown> | undefined) : undefined;
    const speed = firstNum(wp?.waveSpeed);
    if (speed != null && speed > 0)
      rows.push({ key: "sonarWaveSpeed", value: `${Math.round(speed)} ${speedUnit()}` });
    const sector = Array.isArray(pg.sectorParams) ? (pg.sectorParams[0] as Record<string, unknown> | undefined) : undefined;
    const width = num(sector?.width);
    if (width != null && width > 0)
      rows.push({ key: "sonarWidth", value: `${width.toFixed(0)}°`, hint: "sonarWidthHint" });
    // One sectorParams entry per ping tier: [0] = first ping, [1] = the
    // double (second) ping. Rendered as two explicit rows.
    const lifetimes = (Array.isArray(pg.sectorParams) ? pg.sectorParams : [])
      .map((s) => num((s as Record<string, unknown>)?.lifetime))
      .filter((v): v is number => v != null);
    if (lifetimes[0] != null)
      rows.push({ key: "sonarPing1", value: `${lifetimes[0].toFixed(0)} s`, hint: "sonarPing1Hint" });
    if (lifetimes[1] != null)
      rows.push({ key: "sonarPing2", value: `${lifetimes[1].toFixed(0)} s`, hint: "sonarPing2Hint" });
    // The Lesta client's schema has no per-tier sectorParams: one per-ship
    // `sectorLifetime` covers both ping tiers, so it renders as a single
    // neutral mark-duration row (no single/double split to report).
    if (lifetimes.length === 0) {
      const legacy = num(pg.sectorLifetime);
      if (legacy != null && legacy > 0)
        rows.push({
          key: "sonarMarkTime",
          value: `${legacy.toFixed(0)} s`,
          hint: "sonarMarkTimeHint",
        });
    }
  } else {
    const sonar = profile?.submarine_sonar as SubmarineSonarBlock | undefined;
    if (!sonar || typeof sonar !== "object") return [];
    const range = num(sonar.wave_max_dist);
    if (range != null && range > 0)
      rows.push({ key: "sonarRange", value: `${range.toFixed(1)} km`, hint: "sonarRangeHint" });
    const reload = num(sonar.wave_shot_delay);
    if (reload != null && reload > 0)
      rows.push({ key: "sonarReload", value: `${reload.toFixed(1)} s`, hint: "sonarReloadHint" });
    const speed = num(sonar.wave_speed_max);
    if (speed != null && speed > 0)
      rows.push({ key: "sonarWaveSpeed", value: `${Math.round(speed)} ${speedUnit()}` });
    const width = num(sonar.wave_width);
    if (width != null && width > 0)
      rows.push({ key: "sonarWidth", value: `${width.toFixed(0)}°`, hint: "sonarWidthHint" });
    const t0 = num(sonar.wave_duration_0);
    const t1 = num(sonar.wave_duration_1);
    if (t0 != null) rows.push({ key: "sonarPing1", value: `${t0.toFixed(0)} s`, hint: "sonarPing1Hint" });
    if (t1 != null) rows.push({ key: "sonarPing2", value: `${t1.toFixed(0)} s`, hint: "sonarPing2Hint" });
  }
  return rows;
}

/** Submarine battery rows (WG profile block — capacity / drain / regen). */
function batteryRows(profile: Profile): SpecRow[] {
  const b = profile?.submarine_battery as SubmarineBatteryBlock | undefined;
  if (!b || typeof b !== "object") return [];
  const rows: SpecRow[] = [];
  const cap = num(b.max_capacity);
  if (cap != null && cap > 0)
    rows.push({ key: "batteryCapacity", value: fmtNum(cap)!, hint: "batteryCapacityHint" });
  const drain = num(b.consumption_rate);
  if (drain != null && drain > 0)
    rows.push({ key: "batteryDrain", value: `${drain.toFixed(1)}/s` });
  const regen = num(b.regen_rate);
  if (regen != null && regen > 0)
    rows.push({ key: "batteryRegen", value: `${regen.toFixed(1)}/s` });
  return rows;
}

/** `distanceOfDamage` tiers → "<km> km → <pct>%" chain (same ×0.03 km scale
 *  as maxDist; most subs carry only the 2.5 km ×10% → ×100% pair, graduated
 *  hulls like Arona's Whale ramp through 4 tiers out past 11 km). */
function falloffValue(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const parts: string[] = [];
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const d = gpDistKm(pair[0]);
    const c = num(pair[1]);
    if (d == null || c == null) continue;
    parts.push(`${d.toFixed(1)} km → ${Math.round(c * 100)}%`);
  }
  return parts.length ? parts.join(" · ") : null;
}

/** Homing cut-off per ship class at double ping (`dropTargetAtDistance`
 *  values are metres; index 0 = single ping, 1 = double). Fixed display
 *  order BB / CA / DD / SS, explained by the row hint. */
function homingCutoffValue(raw: Record<string, unknown> | undefined): string | null {
  if (!raw || typeof raw !== "object") return null;
  const km = (v: unknown): string | null => {
    const arr = Array.isArray(v) ? v : null;
    if (!arr) return null;
    const m = num(arr[Math.min(1, arr.length - 1)]);
    if (m == null || m <= 0) return null;
    // Two decimals, trailing zeros trimmed ("1.60" → "1.6", "0.12" stays).
    return (m / 1000).toFixed(2).replace(/\.?0+$/, "");
  };
  const bb = km(raw.Battleship);
  const ca = km(raw.Cruiser);
  const dd = km(raw.Destroyer);
  const ss = km(raw.Submarine);
  const parts = [bb, ca, dd, ss].filter((v): v is string => v != null);
  return parts.length ? `${parts.join(" / ")} km` : null;
}

/**
 * Per-torpedo-type sections from the slice's embedded `__torpedoAmmo`
 * entities (slice shape v2). Homing types (carrying `SubmarineTorpedoParams`)
 * and straight-runners get labelled sections; two sections of the same kind
 * disambiguate with a "range · speed" suffix (a Surcouf-style dual-homing
 * fit). Only the TOP configuration's launchers decide what renders: the
 * embedding carries every ammo entity any launcher block references —
 * researchable alternates included (Shimakaze A1/A2/A3) — while the panel
 * shows the mounted fit. Returns [] when the slice predates the embedding —
 * the caller then keeps the WG profile's single-torpedo rows.
 */
function torpedoSections(gameparams: unknown): SpecSection[] {
  const gp = gameparams as Record<string, unknown> | null | undefined;
  const ammo = gp?.__torpedoAmmo;
  if (!ammo || typeof ammo !== "object" || Array.isArray(ammo)) return [];
  // Ammo names mounted by the top-configuration torpedo launchers.
  const mounted = new Set<string>();
  if (gp) {
    for (const [, slot] of roleHpSlots(resolveShipParts(gp, "top").torpedoes)) {
      for (const name of Array.isArray(slot.ammoList) ? slot.ammoList : []) {
        if (typeof name === "string") mounted.add(name);
      }
    }
  }
  // An empty mounted set (no top torpedo launcher resolved — exotic slice
  // shapes) deliberately falls back to every embedded entity rather than
  // dropping the group's per-type detail entirely.
  const sections: SpecSection[] = [];
  for (const [name, entity] of Object.entries(ammo)) {
    if (mounted.size > 0 && !mounted.has(name)) continue;
    if (!entity || typeof entity !== "object") continue;
    const e = entity as TorpedoAmmoEntry;
    const rows: SpecRow[] = [];
    const dmg = fmtNum(e.alphaDamage);
    if (dmg) rows.push({ key: "torpDamage", value: dmg });
    const speed = num(e.speed);
    if (speed != null && speed > 0) rows.push({ key: "torpSpeed", value: `${Math.round(speed)} kn` });
    const range = gpDistKm(e.maxDist);
    if (range != null) rows.push({ key: "torpRange", value: `${range.toFixed(1)} km` });
    const vis = num(e.visibilityFactor);
    if (vis != null && vis > 0)
      rows.push({ key: "torpDetect", value: `${vis.toFixed(1)} km`, hint: "torpDetectHint" });
    const flood = num(e.uwCritical);
    if (flood != null && flood > 0)
      rows.push({ key: "torpFlood", value: `${Math.round(flood * 100)}%`, hint: "torpFloodHint" });
    const falloff = falloffValue(e.distanceOfDamage);
    if (falloff) rows.push({ key: "torpFalloff", value: falloff, hint: "torpFalloffHint" });
    const stp = e.SubmarineTorpedoParams;
    if (stp && typeof stp === "object") {
      const coeff = num(e.damageCoeffMaxPing);
      if (coeff != null && coeff > 0)
        rows.push({ key: "torpDoublePing", value: `×${coeff.toFixed(coeff % 1 ? 1 : 0)}`, hint: "torpDoublePingHint" });
      const yawRaw = Array.isArray(stp.yawChangeSpeed)
        ? stp.yawChangeSpeed.map((v) => num(v)).filter((v): v is number => v != null)
        : [];
      // Triple ping tiers exist in the data but repeat the double value —
      // collapse consecutive duplicates so the row reads single/double.
      const yaw = yawRaw.filter((v, i) => i === 0 || v !== yawRaw[i - 1]);
      if (yaw.length > 0)
        rows.push({
          key: "torpHomingYaw",
          value: yaw.map((v) => `${v.toFixed(1)}°/s`).join(" / "),
          hint: "torpHomingYawHint",
        });
      const cutoff = homingCutoffValue(stp.dropTargetAtDistance);
      if (cutoff) rows.push({ key: "torpHomingCutoff", value: cutoff, hint: "torpHomingCutoffHint" });
    }
    if (rows.length === 0) continue;
    const homing = stp && typeof stp === "object";
    const suffix =
      range != null && speed != null ? ` · ${range.toFixed(1)} km / ${Math.round(speed)} kn` : undefined;
    sections.push({ labelKey: homing ? "torpHomingSection" : "torpStraightSection", suffix, rows });
  }
  // Disambiguate same-kind sections (two homing types): keep the suffix only
  // on duplicates so the common single-type case stays clean.
  const kinds: Record<string, number> = {};
  for (const s of sections) kinds[s.labelKey] = (kinds[s.labelKey] ?? 0) + 1;
  for (const s of sections) {
    if ((kinds[s.labelKey] ?? 0) < 2) s.suffix = undefined;
  }
  return sections;
}

/**
 * Build the player-friendly spec tree from a raw WG `default_profile`.
 * Returns groups in display order; empty groups (no rows) are omitted so a
 * destroyer simply has no "Anti-Air" group rather than showing "—".
 * `gameparams` is the raw GameParams entry the modal unpacked (optional —
 * without it the AA group is simply absent, matching the WG API's lack of
 * usable AA numbers, and submarines fall back to their WG sonar/battery
 * profile blocks).
 */
export function buildShipSpecs(profile: Profile, nation?: string, gameparams?: unknown): SpecGroup[] {
  if (!profile || typeof profile !== "object") return [];
  const p = profile as Record<string, unknown>;
  const groups: SpecGroup[] = [];

  // ── Survivability ─────────────────────────────────────────────────────
  const survRows: SpecRow[] = [];
  const hull = p.hull as HullBlock | undefined;
  const armour = p.armour as ArmourBlock | undefined;
  const hp = fmtNum(hull?.health);
  if (hp) survRows.push({ key: "hp", value: hp, hint: "hpHint" });
  const flood = num(armour?.flood_damage);
  if (flood != null)
    survRows.push({ key: "torpProtection", value: `${flood}%`, hint: "torpProtectionHint" });
  const citadel = armourThickness(armour?.citadel);
  if (citadel != null)
    survRows.push({ key: "citadelArmor", value: `${citadel} mm`, hint: "citadelArmorHint" });
  const deck = armourThickness(armour?.deck);
  if (deck != null) survRows.push({ key: "deckArmor", value: `${deck} mm` });
  const extremities = armourThickness(armour?.extremities);
  if (extremities != null)
    survRows.push({ key: "bowArmor", value: `${extremities} mm`, hint: "bowArmorHint" });
  if (survRows.length) groups.push({ group: "survivability", icon: "Shield", rows: survRows });

  // ── Main Battery (Firepower) ──────────────────────────────────────────
  const art = p.artillery as ArtilleryBlock | undefined;
  const artRows: SpecRow[] = [];
  const dist = fmtNum(art?.distance, 1);
  if (dist) artRows.push({ key: "mainGunRange", value: `${dist} km`, hint: "mainGunRangeHint" });
  const reload = num(art?.shot_delay);
  if (reload != null)
    artRows.push({ key: "mainGunReload", value: `${reload.toFixed(1)} s`, hint: "mainGunReloadHint" });
  const barrels = num(hull?.artillery_barrels);
  if (barrels != null) artRows.push({ key: "mainGunBarrels", value: String(barrels) });
  // WG's default_profile carries NO caliber field at all (verified across the
  // whole fleet: artillery keys are artillery_id/distance/gun_rate/
  // max_dispersion/rotation_time/shells/shot_delay/slots) — fall back to the
  // raw GameParams entry's widest turret barrelDiameter when it is loaded.
  const caliber =
    mainGunCaliber(art) ?? mainCaliberMm(gameparams as Record<string, unknown> | null | undefined);
  if (caliber != null)
    artRows.push({ key: "mainGunCaliber", value: `${caliber} mm`, hint: "mainGunCaliberHint" });
  // Sigma: WG puts it at artillery.sigma (top-level of the artillery block).
  const sigma = num(art?.sigma);
  if (sigma != null)
    artRows.push({ key: "mainGunSigma", value: sigma.toFixed(1), hint: "mainGunSigmaHint" });
  const rot = num(art?.rotation_time);
  if (rot != null)
    artRows.push({ key: "turretTraverse", value: `${rot.toFixed(1)} s / 180°`, hint: "turretTraverseHint" });
  const disp = num(art?.max_dispersion);
  if (disp != null)
    artRows.push({ key: "maxDispersion", value: `${disp} m`, hint: "maxDispersionHint" });
  // Per-shell sections (damage / fire / velocity / DPM per type), divided by
  // separator lines when the battery fields several shell kinds at once.
  const artSections = shellSections(art?.shells, barrels, reload, caliber, nation);
  if (artRows.length || artSections.length)
    groups.push({ group: "artillery", icon: "Crosshair", rows: artRows, sections: artSections.length ? artSections : undefined });

  // ── Torpedoes ─────────────────────────────────────────────────────────
  const torp = p.torpedoes as TorpedoesBlock | undefined;
  const torpSections = torpedoSections(gameparams);
  const torpRows: SpecRow[] = [];
  if (torp && typeof torp === "object") {
    const tReload = num(torp.reload_time);
    if (tReload != null) torpRows.push({ key: "torpReload", value: `${tReload.toFixed(1)} s` });
    const tBarrels = num(hull?.torpedoes_barrels);
    if (tBarrels != null && tBarrels > 0)
      torpRows.push({ key: "torpLaunchers", value: String(tBarrels) });
    // The WG block describes ONE torpedo type; when the embedded ammo
    // entities answer per-type sections, the per-type rows move there
    // (damage / speed / range / detect are per-type, not per-launcher).
    if (torpSections.length === 0) {
      const tDist = fmtNum(torp.distance, 1);
      if (tDist) torpRows.push({ key: "torpRange", value: `${tDist} km` });
      const tSpeed = num(torp.torpedo_speed);
      if (tSpeed != null) torpRows.push({ key: "torpSpeed", value: `${tSpeed} kn` });
      const tDmg = fmtNum(torp.max_damage);
      if (tDmg) torpRows.push({ key: "torpDamage", value: tDmg });
      const tVis = num(torp.visibility_dist);
      if (tVis != null)
        torpRows.push({ key: "torpDetect", value: `${tVis.toFixed(1)} km`, hint: "torpDetectHint" });
    }
  }
  if (torpRows.length || torpSections.length)
    groups.push({
      group: "torpedoes",
      icon: "Target",
      rows: torpRows,
      sections: torpSections.length ? torpSections : undefined,
    });

  // ── Sonar (submarine pinger) ──────────────────────────────────────────
  const sRows = sonarRows(gameparams, p);
  if (sRows.length) groups.push({ group: "sonar", icon: "Radar", rows: sRows });

  // ── Submarine battery ─────────────────────────────────────────────────
  const batRows = batteryRows(p);
  if (batRows.length) groups.push({ group: "battery", icon: "BatteryCharging", rows: batRows });

  // ── Anti-Aircraft ─────────────────────────────────────────────────────
  // WG's default_profile only carries the opaque `defense` rating (its slot
  // DPS/range fields are always null/-1); the real per-aura numbers come
  // from the raw GameParams entry the modal already unpacks.
  const aaRows = buildAntiAirRows(gameparams);
  if (aaRows.length) groups.push({ group: "antiAir", icon: "Plane", rows: aaRows });

  // ── Mobility ──────────────────────────────────────────────────────────
  const mob = p.mobility as MobilityBlock | undefined;
  const mobRows: SpecRow[] = [];
  if (mob && typeof mob === "object") {
    const speed = num(mob.max_speed);
    if (speed != null) mobRows.push({ key: "maxSpeed", value: `${speed.toFixed(1)} kn` });
    const rudder = num(mob.rudder_time);
    if (rudder != null)
      mobRows.push({ key: "rudderShift", value: `${rudder.toFixed(1)} s`, hint: "rudderShiftHint" });
    const radius = num(mob.turning_radius);
    if (radius != null)
      mobRows.push({ key: "turningRadius", value: `${radius} m`, hint: "turningRadiusHint" });
  }
  // Submarine underwater mobility rides the same group (WG carries it as a
  // separate `submarine_mobility` block).
  const subMob = p.submarine_mobility as SubmarineMobilityBlock | undefined;
  if (subMob && typeof subMob === "object") {
    const uwSpeed = num(subMob.max_speed_under_water);
    if (uwSpeed != null && uwSpeed > 0)
      mobRows.push({ key: "underwaterSpeed", value: `${uwSpeed.toFixed(1)} kn` });
    const buoySpeed = num(subMob.max_buoyancy_speed);
    if (buoySpeed != null && buoySpeed > 0)
      mobRows.push({ key: "buoyancySpeed", value: `${buoySpeed.toFixed(1)} m/s` });
    const buoyRudder = num(subMob.buoyancy_rudder_time);
    if (buoyRudder != null && buoyRudder > 0)
      mobRows.push({ key: "buoyancyRudder", value: `${buoyRudder.toFixed(1)} s` });
  }
  if (mobRows.length) groups.push({ group: "mobility", icon: "Gauge", rows: mobRows });

  // ── Concealment ───────────────────────────────────────────────────────
  const con = p.concealment as ConcealmentBlock | undefined;
  const conRows: SpecRow[] = [];
  if (con && typeof con === "object") {
    const byShip = num(con.detect_distance_by_ship);
    if (byShip != null)
      conRows.push({ key: "surfaceDetect", value: `${byShip.toFixed(1)} km`, hint: "surfaceDetectHint" });
    const byPlane = num(con.detect_distance_by_plane);
    if (byPlane != null)
      conRows.push({ key: "airDetect", value: `${byPlane.toFixed(1)} km`, hint: "airDetectHint" });
    const bySub = num(con.detect_distance_by_submarine);
    if (bySub != null) conRows.push({ key: "subDetect", value: `${bySub.toFixed(1)} km` });
  }
  if (conRows.length) groups.push({ group: "concealment", icon: "Eye", rows: conRows });

  return groups;
}
