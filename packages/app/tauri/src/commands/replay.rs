//! Replay (`.wowsreplay`) header parsing.
//!
//! File layout:
//!   4 bytes  magic       = `{0x12, 0x32, 0x34, 0x11}`
//!   4 bytes  json_len    = little-endian u32
//!   N bytes  json_block  = match descriptor JSON (roster, map, match type)
//!   4 bytes  meta_count  = u32, number of trailing metadata blocks
//!   ...      metadata    = extra metadata blocks (usually empty for live)
//!   ...      packets     = encrypted/zlib packet stream (Phase 2 — milestone M3)
//!
//! Phase 1 (this file) implements the magic check + JSON block extraction. The
//! dual-format reader also accepts the bare-JSON variant the client writes as
//! `tempArenaInfo.json` (same logic ApeRadar's `FileUtils.ReadTempArenaInfoFile`
//! uses). The packet-stream decode lands in M3.

use std::fs;
use std::path::PathBuf;

use wowsp_tauri_shared::{ReplayMeta, ReplayMetaLite, VehicleEntry};

/// Replay magic — first 4 bytes of every `.wowsreplay`.
const REPLAY_MAGIC: [u8; 4] = [0x12, 0x32, 0x34, 0x11];

/// Read + parse the header of one `.wowsreplay` file into a [`ReplayMeta`].
///
/// `path` must point at an existing file. On any structural problem (missing
/// magic, truncated header, unparseable JSON) the raw JSON block is still
/// returned when recoverable, so the frontend can render whatever it can.
#[tauri::command]
pub fn read_replay_header(path: String) -> Result<ReplayMeta, String> {
    let bytes = fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    let json = extract_descriptor_json(&bytes)
        .ok_or_else(|| format!("{path}: not a valid wowsreplay (magic mismatch or truncated)"))?;
    let raw: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("parse descriptor JSON: {e}"))?;
    Ok(meta_from_raw(path, raw))
}

/// Decode the packet stream of one `.wowsreplay` and return per-entity
/// position trajectories (milestone M3) annotated with each entity's creation
/// metadata (entity-create: type / vehicleId / initial position) so the frontend
/// can filter ships from capture zones / avatars.
#[tauri::command]
pub fn read_replay_positions(
    path: String,
) -> Result<Vec<wowsp_tauri_shared::EntityTrajectory>, String> {
    let bytes = fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    let stream = packet_stream_after_blocks(&bytes)
        .ok_or_else(|| format!("{path}: not a valid wowsreplay (no packet stream)"))?;
    // Roster shipIds from the descriptor JSON — the candidate set used to
    // recover each entity's shipId from its EntityCreate state stream (the
    // only reliable entity -> player join key).
    let mut candidates = std::collections::HashSet::new();
    if let Some(json) = extract_descriptor_json(&bytes) {
        if let Ok(raw) = serde_json::from_str::<serde_json::Value>(&json) {
            if let Some(arr) = raw.get("vehicles").and_then(|v| v.as_array()) {
                for v in arr {
                    if let Some(id) = v.get("shipId").and_then(|x| x.as_u64()) {
                        candidates.insert(id as u32);
                    }
                }
            }
        }
    }
    let decoded = super::packets::decode_replay(stream, &candidates)?;
    Ok(group_by_entity(decoded))
}

/// Skip the magic + JSON header blocks and return a slice over the encrypted
/// packet stream. Shared by header parsing and position decoding.
fn packet_stream_after_blocks(bytes: &[u8]) -> Option<&[u8]> {
    if bytes.len() < 8 || !bytes.starts_with(&REPLAY_MAGIC) {
        return None;
    }
    let block_count = u32::from_le_bytes(bytes[4..8].try_into().ok()?) as usize;
    let mut cur = 8;
    for _ in 0..block_count {
        if cur + 4 > bytes.len() {
            return None;
        }
        let bl = u32::from_le_bytes(bytes[cur..cur + 4].try_into().ok()?) as usize;
        cur += 4 + bl;
        if cur > bytes.len() {
            return None;
        }
    }
    Some(&bytes[cur..])
}

