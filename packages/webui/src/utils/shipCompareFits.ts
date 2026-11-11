/**
 * Per-ship weapon-fit enumeration for the batch compare table.
 *
 * A hull's WG `default_profile` (the compare table's baseline row) always
 * describes the FULLY-upgraded ship with its standard ammo — but several
 * hulls carry more than one way to fight, and the report is incomplete
 * without them. Every fit renders as an INDENTED sub-row under its ship
 * (the identity cell steps right, marking it as one of that hull's
 * options); rows only appear for the stat groups the fit actually re-specs:
 *
 *   - the alternate firing mode (替代射击): Vyazma / Laffei / Hawaii style
 *     switchable main batteries (a TOP-configuration capability);
 *   - the STOCK hull's artillery, torpedo AND hull fits (白板配置): the
 *     upgrade chain's head modules, which frequently carry smaller guns,
 *     fewer tubes, less HP or a slower hull than the researched end state;
 *   - the researchable torpedo alternates the slice embeds alongside the
 *     mounted type (Shimakaze A1/A2/A3 — every one of them sees play), each
 *     tagged base/top by whether the STOCK launchers mount it;
 *   - the ASW airstrike (深弹空袭): the A_AirSupport charges the WG profile
 *     has no block for — the ONLY anti-submarine weapon most BB/CV hulls
 *     carry;
 *   - one row per embarked AIRFRAME (carriers & hybrids): torpedo / dive /
 *     skip bombers, rockets, fighters, ASW planes — grouped by role and
 *     tagged base/variant exactly like the detail modal's airframe picker
 *     (shared pipeline: slice planes first, the baked squadron seed as the
 *     offline fallback), stats from the baked plane_specs table.
 *
 * Every fit carries a VARIANT ("base" = the stock configuration's
 * modules/airframes, "top" = the fully-upgraded ship's own extras) that the
 * compare toolbar's armament filter (全部 / 基础 / 升级) filters on; under
 * the base filter the identity row itself steps down to the stock fit's
 * values, so both configurations always get compared.
 *
 * Values come from the per-ship GameParams slice (shape v3): role blocks
 * via `resolveShipParts`, shell/torpedo entities via the `__shellAmmo` /
 * `__torpedoAmmo` embeddings. Formatting mirrors `shipCompare.ts`' getters
 * so a fit row lines up with the baseline columns.
 *
 * No i18n here: label KEYS only (the component resolves them), same
 * discipline as shipCompare.ts.
 */
import {
  buildPlaneOptionsFromSeed,
  buildPlaneOptionsFromSlice,
  squadronSeed,
  type PlaneModelOption,
} from "@/components/ships/shipSquadrons";
import { planeSpecEntry } from "@/components/ships/shipPlaneSpecs";
import { resolveShipParts } from "@/components/ships/shipParts";
import { buildShipSpecs, switchableMainBattery } from "@/components/ships/shipSpecs";
import type { CompareProfile } from "@/utils/shipCompare";

/** Which configuration a fit row speaks for: "base" = the stock hull's
 *  modules / base airframes, "top" = the fully-upgraded ship's own extras
 *  (alternate firing mode, researchable torpedo alternates, upgraded
 *  airframes), "both" = a weapon BOTH configurations carry identically
 *  (the ASW airstrike — hiding it under the stock view would misrepresent
 *  most BB/CV hulls as ASW-less, their only anti-submarine armament). */
export type CompareFitVariant = "base" | "top" | "both";

/** One weapon fit of one hull: a sub-row for the compare table. */
export interface CompareShipFit {
  /** Stable key for the table row (unique per ship). */
  key: string;
  /** FULL i18n key path — the component renders t(labelKey). */
  labelKey: string;
  /** Extra disambiguation rendered beside the label (" · 20 km / 67 kn",
   *  or an airframe's model designation). */
  suffix?: string;
  /** Configuration this row speaks for — the toolbar armament filter's
   *  axis. The identity row itself is always the top configuration. */
  variant: CompareFitVariant;
  /** Render the 白板/升级 chip beside the label (aircraft + torpedo
   *  alternate rows; the other fits' labels already say which fit they
   *  are). */
  chip?: boolean;
  /** Row family: "aircraft" rows are per-airframe and survive the base
   *  filter as rows (the identity row cannot carry them — it collapses
   *  into a summary cell); "asw-airstrike" rows are the airstrike weapon,
   *  matched by kind (not by row key) when the view derives ASW
   *  applicability. */
  kind?: "aircraft" | "asw-airstrike";
  /** Stat groups this fit re-specs; the sub-row appears under these. */
  groupKeys: string[];
  /** Compare column key → pre-formatted display value (null → "—"). */
  values: Record<string, string | null>;
}

