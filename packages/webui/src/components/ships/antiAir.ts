/**
 * Anti-air extraction from an unpacked GameParams subtree.
 *
 * WG's `/encyclopedia/ships/` `default_profile` only carries the opaque
 * `anti_aircraft.defense` rating — its per-slot DPS/range fields are always
 * null/-1, so no per-aura numbers can be sourced from the API. The real AA
 * data lives in the raw GameParams entry the modal already unpacks via
 * `api.getShipGameparams`: aura dicts inside the `A_AirDefense`, `A_ATBA`
 * and `A_Artillery` blocks. The A_* blocks are the STOCK hull configuration,
 * which is exactly what WG's default_profile describes (verified: Seattle's
 * WG hull HP equals GameParams A_Hull), so B_/AB_/C_/Default blocks are
 * deliberately NOT read. Dual-purpose main-battery ships (PASC209 Seattle)
 * keep their far aura in `A_Artillery.Far_1/Far_1_Bubbles`, not in
 * A_AirDefense — hence the three-block scan.
 *
 * An aura dict is recognized structurally: `type` ∈ near/medium/far plus an
 * `areaDamage` or `bubbleDamage` key. That skips the AimedFire /
 * priority-sector settings and the mount HP_* entries without hardcoding the
 * varying aura key names (AuraNear1 / Medium_1 / Far_1 / AuraFar_Bubbles...).
 * Several near auras can share the SAME range (Yamato AuraNear1 109 +
 * AuraNear2 2, both 2500 m); no ship carries two different maxDistance
 * values within one band, so DPS summing per band is safe.
 *
 * Field names are PascalCase and values may be missing/null — every read is
 * defensive (same discipline as ballistics.ts). Value formatting happens
 * here so the spec component stays declarative (same philosophy as
 * shipSpecs.ts).
 */
import type { SpecRow } from "./shipSpecs";

type Gp = Record<string, any> | null | undefined;

/** Aura band in GameParams terms; maps to short/mid/long in player terms. */
export type AaBandKey = "near" | "medium" | "far";

