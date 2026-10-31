use serde::{Deserialize, Serialize};

// ── Mod Hub (M10 groundwork) ────────────────────────────────────────────────

/// Plugin category, derived from on-disk structure signatures — see
/// docs/<lang>/designs/mod-formats.md for the full taxonomy and the real
/// package samples each variant mirrors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModKind {
    /// WWise voice bank (`banks/mods/*` + AudioModification xml).
    Voice,
    /// PnF ship-model/camouflage mod (`PnFMods/*/Main.py` registering a ship).
    Skin,
    /// PnF or Unbound script mod whose `Main.py` registers no ship.
    Script,
    /// Direct file overrides under `content/` (`.dds` textures etc.).
    Textures,
    /// HUD art (`gui/ribbons`, `gui/BFGC/BattleWave`).
    Gui,
    /// Loose config patches (`ime_config.xml` …).
    Patch,
}

/// One file-extension bucket of a texture-override tree's content.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureFileKind {
    /// Lowercase extension with any `.bak` toggle suffix stripped (`dds`,
    /// `mfm`, …); files without one count as `none`.
    pub ext: String,
    pub count: u64,
}

/// Structured breakdown of what a texture-override tree actually covers, so
/// the UI can say more than the bare top-level folder name (`content`,
/// `particles`, …). Every value is a language-neutral code the frontend
/// localizes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureAnalysis {
    /// Total files seen under the tree (bounded walk).
    pub file_count: u64,
    /// Extension buckets, largest first (`dds` dominates pure texture packs,
    /// `mfm`/`visual`/`model` mark material & model overrides).
    pub file_kinds: Vec<TextureFileKind>,
    /// Path-signature categories: `gameplay`, `unlocks`, `content`,
    /// `particles`, `spaces`, `texts`, `system`, `camouflage`.
    pub categories: Vec<String>,
    /// Nation folder names under `content/gameplay|unlocks` (`japan`, …).
    pub nations: Vec<String>,
    /// Ship/component class folders under `content/gameplay` — `ship/<class>`
    /// collapses to the class (`battleship`, `gun`, `superstructure`, …).
    pub species: Vec<String>,
    /// Ship/component units parsed from texture file names
    /// (`JSB039_Yamato_1945_Hull_a.dds` → `JSB039 Yamato 1945`), unique by
    /// code, sorted. Empty when the tree carries no recognizable codes.
    pub ships: Vec<String>,
    /// Map folder names directly under `spaces/`.
    pub space_names: Vec<String>,
    /// True when the file budget cut the walk short — counts are lower bounds.
    pub truncated: bool,
}

/// One classified plugin found installed under `res_mods/<version>/`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledMod {
    pub kind: ModKind,
    pub name: String,
    /// PnF `registerShipMod(...)` ship id for skins; in-game voice-over option
    /// label for banks. `None` when the kind has no secondary identifier.
    pub detail: Option<String>,
    /// Structured content breakdown, `kind == Textures` only (see
    /// [`TextureAnalysis`]); `None` for every other kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture_analysis: Option<TextureAnalysis>,
    /// Primary path of the entry relative to the `res_mods/<version>/` root —
    /// the key the enable/uninstall commands take. Manifest-only rows (an
    /// `installed_mods.xml` entry with no matched files) key on the row name.
    pub rel_path: String,
    /// Every root the unit spans (res_mods-relative, disjoint). Directory
    /// paths keep their names; the disabled state lives in the FILES under
    /// them (`.bak` suffix), not in the directory names.
    #[serde(default)]
    pub paths: Vec<String>,
    /// Scan-time notices for this unit — e.g. another installed skin
    /// overriding the same ship id. Absent when empty (wire-compatible
    /// with older payloads).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    /// True when every file of the unit carries a `.bak` suffix (temporarily
    /// disabled). The scan recognizes `.bak` files so units survive being
    /// disabled and can be re-enabled.
    #[serde(default)]
    pub disabled: bool,
    /// Version reported by Aslain's `installed_mods.xml` when the unit is
    /// backed by a manifest entry. `None` for pure filesystem heuristics.
    #[serde(default)]
    pub version: Option<String>,
    /// Catalog entry id this unit paired against at scan time (name or
    /// alias match against the online index) — the hook the UI uses to show
    /// the entry's localized name instead of the raw directory name.
    /// `None` when nothing paired. Absent on the wire when unset so older
    /// payloads stay byte-identical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    /// True when this unit's paths overlap files a WoWSP ledger record
    /// claims (same install + bin version) — the "contested tree" badge:
    /// two writers each believe they own the tree, and the foreign boot
    /// re-installer keeps re-applying its side at every game start. Pure
    /// scan-time computation. Absent when false (older payloads stay
    /// byte-identical).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub contested: bool,
}

