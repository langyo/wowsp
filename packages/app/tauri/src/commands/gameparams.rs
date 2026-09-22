//! GameParams ship-data extractor (milestone M10).
//!
//! The WoWS client ships its full ship database — armor schemes, shell
//! ballistics, dispersion curves, consumables — as a packed binary
//! `content/GameParams.data` inside the `bin/<build>/` idx/pkg store. The
//! community tool `wowsunpack` (vendored under `packages/tools/`) unpacks it.
//!
//! Lookup order for one ship's subtree:
//!   1. `gameparams/<shipId>.json` AppData cache (instant).
//!   2. A pre-unpacked `GameParams.json` at the game root (or the extract
//!      script's LOCALAPPDATA cache) → extract slice → cache → return.
//!   3. In-app unpack: mount the install's idx/pkg VFS, read
//!      `content/GameParams.data`, decode the pickle, pick the ship's entry
//!      → cache → return. This is the path every fresh player install takes
//!      (nobody runs wowsunpack by hand); it costs a few seconds once per
//!      ship, then the per-ship cache makes re-opens instant.
//!
//! The cache is keyed to the game's current `bin/<build>` number: when the
//! game updates, stale slices are dropped so armor data never lags the
//! client.
//!
//! `get_upgrade_prices` walks the same decoded GameParams tree for the
//! Modernization entities' credit prices — the build planner's cost panel
//! sums the selected build's shopping list from them.

use std::fs;
use std::io::Read;
use std::path::Path;

/// Extract one ship's GameParams subtree. `game_root` is the directory
/// containing `bin/` (i.e. the WoWS install root, as detected by
/// `detect_game_install`).
#[tauri::command]
pub async fn get_ship_gameparams(
    ship_id: i64,
    game_root: String,
) -> Result<serde_json::Value, String> {
    let cache_file = format!("gameparams/{ship_id}.json");

    // 0. Game updated since the cache was filled? Drop stale slices BEFORE
    //    any cache read (one bin/ readdir — cheap even on the hot path) so
    //    armor data never lags the client.
    if let Some(build) = latest_build_with_idx(Path::new(&game_root)) {
        invalidate_cache_on_build_change(build);
    }

    // 1. Cache hit?
    if let Ok(Some(raw)) = appdata_read(cache_file.clone()) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            return Ok(v);
        }
    }

    // 2. In-app unpack from the install's pkg store — the player path, and
    //    always fresher than any loose pre-unpacked JSON. Heavy (reads +
    //    decodes the full GameParams pickle) — keep it off the async runtime
    //    threads. A failure here (no install / game updating) falls through
    //    to the loose-JSON candidates and only surfaces if those fail too.
    let game_root2 = game_root.clone();
    let unpacked =
        tokio::task::spawn_blocking(move || unpack_ship_from_install(&game_root2, ship_id))
            .await
            .map_err(|e| format!("GameParams 解包任务异常退出：{e}"));

    // 3. Fallback: a pre-unpacked GameParams.json (dev flow: wowsunpack CLI
    //    output at the game root, or the extract script's LOCALAPPDATA cache
    //    for sessions without a resolvable install).
    let unpack_err = match unpacked {
        Ok(Ok(slice)) => {
            let serialized = serde_json::to_string(&slice).unwrap_or_default();
            let _ = appdata_write(cache_file, serialized);
            return Ok(slice);
        },
        Ok(Err(e)) => e,
        Err(e) => e,
    };

    let root = Path::new(&game_root);
    let local_cache = dirs_next::cache_dir()
        .unwrap_or_default()
        .join("WoWSP-extract")
        .join("GameParams.json");
    let json_candidates: [std::path::PathBuf; 3] = [
        root.join("GameParams.json"),
        root.join("bin").join("GameParams.json"),
        local_cache,
    ];
    if let Some(path) = json_candidates.iter().find(|p| p.exists()) {
        let raw = fs::read_to_string(path).map_err(|e| format!("read GameParams.json: {e}"))?;
        let slice = extract_ship_slice(&raw, ship_id)?;
        let serialized = serde_json::to_string(&slice).unwrap_or_default();
        let _ = appdata_write(cache_file, serialized);
        return Ok(slice);
    }

    Err(unpack_err)
}

