/** Mod Hub domain of the WoWSP API client: installed-unit scans and
 *  lifecycle ops, the online catalog and the stale-bin migration surface
 *  (composed into `api` by client.ts). */
import { transport } from "@/transport";
import { RPC } from "@/rpc";

// ── Mod Hub (mirrors `wowsp_tauri_shared`, see commands/mod_hub.rs) ────────

/** Plugin category from on-disk structure signatures (mod-formats.md). */
export type ModKind = "voice" | "skin" | "script" | "textures" | "gui" | "patch";

/** One extension bucket of a texture-override tree's content. */
export interface TextureFileKind {
  /** Lowercase extension, `.bak` suffix stripped (`dds`, `mfm`, …). */
  ext: string;
  count: number;
}

/** Structured breakdown of what a texture-override tree covers — every value
 *  is a language-neutral code the UI localizes (nations/species/categories). */
export interface TextureAnalysis {
  fileCount: number;
  fileKinds: TextureFileKind[];
  categories: string[];
  nations: string[];
  species: string[];
  /** Ship/component units parsed from file names (`JSB039 Yamato 1945`). */
  ships: string[];
  spaceNames: string[];
  truncated: boolean;
}

/** One classified plugin found installed under `res_mods/<version>/`. */
export interface InstalledMod {
  kind: ModKind;
  name: string;
  /** Scan-time notices — e.g. another skin overriding the same ship id. */
  warnings?: string[];
  /** PnF ship id / voice-over selector label, when the format carries one. */
  detail?: string | null;
  /** Structured content breakdown, `kind === "textures"` only. */
  textureAnalysis?: TextureAnalysis | null;
  /** Primary res_mods-relative path — the key the unit commands take.
   *  Manifest-only rows (no files matched on disk) key on the mod name. */
  relPath: string;
  /** Every root the unit spans (res_mods-relative, disjoint). */
  paths: string[];
  /** True when every file of the unit is renamed with a `.bak` suffix. */
  disabled: boolean;
  /** Version from Aslain's installed_mods.xml, when manifest-backed. */
  version?: string | null;
  /** Catalog entry id the unit paired against at scan time (name or
   *  Aslain-alias match against the online index) — drives the localized
   *  display name. Absent when nothing paired. */
  identity?: string | null;
}

/** One unit the purge could not reinstall. */
export interface PurgeSkip {
  name: string;
  reason: string;
}

/** Result of the "purge every mod, then reinstall only WoWSP-managed ones"
 *  reset (`mod_hub_purge_reinstall`). */
export interface PurgeReinstallReport {
  removedFiles: number;
  reinstalled: string[];
  /** Units copied back from the old tree and registered as WoWSP local
   *  installs (the adoption scope). */
  adopted: string[];
  skipped: PurgeSkip[];
  /** Where the previous tree now lives (nothing deleted before the caller
   *  holds this path). */
  backupPath?: string | null;
}

/** One catalog unit recorded in an unfinished purge's state marker
 *  (`wowsp-purge-state.json`) — the resume feeds the id (and its scheme)
 *  back through the verified reinstall path. */
export interface PurgePlanUnit {
  id: string;
  name: string;
  preset?: string | null;
}

/** The unfinished-purge state marker inside a backup dir: what the flow
 *  planned vs what already completed. Presence alone = the purge never
 *  finished (a completed flow removes the marker). */
export interface PurgeMarkerInfo {
  /** `wowsp-only` | `adopt-foreign`. */
  mode: string;
  planned: PurgePlanUnit[];
  done: PurgePlanUnit[];
  /** Local unit names the adoption pass re-registers on resume. */
  known?: string[];
  /** RFC3339 stamp of the moment the purge started. */
  startedAt: string;
}

/** One `res_mods.wowsp-purge-*` backup directory of the install's bin
 *  tree, newest first (`mod_hub_purge_backups`). */
