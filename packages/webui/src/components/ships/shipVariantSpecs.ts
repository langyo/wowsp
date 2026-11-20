/**
 * Per-subsystem module-variant enumeration over a raw GameParams ship slice.
 *
 * The ship detail modal's 规格参数 groups render the top-configuration
 * numbers. This module enumerates EVERY module variant of each ShipUpgradeInfo
 * ucType chain (stock → top via `prev`, e.g. hull A/B/C) so each spec group
 * can offer a small dropdown and re-derive its rows from the chosen variant's
 * component — the recompute itself lives in shipSpecs.buildShipSpecs'
 * `options.variants`; this module only answers WHAT the variants are.
 *
 * Subsystem → ucType chain:
 *   survivability / concealment → "_Hull"
 *   artillery                   → "_Artillery"
 *   torpedoes                   → "_Torpedoes"
 *   anti-air                    → "_AirDefense" when the slice carries one,
 *                                 falling back to "_Hull" (AA components ride
 *                                 the hull entries: a hull upgrade swaps the
 *                                 AirDefense block — verified Hiryu A/B hulls)
 *   mobility                    → "_Engine"
 *
 * Ships without a parsable ShipUpgradeInfo (loose unpacker dumps) yield no
 * options at all — the caller renders no dropdown and the group keeps the
 * WG-profile rendering (the pre-variant behavior). Single-entry chains are
 * returned as-is; the caller gates the dropdown at two or more options.
 *
 * Everything is Vue-free, i18n-free and defensive (PascalCase / missing /
 * null fields are the norm, same discipline as shipParts.ts): the caller
 * composes display labels from the ships.parts.role.* catalog and the variant
 * letters. The letter convention mirrors upgradeChainRows.variantLetter
 * (A, B, … Z, AA — keyed by ORDERED POSITION so parallel same-depth variants
 * still get distinct labels in a flat dropdown list); the unit tests pin the
 * agreement. ShipUpgradeInfo tables mix ship-level economy scalars (costXP,
 * costCR, lockedConfig, …) in with the module entries — non-dict entries and
 * entries without a usable ucType are skipped.
 */

/** Spec groups that can carry a module-variant dropdown (consumables and the
 *  submarine sonar/battery groups deliberately have none). */
export type VariantGroup =
  | "survivability"
  | "artillery"
  | "torpedoes"
  | "antiAir"
  | "mobility"
  | "concealment";

/** One module step of a subsystem's stock → top chain. */
export interface ShipVariantOption {
  /** ShipUpgradeInfo module entry name ("PJUT905_D10_TORP_TOP"). */
  name: string;
  /** Upgrade level inside the slot: stock = 0, +1 per same-slot `prev` step;
   *  parallel variants of one level share the depth (a prev pointing into
   *  another slot — a hull-locked gun/torpedo top — sits one level above the
   *  slot's stock, the same rule as the equipment-chain extractor). */
  depth: number;
  /** Raw `prev` entry key; null when the entry roots its chain. */
  prev: string | null;
  /** Component NAMES per role, verbatim from the entry's `components`. */
  components: Record<string, string[]>;
  /** Subsystem role key — the ships.parts.role.* suffix ("hull",
   *  "artillery", "torpedoes", "airdefense", "engine"). */
  role: string;
  /** Ordered-position variant letter (A/B/C — upgradeChainRows convention). */
  variant: string;
}

/** Variant option lists per spec group; groups without a usable chain are
 *  absent (never empty arrays). */
export type ShipVariantOptions = Partial<Record<VariantGroup, ShipVariantOption[]>>;

type Gp = Record<string, unknown> | null | undefined;

/** Mount/hardpoint entries live under HP_* keys (the game's slot layout). */
const HARDPOINT_KEY_RE = /^HP_/i;