type Gp = Record<string, unknown> | null | undefined;

function dict(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
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

/** GameParams distance scale (the slice's ×0.03 km: 466.7 → 14.0 km). */
function gpDistKm(v: unknown): number | null {
  const n = num(v);
  if (n == null || n <= 0) return null;
  return n * 0.03;
}

/** Shell Projectile entity out of the slice's `__shellAmmo` embedding. */
interface ShellEntity {
  ammoType?: unknown;
  alphaDamage?: unknown;
  burnProb?: unknown;
  alphaPiercingHE?: unknown;
  bulletSpeed?: unknown;
  name?: unknown;
}

function shellAmmo(gp: Gp): Record<string, ShellEntity> {
  const ammo = dict(dict(gp)?.__shellAmmo);
  const out: Record<string, ShellEntity> = {};
  if (!ammo) return out;
  for (const [name, value] of Object.entries(ammo)) {
    const d = dict(value);
    if (d) out[name] = d as ShellEntity;
  }
  return out;
}

/** Torpedo Projectile entity out of the slice's `__torpedoAmmo` embedding. */
interface TorpedoEntity {
  alphaDamage?: unknown;
  speed?: unknown;
  maxDist?: unknown;
  visibilityFactor?: unknown;
  SubmarineTorpedoParams?: unknown;
}

function torpedoAmmo(gp: Gp): Record<string, TorpedoEntity> {
  const ammo = dict(dict(gp)?.__torpedoAmmo);
  const out: Record<string, TorpedoEntity> = {};
  if (!ammo) return out;
  for (const [name, value] of Object.entries(ammo)) {
    const d = dict(value);
    if (d) out[name] = d as TorpedoEntity;
  }
  return out;
}

/** Mount dicts of one artillery/torpedo block: every entry that carries an
 *  `ammoList` (the SwitchableModeArtilleryModule and bookkeeping entries
 *  have none). Mounts carry barrelDiameter (metres), numBarrels, shotDelay,
 *  rotationSpeed [deg/s] and the shell/torpedo names. */
function mountsOf(block: Gp): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const d = dict(block);
  if (!d) return out;
  for (const value of Object.values(d)) {
    const m = dict(value);
    if (m && Array.isArray(m.ammoList)) out.push(m);
  }
  return out;
}

/** Ammo names mounted by one configuration's torpedo launchers — the base/
 *  top classifier for the embedded torpedo alternates. */
function mountedTorpedoNames(gp: Gp, config: "stock" | "top"): Set<string> {
  const out = new Set<string>();
  for (const block of resolveShipParts(gp, config).torpedoes) {
    for (const mount of mountsOf(block)) {
      for (const name of Array.isArray(mount.ammoList) ? mount.ammoList : []) {
        if (typeof name === "string") out.add(name);
      }
    }
  }
  return out;
}

