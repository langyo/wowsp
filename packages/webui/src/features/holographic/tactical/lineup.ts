/**
 * Fleet lineup for the plan board: the two teams a plan is authored around.
 *
 * A lineup replaces free-placed icon guessing — the author declares the
 * matchup first (7v7 clan default, 6v6, asymmetric, whatever the matchup
 * is), configures each hull's loadout (torpedo choice, consumables), and
 * the board spawns real units at the map edges. Everything a later order,
 * zone or export needs is resolved from the baked assets synchronously
 * (ship_live_stats + ship_consumable_kit — no GameParams dependency, so it
 * works on installs without a game).
 *
 * Persisted per map in localStorage alongside the plan documents; the
 * profile exporter (profile.rs round trip) carries it inside the TOML meta.
 */
import { shipLiveStats } from "@/features/replay/shipLiveStats";
import kitRaw from "@/data/ship_consumable_kit.json";
import type { ShipInfo } from "@/api/client";
import type { Vec2 } from "./types";
import type { ZoneStatSource } from "./zones";
import { wrapAngle } from "./kinematics";

export type TeamSide = "ally" | "enemy";

/** Side-tint of a unit glyph / zone (readable over the dark minimap art and
 *  distinct from the cap-ring greens/reds the board also draws). */
export const TEAM_COLOR: Record<TeamSide, string> = {
  ally: "#22d3ee",
  enemy: "#f472b6",
};

/** One hull of a lineup. `label` "" = display the ship's localized name. */
export interface LineupEntry {
  /** Stable local id (element ids reference nothing here; mirror pairing
   *  uses list INDEX, ids just keep Vue keys stable under reordering). */
  id: string;
  shipId: number;
  label: string;
  /** Chosen torpedo variant index (0 = the baked default — the widest
   *  range the asset knows; further variants arrive with the data refresh
   *  that bakes per-launcher rows). */
  torpedo: number;
  /** Chosen consumable families (subset of the hull's mountable set). */
  consumables: string[];
}

export interface Lineup {
  ally: LineupEntry[];
  enemy: LineupEntry[];
}

let _entrySeq = 0;

export function newEntryId(): string {
  _entrySeq += 1;
  return `lu-${Date.now().toString(36)}-${_entrySeq}`;
}

export function emptyLineup(): Lineup {
  return { ally: [], enemy: [] };
}

export function makeEntry(shipId: number, label = ""): LineupEntry {
  return { id: newEntryId(), shipId, label, torpedo: 0, consumables: [] };
}

// ── Persistence (per map, localStorage) ───────────────────────────────────

function lineupKey(spaceId: string): string {
  return `wowsp:tactics:lineup:v1:${spaceId}`;
}

function sanitizeEntry(raw: unknown): LineupEntry | null {
  if (typeof raw !== "object" || raw == null) return null;
  const e = raw as Partial<LineupEntry> & Record<string, unknown>;
  if (typeof e.shipId !== "number" || !Number.isFinite(e.shipId)) return null;
  return {
    id: typeof e.id === "string" && e.id ? e.id : newEntryId(),
    shipId: e.shipId,
    label: typeof e.label === "string" ? e.label : "",
    torpedo: typeof e.torpedo === "number" && e.torpedo >= 0 ? Math.floor(e.torpedo) : 0,
    consumables: Array.isArray(e.consumables)
      ? e.consumables.filter((c): c is string => typeof c === "string")
      : [],
  };
}

