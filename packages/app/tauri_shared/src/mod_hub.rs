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
    pub title: String,
    pub name_zh: String,
    pub name_en: String,
    pub description: String,
    pub author_url: String,
    pub packages: Vec<CatalogPackage>,
    /// Localized name/description variants; may be empty for older posts.
    #[serde(default)]
    pub i18n: std::collections::HashMap<String, CatalogEntryI18n>,
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
/// `mods/installed.json`) is absent on purpose — it is deleted outright.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPlan {
    pub from_version: String,
    pub to_version: String,
    pub duplicate: Vec<PlanFile>,
    pub superseded: Vec<PlanFile>,
    pub decide: Vec<PlanFile>,
}

/// Progress push for a catalog install (`wowsp://mod-catalog-progress`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogProgress {
    pub id: String,
    /// `downloading | installing | done`.
    pub phase: String,
    /// 1-based index of the package in flight.
    pub package: u32,
    pub packages: u32,
    pub received: u64,
    pub total: u64,
}
