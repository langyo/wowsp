/**
 * Pure data preparation for the BuildPlanner's 装备选择 (equipment
 * progression) panel.
 *
 * The panel renders one ROW per ShipUpgradeInfo ucType slot, left to right
 * from that slot's stock module to its researched modules. Every step
 * carries its raw GameParams 'prev' prerequisite key (null for stock) and its
 * upgrade 'depth' inside the slot, so a slot with parallel research options
 * stacks them as tiles in ONE column:
 *
 *   stock ─┬─ option A ── top A
 *          └─ option B ── top B
 *
 * Missing/invalid depth still falls back to the sequential stock-first step
 * order (a defensive default for partial snapshots; the shipped bundle always
 * carries it). A step whose 'prev' names no module of its own slot (the
 * hull-locked torpedo/artillery tops, cross-slot prerequisites) connects to
 * the row's previous column instead and surfaces its required module in the
 * tile tooltip.
 *
 * Everything here is Vue-free and i18n-free (the caller localizes role keys
 * and labels), so the layout model is unit-testable in isolation.
 */
import {
  allTechTreeNodes,
  techTreeNode,
  type TechTreeNode,
  type TechTreeRealm,
} from "@/utils/techTreeData";

/** Component-name map of one module ("torpedoes" -> ["A1_Torpedoes"]). */
export type ChainComponents = Record<string, string[]>;

/** One module step as the accessor emits it (per-step topology included). */
export interface ChainStepInput {
  name: string;
  isStock: boolean;
  xp: number | null;
  credits: number | null;
  components: ChainComponents;
  unlocks?: number[];
  /** GameParams entry key this module upgrades from; null for stock. */
  prev: string | null;
  /** Upgrade level inside the slot: stock = 0; same-level options share it. */
  depth: number;
}

/** One module bracket (ucType slot) as the accessor emits it. */
export interface ChainSlotInput {
  ucType: string;
  steps: readonly ChainStepInput[];
}

/** Subset of ShipUpgradeChain the panel needs. Kept structural so the
 *  accessor types can evolve (topology fields) without coupling this module. */
export interface UpgradeChainInput {
  research: { xp: number | null };
  next: Record<string, { index: string | null; xpShip: number | null }>;
  slots: readonly ChainSlotInput[];
}

/** One next-ship link of a module, already filtered to same-realm targets. */
export interface NextShipLink {
  shipId: number;
  /** The unlocked ship's GameParams index ("PJSD012"), when known. */
  index: string | null;
  /** The unlocked ship's own research XP (null when the bundle lacks it). */
  xpShip: number | null;
}

/** One rendered module tile. */
export interface UpgradeCell {
  step: ChainStepInput;
  /** 0-based column (0 = the slot's stock module). */
  column: number;
  /** 0-based vertical lane inside that column: same-depth options stack. */
  lane: number;
  /** A / B / C ... — the column's variant letter. */
  variant: string;
  /** GameParams entry name of the cell this one draws its connector FROM. */
  parentName: string | null;
  /** Researchable same-realm ships this module unlocks. */
  nextShips: NextShipLink[];
}

/** One slot row of the panel. */
export interface UpgradeRow {
  /** Raw accessor ucType ("_Hull", "_Suo", ...). */
  ucType: string;
  /** Normalized role key for the ships.parts.role.* i18n table. */
  role: string;
  /** Column-major cells. */
  cells: UpgradeCell[];
  /** columns[0] is the stock column; same-depth options share a column. */
  columns: UpgradeCell[][];
  /** Height of the row in tiles (tallest column). */
  laneCount: number;
  /** Next-ship cards drawn after this row's LAST module, deduped. */
  nextShips: NextShipLink[];
}

/** The whole panel model (null chain => caller's empty state). */
export interface UpgradePanel {
  rows: UpgradeRow[];
  /** This ship's ship-level research XP (the previous-tier link tooltip). */
  researchXp: number | null;
}

/** Canonical slot order — mirrors the extractor's SLOT_ORDER: hull anchors
 *  the chain, then the game's equipment-tab order, then everything else
 *  alphabetically. */
const SLOT_ORDER: Readonly<Record<string, number>> = {
  hull: 0,
  suo: 1,
  artillery: 2,
  engine: 3,
  torpedoes: 4,
};

/** Canonical component-role order inside one module's hover card. */
const COMPONENT_ROLE_ORDER: readonly string[] = [
  "hull",
  "firecontrol",
  "artillery",
  "atba",
  "torpedoes",
  "depthcharges",
  "airdefense",
  "airarmament",
  "airsupport",
  "pinger",
  "radars",
  "directors",
  "finders",
  "engine",
  "specials",
  "visualcustomizations",
];

/** Normalize a ucType / component-role name to the lowercase i18n key
 *  ("_Hull" -> "hull", "airArmament" -> "airarmament"). */
export function chainRole(ucType: string): string {
  return String(ucType ?? "")
    .replace(/^_+/, "")
    .replace(/_/g, "")
    .toLowerCase();
}