export interface PurgeBackup {
  dirName: string;
  path: string;
  /** Unix seconds parsed from the directory name. */
  stamp: number;
  fileCount: number;
  /** The unfinished-purge marker exists — resolve (resume / mark done)
   *  before a new purge or a delete. */
  hasMarker: boolean;
  marker?: PurgeMarkerInfo | null;
}

/** Result of finishing an interrupted purge through the same verified
 *  reinstall path the purge used (`mod_hub_purge_backup_resume`). */
export interface PurgeResumeReport {
  /** Units the marker already carried as done before this resume. */
  resumedDone: number;
  reinstalled: string[];
  /** Units copied back from the backup and registered as WoWSP local
   *  installs (the adoption pass). */
  adopted: string[];
  skipped: PurgeSkip[];
  backupPath: string;
}

/** Result of folding a purge backup back into the live res_mods
 *  (keep-new: live copies always win; a conflict-free merge deletes the
 *  backup, a conflicted one keeps it whole). */
export interface PurgeBackupRestoreReport {
  mergedFiles: number;
  /** Live-owned conflicts plus bookkeeping/probe files (never transplanted). */
  skippedFiles: number;
  /** The live tree already owned these paths — the keep-the-backup signal. */
  conflictFiles: number;
  backupRemoved: boolean;
}

/** Result of toggling one installed plugin's `.bak` state. */
export interface UnitToggleReport {
  relPath: string;
  /** State after the toggle: true = files renamed to `.bak`. */
  disabled: boolean;
  renamedFiles: number;
}

/** One subtree copy in an install plan (package rel → res_mods rel). */
export interface PackagePlanEntry {
  fromRel: string;
  toRel: string;
}

/** Install plan for an unpacked plugin directory. */
export interface PackagePlan {
  kind: ModKind;
  name: string;
  detail?: string | null;
  entries: PackagePlanEntry[];
  warnings: string[];
  /** Structured breakdown of the override trees, when present. */
  textureAnalysis?: TextureAnalysis | null;
}

/** Result of applying a plan to a game install. */
export interface InstallReport {
  name: string;
  binVersion: string;
  wroteFiles: number;
  warnings: string[];
  /** Which other installed mods this install overwrote files of. */
  conflicts?: string[];
  /** Pre-release bin versions the files were mirrored into. */
  mirroredBins?: string[];
}

// ── Mod Hub online catalog (mirrors wowsp_tauri_shared, commands/mod_catalog.rs) ──

/** One downloadable package of a catalog entry (mod-hub release asset). */
export interface CatalogPackage {
  url: string;
  sha256: string;
  size: number;
  name: string;
}

/** Localized name + one-line description (from the wowsp:i18n thread block). */
export interface CatalogEntryI18n {
  name: string;
  description: string;
}

/** One named scheme of a catalog entry — e.g. a marker mod's color
 *  palette, or one variant of a folded style family (the six team
 *  panels, five traffic-light forms…). Installing with a preset id
 *  downloads its packages instead of the entry's default list. */
export interface CatalogPreset {
  id: string;
  nameZh: string;
  nameEn: string;
  packages: CatalogPackage[];
  /** This scheme's own preview screenshot (GitHub user-attachment URL):
   *  folded style families carry one per variant so the detail pane
   *  swaps images as the button group moves; absent when only the
   *  entry-level preview exists. */
  preview?: string | null;
  /** Scheme note (Chinese) — the variant's caveats (mutual exclusions,
   *  replay breakage…), rendered under the scheme buttons. */
  descZh?: string | null;
  /** Scheme note (English) — the non-zh fallback. */
  descEn?: string | null;
}

/** The latest version payload of one mod in `mod-index.json`. */
/** One clickable author tag: the credited name plus its official page. */
export interface CatalogAuthor {
  name: string;
  url: string;
}