/// Result of toggling one installed plugin's `.bak` state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitToggleReport {
    pub rel_path: String,
    /// State AFTER the toggle: true = files renamed to `.bak`.
    pub disabled: bool,
    pub renamed_files: usize,
}

/// One subtree copy the install performs: `fromRel` (relative to the package
/// root) lands at `toRel` (relative to the new `res_mods/<version>/`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagePlanEntry {
    pub from_rel: String,
    pub to_rel: String,
}

/// Install plan for an unpacked plugin directory. Shown to the user before
/// `mod_hub_install` writes anything.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagePlan {
    pub kind: ModKind,
    /// Display name: folder name, or the AudioModification `<Name>` /
    /// PnF ship id when the format carries a better one.
    pub name: String,
    /// Kind-specific secondary id (see `InstalledMod::detail`).
    pub detail: Option<String>,
    pub entries: Vec<PackagePlanEntry>,
    /// Non-fatal observations: missing loader marker will be auto-created,
    /// case-variant bank folders (`Mods` vs `mods`), overwrite targets.
    pub warnings: Vec<String>,
    /// Structured breakdown of the override trees in the plan (see
    /// [`TextureAnalysis`]); `None` when the package carries none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture_analysis: Option<TextureAnalysis>,
}

/// Result of applying a [`PackagePlan`] to a game install.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub name: String,
    /// `bin/<version>` the files were written into.
    pub bin_version: String,
    pub wrote_files: usize,
    pub warnings: Vec<String>,
    /// Which other installed mods this install overwrote files of (also
    /// mirrored into `warnings`); kept separate so the UI can toast them
    /// without string-matching. Absent when empty so the wire shape of
    /// conflict-free reports stays byte-identical to older builds.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflicts: Vec<String>,
    /// Pre-release `bin/<version>` builds the files were mirrored into
    /// (Steam stages the next version before the client switches). Absent
    /// when empty, same wire-shape rule as `conflicts`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mirrored_bins: Vec<String>,
}

// ── Mod Hub online catalog (mirrors scripts/mod_hub_publish.py output) ──────

/// One downloadable package of a catalog entry: a zip re-hosted as an asset of
/// the repo's `mod-hub` release. `sha256` is verified before unpacking.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPackage {
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub name: String,
}

/// Localized name + one-line description of a catalog entry, keyed by
/// BCP-47 locale in `CatalogEntry::i18n` (source: the `wowsp:i18n` block in
/// the Discussions thread). Consumers fall back to en-US.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntryI18n {
    #[serde(default)]
    pub name: String,
    /// Index JSON carries this as `desc` (discussion line format); aliased so
    /// both shapes deserialize.
    #[serde(default, alias = "desc")]
    pub description: String,
}

