//! Decision tick state (experiments E5 + E6) — the first input
//! representation for the decision model.
//!
//! # E5 — scene-unit calibration
//!
//! WoWS replay/world coordinates are NOT metres: E2 bracketed the scene
//! unit at roughly 6–9 m by cross-checking observed speeds against published
//! ship specs. E5 pins the factor with a primary anchor: the recorder of the
//! reference replay is a Lexington (tier VIII US carrier) whose published top
//! speed is 33.5 kt = 17.23 m/s (HARDCODED EXPERIMENTAL REFERENCE VALUE,
//! public ship spec — flag/engine-modifier state unknown, so the anchor
//! carries a systematic uncertainty of a few percent). Sampling the planar
//! speed over quasi-steady full-ahead windows (telegraph held at level 4 for
//! ≥ 20 s) and taking the 90th percentile — the settled speed plateau; the
//! median drags through the ~55 s post-telegraph acceleration ramp — yields
//! the observed top speed in units/s; the ratio is [`METERS_PER_UNIT`].
//! [`calibrate_meters_per_unit`] re-derives the factor from any replay and
//! additionally reports the two cross anchors (squadron straight-line
//! speeds, shell average flight speeds) for sanity.
//!
//! # E6 — the tick state
//!
//! [`build_tick_state`] assembles a [`DecisionTickState`] for one replay at
//! one instant `t`: the recorder's own ship (exact data), every other ship
//! as last known, capture zones, and trailing combat-event counts. It reuses
//! the E3 semantics for observation gaps ([`super::replay_probe`]'s 4 s
//! threshold) and team attribution (shipId → roster side + battle-results
//! conflict downgrade).
//!
//! # Design constraint: incomplete information
//!
//! This is a RECORDER-VIEW snapshot, not a god view. The replay's packet
//! stream is exactly what the recording client received, so an enemy entity
//! only appears here after the recorder's team first spotted it, its fields
//! are LAST-KNOWN values with an explicit `lastObservedDelta` staleness, and
//! `observedNow=false` rows mean "stale intel", never a current observation.
//! No sample with `time > t` is ever read — the builder cannot leak the
//! future into the model input. Speed estimates are position differences
//! WITHIN an observation streak only (a diff never spans a >4 s sample gap,
//! so pre-gap velocity is preserved but never extrapolated across the gap).
//! Only ships (entity type 2) are listed in `entities` in this first version.

use serde::Serialize;
use wowsp_tauri_shared::{
    CruiseSample, DecisionTickEntity, DecisionTickEvents, DecisionTickRecorder, DecisionTickState,
    DecisionTickZone, HpSample, PositionSample, ReplayStream, VehicleEntry,
};

use super::replay_probe::{
    GAP_THRESHOLD, battle_results_conflicts, read_roster, resolve_team, roster_sides,
};
use super::terrain_los::{LosGrid, los_blocked};

// ── E5: scene-unit calibration ──────────────────────────────────────────────

/// Knots → metres per second (1852 m / 3600 s).
pub const KT_MS: f32 = 0.514_444_4;

/// Published top speed of the calibration reference ship (USS Lexington,
/// tier VIII US carrier). Experiment E5's hardcoded reference value: any
/// speed flag / engine modifier the player actually flew is unknown, so the
/// anchor is exact only for a stock ship.
pub const LEXINGTON_TOP_SPEED_KT: f32 = 33.5;

/// Lexington's anchor speed in m/s.
const LEXINGTON_TOP_SPEED_MS: f32 = LEXINGTON_TOP_SPEED_KT * KT_MS;

/// Metres per replay/world scene unit, calibrated 2026-09-20 (experiment E5)
/// on the reference replay
/// `20260918_200033_PASA108-Lexington_50_Gold_harbor.wowsreplay` (client
/// 15.8.0, recorder Lexington): across the 80 full-ahead (telegraph level 4,
/// held ≥ 20 s) windows the planar speed distribution was p50 1.975 / p90
/// 2.941 / max 2.962 units/s — the median drags through the ~55 s
/// acceleration ramp, the tight p90≈max band is the settled plateau — giving
/// 17.23 m/s ÷ 2.941 ≈ 5.86 m/unit. Cross anchors agreed: squadron
/// straight-line speeds cluster at 118–180 kt under this scale (Lexington's
/// published squadron cruise is 133–138 kt), and the shell flight-speed
/// ratio stayed an order-of-magnitude upper bound (14.8). Exact only as good
/// as the stock-33.5-kt assumption (± a few percent).
pub const METERS_PER_UNIT: f32 = 5.86;

/// Median of a non-empty f32 slice (sorted copy; lower middle on even len).
fn median_f32(values: &mut [f32]) -> Option<f32> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some(values[values.len() / 2])
}

/// Planar speed (units/s) of a symmetric ±`win` window centred on `center`
/// (both endpoints clamped into the sample series), for a sorted sample list.
fn windowed_speed(samples: &[PositionSample], center: f32, win: f32) -> Option<f32> {
    let a = samples.iter().find(|s| s.time >= center - win)?;
    let b = samples.iter().rev().find(|s| s.time <= center + win)?;
    let dt = b.time - a.time;
    if dt < 0.5 {
        return None;
    }
    Some((b.x - a.x).hypot(b.z - a.z) / dt)
}

/// Straight-line speeds of one aircraft type (grouped by squadron paramsId),
/// in the cross-anchor report.
#[derive(Debug, Clone, Serialize)]
pub struct SquadronSpeedGroup {
    pub params_id: u32,
    /// (planeId, index) tracks that contributed segments.
    pub plane_tracks: usize,
    /// Straight segments qualifying for the median.
    pub straight_segments: usize,
    /// Median straight-line speed, units/s.
    pub median_speed_units: f32,
    /// That median converted to knots via the calibrated scale — compare
    /// against the ship's known squadron cruise speeds (Lexington's sit in
    /// the ~115–140 kt band).
    pub implied_kt: f32,
}