/** Artillery column values of one artillery block (gameparams shape). */
function artilleryFitValues(
  block: Gp,
  ammo: Record<string, ShellEntity>,
  nation: string | undefined,
): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  const d = dict(block);
  if (!d) return values;
  // Block-level range: raw metres on the module (Yamato 26630 → 26.6 km).
  const rangeM = num(d.maxDist);
  values.mainGunRange = rangeM != null ? rangeM.toFixed(1) + " km" : null;
  const mounts = mountsOf(block);
  let barrelsTotal = 0;
  let reload: number | null = null;
  let caliberMm: number | null = null;
  let traverseDegPerSec: number | null = null;
  const shells: ShellEntity[] = [];
  for (const mount of mounts) {
    const nb = num(mount.numBarrels) ?? 1;
    barrelsTotal += nb;
    const delay = num(mount.shotDelay);
    if (delay != null && reload == null) reload = delay;
    const bd = num(mount.barrelDiameter);
    if (bd != null && caliberMm == null) caliberMm = bd * 1000;
    const rot = Array.isArray(mount.rotationSpeed) ? num(mount.rotationSpeed[0]) : null;
    if (rot != null && rot > 0 && traverseDegPerSec == null) traverseDegPerSec = rot;
    for (const name of Array.isArray(mount.ammoList) ? mount.ammoList : []) {
      if (typeof name === "string") {
        const entity = ammo[name];
        if (entity) shells.push(entity);
      }
    }
  }
  values.mainGunReload = reload != null ? reload.toFixed(1) + " s" : null;
  values.mainGunBarrels = barrelsTotal > 0 ? String(barrelsTotal) : null;
  values.mainGunCaliber = caliberMm != null ? Math.round(caliberMm) + " mm" : null;
  values.turretTraverse =
    traverseDegPerSec != null ? (180 / traverseDegPerSec).toFixed(1) + " s / 180°" : null;
  // Per-shell columns. The exact entity alphaPiercingHE would differ per
  // shell type; the nation-aware estimate mirrors shipCompare.ts so the
  // column stays comparable across fits and with the baseline row.
  const he = shells.find((s) => String(s.ammoType) === "HE") ?? null;
  const ap = shells.find((s) => String(s.ammoType) === "AP") ?? null;
  values.heShell = fmtNum(he?.alphaDamage);
  const speed = num(he?.bulletSpeed) ?? num(ap?.bulletSpeed);
  values.shellSpeed = speed != null ? speed + " m/s" : null;
  const burn = num(he?.burnProb);
  values.fireChance = burn != null ? Math.round(burn * 100) + "%" : null;
  const hePen = num(he?.alphaPiercingHE);
  if (hePen != null) {
    values.hePenetration = hePen + " mm";
  } else {
    const divisor = nation === "germany" ? 4 : 6;
    values.hePenetration = caliberMm != null ? Math.round(caliberMm / divisor) + " mm" : null;
  }
  const heDmg = num(he?.alphaDamage);
  values.heDpm =
    heDmg != null && barrelsTotal > 0 && reload != null && reload > 0
      ? fmtNum((heDmg * barrelsTotal * 60) / reload)
      : null;
  values.apShell = fmtNum(ap?.alphaDamage);
  const apDmg = num(ap?.alphaDamage);
  values.apDpm =
    apDmg != null && barrelsTotal > 0 && reload != null && reload > 0
      ? fmtNum((apDmg * barrelsTotal * 60) / reload)
      : null;
  return values;
}

/** Torpedo column values of one torpedo entity. */
function torpedoFitValues(entity: TorpedoEntity): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  values.torpDamage = fmtNum(entity.alphaDamage);
  const speed = num(entity.speed);
  values.torpSpeed = speed != null && speed > 0 ? String(Math.round(speed)) + " kn" : null;
  const range = gpDistKm(entity.maxDist);
  values.torpRange = range != null ? range.toFixed(1) + " km" : null;
  const vis = num(entity.visibilityFactor);
  values.torpDetect = vis != null && vis > 0 ? vis.toFixed(1) + " km" : null;
  return values;
}

/** Structural equality of two role-block sets (ammo sets + per-mount
 *  numbers): a stock configuration resolving to the same modules as the
 *  top one must not emit a duplicate row. Per-mount numBarrels counts in
 *  the signature — a stock→top re-arm that keeps the same torpedo type
 *  but changes the tube count (Furutaka-style) still reads as a
 *  difference. */
function blocksDiffer(a: Gp[], b: Gp[]): boolean {
  const sig = (blocks: Gp[]): unknown[] =>
    blocks.map((block) => {
      const d = dict(block);
      if (!d) return null;
      return {
        ammo: mountsOf(d)
          .flatMap((m) => (Array.isArray(m.ammoList) ? m.ammoList : []))
          .sort(),
        maxDist: d.maxDist ?? null,
        mounts: mountsOf(d).map((m) => ({
          numBarrels: m.numBarrels ?? null,
          shotDelay: m.shotDelay ?? null,
        })),
      };
    });
  return JSON.stringify(sig(a)) !== JSON.stringify(sig(b));
}

/** Whether two hull blocks differ in any player-facing number (health /
 *  speed / turning circle) — the hull stock fit's dedupe gate. */
function hullBlocksDiffer(a: Gp, b: Gp): boolean {
  const sig = (hull: Gp): unknown[] => {
    const d = dict(hull);
    if (!d) return [];
    return [d.health ?? null, d.maxSpeed ?? null, d.turningRadius ?? null];
  };
  return JSON.stringify(sig(a)) !== JSON.stringify(sig(b));
}