/// One named scheme (preset) of a catalog entry — e.g. a marker mod's
/// color palette. Each preset carries its own packages; installing with a
/// preset id downloads those instead of the entry's default list. The
/// FIRST preset is the default scheme (the indexer backfills the entry's
/// plain packages from it).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPreset {
    pub id: String,
    /// Scheme label (Chinese); the UI prefers it for zh locales.
    pub name_zh: String,
    /// Scheme label (English) — the non-zh fallback.
    pub name_en: String,
    pub packages: Vec<CatalogPackage>,
    /// This scheme's own preview screenshot (a GitHub user-attachment
    /// URL): the detail pane swaps to it while the scheme is selected,
    /// so a folded style family shows the right image per button.
    /// `None` when only the entry-level preview exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// This scheme's own description (Chinese) — the variant's caveats
    /// (mutual exclusions, replay breakage…) rendered under the scheme
    /// buttons. `None` when the scheme has no own notes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desc_zh: Option<String>,
    /// Scheme description (English) — the non-zh fallback of `desc_zh`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desc_en: Option<String>,
}

/// One clickable author tag: the credited name plus its official page
/// (empty url renders the tag without a link).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogAuthor {
    pub name: String,
    #[serde(default)]
    pub url: String,
}

/// The `latest` version payload of one mod in `mod-index.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    /// `battle | minimap | port | texts`.
    pub category: String,
    /// Discussions thread number carrying the full post (source, hashes).
    pub discussion: Option<u64>,
    pub version: String,
    /// Game-version range string as published, e.g. `>=15.7 <15.8`.
    pub game: String,
    /// Ships inside the WoWSP app (no download packages; the UI renders it
    /// as bundled). First-party plugins use this.
    #[serde(default)]
    pub bundled: bool,
    /// The thread carrying this release was closed — the mod is withdrawn
    /// from the catalog (hidden from the list, uninstall still works). The
    /// indexer derives it from the discussion's closed state.
    #[serde(default)]
    pub delisted: bool,
    /// Named install-time schemes (color palette, position, display mode…)
    /// parsed from the thread's `wowsp:presets` block; empty for plain
    /// entries. The first preset is the default scheme.
    #[serde(default)]
    pub presets: Vec<CatalogPreset>,
    /// Registry tag ids this entry carries (licensed, AI-generated, IP
    /// origins…). Definitions come from the mod-tags registry, not the
    /// index, so unknown ids render as raw text until the registry
    /// catches up.
    #[serde(default)]
    pub tags: Vec<String>,
    pub title: String,
    pub name_zh: String,
    pub name_en: String,
    pub description: String,
    /// Mod author tags: one per credited author, in attribution order.
    /// Built by the indexer from the thread's `authors:` front-matter with
    /// each name resolved through the registry; empty when no author is
    /// verified — the UI then renders no author tag.
    #[serde(default)]
    pub authors: Vec<CatalogAuthor>,
    pub packages: Vec<CatalogPackage>,
    /// Localized name/description variants; may be empty for older posts.
    #[serde(default)]
    pub i18n: std::collections::HashMap<String, CatalogEntryI18n>,
    /// Foreign-installer names this entry answers to — the Aslain modpack's
    /// manifest row ids and on-disk directory names (`TeamHP`,
    /// `ThreeDimentionalHydro`…), declared by the discussion's
    /// `aliases:` front-matter. Pairing treats them as exact identity, so a
    /// raw directory name that shares no words with the display name still
    /// pairs. Empty for entries without declared aliases.
    #[serde(default)]
    pub aliases: Vec<String>,
    /// Server realms this entry applies to, as canonical realm codes
    /// (`ru` / `eu` / `na` / `asia` / `cn` — `contribution::REALMS`),
    /// from the discussion's `servers:` front-matter. Empty — like all
    /// five codes — means universal: the mod applies on every server.
    /// Consumed for per-client filtering of the mod list (the entry
    /// never appears under a client whose realm it excludes) and for
    /// the compressed scope badge on scoped entries.
    #[serde(default)]
    pub servers: Vec<String>,
    /// First preview screenshot of the entry (a GitHub user-attachment
    /// URL harvested from the discussion body); `None` when the thread
    /// carries no image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// Legacy one-entry-per-variant catalog ids this folded style
    /// family replaces, as old id → preset id. Ledger pairing treats a
    /// record under a superseded id as this entry installed with that
    /// scheme, and install rewinds those records first (family styles
    /// are mutually exclusive variants of one HUD element). Absent on
    /// unfolded entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<std::collections::BTreeMap<String, String>>,
}

