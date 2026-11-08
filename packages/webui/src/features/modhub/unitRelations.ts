/** Known-mod associations of one installed unit — who else claims files
 *  inside a res_mods unit's tree. Mods are not isolated directories: a
 *  catch-all tree (`content/`, `gui/`) collects files from several
 *  packs, and the shared runtime components (TTaroModUtils, ModForge,
 *  ModsInstaller, the ttaro GUI trees, the gettext DLL…) are written by
 *  every dependent pack — the ledger keeps their files in one `shared.*`
 *  record and each pack declares a `sharedRoots` edge. The installed
 *  list's count tag and the detail pane's related-mod section read this
 *  pure derivation, so the two surfaces can never disagree.
 *
 *  Vocabulary of one relation row (see UnitRelation):
 *  - `own`        — the unit's own mod: the paired ledger record (an
 *    identity match including a folded style family's superseded legacy
 *    ids), a record name match, or the shared component record owning
 *    the unit's tree.
 *  - `shared`     — a per-component `shared.*` ledger record. It is never
 *    directly removable: it leaves with its last consumer.
 *  - `dependency` — a pack record associated only through its
 *    `sharedRoots` edge into a component this unit covers.
 *  - `removable`  — users can cut the mod from here: every non-shared
 *    ledger row (the catalog uninstall removes its files everywhere) and
 *    every foreign / unpaired-catalog row (through the owning unit's
 *    uninstall, hence `ownerRelPath`).
 *
 *  Paths compare the way the ledger and the snapshot layers compare them
 *  (see the app-side `uninstall_path_key`): lowercase, forward slashes,
 *  the `.bak` toggle suffix stripped. A directory root matches by prefix,
 *  a single-file root by exact name; `@game/` drops never land inside a
 *  res_mods unit. Records stamped for another game root are ignored (the
 *  ledger is global; empty stamps are legacy records that match any root).
 *  Pure and Vue-free, like the other features/modhub modules. */
import type { CatalogEntry, ForeignModUnit, InstalledMod, ModInstallRecord } from "@/api";

import { sameGamePath } from "@/utils/gamePath";

/** Where one associated known mod comes from: a ledger record, a foreign
 *  installer's manifest row, or the catalog identity pairing alone (no
 *  record, no foreign row — the copy is on disk but unknown to both). */
export type UnitRelationKind = "record" | "foreign" | "catalog";

/** One known mod associated with an installed unit. */
export interface UnitRelation {
  /** Stable row key (`record:<id>` / `foreign:<installer>:<key>` /
   *  `catalog:<id>`). */
  key: string;
  kind: UnitRelationKind;
  name: string;
  version?: string;
  /** Ledger record id (record rows; the catalog uninstall key). */
  recordId?: string;
  /** Catalog entry id this row pairs against, canonicalized through a
   *  folded family's supersedes map when resolvable. */
  catalogId?: string;
  /** `mod-hub` | `local` | `shared` | `aslain` | `catalog` — the
   *  detail row's source tag vocabulary. */
  source: string;
  /** The unit's own mod (see the module header). */
  own: boolean;
  /** A per-component `shared.*` ledger record (not directly removable). */
  shared: boolean;
  /** Associated through a `sharedRoots` dependency edge only. */
  dependency: boolean;
  /** Files the mod claims INSIDE this unit (0 for dependency/foreign/
   *  catalog rows: their own file list lives elsewhere). */
  files: number;
  /** Every file the mod's ledger row claims (game-root drops included). */
  totalFiles: number;
  /** Can be removed from this unit's related list (see the header). */
  removable: boolean;
  /** Res_mods-relative path of the unit whose uninstall covers a foreign /
   *  catalog row (absent on record rows). */
  ownerRelPath?: string;
}

/** Normalized path identity: lowercase, forward slashes, no trailing
 *  separator, the `.bak` toggle suffix stripped — the app-side
 *  `uninstall_path_key` spelling. */
export function relationPathKey(path: string | null | undefined): string {
  let key = (path ?? "").trim().replace(/\\/g, "/").toLowerCase();
  while (key.startsWith("./")) key = key.slice(2);
  while (key.endsWith("/")) key = key.slice(0, -1);
  if (key.endsWith(".bak")) key = key.slice(0, -4);
  return key;
}

/** Ledger ids/paths compare case-insensitively. */
function normId(id: string | null | undefined): string {
  return (id ?? "").trim().toLowerCase();
}

/** The roots a unit spans, normalized and non-empty. Manifest-only rows
 *  (no files matched on disk) carry no roots and therefore claim nothing;
 *  they can still pair with a catalog identity row. */