/** Alternate-firing fit from buildShipSpecs' alt-mode output: the artillery
 *  rows and the HE/AP shell sections already carry the mode's values (and
 *  the burst cycle's DPM). A TOP-configuration capability. */
function altFireFit(profile: CompareProfile | null | undefined, nation: string | undefined, gp: Gp): CompareShipFit | null {
  // A hull without a switchable module has no alternate mode — the alt-mode
  // build would answer with the NORMAL values and the fit row would just
  // duplicate the baseline.
  if (switchableMainBattery(gp) == null) return null;
  const groups = buildShipSpecs(profile as Record<string, unknown>, nation, gp, { altFire: true });
  const artillery = groups.find((g) => g.group === "artillery");
  if (!artillery) return null;
  const specValue = new Map<string, string>();
  for (const row of artillery.rows) specValue.set(row.key, row.value);
  for (const section of artillery.sections ?? []) {
    for (const row of section.rows) {
      // Section rows repeat keys per shell kind — prefix with the section
      // label ("heShell" / "apShell" / …) so HE and AP stay distinct.
      specValue.set(section.labelKey + ":" + row.key, row.value);
    }
  }
  const columnSource: Record<string, string> = {
    mainGunRange: "mainGunRange",
    mainGunReload: "mainGunReload",
    mainGunBarrels: "mainGunBarrels",
    mainGunCaliber: "mainGunCaliber",
    turretTraverse: "turretTraverse",
    maxDispersion: "maxDispersion",
    heShell: "heShell:shellDamage",
    fireChance: "heShell:fireChance",
    hePenetration: "heShell:hePenetration",
    shellSpeed: "heShell:shellSpeed",
    heDpm: "heShell:heDpm",
    apShell: "apShell:shellDamage",
    apDpm: "apShell:apDpm",
  };
  const values: Record<string, string | null> = {};
  for (const [column, specKey] of Object.entries(columnSource)) {
    const v = specValue.get(specKey);
    values[column] = v ?? null;
  }
  return {
    key: "altFire",
    labelKey: "ships.spec.altFire",
    variant: "top",
    groupKeys: ["artillery"],
    values,
  };
}

/** Stock-hull ARTILLERY fit from the upgrade chain's head modules. Emitted
 *  only when the stock artillery modules actually differ from the top
 *  configuration (a single-hull premium resolves to the same blocks and
 *  would duplicate the baseline row). */
function stockArtilleryFit(gp: Gp, nation: string | undefined): CompareShipFit | null {
  if (!gp) return null;
  const stock = resolveShipParts(gp, "stock");
  const top = resolveShipParts(gp, "top");
  if (!blocksDiffer(stock.artillery, top.artillery)) return null;
  const ammo = shellAmmo(gp);
  const values: Record<string, string | null> = {};
  for (const block of stock.artillery) Object.assign(values, artilleryFitValues(block, ammo, nation));
  return {
    key: "stock-artillery",
    labelKey: "ships.compare.fit.stock",
    variant: "base",
    groupKeys: ["artillery"],
    values,
  };
}

/** Stock-hull TORPEDO fit: the upgrade chain's head torpedo modules and
 *  their mounted type. Only when they differ from the top configuration. */
function stockTorpedoFit(gp: Gp): CompareShipFit | null {
  if (!gp) return null;
  const stock = resolveShipParts(gp, "stock");
  const top = resolveShipParts(gp, "top");
  if (!blocksDiffer(stock.torpedoes, top.torpedoes)) return null;
  const ammo = torpedoAmmo(gp);
  let values: Record<string, string | null> | null = null;
  for (const block of stock.torpedoes) {
    for (const mount of mountsOf(block)) {
      for (const name of Array.isArray(mount.ammoList) ? mount.ammoList : []) {
        if (typeof name !== "string") continue;
        const entity = ammo[name];
        if (entity) values = torpedoFitValues(entity);
      }
    }
  }
  if (!values) return null;
  return {
    key: "stock-torpedoes",
    labelKey: "ships.compare.fit.stock",
    variant: "base",
    groupKeys: ["torpedoes"],
    values,
  };
}

/** Stock-HULL fit: the upgrade chain's head hull block. The stock hull
 *  changes HP, top speed and the turning circle; rudder shift / detection
 *  have no GameParams-only formula and stay outside the fit. Top speed
 *  scales the WG baseline (identical engine module on both hulls) by the
 *  hull blocks' raw maxSpeed ratio — mixing WG-displayed and GameParams
 *  raw speeds would misreport by the engine multiplier. */