// ── in-app unpacking (vendored wowsunpack) ────────────────────────────────

/// Unpack one ship's entry straight from the install's `bin/<build>` pkg
/// store. Mirrors what the wowsunpack CLI's `game-params --game-dir` mode
/// does, minus writing a 350MB intermediate JSON: mount the VFS, read
/// `content/GameParams.data`, decode, pick the ship, serialize just that
/// entry.
fn unpack_ship_from_install(game_root: &str, ship_id: i64) -> Result<serde_json::Value, String> {
    let root = Path::new(game_root);
    if !root.join("bin").is_dir() {
        return Err(format!(
            "游戏目录无效：{game_root}（应包含 bin/ 子目录）。请在设置中重新指定游戏安装路径。"
        ));
    }

    // Resolve the build carrying the idx/ index files.
    let build = latest_build_with_idx(root).ok_or_else(|| {
        format!("在 {game_root}\\bin 下未找到带 idx/ 的版本目录，无法读取游戏资源索引。")
    })?;

    let vfs = wowsunpack::game_data::build_game_vfs_for_build(root, build)
        .map_err(|e| format!("读取游戏资源索引失败（build {build}）：{e}"))?;

    let mut bytes = Vec::new();
    vfs.join("content/GameParams.data")
        .map_err(|e| format!("定位 content/GameParams.data 失败：{e}"))?
        .open_file()
        .map_err(|e| format!("打开 GameParams.data 失败（游戏可能正在更新）：{e}"))?
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取 GameParams.data 失败：{e}"))?;

    let pickle = wowsunpack::game_params::convert::game_params_to_pickle(bytes)
        .map_err(|e| format!("解析 GameParams.data 失败：{e}"))?;

    ship_slice_from_pickle(&pickle, ship_id)
        .ok_or_else(|| format!("ship_id {ship_id} not found in GameParams"))
}

/// The newest `bin/<build>/` that actually ships an `idx/` directory — Steam
/// installs keep several builds around and only some carry the index files
/// the VFS needs (same rule as `scripts/extract/_common.py`).
fn latest_build_with_idx(root: &Path) -> Option<u32> {
    let bin = root.join("bin");
    let mut builds: Vec<u32> = fs::read_dir(&bin)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()))
        .filter(|b| bin.join(b.to_string()).join("idx").is_dir())
        .collect();
    builds.sort_unstable();
    builds.pop()
}

/// Wipe the per-ship cache when the game's build number changed since it was
/// filled. Best-effort: a failed wipe only means stale data until the next
/// build change, never a hard error.
fn invalidate_cache_on_build_change(build: u32) {
    let marker = appdata_dir()
        .map(|d| d.join("gameparams").join("source-build.txt"))
        .ok();
    let Some(marker) = marker else { return };
    let current = fs::read_to_string(&marker).ok();
    if current.as_deref() == Some(build.to_string().as_str()) {
        return;
    }
    if let Some(parent) = marker.parent() {
        let _ = fs::remove_dir_all(parent);
    }
    let _ = appdata_write("gameparams/source-build.txt".to_string(), build.to_string());
}

/// Normalize the decoded GameParams pickle root to the params dict. The raw
/// root varies across game versions — modern builds wrap everything in a
/// `{"": {…}}` namespace dict (alongside region keys like ASIA/EU), old
/// builds use a flat `{name: entry}` dict, and some use a list/tuple whose
/// first element holds the dict.
fn params_root(pickle: &pickled::Value) -> Option<pickled::Value> {
    match pickle {
        pickled::Value::List(items) => items.inner().first().cloned(),
        pickled::Value::Tuple(items) => items.inner().first().cloned(),
        // Modern format: {"": {param_name: param_data, ...}}. Old format:
        // flat {param_name: param_data, ...} (no wrapper key).
        _ => Some(
            dict_entries(pickle)?
                .iter()
                .find(
                    |(k, _)| matches!(k, pickled::HashableValue::String(s) if s.inner().is_empty()),
                )
                .and_then(|(_, v)| dict_like_is_dict(v).then(|| v.clone()))
                .unwrap_or_else(|| pickle.clone()),
        ),
    }
}

