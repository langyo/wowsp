/**
 * Shared build-planner defaults and mountability filters.
 *
 * BuildPlanner renders the interactive editor; this module carries the two
 * pieces other surfaces need WITHOUT the component: which modernizations a
 * hull may mount (the lineup editor's hover summary counts filled slots
 * with the exact same filter the upgrades tab uses), and the "recommended
 * default" build the tactics lineup stamps on freshly added hulls —
 * every slot filled with standard (non-unique) gear, every combat signal
 * flying, the in-game recommended skill set within the 21-point budget,
 * and a STANDARD captain (no unique commander talents). Editing can then
 * only ever diverge from a sane full loadout, never from an empty one.
 *
 * Realm note: lineup defaults are deliberately REALM-AGNOSTIC and keep
 * stamping the WG dataset (SIGNALS + WG recommended skills) — the tactical
 * lineup has no realm switch of its own. The realm-aware catalogs live in
 * signalsFor(); BuildPlanner prunes a lineup build to the active realm the
 * moment it is edited there (pruneBuildForRealm).
 */
import type { ShipInfo } from "@/api";
import { gameNationOf } from "@/utils/nationCodes";
import type { TechTreeRealm } from "@/utils/techTreeData";
import modernizationsData from "../../data/modernizations.json";
import signalsData from "../../data/signals.json";
import signalsLestaData from "../../data/signals_lesta.json";
import type { PlannerBuild } from "./modifierPipeline";
import {
  classSkills,
  recommendedSkills,
  SKILL_BUDGET,
  skillClassFor,
  skillCost,
} from "./skillTree";

export interface SignalEntry {
  index: string;
  name: string;
  names: Record<string, string>;
  desc: Record<string, string>;
  sortOrder: number;
  modifiers: Record<string, unknown>;
  /** Lesta-catalog extras: the flag's family art stem, its tier within the
   *  family (1..4) and the family grouping used to stack the flag grid.
   *  WG entries (PCEF00x) carry none of these and render flat. */
  group?: string;
  tier?: number;
  family?: string;
}

export interface ModernizationEntry {
  name: string;
  names: Record<string, string>;
  desc: Record<string, string>;
  slot: number;
  shiptype: string[];
  nation: string[];
  shiplevel: number[];
  /** Optional ship-gating: full GameParams names ("PJSB018_Yamato_1944");
   *  a mod is mountable only when one name's leading token (before the
   *  first "_") matches the ship's tech-tree index. */
  ships?: string[];
  /** Optional rarity tags ("unique" = research-bureau gear). */
  tags?: string[];
}

/** The WG combat-signal catalog (PCEF00x), sortOrder-ascending. Also the
 *  lineup default's flag set — lineup builds are realm-agnostic and always
 *  stamp WG signals (see defaultBuildFor). */
export const SIGNALS: SignalEntry[] = (signalsData as SignalEntry[]).slice().sort(
  (a, b) => a.sortOrder - b.sortOrder,
);

/** The Lesta catalog (PCEF1xx, disjoint indices), 6 families × 4 tiers,
 *  sortOrder-ascending. */
const SIGNALS_LESTA: SignalEntry[] = (signalsLestaData as SignalEntry[]).slice().sort(
  (a, b) => a.sortOrder - b.sortOrder,
);

/** Combat-signal catalog of a realm. Defaults to WG — callers that are not
 *  realm-aware (the lineup editor) keep seeing the WG list. */
export function signalsFor(realm: TechTreeRealm = "wg"): SignalEntry[] {
  return realm === "lesta" ? SIGNALS_LESTA : SIGNALS;
}

/** Result of {@link pruneBuildForRealm} — the build's captain-data slices,
 *  already restricted to the active realm's catalogs. Null means the build
 *  was fully in-catalog and needs no patch. */
export interface RealmPruneResult {
  skills: Record<string, 1>;
  signals: string[];
  commander: string | null;
}

/** Pure realm-switch prune for a planner build: drop skill codes that the
 *  active realm's class tree does not know, signal indices outside the
 *  active realm's catalog, and a commander outside the active roster.
 *  Returns null when everything already belongs to the realm (no patch to
 *  emit). Hull-capability bans are NOT applied here — callers layer their
 *  own ban pass on top. */
export function pruneBuildForRealm(
  build: Pick<PlannerBuild, "skills" | "signals" | "commander">,
  treeCodes: ReadonlySet<string>,
  signalIndices: ReadonlySet<string>,
  commanderNames: ReadonlySet<string>,
): RealmPruneResult | null {
  const skills = { ...build.skills };
  let changed = false;
  for (const code of Object.keys(skills)) {
    if (!treeCodes.has(code)) {
      delete skills[code];
      changed = true;
    }
  }
  const signals = build.signals.filter((s) => signalIndices.has(s));
  if (signals.length !== build.signals.length) changed = true;
  const commander =
    build.commander != null && commanderNames.has(build.commander) ? build.commander : null;
  if (commander !== build.commander) changed = true;
  return changed ? { skills, signals, commander } : null;
}

