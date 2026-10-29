//! In-game stats plugin status detection.
//!
//! The plugin (`packages/ingame-plugin`, design in
//! `docs/en/designs/ingame-stats-plugin.md`) is a PnFMods mod the app drops
//! into the game's `res_mods` so live-battle telemetry can flow through a
//! file bridge. This command family feeds the settings UI: the 名单识别
//! "plugin detection" option stays greyed until the mod is present in the
//! active install, and its page button deep-links the GitHub Discussions
//! resource thread.

use anyhow::anyhow;
use serde::Serialize;
use tauri::Emitter;

use wowsp_tauri_shared::CommandResult;

/// The plugin's resource thread on langyo/wowsp — the settings page builds
/// `https://github.com/langyo/wowsp/discussions/<n>` from this.
const DISCUSSION_NUMBER: u64 = 640;

/// PnFMods layout written by `scripts/install_ingame_probe.py` (and by the
/// app's own auto-install once M2 lands) — the entry file is the presence
/// probe.
pub(crate) const MOD_DIR: &str = "WoWSPProbe";
/// The probe's entry file — the presence probe and the overlay watcher's
/// mode declaration.
pub(crate) const MOD_ENTRY: &str = "Main.py";

/// The plugin's runtime bridge files (the Main.py side of the file bridge):
/// per-session battle state the plugin rewrites from scratch every run. An
/// install wipes any leftovers, so a dead session's roster and ordering can
/// never survive a reinstall into a tree that carried them in.
const RUNTIME_BRIDGE_FILES: [&str; 9] = [
    "telemetry.json",
    "heartbeat.json",
    "request.json",
    "response.json",
    "roster_raw.json",
    "roster_journal.jsonl",
    "manual_refresh.flag",
    "order_probe.json",
    "builds.json",
];

/// The plugin's per-battle build bridge (`builds.json`, written once per
/// roster session by the probe's `write_builds`; quit-clear = `players: {}`).
const BUILDS_FILE_NAME: &str = "builds.json";

/// The build bridge's event: one [`IngameBuildsFrame`] per content change, and
/// an empty `builds` list on the quit-clear. Ally-only by construction (the
/// probe rows are filtered to `self_team` before they leave this module).
pub(crate) const INGAME_BUILDS_EVENT: &str = "wowsp://ingame-builds";

/// A `builds.json` frame is written ONCE at battle start, so its `t` ages for
/// the whole battle. Anything older than this is a leftover from a previous
/// session (the probe contract treats stale/missing as "no build data"): the
/// longest battles plus loading stay far below it, while a crashed client's
/// bridge file never resurfaces as today's loadouts.
const BUILDS_STALE_MS: i64 = 2 * 60 * 60 * 1000;

/// Bounds mirrored from the probe (its `BUILDS_MAX_PLAYERS` /
/// `BUILDS_MAX_DUMP_CHARS`) plus a file-size ceiling: a hand-edited or hostile
/// bridge file must never drive unbounded work.
const BUILDS_MAX_PLAYERS: usize = 64;
const BUILDS_MAX_DUMP_CHARS: usize = 8192;
const BUILDS_MAX_FILE_BYTES: usize = 1024 * 1024;

/// The SHIP_CONFIG layout era the probe's dump is decoded with. The probe
/// bridges the game's `shipConfigDump` verbatim and carries no client version
/// stamp, so the pinned 15.9 era is assumed; a future client's shifted layout
/// fails [`wowsp_replay_core::decode_ship_config_blob`]'s section sanity caps
/// (0 items / over-cap counts) and the row is skipped instead of mis-read.
const BUILDS_SHIP_CONFIG_ERA: (u32, u32, u32) = (15, 9, 0);

/// One `wowsp://ingame-builds` payload (camelCase on the wire).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngameBuildsFrame {
    /// The probe's session id (the battle the builds belong to). The quit-clear
    /// frame preserves the finished battle's id with an empty `builds` list.
    pub battle: String,
    /// Ally-only player builds (the probe carries the whole roster; every
    /// non-`self_team` row is dropped in this module).
    pub builds: Vec<wowsp_tauri_shared::PlayerBuild>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngamePluginStatus {
    /// Whether the plugin's entry file exists in the install's res_mods.
    pub installed: bool,
    /// Whether the install's current res_mods is quarantined by the mod hub's
    /// safe mode: enabled safe mode renames `res_mods` to
    /// `res_mods.wowsp-disabled` (and a game update while it is on strands
    /// that twin in an older `bin/` dir). `installed` deliberately keeps
    /// describing the LIVE res_mods tree — false while quarantined — because
    /// that is the in-game truth; the UI uses this flag to replace the
    /// install offer with the "turn mods back on and repair" ask instead of
    /// offering an install the backend must refuse.
    pub safe_mode: bool,
    /// Installed but NOT the bytes this app ships (an older build, a
    /// missing unbound view, or a hand-edited file): the UI offers a
    /// one-click update. The in-game version string is pinned at 0.1.0 by
    /// owner decision, so the content hashes over the whole shipped set
    /// (Main.py + view) are the only reliable freshness signal.
    pub outdated: bool,
    /// The res_mods directory that was inspected (diagnostics for the UI).
    pub res_mods: String,
    /// GitHub discussion thread backing the plugin's mod-hub page.
    pub discussion: u64,
}

/// Report whether the in-game stats plugin is present in a game install.
/// Read-only — unlike the install commands it takes no mod-hub gate, so the
/// settings page can poll it freely.
#[tauri::command]
pub fn ingame_plugin_status(game_root: String) -> CommandResult<IngamePluginStatus> {
    let dir = super::game_context::res_mods_dir(std::path::Path::new(&game_root))?;
    let entry = dir.join("PnFMods").join(MOD_DIR).join(MOD_ENTRY);
    let installed = entry.is_file();
    let outdated = installed
        && !(file_fresh(
            &dir,
            &format!("PnFMods/{MOD_DIR}/{MOD_ENTRY}"),
            PLUGIN_SOURCE,
        ) && file_fresh(&dir, VIEW_DEST, PLUGIN_VIEW));
    Ok(IngamePluginStatus {
        installed,
        safe_mode: super::mod_hub::safe_mode_active(&game_root),
        outdated,
        res_mods: dir.to_string_lossy().into_owned(),
        discussion: DISCUSSION_NUMBER,
    })
}

/// The embedded plugin source — the same bytes
/// `scripts/install_ingame_probe.py` copies, so a probe installed by the
/// script and one installed here are byte-identical.
const PLUGIN_SOURCE: &str = include_str!("../../../../ingame-plugin/src/Main.py");

/// The plugin's unbound 2 view — auto discovered + mounted by the game
/// from `gui/unbound2/mods/` — the folder every working battle view on
/// real installs lives in (radar_timer, shot_timer, …). A
/// `ForgeBlueprints/` manifest was tried first and never worked: those
/// XMLs are installer-only metadata the game ignores, and
/// `gui/unbound2/PnFMods/` is outside the scan set. Shipped for the
/// capture side channel's barcode strips — the in-game panel rendering
/// the view also carries is retired with the 游戏内展示 mode (see
/// packages/ingame-plugin/README.md). No view file means the plugin
/// stays a telemetry-only probe.
const PLUGIN_VIEW: &str = include_str!("../../../../ingame-plugin/src/WoWSPProbe.unbound");
const VIEW_DEST: &str = "gui/unbound2/mods/WoWSPProbe.unbound";
/// The layout #694 shipped, retired by this fix — an install (or update)
/// over it removes both leftovers.
const LEGACY_VIEW_DEST: &str = "gui/unbound2/PnFMods/WoWSPProbe.unbound";
const LEGACY_MOUNT_DEST: &str = "ForgeBlueprints/WoWSPProbe.xml";

/// The probe's entry file inside a SPECIFIC res_mods tree — the presence
/// probe for callers that inspect something other than the active install
/// (the mod hub's stale-bin migration looks at stranded old-version trees).
pub(crate) fn probe_entry(res_mods: &std::path::Path) -> std::path::PathBuf {
    res_mods.join("PnFMods").join(MOD_DIR).join(MOD_ENTRY)
}

/// Whether `rel` (res_mods-relative, forward slashes) belongs to the
/// probe's own file set — the current layout's subtree and view, the
/// retired #694 layout's leftovers, `.bak` twins included. The stale-bin
/// migration excludes these from its generic file move and reinstalls the
/// embedded bytes instead: an upgrade is exactly the moment the shipped
/// copy should win over whatever stranded build the old bin carried.
pub(crate) fn is_probe_path(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    if lower.starts_with(&format!("pnfmods/{}/", MOD_DIR.to_ascii_lowercase())) {
        return true;
    }
    // A `.bak` twin of an extra path (the view, disabled by whatever unit
    // claimed it) is a probe file too — it must neither ride the migration
    // move nor outlive the uninstall.
    let bare = lower.strip_suffix(".bak").unwrap_or(lower.as_str());
    PROBE_EXTRA_PATHS
        .iter()
        .any(|p| bare == p.to_ascii_lowercase())
}

/// The probe's files OUTSIDE its PnFMods subtree, res_mods-relative: the
/// view file of the current layout plus the retired #694 leftovers.
/// Companions to the `PnFMods/<MOD_DIR>/` subtree for callers (the
/// stale-bin migration) that remove or carry the probe's whole file set.
pub(crate) const PROBE_EXTRA_PATHS: [&str; 3] = [VIEW_DEST, LEGACY_VIEW_DEST, LEGACY_MOUNT_DEST];

/// The probe's `wowsp.toml` managed row — the single source of truth for
/// the install core and the migration's disabled-state restore.
pub(crate) fn probe_managed_entry(enabled: bool) -> super::mod_hub::manifest::ManagedEntry {
    super::mod_hub::manifest::ManagedEntry {
        name: "WoWSP In-Game Tab Stats Plugin".into(),
        version: "0.1.0".into(),
        category: "battle".into(),
        source: "bundled".into(),
        preset: None,
        enabled,
        installed_at: chrono::Utc::now().to_rfc3339(),
    }
}