/// Parsed `mod-index.json` — the online plugin list the hub page renders.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogIndex {
    /// Upstream catalog stamp, e.g. `v.15.7.0 #10 (2026.08.30)`.
    pub source_version: String,
    /// Game marketing version the catalog targets, e.g. `15.7.0`.
    pub game_version: String,
    /// RFC3339 timestamp of when this copy was fetched.
    pub fetched_at: String,
    /// The official sha256 digest this copy was verified against. A cached
    /// copy whose digest disagrees with the current official one is stale
    /// even inside the freshness TTL.
    #[serde(default)]
    pub source_sha256: String,
    pub mods: Vec<CatalogEntry>,
}

/// Install book-keeping for one mod, persisted in `mods/installed.json`.
/// Uninstall and the future migration engine both work off this record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModInstallRecord {
    pub id: String,
    pub name: String,
    pub version: String,
    pub category: String,
    /// `mod-hub` for catalog installs, `local` for folder installs.
    pub source: String,
    pub discussion: Option<u64>,
    /// Install-time scheme chosen from the entry's presets (see
    /// `CatalogPreset`); absent for plain installs. Mirrored into
    /// `wowsp.toml`'s managed row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    /// `bin/<version>` the files were written into.
    pub bin_version: String,
    /// RFC3339 timestamp.
    pub installed_at: String,
    /// Every file written, relative to `res_mods/<bin_version>/`.
    pub files: Vec<String>,
    /// Where pre-overwrite snapshots of replaced files live, if any.
    pub restore_dir: Option<String>,
    /// Game install this record belongs to (the game root path). Empty on
    /// records written before the field existed — those match any root.
    #[serde(default)]
    pub game_root: String,
    /// Per-file SHA-256 content hashes (lowercase hex) of the
    /// SHARED-COMPONENT files this record wrote (see
    /// `is_shared_component_path` on the app side), keyed by the
    /// normalized res_mods-relative path (lowercase, forward slashes,
    /// `.bak` stripped; `@game/…` game-root drops included). The
    /// shared-file handoff paths verify against these: an uninstall skips
    /// restoring a snapshot layer whose bytes no longer match, and a
    /// later install warns when it writes DIFFERENT bytes over a shared
    /// file this record claims. `None` on records written before the
    /// field existed and on installs that touched no shared component —
    /// every existing ledger loads unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hashes: Option<std::collections::HashMap<String, String>>,
    /// Per-file SHA-256 of the RESTORE LAYERS this install captured —
    /// keyed like `hashes` (normalized res_mods-relative path) but hashing
    /// the PRE-overwrite snapshot copy, not the written bytes. The
    /// uninstall path verifies each layer against THIS map before
    /// restoring it (the written-bytes map above is never used for
    /// restore verification: a healthy layer's bytes differ from what the
    /// install wrote by definition). Only shared-component files with an
    /// actually captured layer get an entry; `None` on pre-field records
    /// and installs that overwrote nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_hashes: Option<std::collections::HashMap<String, String>>,
}

/// One package's expected write map, for the read-only "what will this
/// touch?" preview: the classifier runs over an on-demand extraction in a
/// temp dir, so nothing ever touches `res_mods`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageFilePreview {
    pub name: String,
    pub size: u64,
    /// `res_mods`-relative destinations this package maps its files to
    /// (deduped, sorted; `@game/…` prefixes mark game-root DLL/EXE drops).
    pub files: Vec<String>,
    /// Classifier warnings (wrapper peel, unrecognized leftovers…).
    pub warnings: Vec<String>,
}