export const MODERNIZATIONS: ModernizationEntry[] =
  modernizationsData as ModernizationEntry[];

/** Mod families whose GameParams ships-list is a WHITELIST despite carrying
 *  a type restriction like exclusion-listing regulars (mirrors
 *  BuildPlanner's constant — one source, two consumers). */
const SHIPS_WHITELIST_FAMILIES = /_SkipBomber_Mod_/;

/** Slot indexes unlocked by the ship's tier (WoWS wiki "Ship:Upgrades":
 *  slot 1 @ T1, 2 @ T3, 3 @ T5, 4 @ T6, 5 @ T8, 6 @ T9 — 0-based here). */
export function shipUpgradeSlots(tier: number): number[] {
  const count =
    1 +
    (tier >= 3 ? 1 : 0) +
    (tier >= 5 ? 1 : 0) +
    (tier >= 6 ? 1 : 0) +
    (tier >= 8 ? 1 : 0) +
    (tier >= 9 ? 1 : 0);
  return [0, 1, 2, 3, 4, 5].slice(0, count);
}

/** Ship-gating by the GameParams `ships` list: research-bureau uniques and
 *  untyped entries WHITELIST their ships; broadly-typed regular mods carry
 *  EXCLUSION lists (the skip-bomber hybrid mods being the typed whitelist
 *  exception). */
export function shipMatchesShips(
  m: ModernizationEntry,
  treeIndex: string | null,
): boolean {
  if (!m.ships?.length) return true;
  const hit = treeIndex != null && m.ships.some((s) => s.split("_")[0] === treeIndex);
  const whitelist =
    m.tags?.includes("unique") ||
    m.shiptype.length === 0 ||
    SHIPS_WHITELIST_FAMILIES.test(m.name);
  return whitelist ? hit : !hit;
}

/** Full mountability filter for one modernization on one hull — the exact
 *  predicate BuildPlanner's upgrades tab applies, shared so off-component
 *  consumers (the lineup's default builder and slot counts) never drift
 *  from the editor. */
export function upgradeMountable(
  m: ModernizationEntry,
  ship: Pick<ShipInfo, "type" | "nation" | "tier">,
  treeIndex: string | null,
): boolean {
  // Dead catalog: no type restriction AND no ship binding — legacy gear the
  // current game sells nowhere (the unnamed PCM001 family, PCM040, PCM091).
  if (m.shiptype.length === 0 && !m.ships?.length) return false;
  return (
    (m.shiptype.length === 0 || m.shiptype.includes(ship.type)) &&
    (m.nation.length === 0 || m.nation.includes(gameNationOf(ship.nation))) &&
    (m.shiplevel.length === 0 || m.shiplevel.includes(ship.tier)) &&
    shipMatchesShips(m, treeIndex)
  );
}

/** The recommended skill set, clamped to the 21-point budget in the class
 *  tree's tier-ascending order (a preset that would overspend keeps its
 *  cheapest tiers, not its data order). */
export function budgetedRecommendedSkills(
  treeIndex: string | null,
  shipType: string,
): Record<string, 1> {
  const recommended = recommendedSkills(treeIndex, shipType);
  const order = classSkills(skillClassFor(shipType));
  let budget = SKILL_BUDGET;
  const skills: Record<string, 1> = {};
  for (const skill of order) {
    if (!recommended.has(skill.code)) continue;
    const cost = skillCost(skill.tier);
    if (cost > budget) continue;
    budget -= cost;
    skills[skill.code] = 1;
  }
  return skills;
}

/**
 * The default loadout a freshly added lineup hull carries: everything a
 * "maxed but standard" player would mount — all combat signals, one
 * regular (non-unique) modernization per unlocked slot, the recommended
 * skill set within budget, and a standard captain (commander null —
 * display-only in the pipeline anyway).
 */
export function defaultBuildFor(
  ship: Pick<ShipInfo, "shipId" | "type" | "nation" | "tier">,
  treeIndex: string | null,
): PlannerBuild {
  const upgrades: Record<number, string> = {};
  for (const slot of shipUpgradeSlots(ship.tier)) {
    const pick = MODERNIZATIONS.find(
      (m) => m.slot === slot && !m.tags?.includes("unique") && upgradeMountable(m, ship, treeIndex),
    );
    if (pick) upgrades[slot] = pick.name;
  }
  return {
    skills: budgetedRecommendedSkills(treeIndex, ship.type),
    signals: SIGNALS.map((s) => s.index),
    upgrades,
    commander: null,
    healthPct: 1,
  };
}
