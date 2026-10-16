//! Replay directory walks and the listing commands (paths-only and
//! metadata-rich), the native file picker, and the replay-dir resolution the
//! pairing flows share. Split from the former single-file `commands/replay.rs`.

use anyhow::{Result, anyhow};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use wowsp_tauri_shared::{CommandResult, GameInstall, ReplayMetaLite};

use super::meta::lite_from_path;

// The replay-container extension test lives in the per-client compat
// registry (commands/game_client.rs); the walk below keeps calling it by its
// plain name.
use super::game_client::is_replay_extension;

/// Open a native multi-select file dialog for `.wowsreplay` files anywhere on
/// disk (replays shared from other players live outside the game's replays
/// folder). Returns the picked absolute paths; an empty vec means the user
/// cancelled. Picked files are opened through the same
/// [`read_replay_header`] / [`read_replay_positions`] commands as regular
/// replays — both accept arbitrary paths.
#[tauri::command]
pub async fn pick_replay_files() -> CommandResult<Vec<String>> {
    // Mobile: replays arrive through the pairing / document-picker flow (a
    // later mobile phase), not a desktop-style multi-select dialog.
    #[cfg(mobile)]
    {
        return Err(anyhow::anyhow!(crate::mobile_unsupported::PICKER).into());
    }
    // rfd pumps its own message loop — run it on a blocking thread, never
    // the async runtime workers or the app's UI thread.
    #[cfg(desktop)]
    {
        let picked = tokio::task::spawn_blocking(|| {
            rfd::FileDialog::new()
                .set_title("Select World of Warships replays")
                .add_filter("World of Warships replay", &["wowsreplay"])
                .add_filter("Lesta Мир кораблей replay", &["korablireplay"])
                .pick_files()
        })
        .await
        .map_err(|e| anyhow!("replay file picker task failed: {e}"))?;
        Ok(picked
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect())
    }
}

/// List `.wowsreplay` files under a directory (defaults to the resolved
/// default replay dir — the unified game context's user-scoped order).
/// Returns at most `limit` paths sorted newest-first — every replay when
/// `limit` is omitted. The walk recurses into the per-version archive
/// subfolders the game keeps under `replays/` (e.g. `replays/14.5.0.0/`),
/// which can hold many hundreds of files past what the root folder keeps,
/// so an implicit cap would silently drop a player's archived history.
///
/// Async command + [`tokio::task::spawn_blocking`]: the recursive directory
/// walk + per-file metadata reads are blocking I/O that must never run on the
/// UI thread (Tauri 2 synchronous commands do) — same rule as
/// [`read_replay_header`].
#[tauri::command]
pub async fn list_replays(dir: Option<String>, limit: Option<usize>) -> CommandResult<Vec<String>> {
    Ok(tokio::task::spawn_blocking(move || {
        let dir = resolve_replay_dir(dir)?;
        let mut entries: Vec<WalkedReplay> = Vec::new();
        walk_replays(&dir, &mut entries);
        use std::cmp::Reverse;
        entries.sort_by_key(|e| Reverse(e.mtime));
        // No implicit cap (see the command doc): only an explicit `limit`
        // truncates, so version-archive subfolders are never silently
        // dropped once a tree grows past any fixed default.
        let limit = limit.unwrap_or(usize::MAX);
        Ok::<_, anyhow::Error>(
            entries
                .into_iter()
                .take(limit)
                .map(|e| e.path.to_string_lossy().into_owned())
                .collect(),
        )
    })
    .await
    .map_err(|e| anyhow!("replay listing task failed: {e}"))??)
}