/// Rewrite the probe's managed row as ENABLED — a plain install rewrites
/// live files, so a stale disabled label from a pre-update toggle must
/// not survive. Upsert alone preserves the previous toggle bit, so the
/// row is removed first. (Writing DISABLED goes through the unit toggle's
/// `SetEnabled` path instead — see `unit_ops::set_bundled_plugin_enabled`.)
pub(crate) fn replace_probe_row_enabled(res_mods: &std::path::Path) {
    use super::mod_hub::manifest::{self, ManifestOp};
    manifest::hub_apply(ManifestOp::RemoveManaged {
        res_mods: res_mods.to_path_buf(),
        id: "battle.ingame.stats".into(),
    });
    manifest::hub_apply(ManifestOp::UpsertManaged {
        res_mods: res_mods.to_path_buf(),
        id: "battle.ingame.stats".into(),
        entry: probe_managed_entry(true),
    });
}

/// Whether `res_mods/<rel>` carries exactly `expected`'s bytes. Missing,
/// unreadable and divergent files are all "not fresh" — the freshness
/// signal behind the settings UI's one-click update.
fn file_fresh(dir: &std::path::Path, rel: &str, expected: &str) -> bool {
    use sha2::{Digest, Sha256};
    match std::fs::read(dir.join(rel)) {
        Ok(bytes) => {
            let mut wanted = Sha256::new();
            wanted.update(expected.as_bytes());
            let mut on_disk = Sha256::new();
            on_disk.update(&bytes);
            wanted.finalize()[..] == on_disk.finalize()[..]
        },
        Err(_) => false,
    }
}

/// Loader marker content: the game only scans `res_mods` for mods when this
/// 0-byte file exists; some modpacks (Aslain) ship it already.
const LOADER_MARKER: &str = "PnFModsLoader.py";

/// Install the plugin into the active install: `PnFMods/WoWSPProbe/Main.py`
/// plus the game-scanned unbound view of the in-game display mode, and the
/// 0-byte loader marker when missing. Gated like every res_mods mutation
/// (mod-hub gate, game closed, res_mods active). Idempotent — existing
/// files are overwritten in place (a broken install can be reinstalled
/// over), and the #694 layout's leftovers are removed.
#[tauri::command]
pub async fn ingame_plugin_install(game_root: String) -> CommandResult<String> {
    let _gate = super::mod_catalog::mod_hub_gate().await;
    super::mod_hub::ensure_game_closed(&game_root)?;
    super::mod_hub::ensure_res_mods_active(&game_root)?;
    Ok(install_probe_files(&game_root)?)
}

/// Install core, split from the command so the mod hub's stale-bin
/// migration can reuse it mid-migration: the migrator already holds the
/// mod-hub gate, verified the game is closed and res_mods is active — so
/// this core takes none of those locks (re-taking the gate would deadlock).
pub(crate) fn install_probe_files(game_root: &str) -> anyhow::Result<String> {
    let dir = super::game_context::res_mods_dir(std::path::Path::new(game_root))?;
    let mod_dir = dir.join("PnFMods").join(MOD_DIR);
    std::fs::create_dir_all(&mod_dir).map_err(|e| anyhow!("create {}: {e}", mod_dir.display()))?;
    // Dead session state must not survive the reinstall — these are the
    // plugin's own per-run rewrites (see [`RUNTIME_BRIDGE_FILES`]).
    for file in RUNTIME_BRIDGE_FILES {
        let _ = std::fs::remove_file(mod_dir.join(file));
    }
    let entry = mod_dir.join(MOD_ENTRY);
    std::fs::write(&entry, PLUGIN_SOURCE).map_err(|e| anyhow!("write {}: {e}", entry.display()))?;
    // The view lands under its own res_mods subtree — this install's own
    // first-party file, no shared paths.
    let view_dest = dir.join(VIEW_DEST);
    if let Some(parent) = view_dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| anyhow!("create {}: {e}", parent.display()))?;
    }
    std::fs::write(&view_dest, PLUGIN_VIEW)
        .map_err(|e| anyhow!("write {}: {e}", view_dest.display()))?;
    // The #694 layout's leftovers (installer-only mount manifest + an
    // unscanned view path) are this install's own files — remove them so
    // an update can't leave a stale half-layout behind.
    for rel in [LEGACY_VIEW_DEST, LEGACY_MOUNT_DEST] {
        let dest = dir.join(rel);
        if dest.is_file() {
            let _ = std::fs::remove_file(&dest);
        }
    }
    let loader = dir.join(LOADER_MARKER);
    if !loader.exists() {
        std::fs::write(&loader, "").map_err(|e| anyhow!("write {}: {e}", loader.display()))?;
    }
    // The pre-release twins get the plugin too (see preload_mirror) — the
    // marker ride-along is what keeps twins scannable after the switch.
    for warning in super::mod_hub::preload_mirror::mirror_written(
        game_root,
        &dir,
        &[
            format!("PnFMods/{MOD_DIR}/{MOD_ENTRY}"),
            VIEW_DEST.to_string(),
            LOADER_MARKER.to_string(),
        ],
    )
    .warnings
    {
        tracing::warn!("{warning}");
    }
    // The twins shed their runtime files too: a staged build must not open
    // its first session with a dead one's battle state.
    let runtime_rels: Vec<String> = RUNTIME_BRIDGE_FILES
        .iter()
        .map(|file| format!("PnFMods/{MOD_DIR}/{file}"))
        .collect();
    super::mod_hub::preload_mirror::mirror_removed(game_root, &runtime_rels);
    // wowsp.toml contract: the plugin is a managed unit (bundled source)
    // and its `[tools]` table gets the documented defaults — existing keys,
    // hand-tuned or from a previous install, are never overwritten.
    {
        use std::collections::BTreeMap;
        let mut defaults = BTreeMap::new();
        defaults.insert("panel_fade_ticks".to_string(), 3i64);
        defaults.insert("journal_limit".to_string(), 300i64);
        // The strip switch's install baseline: off. The overlay watcher
        // owns the screen and re-declares it (barcode strips on) every
        // game session; the probe's former `panel` half is gone with the
        // retired in-game display mode.
        defaults.insert("barcode".to_string(), 0i64);
        super::mod_hub::manifest::hub_apply(super::mod_hub::manifest::ManifestOp::SeedTool {
            res_mods: dir.clone(),
            tool: "battle.ingame.stats".into(),
            defaults,
        });
        // Replace the row outright: this install rewrites live files, so a
        // stale disabled label from a pre-update toggle must not survive.
        replace_probe_row_enabled(&dir);
    }
    tracing::info!(dir = %mod_dir.display(), "ingame plugin installed");
    Ok(mod_dir.to_string_lossy().into_owned())
}

/// Remove the plugin files. Idempotent. The loader marker is deleted only
/// when it is the 0-byte file this install layout uses AND no other PnF
/// mod remains that would rely on it — a marker another modpack created
/// (or needs) must survive.
#[tauri::command]
pub async fn ingame_plugin_uninstall(game_root: String) -> CommandResult<()> {
    let _gate = super::mod_catalog::mod_hub_gate().await;
    super::mod_hub::ensure_game_closed(&game_root)?;
    super::mod_hub::ensure_res_mods_active(&game_root)?;
    let dir = super::game_context::res_mods_dir(std::path::Path::new(&game_root))?;
    let mod_dir = dir.join("PnFMods").join(MOD_DIR);
    if mod_dir.is_dir() {
        std::fs::remove_dir_all(&mod_dir)
            .map_err(|e| anyhow!("remove {}: {e}", mod_dir.display()))?;
    }
    // The view is this layout's own file (plus the #694 leftovers) —
    // always removed with the mod, their `.bak` twins included (a foreign
    // file at the same path is not ours to touch, but the first-party
    // names make that collision theoretical).
    for rel in PROBE_EXTRA_PATHS {
        for suffix in ["", ".bak"] {
            let dest = dir.join(format!("{rel}{suffix}"));
            if dest.is_file() {
                let _ = std::fs::remove_file(&dest);
            }
        }
    }
    let loader = dir.join(LOADER_MARKER);
    if !has_pnf_mods(&dir)
        && loader.is_file()
        && std::fs::metadata(&loader).is_ok_and(|m| m.len() == 0)
    {
        let _ = std::fs::remove_file(&loader);
    }
    // Twin copies go with the live ones (the twin's own loader marker is
    // shared-tree bookkeeping and stays — see preload_mirror).
    let mut probe_paths: Vec<String> = PROBE_EXTRA_PATHS.iter().map(|p| p.to_string()).collect();
    probe_paths.push(format!("PnFMods/{MOD_DIR}"));
    super::mod_hub::preload_mirror::mirror_removed(&game_root, &probe_paths);
    // The managed row goes with the files; the tool's config table stays
    // (a reinstall should find the user's tuning where they left it).
    super::mod_hub::manifest::hub_apply(super::mod_hub::manifest::ManifestOp::RemoveManaged {
        res_mods: dir.clone(),
        id: "battle.ingame.stats".into(),
    });
    tracing::info!(dir = %dir.display(), "ingame plugin uninstalled");
    Ok(())
}

/// Does the tree still carry any PnF mod — a directory under `PnFMods`
/// with a standard mod entry (foreign modpacks and the bundled probe
/// alike)? Entry spellings follow the classifier's `find_pnf_main`:
/// `Main.py`, compiled `Main.pyc`, or either's `.bak` twin when disabled —
/// real-world packs ship all four (Aslain's script mods are Main.pyc), and
/// a disabled mod must still keep the shared marker alive or re-enabling
/// it would resurrect a corpse. The marker itself must survive while any
/// does: without it the client stops loading PnF mods entirely, so
/// removing it would silence every OTHER PnF mod too.
pub(crate) fn has_pnf_mods(res_mods: &std::path::Path) -> bool {
    res_mods
        .join("PnFMods")
        .read_dir()
        .map(|entries| {
            entries
                .flatten()
                .any(|e| e.path().is_dir() && super::mod_hub::find_pnf_main(&e.path()).is_some())
        })
        .unwrap_or(false)
}

/// The plugin's live telemetry file for a game root — `None` when the root
/// has no versioned `bin/` layout to hang `res_mods` off.
pub(crate) fn telemetry_file(game_root: &std::path::Path) -> Option<std::path::PathBuf> {
    let dir = super::game_context::res_mods_dir(game_root).ok()?;
    Some(dir.join("PnFMods").join(MOD_DIR).join("telemetry.json"))
}

/// The plugin's liveness file for a game root — written at load and on
/// every scheduler tick (port included), so it answers "is the probe even
/// loaded in this client" independently of any battle. `None` when the
/// root has no versioned `bin/` layout to hang `res_mods` off.
fn heartbeat_file(game_root: &std::path::Path) -> Option<std::path::PathBuf> {
    let dir = super::game_context::res_mods_dir(game_root).ok()?;
    Some(dir.join("PnFMods").join(MOD_DIR).join("heartbeat.json"))
}

