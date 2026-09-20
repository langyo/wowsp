//! Replay visibility probe (experiment E3).
//!
//! Hypothesis under test: the replay's packet stream is exactly what the
//! recording CLIENT received, so position samples for an enemy ship exist
//! only while that ship was spotted by the recorder's team — a gap longer
//! than a few seconds in an enemy's sample stream means "unspotted", which
//! is precisely the incomplete-information constraint a decision model
//! trained on replays must respect. This module quantifies that per entity:
//! sample counts, rates, gap statistics (> 4 s by default) and the observed
//! fraction of each entity's life window.
//!
//! Team attribution joins entity → shipId (the EntityCreate state scan in
//! [`super::packets`]) → roster relation (0/1 = recorder's team, 2+ =
//! enemy), cross-checked against the battle-results payload when present
//! (`playersPublicInfo[dbid]` arrays carry `[6] = teamId, [7] = shipId`).
//! The join is only unique when no roster entry on the OTHER team plays the
//! same ship — mirror lineups leave those entities unattributed rather than
//! guessed (`ship_id_ambiguous`).

use wowsp_tauri_shared::{
    AmbiguousShipId, EntityVisibilityStats, PositionSample, ReplayProbeReport, VehicleEntry,
    VisibilityGap,
};

/// Sample-gap threshold (seconds) separating "continuously observed" from
/// "lost sight of". The position streams of observed entities tick at
/// several Hz (the recorder's own ship: ~7 Hz), so 4 s is far above any
/// packet jitter and far below typical unspotted periods.
pub const GAP_THRESHOLD: f32 = 4.0;

/// Count of roster entries per shipId, split by side.
#[derive(Default, Clone, Copy)]
struct ShipIdSides {
    ally: u32,
    enemy: u32,
}

/// Team of a shipId from the roster split: `Some(0)` (recorder's team) /
/// `Some(1)` (enemy) only when EVERY roster entry playing that ship is on
/// one side — mirror lineups (same ship on both teams) yield `None`.
fn side_of(sides: &ShipIdSides) -> Option<i8> {
    if sides.ally > 0 && sides.enemy == 0 {
        Some(0)
    } else if sides.enemy > 0 && sides.ally == 0 {
        Some(1)
    } else {
        None
    }
}

/// Build the shipId → sides map from the roster (relation 0/1 = recorder's
/// team, 2+ = enemy).
fn roster_sides(vehicles: &[VehicleEntry]) -> std::collections::BTreeMap<i64, ShipIdSides> {
    let mut map: std::collections::BTreeMap<i64, ShipIdSides> = std::collections::BTreeMap::new();
    for v in vehicles {
        if v.ship_id == 0 {
            continue;
        }
        let entry = map.entry(v.ship_id).or_default();
        if v.relation <= 1 {
            entry.ally += 1;
        } else {
            entry.enemy += 1;
        }
    }
    map
}

/// Cross-check ship ids against the battle-results payload (when the replay
/// carries one): every `playersPublicInfo` entry is a positional array whose
/// `[6]` is the teamId and `[7]` the shipId. This mirrors the roster-side
/// ambiguity check — a shipId the results themselves place on more than one
/// team (mirrored lineups) is flagged so those entities downgrade to
/// ambiguous. It does NOT compare roster relations against results teamIds:
/// relation is recorder-relative while teamId is absolute, and calibrating
/// the two namespaces is future work. Returns the ids the results place on
/// multiple teams.
fn battle_results_conflicts(battle_results: Option<&str>) -> Vec<i64> {
    let Some(br) = battle_results else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(br) else {
        return Vec::new();
    };
    let Some(players) = v.get("playersPublicInfo").and_then(|p| p.as_object()) else {
        return Vec::new();
    };
    // shipId -> set of teams seen in battle results.
    let mut seen: std::collections::BTreeMap<i64, std::collections::BTreeSet<i64>> =
        std::collections::BTreeMap::new();
    for entry in players.values() {
        let Some(arr) = entry.as_array() else {
            continue;
        };
        let (Some(team), Some(ship)) = (
            arr.get(6).and_then(|x| x.as_i64()),
            arr.get(7).and_then(|x| x.as_i64()),
        ) else {
            continue;
        };
        seen.entry(ship).or_default().insert(team);
    }
    seen.into_iter()
        .filter(|(_, teams)| teams.len() > 1)
        .map(|(ship, _)| ship)
        .collect()
}

