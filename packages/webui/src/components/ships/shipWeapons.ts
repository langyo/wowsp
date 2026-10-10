/**
 * Weapon grouping over resolved ship parts (shipParts.ts).
 *
 * Pure data — no Vue, no i18n: WeaponBar maps each group onto its card
 * (icon/label/focus zone), the Python fleet audit (scripts/check_weapons.py)
 * mirrors the same rules, and the unit tests pin them with synthetic
 * GameParams fixtures.
 *
 * Grouping rules (carried over from the original WeaponBar logic, now fed
 * by role-resolved blocks instead of canonical component names):
 *  - Main battery: artillery HP_* mounts, grouped by barrels×caliber. A
 *    ship without artillery mounts falls back to its ATBA mounts, of which
 *    only the LARGEST caliber group is promoted to "main" (the small-caliber
 *    rest stays secondary — DD-style pure-ATBA fits).
 *  - Dual-purpose mounts appear in BOTH the ATBA and the AA block (same
 *    gun id); they render once with the combined DP label.
 *  - Torpedoes: ONLY the torpedo role blocks. AirArmament is aircraft
 *    catapults — never torpedoes (the X Worcester "2×1 torpedo" bug).
 */

import { resolveShipParts, roleHpSlots, type ShipParts } from "./shipParts";

export type WeaponKind =
  | "mainGun"
  | "secondary"
  | "dp"
  | "torpedo"
  | "aa"
  | "asw"
  | "aircraft";

export interface WeaponGroup {
  kind: WeaponKind;
  /** Mounts contributing to the group (card count / focus multiplier). */
  count: number;
  /** Barrels per mount (torpedo tubes per launcher). */
  barrels: number;
  /** Gun caliber in mm (0 for non-gun groups). */
  cal: number;
  /** AA band for kind==="aa" groups. */
  band?: "long" | "mid" | "short";
}

type Gp = Record<string, any> | null | undefined;

function gunIds(blocks: Gp[]): Set<string> {
  const ids = new Set<string>();
  for (const [, m] of roleHpSlots(blocks)) {
    const n = m.name ?? m.id ?? "";
    if (n) ids.add(String(n));
  }
  return ids;
}