function isDict(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Case/underscore-insensitive ucType match ("_Hull"/"Hull" → "hull"). */
function ucKind(ucType: unknown): string {
  return String(ucType ?? "").replace(/^_+/, "").toLowerCase();
}

/** Component-name list per role of one upgrade entry (strings only). */
function componentsOf(ent: Record<string, unknown>): Record<string, string[]> {
  const comps = ent.components;
  const out: Record<string, string[]> = {};
  if (!isDict(comps)) return out;
  for (const [role, names] of Object.entries(comps)) {
    if (Array.isArray(names)) {
      out[role.toLowerCase()] = names.filter((n): n is string => typeof n === "string");
    }
  }
  return out;
}

/**
 * Ordered chain steps of one ucType kind, stock first. Depth follows the
 * same-slot `prev` edges (stock = 0, one more per step; a prev naming another
 * slot's module puts the entry one level above the slot's stock; unresolved
 * chains fall back to depth 0), ties keep ShipUpgradeInfo table order — the
 * same topology the equipment-chain extractor emits.
 */
function orderedChain(
  entries: Record<string, Record<string, unknown>>,
  kind: string,
): ShipVariantOption[] {
  const names: string[] = [];
  for (const [name, ent] of Object.entries(entries)) {
    if (ucKind(ent.ucType) === kind) names.push(name);
  }
  if (names.length === 0) return [];
  const nameSet = new Set(names);
  const UNRESOLVED = -1;
  const depth = new Map<string, number>();
  for (const n of names) {
    const prev = entries[n].prev;
    if (!(typeof prev === "string" && prev)) depth.set(n, 0);
    else depth.set(n, nameSet.has(prev) ? UNRESOLVED : 1);
  }
  let progress = true;
  while (progress) {
    progress = false;
    for (const n of names) {
      if (depth.get(n) !== UNRESOLVED) continue;
      const prev = entries[n].prev as string;
      const pd = depth.get(prev);
      if (pd != null && pd !== UNRESOLVED) {
        depth.set(n, pd + 1);
        progress = true;
      }
    }
  }
  return names
    .map((n, i) => ({ n, i, depth: depth.get(n) ?? 0 }))
    .sort((a, b) => a.depth - b.depth || a.i - b.i)
    .map(({ n, depth }, pos): ShipVariantOption => {
      const prev = entries[n].prev;
      return {
        name: n,
        depth,
        prev: typeof prev === "string" && prev ? prev : null,
        components: componentsOf(entries[n]),
        role: kind,
        variant: variantLetter(pos),
      };
    });
}

/**
 * Column variant letter: A, B, … Z, AA, AB — the upgradeChainRows convention
 * (its copy stays there; this module needs one WITHOUT its tech-tree bundle
 * dependency, so the convention is mirrored and pinned by a test).
 */
export function variantLetter(column: number): string {
  const start = Number.isFinite(column) ? Math.max(0, Math.trunc(column)) : 0;
  let out = "";
  let n = start;
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * Enumerate the spec groups' module variants of one raw GameParams entry.
 * Returns {} for null/garbage input, loose dumps without ShipUpgradeInfo, and
 * slices whose upgrade table carries no usable module entries.
 */
export function buildShipVariantOptions(gp: unknown): ShipVariantOptions {
  if (!isDict(gp)) return {};
  const info = gp.ShipUpgradeInfo;
  if (!isDict(info)) return {};
  const entries: Record<string, Record<string, unknown>> = {};
  for (const [name, ent] of Object.entries(info)) {
    if (isDict(ent)) entries[name] = ent;
  }
  if (Object.keys(entries).length === 0) return {};
  const hull = orderedChain(entries, "hull");
  const airDefense = orderedChain(entries, "airdefense");
  const candidates: [VariantGroup, ShipVariantOption[]][] = [
    ["survivability", hull],
    ["artillery", orderedChain(entries, "artillery")],
    ["torpedoes", orderedChain(entries, "torpedoes")],
    // AA recomputes from the chosen option's airDefense components; a slice
    // with its own _AirDefense chain enumerates those, otherwise the options
    // are the hull variants (their components name the mounted AirDefense).
    ["antiAir", airDefense.length > 0 ? airDefense : hull],
    ["mobility", orderedChain(entries, "engine")],
    ["concealment", hull],
  ];
  const out: ShipVariantOptions = {};
  for (const [group, list] of candidates) {
    if (list.length > 0) out[group] = list;
  }
  return out;
}

/** The chain END (fully researched top module) — the panel's default pick. */
export function defaultVariantOf(
  list: readonly ShipVariantOption[] | undefined,
): ShipVariantOption | null {
  return list && list.length > 0 ? list[list.length - 1] : null;
}

/** One option by module entry name, or null. */
export function findVariantOf(
  list: readonly ShipVariantOption[] | undefined,
  name: string | undefined,
): ShipVariantOption | null {
  if (!list || !name) return null;
  return list.find((o) => o.name === name) ?? null;
}

/** Where one option sits in its stock → top chain, for the spec dropdowns'
 *  per-row stage tag. The classifier reads DEPTHS, not list positions, so
 *  parallel same-depth variants (two stock hulls, two top torp banks) all
 *  classify alike instead of the flat order lying about the second one. */
export type ShipVariantStage = "stock" | "mid" | "top";

/**
 * Chain stage of one option: "stock" roots the chain (depth 0 — the game's
 * as-delivered module), "top" sits at the deepest step of its chain (the
 * panel's default pick always does), "mid" fills the steps between. The
 * defensive floor is "stock": every list this module builds contains at
 * least one depth-0 root, and a cyclic prev chain keeps its UNRESOLVED
 * (-1) depth from orderedChain — the <= 0 floor reads it as stock, so a
 * caller can never hand us a depth that means anything else.
 * Single-entry chains answer "stock" too — they never render a dropdown
 * (the caller gates at two options), so the value is only a fallback.
 */
export function variantStageOf(
  list: readonly ShipVariantOption[],
  option: ShipVariantOption,
): ShipVariantStage {
  let max = 0;
  for (const o of list) if (o.depth > max) max = o.depth;
  if (option.depth <= 0) return "stock";
  return option.depth >= max ? "top" : "mid";
}

/** Stats one weapon-mount block answers for its slot's spec rows. */
export interface VariantMountStats {
  /** Σ numBarrels over the block's HP_* hardpoints (mount-level, in key
   *  order — the game's own layout order); null when the block has none. */
  barrels: number | null;
  /** First HP_* hardpoint's shotDelay (the displayed reload, seconds —
   *  Shimakaze's torpedo tubes read 150.0); null when none carries one. */
  reloadS: number | null;
  /** Widest barrelDiameter across the hardpoints, in mm; null when absent. */
  caliberMm: number | null;
}

/** Aggregate a mount block's hardpoint stats (defensive reads — hardpoint
 *  dicts may miss any field). Mirrors build_module_stats.py's extraction. */
export function mountStatsOf(block: Gp): VariantMountStats {
  let barrels: number | null = null;
  let reloadS: number | null = null;
  let caliberMm: number | null = null;
  if (isDict(block)) {
    for (const [key, hp] of Object.entries(block)) {
      if (!HARDPOINT_KEY_RE.test(key) || !isDict(hp)) continue;
      const nb = hp.numBarrels;
      if (typeof nb === "number" && Number.isFinite(nb)) {
        barrels = (barrels ?? 0) + nb;
      }
      if (reloadS == null && typeof hp.shotDelay === "number" && Number.isFinite(hp.shotDelay)) {
        reloadS = hp.shotDelay;
      }
      const dia = hp.barrelDiameter;
      if (typeof dia === "number" && Number.isFinite(dia) && dia > 0) {
        const mm = dia * 1000;
        if (caliberMm == null || mm > caliberMm) caliberMm = mm;
      }
    }
  }
  return { barrels, reloadS, caliberMm };
}

/** Mount stats across the variant's resolved blocks of one role (stats SUM
 *  across mounts — a two-turret hull answers 2× its per-mount numbers). */
export function variantMountStats(
  gp: unknown,
  option: ShipVariantOption,
  role: string,
): VariantMountStats {
  const out: VariantMountStats = { barrels: null, reloadS: null, caliberMm: null };
  for (const block of variantComponentBlocks(gp, option, [role])) {
    const s = mountStatsOf(block);
    if (s.barrels != null) out.barrels = (out.barrels ?? 0) + s.barrels;
    if (out.reloadS == null && s.reloadS != null) out.reloadS = s.reloadS;
    if (s.caliberMm != null && (out.caliberMm == null || s.caliberMm > out.caliberMm)) {
      out.caliberMm = s.caliberMm;
    }
  }
  return out;
}

/**
 * The variant a spec group should RECOMPUTE from: the explicitly selected
 * module, unless it is the chain end — the default (top) selection keeps the
 * WG-profile rendering exactly as before variants existed.
 */
export function selectedVariantOf(
  list: readonly ShipVariantOption[] | undefined,
  name: string | undefined,
): ShipVariantOption | null {
  const def = defaultVariantOf(list);
  if (!def || !name || name === def.name) return null;
  return findVariantOf(list, name);
}

/** Component blocks of one option for the given roles, resolved in the slice
 *  (dict values only, duplicates dropped). */
export function variantComponentBlocks(
  gp: unknown,
  option: ShipVariantOption,
  roles: readonly string[],
): Record<string, unknown>[] {
  if (!isDict(gp)) return [];
  const out: Record<string, unknown>[] = [];
  for (const role of roles) {
    for (const name of option.components[role] ?? []) {
      const block = gp[name];
      if (isDict(block) && !out.includes(block)) out.push(block);
    }
  }
  return out;
}