/// Pick the ship's entry out of a decoded GameParams pickle. The raw root
/// varies across game versions — modern builds wrap everything in a
/// `{"": {…}}` namespace dict (alongside region keys like ASIA/EU), old
/// builds use a flat `{name: entry}` dict, and some use a list/tuple whose
/// first element holds the dict. On top of that, the wrapper and the
/// individual entries may decode as Python objects (`Value::Object` whose
/// `__dict__` is the real data) instead of plain dicts — the same dual
/// shape wowsunpack's `params_from_data` unwraps. We mirror all of it,
/// then scan entries by their `id` field (the real format is keyed by
/// internal name like `PJSB018_Yamato_1944`). When several entries share
/// an id (CV hull + plane squadrons), the one carrying `A_Artillery` wins.
/// Extract every Modernization entity's price data from the install's
/// GameParams.data: `{ "<index>": { name, cost?, group? } }` keyed by the
/// entity index (PCM027…) and also by full entity name — the planner's
/// build state stores full names, so both keys point at the same record.
/// Only entities carrying a numeric `cost` surface; everything else is
/// skipped so the frontend can tell "price known" from "price missing".
#[tauri::command]
pub async fn get_upgrade_prices(game_root: String) -> Result<serde_json::Value, String> {
    // Build-keyed cache, same lifecycle as the per-ship slices.
    if let Some(build) = latest_build_with_idx(Path::new(&game_root)) {
        invalidate_cache_on_build_change(build);
    }
    if let Ok(Some(raw)) = appdata_read("gameparams/upgrade-prices.json".into()) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            return Ok(v);
        }
    }

    let game_root2 = game_root.clone();
    let prices = tokio::task::spawn_blocking(move || upgrade_prices_from_install(&game_root2))
        .await
        .map_err(|e| format!("配件价格解包任务异常退出：{e}"))??;

    let _ = appdata_write(
        "gameparams/upgrade-prices.json".into(),
        serde_json::to_string(&prices).unwrap_or_default(),
    );
    Ok(prices)
}

fn upgrade_prices_from_install(game_root: &str) -> Result<serde_json::Value, String> {
    let root = Path::new(game_root);
    if !root.join("bin").is_dir() {
        return Err(format!(
            "游戏目录无效：{game_root}（应包含 bin/ 子目录）。请在设置中重新指定游戏安装路径。"
        ));
    }
    let build = latest_build_with_idx(root).ok_or_else(|| {
        format!("在 {game_root}\\bin 下未找到带 idx/ 的版本目录，无法读取游戏资源索引。")
    })?;
    let vfs = wowsunpack::game_data::build_game_vfs_for_build(root, build)
        .map_err(|e| format!("读取游戏资源索引失败（build {build}）：{e}"))?;
    let mut bytes = Vec::new();
    vfs.join("content/GameParams.data")
        .map_err(|e| format!("定位 content/GameParams.data 失败：{e}"))?
        .open_file()
        .map_err(|e| format!("打开 GameParams.data 失败（游戏可能正在更新）：{e}"))?
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取 GameParams.data 失败：{e}"))?;
    let pickle = wowsunpack::game_params::convert::game_params_to_pickle(bytes)
        .map_err(|e| format!("解析 GameParams.data 失败：{e}"))?;

    let params = params_root(&pickle).ok_or("GameParams 根结构无法识别")?;
    let mut out = serde_json::Map::new();
    let entries = dict_entries(&params).ok_or("GameParams 根不是字典")?;
    for (k, v) in entries {
        let pickled::HashableValue::String(key) = &k else {
            continue;
        };
        let key = key.inner().clone();
        // Upgrade entities: the PC-prefixed common family and/or an explicit
        // Modernization group. Ships carry numeric id keys, so they never
        // collide with the prefix filter.
        let group = pickled_get(&v, "group")
            .and_then(|g| to_json(&g).ok())
            .and_then(|g| g.as_str().map(str::to_string));
        if !key.starts_with("PC") && group.as_deref() != Some("Modernization") {
            continue;
        }
        let Some(cost) = pickled_get(&v, "cost")
            .and_then(|c| pickled_as_i64(&c))
            .filter(|c| *c > 0)
        else {
            continue;
        };
        let index = pickled_get(&v, "index")
            .and_then(|g| to_json(&g).ok())
            .and_then(|g| g.as_str().map(str::to_string))
            .unwrap_or_else(|| key.split('_').next().unwrap_or(&key).to_string());
        let mut record = serde_json::Map::new();
        record.insert("name".into(), serde_json::json!(key));
        record.insert("cost".into(), serde_json::json!(cost));
        if let Some(group) = group {
            record.insert("group".into(), serde_json::json!(group));
        }
        // Key by index (PCM027) and mirror under the full entity name so the
        // planner's stored full names hit without a split.
        out.insert(index.clone(), serde_json::Value::Object(record.clone()));
        out.insert(key, serde_json::Value::Object(record));
    }
    Ok(serde_json::Value::Object(out))
}