/// List replays with their parsed descriptor metadata — same walk as
/// [`list_replays`], but each entry carries the lightweight summary fields
/// (date/time, match group, map, own ship, player count) instead of just a
/// path. Per file only the first JSON block is read — a bounded header read
/// (see [`lite_from_path`]), never the multi-MB packet stream behind it — and
/// the whole scan runs on the blocking pool
/// ([`tokio::task::spawn_blocking`]) so the UI thread never stalls. Files
/// whose header can't be parsed still appear, with whatever fields were
/// recoverable.
///
/// `all` widens the scan from ONE root to every detected client
/// ([`super::game_context::replay_roots`]): the rail then lists each
/// client's replays side by side, every entry stamped with its owning
/// install (`install_path`/`install_kind`/`install_realm`) so the cards can
/// label the server and the rail can filter by it. `dir` is ignored in
/// that mode (an explicit folder is by definition a single-root scan); with
/// `all` unset the historical single-root behavior is unchanged, which is
/// what the pairing / import flows keep calling.
#[tauri::command]
pub async fn list_replays_meta(
    dir: Option<String>,
    limit: Option<usize>,
    all: Option<bool>,
) -> CommandResult<Vec<ReplayMetaLite>> {
    let all = all.unwrap_or(false);
    Ok(tokio::task::spawn_blocking(move || {
        if all {
            Ok(scan_all_replays_meta(limit))
        } else {
            scan_replays_meta(dir, limit).map(|(_, entries)| entries)
        }
    })
    .await
    .map_err(|e| anyhow!("replay listing task failed: {e}"))??)
}

/// The all-clients enumeration core behind `list_replays_meta { all: true }`:
/// walk every root [`super::game_context::replay_roots`] reports (each
/// detected install's `replays/` folder plus the resolved default dir when
/// no install covers it), parse each file's descriptor, and stamp the entry
/// with the owning install.
pub(crate) fn scan_all_replays_meta(limit: Option<usize>) -> Vec<ReplayMetaLite> {
    scan_roots_meta(&super::game_context::replay_roots(), limit)
}

/// [`scan_all_replays_meta`]'s pure core — the roots arrive as a parameter
/// so tests can drive synthetic trees, the same shape `playtime.rs` uses
/// for its ledger. Files are de-duplicated by normalized path, so a folder
/// reachable through two spellings still contributes each replay exactly
/// once (root de-duplication is the caller's: `game_context::replay_roots`
/// never reports overlapping roots).
///
/// Sorted by mtime descending — the same newest-first order the single-root
/// scan answers — with an explicit `limit` applied after that sort (no
/// implicit cap: see [`scan_replays_meta`]). A `limit` of 0 answers nothing,
/// matching the single-root scan's `.take(0)`.
pub(super) fn scan_roots_meta(
    roots: &[(PathBuf, Option<GameInstall>)],
    limit: Option<usize>,
) -> Vec<ReplayMetaLite> {
    let mut walked: Vec<(WalkedReplay, Option<GameInstall>)> = Vec::new();
    for (root, owner) in roots {
        let mut files = Vec::new();
        walk_replays(root, &mut files);
        for file in files {
            walked.push((file, owner.clone()));
        }
    }
    use std::cmp::Reverse;
    walked.sort_by_key(|(e, _)| Reverse(e.mtime));
    let limit = limit.unwrap_or(usize::MAX);
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for (file, owner) in walked {
        if out.len() >= limit {
            break;
        }
        let key = super::game_detect::install_path_key(&file.path.to_string_lossy());
        if !seen.insert(key) {
            continue;
        }
        let mut lite = lite_from_path(&file.path);
        if let Some(install) = owner {
            lite.install_path = Some(install.path.clone());
            lite.install_kind = Some(install.kind);
            lite.install_realm = install.realm.clone();
        }
        out.push(lite);
    }
    out
}