/** Sort rank of a normalized slot role (hull first, then the game's order,
 *  every other slot afterwards alphabetically by the caller's tiebreak). */
export function slotOrderOf(role: string): number {
  return SLOT_ORDER[role] ?? 100;
}

/** Column variant letter: A, B, ... Z, AA, AB ... */
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

/** The stock/med/top marker GameParams encodes in a module entry name
 *  ("PJUH841_D9_HULL_STOCK_2" -> "stock"). The A/B/C tile letter is the
 *  module's COLUMN position instead: a rebalanced chain renumbers names,
 *  while the column is what the player sees. */
export function variantMarkerOf(name: string): "stock" | "med" | "top" | null {
  const match = /_(STOCK|MED|TOP)(?:_\d+)?(?:_|$)/i.exec(String(name ?? ""));
  if (!match) return null;
  const marker = match[1].toLowerCase();
  return marker === "stock" || marker === "med" || marker === "top" ? marker : null;
}

/** Filter a module's GameParams unlock targets to the researchable tree
 *  ships of the realm — the same contract as treeNextShipIds: drop
 *  premium/special side leaves and ships the realm's tree does not carry. */
export function researchNextShipIds(
  ids: readonly number[] | undefined,
  realm: TechTreeRealm = "wg",
): number[] {
  if (!ids || ids.length === 0) return [];
  const out: number[] = [];
  for (const id of ids) {
    if (out.includes(id)) continue;
    const node = techTreeNode(id, realm);
    if (!node || node.isPremium || node.isSpecial) continue;
    out.push(id);
  }
  return out;
}

/** Pick the predecessor out of the candidate parent nodes. Split out so the
 *  tie-break rules are directly testable (real trees rarely fork). */
export function pickPreviousShip(
  target: TechTreeNode | null,
  candidates: readonly TechTreeNode[],
): TechTreeNode | null {
  if (candidates.length === 0) return null;
  const researchable = candidates.filter((node) => !node.isPremium && !node.isSpecial);
  const pool = (researchable.length > 0 ? researchable : candidates).slice();
  pool.sort((a, b) => {
    const sameA = target && a.type === target.type ? 0 : 1;
    const sameB = target && b.type === target.type ? 0 : 1;
    return sameA - sameB || a.tier - b.tier || a.shipId - b.shipId;
  });
  return pool[0];
}

/** The tech-tree predecessor of a ship: the node whose nextShips lists it.
 *  When several parents qualify (data-level forks), the same ship type wins
 *  first, then the lowest tier. */
export function resolvePreviousShip(
  shipId: number,
  realm: TechTreeRealm = "wg",
): TechTreeNode | null {
  const candidates: TechTreeNode[] = [];
  for (const node of Object.values(allTechTreeNodes(realm))) {
    if (node.shipId === shipId) continue;
    if (!node.nextShips.includes(shipId)) continue;
    candidates.push(node);
  }
  return pickPreviousShip(techTreeNode(shipId, realm), candidates);
}

/** Rank of a normalized component role inside the hover card. */
export function componentRoleRank(role: string): number {
  const index = COMPONENT_ROLE_ORDER.indexOf(role);
  return index < 0 ? COMPONENT_ROLE_ORDER.length : index;
}

/** One mounted component role of a module, ready for the hover card. */
export interface MountedComponent {
  /** Lowercase role key (ships.parts.role.<role>), e.g. "torpedoes". */
  role: string;
  /** Component NAMES the module mounts for the role. */
  names: string[];
}

/** Component roles a module mounts, ordered for display and with empty
 *  roles dropped. */
export function mountedComponents(
  components: ChainComponents | null | undefined,
): MountedComponent[] {
  if (!components) return [];
  const out: MountedComponent[] = [];
  for (const [role, names] of Object.entries(components)) {
    if (!Array.isArray(names)) continue;
    const filtered = names.filter((name): name is string => typeof name === "string");
    if (filtered.length === 0) continue;
    out.push({ role: chainRole(role), names: filtered });
  }
  out.sort(
    (a, b) =>
      componentRoleRank(a.role) - componentRoleRank(b.role) ||
      (a.role < b.role ? -1 : a.role > b.role ? 1 : 0),
  );
  return out;
}

/** Effective depth of every step. The shipped bundle always carries it; a
 *  partial/legacy snapshot without a usable depth falls back to the
 *  sequential stock-first step order instead of collapsing the column. */
function effectiveDepths(steps: readonly ChainStepInput[]): number[] {
  const stockIndex = Math.max(0, steps.findIndex((step) => step.isStock));
  return steps.map((step, index) => {
    const depth =
      typeof step.depth === "number" && Number.isFinite(step.depth)
        ? Math.trunc(step.depth)
        : NaN;
    if (Number.isFinite(depth) && depth >= 0) return depth;
    return index === stockIndex ? 0 : index < stockIndex ? index + 1 : index;
  });
}

