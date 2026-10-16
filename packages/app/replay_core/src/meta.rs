//! Replay container framing + header parsing: the magic/block layout, the
//! descriptor JSON extraction, the WG/Lesta roster projections behind
//! [`ReplayMeta`]/[`ReplayMetaLite`], and the nickname classifiers the arena
//! surfaces share. Split from the former single-file `commands/replay.rs`,
//! then lifted into the reusable decoding core (wave 4a) — the Tauri
//! command wrapper (`read_replay_header`) stayed behind in the app crate
//! (`wowsp_tauri::commands::replay::wire`).

use std::fs;

use wowsp_tauri_shared::{ReplayMeta, ReplayMetaLite, VehicleEntry};

/// Replay magic — first 4 bytes of every `.wowsreplay`.
pub const REPLAY_MAGIC: [u8; 4] = [0x12, 0x32, 0x34, 0x11];

/// Generous upper bound on any one metadata block: real descriptors run a
/// few hundred KB (roster-heavy), so a length prefix beyond this is a corrupt
/// or malicious header, not a block worth buffering.
const MAX_FIRST_BLOCK_BYTES: usize = 16 * 1024 * 1024;

/// Read one metadata block of a replay file by index (0 = the descriptor
/// JSON, 1 = the Lesta roster JSON, ...): the 8-byte prologue (magic + block
/// count), then the 4-byte little-endian length prefixes of every block
/// before `index` — their payloads are SEEKED past, never buffered — and
/// finally `index`'s length + payload. Same framing
/// [`extract_descriptor_json`] parses on an in-memory slice, minus the
/// multi-MB packet stream that follows. Lengths above
/// [`MAX_FIRST_BLOCK_BYTES`] are rejected so a corrupt prefix can never
/// drive a huge allocation or read.
pub fn read_block(path: &std::path::Path, index: usize) -> std::io::Result<Vec<u8>> {
    use std::io::{Read as _, Seek as _, SeekFrom};
    let mut f = fs::File::open(path)?;
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic)?;
    if magic != REPLAY_MAGIC {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "not a wowsreplay container (magic mismatch)",
        ));
    }
    let mut count = [0u8; 4];
    f.read_exact(&mut count)?;
    let block_count = u32::from_le_bytes(count) as usize;
    if block_count == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "wowsreplay container has no blocks",
        ));
    }
    if index >= block_count {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            format!("wowsreplay container has {block_count} blocks, block {index} missing"),
        ));
    }
    let mut len = [0u8; 4];
    for _ in 0..index {
        f.read_exact(&mut len)?;
        let skip = u32::from_le_bytes(len);
        f.seek(SeekFrom::Current(i64::from(skip)))?;
    }
    f.read_exact(&mut len)?;
    let block_len = u32::from_le_bytes(len) as usize;
    if block_len > MAX_FIRST_BLOCK_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("block {index} length {block_len} exceeds {MAX_FIRST_BLOCK_BYTES}"),
        ));
    }
    let mut payload = vec![0u8; block_len];
    f.read_exact(&mut payload)?;
    Ok(payload)
}

/// Build a [`ReplayMetaLite`] for one replay file by reading just its
/// descriptor-JSON block. On any read/parse failure, returns a lite entry with
/// only the path + filename-derived datetime populated, so the file is still
/// listed.
///
/// Shared by the app's playtime battle ledger and the replay-corpus scanner —
/// never duplicate the header parse.
pub fn lite_from_path(path: &std::path::Path) -> ReplayMetaLite {
    lite_and_client_version(path).0
}

/// [`lite_from_path`] plus the descriptor's `clientVersionFromExe`
/// (normalized to dot-numeric), sharing ONE bounded block-0 read — the
/// contribution planner (the app's commands/contribution/) wants both
/// projections per file, so the header bytes are parsed exactly once.
pub fn lite_and_client_version(path: &std::path::Path) -> (ReplayMetaLite, Option<String>) {
    let path_str = path.to_string_lossy().into_owned();
    let date_time = parse_datetime_from_filename(&path_str);
    // The walk only surfaces replay containers (`*.wowsreplay` and the Lesta
    // `*.korablireplay`, same framing), never the bare-JSON tempArenaInfo
    // variant, so the bounded block read is the only input path needed — the
    // multi-MB packet stream behind the header is never touched. A Lesta
    // descriptor (no `vehicles`) additionally pulls its roster from blocks 1
    // and 2 through the same bounded reads. Any read/parse failure falls back
    // to the path + filename-datetime entry below.
    let raw: Option<serde_json::Value> = read_block(path, 0)
        .ok()
        .and_then(|payload| serde_json::from_str(&String::from_utf8_lossy(&payload)).ok());
    let client_version = raw
        .as_ref()
        .and_then(|r| client_version_from_raw(r.get("clientVersionFromExe")));
    let lite = match raw {
        Some(raw) => lite_from_raw(path_str, date_time, raw),
        None => ReplayMetaLite {
            path: path_str,
            date_time,
            match_group: None,
            map_name: None,
            map_id: None,
            scenario: None,
            event_type: None,
            bot_count: 0,
            scripted_unit_count: 0,
            own_ship_id: None,
            player_name: None,
            player_count: 0,
            install_path: None,
            install_kind: None,
            install_realm: None,
        },
    };
    (lite, client_version)
}

