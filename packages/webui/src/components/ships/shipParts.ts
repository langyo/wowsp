/**
 * Ship-part role resolution over a raw GameParams ship entry.
 *
 * The ship detail views (weapon bar, AA spec rows, armor/waterline fallbacks)
 * used to read weapon blocks by their CANONICAL component names only
 * (`A_Artillery`, `A_ATBA`, `A_Torpedoes`, `A_AirDefense`, …). That naming is
 * just the historical upgrade code of ONE hull variant: 2022+ game builds
 * renamed most components canonically, but plenty of ships keep arbitrary
 * codes (`A1_610` torpedo tubes, `AB_127_50` guns, `B_AirDefense`) — reading
 * canonical keys alone silently missed every weapon block for ~55% of the
 * fleet, and one coincidence made it worse: ships whose catapult block is
 * canonically named `A_AirArmament` exposed that block as a "torpedo" badge,
 * because `A_AirArmament` (aircraft catapults: HP_AC_* and friends) was read
 * as the torpedo source (X Worcester: "鱼雷 2×1" with no torpedo tubes).
 *
 * The game's own role → component mapping lives in `ShipUpgradeInfo`: the
 * `_Hull` upgrade entries chain stock → top via `prev`, and each upgrade's
 * `components` dict maps role names ("artillery", "torpedoes", "atba",
 * "airDefense", "airArmament", "depthCharges", "hull", …) to component
 * NAMES. Multi-option roles list every mountable variant on the hull
 * (Shimakaze torpedoes A1/A2/A3_610); the mounted variant is picked by the
 * role's own upgrade chain (the `ucType: "_Torpedoes"` entries, same `prev`
 * chaining) — the chain end is the fully-researched top module.
 *
 * resolveShipParts() resolves role names to the actual component dicts:
 *  - "top"  configuration (chain ends) — the fully upgraded ship, matching
 *    the 规格参数 panel's top-configuration convention;
 *  - "stock" configuration (chain heads) — the stock hull, matching the
 *    WG `default_profile` numbers the AA spec rows are built against.
 * Entries without a parsable ShipUpgradeInfo (loose unpacker dumps) fall
 * back to the canonical literal keys, so every consumer keeps working on
 * any data shape. Everything is defensive: PascalCase/missing/null fields
 * are the norm (same discipline as antiAir.ts).
 */

type Gp = Record<string, any> | null | undefined;

/** Role names the ship detail views consume, in ShipUpgradeInfo spelling. */
export type ShipPartRole =
  | "hull"
  | "artillery"
  | "atba"
  | "torpedoes"
  | "airDefense"
  | "airArmament"
  | "depthCharges"
  | "airSupport";

export const SHIP_PART_ROLES: readonly ShipPartRole[] = [
  "hull",
  "artillery",
  "atba",
  "torpedoes",
  "airDefense",
  "airArmament",
  "depthCharges",
  "airSupport",
];

/** Resolved component blocks per role, top-configuration or stock. */
export interface ShipParts {
  hull: Gp;
  artillery: Gp[];
  atba: Gp[];
  torpedoes: Gp[];
  airDefense: Gp[];
  airArmament: Gp[];
  depthCharges: Gp[];
  airSupport: Gp[];
}