/// The plugin's build bridge file for a game root — None when the root has no
/// versioned bin/ layout to hang res_mods off.
pub(crate) fn builds_file(game_root: &std::path::Path) -> Option<std::path::PathBuf> {
    let dir = super::game_context::res_mods_dir(game_root).ok()?;
    Some(dir.join("PnFMods").join(MOD_DIR).join(BUILDS_FILE_NAME))
}

/// One raw probe build row, parsed from the builds.json players map.
struct ProbeBuildRow {
    name: String,
    team: Option<i64>,
    ship_params_id: Option<u32>,
    dump_enc: Option<String>,
    dump: Option<String>,
    crew: Option<ProbeCrew>,
}

/// The probe's crew block (captain params + learned skills). Every field is
/// optional in the contract: older probe shapes omit the crew key entirely,
/// and a crew object without learnedSkills is never fabricated by the probe.
#[derive(Default)]
struct ProbeCrew {
    params_id: Option<u32>,
    is_in_adaptation: Option<i64>,
    learned_skills: Option<Vec<Vec<u8>>>,
}

/// One parsed builds.json document.
struct ProbeBuildsDoc {
    battle: String,
    written_ms: Option<i64>,
    self_team: Option<i64>,
    players: Vec<ProbeBuildRow>,
}

/// Tolerant integer read: numbers, numeric strings (the sandbox serializer can
/// spell fields as strings), floats truncated.
fn json_int(value: &serde_json::Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|f| f as i64))
        .or_else(|| value.as_str().and_then(|s| s.trim().parse::<i64>().ok()))
}

/// Tolerant text read: strings verbatim, integers rendered as text (the probe's
/// session id is a formatted integer string, but defensive both ways).
fn json_text(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// An object value, transparently re-parsing one level of JSON-in-a-string
/// (the probe's full-encode shape double-encodes some records).
fn json_object(value: &serde_json::Value) -> Option<serde_json::Map<String, serde_json::Value>> {
    match value {
        serde_json::Value::Object(map) => Some(map.clone()),
        serde_json::Value::String(s) => match serde_json::from_str(s) {
            Ok(serde_json::Value::Object(map)) => Some(map),
            _ => None,
        },
        _ => None,
    }
}

/// Parse the probe's learned-skills matrix: rows of u8 skill ordinals. Values
/// are bounded to the u8 range; a row of any other shape skips the whole crew
/// block rather than storing garbage.
fn parse_skill_matrix(value: &serde_json::Value) -> Option<Vec<Vec<u8>>> {
    let rows = value.as_array()?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let ids = row.as_array()?;
        let mut row_out = Vec::with_capacity(ids.len());
        for id in ids {
            let id = json_int(id)?;
            row_out.push(u8::try_from(id).ok()?);
        }
        out.push(row_out);
    }
    Some(out)
}

/// Parse one probe crew block; None when the block carries no readable learned
/// skills (the probe omits the key in that case — never fabricate).
fn parse_probe_crew(value: &serde_json::Value) -> Option<ProbeCrew> {
    let map = json_object(value)?;
    let learned_skills = map.get("learned_skills").and_then(parse_skill_matrix)?;
    Some(ProbeCrew {
        params_id: map.get("params_id").and_then(json_int).map(|v| v as u32),
        is_in_adaptation: map.get("is_in_adaptation").and_then(json_int),
        learned_skills: Some(learned_skills),
    })
}

/// Parse one player row of the probe's players map.
fn parse_probe_build_row(name: &str, value: &serde_json::Value) -> Option<ProbeBuildRow> {
    let map = json_object(value)?;
    Some(ProbeBuildRow {
        name: name.to_string(),
        team: map.get("team").and_then(json_int),
        ship_params_id: map
            .get("ship_params_id")
            .and_then(json_int)
            .map(|v| v as u32),
        dump_enc: map.get("dump_enc").and_then(json_text),
        dump: map.get("dump").and_then(json_text),
        crew: map.get("crew").and_then(parse_probe_crew),
    })
}

/// Parse one builds.json document (double-encoded JSON tolerated).
fn parse_probe_builds(raw: &str) -> Option<ProbeBuildsDoc> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > BUILDS_MAX_FILE_BYTES {
        return None;
    }
    let mut value: serde_json::Value = serde_json::from_str(raw).ok()?;
    if let serde_json::Value::String(inner) = &value {
        value = serde_json::from_str(inner).ok()?;
    }
    let map = value.as_object()?;
    // Contract: v=1 (a future shape bump must not be half-read).
    if map.get("v").and_then(json_int) != Some(1) {
        return None;
    }
    let battle = map.get("battle").and_then(json_text).unwrap_or_default();
    let written_ms = map.get("t").and_then(json_int);
    let self_team = map.get("self_team").and_then(json_int);
    let mut players = Vec::new();
    if let Some(rows) = map.get("players").and_then(|v| v.as_object()) {
        for (name, row) in rows {
            if players.len() >= BUILDS_MAX_PLAYERS {
                break;
            }
            if let Some(row) = parse_probe_build_row(name, row) {
                players.push(row);
            }
        }
    }
    Some(ProbeBuildsDoc {
        battle,
        written_ms,
        self_team,
        players,
    })
}

/// Decode one probe dump body: hex (WG family) or standard base64 (the Lesta
/// SafeClass repr). The char bound mirrors the probe's own cap.
fn decode_probe_dump(enc: &str, body: &str) -> Option<Vec<u8>> {
    if body.is_empty() || body.len() > BUILDS_MAX_DUMP_CHARS {
        return None;
    }
    match enc {
        "hex" => {
            let bytes = body.as_bytes();
            if bytes.len() % 2 != 0 {
                return None;
            }
            let mut out = Vec::with_capacity(bytes.len() / 2);
            for pair in bytes.chunks_exact(2) {
                let hi = (pair[0] as char).to_digit(16)?;
                let lo = (pair[1] as char).to_digit(16)?;
                out.push(((hi << 4) | lo) as u8);
            }
            Some(out)
        },
        "b64" => {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.decode(body).ok()
        },
        _ => None,
    }
}

/// Decode one probe row's dump into a PlayerBuild: the raw SHIP_CONFIG blob
/// through the replay decoder's public parser (the probe bridges the game's own
/// shipConfigDump verbatim), plus the optional crew block. entity_id stays 0 —
/// probe builds join by name.
fn probe_player_build(row: &ProbeBuildRow) -> Option<wowsp_tauri_shared::PlayerBuild> {
    let enc = row.dump_enc.as_deref()?;
    let dump = row.dump.as_deref()?;
    let blob = decode_probe_dump(enc, dump)?;
    let config = wowsp_replay_core::decode_ship_config_blob(&blob, BUILDS_SHIP_CONFIG_ERA)?;
    // The dump's own header ship id is authoritative; a row-level id that
    // disagrees means a drifted record, so trust the parsed dump.
    if config.ship_params_id == 0 {
        return None;
    }
    let crew = row.crew.as_ref();
    Some(wowsp_tauri_shared::PlayerBuild {
        entity_id: 0,
        ship_params_id: config.ship_params_id,
        name: Some(row.name.clone()),
        units: config.units,
        modernization: config.modernization,
        exteriors: config.exteriors,
        abilities: config.abilities,
        ensigns: config.ensigns,
        ecoboosts: config.ecoboosts,
        crew_params_id: crew.and_then(|c| c.params_id).unwrap_or(0),
        is_in_adaptation: crew
            .and_then(|c| c.is_in_adaptation)
            .is_some_and(|flag| flag != 0),
        learned_skills: crew
            .and_then(|c| c.learned_skills.clone())
            .unwrap_or_default(),
    })
}

/// Content key for the poller's dedupe: (battle, every player's encoded dump +
/// crew). The probe rewrites the file with only t changing, so keying on the
/// payload (not the file bytes) is what keeps the event at one emit per battle.
/// Sorted by name so map iteration order never changes the key.
fn builds_content_key(doc: &ProbeBuildsDoc) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut rows: Vec<&ProbeBuildRow> = doc.players.iter().collect();
    rows.sort_by(|a, b| a.name.cmp(&b.name));
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    doc.battle.hash(&mut hasher);
    for row in rows {
        row.name.hash(&mut hasher);
        row.team.hash(&mut hasher);
        row.ship_params_id.hash(&mut hasher);
        row.dump_enc.hash(&mut hasher);
        row.dump.hash(&mut hasher);
        if let Some(crew) = &row.crew {
            crew.params_id.hash(&mut hasher);
            crew.is_in_adaptation.hash(&mut hasher);
            crew.learned_skills.hash(&mut hasher);
        }
    }
    hasher.finish()
}

/// What one parsed frame means for the bridge.
enum BuildsIngest {
    /// The probe's quit-clear: empty snapshot + an empty-builds event so an
    /// already-mounted grid drops yesterday's loadouts.
    Clear { battle: String, key: u64 },
    /// A fresh frame with the ally-only builds.
    Frame {
        battle: String,
        builds: Vec<wowsp_tauri_shared::PlayerBuild>,
        key: u64,
    },
    /// The probe could not name the local player, so team ownership is unknown:
    /// drop the whole frame (never guess which side is ours).
    MissingSelfTeam,
    /// Unparseable / stale / contract-violating.
    Skip,
}

/// Fold one parsed document into the poller's decision. Ally-only rule: only
/// rows whose team equals self_team survive; enemy rows are dropped here (Rust
/// side) and never reach the event/snapshot.
fn builds_ingest(doc: ProbeBuildsDoc, now_ms: i64) -> BuildsIngest {
    let Some(written_ms) = doc.written_ms else {
        return BuildsIngest::Skip;
    };
    if now_ms.saturating_sub(written_ms) > BUILDS_STALE_MS {
        return BuildsIngest::Skip;
    }
    if doc.battle.is_empty() && doc.players.is_empty() {
        return BuildsIngest::Skip;
    }
    let key = builds_content_key(&doc);
    if doc.players.is_empty() {
        // The quit-clear: players blanked, the finished battle's id preserved.
        return BuildsIngest::Clear {
            battle: doc.battle,
            key,
        };
    }
    let Some(self_team) = doc.self_team.filter(|team| *team == 0 || *team == 1) else {
        return BuildsIngest::MissingSelfTeam;
    };
    let mut builds: Vec<wowsp_tauri_shared::PlayerBuild> = Vec::new();
    let mut skipped = 0usize;
    for row in &doc.players {
        if row.team != Some(self_team) {
            continue;
        }
        match probe_player_build(row) {
            Some(build) => builds.push(build),
            None => skipped += 1,
        }
    }
    builds.sort_by(|a, b| a.name.cmp(&b.name));
    tracing::debug!(
        battle = %doc.battle,
        allies = builds.len(),
        skipped,
        "probe builds frame decoded"
    );
    BuildsIngest::Frame {
        battle: doc.battle,
        builds,
        key,
    }
}