export function loadLineup(spaceId: string): Lineup {
  try {
    const raw = window.localStorage.getItem(lineupKey(spaceId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (typeof parsed === "object" && parsed != null) {
      const p = parsed as Partial<Lineup>;
      const ally = Array.isArray(p.ally) ? p.ally.map(sanitizeEntry).filter(Boolean) : [];
      const enemy = Array.isArray(p.enemy) ? p.enemy.map(sanitizeEntry).filter(Boolean) : [];
      return { ally, enemy } as Lineup;
    }
  } catch {
    // unreadable — fall through to empty
  }
  return emptyLineup();
}

export function saveLineup(spaceId: string, lineup: Lineup): void {
  try {
    window.localStorage.setItem(lineupKey(spaceId), JSON.stringify(lineup));
  } catch {
    // storage full/disabled — lineup stays for this session only
  }
}

/** Deep-copy one side over the other (the lineup editor's quick copy).
 *  New ids: the copies are independent hulls, not linked mirrors. */
export function copySide(lineup: Lineup, from: TeamSide, to: TeamSide): Lineup {
  const src = from === "ally" ? lineup.ally : lineup.enemy;
  const copy = src.map((e) => ({ ...e, id: newEntryId() }));
  return to === "ally" ? { ...lineup, ally: copy } : { ...lineup, enemy: copy };
}

// ── Resolved unit capability ──────────────────────────────────────────────

type KitEntry = { r?: number; h?: number; s?: number; radarM?: number; hydroM?: number };
const KIT = kitRaw as Record<string, KitEntry>;

/** What the board needs to know about one hull, resolved synchronously from
 *  the baked assets + the encyclopedia record the picker already had. */
export interface ResolvedUnit {
  entry: LineupEntry;
  ship: ShipInfo | null;
  /** Display name: explicit label or the ship's localized name. */
  name: string;
  /** Encyclopedia type code ("Destroyer" …) — feeds the kinematics class. */
  shipType: string;
  /** Top speed (kn) from the baked asset (fallback 30). */
  topSpeedKn: number;
  /** Torpedo reach in world units, or null when the hull has none. */
  torpRadiusUnits: number | null;
  /** Surface detectability radius in world units (null = unknown). */
  detectUnits: number | null;
  /** Mountable consumable families (slot order, deduped). */
  families: string[];
}

/** Families the author may toggle on for the hull (the editor's chips and
 *  the context menu's zone items). */
export const UTILITY_FAMILIES = ["rls", "sonar", "smoke"] as const;

/** Family codes as the baked assets spell them (GameParams ability keys). */
const FAMILY_MATCHERS: Record<(typeof UTILITY_FAMILIES)[number], (f: string) => boolean> = {
  rls: (f) => /rls|radar/i.test(f),
  sonar: (f) => /sonar|hydro/i.test(f),
  smoke: (f) => /smoke/i.test(f),
};

export function resolveUnit(entry: LineupEntry, byId: Map<number, ShipInfo>): ResolvedUnit {
  const ship = byId.get(entry.shipId) ?? null;
  const stats = shipLiveStats(entry.shipId);
  const families = stats?.load ? [...new Set(stats.load)] : [];
  const name = entry.label || ship?.name || `#${entry.shipId}`;
  return {
    entry,
    ship,
    name,
    shipType: ship?.type ?? "",
    topSpeedKn: stats?.spd ?? 30,
    torpRadiusUnits: stats?.torp ? (stats.torp * 1000) / 30 : null,
    detectUnits: stats?.det ? (stats.det * 1000) / 30 : null,
    families,
  };
}

/** Zone-relevant capability of one hull (zones.ts's stat source). */
export function zoneSourceOf(u: ResolvedUnit): ZoneStatSource {
  const kit = KIT[String(u.entry.shipId)];
  const chosen = new Set(u.entry.consumables);
  const has = (f: (typeof UTILITY_FAMILIES)[number]): boolean => {
    // An explicitly chosen loadout restricts; the unrestricted hull shows
    // everything it COULD mount (planning the matchup, not one player).
    if (chosen.size > 0) return [...chosen].some((c) => FAMILY_MATCHERS[f](c));
    return u.families.some((c) => FAMILY_MATCHERS[f](c)) || (f === "smoke" && !!kit?.s);
  };
  return {
    torpRadius: u.torpRadiusUnits ?? undefined,
    radarRadius: kit?.radarM != null ? kit.radarM / 30 : undefined,
    hydroRadius: kit?.hydroM != null ? kit.hydroM / 30 : undefined,
    smoke: has("smoke"),
  };
}

/** Torpedo options a hull offers. The baked asset carries one widest-range
 *  row today; per-launcher variants (8 km vs 20 km Shimakaze) arrive with a
 *  data refresh — the model already carries the index. */
export interface TorpedoOption {
  /** Range label ("20", "8" — km). */
  label: string;
  radiusUnits: number;
}

export function torpedoOptionsOf(u: ResolvedUnit): TorpedoOption[] {
  if (u.torpRadiusUnits == null) return [];
  const km = (u.torpRadiusUnits * 30) / 1000;
  const label = km >= 10 ? km.toFixed(0) : km.toFixed(1).replace(/\.0$/, "");
  return [{ label, radiusUnits: u.torpRadiusUnits }];
}

// ── Spawns & mirroring ────────────────────────────────────────────────────

/** Spawn poses for one side: a line across the middle 60% of the side's
 *  edge, bows toward the map centre (allies south, enemies north — the
 *  standard plan-frame orientation; flip later by dragging hulls). */
export function spawnPoses(
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  side: TeamSide,
  count: number,
): { at: Vec2; heading: number }[] {
  if (count <= 0) return [];
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxZ - bounds.minZ;
  const z = side === "ally" ? bounds.minZ + h * 0.09 : bounds.maxZ - h * 0.09;
  const heading = side === "ally" ? 0 : Math.PI;
  const out: { at: Vec2; heading: number }[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    out.push({
      at: { x: bounds.minX + w * (0.2 + 0.6 * t), z },
      heading,
    });
  }
  return out;
}

/** Mirror a world point through the map's CENTRE (both axes flip) — the
 *  fleets spawn on opposite edges, so the mate hull's symmetric position is
 *  the 180° rotation of the order, not an x-flip. */
export function mirrorPoint(
  p: Vec2,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
): Vec2 {
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midZ = (bounds.minZ + bounds.maxZ) / 2;
  return { x: 2 * midX - p.x, z: 2 * midZ - p.z };
}

/** Mirror a heading under the same point reflection: the bow swings 180°. */
export function mirrorHeading(heading: number): number {
  return wrapAngle(heading + Math.PI);
}

/** A unit the board operates on: the resolved hull plus its unique marker
 *  key (the label every keyframe of the unit carries — the board's marker
 *  chain identity) and its spawn pose. The host (PlanStage) derives these
 *  from the lineup + map bounds; the board never re-derives them. */
export interface PlanUnit {
  /** Unique marker key: the lineup label the unit's markers chain by. */
  key: string;
  side: TeamSide;
  unit: ResolvedUnit;
  spawn: { at: Vec2; heading: number };
  /** Marker key of the mirrored hull (auto-mirror), when one exists. */
  mateKey?: string;
}