function unitRootKeys(unit: InstalledMod): string[] {
  const keys = new Set<string>();
  for (const root of unit.paths ?? []) {
    const key = relationPathKey(root);
    if (key) keys.add(key);
  }
  return [...keys];
}

/** Does a normalized file path sit under any normalized root? Directory
 *  roots match by prefix, file roots by exact name; `@game/` drops are
 *  outside res_mods and never land inside a unit. */
function landsUnder(fileKey: string, roots: readonly string[]): boolean {
  if (!fileKey || fileKey.startsWith("@game/")) return false;
  return roots.some((root) => fileKey === root || fileKey.startsWith(`${root}/`));
}

/** Does a component file match one `sharedRoots` registry spelling? Tree
 *  roots keep their trailing slash in the registry and match on a path
 *  boundary; slash-less roots are single-file / family prefixes (the
 *  gettext DLL, the unbound fragments) and match as raw prefixes — the
 *  same split the app-side `shared_component_root` applies. */
function sharedRootMatches(rawRoot: string, fileKey: string): boolean {
  const root = relationPathKey(rawRoot);
  if (!root) return false;
  const spelling = (rawRoot ?? "").trim().replace(/\\/g, "/");
  return spelling.endsWith("/")
    ? fileKey === root || fileKey.startsWith(`${root}/`)
    : fileKey.startsWith(root);
}

/** Is the record's game stamp this root's? The ledger is global: a record
 *  stamped for another install describes another tree, while an empty
 *  stamp is a legacy record that matches any root. */
function recordOnRoot(record: ModInstallRecord, gameRoot: string): boolean {
  return !record.gameRoot || sameGamePath(record.gameRoot, gameRoot);
}

/** The catalog entry an identity names — exact id first, then a folded
 *  style family's legacy one-entry-per-variant id. */
function entryOfIdentity(identity: string, catalog: readonly CatalogEntry[]): CatalogEntry | undefined {
  const key = normId(identity);
  if (!key) return undefined;
  return (
    catalog.find((entry) => normId(entry.id) === key) ??
    catalog.find((entry) =>
      Object.keys(entry.supersedes ?? {}).some((legacy) => normId(legacy) === key),
    )
  );
}

/** Every catalog id an identity can answer to: the entry's own id plus its
 *  superseded legacy ids (a record under `battle.panel.ttaro` backs
 *  `battle.panel`). */
function identityFamily(identity: string, catalog: readonly CatalogEntry[]): Set<string> {
  const ids = new Set<string>();
  const add = (id: string | null | undefined) => {
    const key = normId(id);
    if (key) ids.add(key);
  };
  add(identity);
  const entry = entryOfIdentity(identity, catalog);
  if (entry) {
    add(entry.id);
    for (const legacy of Object.keys(entry.supersedes ?? {})) add(legacy);
  }
  return ids;
}

/** The canonical catalog id a ledger record backs (exact id, else the
 *  folded family whose supersedes map names it). */
function catalogIdOfRecord(
  record: ModInstallRecord,
  catalog: readonly CatalogEntry[],
): string | undefined {
  return entryOfIdentity(record.id, catalog)?.id;
}

/** Does this record back a catalog id (exact, or as a superseded legacy
 *  variant of it)? */
function recordBacksIdentity(
  recordId: string | null | undefined,
  identity: string,
  catalog: readonly CatalogEntry[],
): boolean {
  const family = identityFamily(identity, catalog);
  return family.has(normId(recordId));
}

/** One ledger record with its path spellings normalized ONCE per scan:
 *  units all compare against the same normalized lists, so an Aslain-sized
 *  tree (tens of thousands of recorded files) is walked without
 *  re-normalizing every record for every unit. */
interface PreparedRecord {
  record: ModInstallRecord;
  /** Normalized `files` entries (see `relationPathKey`). */
  files: string[];
}

/** Records of THIS game root, path-normalized once. */
function prepareRecords(
  records: readonly ModInstallRecord[],
  gameRoot: string,
): PreparedRecord[] {
  return records
    .filter((record) => recordOnRoot(record, gameRoot))
    .map((record) => ({
      record,
      files: (record.files ?? []).map((file) => relationPathKey(file)),
    }));
}

/** One associated ledger record plus how many of its files land in the
 *  unit. */
interface MatchedRecord {
  record: ModInstallRecord;
  files: number;
}