/// The E5 calibration report: the primary anchor derivation plus cross
/// anchors and the observed world extent (context for the raster bounds).
#[derive(Debug, Clone, Serialize)]
pub struct ScaleCalibration {
    pub recorder_id: Option<i32>,
    /// Quasi-steady full-ahead windows that yielded a speed sample.
    pub full_ahead_windows: usize,
    /// Speed distribution over those windows (units/s). The median drags
    /// through the post-telegraph acceleration ramp (the reference carrier
    /// needs ~55 s to settle); the p90 is the settled-plateau estimate the
    /// scale is anchored on; max shows the contamination headroom.
    pub full_ahead_p50_units: f32,
    pub full_ahead_p90_units: f32,
    pub full_ahead_max_units: f32,
    /// The calibrated factor: `LEXINGTON_TOP_SPEED_MS / full_ahead_p90_units`.
    pub meters_per_unit: f32,
    pub squadron_groups: Vec<SquadronSpeedGroup>,
    /// Shell launches usable for the flight-speed anchor.
    pub shell_samples: usize,
    /// Median average flight speed (muzzle→aim distance ÷ flight time), units/s.
    pub shell_median_avg_units: f32,
    /// Median of the wire `speed` field the game itself labels m/s.
    pub shell_median_muzzle: f32,
    /// Median per-shell `speed ÷ average flight speed` — an m/unit estimate
    /// that OVERSTATES the scale (drag makes the average slower than the
    /// muzzle), used as an upper-bound sanity only.
    pub shell_implied_m_per_unit: f32,
    /// Observed world extent of every position sample (units).
    pub world_min_x: f32,
    pub world_max_x: f32,
    pub world_min_z: f32,
    pub world_max_z: f32,
}

