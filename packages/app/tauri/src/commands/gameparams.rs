//! GameParams ship-data extractor (milestone M10).
//!
//! The WoWS client ships its full ship database — armor schemes, shell
//! ballistics, dispersion curves, consumables — as a packed binary
//! `res_wgs/GameParams.data`. The community tool `wowsunpack` (and its
//! maintained fork `wowsinfo/wowsunpack`) unpacks it to a single large JSON.
//!
//! This module is the *consumer* of an already-unpacked `GameParams.json`.
//! Integrating wowsunpack itself (Python tool, or a Rust port) is a separate
//! milestone — see the project plan. For now we detect a user-provided
//! `GameParams.json` at the game root (or next to `GameParams.data`) and
//! extract one ship's subtree on demand, caching per-ship slices under
//! `gameparams/<shipId>.json` so subsequent loads are instant.
//!
//! The lazy-load contract: the frontend asks for `<shipId>`; we check the
//! cache, then the unpacked JSON, then return an error guiding the user to
//! unpack first if neither is present.

use std::fs;

/// Extract one ship's GameParams subtree. `game_root` is the directory
/// containing `bin/` (i.e. the WoWS install root, as detected by
/// `detect_game_install`).
///
/// Lookup order:
///   1. `gameparams/<shipId>.json` cache (instant).
///   2. `<game_root>/GameParams.json` (unpacked by wowsunpack) → extract
///      slice → cache → return.
///   3. If only `GameParams.data` exists → error with a user-actionable hint.
///   4. Otherwise → error.
#[tauri::command]
pub fn get_ship_gameparams(ship_id: i64, game_root: String) -> Result<serde_json::Value, String> {
    let cache_file = format!("gameparams/{ship_id}.json");

    // 1. Cache hit?
    if let Ok(Some(raw)) = appdata_read(cache_file.clone()) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            return Ok(v);
        }
    }

    // 2. Look for an unpacked GameParams.json at the game root, or in the
    //    extract script's LOCALAPPDATA cache.
    let root = std::path::Path::new(&game_root);
    let local_cache = dirs_next::cache_dir()
        .unwrap_or_default()
        .join("WoWSP-extract")
        .join("GameParams.json");
    let json_candidates: [std::path::PathBuf; 3] = [
        root.join("GameParams.json"),
        root.join("bin").join("GameParams.json"),
        local_cache,
    ];
    let json_path = json_candidates.iter().find(|p| p.exists());

    if let Some(path) = json_path {
        let raw = fs::read_to_string(path).map_err(|e| format!("read GameParams.json: {e}"))?;
        let slice = extract_ship_slice(&raw, ship_id)?;
        let serialized = serde_json::to_string(&slice).unwrap_or_default();
        let _ = appdata_write(cache_file, serialized);
        return Ok(slice);
    }

    // 3. Only the binary .data exists → guide the user.
    let data_candidates = [
        root.join("bin").join("GameParams.data"),
        root.join("res_wgs").join("GameParams.data"),
    ];
    if data_candidates.iter().any(|p| p.exists()) {
        return Err(
            "GameParams.data 需要 wowsunpack 解包。请先运行 wowsunpack 生成 GameParams.json，\
             放在游戏根目录下。详见：https://github.com/wowsinfo/wowsunpack"
                .to_string(),
        );
    }

    Err(format!(
        "未找到 GameParams 数据。请确认游戏路径正确：{game_root}（应包含 bin/ 目录）"
    ))
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

fn appdata_dir() -> Result<std::path::PathBuf, String> {
    let base = dirs_next::data_dir().ok_or_else(|| "cannot resolve AppData dir".to_string())?;
    let dir = base.join("WoWSP");
    fs::create_dir_all(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;
    Ok(dir)
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
}
