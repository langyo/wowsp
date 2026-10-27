//! Per-(map, mode) capture-point layouts, learned from the local replay
//! history — the exact positions the SERVER composed each battle with.
//!
//! The game client carries no such data: a space's VFS folder holds only
//! terrain/art/settings (verified against a live install — no GamePlay
//! entity file exists per space), because WG composes mode layouts
//! server-side and ships them to the client as entities at battle start.
//! The replay records those EntityCreate packets, and the parser already
//! recovers every capture zone (entityType 14: position, radius, point
//! index, initial owner, appearance time). So the plan board's "true"
//! layout source is the player's own replays:
//!
//!   - [`get_map_cap_layouts`] groups the map's replays by (matchGroup,
//!     scenario) — the scenario id ("domination_3point") IS the layout
//!     identity — takes the NEWEST replay per group (layouts shift between
//!     patches; newest is current), decodes it and returns its capture
//!     points in world units.
//!   - The map-setup wizard shows the learned layouts ("实测") above the
//!     hand-made templates; a map never played here simply has none.

use anyhow::anyhow;

use serde::Serialize;

use wowsp_tauri_shared::CommandResult;

/// One capture point as the replay recorded it (world units, x = east,
/// z = north — the same frame as positions).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnedCapPoint {
    /// 0-based point index (A = 0, B = 1, …) from the create packet.
    pub index: i32,
    pub x: f32,
    pub z: f32,
    /// Ring radius as scanned from the create state (world units); None
    /// when the scan found nothing — the frontend floors it.
    pub radius: Option<f32>,
    /// Initial owner (0/1 = team, -1 = neutral), None when unknown.
    pub team: Option<i8>,
    /// Battle second the point appeared at (operations with conditional
    /// objectives); None = present from the start.
    pub appear_t: Option<f32>,
}

/// One replay file behind a learned layout (tooltip provenance).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnedReplaySource {
    /// File name (no directory — the list is for reading, not opening).
    pub name: String,
    /// Recorded date ("YYYYMMDD_HHMMSS"), when parsed.
    pub time: Option<String>,
}

/// One learned layout: the cap set of one (matchGroup, scenario) group,
/// with every replay that produced the SAME arrangement folded in
/// (content-level duplicates merge; the list length is the repeat count).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnedCapLayout {
    /// Descriptor match group ("pvp", "ranked", "clan", "event", …).
    pub mode_group: Option<String>,
    /// Descriptor scenario id ("domination_3point", "epicenter", …) — the
    /// layout identity inside the group.
    pub scenario: Option<String>,
    /// File name of the replay the layout was read from (provenance).
    pub source_replay: String,
    /// That replay's recorded date ("YYYYMMDD_HHMMSS"), when parsed.
    pub source_time: Option<String>,
    /// Team id (0/1) the layout's replay was recorded FROM — caps whose
    /// team equals it are the recorder's side ("ally"). None when the
    /// arena join could not anchor the recorder.
    pub recorder_team: Option<i8>,
    /// Every replay that yielded this exact arrangement, newest first.
    pub replays: Vec<LearnedReplaySource>,
    pub caps: Vec<LearnedCapPoint>,
}

/// Capture layouts of one map, learned from its newest replay per
/// (matchGroup, scenario). `dir` follows the replay-dir resolution the
/// library uses (None = the active install's replays). Desktop only — the
/// scan needs local replay files.
#[tauri::command]
pub async fn get_map_cap_layouts(
    space_id: String,
    dir: Option<String>,
) -> CommandResult<Vec<LearnedCapLayout>> {
    #[cfg(mobile)]
    {
        let _ = (space_id, dir);
        return Err(anyhow!("战术点位学习需要本机录像文件。").into());
    }
    #[cfg(desktop)]
    {
        Ok(
            tokio::task::spawn_blocking(move || learn_cap_layouts(&space_id, dir))
                .await
                .map_err(|e| anyhow!("cap-layout scan task failed: {e}"))??,
        )
    }
}

/// Read ONE explicitly picked replay and lift its capture layout (the
/// manual-import path of the cap editor: a Neptune-series practice
/// recording, say, yields its exact points without being in the scanned
/// history). Ok(None) = the file carries no capture points.
#[tauri::command]
pub async fn get_replay_cap_layout(path: String) -> CommandResult<Option<LearnedCapLayout>> {
    #[cfg(mobile)]
    {
        let _ = path;
        return Err(anyhow!("战术点位学习需要本机录像文件。").into());
    }
    #[cfg(desktop)]
    {
        Ok(
            tokio::task::spawn_blocking(move || replay_cap_layout(&path))
                .await
                .map_err(|e| anyhow!("cap-layout read task failed: {e}"))??,
        )
    }
}