function groupMounts(
  slots: [string, Record<string, any>][],
  skip?: Set<string>,
): { barrels: number; cal: number; count: number; slots: string[] }[] {
  const groups = new Map<string, { barrels: number; cal: number; count: number; slots: string[] }>();
  for (const [k, m] of slots) {
    if (skip?.has(k)) continue;
    const barrels = Number(m.numBarrels ?? 0) || 1;
    const cal = Math.round(Number(m.barrelDiameter ?? 0) * 1000);
    const key = `${barrels}_${cal}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.slots.push(k);
    } else {
      groups.set(key, { barrels, cal, count: 1, slots: [k] });
    }
  }
  // Largest caliber first — the ATBA promotion takes the head of this list.
  return [...groups.values()].sort((a, b) => b.cal - a.cal);
}

/**
 * Summarize every weapon group of a ship. `gp` is the raw GameParams entry;
 * parts may be passed pre-resolved (the audit reuses one resolution across
 * checks). AA mount bucketing consumes `bandOf` — a slot → band map built
 * from the aura `guns` lists (antiAir.auraBandMap); unmapped slots default
 * to the near band.
 */
export function summarizeWeapons(
  gp: Gp,
  opts: {
    parts?: ShipParts;
    bandOf?: Map<string, "near" | "medium" | "far">;
  } = {},
): WeaponGroup[] {
  const parts = opts.parts ?? resolveShipParts(gp, "top");
  const out: WeaponGroup[] = [];

  const atbaSlots = roleHpSlots(parts.atba);
  const aaSlots = roleHpSlots(parts.airDefense);

  // ── Main battery ── artillery mounts, ATBA fallback for gunless hulls.
  const promotedAtba = new Set<string>();
  const artSlots = roleHpSlots(parts.artillery);
  const mainFromAtba = artSlots.length === 0;
  const mainGroups = mainFromAtba
    ? groupMounts(atbaSlots)
    : groupMounts(artSlots);
  for (const [i, g] of mainGroups.entries()) {
    if (mainFromAtba && i > 0) break; // ATBA promotion: largest caliber only
    if (mainFromAtba) for (const s of g.slots) promotedAtba.add(s);
    out.push({ kind: "mainGun", count: g.count, barrels: g.barrels, cal: g.cal });
  }

  // ── Dual-purpose mounts: same gun id in ATBA and AA blocks.
  const atbaIds = gunIds(parts.atba);
  const aaIds = gunIds(parts.airDefense);
  const dpSlots = new Set<string>();
  for (const [k, m] of atbaSlots) {
    const id = String(m.name ?? m.id ?? "");
    if (id && aaIds.has(id)) dpSlots.add(k);
  }
  for (const [k, m] of aaSlots) {
    const id = String(m.name ?? m.id ?? "");
    if (id && atbaIds.has(id)) dpSlots.add(k);
  }

  // ── Secondary battery (excluding DP + promoted slots).
  const secGroups = new Map<string, WeaponGroup>();
  for (const [k, m] of atbaSlots) {
    if (dpSlots.has(k) || promotedAtba.has(k)) continue;
    const barrels = Number(m.numBarrels ?? 0) || 1;
    const cal = Math.round(Number(m.barrelDiameter ?? 0) * 1000);
    const key = `${barrels}_${cal}`;
    const g = secGroups.get(key);
    if (g) g.count++;
    else secGroups.set(key, { kind: "secondary", count: 1, barrels, cal });
  }
  out.push(...secGroups.values());

  // ── Dual-purpose groups (mount counted once across ATBA + AA slots).
  const dpGroups = new Map<string, WeaponGroup>();
  for (const [k, m] of [...atbaSlots, ...aaSlots]) {
    if (!dpSlots.has(k)) continue;
    const barrels = Number(m.numBarrels ?? 0) || 1;
    const cal = Math.round(Number(m.barrelDiameter ?? 0) * 1000);
    const key = `${barrels}_${cal}`;
    const g = dpGroups.get(key);
    if (g) g.count++;
    else dpGroups.set(key, { kind: "dp", count: 1, barrels, cal });
  }
  out.push(...dpGroups.values());

  // ── Torpedoes — torpedo role blocks ONLY (see module docstring).
  const torpGroups = new Map<number, number>();
  for (const [, t] of roleHpSlots(parts.torpedoes)) {
    const n = Number(t.numBarrels ?? t.count ?? 1) || 1;
    torpGroups.set(n, (torpGroups.get(n) ?? 0) + 1);
  }
  for (const [tubes, count] of torpGroups) {
    out.push({ kind: "torpedo", count, barrels: tubes, cal: 0 });
  }

  // ── AA (non-DP mounts) — bucket by aura band.
  if (aaSlots.length > 0) {
    const tiers: Record<string, number> = { long: 0, mid: 0, short: 0 };
    for (const [k] of aaSlots) {
      if (dpSlots.has(k)) continue;
      const band = opts.bandOf?.get(k) ?? "near";
      if (band === "far") tiers.long++;
      else if (band === "medium") tiers.mid++;
      else tiers.short++;
    }
    if (tiers.long > 0) out.push({ kind: "aa", count: tiers.long, barrels: 0, cal: 0, band: "long" });
    if (tiers.mid > 0) out.push({ kind: "aa", count: tiers.mid, barrels: 0, cal: 0, band: "mid" });
    if (tiers.short > 0) out.push({ kind: "aa", count: tiers.short, barrels: 0, cal: 0, band: "short" });
  }

  // ── ASW — hull depth-charge racks / Hedgehog guns, else the ASW
  // airstrike (A_AirSupport: chargesNum charges out to maxDist — the only
  // ASW Yamato/Des Moines-class hulls carry). Both legs feed the spec
  // panel's ASW row (live stats), so the badge mirrors them.
  const dcCount = roleHpSlots(parts.depthCharges).length;
  const strike = parts.airSupport[0];
  const strikeCharges = Number(strike?.chargesNum ?? 0) || 0;
  const strikeDist = Number(strike?.maxDist ?? 0) || 0;
  if (dcCount > 0) {
    out.push({ kind: "asw", count: dcCount, barrels: 0, cal: 0 });
  } else if (strikeCharges > 0 && strikeDist > 0) {
    out.push({ kind: "asw", count: strikeCharges, barrels: 0, cal: 0 });
  }

  // ── Aircraft — catapult slots (AirArmament). Never torpedoes, never CV
  // squadrons (carriers carry no catapult mounts).
  const acCount = roleHpSlots(parts.airArmament).length;
  if (acCount > 0) out.push({ kind: "aircraft", count: acCount, barrels: 0, cal: 0 });

  return out;
}