fn ship_slice_from_pickle(pickle: &pickled::Value, ship_id: i64) -> Option<serde_json::Value> {
    let params = params_root(pickle)?;

    let mut candidates: Vec<pickled::Value> = Vec::new();
    for (k, v) in dict_entries(&params)? {
        // Direct id-keyed form first.
        if let pickled::HashableValue::String(s) = &k {
            if *s.inner() == ship_id.to_string() {
                return to_json(&v).ok();
            }
        }
        if pickled_entry_matches(&v, ship_id) {
            candidates.push(v);
        }
    }

    let pick = candidates
        .iter()
        .find(|v| pickled_get(v, "A_Artillery").is_some())
        .or_else(|| {
            candidates
                .iter()
                .find(|v| pickled_keys(v).iter().any(|k| k.starts_with("A_")))
        })
        .or_else(|| candidates.first())?
        .clone();
    to_json(&pick).ok()
}

fn to_json(v: &pickled::Value) -> Result<serde_json::Value, serde_json::Error> {
    serde_json::to_value(v)
}

/// Entries of a dict-like pickled value: a plain `Dict`, or a Python object
/// whose `__dict__` (a `DictObject` state) is the actual data. Clones the
/// entry list — Rc-bump cheap, and references cannot outlive the RefCell
/// guards anyway.
fn dict_entries(v: &pickled::Value) -> Option<Vec<(pickled::HashableValue, pickled::Value)>> {
    match v {
        pickled::Value::Dict(d) => Some(d.inner().as_slice().to_vec()),
        pickled::Value::Object(o) => {
            let inner = o.inner();
            let dict_obj = inner
                .as_any()
                .downcast_ref::<pickled::object::DictObject>()?;
            Some(dict_obj.state().as_slice().to_vec())
        },
        _ => None,
    }
}

/// Whether the value would yield entries via [`dict_entries`].
fn dict_like_is_dict(v: &pickled::Value) -> bool {
    match v {
        pickled::Value::Dict(_) => true,
        pickled::Value::Object(o) => {
            let inner = o.inner();
            inner
                .as_any()
                .downcast_ref::<pickled::object::DictObject>()
                .is_some()
        },
        _ => false,
    }
}

fn pickled_entry_matches(entry: &pickled::Value, ship_id: i64) -> bool {
    pickled_get(entry, "id")
        .or_else(|| pickled_get(entry, "ShipId"))
        .and_then(|v| pickled_as_i64(&v))
        .map(|n| n == ship_id)
        .unwrap_or(false)
}

/// Look up a string key in a dict-like pickled value (owned clone out of the
/// RefCell guard).
fn pickled_get(v: &pickled::Value, key: &str) -> Option<pickled::Value> {
    dict_entries(v)?
        .into_iter()
        .find(|(k, _)| matches!(k, pickled::HashableValue::String(s) if s.inner() == key))
        .map(|(_, v)| v)
}

fn pickled_keys(v: &pickled::Value) -> Vec<String> {
    dict_entries(v)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(k, _)| match k {
            pickled::HashableValue::String(s) => Some(s.inner().to_string()),
            _ => None,
        })
        .collect()
}

