/**
 * Player-build view model for the hover card (live roster + post-battle).
 *
 * Ground truth: a decoded PlayerBuild (ally-only IPC surface, see the
 * PlayerBuild interface in api/modules/replay.ts) carries NUMERIC GameParams
 * ids. This module is the one translation from those ids to the display
 * model the build grids render — skill names/icons/points, upgrade slots,
 * signal flags, mounted consumables. It is pure (no Vue, no store) so the
 * mapping is unit-tested directly.
 *
 * LEARNED-SKILL SPECIES ROWS (empirical; playerBuild.test.ts pins it):
 * the wire carries SIX per-species rows of skill ordinals. Classifying every
 * non-empty row of 364 decoded builds (31 local 15.9 replays, 2026-10-26) by
 * its class-EXCLUSIVE skill codes (skilltree.json tree membership) gives:
 *
 *   row 0 -> AirCarrier   (59/59 exclusive votes are CV Planes* skills)
 *   row 1 -> Battleship   (310/310 BB-exclusive: TriggerSpeedBb, ...)
 *   row 2 -> Cruiser      (79/79 CA-exclusive)
 *   row 3 -> Destroyer    (27/27 DD-exclusive)
 *   row 4 -> Auxiliary    (no capture on file; the only class left)
 *   row 5 -> Submarine    (21/21 SS-exclusive: Submarine*, TorpedoFlooding...)
 *
 * The submarine recorder of the local corpus carries Planes* skills in row 0
 * and Submarine* skills in row 5 — so row 0 is the CARRIER row, not the
 * submarine one (an earlier "SS = 0" reading of that capture was wrong). One
 * captain may hold skills in several species rows (retraining history), so
 * the UI shows ONLY the row of the player's current ship class, and an empty
 * row means "no skills on file for this class" — never another row's set.
 */
import type { PlayerBuild } from "@/api";
import { classSkills, skillIconUrl, SKILL_BUDGET, type SkillClass } from "@/components/ships/skillTree";
import {
  consumableFamilyOfEntity,
  dataCodeOf,
  familyIconUrl,
  SLOT_KEYS,
} from "@/components/ships/consumables";
import gameparamIdsRaw from "@/data/gameparam_ids.json";
import crewSkillTypesRaw from "@/data/crew_skill_types.json";
import signalsData from "@/data/signals.json";
import modernizationsData from "@/data/modernizations.json";
import { shipConsumableLabel } from "./shipLiveStats";

/** Baked-asset shapes this module reads (subsets, kept local). */
interface SignalEntry {
  index: string;
  name: string;
  names: Record<string, string>;
  desc: Record<string, string>;
  sortOrder: number;
}
interface ModernizationEntry {
  name: string;
  names: Record<string, string>;
  desc: Record<string, string>;
  slot: number;
}
interface CrewSkillType {
  code: string;
  tier: Record<string, number>;
}

const GAMEPARAM_IDS = gameparamIdsRaw as Record<string, string>;
const CREW_SKILL_TYPES = crewSkillTypesRaw as Record<string, CrewSkillType>;
const SIGNALS = signalsData as SignalEntry[];
const MODERNIZATIONS = modernizationsData as ModernizationEntry[];

const SIGNAL_BY_NAME = new Map(SIGNALS.map((s) => [s.name, s] as const));
const SIGNAL_BY_INDEX = new Map(SIGNALS.map((s) => [s.index, s] as const));
const MODERNIZATION_BY_NAME = new Map(
  MODERNIZATIONS.map((m) => [m.name, m] as const),
);

/** GameParams ship class to the captain-skill TREE class. Auxiliary has no
 *  tree in the baked skilltree.json (its crew rows exist but the layout is
 *  not shipped) — such a hull shows its picked skills as unplaced chips
 *  instead of borrowing the cruiser tree. */