/// Pick the EntityProperty index that carries ship HP. The index shifts
/// between game versions (21 in 0.11.x, 20 in 14.5), so score every index by
/// how many ship entities (EntityCreate type 2) show plausible HP magnitudes
/// (a max value in [1000, 200_000]) and take the best; ties break toward the
/// index with more samples. Falls back to 20 (current version) when nothing
/// looks like HP — in that case hp_samples simply stay empty.
fn detect_hp_property(
    kinds: &std::collections::BTreeMap<i32, wowsp_tauri_shared::EntityKind>,
    properties: &std::collections::BTreeMap<i32, Vec<super::packets::PropertyChange>>,
) -> u32 {
    use std::collections::BTreeMap as Map;
    let mut scores: Map<u32, (usize, usize)> = Map::new(); // index -> (entities, samples)
    for (eid, changes) in properties {
        if kinds.get(eid).map(|k| k.entity_type) != Some(2) {
            continue;
        }
        let mut by_index: Map<u32, (u32, usize)> = Map::new(); // index -> (max, count)
        for c in changes {
            let e = by_index.entry(c.property_index).or_default();
            e.0 = e.0.max(c.value);
            e.1 += 1;
        }
        for (idx, (max, count)) in by_index {
            if (1_000..=200_000).contains(&max) {
                let s = scores.entry(idx).or_default();
                s.0 += 1;
                s.1 += count;
            }
        }
    }
    scores
        .into_iter()
        .max_by_key(|(_, (entities, samples))| (*entities, *samples))
        .map(|(idx, _)| idx)
        .unwrap_or(20)
}

/// Group the decoded per-entity positions into trajectories, attaching each
/// entity's creation metadata (type / vehicleId / spawn position) from the
/// EntityCreate packets. Ships (type 2 with many samples) sort first.
fn group_by_entity(
    decoded: super::packets::DecodedReplay,
) -> Vec<wowsp_tauri_shared::EntityTrajectory> {
    let super::packets::DecodedReplay {
        positions,
        kinds,
        destroys,
        properties,
    } = decoded;
    // Build HP timelines. The property index carrying HP is version-dependent
    // (see detect_hp_property); property 0 on capture zones tracks ownership.
    let hp_index = detect_hp_property(&kinds, &properties);
    let mut hp_map: std::collections::BTreeMap<i32, Vec<wowsp_tauri_shared::HpSample>> =
        std::collections::BTreeMap::new();
    let mut cap_map: std::collections::BTreeMap<i32, Vec<wowsp_tauri_shared::HpSample>> =
        std::collections::BTreeMap::new();
    for (eid, changes) in &properties {
        for c in changes {
            let sample = wowsp_tauri_shared::HpSample {
                time: c.time,
                value: c.value,
            };
            if c.property_index == hp_index {
                hp_map.entry(*eid).or_default().push(sample);
            } else if c.property_index == 0 {
                cap_map.entry(*eid).or_default().push(sample);
            }
        }
    }
    let mut out: Vec<_> = positions
        .into_iter()
        .map(|(entity_id, samples)| {
            let hp_samples = hp_map.remove(&entity_id).unwrap_or_default();
            let cap_samples = cap_map.remove(&entity_id).unwrap_or_default();
            wowsp_tauri_shared::EntityTrajectory {
                entity_id,
                kind: kinds.get(&entity_id).cloned(),
                samples,
                death_time: destroys.get(&entity_id).copied(),
                hp_samples,
                cap_samples,
            }
        })
        .collect();
    // Include entities that have creation metadata but no position samples
    // (e.g. static capture zones, entityType 14, which never emit Position packets).
    for (eid, kind) in &kinds {
        if !out.iter().any(|t| t.entity_id == *eid) {
            out.push(wowsp_tauri_shared::EntityTrajectory {
                entity_id: *eid,
                kind: Some(kind.clone()),
                samples: Vec::new(),
                death_time: destroys.get(eid).copied(),
                hp_samples: hp_map.remove(eid).unwrap_or_default(),
                cap_samples: cap_map.remove(eid).unwrap_or_default(),
            });
        }
    }
    // Largest trajectory first — ships have hundreds/thousands of samples,
    // transient entities (planes, torpedoes) have a few dozen.
    use std::cmp::Reverse;
    out.sort_by_key(|t| Reverse(t.samples.len()));
    out
}