function stockHullFit(profile: CompareProfile | null | undefined, gp: Gp): CompareShipFit | null {
  if (!gp) return null;
  const stockHull = dict(resolveShipParts(gp, "stock").hull);
  const topHull = dict(resolveShipParts(gp, "top").hull);
  if (!stockHull || !topHull || !hullBlocksDiffer(stockHull, topHull)) return null;
  const values: Record<string, string | null> = {};
  const hp = num(stockHull.health);
  values.hp = hp != null ? Math.round(hp).toLocaleString(undefined, { maximumFractionDigits: 0 }) : null;
  const stockSpeed = num(stockHull.maxSpeed);
  const topSpeed = num(topHull.maxSpeed);
  const baselineSpeed = num(profile?.mobility?.max_speed);
  if (stockSpeed != null && topSpeed != null && topSpeed > 0 && baselineSpeed != null) {
    values.maxSpeed = (baselineSpeed * (stockSpeed / topSpeed)).toFixed(1) + " kn";
  } else {
    values.maxSpeed = null;
  }
  const radius = num(stockHull.turningRadius);
  values.turningRadius = radius != null ? String(Math.round(radius)) + " m" : null;
  return {
    key: "stock-hull",
    labelKey: "ships.compare.fit.stock",
    variant: "base",
    groupKeys: ["hull"],
    values,
  };
}

/** ASW-airstrike fit from the top configuration's A_AirSupport block:
 *  chargesNum charges out to maxDist (raw metres → km) on a reloadTime
 *  cycle — the WG profile carries none of it, and for Yamato/Des
 *  Moines-class hulls this is the ONLY anti-submarine weapon. The damage
 *  column stays blank: the slice embeds no bomb entity for the strike.
 *  Classified "both" (stock and top carry the identical strike block, the
 *  upgrade chain never touches it), so the stock view still reports it. */
export function aswAirstrikeFit(gp: Gp): CompareShipFit | null {
  if (!gp) return null;
  const strike = dict(resolveShipParts(gp, "top").airSupport[0]);
  if (!strike) return null;
  const charges = num(strike.chargesNum);
  const maxDist = num(strike.maxDist);
  if (charges == null || charges <= 0 || maxDist == null || maxDist <= 0) return null;
  const values: Record<string, string | null> = {
    aswRange: (maxDist / 1000).toFixed(1) + " km",
    depthChargePacks: String(charges),
    depthChargeReload: null,
  };
  const reload = num(strike.reloadTime);
  if (reload != null && reload > 0) values.depthChargeReload = reload.toFixed(1) + " s";
  return {
    key: "asw-airstrike",
    labelKey: "ships.compare.fit.aswAirstrike",
    variant: "both",
    kind: "asw-airstrike",
    groupKeys: ["asw"],
    values,
  };
}

/** Whether the hull fields an ASW airstrike at all — groupApplies' extra
 *  fact for the ASW group. */
export function hasAswAirstrike(gp: Gp): boolean {
  return aswAirstrikeFit(gp) != null;
}

/** Torpedo-alternate fits: one sub-row per embedded torpedo type, mounted
 *  and researchable alike (Shimakaze's A1/A2/A3 all see play). Skipped when
 *  the slice embeds at most one type — the baseline row already speaks for
 *  it. Labels reuse the spec panel's per-kind section keys; the "range ·
 *  speed" suffix disambiguates same-kind types. Variants mounted by the
 *  STOCK launchers classify base, everything else top. */
function torpedoVariantFits(gp: Gp): CompareShipFit[] {
  const ammo = torpedoAmmo(gp);
  const names = Object.keys(ammo);
  if (names.length <= 1) return [];
  const stockMounted = mountedTorpedoNames(gp, "stock");
  const out: CompareShipFit[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const entity = ammo[name];
    const values = torpedoFitValues(entity);
    const homing = entity.SubmarineTorpedoParams != null;
    const labelKey = homing ? "ships.spec.torpHomingSection" : "ships.spec.torpStraightSection";
    const suffix =
      values.torpRange != null && values.torpSpeed != null
        ? " · " + values.torpRange + " / " + values.torpSpeed
        : "";
    const dedupe = labelKey + suffix;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      key: "torp:" + name,
      labelKey,
      suffix,
      variant: stockMounted.has(name) ? "base" : "top",
      chip: true,
      groupKeys: ["torpedoes"],
      values,
    });
  }
  return out;
}