export interface CatalogEntry {
  id: string;
  /** `battle | minimap | port | texts | skin | voice | ui`. */
  category: string;
  /** Discussions thread carrying the full post (source, hashes, feedback). */
  discussion?: number | null;
  version: string;
  /** Game-version range as published, e.g. `>=15.7 <15.8`. */
  game: string;
  /** Ships inside the WoWSP app — listed, not downloadable. */
  bundled?: boolean;
  /** Withdrawn from the catalog (its discussion thread was closed) —
   *  hidden from lists/search; deep links surface an unavailable notice. */
  delisted?: boolean;
  /** Named install-time schemes (palette, position, display mode…); the
   *  first one is the default and mirrors the plain package list. */
  presets?: CatalogPreset[];
  /** Registry tag ids (licensed, AI-generated, IP origins…). */
  tags?: string[];
  /** Server-applicability realm codes — a subset of the five canonical
   *  codes (`ru`/`eu`/`na`/`asia`/`cn`, see features/modhub/servers.ts).
   *  Absent/empty, or all five at once, means the entry is universal;
   *  otherwise it applies only on the listed servers. Absent on older
   *  indexes. */
  servers?: string[];
  title: string;
  nameZh: string;
  nameEn: string;
  description: string;
  /** Mod author tags, one per credited author (thread `authors:`
   *  front-matter resolved through the registry, attribution order). An
   *  author with an empty url renders without a link; an empty list
   *  renders no tag at all. */
  authors: CatalogAuthor[];
  packages: CatalogPackage[];
  /** Localized variants keyed by BCP-47 locale; empty for older posts. */
  i18n: Record<string, CatalogEntryI18n>;
  /** Foreign-installer names this entry answers to exactly (Aslain
   *  manifest row ids and on-disk directory names) — the pairing alias
   *  channel. Absent on older indexes. */
  aliases?: string[];
  /** First preview screenshot (GitHub user-attachment URL); absent when
   *  the discussion carries no image. */
  preview?: string | null;
  /** Folded style family: legacy one-entry-per-variant catalog ids →
   *  preset ids (e.g. `battle.panel.ttaro` → `ttaro`). Ledger pairing
   *  treats a record under a superseded id as this entry installed with
   *  that scheme, and install rewinds those records first — family
   *  styles are mutually exclusive variants of one HUD element. Absent
   *  on unfolded entries. */
  supersedes?: Record<string, string> | null;
}

/** Parsed `mod-index.json` — the online plugin list the hub page renders. */
export interface CatalogIndex {
  /** Upstream catalog stamp, e.g. `v.15.7.0 #10 (2026.08.30)`. */
  sourceVersion: string;
  gameVersion: string;
  fetchedAt: string;
  mods: CatalogEntry[];
}

/** Install book-keeping for one mod (`mods/installed.json`). */
export interface ModInstallRecord {
  id: string;
  name: string;
  version: string;
  category: string;
  /** `mod-hub` for catalog installs, `local` for folder installs. */
  source: string;
  discussion?: number | null;
  /** Install-time scheme the user picked (see CatalogPreset). */
  preset?: string | null;
  binVersion: string;
  installedAt: string;
  files: string[];
  restoreDir?: string | null;
  /** Game install this record belongs to (empty on legacy records). */
  gameRoot?: string;
}

/** One package's expected write map — the read-only classifier over an
 *  on-demand extraction (mirrors wowsp_tauri_shared::PackageFilePreview). */
export interface PackageFilePreview {
  name: string;
  size: number;
  /** res_mods-relative destinations (`@game/…` for game-root drops). */
  files: string[];
  warnings: string[];
}

/** Per-package write maps + the bin version the preview tree roots at
 *  (mirrors wowsp_tauri_shared::CatalogFilePreview). */
export interface CatalogFilePreview {
  binVersion: string;
  packages: PackageFilePreview[];
}

/** One localized tag definition from the mod-tags registry (mirrors
 *  `wowsp_tauri_shared::CatalogTag`). Tags decorate entries beyond their
 *  category: licensed / AI-generated feature markers, IP origins… */
