/**
 * The report sheet's host-provided identity, metadata and roster faces — the
 * view model ReplayView resolves once per opened replay and hands down
 * through StaticReportModal (the panel itself never touches stores or the
 * network, so the exported DOM stays deterministic and testable).
 */
import type { DogTag, ShipInfo, StaticReport } from "@/api";

/** One roster row's display metadata (the picker's ship-icon faces and the
 *  identity head's emblem). */
export interface ReportRosterInfo {
  clanTag: string | null;
  /** The player's in-game emblem off the same roster batch. */
  dogTag: DogTag | null;
  /** WG ship type for BattleIcon (null when no ship source knows the hull). */
  shipType: string | null;
  shipName: string | null;
  tier: number | null;
}

/** Who the report reads (the identity block / picker trigger). */
export interface ReportSheetIdentity {
  name: string;
  clanTag: string | null;
  /** The in-game emblem; null renders the fallback plate. */
  dogTag: DogTag | null;
  shipType: string | null;
  shipName: string | null;
  tier: number | null;
}

/** Which battle the report reads (the head's top-right meta line). */
export interface ReportSheetMeta {
  /** Game-asset language for MapNameTag (the replay header's own map chip). */
  mapLang: string | null;
  /** Localized game-mode label. */
  modeLabel: string | null;
  /** Mode chip ink (AppTag `color`), the replay header's source. */
  modeColor: string | null;
  /** Battle start ("YYYY-MM-DD HH:mm"), reparsed from the replay name. */
  battleStart: string | null;
  /** Full SHA-256 hex of the replay file; the sheet shows the tail. */
  replayHash: string | null;
}

/** The panel's whole host-provided sheet context. */
export interface ReportSheetView {
  identity: ReportSheetIdentity;
  meta: ReportSheetMeta;
  /** entityId → picker-face metadata (missing rows render the neutral ship
   *  placeholder — the picker never falls back to a team dot). */
  roster: Map<number, ReportRosterInfo>;
}

/** The stats-batch facts a picker row reads off the battle's roster answer:
 *  the clan tag beside the nickname and the in-game emblem. Structurally
 *  satisfied by `useRosterStats`' RosterStat — declared locally so this
 *  store-free module never imports the stats composable. */
export interface ReportRosterStatFace {
  clanTag?: string | null;
  dogTag?: DogTag | null;
}

/**
 * The host-side lookups {@link buildReportRosterFaces} joins against.
 *
 * Callbacks, not stores: ReplayView binds them to the encyclopedia (async,
 * realm-scoped), the baked/runtime ship DB and the battle's stats batch,
 * while the join itself stays a plain function reportSheet.test.ts can drive
 * with fixtures — including the descriptor-roster-id fixture that pins the
 * 2026-11-07 picker bug (see the builder below).
 */
export interface ReportRosterFaceResolver {
  /** The encyclopedia's record for a ship id; null/undefined while that
   *  realm's list is still loading (the whole point of the fallbacks below). */
  shipOf: (shipId: number) => ShipInfo | null | undefined;
  /** Localized display name for a resolved record
   *  (encyclopedia.shipDisplayName — strips event-ship brackets). */
  shipDisplayName: (ship: ShipInfo) => string;
  /** Baked/runtime ship-class fallback (utils/shipClass.shipTypeOf). */
  shipTypeOf: (shipId: number) => string;
  /** Baked/runtime tier fallback (utils/shipClass.shipTierOf). */
  shipTierOf: (shipId: number) => number | null;
  /** Baked/runtime localized-name fallback (utils/shipClass.shipNameOf). */
  shipNameOf: (shipId: number, language: string) => string;
  /** Game-asset language the baked-DB name fallback resolves against. */
  language: string;
  /** The battle's stats-batch answer for one PLAYER nickname. */
  statOf: (playerName: string) => ReportRosterStatFace | null | undefined;
}

/**
 * entityId → picker-face metadata for ONE static report, keyed by the
 * report's OWN roster ids.
 *
 * The key space IS the bug this helper exists for: the picker and panel look
 * rows up by `report.roster[].entityId` (BigWorld stream entity ids), while
 * the replay descriptor's `vehicles[].id`s are arena/account ids in a ~5.3e8
 * number space — a real replay's two sets never intersect, so the old join
 * (built off the parser's vehicle list) missed every row and the picker drew
 * its team-dot fallback on all of them (2026-11-07 report). The static report
 * already carries entityId + shipId + playerName per row, so the join is
 * rebuilt from IT and no descriptor data is consulted at all.
 *
 * Ship facts prefer the encyclopedia (localized, event-ship aware) and fall
 * through to the baked/runtime DB when the realm list has not loaded yet, so
 * a row degrades to its last-known class/tier/name instead of blanking. Clan
 * tag is joined on the PLAYER nickname (`playerName`; `name` is the
 * ship-name-preferred display name), and a ship no source knows stays null
 * for the picker's neutral dash — never a team marker.
 */
export function buildReportRosterFaces(
  report: Pick<StaticReport, "roster"> | null | undefined,
  resolver: ReportRosterFaceResolver,
): Map<number, ReportRosterInfo> {
  const faces = new Map<number, ReportRosterInfo>();
  for (const row of report?.roster ?? []) {
    const stat = resolver.statOf(row.playerName ?? row.name ?? "") ?? null;
    const shipId = row.shipId;
    const ship = shipId != null ? resolver.shipOf(shipId) : undefined;
    const shipType =
      ship?.type || (shipId != null ? resolver.shipTypeOf(shipId) : "");
    const shipName =
      (ship ? resolver.shipDisplayName(ship) : "") ||
      (shipId != null ? resolver.shipNameOf(shipId, resolver.language) : "");
    // `||` (not `??`) so a zero/empty encyclopedia field still reaches the
    // baked-DB answer — the picker treats both as "not known".
    const tier =
      ship?.tier || (shipId != null ? resolver.shipTierOf(shipId) : null);
    faces.set(row.entityId, {
      clanTag: stat?.clanTag ?? null,
      dogTag: stat?.dogTag ?? null,
      shipType: shipType || null,
      shipName: shipName || null,
      tier: tier || null,
    });
  }
  return faces;
}