/** One unit's rows: every associated ledger record, the shared components'
 *  consumer packs, the Aslain rows that pair to the unit and — when the
 *  unit paired with a catalog identity nobody claims — one catalog row. */
function unitRelationsOf(
  unit: InstalledMod,
  prepared: readonly PreparedRecord[],
  foreign: readonly ForeignModUnit[],
  catalog: readonly CatalogEntry[],
): UnitRelation[] {
  const roots = unitRootKeys(unit);
  // The unit's catalog identity family: its own identity (with a folded
  // family's superseded legacy ids) UNION the identities of the Aslain
  // rows anchored to it by name — the same pairing rule the view's
  // pairedEntryOf applies, so a ledger record under that identity still
  // counts as the unit's own.
  const family = identityFamily(unit.identity ?? "", catalog);
  for (const row of foreign) {
    if (row.installer !== "aslain" || !row.identity) continue;
    if (!unit.name || normId(row.name) !== normId(unit.name)) continue;
    for (const id of identityFamily(row.identity, catalog)) family.add(id);
  }
  const matched = new Map<string, MatchedRecord>();
  for (const { record, files: normalized } of prepared) {
    const id = record.id ?? "";
    if (matched.has(id)) continue; // an anomalous duplicate id is one install
    let files = 0;
    for (const fileKey of normalized) {
      if (landsUnder(fileKey, roots)) files++;
    }
    if (files > 0) matched.set(id, { record, files });
  }

  // The unit's own ledger row: the identity family first (a folded family
  // record under a legacy id counts), then a plain name match. The shared
  // fallback below marks the component record that owns a pure runtime
  // unit's tree.
  let ownRecordId = "";
  for (const { record } of matched.values()) {
    if (family.has(normId(record.id))) {
      ownRecordId = record.id ?? "";
      break;
    }
  }
  if (!ownRecordId) {
    for (const { record } of matched.values()) {
      if (unit.name && normId(record.name) === normId(unit.name)) {
        ownRecordId = record.id ?? "";
        break;
      }
    }
  }

  const rows: UnitRelation[] = [];
  for (const { record, files } of matched.values()) {
    const shared = (record.id ?? "").startsWith("shared.");
    rows.push({
      key: `record:${record.id}`,
      kind: "record",
      name: record.name || record.id || "",
      version: record.version || undefined,
      recordId: record.id,
      catalogId: shared ? undefined : catalogIdOfRecord(record, catalog),
      source: shared ? "shared" : record.source || "local",
      own: record.id === ownRecordId,
      shared,
      dependency: false,
      files,
      totalFiles: (record.files ?? []).length,
      removable: !shared,
    });
  }

  // A pure shared-runtime unit (the TTaroModUtils tree listed as its own
  // unit) has no pack record of its own — the component record owning the
  // tree IS the unit's own mod. Only a SINGLE component record qualifies: a
  // catch-all tree carrying a whole family (the texts/<locale>/*.mo
  // catalogs) belongs to several components, so none of them is "the"
  // unit's own mod.
  if (!rows.some((row) => row.own)) {
    const sharedRows = rows.filter((row) => row.shared);
    if (sharedRows.length === 1) sharedRows[0].own = true;
  }

  // Shared-component consumers: the pack records that depend on a
  // component this unit covers through the `sharedRoots` edge, even when
  // none of their own files sit in this unit.
  const sharedFiles: string[] = [];
  const preparedById = new Map(prepared.map((entry) => [entry.record.id ?? "", entry]));
  for (const row of rows) {
    if (!row.shared || !row.recordId) continue;
    for (const fileKey of preparedById.get(row.recordId)?.files ?? []) {
      if (landsUnder(fileKey, roots)) sharedFiles.push(fileKey);
    }
  }
  if (sharedFiles.length > 0) {
    for (const { record } of prepared) {
      if ((record.id ?? "").startsWith("shared.")) continue;
      const depends = (record.sharedRoots ?? []).some((rawRoot) =>
        sharedFiles.some((file) => sharedRootMatches(rawRoot, file)),
      );
      if (!depends) continue;
      const existing = rows.find((row) => row.recordId === record.id);
      if (existing) {
        if (!existing.own) existing.dependency = true;
        continue;
      }
      rows.push({
        key: `record:${record.id}`,
        kind: "record",
        name: record.name || record.id || "",
        version: record.version || undefined,
        recordId: record.id,
        catalogId: catalogIdOfRecord(record, catalog),
        source: record.source || "local",
        own: false,
        shared: false,
        dependency: true,
        files: 0,
        totalFiles: (record.files ?? []).length,
        removable: true,
      });
    }
  }

  // Aslain's manifest rows anchor into the installed list by name/identity
  // (the res_mods scan already lists their files). A row whose identity a
  // ledger record already backs is the SAME install after the registration
  // hand-off — it must not double-list.
  for (const row of foreign) {
    if (row.installer !== "aslain") continue;
    const nameHit = !!unit.name && normId(row.name) === normId(unit.name);
    const identityHit = !!row.identity && family.has(normId(row.identity));
    if (!nameHit && !identityHit) continue;
    const catalogId = row.identity ? entryOfIdentity(row.identity, catalog)?.id ?? row.identity : undefined;
    if (
      catalogId &&
      rows.some(
        (rel) => rel.recordId && recordBacksIdentity(rel.recordId, catalogId, catalog),
      )
    ) {
      continue;
    }
    rows.push({
      key: `foreign:${row.installer}:${row.key}`,
      kind: "foreign",
      name: row.name || row.key,
      version: row.version || undefined,
      catalogId,
      source: row.installer,
      // A row whose NAME anchors this unit is the unit's own mod (the
      // installed list builds its rows from exactly those manifest rows);
      // an identity-only pairing describes a sibling copy, not the owner.
      // A ledger-backed own row always wins the badge.
      own: nameHit && !rows.some((rel) => rel.own),
      shared: false,
      dependency: false,
      files: 0,
      totalFiles: 0,
      removable: true,
      ownerRelPath: unit.relPath,
    });
  }

  // Catalog identity with neither a ledger record nor a foreign row behind
  // it: the copy is on disk (the scan paired it) but the ledger has no
  // files to show — surface the identity row so the unit is still
  // attributable and removable through the unit uninstall.
  if (unit.identity) {
    const entry = entryOfIdentity(unit.identity, catalog);
    // Without a resolvable catalog entry there is nothing to name or jump
    // to — the identity alone (a stale or not-yet-fetched index) stays a
    // raw scan detail instead of a user-facing relation row.
    const canonical = entry?.id ?? "";
    const ledgerBacked =
      !!canonical &&
      rows.some(
        (rel) => rel.recordId && recordBacksIdentity(rel.recordId, canonical, catalog),
      );
    const foreignBacked =
      !!canonical &&
      rows.some(
        (rel) =>
          rel.kind === "foreign" &&
          !!rel.catalogId &&
          identityFamily(rel.catalogId, catalog).has(normId(canonical)),
      );
    if (entry && !ledgerBacked && !foreignBacked) {
      rows.push({
        key: `catalog:${canonical}`,
        kind: "catalog",
        name: entry.nameEn || entry.nameZh || entry.title || canonical,
        version: entry.version || undefined,
        catalogId: canonical,
        source: "catalog",
        // The pairing IS the unit's identity and nothing else owns it.
        own: true,
        shared: false,
        dependency: false,
        files: 0,
        totalFiles: 0,
        removable: true,
        ownerRelPath: unit.relPath,
      });
    }
  }

  // Own first, then plain record rows, then dependency-only rows; richest
  // claim first and the name as the final stable key.
  rows.sort(
    (a, b) =>
      Number(b.own) - Number(a.own) ||
      Number(a.dependency) - Number(b.dependency) ||
      b.files - a.files ||
      a.name.localeCompare(b.name),
  );
  return rows;
}

/** Every installed unit's known-mod associations, keyed by
 *  `InstalledMod.relPath` (the row/selection key). Units with nothing
 *  associated are absent. */
export function relationsByUnit(
  units: readonly InstalledMod[],
  records: readonly ModInstallRecord[],
  foreign: readonly ForeignModUnit[],
  catalog: readonly CatalogEntry[],
  gameRoot: string,
): Map<string, UnitRelation[]> {
  const out = new Map<string, UnitRelation[]>();
  const prepared = prepareRecords(records, gameRoot);
  for (const unit of units) {
    const rows = unitRelationsOf(unit, prepared, foreign, catalog);
    if (rows.length > 0) out.set(unit.relPath, rows);
  }
  return out;
}

/** Association count of one unit (0 when it has no known-mod relations) —
 *  the sidebar row's tail tag and the section's header both read this. */
export function unitRelationCount(
  units: readonly InstalledMod[],
  records: readonly ModInstallRecord[],
  foreign: readonly ForeignModUnit[],
  catalog: readonly CatalogEntry[],
  gameRoot: string,
  relPath: string,
): number {
  return relationsByUnit(units, records, foreign, catalog, gameRoot).get(relPath)?.length ?? 0;
}