export interface CatalogTag {
  id: string;
  /** `feature | ip | …` — drives badge styling. */
  kind: string;
  /** Display names keyed by BCP-47 locale. */
  i18n: Record<string, string>;
}

/** The registry (bundled + remotely refreshable). */
export interface CatalogTagIndex {
  schema: number;
  tags: CatalogTag[];
}

/** One foreign-installer unit (mirrors `wowsp_tauri_shared::ForeignModUnit`):
 *  a mod Aslain's modpack or WG's ModStation put on disk, with a best-effort
 *  catalog pairing. WoWSP describes these, never manages them. */
export interface ForeignModUnit {
  /** `aslain | modstation`. */
  installer: string;
  key: string;
  name: string;
  version?: string | null;
  /** Catalog id this unit pairs against, when a match existed. */
  identity?: string | null;
}

/** One previewable file under an installed unit (mirrors
 *  `wowsp_tauri_shared`-adjacent AssetFileInfo in commands/mod_hub/assets.rs). */
export interface AssetFileInfo {
  rel: string;
  size: number;
  /** `image | audio | model`. */
  kind: string;
  ext: string;
  /** False for `.wem` — listed, but the browser cannot play it. */
  playable: boolean;
  /** Wwise event this voice line answers to (from the pack's mod.xml) —
   *  the localized scenario-title key for audio rows. */
  sceneEvent?: string;
  /** State qualifier when the event assigns files per state. */
  sceneState?: string;
  /** 1-based variation index when an event slot lists several files. */
  sceneIndex?: number;
}

/** Browser-ready payload of one asset (a data URL). */
export interface AssetPayload {
  dataUrl: string;
}

/** One cached GLB part of a custom-model preview (mirrors
 *  ModelPreviewPart in commands/mod_hub/model_preview.rs). */
export interface ModelPreviewPart {
  /** res_mods-relative source path. */
  rel: string;
  /** Absolute path of the cached GLB — asset-protocol URL-able. */
  path: string;
  /** GLB size in bytes. */
  size: number;
}

/** ModAPI loader-marker health of the live res_mods (client.ts counterpart
 *  of wowsp_tauri_shared::PnfLoaderStatus). */
export interface PnfLoaderStatus {
  pnfModsPresent: boolean;
  markerPresent: boolean;
}

/** One loader verdict kind from profile/python.log's recent sessions
 *  (client.ts counterpart of the kind codes in
 *  commands/mod_hub/loader_health.rs). */
export type LoaderHealthKind =
  | "signatureRefused"
  | "frameworkDataMissing"
  | "disabledByDependency"
  | "loadedOk";

/** One mod's loader verdict from the tail of profile/python.log — why it
 *  did (or did not) load in the last session. */
export interface LoaderHealthVerdict {
  /** Mod name the log line carried; null for the shared-framework verdict
   *  (it affects every TTaro dependent, not one mod). */
  modName?: string | null;
  kind: LoaderHealthKind;
  /** Short cause line (the log shapes carry no secrets). */
  detail: string;
  /** Raw 'YYYY-MM-DD HH:MM:SS.mmm' stamp of the backing line. */
  at: string;
}

/** Loader/runtime mod health parsed from an install's profile/python.log
 *  tail (`mod_hub_loader_health`). */
export interface LoaderHealthReport {
  logPath: string;
  linesScanned: number;
  /** Newest stamp seen on any scanned line — the last session's moment. */
  lastSessionAt?: string | null;
  /** Errors first (signature refusals, the shared framework's missing
   *  data, dependency-disabled mods), then the loaded-OK rows. */
  verdicts: LoaderHealthVerdict[];
}

/** An older `bin/<version>/` whose `res_mods` still carries files —
 *  stranded by a game update, invisible to the hub's installed list. */
export interface StaleBinInfo {
  binVersion: string;
  /** Unit names the scanner recognizes in the stranded tree. */
  mods: string[];
  fileCount: number;
  /** The in-game stats plugin sits in this stranded tree (live or
   *  disabled): migrating the bin reinstalls it into the current one. */
  probeInstalled?: boolean;
}