/// Coerce a pickled number/string to i64. GameParams ids exceed u32, so the
/// pickle may carry them as I64, unbounded Int, or (rarely) F64.
fn pickled_as_i64(v: &pickled::Value) -> Option<i64> {
    match v {
        pickled::Value::I64(n) => Some(*n),
        pickled::Value::Int(bi) => format!("{bi}").parse::<i64>().ok(),
        pickled::Value::F64(f) if f.fract() == 0.0 && f.is_finite() => Some(*f as i64),
        pickled::Value::String(s) => s.inner().parse::<i64>().ok(),
        _ => None,
    }
}

/// Extract one ship's subtree from the unpacked GameParams.json.
///
/// Supports four top-level shapes the various unpackers emit:
///   1. Array of ship objects: `[ { "id": 428..., ... }, ... ]`
///   2. `{ "ships": [ ... ] }` wrapper
///   3. `{ "<numericShipId>": { ... } }` keyed by the id as a string
///   4. `{ "<internalName>": { "id": <num>, ... }, ... }` — keyed by the
///      internal ship name (e.g. "PJSB018_Yamato_1944"), with the numeric
///      id as a field inside each entry. This is the shape the
///      `wowsunpack game-params` command actually emits.
///
/// In cases 1/2/4 we scan entries and match by the `id` field; in case 3
/// the key itself is the id.  When multiple entries share the same id (e.g.
/// CV hull + its plane squadrons), the one containing `A_Artillery` (or
/// failing that, any `A_*` weapon key) is preferred — module-only entries
/// like aircraft squadrons don't carry weapon data.
/// The per-ship AppData cache makes subsequent calls instant regardless of
/// file size.
pub(crate) fn extract_ship_slice(raw: &str, ship_id: i64) -> Result<serde_json::Value, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("parse GameParams.json: {e}"))?;

    let mut candidates: Vec<serde_json::Value> = Vec::new();

    if let Some(arr) = parsed.as_array() {
        for entry in arr {
            if entry_matches_id(entry, ship_id) {
                candidates.push(entry.clone());
            }
        }
    } else if let Some(obj) = parsed.as_object() {
        if let Some(ships) = obj.get("ships").and_then(|v| v.as_array()) {
            for entry in ships {
                if entry_matches_id(entry, ship_id) {
                    candidates.push(entry.clone());
                }
            }
        }
        let key = ship_id.to_string();
        if let Some(v) = obj.get(&key) {
            return Ok(v.clone());
        }
        for (_name, entry) in obj {
            if entry_matches_id(entry, ship_id) {
                candidates.push(entry.clone());
            }
        }
    }

    if candidates.is_empty() {
        return Err(format!("ship_id {ship_id} not found in GameParams"));
    }

    // Prefer an entry that actually has weapon keys.
    if let Some(hull) = candidates.iter().find(|e| {
        e.as_object()
            .map(|o| o.contains_key("A_Artillery"))
            .unwrap_or(false)
    }) {
        return Ok(hull.clone());
    }

    // The matched entry(ies) might be module-only (CV planes, etc.) while
    // the real hull entry with weapons lives under a different id but shares
    // the same index prefix.  Scan the full GameParams dict for sibling
    // entries with the same prefix that DO carry weapon data.
    if let Some(obj) = parsed.as_object() {
        // Collect all index prefixes from the candidates.
        let mut prefixes: Vec<String> = Vec::new();
        for c in &candidates {
            if let Some(name) = c.get("name").and_then(|v| v.as_str()) {
                // GameParams index format: PASB008 → prefix is "PASB"
                let prefix: String = name
                    .chars()
                    .take_while(|c| c.is_ascii_uppercase())
                    .collect();
                if prefix.len() >= 3 {
                    prefixes.push(prefix);
                }
            }
        }
        // Also collect prefixes from the candidate's key in the dict.
        for (key, _entry) in obj {
            if candidates
                .iter()
                .any(|c| c.get("index").and_then(|v| v.as_str()) == Some(key.as_str()))
            {
                let prefix: String = key.chars().take_while(|c| c.is_ascii_uppercase()).collect();
                if prefix.len() >= 3 && !prefixes.contains(&prefix) {
                    prefixes.push(prefix);
                }
            }
        }
        prefixes.sort();
        prefixes.dedup();

        for prefix in &prefixes {
            for (key, entry) in obj {
                if !key.starts_with(prefix.as_str()) {
                    continue;
                }
                if let Some(e) = entry.as_object() {
                    if e.contains_key("A_Artillery") {
                        return Ok(entry.clone());
                    }
                }
            }
        }
    }

    // Fall back to any entry with at least one A_* weapon key.
    if let Some(armed) = candidates.iter().find(|e| {
        e.as_object()
            .map(|o| o.keys().any(|k| k.starts_with("A_")))
            .unwrap_or(false)
    }) {
        return Ok(armed.clone());
    }
    // Absolute fallback: first match.
    Ok(candidates[0].clone())
}