/// Re-derive the scene-unit scale from a decoded replay (E5). The primary
/// anchor is the recorder's quasi-steady full-ahead speed (see the module
/// docs); the cross anchors are reported for eyeballing, not fitted:
///   - squadrons: straight-line segment speeds grouped by squadron paramsId,
///     converted to "kt" with the primary scale (aircraft cruise ~115–140 kt
///     for the Lexington reference);
///   - shells: `speed` field (the game's own m/s label) versus the average
///     muzzle→aim-point speed in units/s — the ratio is an m/unit UPPER
///     bound because shell drag makes the flight average slower than the
///     muzzle velocity.
pub fn calibrate_meters_per_unit(stream: &ReplayStream) -> ScaleCalibration {
    let mut cal = ScaleCalibration {
        recorder_id: None,
        full_ahead_windows: 0,
        full_ahead_p50_units: 0.0,
        full_ahead_p90_units: 0.0,
        full_ahead_max_units: 0.0,
        meters_per_unit: 0.0,
        squadron_groups: Vec::new(),
        shell_samples: 0,
        shell_median_avg_units: 0.0,
        shell_median_muzzle: 0.0,
        shell_implied_m_per_unit: 0.0,
        world_min_x: f32::MAX,
        world_max_x: f32::MIN,
        world_min_z: f32::MAX,
        world_max_z: f32::MIN,
    };
    for traj in &stream.trajectories {
        for s in &traj.samples {
            cal.world_min_x = cal.world_min_x.min(s.x);
            cal.world_max_x = cal.world_max_x.max(s.x);
            cal.world_min_z = cal.world_min_z.min(s.z);
            cal.world_max_z = cal.world_max_z.max(s.z);
        }
    }
    // ── primary anchor: recorder full-ahead windows ───────────────────────
    let recorder = stream
        .recorder_vehicle_id
        .and_then(|id| stream.trajectories.iter().find(|t| t.entity_id == id));
    let Some(recorder) = recorder else {
        return cal;
    };
    cal.recorder_id = Some(recorder.entity_id);
    let samples = &recorder.samples;
    let cruise = &recorder.cruise_samples;
    let throttle_at = |tt: f32| -> Option<i32> {
        cruise
            .iter()
            .rfind(|s| s.controller == 0 && s.time <= tt)
            .map(|s| s.level)
    };
    if let (Some(first), Some(last)) = (samples.first(), samples.last()) {
        let mut speeds = Vec::new();
        let mut tt = first.time + 60.0;
        while tt < last.time - 60.0 {
            // Level at tt and 20 s earlier both full ahead -> held long
            // enough for the ship to have settled at its speed plateau.
            if throttle_at(tt) == Some(4) && throttle_at(tt - 20.0) == Some(4) {
                if let Some(v) = windowed_speed(samples, tt, 8.0) {
                    speeds.push(v);
                }
            }
            tt += 5.0;
        }
        cal.full_ahead_windows = speeds.len();
        if !speeds.is_empty() {
            speeds.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let pct = |p: f32| speeds[((speeds.len() as f32 - 1.0) * p) as usize];
            cal.full_ahead_p50_units = pct(0.50);
            cal.full_ahead_p90_units = pct(0.90);
            cal.full_ahead_max_units = *speeds.last().unwrap();
            // The MEDIAN of full-ahead windows drags through the post-telegraph
            // acceleration ramp (the reference carrier needs ~55 s to settle),
            // so the plateau estimate — what full speed actually means — is the
            // 90th percentile of those windows.
            cal.meters_per_unit = LEXINGTON_TOP_SPEED_MS / cal.full_ahead_p90_units;
        }
    }
    // ── cross anchor 1: squadron straight-line speeds ─────────────────────
    let params_of: std::collections::BTreeMap<u64, u32> = stream
        .squadron_creates
        .iter()
        .map(|s| (s.plane_id, s.params_id))
        .collect();
    let mut tracks: std::collections::BTreeMap<(u64, u8), Vec<&wowsp_tauri_shared::SquadronPlane>> =
        std::collections::BTreeMap::new();
    for p in &stream.squadron_planes {
        if params_of.contains_key(&p.plane_id) {
            tracks.entry((p.plane_id, p.index)).or_default().push(p);
        }
    }
    let mut by_params: std::collections::BTreeMap<u32, Vec<f32>> =
        std::collections::BTreeMap::new();
    let mut track_count: std::collections::BTreeMap<u32, usize> = std::collections::BTreeMap::new();
    for ((plane_id, _index), mut pts) in tracks {
        pts.sort_by(|a, b| {
            a.time
                .partial_cmp(&b.time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let Some(&params_id) = params_of.get(&plane_id) else {
            continue;
        };
        *track_count.entry(params_id).or_default() += 1;
        // Split into streaks of consecutive updates (≤ 2 s apart); a streak
        // ≥ 5 s whose endpoint distance is ≥ 98% of its path length counts as
        // a straight segment.
        let mut seg_start = 0usize;
        for i in 0..=pts.len() {
            let streak_break = i == pts.len() || (i > 0 && pts[i].time - pts[i - 1].time > 2.0);
            if !streak_break {
                continue;
            }
            let seg = &pts[seg_start..i];
            seg_start = i;
            let span = seg.last().map(|e| e.time).unwrap_or(0.0)
                - seg.first().map(|e| e.time).unwrap_or(0.0);
            if seg.len() < 3 || span < 5.0 {
                continue;
            }
            let mut path_len = 0.0f32;
            for w in seg.windows(2) {
                path_len += (w[1].x - w[0].x).hypot(w[1].z - w[0].z);
            }
            let straight =
                (seg.last().unwrap().x - seg[0].x).hypot(seg.last().unwrap().z - seg[0].z);
            if path_len > 0.0 && straight / path_len >= 0.98 {
                by_params
                    .entry(params_id)
                    .or_default()
                    .push(straight / span);
            }
        }
    }
    for (params_id, mut speeds) in by_params {
        let Some(median) = median_f32(&mut speeds) else {
            continue;
        };
        cal.squadron_groups.push(SquadronSpeedGroup {
            params_id,
            plane_tracks: track_count.get(&params_id).copied().unwrap_or(0),
            straight_segments: speeds.len(),
            median_speed_units: median,
            implied_kt: median * cal.meters_per_unit / KT_MS,
        });
    }
    // ── cross anchor 2: shell flight speeds ───────────────────────────────
    let mut v_avgs = Vec::new();
    let mut muzzles = Vec::new();
    let mut ratios = Vec::new();
    for s in &stream.shell_launches {
        // serverTimeLeft is in server ticks: battle seconds = value / 2.75.
        let flight_s = s.server_time_left / 2.75;
        if !(1.0..=150.0).contains(&flight_s) {
            continue;
        }
        let dist = (s.target_x - s.x).hypot(s.target_z - s.z);
        if dist < 10.0 || s.speed <= 0.0 || !s.speed.is_finite() {
            continue;
        }
        let v = dist / flight_s;
        v_avgs.push(v);
        muzzles.push(s.speed);
        ratios.push(s.speed / v);
    }
    cal.shell_samples = v_avgs.len();
    cal.shell_median_avg_units = median_f32(&mut v_avgs).unwrap_or(0.0);
    cal.shell_median_muzzle = median_f32(&mut muzzles).unwrap_or(0.0);
    cal.shell_implied_m_per_unit = median_f32(&mut ratios).unwrap_or(0.0);
    cal
}

// ── E6: the decision tick state ─────────────────────────────────────────────

/// EntityCreate type index of vehicles (ships). The E6 v1 entity list keeps
/// ships only — aircraft/projectile transients are excluded on purpose.
const SHIP_ENTITY_TYPE: i16 = 2;

/// InteractiveZone type index (13 before 14.5.0, 14 after).
const ZONE_ENTITY_TYPES: [i16; 2] = [13, 14];

/// Eye height above the sight-line origin (sea level) used for terrain LOS
/// when the caller passes none — the E4 baker's default, in raster units.
pub const DEFAULT_EYE_HEIGHT: f32 = 20.0;

/// Length of the trailing combat-event window (seconds).
const EVENT_WINDOW_S: f32 = 30.0;

/// "Near the recorder" radius for the incoming-fire explosion proxy.
const EXPLOSION_NEAR_RADIUS_M: f32 = 500.0;

/// Latest sample at or before `t` (samples are time-sorted by the decoder).
fn last_sample_at(samples: &[PositionSample], t: f32) -> Option<&PositionSample> {
    samples.iter().rfind(|s| s.time <= t)
}

/// Latest property value at or before `t`.
fn value_at(samples: &[HpSample], t: f32) -> Option<u32> {
    samples.iter().rfind(|s| s.time <= t).map(|s| s.value)
}

/// Latest CruiseState of one controller at or before `t`.
fn cruise_at(cruise: &[CruiseSample], t: f32, controller: u32) -> Option<&CruiseSample> {
    cruise
        .iter()
        .rfind(|s| s.controller == controller && s.time <= t)
}

/// Planar speed (units/s) of the trailing observation streak ending at the
/// last sample ≤ `t`: walks back at most 8 s and never across an
/// inter-sample gap above the E3 threshold, so pre-gap velocity is preserved
/// but never extrapolated across a gap. `None` when the streak spans < 1 s.
fn trailing_speed(samples: &[PositionSample], t: f32) -> Option<f32> {
    const WINDOW: f32 = 8.0;
    const MIN_SPAN: f32 = 1.0;
    let end = samples.iter().rposition(|s| s.time <= t)?;
    let mut start = end;
    for i in (0..end).rev() {
        // Stop at a visibility gap: the sample below it belongs to the
        // previous observation period.
        if samples[i + 1].time - samples[i].time > GAP_THRESHOLD {
            break;
        }
        if samples[end].time - samples[i].time > WINDOW {
            break;
        }
        start = i;
    }
    let dt = samples[end].time - samples[start].time;
    if dt < MIN_SPAN {
        return None;
    }
    let dx = samples[end].x - samples[start].x;
    let dz = samples[end].z - samples[start].z;
    Some(dx.hypot(dz) / dt)
}

/// Assemble the recorder-view snapshot for `stream` at time `t` (seconds
/// since match start). `vehicles` is the replay roster (team attribution);
/// `los` optionally supplies the terrain raster for enemy occlusion
/// (`eye_height` in raster units above the sight-line origin). Fails when
/// the replay carries no recorder-vehicle join or no recorder sample at/before
/// `t` — both mean the snapshot cannot be built on this input.
pub fn build_tick_state(
    stream: &ReplayStream,
    vehicles: &[VehicleEntry],
    time_sec: f32,
    los: Option<&LosGrid>,
    eye_height: f32,
) -> Result<DecisionTickState, String> {
    let rec_id = stream.recorder_vehicle_id.ok_or_else(|| {
        "replay carries no recorder vehicle join (modern replays only)".to_string()
    })?;
    let rec_traj = stream
        .trajectories
        .iter()
        .find(|t| t.entity_id == rec_id)
        .ok_or_else(|| format!("recorder entity {rec_id} has no trajectory"))?;
    let rec_sample = last_sample_at(&rec_traj.samples, time_sec)
        .ok_or_else(|| format!("no recorder position at or before t={time_sec}"))?;
    let sides = roster_sides(vehicles);
    let conflicts = battle_results_conflicts(stream.battle_results.as_deref());

    let throttle = cruise_at(&rec_traj.cruise_samples, time_sec, 0);
    let rudder = cruise_at(&rec_traj.cruise_samples, time_sec, 1);
    let recorder = DecisionTickRecorder {
        entity_id: rec_id,
        x: rec_sample.x,
        z: rec_sample.z,
        yaw: rec_sample.yaw,
        speed_kt: trailing_speed(&rec_traj.samples, time_sec).map(|v| v * METERS_PER_UNIT / KT_MS),
        throttle_level: throttle.map(|s| s.level),
        throttle_value: throttle.and_then(|s| s.value),
        rudder_level: rudder.map(|s| s.level),
        rudder_value: rudder.and_then(|s| s.value),
        hp: value_at(&rec_traj.hp_samples, time_sec),
        alive: rec_traj.death_time.is_none_or(|d| d > time_sec),
    };

    let mut entities = Vec::new();
    for traj in &stream.trajectories {
        if traj.entity_id == rec_id {
            continue;
        }
        let Some(kind) = traj.kind.as_ref() else {
            continue;
        };
        if kind.entity_type != SHIP_ENTITY_TYPE {
            continue;
        }
        // An entity the recorder has never observed by `t` does not exist in
        // the recorder's world yet — skip instead of emitting empty intel.
        let Some(last) = last_sample_at(&traj.samples, time_sec) else {
            continue;
        };
        let (team_id, team_ambiguous) = resolve_team(kind.ship_id, &sides, &conflicts);
        let observed_now = time_sec - last.time <= GAP_THRESHOLD;
        let terrain_blocked = match (los, team_id, observed_now) {
            (Some(grid), Some(1), true) => Some(los_blocked(
                grid,
                (rec_sample.x as f64, rec_sample.z as f64, eye_height as f64),
                (last.x as f64, last.z as f64, 0.0),
            )),
            _ => None,
        };
        entities.push(DecisionTickEntity {
            entity_id: traj.entity_id,
            entity_type: kind.entity_type,
            ship_id: kind.ship_id,
            team_id,
            team_ambiguous,
            last_known_x: last.x,
            last_known_z: last.z,
            last_known_yaw: last.yaw,
            last_observed_delta: time_sec - last.time,
            observed_now,
            speed_kt: trailing_speed(&traj.samples, time_sec).map(|v| v * METERS_PER_UNIT / KT_MS),
            distance_m: Some(
                (last.x - rec_sample.x).hypot(last.z - rec_sample.z) * METERS_PER_UNIT,
            ),
            hp: value_at(&traj.hp_samples, time_sec),
            alive: traj.death_time.is_none_or(|d| d > time_sec),
            terrain_blocked,
        });
    }

    let mut zones = Vec::new();
    for traj in &stream.trajectories {
        let Some(kind) = traj.kind.as_ref() else {
            continue;
        };
        if !ZONE_ENTITY_TYPES.contains(&kind.entity_type) {
            continue;
        }
        let owner = value_at(&traj.cap_samples, time_sec)
            .map(|v| v as i32)
            .or_else(|| kind.initial_team.map(i32::from));
        let progress = traj
            .cap_progress
            .iter()
            .rfind(|s| s.time <= time_sec)
            .map(|s| s.value as f32 / 1000.0);
        zones.push(DecisionTickZone {
            entity_id: traj.entity_id,
            control_point_index: kind.control_point_index,
            radius: kind.radius,
            owner,
            progress,
        });
    }

    let near_units = EXPLOSION_NEAR_RADIUS_M / METERS_PER_UNIT;
    let in_window = |tt: f32| tt > time_sec - EVENT_WINDOW_S && tt <= time_sec;
    let recent_events = DecisionTickEvents {
        shell_launches: stream
            .shell_launches
            .iter()
            .filter(|e| in_window(e.time))
            .count() as u32,
        torpedo_launches: stream
            .torpedoes
            .iter()
            .filter(|e| in_window(e.time))
            .count() as u32,
        explosions: stream
            .explosions
            .iter()
            .filter(|e| in_window(e.time))
            .count() as u32,
        shell_launches_by_recorder: stream
            .shell_launches
            .iter()
            .filter(|e| in_window(e.time) && e.owner_id == rec_id)
            .count() as u32,
        torpedo_launches_by_recorder: stream
            .torpedoes
            .iter()
            .filter(|e| in_window(e.time) && e.owner_id == rec_id)
            .count() as u32,
        explosions_near_recorder: stream
            .explosions
            .iter()
            .filter(|e| {
                in_window(e.time) && (e.x - rec_sample.x).hypot(e.z - rec_sample.z) <= near_units
            })
            .count() as u32,
    };

    Ok(DecisionTickState {
        match_time: time_sec,
        map_name: stream.map_name.clone(),
        recorder,
        entities,
        zones,
        recent_events,
    })
}

/// E5 scene-unit calibration report for one replay — the IPC surface that
/// lets the webui (or a CLI caller) re-derive [`METERS_PER_UNIT`] on any
/// reference capture whose recorder's ship spec is known.
#[tauri::command]
pub fn decision_scale_calibration(replay_path: String) -> Result<ScaleCalibration, String> {
    let stream = super::replay::read_replay_positions(replay_path)?;
    Ok(calibrate_meters_per_unit(&stream))
}

/// Decision-model input snapshot for one replay at one instant (the E6
/// command surface). `los_grid_path` optionally points at an E4
/// `terrain_los.npz`; `eye_height` (raster units) defaults to
/// [`DEFAULT_EYE_HEIGHT`].
#[tauri::command]
pub fn decision_tick_state(
    replay_path: String,
    time_sec: f32,
    los_grid_path: Option<String>,
    eye_height: Option<f32>,
) -> Result<DecisionTickState, String> {
    let stream = super::replay::read_replay_positions(replay_path.clone())?;
    let vehicles = read_roster(&replay_path)?;
    let grid = match los_grid_path {
        Some(p) => Some(LosGrid::load_npz(std::path::Path::new(&p))?),
        None => None,
    };
    build_tick_state(
        &stream,
        &vehicles,
        time_sec,
        grid.as_ref(),
        eye_height.unwrap_or(DEFAULT_EYE_HEIGHT),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(t: f32, eid: i32, x: f32, z: f32) -> PositionSample {
        PositionSample {
            time: t,
            entity_id: eid,
            vehicle_id: 1,
            x,
            y: 0.0,
            z,
            yaw: 0.25,
        }
    }

    fn kind(et: i16, ship_id: Option<i64>) -> Option<wowsp_tauri_shared::EntityKind> {
        Some(wowsp_tauri_shared::EntityKind {
            entity_type: et,
            vehicle_id: 5331,
            initial_x: 0.0,
            initial_y: 0.0,
            initial_z: 0.0,
            creation_time: 0.0,
            ship_id,
            radius: None,
            control_point_index: None,
            initial_team: None,
        })
    }

    fn trajectory(
        eid: i32,
        k: Option<wowsp_tauri_shared::EntityKind>,
        samples: Vec<PositionSample>,
    ) -> wowsp_tauri_shared::EntityTrajectory {
        wowsp_tauri_shared::EntityTrajectory {
            entity_id: eid,
            kind: k,
            samples,
            death_time: None,
            hp_samples: Vec::new(),
            cap_samples: Vec::new(),
            cap_progress: Vec::new(),
            cruise_samples: Vec::new(),
        }
    }

    fn roster_entry(id: i64, relation: i64, ship_id: i64) -> VehicleEntry {
        VehicleEntry {
            id,
            name: format!("p{id}"),
            relation,
            ship_id,
            ship_name: None,
        }
    }

    /// E5 pure check: a synthetic recorder cruising at a constant 2.9 units/s
    /// with the telegraph pinned at full ahead calibrates to exactly
    /// `LEXINGTON_TOP_SPEED_MS / 2.9`.
    #[test]
    fn calibration_anchors_full_ahead_median() {
        let mut samples = Vec::new();
        let mut t = 0.0f32;
        while t <= 1000.0 {
            samples.push(sample(t, 7, 2.9 * t, 0.0));
            t += 0.5;
        }
        let mut rec = trajectory(7, kind(2, Some(111)), samples);
        rec.cruise_samples = vec![CruiseSample {
            time: 0.0,
            controller: 0,
            level: 4,
            value: Some(1.0),
        }];
        let stream = ReplayStream {
            trajectories: vec![rec],
            recorder_vehicle_id: Some(7),
            ..minimal_stream()
        };
        let cal = calibrate_meters_per_unit(&stream);
        assert_eq!(cal.recorder_id, Some(7));
        assert!(
            cal.full_ahead_windows > 20,
            "windows: {}",
            cal.full_ahead_windows
        );
        // Constant 2.9 units/s throughout -> every percentile equals it.
        assert!((cal.full_ahead_p50_units - 2.9).abs() < 1e-3);
        assert!((cal.full_ahead_p90_units - 2.9).abs() < 1e-3);
        assert!(
            (cal.meters_per_unit - LEXINGTON_TOP_SPEED_MS / 2.9).abs() < 0.01,
            "mpu {}",
            cal.meters_per_unit
        );
        // A replay without the recorder join degrades to a zeroed report.
        let empty = ReplayStream {
            trajectories: Vec::new(),
            recorder_vehicle_id: None,
            ..minimal_stream()
        };
        let cal0 = calibrate_meters_per_unit(&empty);
        assert_eq!(cal0.recorder_id, None);
        assert_eq!(cal0.meters_per_unit, 0.0);
    }

    /// E6 synthetic: recorder self block, entity intel with staleness, zone
    /// ownership/progress, event window counts — and no future leakage.
    #[test]
    fn tick_state_builds_self_entities_zones_and_events() {
        let t = 75.0f32;
        // Recorder: +x at 1 unit/s from t=0; a sample AFTER t must be ignored.
        let mut rec_samples: Vec<PositionSample> = (0..=150)
            .map(|i| sample(i as f32 * 0.5, 7, i as f32 * 0.5, 0.0))
            .collect();
        rec_samples.push(sample(76.0, 7, 999.0, 999.0));
        let mut rec = trajectory(7, kind(2, Some(111)), rec_samples);
        rec.cruise_samples = vec![
            CruiseSample {
                time: 0.0,
                controller: 0,
                level: 4,
                value: Some(1.0),
            },
            CruiseSample {
                time: 10.0,
                controller: 1,
                level: 1,
                value: Some(0.5),
            },
        ];
        rec.hp_samples = vec![
            HpSample {
                time: 0.0,
                value: 40_000,
            },
            HpSample {
                time: 60.0,
                value: 38_000,
            },
        ];
        // Enemy 9: seen 10..30 stationary at (30, 40), lost, seen 60..75
        // moving +z at 2 units/s; last sample 74.5 <= t.
        let mut enemy_samples: Vec<PositionSample> = Vec::new();
        let mut tt = 10.0;
        while tt < 30.0 {
            enemy_samples.push(sample(tt, 9, 30.0, 40.0));
            tt += 0.5;
        }
        tt = 60.0;
        while tt <= 74.5 {
            enemy_samples.push(sample(tt, 9, 30.0, 2.0 * (tt - 60.0)));
            tt += 0.5;
        }
        // Future leak guard: a sample after t must not become last-known.
        enemy_samples.push(sample(80.0, 9, 30.0, 999.0));
        let enemy = trajectory(9, kind(2, Some(222)), enemy_samples);
        // Enemy 10: last seen at 30 (stale intel), observed 10..30 at
        // (100, -100) stationary.
        let mut lost_samples = Vec::new();
        let mut lt = 10.0;
        while lt < 30.0 {
            lost_samples.push(sample(lt, 10, 100.0, -100.0));
            lt += 0.5;
        }
        let lost = trajectory(10, kind(2, Some(333)), lost_samples);
        // Ally 11 on the mirror ship 333: continuous.
        let ally_samples: Vec<PositionSample> = (0..150)
            .map(|i| sample(i as f32 * 0.5, 11, 0.0, 10.0))
            .collect();
        let ally = trajectory(11, kind(2, Some(333)), ally_samples);
        // Zone 21: ownership flips to team 1 at 70; progress 0.35 at 60.
        let mut zone = trajectory(21, kind(14, Some(999)), Vec::new());
        zone.cap_samples = vec![
            HpSample {
                time: 50.0,
                value: 0,
            },
            HpSample {
                time: 70.0,
                value: 1,
            },
        ];
        zone.cap_progress = vec![HpSample {
            time: 60.0,
            value: 350,
        }];
        let stream = ReplayStream {
            trajectories: vec![rec, enemy, lost, ally, zone],
            recorder_vehicle_id: Some(7),
            shell_launches: vec![
                shell_event(50.0, 7),
                shell_event(70.0, 9),
                shell_event(40.0, 7), // outside [45, 75]
                shell_event(80.0, 7), // after t — must not count
            ],
            torpedoes: vec![wowsp_tauri_shared::TorpedoLaunch {
                time: 74.0,
                owner_id: 9,
                params_id: 0,
                salvo_id: 0,
                shot_id: 0,
                x: 0.0,
                y: 0.0,
                z: 0.0,
                dir_x: 1.0,
                dir_y: 0.0,
                dir_z: 0.0,
                armed: true,
            }],
            explosions: vec![
                wowsp_tauri_shared::ExplosionEvent {
                    time: 74.0,
                    x: 75.0,
                    y: 0.0,
                    z: 5.0,
                    params_id: 0,
                },
                wowsp_tauri_shared::ExplosionEvent {
                    time: 74.0,
                    x: 500.0,
                    y: 0.0,
                    z: 500.0,
                    params_id: 0,
                },
                wowsp_tauri_shared::ExplosionEvent {
                    time: 44.0,
                    x: 75.0,
                    y: 0.0,
                    z: 5.0,
                    params_id: 0,
                }, // outside window
            ],
            map_name: Some("spaces/50_Gold_harbor".into()),
            ..minimal_stream()
        };
        let vehicles = vec![
            roster_entry(1, 0, 111),
            roster_entry(2, 2, 222),
            roster_entry(3, 1, 333),
            roster_entry(4, 2, 333),
        ];
        let state =
            build_tick_state(&stream, &vehicles, t, None, DEFAULT_EYE_HEIGHT).expect("tick builds");
        // Recorder self: position/speed at t (not the future sample).
        assert_eq!(state.recorder.entity_id, 7);
        assert!((state.recorder.x - 75.0).abs() < 1e-4);
        assert_eq!(state.recorder.throttle_level, Some(4));
        assert_eq!(state.recorder.throttle_value, Some(1.0));
        assert_eq!(state.recorder.rudder_level, Some(1));
        assert_eq!(state.recorder.hp, Some(38_000));
        let kt = state.recorder.speed_kt.expect("recorder speed");
        assert!(
            (kt - METERS_PER_UNIT / KT_MS).abs() < 0.2,
            "1 unit/s -> {} kt",
            kt
        );
        // Entities: three ships (the zone is not an entity row).
        assert_eq!(state.entities.len(), 3);
        let e9 = state.entities.iter().find(|e| e.entity_id == 9).unwrap();
        assert_eq!(e9.team_id, Some(1));
        assert!(e9.observed_now);
        assert!(e9.last_observed_delta <= 0.5);
        assert!((e9.last_known_z - 29.0).abs() < 0.1, "z at 74.5");
        // Speed 2 units/s -> kt.
        let e9kt = e9.speed_kt.expect("enemy speed");
        assert!(
            (e9kt - 2.0 * METERS_PER_UNIT / KT_MS).abs() < 0.5,
            "2 unit/s -> {e9kt} kt"
        );
        // Distance from (75, 0) to (30, 29) in metres.
        let want = (30.0f32 - 75.0).hypot(29.0) * METERS_PER_UNIT;
        assert!((e9.distance_m.unwrap() - want).abs() < 0.5);
        assert_eq!(e9.terrain_blocked, None, "no grid -> no LOS field");
        let e10 = state.entities.iter().find(|e| e.entity_id == 10).unwrap();
        assert!(!e10.observed_now);
        assert!((e10.last_observed_delta - 45.5).abs() < 0.1);
        // Stationary streak -> a valid last-known speed of ~0.
        assert!(e10.speed_kt.unwrap().abs() < 0.5);
        let e11 = state.entities.iter().find(|e| e.entity_id == 11).unwrap();
        assert_eq!(e11.team_id, None, "mirror ship 333 is ambiguous");
        assert!(e11.team_ambiguous);
        assert!(e11.observed_now, "allies stream continuously");
        // Zone: latest ownership at/before 75 is the 70s flip.
        assert_eq!(state.zones.len(), 1);
        let z = &state.zones[0];
        assert_eq!(z.entity_id, 21);
        assert_eq!(z.owner, Some(1));
        assert!((z.progress.unwrap() - 0.35).abs() < 1e-6);
        // Events: window (45, 75].
        assert_eq!(state.recent_events.shell_launches, 2);
        assert_eq!(state.recent_events.shell_launches_by_recorder, 1);
        assert_eq!(state.recent_events.torpedo_launches, 1);
        assert_eq!(state.recent_events.torpedo_launches_by_recorder, 0);
        assert_eq!(state.recent_events.explosions, 2);
        assert_eq!(state.recent_events.explosions_near_recorder, 1);
        // Earlier tick: ownership still 0, and the 60 s progress sample must
        // not leak into a 55 s tick.
        let early = build_tick_state(&stream, &vehicles, 55.0, None, DEFAULT_EYE_HEIGHT)
            .expect("early tick");
        assert_eq!(early.zones[0].owner, Some(0));
        assert_eq!(early.zones[0].progress, None);
        assert!((early.recorder.x - 55.0).abs() < 0.1);
    }

    /// Speed is never differentiated across a >4 s sample gap: an enemy
    /// re-spotted with a single fresh sample has no speed estimate yet.
    #[test]
    fn speed_is_not_extrapolated_across_gaps() {
        let samples = vec![
            sample(10.0, 9, 0.0, 0.0),
            sample(10.5, 9, 1.0, 0.0),
            sample(11.0, 9, 2.0, 0.0),
            // 63 s gap
            sample(74.0, 9, 5.0, 5.0),
        ];
        let traj = trajectory(9, kind(2, Some(222)), samples);
        let stream = ReplayStream {
            trajectories: vec![
                trajectory(
                    7,
                    kind(2, Some(111)),
                    (0..160)
                        .map(|i| sample(i as f32 * 0.5, 7, 0.0, 0.0))
                        .collect(),
                ),
                traj,
            ],
            recorder_vehicle_id: Some(7),
            ..minimal_stream()
        };
        let vehicles = vec![roster_entry(1, 0, 111), roster_entry(2, 2, 222)];
        let state = build_tick_state(&stream, &vehicles, 75.0, None, DEFAULT_EYE_HEIGHT)
            .expect("tick builds");
        let e = state.entities.iter().find(|e| e.entity_id == 9).unwrap();
        assert!(e.observed_now, "1 s old sample counts as spotted");
        assert_eq!(e.speed_kt, None, "lone post-gap sample has no speed");
    }

    /// Terrain LOS wiring: observed enemy ships get a verdict from the raster,
    /// everyone else stays `None`.
    #[test]
    fn terrain_los_marks_observed_enemies_only() {
        // 16×16 grid, 10-unit cells, one 100-unit wall at column 8.
        let res = 16usize;
        let mut heights = vec![0.0f32; res * res];
        for r in 0..res {
            heights[r * res + 8] = 100.0;
        }
        let grid = LosGrid::from_parts(res, 0.0, 160.0, 0.0, 160.0, heights).expect("grid");
        // Recorder at (5, 80); enemy behind the wall at (150, 80) observed;
        // a second enemy west of the wall at (10, 80); an unobserved enemy
        // east of the wall; an ally behind the wall.
        let mk = |eid: i32, x: f32, times: (f32, f32)| {
            let mut v = Vec::new();
            let mut tt = times.0;
            while tt <= times.1 {
                v.push(sample(tt, eid, x, 80.0));
                tt += 0.5;
            }
            trajectory(eid, kind(2, Some(eid as i64 * 10)), v)
        };
        let stream = ReplayStream {
            trajectories: vec![
                mk(7, 5.0, (0.0, 100.0)),
                mk(9, 150.0, (60.0, 74.5)), // enemy, observed, behind wall
                mk(10, 10.0, (60.0, 74.5)), // enemy, observed, this side
                mk(11, 150.0, (10.0, 20.0)), // enemy, NOT observed now
                mk(12, 150.0, (0.0, 74.5)), // ally behind the wall
            ],
            recorder_vehicle_id: Some(7),
            ..minimal_stream()
        };
        let vehicles = vec![
            roster_entry(1, 0, 70),
            roster_entry(2, 2, 90),
            roster_entry(3, 2, 100),
            roster_entry(4, 2, 110),
            roster_entry(5, 0, 120),
        ];
        let state = build_tick_state(&stream, &vehicles, 75.0, Some(&grid), DEFAULT_EYE_HEIGHT)
            .expect("tick builds");
        let find = |eid: i32| state.entities.iter().find(|e| e.entity_id == eid).unwrap();
        assert_eq!(find(9).terrain_blocked, Some(true), "enemy behind wall");
        assert_eq!(find(10).terrain_blocked, Some(false), "enemy this side");
        assert_eq!(
            find(11).terrain_blocked,
            None,
            "unobserved enemy gets no verdict"
        );
        assert_eq!(find(12).terrain_blocked, None, "allies get no verdict");
    }

    /// A replay without the recorder join refuses to build a tick.
    #[test]
    fn tick_state_requires_recorder_join() {
        let stream = ReplayStream {
            trajectories: Vec::new(),
            recorder_vehicle_id: None,
            ..minimal_stream()
        };
        assert!(build_tick_state(&stream, &[], 100.0, None, DEFAULT_EYE_HEIGHT).is_err());
    }

    fn shell_event(time: f32, owner: i32) -> wowsp_tauri_shared::ShellLaunchEvent {
        wowsp_tauri_shared::ShellLaunchEvent {
            time,
            owner_id: owner,
            params_id: 0,
            salvo_id: 0,
            shot_id: 0,
            x: 0.0,
            y: 0.0,
            z: 0.0,
            target_x: 10.0,
            target_y: 0.0,
            target_z: 0.0,
            server_time_left: 11.0,
            speed: 780.0,
            gun_barrel_id: 0,
        }
    }

    fn minimal_stream() -> ReplayStream {
        ReplayStream {
            trajectories: Vec::new(),
            recorder_vehicle_id: None,
            shell_launches: Vec::new(),
            explosions: Vec::new(),
            torpedoes: Vec::new(),
            torpedo_steers: Vec::new(),
            weapon_locks: Vec::new(),
            battle_results: None,
            version: None,
            map_name: None,
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
        }
    }

    /// E5 against the real reference replay — run with
    /// `WOWSP_TEST_REPLAY=<path> cargo test -p wowsp_tauri e5_ -- --nocapture`.
    /// Prints the full calibration (primary + cross anchors) and drift-guards
    /// the constant. Skips when the env var is unset.
    #[test]
    fn e5_calibration_on_real_replay() {
        let Ok(path) = std::env::var("WOWSP_TEST_REPLAY") else {
            eprintln!("[e5] WOWSP_TEST_REPLAY not set - skipping");
            return;
        };
        let stream =
            super::super::replay::read_replay_positions(path.clone()).expect("decode real replay");
        let cal = calibrate_meters_per_unit(&stream);
        eprintln!(
            "[e5] recorder={:?} world extent x[{:.0},{:.0}] z[{:.0},{:.0}]",
            cal.recorder_id, cal.world_min_x, cal.world_max_x, cal.world_min_z, cal.world_max_z
        );
        eprintln!(
            "[e5] PRIMARY anchor: {} full-ahead windows, speeds p50 {:.3} / p90 {:.3} / max {:.3} units/s -> plateau p90 -> METERS_PER_UNIT = {:.3} (constant {})",
            cal.full_ahead_windows,
            cal.full_ahead_p50_units,
            cal.full_ahead_p90_units,
            cal.full_ahead_max_units,
            cal.meters_per_unit,
            METERS_PER_UNIT
        );
        for g in &cal.squadron_groups {
            eprintln!(
                "[e5] squadron cross-anchor paramsId {}: {} tracks / {} straight segments, median {:.3} units/s = {:.1} kt at calibrated scale",
                g.params_id,
                g.plane_tracks,
                g.straight_segments,
                g.median_speed_units,
                g.implied_kt
            );
        }
        eprintln!(
            "[e5] shell cross-anchor: {} shells, median avg flight {:.2} units/s, median wire muzzle speed {:.0}, implied m/unit (UPPER bound) {:.2}",
            cal.shell_samples,
            cal.shell_median_avg_units,
            cal.shell_median_muzzle,
            cal.shell_implied_m_per_unit
        );
        assert!(cal.full_ahead_windows > 0, "no sustained full-ahead window");
        assert!(
            (3.0..=12.0).contains(&cal.meters_per_unit),
            "implausible scale {}",
            cal.meters_per_unit
        );
        assert!(
            (cal.meters_per_unit - METERS_PER_UNIT).abs() <= 0.25,
            "constant {} drifted from live calibration {}",
            METERS_PER_UNIT,
            cal.meters_per_unit
        );
    }

    /// E6 against the real reference replay at t=300 — run with
    /// `WOWSP_TEST_REPLAY=<path> cargo test -p wowsp_tauri e6_ -- --nocapture`.
    /// Asserts the structural sanity asked for by the experiment and prints a
    /// JSON excerpt (recorder + three representative entities + zones).
    #[test]
    fn e6_tick_state_on_real_replay() {
        let Ok(path) = std::env::var("WOWSP_TEST_REPLAY") else {
            eprintln!("[e6] WOWSP_TEST_REPLAY not set - skipping");
            return;
        };
        let stream =
            super::super::replay::read_replay_positions(path.clone()).expect("decode real replay");
        let vehicles = read_roster(&path).expect("roster");
        let state = build_tick_state(&stream, &vehicles, 300.0, None, DEFAULT_EYE_HEIGHT)
            .expect("tick at t=300");
        assert!(
            state.recorder.throttle_level.is_some(),
            "recorder telegraph"
        );
        let kt = state.recorder.speed_kt.expect("recorder speed");
        assert!((5.0..=40.0).contains(&kt), "recorder speed {kt} kt");
        assert!(
            (8..=30).contains(&state.entities.len()),
            "entities {}",
            state.entities.len()
        );
        assert!(!state.zones.is_empty(), "zones must exist");
        let observed_enemies = state
            .entities
            .iter()
            .filter(|e| e.team_id == Some(1) && e.observed_now)
            .count();
        assert!(
            (0..=12).contains(&observed_enemies),
            "observed enemies {observed_enemies}"
        );
        eprintln!(
            "[e6] t={} map={:?}: {} entities ({} enemy observed, {} stale-enemy rows), {} zones, events {:?}",
            state.match_time,
            state.map_name,
            state.entities.len(),
            observed_enemies,
            state
                .entities
                .iter()
                .filter(|e| e.team_id == Some(1) && !e.observed_now)
                .count(),
            state.zones.len(),
            state.recent_events
        );
        // JSON excerpt for the experiment report: recorder, the nearest
        // observed enemy, the stalest enemy row, one ally, zones.
        let mut excerpt_entities = Vec::new();
        if let Some(nearest) = state
            .entities
            .iter()
            .filter(|e| e.team_id == Some(1) && e.observed_now)
            .min_by(|a, b| {
                a.distance_m
                    .unwrap_or(f32::MAX)
                    .partial_cmp(&b.distance_m.unwrap_or(f32::MAX))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        {
            excerpt_entities.push(nearest.clone());
        }
        if let Some(stalest) = state
            .entities
            .iter()
            .filter(|e| e.team_id == Some(1) && !e.observed_now)
            .max_by(|a, b| {
                a.last_observed_delta
                    .partial_cmp(&b.last_observed_delta)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        {
            excerpt_entities.push(stalest.clone());
        }
        if let Some(ally) = state.entities.iter().find(|e| e.team_id == Some(0)) {
            excerpt_entities.push(ally.clone());
        }
        let excerpt = serde_json::json!({
            "matchTime": state.match_time,
            "mapName": state.map_name,
            "recorder": state.recorder,
            "entities": excerpt_entities,
            "zones": state.zones,
            "recentEvents": state.recent_events,
        });
        eprintln!(
            "e6 excerpt:\n{}",
            serde_json::to_string_pretty(&excerpt).expect("serialize")
        );
    }

    /// Terrain-LOS integration against the real replay + the real E4 raster —
    /// run with `WOWSP_TEST_REPLAY=<path> [WOWSP_TEST_LOS_GRID=<path>] cargo
    /// test -p wowsp_tauri e6_los -- --nocapture`. Defaults the raster to the
    /// worktree's baked 50_Gold_harbor copy; skips when neither exists.
    #[test]
    fn e6_los_on_real_replay() {
        let Ok(path) = std::env::var("WOWSP_TEST_REPLAY") else {
            eprintln!("[e6-los] WOWSP_TEST_REPLAY not set - skipping");
            return;
        };
        let grid_path = match std::env::var("WOWSP_TEST_LOS_GRID") {
            Ok(p) => std::path::PathBuf::from(p),
            Err(_) => {
                let default = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../scripts/experiments/out/50_Gold_harbor/terrain_los.npz");
                if !default.exists() {
                    eprintln!("[e6-los] no LOS raster available - skipping");
                    return;
                }
                default
            },
        };
        let grid = LosGrid::load_npz(&grid_path).expect("load LOS raster");
        let stream =
            super::super::replay::read_replay_positions(path.clone()).expect("decode real replay");
        let vehicles = read_roster(&path).expect("roster");
        let state = build_tick_state(&stream, &vehicles, 300.0, Some(&grid), DEFAULT_EYE_HEIGHT)
            .expect("tick with LOS");
        let with_verdict: Vec<&DecisionTickEntity> = state
            .entities
            .iter()
            .filter(|e| e.terrain_blocked.is_some())
            .collect();
        let blocked = with_verdict
            .iter()
            .filter(|e| e.terrain_blocked == Some(true))
            .count();
        eprintln!(
            "[e6-los] observed enemies with verdict: {} (terrain-blocked {}); observed-all {}",
            with_verdict.len(),
            blocked,
            state.entities.iter().filter(|e| e.observed_now).count()
        );
        for e in with_verdict.iter().take(6) {
            eprintln!(
                "[e6-los] entity {} shipId {:?} dist {:.0} m blocked {:?}",
                e.entity_id,
                e.ship_id,
                e.distance_m.unwrap_or(0.0),
                e.terrain_blocked
            );
        }
        // Every observed enemy must carry a verdict when the grid was loaded.
        for e in &state.entities {
            if e.team_id == Some(1) && e.observed_now {
                assert!(
                    e.terrain_blocked.is_some(),
                    "observed enemy {} missing LOS verdict",
                    e.entity_id
                );
            }
        }
    }
}