export interface AaBand {
  key: AaBandKey;
  /** Continuous DPS: Σ areaDamage over the band's auras. */
  dps: number;
  /** Outer range in meters (max maxDistance of the band). */
  rangeM: number;
  /** Hit chance 0..1 (max across auras), null when no aura carries it. */
  hitChance: number | null;
  /** Flak (black cloud) damage per cloud, null when the band has none. */
  flakDamage: number | null;
  /** Flak clouds per volley, summed across the band's flak sources, null
   *  when the band has none. */
  flakCount: number | null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function bandKeyOf(v: unknown): AaBandKey | null {
  return v === "near" || v === "medium" || v === "far" ? v : null;
}

/** A dict value that looks like an aura: typed near/medium/far AND carrying
 *  damage numbers (skips settings dicts and HP_* mount entries). */
function isAura(v: unknown): v is Record<string, any> {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return bandKeyOf(o.type) != null && ("areaDamage" in o || "bubbleDamage" in o);
}

/** All aura dicts across the three stock-hull blocks. */
function aurasOf(gp: Gp): Array<{ band: AaBandKey; aura: Record<string, any> }> {
  const out: Array<{ band: AaBandKey; aura: Record<string, any> }> = [];
  if (!gp || typeof gp !== "object") return out;
  for (const blockKey of ["A_AirDefense", "A_ATBA", "A_Artillery"] as const) {
    const block = gp[blockKey];
    if (!block || typeof block !== "object") continue;
    for (const v of Object.values(block)) {
      if (isAura(v)) out.push({ band: bandKeyOf(v.type)!, aura: v });
    }
  }
  return out;
}

/**
 * Aggregate the stock-hull AA auras into per-band stats, ordered near →
 * medium → far. Bands with no DPS and no flak (submarines, ~98 ships have no
 * auras at all) yield an empty list.
 */
export function collectAaBands(gp: unknown): AaBand[] {
  const acc = new Map<AaBandKey, AaBand>();
  for (const { band, aura } of aurasOf(gp as Gp)) {
    let b = acc.get(band);
    if (!b) {
      b = { key: band, dps: 0, rangeM: 0, hitChance: null, flakDamage: null, flakCount: null };
      acc.set(band, b);
    }
    b.dps += num(aura.areaDamage) ?? 0;
    const range = num(aura.maxDistance);
    if (range != null && range > b.rangeM) b.rangeM = range;
    const hit = num(aura.hitChance);
    if (hit != null && (b.hitChance == null || hit > b.hitChance)) b.hitChance = hit;
    // Bubble (flak) auras: fold damage/count into the band. Some ships
    // carry several bubble auras within one far band (PBSB609 Scarlet
    // Thunder: AuraFar1_Bubbles 3+1 and AuraFar_Bubbles 2+1); the bubble
    // damage is identical within the band and the clouds from each source
    // ADD in-game, so counts are summed while damage keeps the max
    // (uniform in the data, max is a safe pick).
    if ((num(aura.bubbleDamage) ?? 0) > 0) {
      const dmg = num(aura.bubbleDamage)!;
      if (b.flakDamage == null || dmg > b.flakDamage) b.flakDamage = dmg;
      const inner = num(aura.innerBubbleCount) ?? 0;
      const outer = num(aura.outerBubbleCount) ?? 0;
      b.flakCount = (b.flakCount ?? 0) + Math.round(inner + outer);
    }
  }
  const order: AaBandKey[] = ["near", "medium", "far"];
  return order
    .map((k) => acc.get(k))
    .filter((b): b is AaBand => b != null)
    .filter((b) => b.dps > 0 || b.flakDamage != null || (b.flakCount ?? 0) > 0);
}

/**
 * Map every AA mount slot key ("HP_JGA_1") to the aura band its aura lists
 * it under — the reliable way to bucket mounts by range (mount dicts carry
 * only antiAirAuraDistance in a non-meter scale). A slot listed in several
 * bands resolves to the outermost one (far > medium > near).
 */
export function gunBandMap(gp: unknown): Map<string, AaBandKey> {
  const priority: Record<AaBandKey, number> = { near: 0, medium: 1, far: 2 };
  const out = new Map<string, AaBandKey>();
  for (const { band, aura } of aurasOf(gp as Gp)) {
    const guns = aura.guns;
    if (!Array.isArray(guns)) continue;
    for (const g of guns) {
      if (typeof g !== "string") continue;
      const prev = out.get(g);
      if (prev == null || priority[band] > priority[prev]) out.set(g, band);
    }
  }
  return out;
}

function fmtNum(v: number, digits = 0): string {
  return v.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * Spec rows for the AA group: per band (short/mid/long) the range, continuous
 * DPS and hit chance, plus flak damage/count on the long band when present.
 * Rows whose data is missing are skipped, and a band with no rows at all is
 * skipped entirely.
 */
export function buildAntiAirRows(gp: unknown): SpecRow[] {
  const bands = collectAaBands(gp);
  const rows: SpecRow[] = [];
  for (const band of bands) {
    const rowsForBand: SpecRow[] = [];
    const prefix = band.key === "near" ? "aaShort" : band.key === "medium" ? "aaMid" : "aaLong";
    const rangeKm = band.rangeM > 0 ? (band.rangeM / 1000).toFixed(1) : null;
    if (rangeKm != null) rowsForBand.push({ key: `${prefix}Range`, value: `${rangeKm} km` });
    if (band.dps > 0) rowsForBand.push({ key: `${prefix}Dps`, value: fmtNum(band.dps) });
    if (band.hitChance != null)
      rowsForBand.push({ key: `${prefix}HitChance`, value: `${Math.round(band.hitChance * 100)}%` });
    // Flak only rides the far band in the data (verified across the full
    // dump: 669 ships carry bubble auras, all of them far); emitting the
    // unprefixed flak rows only there also keeps every row key unique.
    if (band.key === "far") {
      if (band.flakDamage != null)
        rowsForBand.push({ key: "aaFlakDamage", value: fmtNum(band.flakDamage) });
      if (band.flakCount != null && band.flakCount > 0)
        rowsForBand.push({ key: "aaFlakCount", value: String(band.flakCount) });
    }
    rows.push(...rowsForBand);
  }
  return rows;
}