/// Gap statistics over one entity's (sorted) sample times.
struct GapStats {
    gaps: Vec<VisibilityGap>,
    /// Sum of inter-sample intervals at or below the threshold ("observed"
    /// time — gaps above the threshold are not counted).
    observed: f32,
}

fn gap_stats(samples: &[PositionSample], threshold: f32) -> GapStats {
    let mut gaps = Vec::new();
    let mut observed = 0.0f32;
    for w in samples.windows(2) {
        let dt = w[1].time - w[0].time;
        if dt > threshold {
            gaps.push(VisibilityGap {
                from: w[0].time,
                to: w[1].time,
                duration: dt,
            });
        } else {
            observed += dt;
        }
    }
    GapStats { gaps, observed }
}

/// Build the whole visibility report over a decoded stream plus its roster.
pub fn build_report(
    path: &str,
    stream: &wowsp_tauri_shared::ReplayStream,
    vehicles: &[VehicleEntry],
) -> ReplayProbeReport {
    let sides = roster_sides(vehicles);
    let conflicts = battle_results_conflicts(stream.battle_results.as_deref());
    // Match end proxy: the latest position sample across every entity.
    let match_end = stream
        .trajectories
        .iter()
        .filter_map(|t| t.samples.last().map(|s| s.time))
        .fold(0.0f32, f32::max);
    let mut ambiguous_ship_ids = Vec::new();
    let mut entities = Vec::new();
    for t in &stream.trajectories {
        let kind = t.kind.as_ref();
        let samples = &t.samples;
        let stats = gap_stats(samples, GAP_THRESHOLD);
        let gap_total = stats.gaps.iter().fold(0.0f32, |acc, g| acc + g.duration);
        // Life window: creation (or first sample for pre-replay entities) to
        // death (or match end for survivors). The end is additionally raised
        // to the last sample when the stream outlasts the inferred death —
        // death times come from HP-stream inference and can land early, and
        // samples cannot exist past a real death, so the stream wins.
        let window_start = kind
            .and_then(|k| (k.creation_time >= 0.0).then_some(k.creation_time))
            .or_else(|| samples.first().map(|s| s.time))
            .unwrap_or(0.0);
        let stream_end = samples.last().map(|s| s.time).unwrap_or(window_start);
        let window_end = t
            .death_time
            .unwrap_or(match_end)
            .max(window_start)
            .max(stream_end);
        let window = window_end - window_start;
        let observed_fraction = if window <= 0.0 {
            // Zero-length window: an entity seen at a single instant counts
            // as observed, one never seen does not.
            if samples.is_empty() { 0.0 } else { 1.0 }
        } else {
            (stats.observed / window).clamp(0.0, 1.0)
        };
        let span = samples
            .last()
            .zip(samples.first())
            .map(|(a, b)| a.time - b.time)
            .unwrap_or(0.0);
        let avg_sample_rate = if span > 0.0 {
            samples.len() as f32 / span
        } else {
            0.0
        };
        let ship_id = kind.and_then(|k| k.ship_id);
        let (team_id, ship_id_ambiguous) = match ship_id {
            Some(sid) => {
                let sides_for = sides.get(&sid).copied().unwrap_or_default();
                let mut team = side_of(&sides_for);
                let mut ambiguous = team.is_none() && (sides_for.ally + sides_for.enemy > 0);
                if conflicts.contains(&sid) {
                    // Battle results place this ship on both teams — same
                    // ambiguity, validated by the game's own data.
                    team = None;
                    ambiguous = true;
                }
                (team, ambiguous)
            },
            None => (None, false),
        };
        entities.push(EntityVisibilityStats {
            entity_id: t.entity_id,
            entity_type: kind.map(|k| k.entity_type).unwrap_or(-1),
            ship_id,
            team_id,
            ship_id_ambiguous,
            is_recorder: stream.recorder_vehicle_id == Some(t.entity_id),
            death_time: t.death_time,
            first_sample_time: samples.first().map(|s| s.time),
            sample_count: samples.len() as u32,
            avg_sample_rate,
            gaps: stats.gaps,
            gap_total,
            observed_fraction,
        });
    }
    for (sid, s) in &sides {
        if s.ally > 0 && s.enemy > 0 {
            ambiguous_ship_ids.push(AmbiguousShipId {
                ship_id: *sid,
                ally_count: s.ally,
                enemy_count: s.enemy,
            });
        }
    }
    ReplayProbeReport {
        path: path.to_string(),
        map_name: stream.map_name.clone(),
        version: stream.version.clone(),
        gap_threshold_seconds: GAP_THRESHOLD,
        match_end,
        recorder_vehicle_id: stream.recorder_vehicle_id,
        ambiguous_ship_ids,
        entities,
    }
}