/// Per-root build-bridge bookkeeping: the last emitted content key (the probe
/// rewrites builds.json every tick, so the payload key — not the file bytes —
/// is the dedupe) and the one-shot missing-self_team warning.
#[derive(Default)]
struct BuildsWatch {
    last_key: Option<u64>,
    warned_missing_self_team: bool,
}

impl BuildsWatch {
    /// True when this content key is new (the caller may emit).
    fn accept_key(&mut self, key: u64) -> bool {
        if self.last_key == Some(key) {
            return false;
        }
        self.last_key = Some(key);
        true
    }

    /// True once per root: the missing-self_team warning fires on the first
    /// such frame and stays quiet while the probe keeps answering without it.
    fn warn_missing_self_team(&mut self) -> bool {
        if self.warned_missing_self_team {
            return false;
        }
        self.warned_missing_self_team = true;
        true
    }
}

/// The latest ally-only build frame across every running install — what
/// ingame_builds_snapshot serves to a UI that mounts mid-battle.
struct LatestBuilds {
    root: String,
    frame: IngameBuildsFrame,
}

static LATEST_BUILDS: std::sync::Mutex<Option<LatestBuilds>> = std::sync::Mutex::new(None);

fn store_latest_builds(root: &str, frame: IngameBuildsFrame) {
    if let Ok(mut latest) = LATEST_BUILDS.lock() {
        *latest = Some(LatestBuilds {
            root: root.to_string(),
            frame,
        });
    }
}

/// Drop the latest frame when its owning install exits (a dead client's battle
/// must not be served as live data after the process is gone).
fn clear_latest_builds_for_root(root: &str) {
    if let Ok(mut latest) = LATEST_BUILDS.lock() {
        if latest.as_ref().is_some_and(|l| l.root == root) {
            *latest = None;
        }
    }
}

/// Latest ally-only build frame for the CURRENT battle, or None while no probe
/// frame has arrived (old probe / port / install without the plugin).
/// Late-mounting consumers call this once, then follow wowsp://ingame-builds.
#[tauri::command]
pub fn ingame_builds_snapshot() -> Option<IngameBuildsFrame> {
    LATEST_BUILDS
        .lock()
        .ok()
        .and_then(|latest| latest.as_ref().map(|l| l.frame.clone()))
}

/// Emit one build frame to every window.
fn emit_builds(app: &tauri::AppHandle, frame: &IngameBuildsFrame) {
    if let Err(e) = app.emit(INGAME_BUILDS_EVENT, frame) {
        tracing::warn!(error = %e, "emit ingame-builds failed");
    }
}

/// Read + fold ONE root's raw builds.json content into the bridge stream. A
/// parse failure (half write / old shape) leaves the watch untouched, so the
/// next good rewrite still emits.
fn ingest_builds(
    app: &tauri::AppHandle,
    root: &str,
    raw: &str,
    watch: &mut BuildsWatch,
    now_ms: i64,
) {
    let Some(doc) = parse_probe_builds(raw) else {
        return;
    };
    match builds_ingest(doc, now_ms) {
        BuildsIngest::Skip => {},
        BuildsIngest::MissingSelfTeam => {
            if watch.warn_missing_self_team() {
                tracing::warn!(
                    root,
                    "probe builds bridge carries no self_team — whole frame dropped (the ally-only filter cannot run)"
                );
            }
        },
        BuildsIngest::Frame {
            battle,
            builds,
            key,
        } => {
            if watch.accept_key(key) {
                tracing::info!(
                    root,
                    battle = %battle,
                    allies = builds.len(),
                    "probe builds frame acquired"
                );
                let frame = IngameBuildsFrame { battle, builds };
                store_latest_builds(root, frame.clone());
                emit_builds(app, &frame);
            }
        },
        BuildsIngest::Clear { battle, key } => {
            if watch.accept_key(key) {
                tracing::info!(root, battle = %battle, "probe builds cleared (battle quit)");
                clear_latest_builds_for_root(root);
                emit_builds(
                    app,
                    &IngameBuildsFrame {
                        battle,
                        builds: Vec::new(),
                    },
                );
            }
        },
    }
}

/// One parsed `heartbeat.json` frame (the plugin rewrites it whole every
/// tick; see its Main.py `tick`).
struct HeartbeatFrame {
    /// `'load'` / `'port'` / `'battle'` — the probe's own phase report.
    phase: String,
    /// The heartbeat's freshness against the poll's clock (same cap as the
    /// telemetry payloads).
    fresh: bool,
    /// The probe's degraded-roster marker (`fb`, non-empty only while the
    /// telemetry session was synthesized instead of stabilized — `'walk'`
    /// = records dead, entity walk carrying the roster; `'records'` = a
    /// churning roster latched). `None` on older probe builds.
    fallback: Option<String>,
}

/// Parse one heartbeat frame. Missing `phase`/`t`, or an unparseable file,
/// reads as "no heartbeat" — the health state treats that as gone/stale.
fn parse_heartbeat(raw: &str, now_ms: i64) -> Option<HeartbeatFrame> {
    let value: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    let phase = value.get("phase")?.as_str()?.to_string();
    let t = payload_epoch_ms(&value)?;
    let fallback = value
        .get("fb")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Some(HeartbeatFrame {
        phase,
        fresh: now_ms - t <= TELEMETRY_STALE_MS,
        fallback,
    })
}

/// One probe-health transition worth a log line — the poller's
/// diagnosability layer over `heartbeat.json`. The heartbeat is the ONLY
/// channel that distinguishes "the probe never loaded" (no file at all)
/// from "loaded, healthy, in port" (`phase=port`, fresh) from "in a
/// battle but the roster bridge is failing" (`phase=battle` while
/// telemetry.json never appears) — exactly the states the 2026-10-11 CN360
/// report left indistinguishable in the app log. `phase=battle` rides the
/// game's own battleStart event in the probe bytes this app ships (older
/// probe builds required roster stabilization, so a schema-drifted client
/// kept reporting port through its battles and the WARN below could not
/// fire).
#[derive(Debug, PartialEq, Eq)]
enum ProbeHealthEvent {
    /// Fresh heartbeat seen for the first time (or regained after a loss).
    HeartbeatGained(String),
    /// Fresh heartbeat changed phase (port ↔ battle).
    HeartbeatPhase(String, String),
    /// Heartbeat went absent or stale while its client still runs.
    HeartbeatLost,
    /// The probe reports a battle but telemetry.json never appeared
    /// ([`BATTLE_TELEMETRY_GRACE_POLLS`] consecutive polls) — the roster
    /// path is failing on this build.
    BattleWithoutTelemetry,
    /// The probe's heartbeat carries the degraded-roster marker: this
    /// battle's telemetry session was synthesized from the fallback source
    /// (`walk` = records dead, the entity walk carrying the roster;
    /// `records` = a roster that churns every tick latched as-is). The
    /// stream is FLOWING — this is the evidence line for the build class
    /// the 2026-10-18/19 Steam/CN360 reports belong to, distinguishing
    /// "degraded but bridged" from a hard outage.
    RosterFallback(String),
}

/// How many consecutive battle-heartbeat polls with no readable telemetry
/// file arm the [`ProbeHealthEvent::BattleWithoutTelemetry`] WARN (the
/// poller's 2 s cadence makes this a ~30 s grace). A healthy battle's
/// first telemetry lands within a few seconds of battleStart (the probe
/// stabilizes its roster over three 1–2 s ticks); only a genuinely dead
/// roster bridge outlasts the grace, so loading screens never trip it.
const BATTLE_TELEMETRY_GRACE_POLLS: u8 = 15;

/// Per-root probe-health bookkeeping: what was last announced, so each
/// transition logs once instead of on every 2 s tick.
#[derive(Default)]
struct ProbeHealthState {
    phase: Option<String>,
    alive: bool,
    /// Consecutive fresh-`battle` polls with no telemetry file. Armed only
    /// at [`BATTLE_TELEMETRY_GRACE_POLLS`] — the grace swallows both the
    /// write-order race (the plugin writes the heartbeat before the
    /// telemetry of the same tick) and the loading-screen window between
    /// battleStart and the first stabilized roster write.
    battle_gaps: u8,
    warned_battle_without_telemetry: bool,
    /// The fallback source last announced this battle (see
    /// [`ProbeHealthEvent::RosterFallback`]); resets when the phase leaves
    /// battle so the next battle's degradation announces again.
    fallback_seen: Option<String>,
}

impl ProbeHealthState {
    /// Fold one poll's observation into the transition list. `hb` is the
    /// fresh heartbeat frame when one parsed (absent/stale files fold to
    /// `None` — phase, freshness, and the degraded-roster marker);
    /// `telemetry_readable` is whether this poll could read the telemetry
    /// file at all.
    fn observe(
        &mut self,
        hb: Option<(&str, bool, Option<&str>)>,
        telemetry_readable: bool,
    ) -> Vec<ProbeHealthEvent> {
        let mut events = Vec::new();
        let Some((phase, true, fallback)) = hb else {
            if self.alive {
                self.alive = false;
                self.phase = None;
                self.battle_gaps = 0;
                self.warned_battle_without_telemetry = false;
                self.fallback_seen = None;
                events.push(ProbeHealthEvent::HeartbeatLost);
            }
            return events;
        };
        let phase = phase.to_string();
        if !self.alive {
            self.alive = true;
            self.phase = Some(phase.clone());
            events.push(ProbeHealthEvent::HeartbeatGained(phase.clone()));
        } else if self.phase.as_deref() != Some(phase.as_str()) {
            let from = self.phase.take().unwrap_or_default();
            self.phase = Some(phase.clone());
            events.push(ProbeHealthEvent::HeartbeatPhase(from, phase.clone()));
        }
        if phase == "battle" {
            if telemetry_readable {
                self.battle_gaps = 0;
            } else {
                self.battle_gaps = self.battle_gaps.saturating_add(1);
                if self.battle_gaps >= BATTLE_TELEMETRY_GRACE_POLLS
                    && !self.warned_battle_without_telemetry
                {
                    self.warned_battle_without_telemetry = true;
                    events.push(ProbeHealthEvent::BattleWithoutTelemetry);
                }
            }
            // The degraded-roster marker announces once per source per
            // battle: the probe latches it for the whole battle, while the
            // poller only owes the log line at the transition.
            if let Some(source) = fallback {
                if self.fallback_seen.as_deref() != Some(source) {
                    self.fallback_seen = Some(source.to_string());
                    events.push(ProbeHealthEvent::RosterFallback(source.to_string()));
                }
            }
        } else {
            self.battle_gaps = 0;
            self.warned_battle_without_telemetry = false;
            self.fallback_seen = None;
        }
        events
    }
}