/// Result of `mod_catalog_preview_files`: per-package expected write maps
/// plus the `bin/<version>` the tree roots at.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogFilePreview {
    /// `bin/<version>` string the preview tree should root at; empty when
    /// the given game root has no recognizable bin version (the UI falls
    /// back to a localized "current version" label).
    pub bin_version: String,
    pub packages: Vec<PackageFilePreview>,
}

/// ModAPI loader-marker health of the live `res_mods`: the client only
/// loads `PnFMods/` python mods while the `PnFModsLoader.py` marker
/// exists, so `pnf_mods_present && !marker_present` is the "everything
/// silently dead" failure shape (client.ts: PnfLoaderStatus).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PnfLoaderStatus {
    /// Any `PnFMods/<dir>/Main.py|Main.pyc` (or `.bak` twin) lives in the
    /// tree — entry spellings per the classifier's `find_pnf_main`.
    pub pnf_mods_present: bool,
    /// The `PnFModsLoader.py` marker exists.
    pub marker_present: bool,
}

/// A `bin/<version>/` older than the client's current one whose `res_mods`
/// still carries files — stranded by a game update: invisible to the hub's
/// installed list and not loaded by the client, but still on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleBinInfo {
    pub bin_version: String,
    /// Unit names the scanner recognizes in the stranded tree.
    pub mods: Vec<String>,
    pub file_count: u64,
    /// The bundled in-game stats plugin sits in this stranded tree (live or
    /// `.bak`-disabled): a migration then reinstalls it into the current
    /// bin instead of leaving it behind with the mods.
    #[serde(default)]
    pub probe_installed: bool,
}

/// One catalog tag definition (from the mod-tags registry). Tags decorate
/// catalog entries beyond their category: feature markers (licensed,
/// AI-generated), IP origins (Blue Archive, …), whatever the registry
/// grows. The registry ships bundled and refreshes from the `mod-tags`
/// release, so new tags land without an app update.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogTag {
    pub id: String,
    /// `feature | ip | …` — drives the badge styling.
    pub kind: String,
    /// Localized display names keyed by BCP-47 locale (a tag IS just a
    /// name — plain strings, not the entry i18n shape).
    pub i18n: std::collections::HashMap<String, String>,
}

/// The parsed mod-tags registry (`mod-tags.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogTagIndex {
    pub schema: i64,
    pub tags: Vec<CatalogTag>,
}

/// One foreign-installer unit surfaced to the webui: a unit another
/// installer (Aslain's modpack, WG's ModStation) put on disk, with the
/// best-effort catalog pairing. WoWSP describes these, never manages them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignModUnit {
    /// `aslain | modstation`.
    pub installer: String,
    /// Stable manifest key (slug of the display name).
    pub key: String,
    /// The unit's own display name (manifest row / directory name).
    pub name: String,
    pub version: Option<String>,
    /// Catalog id this unit pairs against, when a match existed.
    pub identity: Option<String>,
    /// True when the unit's tree overlaps files a WoWSP ledger record
    /// claims (see [`InstalledMod::contested`]; Aslain rows inherit the
    /// verdict of the installed unit anchored under the same name).
    /// Absent when false (older payloads stay byte-identical).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub contested: bool,
}

/// The boot re-installer footprint of a live `res_mods`: the
/// `PnFMods/ModsInstaller_*` unit Aslain's modpack ships, whose `Main.py`
/// re-runs the installer at EVERY game start and re-applies its descriptor
/// XMLs (`mods/*.xml` inside the unit) — the engine behind WoWSP rewrites
/// and Aslain rewrites undoing each other. `None` from the read command
/// when no such unit lives in the tree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInstallerInfo {
    /// The unit's res_mods-relative tree root, e.g.
    /// `PnFMods/ModsInstaller_4_3_1` (spelling as on disk).
    pub unit_rel_path: String,
    /// The version digit encoded in the directory name (`4_3_1`), when the
    /// family prefix carries one.
    pub version: Option<String>,
    /// File names (stems) of `PnFMods/ModsInstaller_*/mods/*.xml` — the
    /// rows the installer would re-apply at every game start, sorted.
    pub descriptors: Vec<String>,
    /// `installed_mods.xml` rows whose name matches one of those
    /// descriptors (or the unit's own name) — the rows currently pairing
    /// with WoWSP-claimed files, i.e. exactly what a disarm cuts. Empty
    /// when no manifest exists or nothing pairs.
    pub manifest_rows: Vec<String>,
}