/// List `.wowsreplay` files under a directory (defaults to the detected game's
/// `replays/` folder). Returns at most `limit` paths sorted newest-first.
#[tauri::command]
pub fn list_replays(dir: Option<String>, limit: Option<usize>) -> Result<Vec<String>, String> {
    let dir = resolve_replay_dir(dir)?;
    let mut entries: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    walk_replays(&dir, &mut entries);
    use std::cmp::Reverse;
    entries.sort_by_key(|(_, t)| Reverse(*t));
    let limit = limit.unwrap_or(200);
    Ok(entries
        .into_iter()
        .take(limit)
        .map(|(p, _)| p.to_string_lossy().into_owned())
        .collect())
}

/// List replays with their parsed descriptor metadata — same walk as
/// [`list_replays`], but each entry carries the lightweight summary fields
/// (date/time, match group, map, own ship, player count) instead of just a
/// path. Only the first JSON block is read per file (no packet-stream decode),
/// so a few hundred replays list in well under a second. Files whose header
/// can't be parsed still appear, with whatever fields were recoverable.
#[tauri::command]
pub fn list_replays_meta(
    dir: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<ReplayMetaLite>, String> {
    let dir = resolve_replay_dir(dir)?;
    let mut entries: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    walk_replays(&dir, &mut entries);
    use std::cmp::Reverse;
    entries.sort_by_key(|(_, t)| Reverse(*t));
    let limit = limit.unwrap_or(200);
    Ok(entries
        .into_iter()
        .take(limit)
        .map(|(p, _)| lite_from_path(&p))
        .collect())
}

/// Build a [`ReplayMetaLite`] for one replay file by reading just its
/// descriptor-JSON block. On any parse failure, returns a lite entry with only
/// the path + filename-derived datetime populated, so the file is still listed.
fn lite_from_path(path: &PathBuf) -> ReplayMetaLite {
    let path_str = path.to_string_lossy().into_owned();
    let date_time = parse_datetime_from_filename(&path_str);
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(_) => {
            return ReplayMetaLite {
                path: path_str,
                date_time,
                match_group: None,
                map_name: None,
                map_id: None,
                own_ship_id: None,
                own_ship_name: None,
                player_count: 0,
            };
        },
    };
    let json = match extract_descriptor_json(&bytes) {
        Some(j) => j,
        None => {
            return ReplayMetaLite {
                path: path_str,
                date_time,
                match_group: None,
                map_name: None,
                map_id: None,
                own_ship_id: None,
                own_ship_name: None,
                player_count: 0,
            };
        },
    };
    let raw: serde_json::Value = match serde_json::from_str(&json) {
        Ok(v) => v,
        Err(_) => {
            return ReplayMetaLite {
                path: path_str,
                date_time,
                match_group: None,
                map_name: None,
                map_id: None,
                own_ship_id: None,
                own_ship_name: None,
                player_count: 0,
            };
        },
    };
    lite_from_raw(path_str, date_time, raw)
}