/// Log one probe-health transition (the poller's only consumer of
/// [`ProbeHealthState`] — lines land in the app log where a support bundle
/// finds them).
fn log_probe_health(event: &ProbeHealthEvent, root: &std::path::Path) {
    match event {
        ProbeHealthEvent::HeartbeatGained(phase) => tracing::info!(
            root = %root.display(),
            phase,
            "ingame probe heartbeat acquired"
        ),
        ProbeHealthEvent::HeartbeatPhase(from, to) => tracing::info!(
            root = %root.display(),
            from,
            to,
            "ingame probe heartbeat phase changed"
        ),
        ProbeHealthEvent::HeartbeatLost => tracing::info!(
            root = %root.display(),
            "ingame probe heartbeat lost (stale or gone)"
        ),
        ProbeHealthEvent::BattleWithoutTelemetry => tracing::warn!(
            root = %root.display(),
            "probe heartbeat reports a battle but telemetry is absent — the roster path is failing on this client build"
        ),
        ProbeHealthEvent::RosterFallback(source) => tracing::info!(
            root = %root.display(),
            source,
            "probe roster bridge degraded — telemetry session synthesized from the fallback source"
        ),
    }
}

/// Age cap for emitting a telemetry payload — the same freshness the
/// overlay consumer enforces on `wowsp://ingame-telemetry` (older payloads
/// are dropped there). The poller skips them at the source: the file's
/// existence alone says nothing about the plugin still running, and a dead
/// session's leftover must not reach any consumer as an emit.
const TELEMETRY_STALE_MS: i64 = 30_000;

/// A telemetry payload's `t` stamp (epoch milliseconds). The plugin writes
/// an integer today; the float parse is defensive against older or
/// hand-edited files.
fn payload_epoch_ms(value: &serde_json::Value) -> Option<i64> {
    let t = value.get("t")?;
    t.as_i64().or_else(|| t.as_f64().map(|f| f as i64))
}

/// The emit decision for one parsed payload: fresh only when it carries a
/// `t` no older than [`TELEMETRY_STALE_MS`]. A payload without `t` is
/// stale by definition (the overlay's own gate drops it the same way).
fn payload_fresh(value: &serde_json::Value, now_ms: i64) -> bool {
    match payload_epoch_ms(value) {
        Some(t) => now_ms - t <= TELEMETRY_STALE_MS,
        None => false,
    }
}

/// The per-instance companion of the plain telemetry event: EVERY running
/// install's stream, each payload tagged with the `root` it came from. The
/// main window's live panel listens here and keeps only the frames whose
/// root matches the install it serves — on multi-client machines (a Lesta
/// and a WG client both running their probe) that makes the exact TAB
/// ordering follow the CLIENT-VERSION selection instead of silently
/// following whichever install the backend prefers.
pub(crate) const TELEMETRY_WATCHED_EVENT: &str = "wowsp://ingame-telemetry-watched";

/// Spawn the detached telemetry poller: every 2 s it resolves the active
/// game install, reads the plugin's `telemetry.json` (written by the
/// in-game bridge on every alive-set change) and emits
/// `wowsp://ingame-telemetry` to every window when its content changed and
/// is fresh ([`TELEMETRY_STALE_MS`]). Both the live panel and the overlay
/// window listen for the same event — this is the M2 consumer that turns
/// the plugin's observations into authoritative sink marking and TAB
/// ordering.
///
/// Multi-instance machines: the poller walks EVERY running install's probe
/// file (one dedupe/freshness state per root). The PREFERRED root's frames
/// ride `wowsp://ingame-telemetry` unchanged (the overlay window and every
/// existing consumer keep seeing exactly one stream); every root — the
/// preferred one included — rides [`TELEMETRY_WATCHED_EVENT`] with a `root`
/// field stamped in, for consumers that select their stream themselves.
///
/// The poller is otherwise a best-effort publisher, but the CHAIN has been
/// hard to diagnose from the field (a silent gap anywhere looks identical
/// to "the feature is broken"), so state transitions log: file acquired /
/// lost, every emit at DEBUG with the alive count, and the probe-health
/// layer over `heartbeat.json` ([`ProbeHealthState`]) — acquired / phase
/// change / lost, plus a WARN when the probe reports a battle whose
/// telemetry never appears.
pub fn spawn_telemetry_poller(app: tauri::AppHandle) {
    /// Per-root poller bookkeeping: the telemetry stream's dedupe/liveness
    /// pair plus the probe-health transition state.
    #[derive(Default)]
    struct RootWatch {
        telemetry: (Option<String>, bool),
        health: ProbeHealthState,
        /// The builds.json ingestion state (content dedupe + the one-shot
        /// missing-self_team warning) — independent of the telemetry stream.
        builds: BuildsWatch,
    }
    let _ = std::thread::Builder::new()
        .name("ingame-telemetry-poll".into())
        .spawn(move || {
            let mut states: std::collections::HashMap<String, RootWatch> =
                std::collections::HashMap::new();
            loop {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let preferred_root = super::game_context::resolve_root(
                    super::game_context::RootPreference::PreferRunning,
                )
                .map(|r| r.root);
                let mut roots: Vec<std::path::PathBuf> = super::game_context::running_processes()
                    .into_iter()
                    .filter_map(|p| p.validated_root.map(std::path::PathBuf::from))
                    .collect();
                roots.sort();
                roots.dedup();
                // A root that stopped running drops its state (its leftover
                // file must not resume as "unchanged" if that client starts
                // another battle later) — but not before ONE last read+emit:
                // the probe clears `players` on quit and the consumers treat
                // an empty map as the reset that releases the authoritative
                // alive-sets/sort keys (LiveBattlePanel, the overlay). The
                // old single-root poller delivered that quit-clear through
                // its active-install fallback; without this final pass the
                // exit races the 2 s tick and a missed frame would pin the
                // battle's final sunk sets until the next battle.
                let mut evicted: Vec<String> = Vec::new();
                states.retain(|root, watch| {
                    let alive = roots.iter().any(|r| r == std::path::Path::new(root));
                    if !alive {
                        if watch.telemetry.1 {
                            tracing::info!(
                                root,
                                "ingame telemetry stream lost (client exited) — resuming inference"
                            );
                            evicted.push(root.clone());
                        }
                        return false;
                    }
                    true
                });
                for root in evicted {
                    // A dead client's build frame must not stay served as live
                    // data after its process is gone.
                    clear_latest_builds_for_root(&root);
                    if let Some(mut watch) = states.remove(&root) {
                        emit_once(
                            &app,
                            &root,
                            Some(&mut watch.telemetry),
                            &preferred_root,
                            now_unix_ms(),
                        );
                    }
                }
                for root in roots {
                    let root_key = root.display().to_string();
                    // The build bridge is read independently of telemetry.json:
                    // builds.json lands once when the roster stabilizes even on
                    // clients whose telemetry stream stays empty.
                    if let Some(raw) =
                        builds_file(&root).and_then(|p| std::fs::read_to_string(p).ok())
                    {
                        let watch = states.entry(root_key.clone()).or_default();
                        ingest_builds(&app, &root_key, &raw, &mut watch.builds, now_unix_ms());
                    }
                    let Some(path) = telemetry_file(&root) else {
                        continue;
                    };
                    // The heartbeat read is independent of the telemetry
                    // file: a probe that never enters a battle still
                    // heartbeats from load, and that distinction is what
                    // the health layer exists to log.
                    let heartbeat = heartbeat_file(&root)
                        .and_then(|p| std::fs::read_to_string(p).ok())
                        .and_then(|raw| parse_heartbeat(&raw, now_unix_ms()));
                    let raw = std::fs::read_to_string(&path).ok();
                    let watch = states.entry(root_key).or_default();
                    for event in watch.health.observe(
                        heartbeat
                            .as_ref()
                            .map(|h| (h.phase.as_str(), h.fresh, h.fallback.as_deref())),
                        raw.is_some(),
                    ) {
                        log_probe_health(&event, &root);
                    }
                    let Some(raw) = raw else {
                        if watch.telemetry.1 {
                            watch.telemetry.1 = false;
                            tracing::info!(
                                root = %root.display(),
                                "ingame telemetry stream lost (file gone) — resuming inference"
                            );
                        }
                        continue;
                    };
                    if !watch.telemetry.1 {
                        watch.telemetry.1 = true;
                        tracing::info!(path = %path.display(), "ingame telemetry stream acquired");
                    }
                    let root = root.display().to_string();
                    if let Some(value) =
                        parse_fresh_frame(&raw, &mut watch.telemetry, &root, now_unix_ms())
                    {
                        dispatch_fresh_frame(&app, &root, value, &preferred_root);
                    }
                }
            }
        });
}

/// Wall clock in unix milliseconds (the payload freshness base).
fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Dedupe + parse + freshness over one root's raw file content. Mutates the
/// dedupe slot (a parseable payload must always enter it — a half-written
/// read must not poison the next good rewrite into "unchanged"), logs at
/// the same points the single-root poller always did, and answers the value
/// to emit.
fn parse_fresh_frame(
    raw: &str,
    state: &mut (Option<String>, bool),
    root: &str,
    now_ms: i64,
) -> Option<serde_json::Value> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 262_144 || state.0.as_deref() == Some(raw) {
        return None;
    }
    // Only emit parseable JSON: a half-written file (the plugin rewrites
    // whole, but the reader can still race the write) must not poison the
    // dedupe — otherwise the good rewrite would be swallowed as "unchanged"
    // while windows never saw it.
    let value = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    state.0 = Some(raw.to_owned());
    if !payload_fresh(&value, now_ms) {
        // Parseable but old (a dead session's leftover): it entered the
        // dedupe above, so this logs once per content and the live rewrite
        // still emits.
        tracing::debug!(root, "ingame telemetry payload stale — emit skipped");
        return None;
    }
    Some(value)
}