fn entry_matches_id(entry: &serde_json::Value, ship_id: i64) -> bool {
    // The id field may be a number or a string-encoded number.
    if let Some(n) = entry.get("id").and_then(|v| v.as_i64()) {
        return n == ship_id;
    }
    if let Some(s) = entry.get("id").and_then(|v| v.as_str()) {
        if let Ok(n) = s.parse::<i64>() {
            return n == ship_id;
        }
    }
    // Some unpackers use "ShipId" or nest under "Typeinfo".
    if let Some(n) = entry.get("ShipId").and_then(|v| v.as_i64()) {
        return n == ship_id;
    }
    false
}

// ── shared helpers (same pattern as encyclopedia.rs) ─────────────────────

/// Resolves through `paths` (NOT `dirs_next` directly) so portable installs
/// read/write `<exe>/data/` like every other appdata consumer — this used to
/// hardcode %APPDATA%\WoWSP and silently split the gameparams cache across
/// two roots in portable mode.
fn appdata_dir() -> Result<std::path::PathBuf, String> {
    crate::paths::ensure_data_dir()
}

fn appdata_read(file: String) -> Result<Option<String>, String> {
    let path = appdata_dir()?.join(&file);
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {path:?}: {e}")),
    }
}

fn appdata_write(file: String, content: String) -> Result<(), String> {
    let dir = appdata_dir()?;
    let path = dir.join(&file);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {parent:?}: {e}"))?;
    }
    let tmp = dir.join(format!("{file}.tmp"));
    fs::write(&tmp, &content).map_err(|e| format!("write {tmp:?}: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename {tmp:?} → {path:?}: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end smoke against a real install (dev machine only): mount the
    /// pkg VFS, read + decode the real GameParams.data, pick a ship, and
    /// round-trip the public unpack path. Guarded by WOWSP_GAME_PATH so CI
    /// skips it. The ship is located by its PASB510 index-key prefix because
    /// WG regenerates ids and reassigns index keys between builds (PASB510 is
    /// Ohio on current installs) — neither can be hardcoded.
    #[test]
    #[ignore = "manual: requires a local game install; set WOWSP_GAME_PATH to run"]
    fn smoke_unpack_from_real_install() {
        let root = std::env::var("WOWSP_GAME_PATH").expect("WOWSP_GAME_PATH");

        // Find the PASB510 ship's current id from the decoded params.
        let install = Path::new(&root);
        let build = latest_build_with_idx(install).expect("build");
        let vfs = wowsunpack::game_data::build_game_vfs_for_build(install, build).expect("vfs");
        let mut bytes = Vec::new();
        vfs.join("content/GameParams.data")
            .expect("join")
            .open_file()
            .expect("open GameParams.data")
            .read_to_end(&mut bytes)
            .expect("read GameParams.data");
        eprintln!("[smoke] GameParams.data = {} bytes", bytes.len());
        let pickle =
            wowsunpack::game_params::convert::game_params_to_pickle(bytes).expect("decode");

        let found: Option<(String, i64)> = (|| {
            let wrapper = dict_entries(&pickle)?.into_iter().find(
                |(k, _)| matches!(k, pickled::HashableValue::String(s) if s.inner().is_empty()),
            )?;
            for (k, v) in dict_entries(&wrapper.1)?.into_iter() {
                if matches!(&k, pickled::HashableValue::String(s) if s.inner().starts_with("PASB510"))
                {
                    let id = pickled_get(&v, "id").and_then(|x| pickled_as_i64(&x))?;
                    let name = match pickled_get(&v, "name")? {
                        pickled::Value::String(s) => s.inner().to_string(),
                        _ => return None,
                    };
                    return Some((name, id));
                }
            }
            None
        })();
        eprintln!("[smoke] PASB510 ship = {found:?}");
        let (want_name, want_id) = found.expect("PASB510 ship");

        let v = unpack_ship_from_install(&root, want_id).expect("unpack ship");
        let name = v.get("name").and_then(|n| n.as_str()).unwrap_or_default();
        eprintln!("[smoke] ship name = {name}");
        assert_eq!(name, want_name);
        let json = serde_json::to_string_pretty(&v).unwrap();
        eprintln!("[smoke] slice size = {} bytes", json.len());
        assert!(json.contains("A_Artillery") || json.contains("A_Hull"));
    }

    #[test]
    fn extracts_ship_from_array_form() {
        // Two ships, array form (wowsunpack default output shape).
        let raw = serde_json::json!([
            {
                "id": 4282948544_i64,
                "name": "PASB510_Montana",
                "ShipHp": { "maxHealth": 96300 },
                "Hull": { "burningFlags": 5 }
            },
            {
                "id": 4279322512_i64,
                "name": "PJSD109_Shimakaze",
                "ShipHp": { "maxHealth": 17900 }
            }
        ])
        .to_string();
        let ship = extract_ship_slice(&raw, 4282948544).unwrap();
        assert_eq!(
            ship.get("name").and_then(|v| v.as_str()),
            Some("PASB510_Montana")
        );
        assert_eq!(
            ship.get("ShipHp")
                .and_then(|h| h.get("maxHealth"))
                .and_then(|v| v.as_i64()),
            Some(96300)
        );
    }

    #[test]
    fn extracts_ship_from_object_ships_form() {
        let raw = serde_json::json!({
            "ships": [
                { "id": 100, "name": "A" },
                { "id": 200, "name": "B" }
            ]
        })
        .to_string();
        let ship = extract_ship_slice(&raw, 200).unwrap();
        assert_eq!(ship.get("name").and_then(|v| v.as_str()), Some("B"));
    }

    #[test]
    fn extracts_ship_from_keyed_object_form() {
        let raw = serde_json::json!({
            "100": { "name": "A" },
            "200": { "name": "B" }
        })
        .to_string();
        let ship = extract_ship_slice(&raw, 200).unwrap();
        assert_eq!(ship.get("name").and_then(|v| v.as_str()), Some("B"));
    }

    #[test]
    fn missing_ship_returns_error() {
        let raw = serde_json::json!([{ "id": 1, "name": "A" }]).to_string();
        let err = extract_ship_slice(&raw, 999).unwrap_err();
        assert!(err.contains("not found"));
    }

    /// The real wowsunpack `game-params` output is keyed by internal ship
    /// name (not numeric id), with the numeric id as a field. The parser
    /// must scan values and match by `id`.
    #[test]
    fn extracts_ship_from_dict_of_names_form() {
        let raw = serde_json::json!({
            "PJSB018_Yamato_1944": {
                "id": 4276041424_i64,
                "name": "PJSB018_Yamato_1944",
                "typeinfo": { "type": "Ship" },
                "A_Hull": { "maxHP": 48600 }
            },
            "PASA002_Bogue": {
                "id": 4292851696_i64,
                "name": "PASA002_Bogue",
                "typeinfo": { "type": "Ship" }
            }
        })
        .to_string();
        let ship = extract_ship_slice(&raw, 4276041424).unwrap();
        assert_eq!(
            ship.get("name").and_then(|v| v.as_str()),
            Some("PJSB018_Yamato_1944")
        );
        assert_eq!(
            ship.get("A_Hull")
                .and_then(|h| h.get("maxHP"))
                .and_then(|v| v.as_i64()),
            Some(48600)
        );
    }

    #[test]
    fn entry_matches_id_accepts_string_id() {
        let entry = serde_json::json!({ "id": "4282948544", "name": "x" });
        assert!(entry_matches_id(&entry, 4282948544));
    }

    // ── in-app unpack helpers ─────────────────────────────────────────────

    fn pdict(pairs: &[(&str, pickled::Value)]) -> pickled::Value {
        let mut d = pickled::Dict::new();
        for (k, v) in pairs {
            d.insert(
                pickled::HashableValue::String(k.to_string().into()),
                v.clone(),
            );
        }
        pickled::Value::Dict(d.into())
    }

    fn pstr(s: &str) -> pickled::Value {
        pickled::Value::String(s.to_string().into())
    }

    /// The decoded pickle is keyed by internal name with the numeric id as a
    /// field; the hull entry (A_Artillery) must win over a same-id module
    /// entry (CV planes).
    #[test]
    fn picks_armed_entry_from_pickle_dict() {
        let pickle = pdict(&[
            (
                "PASA002_Bogue",
                pdict(&[
                    ("id", pickled::Value::I64(4292851696)),
                    ("name", pstr("PASA002_Bogue")),
                ]),
            ),
            (
                "PJSB018_Yamato_1944",
                pdict(&[
                    ("id", pickled::Value::I64(4276041424)),
                    ("name", pstr("PJSB018_Yamato_1944")),
                    (
                        "A_Artillery",
                        pdict(&[("maxCaliber", pickled::Value::I64(460))]),
                    ),
                ]),
            ),
        ]);
        let ship = ship_slice_from_pickle(&pickle, 4276041424).unwrap();
        assert_eq!(
            ship.get("name").and_then(|v| v.as_str()),
            Some("PJSB018_Yamato_1944")
        );
        assert_eq!(
            ship.get("A_Artillery")
                .and_then(|a| a.get("maxCaliber"))
                .and_then(|v| v.as_i64()),
            Some(460)
        );
    }

    /// Unbounded big-int ids (protocol LONG) and F64-encoded ids coerce too.
    #[test]
    fn pickled_as_i64_handles_bigint_and_f64() {
        assert_eq!(
            pickled_as_i64(&pickled::Value::Int(Box::new(
                "4282948544".parse::<pickled::num_bigint::BigInt>().unwrap()
            ))),
            Some(4282948544)
        );
        assert_eq!(
            pickled_as_i64(&pickled::Value::F64(4282948544.0)),
            Some(4282948544)
        );
        assert_eq!(pickled_as_i64(&pickled::Value::F64(1.5)), None);
    }

    /// Modern GameParams.data wraps the params dict under an empty-string
    /// namespace key, alongside region keys (ASIA/EU/...) — the ship scan
    /// must unwrap it instead of matching the 13 namespace entries.
    #[test]
    fn picks_entry_from_modern_wrapper_root() {
        let inner = pdict(&[
            (
                "PASA002_Bogue",
                pdict(&[
                    ("id", pickled::Value::I64(4292851696)),
                    ("name", pstr("PASA002_Bogue")),
                ]),
            ),
            (
                "PASB510_Montana",
                pdict(&[
                    ("id", pickled::Value::I64(4282948544)),
                    ("name", pstr("PASB510_Montana")),
                    (
                        "A_Artillery",
                        pdict(&[("maxCaliber", pickled::Value::I64(406))]),
                    ),
                ]),
            ),
        ]);
        let root = pdict(&[("", inner), ("EU", pdict(&[])), ("ASIA", pdict(&[]))]);
        let ship = ship_slice_from_pickle(&root, 4282948544).unwrap();
        assert_eq!(
            ship.get("name").and_then(|v| v.as_str()),
            Some("PASB510_Montana")
        );
    }

    /// `latest_build_with_idx` picks the highest-numbered bin/<build>/ that
    /// actually carries idx/, skipping numeric dirs without one.
    #[test]
    fn latest_build_with_idx_prefers_idx_carriers() {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-gp-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let bin = dir.join("bin");
        for (build, with_idx) in [(100u32, true), (300, false), (200, true)] {
            let b = bin.join(build.to_string());
            let target = if with_idx { b.join("idx") } else { b };
            fs::create_dir_all(&target).unwrap();
        }
        assert_eq!(latest_build_with_idx(&dir), Some(200));
        fs::remove_dir_all(&dir).unwrap();
    }
}