/// Enumeration core shared by the [`list_replays_meta`] command and the
/// pairing server's `/api/replays` route (single source of truth — never
/// duplicate the walk). Returns the resolved replay ROOT alongside the
/// entries so callers that need relative names (the pairing server projects
/// absolute paths onto root-relative remote names) can do so.
pub(crate) fn scan_replays_meta(
    dir: Option<String>,
    limit: Option<usize>,
) -> Result<(PathBuf, Vec<ReplayMetaLite>)> {
    let dir = resolve_replay_dir(dir)?;
    let mut entries: Vec<WalkedReplay> = Vec::new();
    walk_replays(&dir, &mut entries);
    use std::cmp::Reverse;
    entries.sort_by_key(|e| Reverse(e.mtime));
    // No implicit cap — same rationale as list_replays: the versioned
    // archive subfolders routinely push a tree past any fixed default, and
    // mtime-desc truncation would drop exactly the OLDEST (archived)
    // replays, which is the history the caller wants to surface.
    let limit = limit.unwrap_or(usize::MAX);
    Ok((
        dir,
        entries
            .into_iter()
            .take(limit)
            .map(|e| lite_from_path(&e.path))
            .collect(),
    ))
}
/// Default replay dir when neither an explicit `dir` nor the env pins name
/// one. Desktop resolves through the unified game context in its user-scoped
/// order — the persisted active install, then the running client, then the
/// first detected install — instead of blindly taking the first registry hit
/// (on multi-install machines that could be a folder the user never selected
/// and nothing is writing to). Mobile replays live in the app-private
/// managed dir (`<app_data>/replays`), filled by the pairing / import flow —
/// there is no game install to auto-detect on a phone.
#[cfg(desktop)]
fn default_replay_dir() -> Result<PathBuf> {
    super::game_context::resolve_root(super::game_context::RootPreference::PreferActive)
        .map(|ctx| super::game_context::replays_dir(&ctx.root))
        .ok_or_else(|| {
            anyhow!("no replay dir: pass `dir`, or set WOWSP_REPLAY_DIR / WOWSP_GAME_PATH")
        })
}

#[cfg(mobile)]
fn default_replay_dir() -> Result<PathBuf> {
    crate::paths::ensure_data_dir().map(|d| d.join("replays"))
}

/// Resolve the replay dir the caller asked for (explicit → env override →
/// platform default). Shared with the pairing module, which writes imports /
/// pulls into the same dir the local listing reads.
pub(crate) fn resolve_replay_dir(dir: Option<String>) -> Result<PathBuf> {
    if let Some(d) = dir {
        return Ok(PathBuf::from(d));
    }
    if let Ok(d) = std::env::var("WOWSP_REPLAY_DIR") {
        return Ok(PathBuf::from(d));
    }
    if let Ok(game) = std::env::var("WOWSP_GAME_PATH") {
        return Ok(PathBuf::from(game).join("replays"));
    }
    default_replay_dir()
}

/// One replay file surfaced by [`walk_replays`]: its path, modification
/// time (the listings' newest-first sort key) and length in bytes (the
/// playtime battle ledger's cache-identity half, alongside the mtime).
pub(crate) struct WalkedReplay {
    pub path: PathBuf,
    pub mtime: std::time::SystemTime,
    pub len: u64,
}

/// Recursively collect every replay container under `dir` (both clients'
/// extensions; the live `temp.*` files are skipped — see below). Shared by
/// the listing commands, the pairing server's replay route and the playtime
/// battle ledger (single source of truth — never duplicate the walk).
pub(crate) fn walk_replays(dir: &PathBuf, out: &mut Vec<WalkedReplay>) {
    // The game writes a live temp container during a match (`temp.<ext>` for
    // each client family's container extension — WG: temp.wowsreplay, Lesta:
    // temp.korablireplay); it is not a completed replay. The frontend renders
    // it as a live-battle entry instead of listing it here. Generated from
    // the compat registry so a future family needs no edit here; the match
    // stays exact (case-sensitive) on the file name, as before.
    let temp_names: Vec<String> = super::game_client::replay_extensions()
        .into_iter()
        .map(|ext| format!("temp.{ext}"))
        .collect();
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for ent in rd.flatten() {
        let path = ent.path();
        let Ok(meta) = ent.metadata() else { continue };
        if meta.is_dir() {
            walk_replays(&path, out);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(is_replay_extension)
        {
            let is_temp = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| temp_names.iter().any(|temp| n == temp.as_str()));
            if is_temp {
                continue;
            }
            if let Ok(mtime) = meta.modified() {
                out.push(WalkedReplay {
                    path,
                    mtime,
                    len: meta.len(),
                });
            }
        }
    }
}