/// The one consumer of a FRESH parsed frame, shared by the poll loop and
/// the eviction path's final read: the frame first feeds the probe-arena
/// registry (a new `battle` id on a client that never writes
/// tempArenaInfo.json — the 2026-10-20 field report — is the ONLY place
/// that battle surfaces, so the synthesized roster goes straight into
/// the arena pipeline; the quit-clear/absence frames end it there), then
/// rides the telemetry streams as before.
fn dispatch_fresh_frame(
    app: &tauri::AppHandle,
    root: &str,
    value: serde_json::Value,
    preferred_root: &Option<std::path::PathBuf>,
) {
    let replays_dir = super::game_context::replays_dir(std::path::Path::new(root));
    match super::probe_arena::note_telemetry(std::path::Path::new(root), &value, now_unix_ms()) {
        Some(super::probe_arena::NewProbeBattle::Serve) => {
            // The CLAIM (not the verdict) gates the serve: a read path
            // that already served this battle wins the race, and this
            // poller skips its duplicate emit (see try_claim_serve).
            if let Some(claim) = super::probe_arena::try_claim_serve(&replays_dir, now_unix_ms()) {
                super::arena_info::serve_probe_battle(
                    app,
                    &replays_dir,
                    &claim.info,
                    claim.stamp_unix,
                );
            }
        },
        // A file-writing client's battle: the file pipeline owns it, the
        // probe's copy stays out of the way (see probe_arena).
        Some(super::probe_arena::NewProbeBattle::FileOwned) => {},
        None => {},
    }
    emit_frame(app, root, value, preferred_root);
}

/// Read one root's file (when still present) and emit its final frame —
/// the eviction path's quit-clear delivery (see the loop comment).
fn emit_once(
    app: &tauri::AppHandle,
    root: &str,
    state: Option<&mut (Option<String>, bool)>,
    preferred_root: &Option<std::path::PathBuf>,
    now_ms: i64,
) {
    let Some(state) = state else { return };
    let Some(path) = telemetry_file(std::path::Path::new(root)) else {
        return;
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return;
    };
    if let Some(value) = parse_fresh_frame(&raw, state, root, now_ms) {
        dispatch_fresh_frame(app, root, value, preferred_root);
    }
}