const SKILL_TREE_CLASS_BY_TYPE: Readonly<Record<string, SkillClass>> = {
  AirCarrier: "CV",
  Battleship: "BB",
  Cruiser: "CA",
  Destroyer: "DD",
  Submarine: "SS",
};

/** Learned-skill species row per GameParams ship class — see the file header
 *  for the empirical derivation and playerBuild.test.ts for the pinned set. */
const SKILL_ROW_BY_SHIP_TYPE: Readonly<Record<string, number>> = {
  AirCarrier: 0,
  Battleship: 1,
  Cruiser: 2,
  Destroyer: 3,
  Auxiliary: 4,
  Submarine: 5,
};

export type PlayerBuildSource = "replay" | "probe";

/** One picked captain skill, placed on its class tree cell when the baked
 *  tree knows it (unknown future skills fall back to unplacedSkills). */
export interface PlayerBuildSkill {
  code: string;
  label: string;
  iconUrl: string | null;
  hint: string;
  tier: number;
  column: number;
}

/** One tier row of the class skill tree: cells are the picked skills, with
 *  null placeholders keeping the tree's column geometry. */
export interface PlayerBuildSkillRow {
  tier: number;
  cells: Array<PlayerBuildSkill | null>;
}

export interface PlayerBuildUpgrade {
  slot: number;
  code: string;
  label: string;
  hint: string;
  iconUrl: string;
}

export interface PlayerBuildSignal {
  code: string;
  index: string;
  label: string;
  hint: string;
  iconUrl: string;
}

export interface PlayerBuildConsumable {
  /** AbilitySlot index on the wire (0-based). */
  slot: number;
  /** Battle key for the slot (R/T/Y/U/I), null past the in-game sequence. */
  key: string | null;
  family: string;
  label: string;
  iconUrl: string | null;
}

/** The whole build grid's input — everything already localized/joined. */
export interface PlayerBuildView {
  source: PlayerBuildSource;
  /** GameParams ship class the build was built for, null when unknown. */
  shipType: string | null;
  /** Captain is in adaptation (retraining) — the grid shows a note. */
  inAdaptation: boolean;
  skills: PlayerBuildSkill[];
  skillRows: PlayerBuildSkillRow[];
  skillColumns: number;
  skillPoints: number;
  skillBudget: number;
  /** Picked skills the baked tree cannot place (a newer client's skills). */
  unplacedSkills: PlayerBuildSkill[];
  upgrades: PlayerBuildUpgrade[];
  signals: PlayerBuildSignal[];
  consumables: PlayerBuildConsumable[];
}

/** Resolve one numeric GameParams id to its top-level code, if the bake knows
 *  it (gameparam_ids.json: 23 859 ids). */
export function gameparamCode(id: number | null | undefined): string | null {
  if (id == null) return null;
  return GAMEPARAM_IDS[String(id)] ?? null;
}

/** Learned-skills row index for a GameParams ship class; null when the class
 *  is unknown (no row is then shown — never a guess). */
export function learnedSkillRowIndex(shipType: string | null | undefined): number | null {
  if (!shipType) return null;
  const row = SKILL_ROW_BY_SHIP_TYPE[shipType];
  return row == null ? null : row;
}

/** Baked per-language name out of a data dict ({en,ja,zh,tw}), null when the
 *  dict has nothing usable. */
function dataText(
  dict: Record<string, string> | undefined,
  code: string,
): string | null {
  if (!dict) return null;
  return dict[code] || dict.en || null;
}

/** Catalog entry for a decodable signal-flag code (PCEF019_JW1_SignalFlag),
 *  matched by full name first, then by the six-character catalog index. */
function signalEntryFor(code: string): SignalEntry | null {
  const byName = SIGNAL_BY_NAME.get(code);
  if (byName) return byName;
  for (const [index, entry] of SIGNAL_BY_INDEX) {
    if (code.startsWith(index + "_") || code === index) return entry;
  }
  return null;
}

function signalIconUrl(entry: SignalEntry): string {
  return "/images/signals/" + entry.name + ".webp";
}

