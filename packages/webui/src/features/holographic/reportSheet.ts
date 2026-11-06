/**
 * The report sheet's host-provided identity, metadata and roster faces — the
 * view model ReplayView resolves once per opened replay and hands down
 * through StaticReportModal (the panel itself never touches stores or the
 * network, so the exported DOM stays deterministic and testable).
 */
import type { DogTag } from "@/api";

/** One roster row's display metadata (the picker's ship-icon faces). */
export interface ReportRosterInfo {
  clanTag: string | null;
  /** WG ship type for BattleIcon ("" when the encyclopedia lacks the ship). */
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
  /** Localized official map name (null → the report's own space id). */
  mapName: string | null;
  /** Localized game-mode label. */
  modeLabel: string | null;
  /** Battle start ("YYYY-MM-DD HH:mm"), reparsed from the replay name. */
  battleStart: string | null;
  /** Full SHA-256 hex of the replay file; the sheet shows the tail. */
  replayHash: string | null;
}

/** The panel's whole host-provided sheet context. */
export interface ReportSheetView {
  identity: ReportSheetIdentity;
  meta: ReportSheetMeta;
  /** entityId → picker-face metadata (missing rows fall back to the dot). */
  roster: Map<number, ReportRosterInfo>;
}

/** Identity lookups outlive a perspective switch: the cache key must carry the
 *  cluster (a nickname can exist on two realms with different clans/emblems). */
export function identityCacheKey(realm: string, name: string): string {
  return realm + "\u0000" + name;
}

/** Latest-wins ticket gate for the async identity lookups. Every resolve
 *  takes a ticket BEFORE touching the cache: a cache HIT must also invalidate
 *  any in-flight lookup, or switching A -> (pending) B -> back to A lets B's
 *  late answer overwrite A's identity on the sheet (2026-11-06 review). */
export function createIdentityGate(): {
  next: () => number;
  isCurrent: (ticket: number) => boolean;
} {
  let seq = 0;
  return {
    next: () => ++seq,
    isCurrent: (ticket: number) => ticket === seq,
  };
}