/// Project the parsed descriptor JSON onto a [`ReplayMetaLite`]. Shares the
/// defensive field-pulling style of [`meta_from_raw`], but drops the roster
/// and raw JSON and resolves the recording player's ship (relation == 0).
fn lite_from_raw(
    path: String,
    date_time: Option<String>,
    raw: serde_json::Value,
) -> ReplayMetaLite {
    let obj = raw.as_object();
    let match_group = obj
        .and_then(|o| o.get("matchGroup"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let map_id = obj.and_then(|o| o.get("mapId")).and_then(|v| v.as_i64());
    let map_name = obj
        .and_then(|o| o.get("mapDisplayName"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);

    // Pull the roster just enough to count players + find the recorder (relation 0).
    let vehicles = obj
        .and_then(|o| o.get("vehicles"))
        .and_then(|v| v.as_array());
    let player_count = vehicles.map(|a| a.len()).unwrap_or(0);
    let own = vehicles.and_then(|arr| {
        arr.iter()
            .filter_map(|v| v.as_object())
            .find(|o| o.get("relation").and_then(|x| x.as_i64()).unwrap_or(-1) == 0)
    });
    let own_ship_id = own.and_then(|o| o.get("shipId")).and_then(|x| x.as_i64());
    // ship_name is left None here — the frontend resolves it via the encyclopedia.
    let own_ship_name = own
        .and_then(|o| o.get("name"))
        .and_then(|x| x.as_str())
        .map(str::to_owned);

    ReplayMetaLite {
        path,
        date_time,
        match_group,
        map_name,
        map_id,
        own_ship_id,
        own_ship_name,
        player_count,
    }
}

/// Public re-export so `arena_info` can reuse the exact same JSON extraction
/// (the live `tempArenaInfo.json` shares the replay's dual-format header).
pub fn extract_descriptor_json_pub(bytes: &[u8]) -> Option<String> {
    extract_descriptor_json(bytes)
}

/// Public re-export of [`meta_from_raw`] for `arena_info` (same JSON shape).
pub fn meta_from_raw_pub(path: String, raw: serde_json::Value) -> ReplayMeta {
    meta_from_raw(path, raw)
}

/// Pull the descriptor JSON out of a replay byte slice. Handles both the
/// binary-prefixed replay format and the bare-JSON `tempArenaInfo.json`
/// variant — the same dual-format logic ApeRadar ships.
///
/// Replay layout: `magic(4) + block_count(4) + [len(4)+payload]×block_count`.
/// The first payload is the match-descriptor JSON.
fn extract_descriptor_json(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 8 {
        if bytes.first().copied() == Some(b'{') {
            return Some(String::from_utf8_lossy(bytes).into_owned());
        }
        return None;
    }
    if !bytes.starts_with(&REPLAY_MAGIC) {
        if bytes.first().copied() == Some(b'{') {
            return Some(String::from_utf8_lossy(bytes).into_owned());
        }
        return None;
    }
    // magic(4) + block_count(4); first block = len(4) + JSON payload.
    let mut cur = 4;
    let block_count = u32::from_le_bytes(bytes[cur..cur + 4].try_into().ok()?) as usize;
    cur += 4;
    if block_count == 0 {
        return None;
    }
    // First block length.
    if cur + 4 > bytes.len() {
        return None;
    }
    let json_len = u32::from_le_bytes(bytes[cur..cur + 4].try_into().ok()?) as usize;
    cur += 4;
    let end = cur + json_len;
    if end > bytes.len() {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes[cur..end]).into_owned())
}

/// Build a [`ReplayMeta`] from the raw descriptor JSON, pulling the common
/// fields defensively. `dateTime` is parsed from the replay filename (the
/// descriptor has no timestamp).
fn meta_from_raw(path: String, raw: serde_json::Value) -> ReplayMeta {
    let obj = raw.as_object();
    let match_group = obj
        .and_then(|o| o.get("matchGroup"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let map_id = obj.and_then(|o| o.get("mapId")).and_then(|v| v.as_i64());
    let map_name = obj
        .and_then(|o| o.get("mapDisplayName"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);

    let vehicles = obj
        .and_then(|o| o.get("vehicles"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(parse_vehicle_entry)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    ReplayMeta {
        date_time: parse_datetime_from_filename(&path),
        path,
        match_group,
        map_id,
        map_name,
        vehicles,
        raw,
    }
}

/// Filenames look like `20250622_152405_PJSB719-Hotaka_15_NE_north.wowsreplay`;
/// the leading `YYYYMMDD_HHMMSS` is the only timestamp source. Both segments
/// are 8/6 pure digits; we return them joined by `_` when both are present,
/// falling back to the date alone if only the first matches.
fn parse_datetime_from_filename(path: &str) -> Option<String> {
    let name = std::path::Path::new(path).file_name()?.to_str()?;
    let mut parts = name.split('_');
    let date = parts.next()?;
    let is_digits = |s: &str, n: usize| s.len() == n && s.chars().all(|c| c.is_ascii_digit());
    if !is_digits(date, 8) {
        return None;
    }
    match parts.next() {
        Some(t) if is_digits(t, 6) => Some(format!("{date}_{t}")),
        _ => Some(date.to_owned()),
    }
}

fn parse_vehicle_entry(v: &serde_json::Value) -> Option<VehicleEntry> {
    let obj = v.as_object()?;
    Some(VehicleEntry {
        id: obj.get("id").and_then(|x| x.as_i64()).unwrap_or(0),
        name: obj
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_owned(),
        relation: obj.get("relation").and_then(|x| x.as_i64()).unwrap_or(0),
        ship_id: obj.get("shipId").and_then(|x| x.as_i64()).unwrap_or(0),
        ship_name: None,
    })
}

fn resolve_replay_dir(dir: Option<String>) -> Result<PathBuf, String> {
    if let Some(d) = dir {
        return Ok(PathBuf::from(d));
    }
    if let Ok(d) = std::env::var("WOWSP_REPLAY_DIR") {
        return Ok(PathBuf::from(d));
    }
    if let Ok(game) = std::env::var("WOWSP_GAME_PATH") {
        return Ok(PathBuf::from(game).join("replays"));
    }
    // Last resort: auto-detect the install (registry + Steam) and use its
    // `replays/` folder. This is the common path when the frontend doesn't pass
    // an explicit dir (e.g. CLI use, or a caller that didn't wire up the
    // config store). The frontend normally passes the active install's path.
    if let Some(detected) = super::game_detect::detect_game_install().into_iter().next() {
        return Ok(PathBuf::from(&detected.path).join("replays"));
    }
    Err("no replay dir: pass `dir`, or set WOWSP_REPLAY_DIR / WOWSP_GAME_PATH".into())
}

fn walk_replays(dir: &PathBuf, out: &mut Vec<(PathBuf, std::time::SystemTime)>) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for ent in rd.flatten() {
        let path = ent.path();
        let Ok(meta) = ent.metadata() else { continue };
        if meta.is_dir() {
            walk_replays(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("wowsreplay") {
            if let Ok(mtime) = meta.modified() {
                out.push((path, mtime));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// HP property detection picks the index where ship entities show
    /// plausible HP magnitudes, regardless of game version.
    #[test]
    fn detect_hp_property_scores_by_magnitude() {
        let mut kinds = std::collections::BTreeMap::new();
        kinds.insert(
            1,
            wowsp_tauri_shared::EntityKind {
                entity_type: 2,
                vehicle_id: 7770,
                initial_x: 0.0,
                initial_y: 0.0,
                initial_z: 0.0,
                creation_time: 0.0,
                ship_id: None,
            },
        );
        let change = |property_index: u32, value: u32| super::super::packets::PropertyChange {
            time: 0.0,
            entity_id: 1,
            property_index,
            value,
        };
        // Version A layout: HP at 21 (values ~20k), flags at 20 (small ints).
        let props_a = std::collections::BTreeMap::from([(
            1,
            vec![
                change(21, 20340),
                change(21, 19800),
                change(20, 2),
                change(20, 0),
            ],
        )]);
        assert_eq!(detect_hp_property(&kinds, &props_a), 21);
        // Version B layout: HP at 20.
        let props_b = std::collections::BTreeMap::from([(
            1,
            vec![change(20, 26650), change(20, 25100), change(21, 3)],
        )]);
        assert_eq!(detect_hp_property(&kinds, &props_b), 20);
        // No plausible HP anywhere -> default 20.
        let props_c = std::collections::BTreeMap::from([(1, vec![change(7, 5)])]);
        assert_eq!(detect_hp_property(&kinds, &props_c), 20);
    }

    /// Synthetic replay: magic + 1 block + a tiny JSON descriptor. Verifies the
    /// block-count format is parsed correctly (the bug the skeleton had).
    #[test]
    fn parses_synthetic_replay_header() {
        let json = r#"{"matchGroup":"pvp","mapDisplayName":"15_NE_north","mapId":8,"vehicles":[]}"#;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&REPLAY_MAGIC);
        bytes.extend_from_slice(&1u32.to_le_bytes()); // 1 block
        bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
        bytes.extend_from_slice(json.as_bytes());
        let extracted = extract_descriptor_json(&bytes).expect("must extract JSON");
        assert!(extracted.contains("15_NE_north"));
        let raw: serde_json::Value = serde_json::from_str(&extracted).unwrap();
        let meta = meta_from_raw("20250622_152405_x.wowsreplay".into(), raw);
        assert_eq!(meta.map_name.as_deref(), Some("15_NE_north"));
        assert_eq!(meta.map_id, Some(8));
        assert_eq!(meta.match_group.as_deref(), Some("pvp"));
        // dateTime now retains the full YYYYMMDD_HHMMSS from the filename.
        assert_eq!(meta.date_time.as_deref(), Some("20250622_152405"));
    }

    /// Datetime parser keeps the time-of-day segment and tolerates a date-only
    /// filename (older clients / renamed files).
    #[test]
    fn datetime_parser_keeps_time_or_date() {
        assert_eq!(
            parse_datetime_from_filename("20250622_152405_PJSB719-Hotaka_15_NE_north.wowsreplay")
                .as_deref(),
            Some("20250622_152405"),
        );
        assert_eq!(
            parse_datetime_from_filename("20250622_someother.wowsreplay").as_deref(),
            Some("20250622"),
        );
        assert!(parse_datetime_from_filename("replay.wowsreplay").is_none());
    }

    /// The lite projection counts players and finds the recorder's ship
    /// (relation == 0) without retaining the roster or raw JSON.
    #[test]
    fn lite_from_raw_finds_own_ship() {
        let json = r#"{"matchGroup":"ranked","mapDisplayName":"15_NE_north","mapId":8,"vehicles":[
            {"id":1,"name":"Alpha","relation":0,"shipId":4182828960},
            {"id":2,"name":"Bravo","relation":1,"shipId":4286591792},
            {"id":3,"name":"Enemy","relation":2,"shipId":4292851696}
        ]}"#;
        let raw: serde_json::Value = serde_json::from_str(json).unwrap();
        let lite = lite_from_raw(
            "20250622_152405_x.wowsreplay".into(),
            Some("20250622_152405".into()),
            raw,
        );
        assert_eq!(lite.match_group.as_deref(), Some("ranked"));
        assert_eq!(lite.map_name.as_deref(), Some("15_NE_north"));
        assert_eq!(lite.player_count, 3);
        assert_eq!(lite.own_ship_id, Some(4182828960));
        assert_eq!(lite.own_ship_name.as_deref(), Some("Alpha"));
    }

    /// If a real replay is available on this machine, parse it end-to-end.
    #[test]
    fn parses_real_replay_if_present() {
        let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
            return; // no real replay on this machine — skip
        };
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        let json = extract_descriptor_json(&bytes)
            .unwrap_or_else(|| panic!("no descriptor JSON in {path}"));
        let raw: serde_json::Value = serde_json::from_str(&json).expect("descriptor must be JSON");
        let meta = meta_from_raw(path.clone(), raw);
        assert!(!meta.vehicles.is_empty(), "roster must not be empty");
        assert!(meta.map_name.is_some(), "mapDisplayName must be present");
        eprintln!(
            "[real-replay] {}  map={}, {} players",
            path,
            meta.map_name.unwrap(),
            meta.vehicles.len()
        );
    }

    /// Diagnostic: dump a real replay's header + trajectories to JSON, used to
    /// feed the mock backend (`scripts/mock/fixtures/replay_dump.json`) so the
    /// holographic map can render a real match in a browser. Run with
    /// `WOWSP_TEST_REPLAY=<path> [WOWSP_DUMP_OUT=out.json]`.
    #[test]
    fn dump_replay_json() {
        let Some(path) = std::env::var("WOWSP_TEST_REPLAY").ok() else {
            return;
        };
        let meta = read_replay_header(path.clone()).expect("header");
        let trajs = read_replay_positions(path).expect("positions");
        let out = serde_json::json!({
            "meta": meta,
            "trajectories": trajs,
        });
        let out_path =
            std::env::var("WOWSP_DUMP_OUT").unwrap_or_else(|_| "replay_dump.json".to_string());
        std::fs::write(&out_path, serde_json::to_string(&out).unwrap()).unwrap();
        eprintln!("dumped to {out_path}");
    }
}