/// Emit one parsed frame: the plain stream for the preferred root (spelling
/// -insensitive identity — the resolved preferred root may come from the
/// active-install tier whose path spelling differs from the exe-derived
/// root), and the watched stream for every root with its `root` stamped.
fn emit_frame(
    app: &tauri::AppHandle,
    root: &str,
    mut value: serde_json::Value,
    preferred_root: &Option<std::path::PathBuf>,
) {
    let alive = value
        .get("players")
        .and_then(|p| p.as_object())
        .map(|m| m.len())
        .unwrap_or(0);
    tracing::debug!(alive, root, "ingame telemetry emitted");
    let is_preferred = preferred_root
        .as_ref()
        .is_some_and(|p| super::game_context::same_folder(&p.to_string_lossy(), root));
    if is_preferred {
        if let Err(e) = app.emit("wowsp://ingame-telemetry", &value) {
            tracing::warn!(error = %e, "emit ingame-telemetry failed");
        }
    }
    // The per-instance stream tags its origin; consumers match it against
    // the install they serve.
    if let Some(obj) = value.as_object_mut() {
        obj.insert("root".into(), serde_json::Value::String(root.to_owned()));
    }
    if let Err(e) = app.emit(TELEMETRY_WATCHED_EVENT, &value) {
        tracing::warn!(error = %e, "emit ingame-telemetry-watched failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PnF presence accepts every real-world entry spelling: plain Main.py,
    /// Aslain's compiled Main.pyc, and either's disabled `.bak` twin — a
    /// disabled mod must still keep the shared loader marker alive.
    #[test]
    fn has_pnf_mods_covers_pyc_and_disabled_spellings() {
        let tmp = std::env::temp_dir().join("wowsp_haspnf");
        let _ = std::fs::remove_dir_all(&tmp);
        let rm = tmp.join("res_mods");
        let mk = |entry: &str| {
            let _ = std::fs::remove_dir_all(&rm);
            std::fs::create_dir_all(rm.join("PnFMods/Mod")).unwrap();
            std::fs::write(rm.join("PnFMods/Mod").join(entry), b"x").unwrap();
            let got = has_pnf_mods(&rm);
            std::fs::remove_dir_all(&rm).unwrap();
            got
        };
        assert!(mk("Main.py"), "plain entry counts");
        assert!(mk("Main.pyc"), "compiled entry counts (Aslain ships these)");
        assert!(mk("Main.py.bak"), "disabled twin counts");
        assert!(mk("Main.pyc.bak"), "disabled compiled twin counts");

        // An empty PnFMods skeleton carries no loadable mod.
        std::fs::create_dir_all(rm.join("PnFMods/Empty")).unwrap();
        assert!(!has_pnf_mods(&rm));
        // No PnFMods at all.
        std::fs::remove_dir_all(rm.join("PnFMods")).unwrap();
        assert!(!has_pnf_mods(&rm));

        std::fs::remove_dir_all(&tmp).ok();
    }

    /// A minimal versioned install: one `bin/<build>` carrying `idx/`,
    /// pinned by `preferences.xml` so `res_mods_dir` resolves without a
    /// real client. The temp tree is recreated fresh on every call.
    fn fixture_game_root(tag: &str) -> std::path::PathBuf {
        let tmp = std::env::temp_dir().join(format!("wowsp_probe_install_{tag}"));
        let _ = std::fs::remove_dir_all(&tmp);
        let game = tmp.join("game");
        let build = game.join("bin").join("100");
        std::fs::create_dir_all(build.join("idx")).unwrap();
        std::fs::write(
            game.join("preferences.xml"),
            "<root><last_server_version> 15,8,0,100 </last_server_version></root>",
        )
        .unwrap();
        game
    }

    #[test]
    fn install_wipes_stale_runtime_bridge_files() {
        let game = fixture_game_root("wipe_live");
        let res_mods = super::super::game_context::res_mods_dir(&game).unwrap();
        let probe_dir = res_mods.join("PnFMods").join(MOD_DIR);
        std::fs::create_dir_all(&probe_dir).unwrap();
        std::fs::write(probe_dir.join(MOD_ENTRY), "stale entry").unwrap();
        // Literal names, not [`RUNTIME_BRIDGE_FILES`] itself: the wipe list
        // is the plugin's bridge contract, and dropping a name from the
        // const must fail here.
        let runtime_files = [
            "telemetry.json",
            "heartbeat.json",
            "request.json",
            "response.json",
            "roster_raw.json",
            "roster_journal.jsonl",
            "manual_refresh.flag",
            "order_probe.json",
            "builds.json",
        ];
        assert_eq!(runtime_files, RUNTIME_BRIDGE_FILES);
        for file in runtime_files {
            std::fs::write(probe_dir.join(file), "stale session state").unwrap();
        }

        let mod_dir =
            std::path::PathBuf::from(install_probe_files(&game.to_string_lossy()).unwrap());

        for file in runtime_files {
            assert!(!mod_dir.join(file).exists(), "{file} survived the install");
        }
        // The shipped entry replaced the stranded one.
        assert_eq!(
            std::fs::read(mod_dir.join(MOD_ENTRY)).unwrap(),
            PLUGIN_SOURCE.as_bytes()
        );
        std::fs::remove_dir_all(game.parent().unwrap()).ok();
    }

    #[test]
    fn install_wipes_runtime_files_in_preload_twins() {
        let game = fixture_game_root("wipe_twin");
        // A complete staged build numerically above the pin — the twin the
        // mirror fan-out targets.
        let twin_res_mods = game.join("bin").join("200").join("res_mods");
        let twin_probe = twin_res_mods.join("PnFMods").join(MOD_DIR);
        std::fs::create_dir_all(game.join("bin").join("200").join("idx")).unwrap();
        std::fs::create_dir_all(&twin_probe).unwrap();
        std::fs::write(twin_probe.join(MOD_ENTRY), "twin entry").unwrap();
        std::fs::write(twin_probe.join("telemetry.json"), "stale").unwrap();

        install_probe_files(&game.to_string_lossy()).unwrap();

        assert!(
            !twin_probe.join("telemetry.json").exists(),
            "twin kept the dead session's telemetry"
        );
        // The mirrored copy of the shipped entry is in place.
        assert_eq!(
            std::fs::read(twin_probe.join(MOD_ENTRY)).unwrap(),
            PLUGIN_SOURCE.as_bytes()
        );
        std::fs::remove_dir_all(game.parent().unwrap()).ok();
    }

    /// The status payload must let the UI tell safe-mode quarantine apart
    /// from a genuinely missing plugin: while safe mode is on, the whole
    /// res_mods is renamed to `res_mods.wowsp-disabled`, so `installed`
    /// reads false even though the probe files are all still there. The
    /// probe entry sits in the live tree first (installed, not
    /// quarantined), then the quarantine rename flips the report to
    /// "not installed AND safe mode on" — exactly the pair the recovery
    /// prompt keys on, instead of an install offer the backend refuses.
    #[test]
    fn status_reports_safe_mode_beside_the_live_install() {
        let game = std::env::temp_dir().join("wowsp-probe-status-safe-mode");
        let _ = std::fs::remove_dir_all(&game);
        let ver_dir = game.join("bin").join("42");
        let res_mods = ver_dir.join("res_mods");
        let probe_dir = res_mods.join("PnFMods").join(MOD_DIR);
        std::fs::create_dir_all(&probe_dir).unwrap();
        std::fs::write(probe_dir.join(MOD_ENTRY), PLUGIN_SOURCE).unwrap();

        let status = ingame_plugin_status(game.to_string_lossy().into_owned()).unwrap();
        assert!(status.installed, "the live tree carries the probe entry");
        assert!(!status.safe_mode, "nothing is quarantined yet");

        // Safe mode's one atomic rename (the shape mod_hub applies): the
        // files survive, the LIVE res_mods path does not.
        std::fs::rename(&res_mods, ver_dir.join("res_mods.wowsp-disabled")).unwrap();
        let status = ingame_plugin_status(game.to_string_lossy().into_owned()).unwrap();
        assert!(
            !status.installed,
            "the live res_mods tree is gone — that is the in-game truth"
        );
        assert!(
            status.safe_mode,
            "the quarantine must be reported, not read as a missing plugin"
        );

        std::fs::remove_dir_all(&game).ok();
    }

    #[test]
    fn telemetry_freshness_rules() {
        let now = 1_800_000_000_000i64;
        let fresh = serde_json::json!({ "t": now - 1_000, "players": {} });
        let boundary = serde_json::json!({ "t": now - 30_000, "players": {} });
        let stale = serde_json::json!({ "t": now - 31_000, "players": {} });
        let float_t = serde_json::json!({ "t": (now - 500) as f64, "players": {} });
        let no_stamp = serde_json::json!({ "players": {} });

        assert!(payload_fresh(&fresh, now));
        assert!(payload_fresh(&boundary, now), "exactly the cap is fresh");
        assert!(!payload_fresh(&stale, now));
        assert!(payload_fresh(&float_t, now), "float stamps parse");
        assert_eq!(payload_epoch_ms(&float_t), Some(now - 500));
        assert!(!payload_fresh(&no_stamp, now), "no t — stale by definition");
    }

    /// The heartbeat parser answers the probe's own phase + freshness;
    /// everything else (missing keys, junk) reads as "no heartbeat".
    #[test]
    fn heartbeat_parses_phase_and_freshness() {
        // A frame written at t=1000 polled at t=2000: fresh.
        let port = parse_heartbeat(
            r#"{"v":"0.1.0","t":1000,"phase":"port","players":0,"revision":-1}"#,
            2_000,
        )
        .map(|h| (h.phase, h.fresh));
        assert_eq!(port, Some(("port".to_string(), true)));
        // The same frame polled eons later: stale.
        let battle = parse_heartbeat(
            r#"{"v":"0.1.0","t":1000,"phase":"battle","players":12,"revision":3}"#,
            1_800_000_000_000,
        )
        .map(|h| (h.phase, h.fresh));
        assert_eq!(battle, Some(("battle".to_string(), false)));
        assert!(
            parse_heartbeat(r#"{"t":1000}"#, 2_000).is_none(),
            "no phase"
        );
        assert!(
            parse_heartbeat(r#"{"phase":"port"}"#, 2_000).is_none(),
            "no t"
        );
        assert!(parse_heartbeat("", 2_000).is_none());
        assert!(parse_heartbeat("not json", 2_000).is_none());
    }

    /// The probe-health transitions: gained → phase change → lost, with the
    /// battle-without-telemetry WARN confirmed over two polls (the plugin
    /// writes the heartbeat of a tick before its telemetry — a one-poll gap
    /// is that write order, two is a failing roster path) and re-armed when
    /// the phase leaves battle.
    #[test]
    fn probe_health_transitions() {
        let mut health = ProbeHealthState::default();
        // Silence before the first frame: nothing to announce.
        assert!(health.observe(None, false).is_empty());
        // First fresh heartbeat (port): announced once.
        assert_eq!(
            health.observe(Some(("port", true, None)), false),
            vec![ProbeHealthEvent::HeartbeatGained("port".into())]
        );
        assert!(health.observe(Some(("port", true, None)), false).is_empty());
        // Battle begins, telemetry flowing: just the phase change.
        assert_eq!(
            health.observe(Some(("battle", true, None)), true),
            vec![ProbeHealthEvent::HeartbeatPhase(
                "port".into(),
                "battle".into()
            )]
        );
        assert!(
            health
                .observe(Some(("battle", true, None)), true)
                .is_empty()
        );
        // The CN360 failure shape: battle heartbeat, no telemetry file.
        // The grace window (write-order race + the loading screen between
        // battleStart and the first stabilized write) stays silent; the
        // WARN arms once the gap outlasts it, exactly once per battle.
        for _ in 0..(BATTLE_TELEMETRY_GRACE_POLLS - 1) {
            assert!(
                health
                    .observe(Some(("battle", true, None)), false)
                    .is_empty(),
                "inside the grace window the gap stays silent"
            );
        }
        assert_eq!(
            health.observe(Some(("battle", true, None)), false),
            vec![ProbeHealthEvent::BattleWithoutTelemetry]
        );
        assert!(
            health
                .observe(Some(("battle", true, None)), false)
                .is_empty(),
            "the WARN latches once per battle"
        );
        // Back to port re-arms the warning for the next battle.
        assert_eq!(
            health.observe(Some(("port", true, None)), true),
            vec![ProbeHealthEvent::HeartbeatPhase(
                "battle".into(),
                "port".into()
            )]
        );
        assert_eq!(
            health.observe(Some(("battle", true, None)), false),
            vec![ProbeHealthEvent::HeartbeatPhase(
                "port".into(),
                "battle".into()
            )]
        );
        for _ in 0..(BATTLE_TELEMETRY_GRACE_POLLS - 2) {
            assert!(
                health
                    .observe(Some(("battle", true, None)), false)
                    .is_empty()
            );
        }
        assert_eq!(
            health.observe(Some(("battle", true, None)), false),
            vec![ProbeHealthEvent::BattleWithoutTelemetry]
        );
        // A stale/absent heartbeat while the client still runs: lost once,
        // and the next fresh frame announces as gained again.
        assert_eq!(
            health.observe(None, false),
            vec![ProbeHealthEvent::HeartbeatLost]
        );
        assert!(health.observe(None, false).is_empty());
        assert_eq!(
            health.observe(Some(("port", false, None)), false),
            Vec::<ProbeHealthEvent>::new(),
            "a stale frame is no heartbeat at all"
        );
        assert_eq!(
            health.observe(Some(("port", true, None)), false),
            vec![ProbeHealthEvent::HeartbeatGained("port".into())]
        );
    }

    /// The degraded-roster marker (`fb`): parsed off the heartbeat, empty
    /// and missing keys read as None, and the RosterFallback event announces
    /// once per source per battle — re-announcing after the phase leaves
    /// battle and staying silent while the marker holds.
    #[test]
    fn roster_fallback_announces_once_per_battle() {
        // Parsing: a non-empty marker survives, empty/missing fold to None.
        let frame = parse_heartbeat(
            r#"{"v":"0.1.0","t":1000,"phase":"battle","players":12,"rec":0,"fb":"walk"}"#,
            2_000,
        )
        .expect("frame parses");
        assert_eq!(frame.phase, "battle");
        assert_eq!(frame.fallback.as_deref(), Some("walk"));
        assert_eq!(
            parse_heartbeat(r#"{"v":"0.1.0","t":1000,"phase":"battle","fb":""}"#, 2_000)
                .expect("frame parses")
                .fallback,
            None
        );

        let mut health = ProbeHealthState::default();
        // Battle with the marker and telemetry flowing (the fixed shape):
        // the phase change and the fallback land together on the first
        // poll, then silence while the marker holds.
        let mut events = health.observe(Some(("battle", true, Some("walk"))), true);
        assert!(events.contains(&ProbeHealthEvent::RosterFallback("walk".into())));
        assert!(
            health
                .observe(Some(("battle", true, Some("walk"))), true)
                .is_empty()
        );
        // A source switch mid-battle (records recovered enough to change
        // the synthesis source) announces the new one.
        events = health.observe(Some(("battle", true, Some("records"))), true);
        assert_eq!(
            events,
            vec![ProbeHealthEvent::RosterFallback("records".into())]
        );
        // Leaving battle clears the latch: the next battle re-announces.
        assert_eq!(
            health.observe(Some(("port", true, None)), true),
            vec![ProbeHealthEvent::HeartbeatPhase(
                "battle".into(),
                "port".into()
            )]
        );
        events = health.observe(Some(("battle", true, Some("walk"))), true);
        assert!(events.contains(&ProbeHealthEvent::RosterFallback("walk".into())));
        // Old probe builds carry no marker at all: nothing ever announces.
        assert!(
            health
                .observe(Some(("battle", true, None)), true)
                .is_empty()
        );
    }

    // ── builds.json bridge (probe -> ally-only IPC) ───────────────────────

    /// A valid 15.9 SHIP_CONFIG blob: header, 1 unit, 1 modernization, no
    /// exteriors, 2 ability slots and 1 ecoboost. Mirrors the replay parser's
    /// verified layout so the probe path exercises the SAME parser.
    fn sample_ship_config_blob(ship_params_id: u32) -> Vec<u8> {
        fn push(out: &mut Vec<u8>, values: &[u32]) {
            for value in values {
                out.extend_from_slice(&value.to_le_bytes());
            }
        }
        let mut blob = Vec::new();
        push(&mut blob, &[1, ship_params_id, 0, 1]); // version, ship, elem, units
        push(&mut blob, &[100]); // one hull slot
        push(&mut blob, &[0]); // >= 13.2 unknown
        push(&mut blob, &[1, 0xff12_cfb0]); // modernization
        push(&mut blob, &[0]); // exteriors
        push(&mut blob, &[0]); // supply state
        push(&mut blob, &[0]); // color schemes
        push(&mut blob, &[0]); // >= 15.9 unknown
        push(&mut blob, &[2, 0xff62_9fb0, 0xff12_9fb0]); // ability slots
        push(&mut blob, &[0]); // ensign slots
        push(&mut blob, &[1, 0xff2f_efb0]); // ecoboost slots
        blob
    }

    fn hex_body(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn b64_body(bytes: &[u8]) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// One planted builds.json document at a given write timestamp.
    fn builds_doc_json(players: serde_json::Value, self_team: Option<i64>, t: i64) -> String {
        let mut doc = serde_json::json!({
            "v": 1,
            "t": t,
            "battle": "1800000000000",
            "players": players,
        });
        if let Some(team) = self_team {
            doc["self_team"] = serde_json::json!(team);
        }
        doc.to_string()
    }

    /// One planted player row (hex dump, optionally with a crew block).
    fn probe_row(team: i64, ship_params_id: u32, with_crew: bool) -> serde_json::Value {
        let mut row = serde_json::json!({
            "team": team,
            "ship_params_id": ship_params_id,
            "dump_enc": "hex",
            "dump": hex_body(&sample_ship_config_blob(ship_params_id)),
        });
        if with_crew {
            row["crew"] = serde_json::json!({
                "params_id": 310_000_000u32,
                "is_in_adaptation": 1,
                "learned_skills": [[1, 2, 3], [4, 5]],
            });
        }
        row
    }

    /// Hex and base64 bodies decode to the same bytes and the same parsed
    /// SHIP_CONFIG sections; malformed bodies are refused.
    #[test]
    fn probe_dump_decodes_identically_from_hex_and_base64() {
        let blob = sample_ship_config_blob(4_065_212_112);
        let from_hex = decode_probe_dump("hex", &hex_body(&blob)).expect("hex dump");
        let from_b64 = decode_probe_dump("b64", &b64_body(&blob)).expect("base64 dump");
        assert_eq!(from_hex, from_b64);
        assert_eq!(from_hex, blob);
        let config = wowsp_replay_core::decode_ship_config_blob(&from_hex, BUILDS_SHIP_CONFIG_ERA)
            .expect("planted blob decodes");
        assert_eq!(config.ship_params_id, 4_065_212_112);
        assert_eq!(config.units, [100]);
        assert_eq!(config.modernization, [0xff12_cfb0]);
        assert_eq!(config.abilities, [0xff62_9fb0, 0xff12_9fb0]);
        assert_eq!(config.ecoboosts, [0xff2f_efb0]);
        assert!(decode_probe_dump("hex", "abc").is_none());
        assert!(decode_probe_dump("b64", "!!!").is_none());
        assert!(decode_probe_dump("raw", "00").is_none());
        // A drifted blob (garbage after the header) fails the parser instead of
        // mis-reading ids.
        assert!(
            wowsp_replay_core::decode_ship_config_blob(
                &[1u8, 0, 0, 0, 9, 9, 9, 9, 255, 255],
                BUILDS_SHIP_CONFIG_ERA
            )
            .is_none()
        );
    }

    /// The ally-only rule + the optional crew block: enemy rows are dropped,
    /// crew-less rows keep zero/empty crew fields (never fabricated).
    #[test]
    fn builds_ingest_filters_to_self_team_and_keeps_crew_optional() {
        let players = serde_json::json!({
            "Ally": probe_row(1, 4_065_212_112, true),
            "Foe": probe_row(0, 3_750_639_408, true),
            "Teammate": probe_row(1, 4_180_555_728, false),
        });
        let raw = builds_doc_json(players, Some(1), 1_800_000_000_000);
        let doc = parse_probe_builds(&raw).expect("planted document parses");
        let BuildsIngest::Frame { battle, builds, .. } = builds_ingest(doc, 1_800_000_000_500)
        else {
            panic!("expected a frame");
        };
        assert_eq!(battle, "1800000000000");
        assert_eq!(builds.len(), 2, "the enemy row never reaches IPC");
        let names: Vec<&str> = builds
            .iter()
            .map(|build| build.name.as_deref().unwrap_or(""))
            .collect();
        assert_eq!(names, ["Ally", "Teammate"]);
        let ally = &builds[0];
        assert_eq!(ally.entity_id, 0, "probe builds join by name");
        assert_eq!(ally.ship_params_id, 4_065_212_112);
        assert_eq!(ally.modernization, [0xff12_cfb0]);
        assert_eq!(ally.abilities, [0xff62_9fb0, 0xff12_9fb0]);
        assert_eq!(ally.crew_params_id, 310_000_000);
        assert!(ally.is_in_adaptation);
        assert_eq!(ally.learned_skills, [vec![1, 2, 3], vec![4, 5]]);
        let teammate = &builds[1];
        assert_eq!(teammate.crew_params_id, 0);
        assert!(teammate.learned_skills.is_empty());
        assert!(!teammate.is_in_adaptation);
    }

    /// A probe that cannot name the local player carries no usable team
    /// ownership: the whole frame is dropped and the warning latches once.
    #[test]
    fn missing_self_team_drops_the_frame_and_warns_once() {
        let players = serde_json::json!({"Ally": probe_row(1, 4_065_212_112, false)});
        let raw = builds_doc_json(players, None, 1_800_000_000_000);
        let doc = parse_probe_builds(&raw).expect("document parses");
        assert!(matches!(
            builds_ingest(doc, 1_800_000_000_000),
            BuildsIngest::MissingSelfTeam
        ));
        // A self_team outside 0/1 is equally unusable.
        let players = serde_json::json!({"Ally": probe_row(1, 4_065_212_112, false)});
        let raw = builds_doc_json(players, Some(7), 1_800_000_000_000);
        let doc = parse_probe_builds(&raw).expect("document parses");
        assert!(matches!(
            builds_ingest(doc, 1_800_000_000_000),
            BuildsIngest::MissingSelfTeam
        ));
        let mut watch = BuildsWatch::default();
        assert!(watch.warn_missing_self_team(), "first frame warns");
        assert!(!watch.warn_missing_self_team(), "warn once per root");
    }

    /// The probe's quit-clear blanks the players map and keeps the finished
    /// battle id: the snapshot clears and repeated ticks stay deduped.
    #[test]
    fn quit_clear_clears_the_snapshot_frame() {
        let raw = r#"{"v":1,"t":1800000000000,"battle":"1800000000000","players":{}}"#;
        let doc = parse_probe_builds(raw).expect("quit-clear parses");
        let BuildsIngest::Clear { battle, key } = builds_ingest(doc, 1_800_000_000_100) else {
            panic!("expected a clear");
        };
        assert_eq!(battle, "1800000000000");
        let mut watch = BuildsWatch::default();
        assert!(watch.accept_key(key));
        assert!(!watch.accept_key(key), "a repeated quit-clear is deduped");
    }

    /// The content key tracks the payload (dumps + crew), not the rewrite
    /// timestamp, so the once-per-battle file emits once; a changed dump
    /// re-emits.
    #[test]
    fn build_content_key_ignores_timestamp_and_tracks_dump_changes() {
        let players = serde_json::json!({"Ally": probe_row(1, 4_065_212_112, true)});
        let first = parse_probe_builds(&builds_doc_json(
            players.clone(),
            Some(1),
            1_800_000_000_000,
        ))
        .unwrap();
        let second = parse_probe_builds(&builds_doc_json(
            players.clone(),
            Some(1),
            1_800_000_001_000,
        ))
        .unwrap();
        assert_eq!(
            builds_content_key(&first),
            builds_content_key(&second),
            "t is not content"
        );
        let other = serde_json::json!({"Ally": probe_row(1, 3_750_639_408, true)});
        let third =
            parse_probe_builds(&builds_doc_json(other, Some(1), 1_800_000_000_000)).unwrap();
        assert_ne!(
            builds_content_key(&first),
            builds_content_key(&third),
            "a changed dump re-emits"
        );
        let mut watch = BuildsWatch::default();
        assert!(watch.accept_key(builds_content_key(&first)));
        assert!(!watch.accept_key(builds_content_key(&second)));
        assert!(watch.accept_key(builds_content_key(&third)));
    }

    /// Stale / contract-violating files are skipped; a single unreadable dump
    /// only drops that row; oversize bodies and the double-encoded JSON shape
    /// are handled without panics.
    #[test]
    fn stale_or_malformed_build_frames_are_skipped() {
        let now = 1_800_000_000_000i64;
        let players = serde_json::json!({"Ally": probe_row(1, 4_065_212_112, false)});
        // Stale: older than the bridge's battle-lifetime cap (a leftover).
        let stale = parse_probe_builds(&builds_doc_json(
            players.clone(),
            Some(1),
            now - BUILDS_STALE_MS - 1,
        ))
        .unwrap();
        assert!(matches!(builds_ingest(stale, now), BuildsIngest::Skip));
        // Non-v1 / junk / no timestamp.
        assert!(parse_probe_builds(r#"{"v":2,"players":{}}"#).is_none());
        assert!(parse_probe_builds("not json").is_none());
        assert!(parse_probe_builds(r#"{"v":1,"players":{}}"#).is_some());
        // A drifted / unparseable dump only drops that row, never the frame.
        let bad =
            serde_json::json!({"Ally": {"team":1,"dump_enc":"hex","dump":"01000000deadbeef"}});
        let doc = parse_probe_builds(&builds_doc_json(bad, Some(1), now)).unwrap();
        let BuildsIngest::Frame { builds, .. } = builds_ingest(doc, now) else {
            panic!("expected a frame");
        };
        assert!(builds.is_empty(), "undecodable dump skipped");
        // Oversize body (mirror of the probe's own dump cap).
        let huge = "0".repeat(BUILDS_MAX_DUMP_CHARS + 2);
        let oversize = serde_json::json!({"Ally": {"team":1,"dump_enc":"hex","dump":huge}});
        let doc = parse_probe_builds(&builds_doc_json(oversize, Some(1), now)).unwrap();
        assert!(matches!(
            builds_ingest(doc, now),
            BuildsIngest::Frame { builds, .. } if builds.is_empty()
        ));
        // The probe's full-encode shape: the whole document as a JSON string.
        let inner = builds_doc_json(players, Some(1), now);
        let double = serde_json::to_string(&serde_json::Value::String(inner)).unwrap();
        assert!(parse_probe_builds(&double).is_some());
    }

    /// The snapshot command serves the latest ally-only frame; an exited
    /// root's frame is cleared without touching another root's.
    #[test]
    fn latest_snapshot_round_trips_and_clears_per_root() {
        let frame = IngameBuildsFrame {
            battle: "1800000000000".into(),
            builds: Vec::new(),
        };
        store_latest_builds("C:/root/a", frame.clone());
        assert_eq!(ingame_builds_snapshot(), Some(frame.clone()));
        clear_latest_builds_for_root("C:/root/b");
        assert_eq!(
            ingame_builds_snapshot(),
            Some(frame),
            "another root's frame is untouched"
        );
        clear_latest_builds_for_root("C:/root/a");
        assert_eq!(ingame_builds_snapshot(), None);
    }

    #[test]
    fn builds_file_hangs_off_the_probe_dir() {
        let game = fixture_game_root("builds_file");
        let path = builds_file(&game).expect("versioned install resolves res_mods");
        let text = path.to_string_lossy();
        assert!(text.contains(MOD_DIR), "path under the probe dir: {text}");
        assert!(text.ends_with(".json"), "path: {text}");
        assert!(text.contains("builds"), "path: {text}");
        std::fs::remove_dir_all(game.parent().unwrap()).ok();
    }
}
