/**
 * Damage composition (伤害组成) for the personal battle report (我的战绩):
 * what the recorder's damage was made OF, at two granularities that share
 * one vocabulary.
 *
 *  - Global strip: the server's own running totals (receiveDamageStat)
 *    folded into weapon families — authoritative per-weapon damage, enemy
 *    category only. The same stream the 伤害 / 飞机伤害 tiles fold, so the
 *    chips always agree with them.
 *  - Per-row ledger: the hit-level attribution sees no weapon ids, so each
 *    attributed impact is classified by joining its (ownerId, shotId)
 *    against the launch streams — gun shells vs torpedoes vs everything the
 *    launches never carried (aircraft weapons, depth charges, DoT splashes
 *    at death). Estimate-grade by construction; the panel's estimate
 *    footnote covers it.
 *
 * Family id sets follow the vendored game constants table (wows-core
 * `DamageStatWeapon`, mc15a2792.pyc enum_weapon, game_constants.rs).
 */
import type { DamageStatSample, ShellLaunchEvent, TorpedoLaunch } from "@/api";
import { isPlaneWeapon } from "@/api";

/** The weapon families the composition surfaces show. */
export type WeaponFamily =
  | "main"
  | "atba"
  | "torpedo"
  | "air"
  | "burn"
  | "flood"
  | "depth"
  | "ram"
  | "other";

/** DamageStatWeapon ids per family — everything unlisted falls to "other"
 *  (AA, spotting, pings, mines, event weapons …). Main battery includes the
 *  AI-gun ids (bots' returns in the recorder's stream) and ATBA the
 *  secondary-battery variants; ship-launched depth charges (27) split from
 *  the aircraft ones (those ride the air family). The air family itself is
 *  not listed here — `isPlaneWeapon` owns it, so the 航空 chip always sums
 *  to the 飞机伤害 tile. */
const FAMILY_IDS: Readonly<Record<Exclude<WeaponFamily, "air" | "other">, readonly number[]>> = {
  main: [1, 2, 5, 6, 15, 32],
  atba: [3, 4, 33],
  torpedo: [7, 35, 36, 40, 59, 60, 82],
  burn: [17],
  flood: [20],
  depth: [27],
  ram: [18],
};

export function weaponFamilyOf(weapon: number): WeaponFamily {
  // Aircraft weapons resolve through the shared predicate so the 航空 chip
  // always sums to the 飞机伤害 tile (same id set, Asup/Alter/Tc variants
  // included).
  if (isPlaneWeapon(weapon)) return "air";
  for (const [family, ids] of Object.entries(FAMILY_IDS)) {
    if ((ids as readonly number[]).includes(weapon)) return family as WeaponFamily;
  }
  return "other";
}

export interface FamilyDamage {
  family: WeaponFamily;
  /** Enemy-category damage total, rounded (the shared fold's convention). */
  total: number;
  /** Enemy-category hit count. */
  count: number;
}

/** Fold cumulative damage-stat samples into per-family totals (enemy
 *  category only — 1=ally / 2=spot / 3=agro stay out). Samples are running
 *  totals: keep the latest per (weapon, category) pair, never sum across
 *  ticks. Descending by total; on exact ties the specific families read
 *  before "other" (a dominant "other" still sorts first — the chips show
 *  real proportions). Zero families dropped. */
export function foldDamageComp(
  samples: DamageStatSample[] | null | undefined,
): FamilyDamage[] {
  const latest = new Map<string, DamageStatSample>();
  for (const s of samples ?? []) {
    if (s.category !== 0) continue;
    latest.set(`${s.weapon}_${s.category}`, s);
  }
  const byFamily = new Map<WeaponFamily, FamilyDamage>();
  for (const s of latest.values()) {
    const family = weaponFamilyOf(s.weapon);
    const cur = byFamily.get(family) ?? { family, total: 0, count: 0 };
    cur.total += s.total;
    cur.count += s.count;
    byFamily.set(family, cur);
  }
  return [...byFamily.values()]
    .map((f) => ({ ...f, total: Math.round(f.total) }))
    .filter((f) => f.total > 0 || f.count > 0)
    .sort(
      (a, b) =>
        b.total - a.total ||
        (a.family === "other" ? 1 : 0) - (b.family === "other" ? 1 : 0),
    );
}

/** The coarse per-target buckets the launch join can actually tell apart. */
export type RowCompKey = "shell" | "torpedo" | "other";

/** One ledger row's attributed damage by bucket — the same estimate-grade
 *  figures as `damage` itself, just split. */
export type RowComp = Partial<Record<RowCompKey, number>>;

/** Classifies a hit event's weapon by joining (ownerId, shotId) against the
 *  battle's launch streams. Shot ids RECYCLE per salvo (the minimap's
 *  shellWarfare join learned this the hard way — "shot ids recycle across
 *  salvos, so the window must be tight"), so a battle-wide id set would
 *  chip gun hits as torpedo whenever a recycled gun id collides with an
 *  old fish id. The classifier instead takes the NEAREST launch at or
 *  before the hit, per family, and lets the closer one own the hit.
 *  Returns null when neither stream carried the id at all (aircraft
 *  weapons, depth charges, DoT splashes) — the row's "other" bucket. */
export function shotWeaponJoiner(
  shellLaunches: ShellLaunchEvent[] | null | undefined,
  torpedoes: TorpedoLaunch[] | null | undefined,
): (ownerId: number, shotId: number, time: number) => RowCompKey | null {
  const shells = new Map<string, number[]>();
  const torps = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, ownerId: number, shotId: number, time: number) => {
    const key = `${ownerId}:${shotId}`;
    const list = m.get(key);
    if (list) list.push(time);
    else m.set(key, [time]);
  };
  for (const s of shellLaunches ?? []) push(shells, s.ownerId, s.shotId, s.time);
  for (const s of torpedoes ?? []) push(torps, s.ownerId, s.shotId, s.time);
  for (const list of shells.values()) list.sort((a, b) => a - b);
  for (const list of torps.values()) list.sort((a, b) => a - b);
  if (shells.size === 0 && torps.size === 0) return () => null;
  /** Latest launch at or before `time` (NaN when that family never fired
   *  this id before the hit). */
  const latestBefore = (times: number[], time: number): number => {
    let lo = 0;
    let hi = times.length - 1;
    let best = NaN;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= time) {
        best = times[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  };
  return (ownerId, shotId, time) => {
    const key = `${ownerId}:${shotId}`;
    const sh = shells.get(key);
    const tp = torps.get(key);
    const ds = sh ? latestBefore(sh, time) : NaN;
    const dt = tp ? latestBefore(tp, time) : NaN;
    if (Number.isNaN(ds) && Number.isNaN(dt)) return null;
    if (Number.isNaN(ds)) return "torpedo";
    if (Number.isNaN(dt)) return "shell";
    // Both families fired this recycled id — the nearest preceding launch
    // owns the hit.
    return dt >= ds ? "torpedo" : "shell";
  };
}

const ROW_COMP_ORDER: readonly RowCompKey[] = ["shell", "torpedo", "other"];

/** Non-zero buckets of one row's composition, descending — the chips the
 *  ledger rows render. Empty when nothing was classified. */
export function rowCompEntries(
  comp: RowComp | undefined,
): { key: RowCompKey; total: number }[] {
  if (!comp) return [];
  return ROW_COMP_ORDER.filter((k) => (comp[k] ?? 0) > 0).map((k) => ({
    key: k,
    total: comp[k]!,
  }));
}