/// Synchronous core of [`get_replay_cap_layout`].
#[cfg(desktop)]
fn replay_cap_layout(path: &str) -> anyhow::Result<Option<LearnedCapLayout>> {
    let p = std::path::Path::new(path);
    // mod.rs re-exports wowsp_replay_core's lite meta reader pub(crate).
    let meta = super::lite_from_path(p);
    let Some((caps, recorder_team)) = caps_of_replay(p) else {
        return Ok(None);
    };
    if caps.is_empty() {
        return Ok(None);
    }
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    Ok(Some(LearnedCapLayout {
        mode_group: meta.match_group.clone(),
        scenario: meta.scenario.clone(),
        source_replay: name.clone(),
        source_time: meta.date_time.clone(),
        recorder_team,
        replays: vec![LearnedReplaySource {
            name,
            time: meta.date_time.clone(),
        }],
        caps,
    }))
}

/// Grouping key of the meta scan — every field that distinguishes two
/// layouts of the same map.
fn group_of(meta: &wowsp_tauri_shared::ReplayMetaLite) -> (Option<String>, Option<String>) {
    (meta.match_group.clone(), meta.scenario.clone())
}

/// Grouping key of the content-dedup pass: one cap as (index, quantised
/// x/z, owner, appear second) — see the dedup comment inside.
type CapKeyPart = (i32, i32, i32, Option<i8>, Option<i32>);

/// Synchronous core (unit-testable with an explicit dir).
#[cfg(desktop)]
fn learn_cap_layouts(space_id: &str, dir: Option<String>) -> anyhow::Result<Vec<LearnedCapLayout>> {
    use std::path::Path;

    let (_, metas) = super::listing::scan_replays_meta(dir, None)?;
    // The metas arrive newest-first. Group EVERY replay of the map by
    // (matchGroup, scenario) — the counts and tooltip lists come straight
    // off these metas (no decode) — but only the NEWEST member of each
    // group is decoded (layouts shift between patches; newest is current).
    type GroupKey = (Option<String>, Option<String>);
    let mut groups: Vec<(GroupKey, Vec<wowsp_tauri_shared::ReplayMetaLite>)> = Vec::new();
    let mut index: std::collections::HashMap<GroupKey, usize> = std::collections::HashMap::new();
    for meta in metas {
        if meta.map_name.as_deref() != Some(space_id) {
            continue;
        }
        let key = group_of(&meta);
        let slot = match index.get(&key) {
            Some(&i) => i,
            None => {
                groups.push((key.clone(), Vec::new()));
                index.insert(key, groups.len() - 1);
                groups.len() - 1
            },
        };
        groups[slot].1.push(meta);
    }
    let mut out = Vec::new();
    for ((mode_group, scenario), members) in groups {
        let meta = &members[0];
        let path = Path::new(&meta.path);
        let Some((caps, recorder_team)) = caps_of_replay(path) else {
            continue;
        };
        if caps.is_empty() {
            continue;
        }
        out.push(LearnedCapLayout {
            mode_group,
            scenario,
            source_replay: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| meta.path.clone()),
            source_time: meta.date_time.clone(),
            recorder_team,
            replays: members
                .iter()
                .map(|m| LearnedReplaySource {
                    name: Path::new(&m.path)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| m.path.clone()),
                    time: m.date_time.clone(),
                })
                .collect(),
            caps,
        });
    }
    // Content-level dedup ACROSS groups (the same arrangement under two
    // descriptors — pvp and ranked sharing a domination set, say — is one
    // entry): identical cap sets (index, quantised position, owner, appear
    // time; radius deliberately excluded — its scan jitters) merge into the
    // first-seen entry (first-seen order is newest-overall), the replay
    // lists concatenate and re-sort newest-first.
    let mut deduped: Vec<LearnedCapLayout> = Vec::new();
    let mut keys: Vec<Vec<CapKeyPart>> = Vec::new();
    for layout in out {
        let mut key: Vec<CapKeyPart> = layout
            .caps
            .iter()
            .map(|c| {
                (
                    c.index,
                    (c.x * 2.0).round() as i32,
                    (c.z * 2.0).round() as i32,
                    c.team,
                    c.appear_t.map(|t| t.round() as i32),
                )
            })
            .collect();
        key.sort_unstable();
        match keys.iter().position(|k| *k == key) {
            Some(i) => {
                deduped[i].replays.extend(layout.replays);
                deduped[i].replays.sort_by(|a, b| b.time.cmp(&a.time));
            },
            None => {
                keys.push(key);
                deduped.push(layout);
            },
        }
    }
    let mut out = deduped;
    // Stable, readable order: group then scenario.
    out.sort_by(|a, b| {
        (
            a.mode_group.as_deref().unwrap_or(""),
            a.scenario.as_deref().unwrap_or(""),
        )
            .cmp(&(
                b.mode_group.as_deref().unwrap_or(""),
                b.scenario.as_deref().unwrap_or(""),
            ))
    });
    Ok(out)
}