/// What [`mod_hub_disarm_boot_installer`] did: the unit tree removed and
/// the foreign manifest rows cut.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInstallerDisarmReport {
    /// Files removed with the unit tree (its own contents; ledger-backed
    /// restores are counted separately by the unit uninstall).
    pub removed_files: usize,
    /// `installed_mods.xml` rows cut (the unit's own row plus every row
    /// matching a descriptor it would re-apply).
    pub cut_rows: usize,
}

/// What a stale-bin migration did: files moved into the current version's
/// `res_mods`, files kept as-is because the current tree already had
/// them (the newer install wins, so migrations never overwrite), and —
/// wizard runs only — files the user marked "leave alone" that stayed in
/// the stale bin untouched.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateReport {
    pub from_version: String,
    pub to_version: String,
    pub moved_files: usize,
    pub skipped_files: usize,
    /// Additive + default so payloads from the pre-ignore wizard keep
    /// parsing.
    #[serde(default)]
    pub ignored_files: usize,
    /// The bundled in-game stats plugin is in place in the current bin
    /// after this migration — freshly reinstalled from the embedded bytes,
    /// or already present there (the user beat the migration to it) and
    /// deliberately left untouched. Additive + default like
    /// `ignored_files`.
    #[serde(default)]
    pub probe_reinstalled: bool,
}

/// One stale-tree file in a [`MigrationPlan`], `res_mods`-relative with
/// forward slashes so the wire shape is platform-independent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFile {
    pub path: String,
    pub size: u64,
    /// Display name resolved backend-side. Always `None` today — identity
    /// matching (catalog ids / Aslain dir aliases) is done by the webui
    /// (`features/modhub/migrateIdentity.ts`), which has the online catalog
    /// loaded already.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
}

/// The wizard's pre-flight view of a stale bin: every file bucketed by what
/// the execute step will do with it. Duplicates (identical size + SHA-256 in
/// the destination) and superseded files (same path, different content — the
/// newer destination copy wins) are deleted, never carried over; `decide`
/// files exist only in the stale tree and follow the user's per-file keep
/// choice. Per-install bookkeeping (`installed_mods.xml`, `PnFModsLoader.py`,
/// `mods/installed.json`) is absent on purpose — it is deleted outright —
/// and so are the bundled in-game plugin's own files: a migration that
/// finds them reinstalls fresh embedded bytes instead of carrying them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPlan {
    pub from_version: String,
    pub to_version: String,
    pub duplicate: Vec<PlanFile>,
    pub superseded: Vec<PlanFile>,
    pub decide: Vec<PlanFile>,
}

/// One unit the purge could not put back (its payload is not reconstructible
/// from the local ledger).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeSkip {
    pub name: String,
    pub reason: String,
}

/// Result of the "purge every mod, then reinstall only WoWSP-managed ones"
/// reset (`mod_hub_purge_reinstall`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeReinstallReport {
    /// Files that were moved out of the load path.
    pub removed_files: usize,
    /// Display names of the units reinstalled from the catalog.
    pub reinstalled: Vec<String>,
    /// Display names of the units copied back from the old tree and
    /// registered as WoWSP local installs (the adoption scope).
    pub adopted: Vec<String>,
    /// Units that could not be reinstalled.
    pub skipped: Vec<PurgeSkip>,
    /// Where the previous tree now lives (nothing is deleted before the
    /// caller holds this path — the user cleans it up once satisfied).
    pub backup_path: Option<String>,
}