/// Visibility statistics for one `.wowsreplay` — the E3 probe surface.
/// Reuses the full decode pipeline ([`super::replay::read_replay_positions`])
/// plus the roster from the descriptor JSON for team attribution.
#[tauri::command]
pub fn replay_visibility_probe(path: String) -> Result<ReplayProbeReport, String> {
    let stream = super::replay::read_replay_positions(path.clone())?;
    let vehicles = read_roster(&path)?;
    Ok(build_report(&path, &stream, &vehicles))
}

/// Read the roster out of a replay's descriptor JSON block (empty on any
/// structural problem — the report degrades to team-less stats).
fn read_roster(path: &str) -> Result<Vec<VehicleEntry>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {path}: {e}"))?;
    let Some(json) = super::replay::extract_descriptor_json_pub(&bytes) else {
        return Ok(Vec::new());
    };
    let raw: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("parse descriptor JSON: {e}"))?;
    Ok(raw
        .get("vehicles")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
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
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(t: f32, eid: i32) -> PositionSample {
        PositionSample {
            time: t,
            entity_id: eid,
            vehicle_id: 1,
            x: 0.0,
            y: 0.0,
            z: 0.0,
            yaw: 0.0,
        }
    }

    fn kind(
        et: i16,
        ship_id: Option<i64>,
        creation: f32,
    ) -> Option<wowsp_tauri_shared::EntityKind> {
        Some(wowsp_tauri_shared::EntityKind {
            entity_type: et,
            vehicle_id: 5331,
            initial_x: 0.0,
            initial_y: 0.0,
            initial_z: 0.0,
            creation_time: creation,
            ship_id,
            radius: None,
            control_point_index: None,
            initial_team: None,
        })
    }

    /// Gap statistics: intervals above the threshold become gaps, intervals
    /// below accumulate as observed time.
    #[test]
    fn gap_stats_split_observed_and_lost() {
        let samples: Vec<PositionSample> = [0.0f32, 1.0, 2.0, 3.0, 20.0, 21.0, 22.5, 40.0]
            .map(|t| sample(t, 1))
            .to_vec();
        let s = gap_stats(&samples, 4.0);
        // Gaps: 3->20 (17s), 22.5->40 (17.5s).
        assert_eq!(s.gaps.len(), 2);
        assert!((s.gaps[0].duration - 17.0).abs() < 1e-5);
        assert!((s.gaps[1].duration - 17.5).abs() < 1e-5);
        // Observed: 1+1+1 + 1+1.5 = 5.5s.
        assert!((s.observed - 5.5).abs() < 1e-5);
        // Raising the threshold to 20s swallows both gaps.
        let loose = gap_stats(&samples, 20.0);
        assert!(loose.gaps.is_empty());
    }

    /// A synthetic stream + roster exercises the whole report: the recorder's
    /// own ship is continuously observed, a spotted-then-lost enemy carries
    /// one gap, a mirror-lineup ship stays team-less, and dead entities stop
    /// their life window at the sink time.
    #[test]
    fn report_counts_visibility_and_teams() {
        // 100 s of near-continuous coverage (0.5 s cadence) for the recorder.
        let own_times: Vec<f32> = (0..200).map(|i| i as f32 * 0.5).collect();
        // Enemy: seen 10..30, lost until 60, seen 60..80, sunk at 80.
        let mut enemy_times: Vec<f32> = Vec::new();
        let mut t = 10.0;
        while t < 30.0 {
            enemy_times.push(t);
            t += 0.5;
        }
        t = 60.0;
        while t < 80.0 {
            enemy_times.push(t);
            t += 0.5;
        }
        // Ally on the mirror ship: continuous 0..100.
        let ally_times: Vec<f32> = (0..100).map(|i| i as f32).collect();
        let trajectories = vec![
            wowsp_tauri_shared::EntityTrajectory {
                entity_id: 7,
                kind: kind(2, Some(111), 0.0),
                samples: own_times.iter().map(|t| sample(*t, 7)).collect(),
                death_time: None,
                hp_samples: Vec::new(),
                cap_samples: Vec::new(),
                cap_progress: Vec::new(),
                cruise_samples: Vec::new(),
            },
            wowsp_tauri_shared::EntityTrajectory {
                entity_id: 9,
                kind: kind(2, Some(222), 0.0),
                samples: enemy_times.iter().map(|t| sample(*t, 9)).collect(),
                death_time: Some(80.0),
                hp_samples: Vec::new(),
                cap_samples: Vec::new(),
                cap_progress: Vec::new(),
                cruise_samples: Vec::new(),
            },
            wowsp_tauri_shared::EntityTrajectory {
                entity_id: 11,
                kind: kind(2, Some(333), 0.0),
                samples: ally_times.iter().map(|t| sample(*t, 11)).collect(),
                death_time: None,
                hp_samples: Vec::new(),
                cap_samples: Vec::new(),
                cap_progress: Vec::new(),
                cruise_samples: Vec::new(),
            },
        ];
        let stream = wowsp_tauri_shared::ReplayStream {
            trajectories,
            recorder_vehicle_id: Some(7),
            shell_launches: Vec::new(),
            explosions: Vec::new(),
            torpedoes: Vec::new(),
            torpedo_steers: Vec::new(),
            weapon_locks: Vec::new(),
            battle_results: None,
            version: None,
            map_name: Some("spaces/50_Gold_harbor".into()),
            camera: Vec::new(),
            net_stats: Vec::new(),
            leaves: std::collections::BTreeMap::new(),
            camera_modes: Vec::new(),
            diagnostics: Default::default(),
            squadron_creates: Vec::new(),
            squadron_planes: Vec::new(),
            minimap_squadron_adds: Vec::new(),
            minimap_squadron_moves: Vec::new(),
            minimap_squadron_removes: Vec::new(),
            wards: Vec::new(),
            ward_removes: Vec::new(),
            shot_kills: Vec::new(),
            damage_stats: Vec::new(),
        };
        let vehicles = vec![
            VehicleEntry {
                id: 1,
                name: "recorder".into(),
                relation: 0,
                ship_id: 111,
                ship_name: None,
            },
            VehicleEntry {
                id: 2,
                name: "enemy".into(),
                relation: 2,
                ship_id: 222,
                ship_name: None,
            },
            // Mirror lineup: ship 333 on BOTH sides.
            VehicleEntry {
                id: 3,
                name: "ally-mirror".into(),
                relation: 1,
                ship_id: 333,
                ship_name: None,
            },
            VehicleEntry {
                id: 4,
                name: "enemy-mirror".into(),
                relation: 2,
                ship_id: 333,
                ship_name: None,
            },
        ];
        let report = build_report("x.wowsreplay", &stream, &vehicles);
        assert_eq!(report.gap_threshold_seconds, 4.0);
        assert_eq!(report.match_end, 99.5); // last sample across entities
        assert_eq!(report.recorder_vehicle_id, Some(7));
        // One ambiguous shipId, both sides counted.
        assert_eq!(report.ambiguous_ship_ids.len(), 1);
        assert_eq!(report.ambiguous_ship_ids[0].ship_id, 333);
        assert_eq!(report.ambiguous_ship_ids[0].ally_count, 1);
        assert_eq!(report.ambiguous_ship_ids[0].enemy_count, 1);

        let own = report.entities.iter().find(|e| e.entity_id == 7).unwrap();
        assert!(own.is_recorder);
        assert_eq!(own.team_id, Some(0));
        assert!(own.gaps.is_empty());
        assert!(own.observed_fraction > 0.99);
        assert!(own.avg_sample_rate > 1.9);

        let enemy = report.entities.iter().find(|e| e.entity_id == 9).unwrap();
        assert_eq!(enemy.team_id, Some(1));
        assert_eq!(enemy.gaps.len(), 1, "the lost period 30..60 is one gap");
        assert!((enemy.gaps[0].duration - 30.0).abs() < 1.0);
        assert!((enemy.gap_total - 30.0).abs() < 1.0);
        // Life window is creation 0 -> death 80 (not match end): observed
        // ~40 s of the 80 s window -> ~0.5.
        assert!(
            (enemy.observed_fraction - 0.5).abs() < 0.05,
            "enemy observed fraction {}",
            enemy.observed_fraction
        );

        let mirror = report.entities.iter().find(|e| e.entity_id == 11).unwrap();
        assert_eq!(mirror.team_id, None);
        assert!(mirror.ship_id_ambiguous);
        assert!(mirror.gaps.is_empty());
    }

    /// Battle-results conflicts: a shipId the results place on both teams
    /// downgrades a roster-resolved team to ambiguous.
    #[test]
    fn battle_results_conflict_downgrades_team() {
        let br = serde_json::json!({
            "playersPublicInfo": {
                "100": [100, "a", 0, "", 0, -1, 0, 555, 0, "ASIA"],
                "200": [200, "b", 0, "", 0, -1, 1, 555, 0, "ASIA"],
                "300": [300, "c", 0, "", 0, -1, 1, 777, 0, "ASIA"],
            }
        })
        .to_string();
        let conflicts = battle_results_conflicts(Some(&br));
        assert_eq!(conflicts, vec![555]);
        assert!(battle_results_conflicts(None).is_empty());
        assert!(battle_results_conflicts(Some("not json")).is_empty());
    }

    /// E3 probe against a real replay — run with
    /// `WOWSP_TEST_REPLAY=<path> cargo test -p wowsp_tauri replay_probe -- --nocapture --ignored`.
    /// Skips (passes) when the env var is unset, so CI without replay files
    /// stays green.
    #[test]
    #[ignore = "needs WOWSP_TEST_REPLAY pointing at a real .wowsreplay"]
    fn probe_real_replay() {
        let Ok(path) = std::env::var("WOWSP_TEST_REPLAY") else {
            eprintln!("[e3] WOWSP_TEST_REPLAY not set - skipping");
            return;
        };
        let report = replay_visibility_probe(path.clone()).expect("probe");
        // Structural sanity before printing.
        assert!(!report.entities.is_empty());
        assert!(report.match_end > 60.0, "match must span minutes");
        let ships: Vec<&EntityVisibilityStats> = report
            .entities
            .iter()
            .filter(|e| e.entity_type == 2)
            .collect();
        assert!(ships.len() >= 2, "a real match has several ships");
        // The recorder's own ship is continuously observed.
        let own = report
            .entities
            .iter()
            .find(|e| e.is_recorder)
            .expect("recorder entity");
        assert!(own.observed_fraction > 0.95, "own ship always observed");
        // Team attribution: unambiguous ships must resolve, and enemies
        // (spotted only in bursts) must show gaps.
        let attributed: Vec<_> = ships.iter().filter(|e| e.team_id.is_some()).collect();
        assert!(
            attributed.len() >= ships.len() / 2,
            "most ships should team-resolve"
        );
        let enemies: Vec<_> = attributed.iter().filter(|e| e.team_id == Some(1)).collect();
        let allies: Vec<_> = attributed.iter().filter(|e| e.team_id == Some(0)).collect();
        assert!(!enemies.is_empty() && !allies.is_empty());
        let enemy_gappy = enemies.iter().filter(|e| !e.gaps.is_empty()).count();
        let ally_gappy = allies.iter().filter(|e| !e.gaps.is_empty()).count();
        eprintln!(
            "[e3] {} ships: {} allies ({} with gaps), {} enemies ({} with gaps), {} ambiguous-team",
            ships.len(),
            allies.len(),
            ally_gappy,
            enemies.len(),
            enemy_gappy,
            ships.iter().filter(|e| e.ship_id_ambiguous).count()
        );
        assert!(
            enemy_gappy > 0,
            "enemies must exhibit >4s sample gaps (unspotted periods)"
        );
        // Print the full report for the experiment README.
        eprintln!(
            "{}",
            serde_json::to_string_pretty(&summarize(&report)).expect("serialize")
        );
    }

    /// Compact per-entity rows for the human-readable dump (the full report
    /// with every gap listed is too noisy for --nocapture output).
    fn summarize(report: &ReplayProbeReport) -> serde_json::Value {
        serde_json::json!({
            "path": report.path,
            "mapName": report.map_name,
            "version": report.version,
            "gapThresholdSeconds": report.gap_threshold_seconds,
            "matchEnd": report.match_end,
            "recorderVehicleId": report.recorder_vehicle_id,
            "ambiguousShipIds": report.ambiguous_ship_ids,
            "ships": report.entities.iter()
                .filter(|e| e.entity_type == 2)
                .map(|e| serde_json::json!({
                    "entityId": e.entity_id,
                    "teamId": e.team_id,
                    "ambiguous": e.ship_id_ambiguous,
                    "recorder": e.is_recorder,
                    "shipId": e.ship_id,
                    "samples": e.sample_count,
                    "firstSample": e.first_sample_time,
                    "rate": (e.avg_sample_rate * 100.0).round() / 100.0,
                    "gaps": e.gaps.len(),
                    "gapTotal": (e.gap_total * 10.0).round() / 10.0,
                    "observed": (e.observed_fraction * 1000.0).round() / 1000.0,
                    "deathTime": e.death_time,
                }))
                .collect::<Vec<_>>(),
            "otherEntities": report.entities.iter()
                .filter(|e| e.entity_type != 2)
                .count(),
        })
    }
}