/** Result of migrating a stranded old-version `res_mods` into the current
 *  one (keep-new: files the current tree already has stay untouched). */
export interface MigrateReport {
  fromVersion: string;
  toVersion: string;
  movedFiles: number;
  skippedFiles: number;
  /** Wizard runs only: files marked "leave alone" that stayed in the old
   *  bin. Absent (0) from one-click migrations and older payloads. */
  ignoredFiles?: number;
  /** The in-game stats plugin was found stranded and freshly reinstalled
   *  into the current bin (embedded bytes). Absent from older payloads. */
  probeReinstalled?: boolean;
}

/** One stale-tree file in a migration plan — res_mods-relative, forward
 *  slashes. `identity` is the display name when the backend resolved one
 *  (always absent today: the webui matches catalog ids / Aslain dir
 *  aliases itself, see features/modhub/migrateIdentity.ts). */
export interface PlanFile {
  path: string;
  size: number;
  identity?: string | null;
}

/** The migration wizard's pre-flight classification of one stale bin:
 *  duplicates (identical content already in the destination) and superseded
 *  files (same path, different content — the newer copy wins) are deleted;
 *  `decide` files are stale-only and follow the user's per-file choice. */
export interface MigrationPlan {
  fromVersion: string;
  toVersion: string;
  duplicate: PlanFile[];
  superseded: PlanFile[];
  decide: PlanFile[];
}

/** What a ledger reconciliation cleaned up (ghost records, orphan
 *  snapshot dirs) and how many junk record names it re-resolved. */
export interface ReconcileReport {
  droppedRecords: number;
  removedRestoreDirs: number;
  healedNames: number;
}

/** Result of uninstalling a catalog mod. */
export interface UninstallReport {
  id: string;
  name: string;
  removedFiles: number;
  restoredFiles: number;
}

/** Mod-install progress, the store-side projection of a
 *  `DownloadProgress` tick with `kind: "mod-package"` (the package
 *  counters come from the event's `detail`). */
export interface CatalogProgress {
  id: string;
  /** `download | installing | done`. */
  phase: string;
  package: number;
  packages: number;
  received: number;
  total: number;
}