function modernizationIconUrl(entry: ModernizationEntry): string {
  return "/images/modernization/icon_modernization_" + entry.name + ".webp";
}

/** One learned-skill row translated for the grid; the class tree supplies the
 *  cell positions, crew_skill_types.json the point cost. */
function skillView(
  ordinal: number,
  classType: string,
  dataCode: string,
  tree: Map<string, { code: string; tier: number; column: number; name: Record<string, string> }>,
  cls: Parameters<typeof skillIconUrl>[1],
): { placed: PlayerBuildSkill | null; label: string; tier: number; iconUrl: string | null } {
  const record = CREW_SKILL_TYPES[String(ordinal)];
  const code = record?.code ?? null;
  const treeSkill = code ? tree.get(code) : undefined;
  const label = (treeSkill && dataText(treeSkill.name, dataCode)) || code || String(ordinal);
  const tier = treeSkill?.tier ?? record?.tier[classType] ?? 0;
  const iconUrl = code ? skillIconUrl(code, cls) : null;
  const placed =
    treeSkill && tier > 0
      ? {
          code,
          label,
          iconUrl,
          hint: label,
          tier,
          column: treeSkill.column,
        }
      : null;
  return { placed, label, tier, iconUrl };
}

/** Translate one decoded build into the grid's view model. shipType is the
 *  player's GameParams ship class (caller resolves it from the ship id); a
 *  null class still yields upgrades/signals/consumables but no skill rows. */