/// Decode one replay and lift its capture zones out of the entity table.
/// Ok(None) = not a parsable replay (foreign/corrupt file) — the caller
/// skips the group rather than failing the whole scan. The geometry lift
/// itself lives in the decoding core (`wowsp_replay_core::caps::
/// cap_points_of`), shared with the replay-corpus aggregator (wave 4a).
/// The decode rides the shared file prologue (`streams::
/// decode_replay_file_decoded`): the former hand-rolled copy passed no
/// client version and no roster candidates, so version-gated layouts
/// never fired and the recorder-team join below could not succeed.
#[cfg(desktop)]
fn caps_of_replay(path: &std::path::Path) -> Option<(Vec<LearnedCapPoint>, Option<i8>)> {
    let (decoded, _roster) = super::streams::decode_replay_file_decoded(path).ok()?;
    let caps = wowsp_replay_core::caps::cap_points_of(&decoded)
        .into_iter()
        .map(|c| LearnedCapPoint {
            index: c.index,
            x: c.x,
            z: c.z,
            radius: c.radius,
            team: c.team,
            appear_t: c.appear_t,
        })
        .collect();
    // The recorder's team id anchors which cap owner is "ours" — the
    // arena state's is_self row is the authoritative join.
    let recorder_team = decoded
        .arena_players
        .iter()
        .find(|p| p.is_self)
        .map(|p| p.team_id);
    Some((caps, recorder_team))
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    /// Live probe against a real install — run explicitly with
    /// `WOWSP_PROBE_GAME_ROOT` (and optional `WOWSP_PROBE_SPACE`) set:
    ///   cargo test -p wowsp_tauri probe_cap_layouts -- --ignored --nocapture
    /// Prints every learned (map-group, scenario) layout's points so the
    /// extracted coordinates/radii can be eyeballed against the map.
    /// Debug listing: print every map_name the meta scan sees.
    #[test]
    #[ignore]
    fn probe_cap_layouts() {
        let root = std::env::var("WOWSP_PROBE_GAME_ROOT").expect("set WOWSP_PROBE_GAME_ROOT");
        let space =
            std::env::var("WOWSP_PROBE_SPACE").unwrap_or_else(|_| "20_NE_two_brothers".into());
        let dir = std::path::Path::new(&root).join("replays");
        let layouts = learn_cap_layouts(&space, Some(dir.to_string_lossy().into_owned())).unwrap();
        println!("{} learned layouts for {space}", layouts.len());
        for l in &layouts {
            println!(
                "  group={:?} scenario={:?} from {} ({:?})",
                l.mode_group, l.scenario, l.source_replay, l.source_time
            );
            for c in &l.caps {
                println!(
                    "    idx={} x={:.1} z={:.1} r={:?} team={:?} appearT={:?}",
                    c.index, c.x, c.z, c.radius, c.team, c.appear_t
                );
            }
        }
    }

    #[test]
    fn group_of_pairs_group_and_scenario() {
        let meta = wowsp_tauri_shared::ReplayMetaLite {
            path: String::new(),
            date_time: None,
            match_group: Some("pvp".into()),
            map_name: Some("20_NE_two_brothers".into()),
            map_id: None,
            scenario: Some("domination_3point".into()),
            event_type: None,
            bot_count: 0,
            scripted_unit_count: 0,
            enemy_count: 0,
            own_ship_id: None,
            player_name: None,
            player_count: 0,
            install_path: None,
            install_kind: None,
            install_realm: None,
        };
        assert_eq!(
            group_of(&meta),
            (Some("pvp".into()), Some("domination_3point".into()))
        );
    }
}
