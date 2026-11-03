/** Mod-integrity domain (commands/mod_integrity.rs): the ONE static
 *  "would this mod tree break the game UI?" scanner shared by the catalog
 *  installer, the crash analyzer and the pre-launch scan. The webui
 *  surface is the on-demand mod_integrity_scan command plus the
 *  wowsp://mod-conflict push (the backend's watchdog report at game
 *  start). Composed into the "api" object by client.ts. */
import { transport } from "@/transport";
import { RPC } from "@/rpc";

/** Mirrors commands::mod_integrity::ModIntegrityProblem — one integrity
 *  finding. Field names are the wire contract (the backend serializes
 *  this struct snake_case verbatim) — do not rename or camelCase them. */
export interface ModIntegrityProblem {
  /** "dangling_ref" — glue references an asset present in neither the
   *  scanned trees nor the client index; "invalid_swf" — a .swf whose
   *  leading bytes are not a legal SWF signature; "overlap" — one load
   *  claim made by 2+ different files (advisory). */
  kind: "dangling_ref" | "invalid_swf" | "overlap";
  /** The offending asset basename ("battle_stats.swf") — dangling_ref
   *  and overlap. */
  asset: string | null;
  /** The offending file, tree-relative ("gui/broken.swf") — invalid_swf. */
  path: string | null;
  /** Tree-relative paths of the files referencing/claiming the asset. */
  files: string[];
  /** True when the finding's own files sit in the caller's first tree —
   *  the catalog install gate's staged package (single-tree scans mark
   *  everything). The install gate blocks only on staged findings; an
   *  existing-tree finding pre-dates the package and is advisory. */
  staged: boolean;
}

/** Mirrors commands::mod_integrity::ModIntegrityReport — one bounded scan
 *  over an install's mod trees (the mod_integrity_scan reply and the
 *  wowsp://mod-conflict payload). */
export interface ModIntegrityReport {
  /** The game root the scan ran for (empty when the caller had none). */
  game_root: string;
  /** Regular files the walk actually processed (toolchain stubs
   *  excluded). */
  scanned_files: number;
  /** Findings, ordered dangling_ref → invalid_swf → overlap. */
  problems: ModIntegrityProblem[];
}

/** The backend's conflict push (commands/mod_integrity.rs): one
 *  ModIntegrityReport when the watchdog detects the game starting over a
 *  mod tree with findings — emitted only when problems exist, deduped
 *  once per boot per game root. */
export const MOD_CONFLICT_EVENT = "wowsp://mod-conflict";

export const modIntegrityApi = {
  /** Conflict push: the report the backend scanned up at game start. */
  listenModConflict: (handler: (report: ModIntegrityReport) => void) =>
    transport.listen?.<ModIntegrityReport>(MOD_CONFLICT_EVENT, handler),
  /** The on-demand pre-launch scan over the given install's mod trees
   *  (heavy IO backend-side; hard-capped, so it resolves in one pass). */
  modIntegrityScan: (gameRoot: string) =>
    transport.invoke<ModIntegrityReport>(RPC.mod_integrity_scan, { gameRoot }),
};