function isDict(v: unknown): v is Record<string, any> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** ShipUpgradeInfo entries keyed by upgrade name; null when absent/unparsable. */
function upgradeInfoOf(gp: Gp): Record<string, Record<string, any>> | null {
  if (!isDict(gp)) return null;
  const info = gp.ShipUpgradeInfo;
  if (!isDict(info)) return null;
  const out: Record<string, Record<string, any>> = {};
  for (const [name, ent] of Object.entries(info)) {
    if (isDict(ent)) out[name] = ent;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Case/underscore-insensitive ucType match ("_Hull"/"Hull" → "hull"). */
function ucKind(ucType: unknown): string {
  return String(ucType ?? "").replace(/^_+/, "").toLowerCase();
}

/** Role components of one upgrade entry (component NAMES per role). */
function componentsOf(ent: Record<string, any>): Record<string, string[]> {
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
 * One upgrade chain per ucType kind: upgrades link to their predecessor via
 * `prev`, the chain END is the top (fully researched) module and the head
 * the stock one. Split/duplicate chains are tolerated — ends resolve by
 * "not referenced as anyone's prev", ties keep the first in table order.
 */
function chainsByKind(
  info: Record<string, Record<string, any>>,
): Map<string, { head: string; end: string; names: string[] }> {
  const byKind = new Map<string, string[]>();
  for (const [name, ent] of Object.entries(info)) {
    const kind = ucKind(ent.ucType);
    if (!kind) continue;
    const names = byKind.get(kind);
    if (names) names.push(name);
    else byKind.set(kind, [name]);
  }
  const out = new Map<string, { head: string; end: string; names: string[] }>();
  for (const [kind, names] of byKind) {
    const referenced = new Set<string>();
    for (const name of names) {
      const prev = info[name].prev;
      if (typeof prev === "string" && prev) referenced.add(prev);
    }
    const ends = names.filter((n) => !referenced.has(n));
    // The head is the stock module: the chain entry nothing follows FROM,
    // i.e. an entry never named as another's successor — approximated by
    // "its prev points outside this kind's table" (stock roots point at ""
    // or at a name that is not an upgrade of the same kind).
    const nameSet = new Set(names);
    const heads = names.filter((n) => {
      const prev = info[n].prev;
      return !(typeof prev === "string" && nameSet.has(prev));
    });
    const end = ends[0] ?? names[names.length - 1];
    const head = heads[0] ?? names[0];
    out.set(kind, { head, end, names });
  }
  return out;
}

/** Component-name list for one role, at the requested configuration depth. */
function roleComponentNames(
  info: Record<string, Record<string, any>>,
  chains: Map<string, { head: string; end: string; names: string[] }>,
  hullEntry: Record<string, any>,
  role: ShipPartRole,
  config: "stock" | "top",
): string[] {
  const key = role.toLowerCase();
  const hullNames = componentsOf(hullEntry)[key] ?? [];
  // The role's own upgrade chain decides stock vs top when upgrades exist
  // (torpedo A1/A2/A3-style variants); otherwise the hull entry's list IS
  // the mounted configuration.
  const chain = chains.get(key);
  if (chain) {
    const pick = config === "top" ? chain.end : chain.head;
    const names = componentsOf(info[pick])[key];
    if (names && names.length > 0) {
      // An upgrade entry may co-list every hull variant's blocks (stock
      // artillery upgrades name A_Artillery AND B_Artillery); the hull's
      // own list names exactly what THAT hull mounts — intersect down to
      // it, or the mounts double-count.
      if (hullNames.length > 0) {
        const hullSet = new Set(hullNames);
        const mounted = names.filter((n) => hullSet.has(n));
        if (mounted.length > 0) return mounted;
      }
      return names;
    }
  }
  return hullNames;
}

/** Canonical literal block keys, the fallback when resolution is silent. */
const CANONICAL_KEYS: Record<ShipPartRole, string[]> = {
  hull: ["A_Hull", "Hull"],
  artillery: ["A_Artillery"],
  atba: ["A_ATBA"],
  torpedoes: ["A_Torpedoes"],
  airDefense: ["A_AirDefense"],
  airArmament: ["A_AirArmament"],
  depthCharges: ["A_DepthCharge"],
  airSupport: ["A_AirSupport"],
};

function blocksFor(gp: Gp, names: string[]): Gp[] {
  if (!isDict(gp)) return [];
  return names
    .map((n) => gp[n])
    .filter((b): b is Record<string, any> => isDict(b));
}

const EMPTY_PARTS: ShipParts = {
  hull: null,
  artillery: [],
  atba: [],
  torpedoes: [],
  airDefense: [],
  airArmament: [],
  depthCharges: [],
  airSupport: [],
};

/**
 * Resolve the ship's part blocks for the requested configuration ("top" =
 * fully upgraded, "stock" = as researched). Returns per-role block dicts;
 * consumers group/count their own HP_* slots inside them.
 */
export function resolveShipParts(gp: Gp, config: "stock" | "top" = "top"): ShipParts {
  if (!isDict(gp)) return EMPTY_PARTS;
  const info = upgradeInfoOf(gp);
  if (!info) return canonicalParts(gp);

  const chains = chainsByKind(info);
  // The ship-level hull entries ("_Hull"); top/stock picked by the chain.
  const hullChain = chains.get("hull");
  const hullName = hullChain ? (config === "top" ? hullChain.end : hullChain.head) : null;
  const hullEntry = (hullName && info[hullName]) || null;
  if (!hullEntry) return canonicalParts(gp);

  // Fresh arrays per call — the literal fallback below pushes into them.
  const parts: ShipParts = {
    hull: null,
    artillery: [],
    atba: [],
    torpedoes: [],
    airDefense: [],
    airArmament: [],
    depthCharges: [],
    airSupport: [],
  };
  // Legacy fallback: entries whose hull omits a role (or unpacker dumps
  // with stripped hulls) still mounted the canonical block — e.g. the
  // Midway legacy hull carries its secondaries' far AA aura in a literal
  // A_ATBA its ShipUpgradeInfo never names.
  const literalBlock = (role: ShipPartRole): Gp => {
    for (const key of CANONICAL_KEYS[role]) {
      if (isDict(gp[key])) return gp[key];
    }
    return null;
  };
  {
    const names = roleComponentNames(info, chains, hullEntry, "hull", config);
    parts.hull = blocksFor(gp, names)[0] ?? literalBlock("hull");
  }
  for (const role of SHIP_PART_ROLES) {
    if (role === "hull") continue;
    const names = roleComponentNames(info, chains, hullEntry, role, config);
    const blocks = blocksFor(gp, names);
    if (blocks.length > 0) {
      parts[role] = blocks;
      continue;
    }
    const literal = literalBlock(role);
    if (literal) parts[role].push(literal);
  }
  return parts;
}

/**
 * Fallback for entries without a parsable ShipUpgradeInfo: the canonical
 * component names (A_Artillery, A_Torpedoes, …). Torpedoes deliberately
 * have NO A_AirArmament leg — that block is aircraft catapults.
 */
function canonicalParts(gp: Record<string, any>): ShipParts {
  const first = (v: unknown): Gp => (isDict(v) ? v : null);
  const list = (v: unknown): Gp[] => (isDict(v) ? [v] : []);
  return {
    hull: first(gp.A_Hull) ?? first(gp.Hull),
    artillery: list(gp.A_Artillery),
    atba: list(gp.A_ATBA),
    torpedoes: list(gp.A_Torpedoes),
    airDefense: list(gp.A_AirDefense),
    airArmament: list(gp.A_AirArmament),
    depthCharges: list(gp.A_DepthCharge),
    airSupport: list(gp.A_AirSupport),
  };
}

/** HP_* mount slot entries of a component block ("HP_AGM_1" → dict). */
export function hpSlots(block: Gp): [string, Record<string, any>][] {
  if (!isDict(block)) return [];
  return Object.entries(block).filter(
    ([k, v]) => k.startsWith("HP_") && isDict(v),
  ) as [string, Record<string, any>][];
}

/**
 * HP_* mount slots merged across every block of a role. Slot keys are
 * unique per ship assembly — when several resolved blocks carry the same
 * key (variant blocks co-listed by one upgrade entry), the first wins so
 * mounts never double-count.
 */
export function roleHpSlots(blocks: Gp[]): [string, Record<string, any>][] {
  const out: [string, Record<string, any>][] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    for (const [k, v] of hpSlots(block)) {
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([k, v]);
    }
  }
  return out;
}