/** Whether the hull embarks aircraft at all (slice squadrons or the baked
 *  squadron seed) — groupApplies' extra fact for the aircraft group. */
export function hasComparePlanes(shipId: number | string, gp: Gp): boolean {
  if (buildPlaneOptionsFromSlice(gp ?? null).length > 0) return true;
  const seed = squadronSeed(shipId);
  return seed != null && Array.isArray(seed.planes) && seed.planes.length > 0;
}

/** Per-airframe fits for carriers & hybrids: one row per embarked squadron
 *  airframe, stats from the baked plane_specs table, role labels from the
 *  shared shipSquadrons pipeline (slice planes first, the seed as the
 *  offline fallback — the seed answers without any GameParams unpack, so a
 *  carrier compares its air wing even on the web build). Airframes whose
 *  specs are missing (a newer airframe the bake predates) are skipped — an
 *  all-dashes row would be noise. The picker's base/variant rank drives the
 *  row's variant; unknown ranks (event squads) read as top so the "all" and
 *  "top" filters keep them visible. */
export function aircraftFits(shipId: number | string, gp: Gp): CompareShipFit[] {
  let options: PlaneModelOption[] = buildPlaneOptionsFromSlice(gp ?? null);
  if (options.length === 0) {
    const seed = squadronSeed(shipId);
    if (seed) options = buildPlaneOptionsFromSeed(seed);
  }
  const out: CompareShipFit[] = [];
  for (const option of options) {
    const entry = planeSpecEntry(option.index);
    if (!entry) continue;
    const values: Record<string, string | null> = {
      planeHp: fmtNum(entry.hp),
      planeSquadron: fmtNum(entry.squadron),
      planeSpeed: entry.maxSpeed != null ? Math.round(entry.maxSpeed) + " kn" : null,
      planeDamage: null,
      planePen: entry.pen != null ? Math.round(entry.pen) + " mm" : null,
      planeFire: entry.fire != null ? Math.round(entry.fire) + "%" : null,
      planeFlood: entry.flood != null ? Math.round(entry.flood) + "%" : null,
      planeTorpSpeed: entry.torpSpeed != null ? Math.round(entry.torpSpeed) + " kn" : null,
      planeTorpRange: entry.torpRange != null ? entry.torpRange.toFixed(1) + " km" : null,
    };
    // HE/AP bomb and rocket damage reads with its ammo kind ("HE 3150");
    // torpedo and depth-charge rows stay plain — their role label already
    // names the weapon family.
    const dmg = fmtNum(entry.damage);
    if (dmg != null) {
      const kindPrefix =
        entry.ammo === "torpedo" || entry.ammo === "depthcharge" || !entry.ammoType
          ? ""
          : entry.ammoType + " ";
      values.planeDamage = kindPrefix + dmg;
    }
    out.push({
      key: "plane:" + option.index,
      labelKey: "ships.plane." + (option.role || "auxiliary"),
      suffix: option.label,
      variant: option.config === "base" ? "base" : "top",
      chip: true,
      kind: "aircraft",
      groupKeys: ["aircraft"],
      values,
    });
  }
  return out;
}

/**
 * Enumerate the weapon fits of one hull. Returns [] when neither the slice
 * nor the baked data answers — the table then renders the baseline row
 * alone, exactly as before. Aircraft rows survive a missing slice (the
 * squadron seed is committed data); every other fit needs the GameParams
 * slice and silently drops out while it loads.
 */
export function shipCompareFits(
  profile: CompareProfile | null | undefined,
  nation: string | undefined,
  gameparams: unknown,
  shipId: number | string,
): CompareShipFit[] {
  const gp = dict(gameparams);
  const out: CompareShipFit[] = [];
  if (gp) {
    const alt = altFireFit(profile, nation, gp);
    if (alt) out.push(alt);
    const stockArt = stockArtilleryFit(gp, nation);
    if (stockArt) out.push(stockArt);
    const stockTorp = stockTorpedoFit(gp);
    if (stockTorp) out.push(stockTorp);
    const stockHull = stockHullFit(profile, gp);
    if (stockHull) out.push(stockHull);
    const airstrike = aswAirstrikeFit(gp);
    if (airstrike) out.push(airstrike);
    out.push(...torpedoVariantFits(gp));
  }
  out.push(...aircraftFits(shipId, gp));
  return out;
}