/** Researchable next-ship links of one module, with the ship-level XP the
 *  panel's extension-line tooltip renders. */
function nextLinksOf(
  step: ChainStepInput,
  chain: UpgradeChainInput,
  realm: TechTreeRealm,
): NextShipLink[] {
  return researchNextShipIds(step.unlocks, realm).map((shipId) => {
    const meta = chain.next?.[String(shipId)];
    return {
      shipId,
      index: typeof meta?.index === "string" ? meta.index : null,
      xpShip: typeof meta?.xpShip === "number" ? meta.xpShip : null,
    };
  });
}

/** Build one slot row (null when the slot carries no steps at all). */
function buildRow(
  slot: ChainSlotInput,
  chain: UpgradeChainInput,
  realm: TechTreeRealm,
): UpgradeRow | null {
  const steps = slot.steps ?? [];
  if (steps.length === 0) return null;
  const depths = effectiveDepths(steps);
  const depthValues = [...new Set(depths)].sort((a, b) => a - b);
  const columnOf = new Map<number, number>(depthValues.map((depth, index) => [depth, index]));
  // Cells grouped by depth, keeping the accessor's order inside a depth.
  const byDepth = new Map<number, number[]>();
  for (let index = 0; index < steps.length; index++) {
    const depth = depths[index];
    const list = byDepth.get(depth);
    if (list) list.push(index);
    else byDepth.set(depth, [index]);
  }

  const columns: UpgradeCell[][] = [];
  const cells: UpgradeCell[] = [];
  const byName = new Map<string, UpgradeCell>();
  for (const depth of depthValues) {
    const indexes = byDepth.get(depth) ?? [];
    const column = columnOf.get(depth) ?? 0;
    const previousColumn = column > 0 ? columns[column - 1] : undefined;
    /** Lane of a step's parent (or of the previous column's anchor) — keeps
     *  the children of one option together so edges do not cross. */
    const parentLane = (step: ChainStepInput, fallbackIndex: number): number => {
      const prev = typeof step.prev === "string" && step.prev ? step.prev : null;
      if (prev) {
        const parent = byName.get(prev);
        if (parent && parent.column < column) return parent.lane;
      }
      if (previousColumn && previousColumn.length > 0) return previousColumn[0].lane;
      return fallbackIndex;
    };
    indexes.sort(
      (a, b) => parentLane(steps[a], a) - parentLane(steps[b], b) || a - b,
    );
    const columnCells: UpgradeCell[] = [];
    for (const index of indexes) {
      const step = steps[index];
      const prev = typeof step.prev === "string" && step.prev ? step.prev : null;
      let parentName: string | null = null;
      if (prev) {
        const parent = byName.get(prev);
        if (parent && parent.step !== step) parentName = parent.step.name;
      }
      // Cross-slot / missing prev: connect from the previous column (the
      // hull-locked top modules land here) instead of leaving the tile
      // unconnected; the required module still rides the hover card.
      if (!parentName && previousColumn && previousColumn.length > 0) {
        parentName = previousColumn[0].step.name;
      }
      const cell: UpgradeCell = {
        step,
        column,
        lane: columnCells.length,
        variant: variantLetter(column),
        parentName,
        nextShips: nextLinksOf(step, chain, realm),
      };
      columnCells.push(cell);
      cells.push(cell);
      byName.set(step.name, cell);
    }
    columns.push(columnCells);
  }

  // Only the LAST module's unlocks continue the line to the next ship; a
  // mid-chain unlock is data noise this panel does not draw.
  const lastColumn = columns[columns.length - 1] ?? [];
  const nextShips: NextShipLink[] = [];
  for (const cell of lastColumn) {
    for (const link of cell.nextShips) {
      if (!nextShips.some((existing) => existing.shipId === link.shipId)) nextShips.push(link);
    }
  }

  return {
    ucType: slot.ucType,
    role: chainRole(slot.ucType),
    cells,
    columns,
    laneCount: Math.max(...columns.map((column) => column.length), 0),
    nextShips,
  };
}

/**
 * Build the 装备选择 panel model from one ship's upgrade chain.
 * Returns null when the chain (or a usable slot list) is missing — the
 * caller renders the empty state in that case.
 */
export function buildUpgradeChainRows(
  chain: UpgradeChainInput | null,
  realm: TechTreeRealm = "wg",
): UpgradePanel | null {
  if (!chain || !Array.isArray(chain.slots) || chain.slots.length === 0) return null;
  const rows: UpgradeRow[] = [];
  for (const slot of chain.slots) {
    const row = buildRow(slot, chain, realm);
    if (row) rows.push(row);
  }
  if (rows.length === 0) return null;
  rows.sort(
    (a, b) =>
      slotOrderOf(a.role) - slotOrderOf(b.role) ||
      (a.role < b.role ? -1 : a.role > b.role ? 1 : 0),
  );
  return {
    rows,
    researchXp: typeof chain.research?.xp === "number" ? chain.research.xp : null,
  };
}