export const modHubApi = {
  modHubScanInstalled: (gameRoot: string) =>
    transport.invoke<InstalledMod[]>(RPC.mod_hub_scan_installed, { gameRoot }),
  modHubForeignUnits: (gameRoot: string) =>
    transport.invoke<ForeignModUnit[]>(RPC.mod_hub_foreign_units, { gameRoot }),
  modHubListAssets: (gameRoot: string, relPath: string) =>
    transport.invoke<AssetFileInfo[]>(RPC.mod_hub_list_assets, { gameRoot, relPath }),
  modHubReadAsset: (gameRoot: string, relPath: string) =>
    transport.invoke<AssetPayload>(RPC.mod_hub_read_asset, { gameRoot, relPath }),
  /** Custom-model 3D preview: expand a `.geometry` click into its family's
   *  cached GLB parts (hull base + sections, or a standalone mesh). */
  modHubReadModel: (gameRoot: string, relPath: string) =>
    transport.invoke<ModelPreviewPart[]>(RPC.mod_hub_read_model, { gameRoot, relPath }),
  modHubClassifyPath: (sourcePath: string) =>
    transport.invoke<PackagePlan>(RPC.mod_hub_classify_path, { sourcePath }),
  /** Native folder picker for the local-package source (audit H-3): the
   *  picked path is the only install source the backend accepts. */
  modHubPickSource: () => transport.invoke<string | null>(RPC.mod_hub_pick_source),
  modHubInstall: (sourceRoot: string, gameRoot: string) =>
    transport.invoke<InstallReport>(RPC.mod_hub_install, { sourceRoot, gameRoot }),
  /** Toggle one installed plugin's temporary disable state: disabling
   *  renames every file with a `.bak` suffix, enabling strips it again. */
  modHubSetUnitEnabled: (relPath: string, gameRoot: string, enabled: boolean) =>
    transport.invoke<UnitToggleReport>(RPC.mod_hub_set_unit_enabled, {
      relPath,
      gameRoot,
      enabled,
    }),
  /** Uninstall one installed plugin unit (deletes its files, restores
   *  snapshotted originals, syncs the Aslain manifest when relevant). */
  modHubUninstallUnit: (relPath: string, gameRoot: string) =>
    transport.invoke<UninstallReport>(RPC.mod_hub_uninstall_unit, { relPath, gameRoot }),
  /** Uninstall a ModStation unit by manifest key — removes its whole tree
   *  under bin/<version>/mods/ (outside res_mods, invisible to unit ops). */
  modHubUninstallModstationUnit: (gameRoot: string, key: string) =>
    transport.invoke<null>(RPC.mod_hub_uninstall_modstation_unit, { gameRoot, key }),
  /** Older `bin/<version>` dirs whose res_mods still carries stranded mods. */
  modHubStaleVersions: (gameRoot: string) =>
    transport.invoke<StaleBinInfo[]>(RPC.mod_hub_stale_versions, { gameRoot }),
  /** ModAPI loader-marker health: PnF content with a missing
   *  PnFModsLoader.py marker loads nothing in game. */
  modHubPnfLoaderStatus: (gameRoot: string) =>
    transport.invoke<PnfLoaderStatus>(RPC.mod_hub_pnf_loader_status, { gameRoot }),
  /** Loader/runtime mod health from the tail of profile/python.log —
   *  signature refusals, the shared TTaro framework's missing data,
   *  dependency-disabled mods and the quiet loaded-OK rows. */
  modHubLoaderHealth: (gameRoot: string) =>
    transport.invoke<LoaderHealthReport>(RPC.mod_hub_loader_health, { gameRoot }),
  /** Write the missing PnFModsLoader.py marker back (gated). */
  modHubRestorePnfLoaderMarker: (gameRoot: string) =>
    transport.invoke<boolean>(RPC.mod_hub_restore_pnf_loader_marker, { gameRoot }),
  /** Move a stranded old-version res_mods into the current one (keep-new). */
  modHubMigrateStaleBin: (gameRoot: string, fromVersion: string) =>
    transport.invoke<MigrateReport>(RPC.mod_hub_migrate_stale_bin, {
      gameRoot,
      fromVersion,
    }),
  /** Migration wizard step 1: classify the stale tree into duplicate /
   *  superseded / decide buckets (read-only). */
  modHubMigrationPlan: (gameRoot: string, fromVersion: string) =>
    transport.invoke<MigrationPlan>(RPC.mod_hub_migration_plan, {
      gameRoot,
      fromVersion,
    }),
  /** Migration wizard step 2: apply the reviewed plan — `keep` lists the
   *  decide paths to carry over, `ignore` the ones to leave untouched in
   *  the stale bin, everything else is cleaned up. */
  modHubMigrationExecute: (
    gameRoot: string,
    fromVersion: string,
    keep: string[],
    ignore: string[],
  ) =>
    transport.invoke<MigrateReport>(RPC.mod_hub_migration_execute, {
      gameRoot,
      fromVersion,
      keep,
      ignore,
    }),
  /** Is safe mode visible (current res_mods quarantined, or a stranded
   *  twin in an old version dir)? */
  modHubSafeMode: (gameRoot: string) =>
    transport.invoke<boolean>(RPC.mod_hub_safe_mode, { gameRoot }),
  /** Quarantine (or restore) the current res_mods in one atomic rename. */
  modHubSetSafeMode: (gameRoot: string, enabled: boolean) =>
    transport.invoke<boolean>(RPC.mod_hub_set_safe_mode, { gameRoot, enabled }),
  /** Move EVERY mod out of the load path, then reinstall only the units
   *  WoWSP's own ledger records (the "all mods must come from WoWSP" reset). */
  modHubPurgeReinstall: (
    gameRoot: string,
    mode: "wowsp-only" | "adopt-foreign",
  ) =>
    transport.invoke<PurgeReinstallReport>(RPC.mod_hub_purge_reinstall, {
      gameRoot,
      mode,
    }),
  /** Every purge-backup directory under the install's bin tree, newest
   *  first; `hasMarker` marks a purge that never finished. */
  modHubPurgeBackups: (gameRoot: string) =>
    transport.invoke<PurgeBackup[]>(RPC.mod_hub_purge_backups, { gameRoot }),
  /** Permanently delete a COMPLETED purge backup (refuses while the
   *  unfinished marker is still there). */
  modHubPurgeBackupDelete: (gameRoot: string, dirName: string) =>
    transport.invoke<null>(RPC.mod_hub_purge_backup_delete, { gameRoot, dirName }),
  /** Drop ONLY the unfinished marker — the backup becomes a plain
   *  completed snapshot (files kept). */
  modHubPurgeBackupDismiss: (gameRoot: string, dirName: string) =>
    transport.invoke<null>(RPC.mod_hub_purge_backup_dismiss, { gameRoot, dirName }),
  /** Fold the backup's files back into live res_mods (keep-new: live
   *  copies win; a conflict-free merge deletes the backup). */
  modHubPurgeBackupRestore: (gameRoot: string, dirName: string) =>
    transport.invoke<PurgeBackupRestoreReport>(RPC.mod_hub_purge_backup_restore, {
      gameRoot,
      dirName,
    }),
  /** Finish an interrupted purge: the remaining planned units through
   *  the verified reinstall path, then the adoption pass. */
  modHubPurgeBackupResume: (gameRoot: string, dirName: string) =>
    transport.invoke<PurgeResumeReport>(RPC.mod_hub_purge_backup_resume, {
      gameRoot,
      dirName,
    }),
  /** Drop ghost ledger records and collect orphaned snapshot dirs. */
  modHubReconcile: (gameRoot: string) =>
    transport.invoke<ReconcileReport>(RPC.mod_hub_reconcile, { gameRoot }),
  // ── Mod Hub online catalog ──
  /** Fetch (or serve cached) `mod-index.json` from the mod-hub release. */
  modTags: () => transport.invoke<CatalogTagIndex>(RPC.mod_tags),
  modCatalogRefresh: (force: boolean) =>
    transport.invoke<CatalogIndex>(RPC.mod_catalog_refresh, { force }),
  modCatalogInstall: (modId: string, gameRoot: string, preset?: string) =>
    transport.invoke<InstallReport>(RPC.mod_catalog_install, {
      modId,
      gameRoot,
      preset: preset ?? null,
    }),
  /** Read-only file preview: downloads the packages to a temp dir and
   *  classifies them there, never touching res_mods. */
  modCatalogPreviewFiles: (modId: string, gameRoot: string, preset?: string) =>
    transport.invoke<CatalogFilePreview>(RPC.mod_catalog_preview_files, {
      modId,
      gameRoot,
      preset: preset ?? null,
    }),
  /** Open a unit's folder (`bin/<version>/res_mods[/rel]`) in the OS file
   *  manager; an empty binVersion resolves to the client's current one. */
  modHubRevealPath: (gameRoot: string, binVersion: string, relPath?: string) =>
    transport.invoke<null>(RPC.mod_hub_reveal_path, {
      gameRoot,
      binVersion: binVersion || null,
      relPath: relPath || null,
    }),
  modCatalogUninstall: (modId: string, gameRoot: string) =>
    transport.invoke<UninstallReport>(RPC.mod_catalog_uninstall, { modId, gameRoot }),
  modHubRecords: () => transport.invoke<ModInstallRecord[]>(RPC.mod_hub_records),
};