/// Normalize the descriptor's `clientVersionFromExe` into the dot-numeric
/// form the replay-share contract compares (`14.5.0` ≥ `14.0`): clients
/// write comma-separated 4-tuples (`26,10,0,8867689`), so keep at most the
/// first three NUMERIC segments and join them with dots. Anything without a
/// leading numeric segment (or absent entirely) answers `None`.
pub fn client_version_from_raw(value: Option<&serde_json::Value>) -> Option<String> {
    let raw = value?.as_str()?;
    let numeric: Vec<&str> = raw
        .split([',', '.'])
        .map(str::trim)
        .take_while(|part| part.parse::<u64>().is_ok())
        .take(3)
        .collect();
    if numeric.is_empty() {
        None
    } else {
        Some(numeric.join("."))
    }
}

/// Project the parsed descriptor JSON onto a [`ReplayMetaLite`]. Shares the
/// defensive field-pulling style of [`meta_from_raw`] and the same roster
/// source ([`roster_from_raw`] — WG `vehicles`, or the synthesized Lesta
/// roster), resolving the recording player's ship (relation == 0).
pub fn lite_from_raw(
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
    let scenario = obj
        .and_then(|o| o.get("scenario"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let event_type = obj
        .and_then(|o| o.get("eventType"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);

    // Pull the roster just enough to count players + find the recorder
    // (relation 0). For a Lesta descriptor this synthesizes the roster from
    // block[1]/block[2] — the path is only re-opened when the descriptor
    // carries no `vehicles` array.
    let vehicles = roster_from_raw(std::path::Path::new(&path), &raw);
    // Listed players only: scripted scenario NPCs (`IDS_*` text keys, `#Name`
    // — story-mode ally flagships riding relation-1 slots) are not players
    // and sit out the count, matching the frontend's roster filtering
    // (utils/rosterSides). The `:Name:` co-op bot fills stay counted — they
    // really are team slots.
    let player_count = vehicles
        .iter()
        .filter(|v| !is_scripted_unit_nickname(&v.name))
        .count();
    let (bot_count, scripted_unit_count) =
        vehicles.iter().fold((0u32, 0u32), |(bots, scripted), v| {
            (
                bots + u32::from(is_bot_nickname(&v.name)),
                scripted + u32::from(is_scripted_unit_nickname(&v.name)),
            )
        });
    let own = vehicles.iter().find(|v| v.relation == 0);
    let own_ship_id = own.map(|v| v.ship_id);
    // The recorder's identity: the descriptor's own `playerName` (the
    // client writes it verbatim, Lesta included) with the relation-0 roster
    // entry's `name` as the fallback for headers that omit it. Roster names
    // are player nicknames on both clients — the descriptor carries no ship
    // name, which is why the list card titles a replay with this.
    let player_name = obj
        .and_then(|o| o.get("playerName"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            own.map(|v| v.name.trim().to_owned())
                .filter(|name| !name.is_empty())
        });

    ReplayMetaLite {
        path,
        date_time,
        match_group,
        map_name,
        map_id,
        scenario,
        event_type,
        bot_count,
        scripted_unit_count,
        own_ship_id,
        player_name,
        player_count,
        // Filled by the scan that owns the root — see `scan_all_replays_meta`.
        install_path: None,
        install_kind: None,
        install_realm: None,
    }
}
/// Pull the descriptor JSON out of a replay byte slice. Handles both the
/// binary-prefixed replay format and the bare-JSON `tempArenaInfo.json`
/// variant — the same dual-format logic ApeRadar ships.
///
/// Replay layout: `magic(4) + block_count(4) + [len(4)+payload]×block_count`.
/// The first payload is the match-descriptor JSON.
pub fn extract_descriptor_json(bytes: &[u8]) -> Option<String> {
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

/// Skip the magic + JSON header blocks and return a slice over the encrypted
/// packet stream. Shared by header parsing and position decoding (the app's
/// replay-stream command and the replay-corpus decoder both enter the packet
/// stage through this).
pub fn packet_stream_after_blocks(bytes: &[u8]) -> Option<&[u8]> {
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

/// Build a [`ReplayMeta`] from the raw descriptor JSON, pulling the common
/// fields defensively. `dateTime` is parsed from the replay filename (the
/// descriptor has no timestamp).
pub fn meta_from_raw(path: String, raw: serde_json::Value) -> ReplayMeta {
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
    let scenario = obj
        .and_then(|o| o.get("scenario"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let event_type = obj
        .and_then(|o| o.get("eventType"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);

    let vehicles = roster_from_raw(std::path::Path::new(&path), &raw);
    let bot_count = vehicles.iter().filter(|v| is_bot_nickname(&v.name)).count() as u32;
    let scripted_unit_count = vehicles
        .iter()
        .filter(|v| is_scripted_unit_nickname(&v.name))
        .count() as u32;

    ReplayMeta {
        // Replay files carry no timestamp in the descriptor (filename wins);
        // the live tempArenaInfo.json HAS a "dateTime" field and no date in
        // its name, so the descriptor is the fallback there.
        date_time: parse_datetime_from_filename(&path).or_else(|| {
            obj.and_then(|o| o.get("dateTime"))
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        }),
        path,
        match_group,
        map_id,
        map_name,
        scenario,
        event_type,
        bot_count,
        scripted_unit_count,
        vehicles,
        raw,
    }
}

/// The client fills bot rosters with colon-wrapped nicknames (`:Sturdee:`)
/// and scripted scenario units with their text-key / scenario-style nickname
/// (see [`is_scripted_unit_nickname`]) — the same markers the frontend's
/// `isAiName` uses to skip WG API lookups. Mirrors that
/// `^(?::.*:|IDS_.*|#.+)$` rule.
pub fn is_bot_nickname(name: &str) -> bool {
    is_scripted_unit_nickname(name)
        || (name.len() >= 2 && name.starts_with(':') && name.ends_with(':'))
}

/// Scripted scenario units — operation (行动) fleets whose nickname is the
/// client text key (`IDS_OP_15_DUMMY_01`, `IDS_SCENARIO_...`, the tutorial
/// `IDS_AL_01`/`IDS_EN_01`) or the `#Name` scenario style. Unlike the
/// `:Name:` bots that official co-op / random battles fill, these field only
/// in scripted scenarios (operations and the intro/tutorial battles), so
/// their count doubles as an operation fingerprint for the frontend mode
/// classifier (see `ReplayMeta::scripted_unit_count`).
pub fn is_scripted_unit_nickname(name: &str) -> bool {
    name.starts_with("IDS_") || (name.len() >= 2 && name.starts_with('#'))
}

/// Whether this battle is a REAL operation (行动) — the PCVO*/`_op_`/`_hl_`
/// descriptor fingerprints plus the roster scan for arena files whose
/// descriptor carries no scenario (a `pve` matchGroup with `IDS_OP_*`
/// nicknames), EXCLUDING the tutorial family (`low_lvl_operation`,
/// `first_battle`, the `IDS_OP_15_*` escort op) whose scripted units field
/// as real team rows. Exact mirror of the frontend's `isOperationBattle`
/// (utils/modeColors.ts): the live surfaces' scripted-unit filtering
/// (arena_info's `note_arena_seen` in the app, the webui's
/// `splitLiveRosterSides`) keys on the same rule on both sides of the IPC
/// boundary, so the sink solver's ally block and the frontend's ally order
/// stay index-aligned.
pub fn is_operation_battle(
    match_group: Option<&str>,
    scenario: Option<&str>,
    event_type: Option<&str>,
    vehicles: &[wowsp_tauri_shared::VehicleEntry],
) -> bool {
    let sc = scenario.unwrap_or("").to_lowercase();
    let et = event_type.unwrap_or("").to_lowercase();
    if sc.starts_with("low_lvl_operation") || sc == "first_battle" {
        return false;
    }
    if et.starts_with("low_lvl_operation") || et == "first_battle" {
        return false;
    }
    if vehicles
        .iter()
        .any(|v| v.name.to_uppercase().starts_with("IDS_OP_15_"))
    {
        return false;
    }
    if et.starts_with("pcvo") || sc.starts_with("pcvo") {
        return true;
    }
    if et.contains("_op_") || sc.contains("_op_") || sc.contains("_hl_") {
        return true;
    }
    match_group.unwrap_or("").eq_ignore_ascii_case("pve")
        && vehicles
            .iter()
            .any(|v| v.name.to_uppercase().starts_with("IDS_OP_"))
}

/// Filenames look like `20250622_152405_PJSB719-Hotaka_15_NE_north.wowsreplay`;
/// the leading `YYYYMMDD_HHMMSS` is the only timestamp source. Both segments
/// are 8/6 pure digits; we return them joined by `_` when both are present,
/// falling back to the date alone if only the first matches.
pub fn parse_datetime_from_filename(path: &str) -> Option<String> {
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

/// The roster behind a parsed descriptor — the single source shared by the
/// full ([`meta_from_raw`]) and lite ([`lite_from_raw`]) projections, never
/// duplicated. WG descriptors carry the roster inline (`vehicles`); a
/// descriptor without one is the Lesta container, whose roster is
/// synthesized from block[1]/block[2] ([`lesta_roster`]).
pub fn roster_from_raw(path: &std::path::Path, raw: &serde_json::Value) -> Vec<VehicleEntry> {
    if let Some(arr) = raw.get("vehicles").and_then(|v| v.as_array()) {
        return arr.iter().filter_map(parse_vehicle_entry).collect();
    }
    lesta_roster(path, raw)
}

/// One positional `playersPublicInfo` entry (see the module docs for the
/// layout). Every slot is pulled defensively: an entry without its identity
/// slots is dropped, missing optional slots heal to WG-neutral defaults.
struct LestaPlayer {
    id: i64,
    name: String,
    team: i64,
    ship_id: i64,
}

/// Parse one `playersPublicInfo` positional array: `[0]` account id, `[1]`
/// name, `[6]` team (0/1), `[7]` shipId.
fn parse_lesta_player(entry: &serde_json::Value) -> Option<LestaPlayer> {
    let arr = entry.as_array()?;
    let get_i64 = |i: usize| arr.get(i).and_then(|v| v.as_i64());
    let get_str = |i: usize| arr.get(i).and_then(|v| v.as_str());
    Some(LestaPlayer {
        id: get_i64(0)?,
        name: get_str(1)?.to_owned(),
        team: get_i64(6).unwrap_or(0),
        ship_id: get_i64(7).unwrap_or(0),
    })
}

/// Synthesize a WG-shaped roster for a Lesta descriptor (no `vehicles`):
/// block[1] carries the roster as `playersPublicInfo` positional arrays,
/// block[2] pins the recorder. Relations follow the WG rule once the
/// recorder is known — 0 for the recorder, 1 for its team, 2 for the other.
///
/// Defensive throughout: a block[1]/block[2] that is missing, unparseable
/// or roster-less degrades to an empty list (the descriptor's own fields
/// still parse) — a Lesta header read must never fail the whole parse.
fn lesta_roster(path: &std::path::Path, descriptor: &serde_json::Value) -> Vec<VehicleEntry> {
    let players: Vec<LestaPlayer> = read_block(path, 1)
        .ok()
        .and_then(|payload| {
            serde_json::from_str::<serde_json::Value>(&String::from_utf8_lossy(&payload)).ok()
        })
        .and_then(|raw| {
            raw.get("playersPublicInfo")
                .and_then(|v| v.as_object())
                .map(|entries| entries.values().filter_map(parse_lesta_player).collect())
        })
        .unwrap_or_default();
    if players.is_empty() {
        return Vec::new();
    }
    // The recorder: block[2]'s leading integer (`"<accountDBID>.<arenaID>"`)
    // when it lands on a roster entry, else the descriptor's `playerName`
    // matched against the names, else the first positive-id (human) entry.
    let recorder_from_marker = read_block(path, 2).ok().and_then(|payload| {
        let text = String::from_utf8_lossy(&payload);
        text.trim()
            .split('.')
            .next()
            .and_then(|head| head.trim().parse::<i64>().ok())
    });
    let self_idx = recorder_from_marker
        .and_then(|id| players.iter().position(|p| p.id == id))
        .or_else(|| {
            descriptor
                .get("playerName")
                .and_then(|v| v.as_str())
                .and_then(|name| players.iter().position(|p| p.name == name))
        })
        .or_else(|| players.iter().position(|p| p.id > 0));
    let Some(self_idx) = self_idx else {
        return Vec::new();
    };
    let self_team = players[self_idx].team;
    players
        .into_iter()
        .enumerate()
        .map(|(i, p)| VehicleEntry {
            relation: if i == self_idx {
                0
            } else if p.team == self_team {
                1
            } else {
                2
            },
            id: p.id,
            name: p.name,
            ship_id: p.ship_id,
            ship_name: None,
        })
        .collect()
}