export function playerBuildView(
  build: PlayerBuild,
  options: {
    dataLanguage: string;
    shipType?: string | null;
    source?: PlayerBuildSource;
  },
): PlayerBuildView {
  const dataCode = dataCodeOf(options.dataLanguage);
  const shipType = options.shipType ?? null;
  const cls = shipType ? SKILL_TREE_CLASS_BY_TYPE[shipType] ?? null : null;
  const treeSkills = cls ? classSkills(cls) : [];
  const tree = new Map(treeSkills.map((s) => [s.code, s] as const));

  // ── Captain skills: the row of THIS ship class only ───────────────────
  const rowIndex = learnedSkillRowIndex(shipType);
  const row = rowIndex == null ? [] : build.learnedSkills?.[rowIndex] ?? [];
  const picked = new Map<string, PlayerBuildSkill>();
  const unplaced: PlayerBuildSkill[] = [];
  let skillPoints = 0;
  const seenOrdinals = new Set<number>();
  for (const ordinal of row) {
    if (seenOrdinals.has(ordinal)) continue;
    seenOrdinals.add(ordinal);
    if (shipType) skillPoints += CREW_SKILL_TYPES[String(ordinal)]?.tier[shipType] ?? 0;
    const view = skillView(ordinal, shipType ?? "", dataCode, tree, cls ?? undefined);
    if (view.placed) {
      if (!picked.has(view.placed.code)) picked.set(view.placed.code, view.placed);
    } else {
      unplaced.push({
        code: view.label,
        label: view.label,
        iconUrl: view.iconUrl,
        hint: view.label,
        tier: view.tier,
        column: -1,
      });
    }
  }
  const skills = [...picked.values()].sort(
    (a, b) => a.tier - b.tier || a.column - b.column,
  );
  // Column count of the class tree (BB/CA/DD/CV = 6, SS = 5); a class the
  // tree does not know falls back to the widest standard tree.
  let skillColumns = 6;
  if (treeSkills.length > 0) {
    let max = 0;
    for (const s of treeSkills) max = Math.max(max, s.column);
    skillColumns = max + 1;
  }
  const skillRows: PlayerBuildSkillRow[] = [1, 2, 3, 4].map((tier) => ({
    tier,
    cells: Array.from({ length: skillColumns }, (_, column) => {
      const hit = skills.find((s) => s.tier === tier && s.column === column);
      return hit ?? null;
    }),
  }));

  // ── Upgrades (modernizations), ordered by their in-game slot ──────────
  const upgrades: PlayerBuildUpgrade[] = [];
  const seenUpgrades = new Set<string>();
  for (const id of build.modernization ?? []) {
    const code = gameparamCode(id);
    if (!code || seenUpgrades.has(code)) continue;
    const entry = MODERNIZATION_BY_NAME.get(code);
    if (!entry) continue;
    seenUpgrades.add(code);
    const label = dataText(entry.names, dataCode) ?? code;
    const desc = dataText(entry.desc, dataCode);
    upgrades.push({
      slot: entry.slot,
      code,
      label,
      hint: desc ? label + ": " + desc : label,
      iconUrl: modernizationIconUrl(entry),
    });
  }
  upgrades.sort((a, b) => a.slot - b.slot || a.code.localeCompare(b.code));

  // ── Signal flags: PCEF exterior slots (camouflage/paint ids are skipped) ─
  const signals: PlayerBuildSignal[] = [];
  const seenSignals = new Set<string>();
  for (const id of build.exteriors ?? []) {
    const code = gameparamCode(id);
    if (!code || !code.startsWith("PCEF")) continue;
    const entry = signalEntryFor(code);
    if (!entry || seenSignals.has(entry.index)) continue;
    seenSignals.add(entry.index);
    const label = dataText(entry.names, dataCode) ?? entry.index;
    const desc = dataText(entry.desc, dataCode);
    signals.push({
      code,
      index: entry.index,
      label,
      hint: desc ? label + ": " + desc : label,
      iconUrl: signalIconUrl(entry),
    });
  }

  // ── Mounted consumables: AbilitySlot ids, slot order gives the key ────
  const consumables: PlayerBuildConsumable[] = [];
  const seenFamilies = new Set<string>();
  (build.abilities ?? []).forEach((id, slot) => {
    if (!id) return;
    const code = gameparamCode(id);
    const family = code ? consumableFamilyOfEntity(code) : null;
    const identity = family ?? code;
    if (!identity || seenFamilies.has(identity)) return;
    seenFamilies.add(identity);
    consumables.push({
      slot,
      key: slot < SLOT_KEYS.length ? SLOT_KEYS[slot] : null,
      family: family ?? "",
      label: family ? shipConsumableLabel(family) : code ?? String(id),
      iconUrl: family ? familyIconUrl(family) : null,
    });
  });

  return {
    source: options.source ?? "replay",
    shipType,
    inAdaptation: build.isInAdaptation === true,
    skills,
    skillRows,
    skillColumns,
    skillPoints,
    skillBudget: SKILL_BUDGET,
    unplacedSkills: unplaced,
    upgrades,
    signals,
    consumables,
  };
}

/** True when the grid has anything to show — a build whose decode carried no
 *  loadout at all must not widen the card or render an empty section. */
export function playerBuildHasContent(view: PlayerBuildView | null | undefined): boolean {
  if (!view) return false;
  return (
    view.skills.length > 0 ||
    view.unplacedSkills.length > 0 ||
    view.upgrades.length > 0 ||
    view.signals.length > 0 ||
    view.consumables.length > 0
  );
}

/** Join one roster row to its build: the player name wins (the Rust exit
 *  attributes it when the ship id maps to exactly one ally), then a build
 *  whose ship id maps to exactly one unnamed ally entry, else nothing —
 *  ambiguous hulls intentionally show no loadout rather than a wrong one. */
export function joinPlayerBuild(
  builds: readonly PlayerBuild[] | null | undefined,
  name: string | null | undefined,
  shipId: number | null | undefined,
): PlayerBuild | null {
  if (!builds || builds.length === 0) return null;
  if (name) {
    for (const build of builds) {
      if (build.name && build.name === name) return build;
    }
  }
  if (shipId == null) return null;
  const candidates = builds.filter((b) => !b.name && b.shipParamsId === shipId);
  return candidates.length === 1 ? candidates[0] : null;
}
