/**
 * Per-ship weapon-fit enumeration for the batch compare table.
 *
 * A hull's WG `default_profile` (the compare table's baseline row) always
 * describes the FULLY-upgraded ship with its standard ammo — but several
 * hulls carry more than one way to fight, and the report is incomplete
 * without them:
 *
 *   - the alternate firing mode (替代射击): Vyazma / Laffei / Hawaii style
 *     switchable main batteries, where range, reload, dispersion, shells,
 *     fire chance and both DPMs follow the SwitchableModeArtilleryModule;
 *   - the STOCK hull's artillery and torpedo fits (白板配置): the upgrade
 *     chain's head modules, which frequently carry smaller guns or fewer
 *     tubes than the researched end state;
 *   - the researchable torpedo alternates the slice embeds alongside the
 *     mounted type (Shimakaze A1/A2/A3 — every one of them sees play, the
 *     stock option included).
 *
 * Every fit renders as an INDENTED sub-row under its ship (the identity
 * cell steps right, marking it as one of that hull's options); rows only
 * appear for the stat groups the fit actually re-specs.
 *
 * Values come from the per-ship GameParams slice (shape v3): role blocks
 * via `resolveShipParts`, shell/torpedo entities via the `__shellAmmo` /
 * `__torpedoAmmo` embeddings. Formatting mirrors `shipCompare.ts`' getters
 * so a fit row lines up with the baseline columns.
 *
 * No i18n here: label KEYS only (the component resolves them), same
 * discipline as shipCompare.ts.
 */
import { resolveShipParts } from "@/components/ships/shipParts";
import { buildShipSpecs, switchableMainBattery } from "@/components/ships/shipSpecs";
import type { CompareProfile } from "@/utils/shipCompare";

/** One weapon fit of one hull: a sub-row for the compare table. */
export interface CompareShipFit {
  /** Stable key for the table row (unique per ship). */
  key: string;
  /** FULL i18n key path — the component renders t(labelKey). */
  labelKey: string;
  /** Extra disambiguation rendered beside the label (" · 20 km / 67 kn"). */
  suffix?: string;
  /** Stat groups this fit re-specs; the sub-row appears under these.
   *  (Currently only the artillery / torpedoes groups grow fit rows —
   *  hull, mobility and concealment stats do not change per fit.) */
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

/** Structural equality of two role-block sets (ammo sets + key numbers): a
 *  stock configuration resolving to the same modules as the top one must
 *  not emit a duplicate row. */
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
        shotDelay: mountsOf(d).map((m) => m.shotDelay ?? null),
      };
    });
  return JSON.stringify(sig(a)) !== JSON.stringify(sig(b));
}

/** Alternate-firing fit from buildShipSpecs' alt-mode output: the artillery
 *  rows and the HE/AP shell sections already carry the mode's values (and
 *  the burst cycle's DPM). */
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
  return { key: "altFire", labelKey: "ships.spec.altFire", groupKeys: ["artillery"], values };
}

/** Stock-hull fit from the upgrade chain's head modules. Emitted only when
 *  the stock artillery or torpedo modules actually differ from the top
 *  configuration (a single-hull premium resolves to the same blocks and
 *  would duplicate the baseline row). */
function stockFit(profile: CompareProfile | null | undefined, nation: string | undefined, gp: Gp): CompareShipFit | null {
  if (!gp) return null;
  const stock = resolveShipParts(gp, "stock");
  const top = resolveShipParts(gp, "top");
  const artDiffers = blocksDiffer(stock.artillery, top.artillery);
  const torpDiffers = blocksDiffer(stock.torpedoes, top.torpedoes);
  if (!artDiffers && !torpDiffers) return null;
  const ammo = shellAmmo(gp);
  const values: Record<string, string | null> = {};
  if (artDiffers) {
    for (const block of stock.artillery) Object.assign(values, artilleryFitValues(block, ammo, nation));
  } else {
    // Torpedoes-only difference: the artillery columns read as not carried
    // by this row, keeping the baseline row the artillery reference.
    for (const column of [
      "mainGunRange", "mainGunReload", "mainGunBarrels", "mainGunCaliber",
      "turretTraverse", "maxDispersion", "heShell", "fireChance",
      "hePenetration", "shellSpeed", "heDpm", "apShell", "apDpm",
    ]) {
      values[column] = null;
    }
  }
  if (torpDiffers) {
    for (const block of stock.torpedoes) {
      for (const mount of mountsOf(block)) {
        for (const name of Array.isArray(mount.ammoList) ? mount.ammoList : []) {
          if (typeof name !== "string") continue;
          const entity = torpedoAmmo(gp)[name];
          if (entity) Object.assign(values, torpedoFitValues(entity));
        }
      }
    }
  } else if (!artDiffers) {
    return null;
  }
  const groupKeys: ("artillery" | "torpedoes")[] = [];
  if (artDiffers) groupKeys.push("artillery");
  if (torpDiffers) groupKeys.push("torpedoes");
  return { key: "stock", labelKey: "ships.compare.fit.stock", groupKeys, values };
}

/** Torpedo-alternate fits: one sub-row per embedded torpedo type, mounted
 *  and researchable alike (Shimakaze's A1/A2/A3 all see play). Skipped when
 *  the slice embeds at most one type — the baseline row already speaks for
 *  it. Labels reuse the spec panel's per-kind section keys; the "range ·
 *  speed" suffix disambiguates same-kind types. */
function torpedoVariantFits(gp: Gp): CompareShipFit[] {
  const ammo = torpedoAmmo(gp);
  const names = Object.keys(ammo);
  if (names.length <= 1) return [];
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
    out.push({ key: "torp:" + name, labelKey, suffix, groupKeys: ["torpedoes"], values });
  }
  return out;
}

/**
 * Enumerate the weapon fits of one hull. Returns [] when the slice is
 * absent (gameparams still loading / unavailable) — the table then renders
 * the baseline row alone, exactly as before.
 */
export function shipCompareFits(
  profile: CompareProfile | null | undefined,
  nation: string | undefined,
  gameparams: unknown,
): CompareShipFit[] {
  const gp = dict(gameparams);
  if (!gp) return [];
  const out: CompareShipFit[] = [];
  const alt = altFireFit(profile, nation, gp);
  if (alt) out.push(alt);
  const stock = stockFit(profile, nation, gp);
  if (stock) out.push(stock);
  out.push(...torpedoVariantFits(gp));
  return out;
}
