//! End-to-end fire-decision suggestions (G4-a) — the tactical-board surface.
//!
//! One call chains what experiments E5–E9 validated: decode the replay →
//! E7 weak-supervision decider set (alive ships with a fire history, plus
//! the recorder even when it never fired — a CV still gets a dummy row) →
//! per-decider E9 feature construction → [`DecisionModel`] inference → a
//! camelCase [`DecisionSuggestionReport`] for the webui.
//!
//! # Feature bridge (why this file re-implements instead of reusing)
//!
//! The E9 training rows are produced by `fire_dataset::export_decision_dataset`,
//! whose internals (ship join, salvo grouping, slot construction) are module
//! private and that module is frozen this round. This module therefore
//! re-implements the construction **field-for-field aligned** with
//! `fire_dataset.rs` (E7 semantics) and `train_fire_model.py`
//! (`featurize_slot` / `featurize_row`, E9 schema): entity[1,24,10] +
//! global_feat[1,14] + mask[1,24] → logitA/logitB. The env-gated
//! `feature_parity` test pins the alignment: for the same (decider, t) the
//! slots and globals built here are exactly equal to the exported row's.
//!
//! # Model path
//!
//! [`super::decision_ai::shared_model`] runs the G4 source ladder
//! (`decisions` pack → embedded E1 fixture) and the session's own metadata
//! picks the inference path: a 24-slot two-head schema runs the real model,
//! the [1,8] fixture keeps the E1 dummy semantics (suggestions still come
//! back, flagged `modelSource: "fixture"`).
//!
//! Incomplete-information discipline is inherited from E6/E7: every field
//! is built from samples at or before `t` only.

use anyhow::anyhow;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::Serialize;
use wowsp_tauri_shared::{
    CommandResult, EntityTrajectory, PositionSample, ReplayStream, ShellLaunchEvent, VehicleEntry,
};

use super::decision_ai::{DecisionModel, DecisionModelKind, advice_model, shared_model};
use super::decision_score::{
    ENTITY_DIM_V2, GLOBAL_DIM_V2, ScoreModel, ScoreModelKind, ScoreModelSources, ShipScoreReport,
    ablate_e11_tensors, build_ship_scores, feature_tensors_v2, softmax,
};
use super::decision_tick::{DEFAULT_EYE_HEIGHT, KT_MS, METERS_PER_UNIT};
use super::fire_dataset::{
    ENEMY_SLOTS, FRIEND_SLOTS, FireDatasetSlot, FireSampleParams, MOVE_SECTOR_COUNT,
    MOVE_SECTOR_NONE, MOVE_SECTOR_RAD, MoveDatasetRow, export_move_replay_file,
};
use super::replay_probe::{GAP_THRESHOLD, battle_results_conflicts, resolve_team, roster_sides};
use super::terrain_los::{LosGrid, los_blocked};

// ── DTOs (webui contract; camelCase over IPC) ───────────────────────────────

/// One ship's fire-decision suggestion at one instant.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionSuggestion {
    pub entity_id: i32,
    pub ship_id: Option<i64>,
    /// Recorder-relative team: 0 = recorder's side, 1 = enemy. Never null on
    /// the wire today — the recorder row's mirror ambiguity is resolved to
    /// the recorder's own side (0), deciders require a known team.
    pub team_id: Option<i8>,
    /// Whether this row is the replay's recorder (the webui highlights it).
    pub is_recorder: bool,
    /// Head-A logit "physically able to fire" (reload completing within the
    /// label window + an observed enemy in range). Fixture models have no
    /// head A: this is the hard rule as a saturated ±1 dummy.
    pub can_fire_logit: f32,
    /// Head-B logit "expert would fire now".
    pub fire_logit: f32,
    /// `sigmoid(fire_logit)`, always in [0, 1].
    pub fire_prob: f32,
    /// Nearest observed-now enemy within own engagement range (the E7
    /// eligibility target), `null` when none qualifies.
    pub target_entity_id: Option<i32>,
    /// Distance to [`Self::target_entity_id`] in metres.
    pub target_distance_m: Option<f32>,
}

/// The `decision_fire_suggestions` payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionSuggestionReport {
    /// The instant the suggestions were built for (seconds since start).
    pub time_sec: f32,
    pub map_name: Option<String>,
    /// `"pack"` (decisions model pack installed) | `"fixture"` (embedded E1
    /// dummy). Consumers must treat fixture numbers as placeholders.
    pub model_source: String,
    /// Provenance detail: the pack file's path or the fixture label.
    pub model_detail: String,
    /// `"fire24"` (E9 two-head schema) | `"fixture8"` (E1 dummy schema).
    pub model_kind: String,
    /// Whether a terrain-LOS raster was loaded for this map (features carry
    /// `terrainBlocked` verdicts only when true).
    pub los_grid_loaded: bool,
    /// One row per qualifying decider, ordered by entity id.
    pub suggestions: Vec<DecisionSuggestion>,
}

// ── E9 feature schema (mirrors train_fire_model.py — keep in sync) ──────────

/// Total entity slots: 16 enemies + 8 friends.
pub const SLOTS: usize = ENEMY_SLOTS + FRIEND_SLOTS;
/// Per-entity feature width.
pub const ENTITY_DIM: usize = 10;
/// Global (own-ship) feature width.
pub const GLOBAL_DIM: usize = 14;

/// Normalization constants — the fixed scales documented in
/// `train_fire_model.py` (no fitted scalers, one replay of data).
pub const DIST_SCALE_M: f32 = 10_000.0;
pub const SPEED_SCALE_KT: f32 = 40.0;
pub const AGE_SCALE_S: f32 = 60.0;
pub const TIME_SCALE_S: f32 = 1200.0;
pub const RANGE_SCALE_M: f32 = 30_000.0;
pub const ZONE_SCALE: f32 = 10.0;
pub const EVENT_SCALE: f32 = 8.0;

/// Muzzle height (world units) separating ship guns from aircraft ordnance —
/// `fire_dataset.rs`'s bound, mirrored for the salvo semantics.
const AIRBORNE_MUZZLE_Y_UNITS: f32 = 15.0;
/// `gunBarrelID` bound of the main battery (E7).
const MAIN_BATTERY_MAX_BARREL_ID: u16 = 32;
/// Trailing event window (seconds, E6 semantics).
const EVENT_WINDOW_S: f32 = 30.0;
/// "Near the decider" explosion radius (metres, E6 semantics).
const EXPLOSION_NEAR_RADIUS_M: f32 = 500.0;
/// InteractiveZone entity types (13 pre-14.5.0, 14 after).
const ZONE_ENTITY_TYPES: [i16; 2] = [13, 14];

/// One entity slot featurized (`featurize_slot` in the training script).
/// Field order is the model input order.
pub fn featurize_slot(slot: &FireDatasetSlot) -> [f32; ENTITY_DIM] {
    [
        (slot.dist_m / DIST_SCALE_M).min(2.0),
        slot.bearing_rel_rad.sin(),
        slot.bearing_rel_rad.cos(),
        slot.speed_kt.map_or(-1.0, |v| v / SPEED_SCALE_KT),
        slot.hp_frac.unwrap_or(-1.0),
        (slot.obs_age_s / AGE_SCALE_S).min(1.0),
        if slot.observed_now { 1.0 } else { 0.0 },
        slot.terrain_blocked
            .map_or(-1.0, |blocked| if blocked { 1.0 } else { 0.0 }),
        if slot.entity_type == 2 { 1.0 } else { 0.0 },
        if slot.speed_kt.is_some() { 1.0 } else { 0.0 },
    ]
}

/// The own/global feature block of one decision point.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DecisionGlobals {
    pub t: f32,
    pub own_speed_kt: Option<f32>,
    pub own_hp_frac: Option<f32>,
    /// `(t − last main salvo) / estimated reload`, clamped to [0, 1]; 1.0
    /// before the first salvo (guns spawn loaded).
    pub own_reload_frac: f32,
    /// Engagement range (metres) — max observed aim distance × slack, or the
    /// fallback when the ship never fired.
    pub own_range_m: f32,
    pub zones_owned_0: u32,
    pub zones_owned_1: u32,
    pub zones_owned_2: u32,
    pub zones_owned_other: u32,
    pub zones_active_progress: u32,
    pub events_shells_30s: u32,
    pub events_torps_30s: u32,
    pub events_explosions_30s: u32,
    pub events_explosions_near_30s: u32,
}

/// `featurize_row`'s global half (the training script's fixed scales).
pub fn featurize_globals(g: &DecisionGlobals) -> [f32; GLOBAL_DIM] {
    [
        g.t / TIME_SCALE_S,
        g.own_speed_kt.map_or(-1.0, |v| v / SPEED_SCALE_KT),
        g.own_hp_frac.unwrap_or(-1.0),
        g.own_reload_frac,
        g.own_range_m / RANGE_SCALE_M,
        g.zones_owned_0 as f32 / ZONE_SCALE,
        g.zones_owned_1 as f32 / ZONE_SCALE,
        g.zones_owned_2 as f32 / ZONE_SCALE,
        g.zones_owned_other as f32 / ZONE_SCALE,
        g.zones_active_progress as f32 / ZONE_SCALE,
        (g.events_shells_30s as f32 + 1.0).ln() / EVENT_SCALE,
        (g.events_torps_30s as f32 + 1.0).ln() / EVENT_SCALE,
        (g.events_explosions_30s as f32 + 1.0).ln() / EVENT_SCALE,
        (g.events_explosions_near_30s as f32 + 1.0).ln() / EVENT_SCALE,
    ]
}

// ── E7 bridge: ship rows + per-owner fire context (mirrors fire_dataset.rs) ─

/// A ship trajectory joined with its recorder-relative team — the
/// `fire_dataset::ShipInfo` shape, rebuilt here because that struct's
/// fields are module-private.
pub(crate) struct ShipRow<'a> {
    traj: &'a EntityTrajectory,
    team_id: Option<i8>,
    team_ambiguous: bool,
    is_recorder: bool,
}

/// Type-2 ship trajectories with team attribution (E3 semantics verbatim).
pub(crate) fn ship_rows<'a>(
    stream: &'a ReplayStream,
    vehicles: &[VehicleEntry],
) -> Vec<ShipRow<'a>> {
    let sides = roster_sides(vehicles);
    let conflicts = battle_results_conflicts(stream.battle_results.as_deref());
    stream
        .trajectories
        .iter()
        .filter(|t| t.kind.as_ref().is_some_and(|k| k.entity_type == 2))
        .map(|traj| {
            let (team_id, team_ambiguous) = resolve_team(
                traj.kind.as_ref().and_then(|k| k.ship_id),
                &sides,
                &conflicts,
            );
            ShipRow {
                traj,
                team_id,
                team_ambiguous,
                is_recorder: stream.recorder_vehicle_id == Some(traj.entity_id),
            }
        })
        .collect()
}

/// One fire event: one owner's shells of one battery class, contiguous in
/// time (≤ 2 s gaps) — the replay-visible proxy for one player click.
#[derive(Debug, Clone, Copy)]
struct Salvo {
    start: f32,
    /// Time of the event's last shell (the 2 s merge gap is measured from
    /// here, not from the salvo start).
    last_time: f32,
    main_battery: bool,
    max_aim_dist_units: f32,
}

/// Fire-derived state per owner (E7): salvo starts, reload estimate,
/// observed engagement range.
struct OwnerFireContext {
    salvos: Vec<Salvo>,
    reload_s: f32,
    range_m: f32,
    has_fire_history: bool,
}

/// p10 of the intervals between consecutive MAIN-battery salvos, clamped to
/// the plausible band (E7's reload estimator, verbatim semantics).
fn estimate_reload(main_starts: &[f32], params: &FireSampleParams) -> f32 {
    if main_starts.len() < 2 {
        return 0.0;
    }
    let mut intervals: Vec<f32> = main_starts.windows(2).map(|w| w[1] - w[0]).collect();
    intervals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = (((intervals.len() as f32 - 1.0) * 0.10).round() as usize).min(intervals.len() - 1);
    intervals[idx].clamp(params.min_reload_s, params.max_reload_s)
}

/// Build every type-2 ship's fire context from the ground-level shells —
/// `fire_dataset::fire_contexts` mirrored (owners without shells get the
/// fallback range and always-reloaded guns).
fn fire_contexts(
    stream: &ReplayStream,
    ships: &[ShipRow<'_>],
    params: &FireSampleParams,
) -> BTreeMap<i32, OwnerFireContext> {
    let mut by_owner: BTreeMap<i32, Vec<&ShellLaunchEvent>> = BTreeMap::new();
    for s in &stream.shell_launches {
        if s.y < AIRBORNE_MUZZLE_Y_UNITS {
            by_owner.entry(s.owner_id).or_default().push(s);
        }
    }
    let mut out = BTreeMap::new();
    for ship in ships {
        let id = ship.traj.entity_id;
        let Some(shells) = by_owner.get(&id) else {
            out.insert(
                id,
                OwnerFireContext {
                    salvos: Vec::new(),
                    reload_s: 0.0,
                    range_m: params.range_fallback_m,
                    has_fire_history: false,
                },
            );
            continue;
        };
        // group_salvos: within each battery class, consecutive shells ≤ 2 s
        // apart merge (salvo ids are pack-level, not click-level).
        let mut sorted: Vec<&ShellLaunchEvent> = shells.to_vec();
        sorted.sort_by(|a, b| {
            a.time
                .partial_cmp(&b.time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut classes: [Vec<&ShellLaunchEvent>; 2] = [Vec::new(), Vec::new()];
        for s in sorted {
            let main = s.gun_barrel_id < MAIN_BATTERY_MAX_BARREL_ID;
            classes[usize::from(!main)].push(s);
        }
        let mut salvos = Vec::new();
        for (idx, class) in classes.into_iter().enumerate() {
            let main = idx == 0;
            let mut current: Option<Salvo> = None;
            for s in class {
                let aim = (s.target_x - s.x).hypot(s.target_z - s.z);
                match current.as_mut() {
                    Some(prev) if s.time - prev.last_time <= 2.0 => {
                        prev.max_aim_dist_units = prev.max_aim_dist_units.max(aim);
                        prev.last_time = s.time;
                    },
                    _ => {
                        if let Some(ev) = current.take() {
                            salvos.push(ev);
                        }
                        current = Some(Salvo {
                            start: s.time,
                            last_time: s.time,
                            main_battery: main,
                            max_aim_dist_units: aim,
                        });
                    },
                }
            }
            if let Some(ev) = current.take() {
                salvos.push(ev);
            }
        }
        salvos.sort_by(|a, b| {
            a.start
                .partial_cmp(&b.start)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let main_starts: Vec<f32> = salvos
            .iter()
            .filter(|s| s.main_battery)
            .map(|s| s.start)
            .collect();
        let reload_s = estimate_reload(&main_starts, params);
        let max_aim = salvos
            .iter()
            .filter(|s| s.main_battery)
            .map(|s| s.max_aim_dist_units)
            .fold(0.0f32, f32::max);
        let range_m = if max_aim > 0.0 {
            max_aim * METERS_PER_UNIT * params.range_slack
        } else {
            params.range_fallback_m
        };
        out.insert(
            id,
            OwnerFireContext {
                salvos,
                reload_s,
                range_m,
                has_fire_history: true,
            },
        );
    }
    out
}

// ── at-time helpers (mirrors of fire_dataset.rs) ────────────────────────────

/// Latest sample at or before `t` (binary search; streams are time-sorted).
fn last_sample_before(samples: &[PositionSample], t: f32) -> Option<&PositionSample> {
    let idx = samples.partition_point(|s| s.time <= t);
    if idx == 0 {
        None
    } else {
        Some(&samples[idx - 1])
    }
}

/// Planar distance between two samples' positions (units).
fn planar_dist(a: (f32, f32), b: (f32, f32)) -> f32 {
    (a.0 - b.0).hypot(a.1 - b.1)
}

/// Wrap an angle to [-pi, pi].
fn wrap_angle(a: f32) -> f32 {
    let r = a.rem_euclid(std::f32::consts::TAU);
    if r > std::f32::consts::PI {
        r - std::f32::consts::TAU
    } else {
        r
    }
}

/// Trailing-streak speed (kt): walk back ≤ 8 s from the last sample ≤ t,
/// never across a > GAP_THRESHOLD inter-sample gap (E6 semantics).
fn trailing_speed_kt(ships: &[ShipRow<'_>], entity_id: i32, t: f32) -> Option<f32> {
    let ship = ships.iter().find(|s| s.traj.entity_id == entity_id)?;
    let samples = &ship.traj.samples;
    let end = samples.partition_point(|s| s.time <= t).checked_sub(1)?;
    let mut start = end;
    for i in (0..end).rev() {
        if samples[i + 1].time - samples[i].time > GAP_THRESHOLD {
            break;
        }
        if samples[end].time - samples[i].time > 8.0 {
            break;
        }
        start = i;
    }
    let dt = samples[end].time - samples[start].time;
    if dt < 1.0 {
        return None;
    }
    let v = (samples[end].x - samples[start].x).hypot(samples[end].z - samples[start].z) / dt;
    Some(v * METERS_PER_UNIT / KT_MS)
}

/// HP fraction at `t` vs the entity's first observed HP sample (max proxy).
fn hp_frac_at(traj: &EntityTrajectory, t: f32) -> Option<f32> {
    let first = traj.hp_samples.first()?;
    let cur = traj.hp_samples.iter().rev().find(|s| s.time <= t)?;
    if first.value == 0 {
        return None;
    }
    Some((cur.value as f32 / first.value as f32).clamp(0.0, 1.0))
}

/// Zone + trailing-event summary at `t` (E6 semantics, decider-centric).
fn zone_and_event_summary(stream: &ReplayStream, own: &PositionSample, t: f32) -> DecisionGlobals {
    let mut g = DecisionGlobals {
        t,
        own_speed_kt: None,
        own_hp_frac: None,
        own_reload_frac: 1.0,
        own_range_m: 0.0,
        zones_owned_0: 0,
        zones_owned_1: 0,
        zones_owned_2: 0,
        zones_owned_other: 0,
        zones_active_progress: 0,
        events_shells_30s: 0,
        events_torps_30s: 0,
        events_explosions_30s: 0,
        events_explosions_near_30s: 0,
    };
    for traj in &stream.trajectories {
        let Some(kind) = traj.kind.as_ref() else {
            continue;
        };
        if !ZONE_ENTITY_TYPES.contains(&kind.entity_type) {
            continue;
        }
        let owner = traj
            .cap_samples
            .iter()
            .rev()
            .find(|s| s.time <= t)
            .map(|s| s.value)
            .or_else(|| kind.initial_team.map(|v| v as u32));
        match owner {
            Some(0) => g.zones_owned_0 += 1,
            Some(1) => g.zones_owned_1 += 1,
            Some(2) => g.zones_owned_2 += 1,
            Some(_) => g.zones_owned_other += 1,
            None => {},
        }
        if let Some(p) = traj.cap_progress.iter().rev().find(|s| s.time <= t) {
            if p.value > 0 && p.value < 1000 {
                g.zones_active_progress += 1;
            }
        }
    }
    let in_window = |tt: f32| tt > t - EVENT_WINDOW_S && tt <= t;
    let near_units = EXPLOSION_NEAR_RADIUS_M / METERS_PER_UNIT;
    g.events_shells_30s = stream
        .shell_launches
        .iter()
        .filter(|e| in_window(e.time))
        .count() as u32;
    g.events_torps_30s = stream
        .torpedoes
        .iter()
        .filter(|e| in_window(e.time))
        .count() as u32;
    g.events_explosions_30s = stream
        .explosions
        .iter()
        .filter(|e| in_window(e.time))
        .count() as u32;
    g.events_explosions_near_30s = stream
        .explosions
        .iter()
        .filter(|e| in_window(e.time) && (e.x - own.x).hypot(e.z - own.z) <= near_units)
        .count() as u32;
    g
}

/// One fully-constructed decision point (pre-featurization).
#[derive(Debug, Clone)]
pub struct DecisionPoint {
    pub owner_entity_id: i32,
    pub ship_id: Option<i64>,
    pub team_id: i8,
    pub is_recorder: bool,
    /// The decider's last-known heading at `t` (fixture-path input).
    pub own_yaw: f32,
    pub globals: DecisionGlobals,
    pub enemies: Vec<FireDatasetSlot>,
    pub friends: Vec<FireDatasetSlot>,
    /// Nearest observed-now enemy within own range (entity id, distance m).
    pub target: Option<(i32, f32)>,
    /// The E7 hard eligibility rule (training labelA): reload completes
    /// within the label window AND an observed-now enemy is in range.
    pub can_fire_rule: bool,
}

/// Nearest observed-now enemy within `range_m` (E7's target semantics).
struct EnemySighting {
    entity_id: i32,
    dist_m: f32,
}

fn nearest_enemy(
    // The decider's EFFECTIVE team (after the recorder mirror-ambiguity
    // override) — not ShipRow::team_id, which stays None for ambiguous
    // mirror ships and would let teammates into the candidate set.
    effective_team: i8,
    own_entity_id: i32,
    ships: &[ShipRow<'_>],
    own: &PositionSample,
    t: f32,
    range_m: f32,
) -> Option<EnemySighting> {
    let mut best: Option<EnemySighting> = None;
    for other in ships {
        if other.traj.entity_id == own_entity_id
            || other.team_id.is_none()
            || other.team_ambiguous
            || other.team_id == Some(effective_team)
        {
            continue;
        }
        let Some(e) = last_sample_before(&other.traj.samples, t) else {
            continue;
        };
        if t - e.time > GAP_THRESHOLD || other.traj.death_time.is_some_and(|d| d <= t) {
            continue;
        }
        let dist_m = planar_dist((own.x, own.z), (e.x, e.z)) * METERS_PER_UNIT;
        if dist_m <= range_m && best.as_ref().is_none_or(|b| dist_m < b.dist_m) {
            best = Some(EnemySighting {
                entity_id: other.traj.entity_id,
                dist_m,
            });
        }
    }
    best
}

/// Build the enemy or friend slot list for one decider position at `t` —
/// `fire_dataset::build_slots` mirrored: observed-now first, then stale,
/// each by ascending distance; truncated to `max_slots`.
#[allow(clippy::too_many_arguments)]
fn build_slots(
    decider_id: i32,
    decider_team: i8,
    ships: &[ShipRow<'_>],
    own: &PositionSample,
    t: f32,
    los: Option<&LosGrid>,
    eye_height: f32,
    enemy_side: bool,
    max_slots: usize,
) -> Vec<FireDatasetSlot> {
    let mut candidates: Vec<(bool, f32, &ShipRow<'_>, &PositionSample)> = Vec::new();
    for other in ships {
        if other.traj.entity_id == decider_id {
            continue;
        }
        let Some(team) = other.team_id else {
            continue;
        };
        let is_side = if enemy_side {
            team != decider_team
        } else {
            team == decider_team
        };
        if !is_side {
            continue;
        }
        let Some(last) = last_sample_before(&other.traj.samples, t) else {
            continue; // never observed by t — not in the decider's world
        };
        if other.traj.death_time.is_some_and(|d| d <= t) {
            continue;
        }
        let dist_m = planar_dist((own.x, own.z), (last.x, last.z)) * METERS_PER_UNIT;
        let observed_now = t - last.time <= GAP_THRESHOLD;
        candidates.push((!observed_now, dist_m, other, last));
    }
    candidates.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
    });
    candidates
        .into_iter()
        .take(max_slots)
        .map(|(_stale, dist_m, other, last)| {
            // Bearing convention: atan2(dz, dx) relative to the decider's yaw.
            let bearing = (last.z - own.z).atan2(last.x - own.x);
            let observed_now = t - last.time <= GAP_THRESHOLD;
            let terrain_blocked = if enemy_side && observed_now {
                los.map(|g| {
                    los_blocked(
                        g,
                        (own.x as f64, own.z as f64, eye_height as f64),
                        (last.x as f64, last.z as f64, 0.0),
                    )
                })
            } else {
                None
            };
            FireDatasetSlot {
                entity_id: other.traj.entity_id,
                entity_type: other.traj.kind.as_ref().map_or(-1, |k| k.entity_type),
                ship_id: other.traj.kind.as_ref().and_then(|k| k.ship_id),
                dist_m,
                bearing_rel_rad: wrap_angle(bearing - own.yaw),
                speed_kt: trailing_speed_kt(ships, other.traj.entity_id, t),
                hp_frac: hp_frac_at(other.traj, t),
                obs_age_s: t - last.time,
                observed_now,
                terrain_blocked,
                // Feature-v2 fields (E14): the serve path still featurizes
                // for the packed v1 model and decodes no E11 event streams,
                // so every event-derived field carries its "unknown"
                // sentinel — only the side marker is exact. Wiring the live
                // v2 featurization happens when a v2 model is packed.
                spotted_now: None,
                inside_smoke: false,
                radar_lit: false,
                is_enemy: enemy_side,
                engine_power_frac: None,
            }
        })
        .collect()
}

/// Ships + fire contexts + params: everything the per-decider construction
/// needs, bundled so no builder grows a clippy-defeating argument list.
pub(crate) struct ServeState<'a> {
    stream: &'a ReplayStream,
    ships: Vec<ShipRow<'a>>,
    contexts: BTreeMap<i32, OwnerFireContext>,
    params: FireSampleParams,
}

impl<'a> ServeState<'a> {
    pub(crate) fn build(
        stream: &'a ReplayStream,
        vehicles: &[VehicleEntry],
        params: FireSampleParams,
    ) -> Self {
        let ships = ship_rows(stream, vehicles);
        let contexts = fire_contexts(stream, &ships, &params);
        Self {
            stream,
            ships,
            contexts,
            params,
        }
    }

    /// Construct one decider's decision point at `t`. `team_override` forces
    /// the recorder-relative team (used for the recorder row when its shipId
    /// is mirror-ambiguous — the recorder is team 0 by definition).
    /// `None` when the ship has no position sample at or before `t`.
    pub(crate) fn decision_point(
        &self,
        ship: &ShipRow<'a>,
        t: f32,
        los: Option<&LosGrid>,
        eye_height: f32,
        team_override: Option<i8>,
    ) -> Option<DecisionPoint> {
        let ctx = self.contexts.get(&ship.traj.entity_id)?;
        let own = last_sample_before(&ship.traj.samples, t)?;
        let team_id = team_override.or(ship.team_id).unwrap_or(0);
        // labelA hard rule (E7 eligibility): the reload completes within the
        // label window AND an observed-now enemy sits inside own range.
        let effective_reload = (ctx.reload_s - self.params.decision_interval_s).max(0.0);
        let is_reloaded = !ctx
            .salvos
            .iter()
            .filter(|s| s.main_battery)
            .any(|s| s.start <= t && t - s.start < effective_reload);
        let target = nearest_enemy(
            team_id,
            ship.traj.entity_id,
            &self.ships,
            own,
            t,
            ctx.range_m,
        );
        let last_main_salvo = ctx
            .salvos
            .iter()
            .rfind(|s| s.main_battery && s.start <= t)
            .map(|s| s.start);
        let mut globals = zone_and_event_summary(self.stream, own, t);
        globals.own_speed_kt = trailing_speed_kt(&self.ships, ship.traj.entity_id, t);
        globals.own_hp_frac = hp_frac_at(ship.traj, t);
        globals.own_reload_frac = match last_main_salvo {
            Some(s) => ((t - s) / ctx.reload_s.max(0.001)).clamp(0.0, 1.0),
            None => 1.0, // guns spawn loaded
        };
        globals.own_range_m = ctx.range_m;
        Some(DecisionPoint {
            owner_entity_id: ship.traj.entity_id,
            ship_id: ship.traj.kind.as_ref().and_then(|k| k.ship_id),
            team_id,
            is_recorder: ship.is_recorder,
            own_yaw: own.yaw,
            globals,
            enemies: build_slots(
                ship.traj.entity_id,
                team_id,
                &self.ships,
                own,
                t,
                los,
                eye_height,
                true,
                ENEMY_SLOTS,
            ),
            friends: build_slots(
                ship.traj.entity_id,
                team_id,
                &self.ships,
                own,
                t,
                los,
                eye_height,
                false,
                FRIEND_SLOTS,
            ),
            target: target.as_ref().map(|e| (e.entity_id, e.dist_m)),
            can_fire_rule: is_reloaded && target.is_some(),
        })
    }

    /// Whether `ship` is alive at `t` (no death, or death after `t`).
    fn alive_at(&self, ship: &ShipRow<'_>, t: f32) -> bool {
        ship.traj.death_time.is_none_or(|d| d > t)
    }
}

/// The E9 feature tensors for one decision point: flat row-major
/// entity[SLOTS×ENTITY_DIM], global[GLOBAL_DIM], mask[SLOTS].
pub fn feature_tensors(point: &DecisionPoint) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let mut entity = vec![0.0f32; SLOTS * ENTITY_DIM];
    let mut mask = vec![0.0f32; SLOTS];
    let slots = point
        .enemies
        .iter()
        .take(ENEMY_SLOTS)
        .chain(point.friends.iter().take(FRIEND_SLOTS));
    for (i, slot) in slots.enumerate() {
        entity[i * ENTITY_DIM..(i + 1) * ENTITY_DIM].copy_from_slice(&featurize_slot(slot));
        mask[i] = 1.0;
    }
    (entity, featurize_globals(&point.globals).to_vec(), mask)
}

/// The E1 fixture-path dummy state for one decision point (E1 field order):
/// own heading, normalized own speed, nearest observed enemy bearing /
/// distance, own HP fraction, target visibility.
fn fixture_input(point: &DecisionPoint) -> [f32; 8] {
    // Slot order is observed-first-by-distance, so the first observed-now
    // enemy IS the nearest one.
    let target = point.enemies.iter().find(|e| e.observed_now);
    let (bsin, bcos, dist, vis) = match target {
        Some(e) => (
            e.bearing_rel_rad.sin(),
            e.bearing_rel_rad.cos(),
            (e.dist_m / DIST_SCALE_M).min(2.0),
            1.0,
        ),
        None => (0.0, 1.0, 0.0, 0.0),
    };
    [
        point.own_yaw.sin(),
        point.own_yaw.cos(),
        point.own_speed_normalized(),
        bsin,
        bcos,
        dist,
        point.globals.own_hp_frac.unwrap_or(1.0),
        vis,
    ]
}

impl DecisionPoint {
    /// Own speed normalized by [`SPEED_SCALE_KT`] (0 when unknown).
    fn own_speed_normalized(&self) -> f32 {
        self.globals
            .own_speed_kt
            .map_or(0.0, |v| (v / SPEED_SCALE_KT).clamp(0.0, 2.0))
    }
}

fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

fn model_kind_str(kind: &DecisionModelKind) -> &'static str {
    match kind {
        DecisionModelKind::Fire24 { attr_dim, .. } => {
            if *attr_dim > 0 {
                "fire24-attrs"
            } else {
                "fire24"
            }
        },
        DecisionModelKind::Fixture8 => "fixture8",
    }
}

/// Run the model over one decision point → one suggestion row. An
/// attribute-routed model (attr_dim > 0) gets its routing vector from the
/// embedded ship-attribute table — the same bytes training featurized
/// against — built from the point's own ship and its friend/enemy slots.
fn infer_one(
    model: &mut DecisionModel,
    point: &DecisionPoint,
) -> anyhow::Result<DecisionSuggestion> {
    let (can_fire_logit, fire_logit) = match model.kind() {
        DecisionModelKind::Fire24 { attr_dim, .. } => {
            let (entity, global, mask) = feature_tensors(point);
            let routing = (*attr_dim > 0)
                .then(|| {
                    crate::commands::ship_attrs::embedded_row_vector(
                        point.ship_id,
                        &point.friends,
                        &point.enemies,
                    )
                })
                .transpose()?;
            model.infer_fire(&entity, &global, &mask, routing.as_ref().map(|v| &v[..]))?
        },
        // The fixture has no two-head layout: head A is the E7 hard rule as
        // a saturated dummy, head B is the fixture's fire vote (logit 7).
        DecisionModelKind::Fixture8 => {
            let input = fixture_input(point);
            let y = model.infer_fixture(&input)?;
            (if point.can_fire_rule { 1.0 } else { -1.0 }, y[7])
        },
    };
    Ok(DecisionSuggestion {
        entity_id: point.owner_entity_id,
        ship_id: point.ship_id,
        team_id: Some(point.team_id),
        is_recorder: point.is_recorder,
        can_fire_logit,
        fire_logit,
        fire_prob: sigmoid(fire_logit),
        target_entity_id: point.target.map(|(id, _)| id),
        target_distance_m: point.target.map(|(_, d)| d),
    })
}

/// Build the full suggestion report for `stream` at `time_sec` (pure core —
/// the command does the IO). Decider set: alive ships with a known team and
/// a fire history (the E7 weak-supervision criterion), plus the recorder
/// even when it never fired (a CV still gets a row — dummy under the
/// fixture, real features under the fire model).
pub fn build_suggestions(
    stream: &ReplayStream,
    vehicles: &[VehicleEntry],
    time_sec: f32,
    los: Option<&LosGrid>,
    eye_height: f32,
    model: &mut DecisionModel,
) -> anyhow::Result<DecisionSuggestionReport> {
    let state = ServeState::build(stream, vehicles, FireSampleParams::default());
    let mut ordered: Vec<&ShipRow<'_>> = state.ships.iter().collect();
    ordered.sort_by_key(|s| s.traj.entity_id);
    let mut suggestions = Vec::new();
    for ship in ordered {
        let Some(ctx) = state.contexts.get(&ship.traj.entity_id) else {
            continue;
        };
        if !state.alive_at(ship, time_sec) {
            continue;
        }
        if !ctx.has_fire_history && !ship.is_recorder {
            continue;
        }
        // The recorder row is always team 0 (recorder-relative namespace)
        // even when its shipId is mirror-ambiguous.
        let team_override = if ship.is_recorder && (ship.team_id.is_none() || ship.team_ambiguous) {
            Some(0_i8)
        } else {
            None
        };
        if team_override.is_none() && (ship.team_id.is_none() || ship.team_ambiguous) {
            continue;
        }
        let Some(point) = state.decision_point(ship, time_sec, los, eye_height, team_override)
        else {
            continue;
        };
        suggestions.push(infer_one(model, &point)?);
    }
    Ok(DecisionSuggestionReport {
        time_sec,
        map_name: stream.map_name.clone(),
        model_source: model.source().as_str().to_string(),
        model_detail: model.detail().to_string(),
        model_kind: model_kind_str(model.kind()).to_string(),
        los_grid_loaded: los.is_some(),
        suggestions,
    })
}

/// `<los_dir>/<map short name>/terrain_los.npz` (the E12 lookup convention);
/// absent map name / missing file / unparsable raster → `None`.
fn los_for_map(map_name: Option<&str>, los_dir: &Path) -> Option<LosGrid> {
    let short = map_name?.rsplit('/').next()?.trim();
    if short.is_empty() {
        return None;
    }
    LosGrid::load_npz(&los_dir.join(short).join("terrain_los.npz")).ok()
}

// ── E18 · G6 step 3: the AI analysis debug report ───────────────────────────
//
// The tactical-debug surface the E17 negative result shaped: "given THIS time
// and THIS intel, where should each ship go" (movement advice, the E16 move
// model) next to the full per-ship score timeline (E17's
// `compute_ship_scores` core). The E17 validation FAILED the preregistered
// ρ≥0.30 line (wholeGame vs damage ρ=+0.011), so the UI copy must present the
// scores as MODEL AGREEMENT ("模型认同度") with an explicit ≠skill/≠result
// disclaimer — the webui carries that banner; the wire contract just carries
// the numbers.
//
// # Feature reuse (why the advice rides the E16 rows, not a rebuild)
//
// The movement advice deliberately consumes the rows of ONE
// `export_move_replay_file` pass — the exact E16 decision-point construction
// (v2 features, own-observable gate, censorship) the move model was trained
// on. Re-implementing the featurizer at an arbitrary `t` would risk the very
// train/inference drift the E14 lesson warns about; snapping to each ship's
// latest row at or before `t` (rows sit on a 4 s grid, staleness capped at
// [`MOVE_ADVICE_MAX_STALE_S`]) never reads a sample after `t`, so the
// incomplete-information discipline holds. The same rows also feed the score
// timeline, so ONE export + ONE extra decode serves the whole report.
//
// # Cost & cache
//
// A cold call = one movement export (decode + features), one raw-stream
// decode (fire actions / battle results / death times) and two model passes
// over every row (~4–8 s per replay on a desktop CPU, E17 measured). The
// expensive artifacts — the full-timeline score report and the per-ship row
// lists — are cached in-process (single slot keyed by replay path + LOS dir +
// both model sources, the `OnceLock<Mutex<…>>` precedent of the model
// ladders); per-call work after a hit is only the ~14 movement forwards
// (milliseconds). The DTO says which happened via `cached` / `elapsedMs`.

/// Movement-advice staleness cap: a ship's latest E16 row must be at most
/// this old (two decision intervals) for its advice to be served — older
/// intel than that (dark ship / pre-first-row) yields no row, honestly.
pub const MOVE_ADVICE_MAX_STALE_S: f32 = 8.0;

/// One ship's movement advice at one instant (E16 move model over that
/// ship's latest decision row at or before `time_sec`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovementAdvice {
    pub entity_id: i32,
    pub ship_id: Option<i64>,
    /// Recorder-relative team: 0 = recorder's side, 1 = enemy.
    pub team_id: i8,
    pub is_recorder: bool,
    /// Decision time of the underlying E16 row (≤ `time_sec`).
    pub row_t: f32,
    /// Argmax sector: 0..=15 directional (22.5° each, sector 0 = dead ahead),
    /// 16 = no-move.
    pub top_sector: u8,
    pub top_prob: f32,
    /// The full 17-class softmax (sums to 1).
    pub prob_dist: Vec<f32>,
    /// Absolute map bearing of the top sector, reconstructed serve-side as
    /// `own_yaw + topSector × 22.5°` in the E16 labels' atan2(dz, dx) frame;
    /// `null` for the no-move class (no direction to draw).
    pub map_bearing_rad: Option<f32>,
    /// Runner-up sector (never the no-move mixing rule — plain second argmax).
    /// The webui draws its pale short arrow when `second_prob` clears 0.15.
    pub second_sector: u8,
    pub second_prob: f32,
}

/// The `decision_debug_report` payload: movement advice for the instant plus
/// the EMBEDDED full-timeline score report (per-ship samples slide on the
/// client without further calls).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionDebugReport {
    pub time_sec: f32,
    pub map_name: Option<String>,
    /// Provenance of the two scoring/advice models (path or label).
    pub fire_model: String,
    pub move_model: String,
    /// Where each model came from: `"env"` (debug override) | `"pack"`
    /// (decisions pack) | `"experiments"` (local out/ default).
    pub fire_model_origin: String,
    pub move_model_origin: String,
    /// Whether a terrain-LOS raster fed the feature pass for this map.
    pub los_grid_loaded: bool,
    /// Whether the expensive artifacts came from the in-process cache.
    pub cached: bool,
    /// Wall time of this call (ms) — a cold build is seconds, a cached hit
    /// is the ~14 movement forwards.
    pub elapsed_ms: u64,
    /// One row per alive team-known ship with a fresh-enough row, ordered by
    /// entity id.
    pub movement: Vec<MovementAdvice>,
    /// The E17 score report over the SAME export (full timeline).
    pub scores: ShipScoreReport,
}

/// Pure top-2 extraction + bearing reconstruction (unit-tested without a
/// session): `probs` is the 17-class softmax of one row, `own_yaw_rad` that
/// row's heading (the E16 relative-frame reference).
fn movement_advice_row(row: &MoveDatasetRow, probs: &[f32], is_recorder: bool) -> MovementAdvice {
    let mut top = 0usize;
    for (i, p) in probs.iter().enumerate() {
        if *p > probs[top] {
            top = i;
        }
    }
    // True runner-up: best index strictly EXCLUDING `top`, via a sentinel
    // scan. The old in-loop `second` track broke when the argmax sat at 0 —
    // `probs[second]` was then the max itself, unbeatable, and every
    // distribution with top==0 reported second=(top+1) instead of the real
    // runner-up (a wrong pale arrow on the map).
    let mut second = usize::MAX;
    for (i, p) in probs.iter().enumerate() {
        if i != top && (second == usize::MAX || *p > probs[second]) {
            second = i;
        }
    }
    let top_sector = top as u8;
    MovementAdvice {
        entity_id: row.core.owner_entity_id,
        ship_id: row.core.ship_id,
        team_id: row.core.team_id,
        is_recorder,
        row_t: row.core.t,
        top_sector,
        top_prob: probs[top],
        map_bearing_rad: (top_sector != MOVE_SECTOR_NONE)
            .then(|| wrap_angle(row.own_yaw_rad + top_sector as f32 * MOVE_SECTOR_RAD)),
        prob_dist: probs.to_vec(),
        second_sector: second as u8,
        second_prob: probs[second],
    }
}

// ── the debug model ladder (env → pack → experiments out/) ──────────────────

/// The experiments outputs root (compile-time path; same root the E17
/// scoring ladder defaults to).
fn experiments_out() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../scripts/experiments/out")
}

/// Default debug models (fp32 deliberate — E16 measured int8 hurting the
/// 17-class head; see `decision_score`'s module docs).
pub const DEBUG_FIRE_MODEL_REL: &str = "fire_model/v2plain_std/fp32.onnx";
pub const DEBUG_MOVE_MODEL_REL: &str = "move_model/node3/main/fp32.onnx";

/// One ladder step: where a candidate file lives + how to label its origin.
struct DebugModelCandidate {
    path: PathBuf,
    origin: &'static str,
}

/// env override → decisions-pack slot → the experiments default, in order;
/// missing files simply drop out of the ladder.
fn debug_model_candidates(
    env_key: &str,
    pack_file: &str,
    default_rel: &str,
) -> Vec<DebugModelCandidate> {
    let mut out = Vec::new();
    if let Ok(p) = std::env::var(env_key) {
        if !p.trim().is_empty() {
            out.push(DebugModelCandidate {
                path: PathBuf::from(p),
                origin: "env",
            });
        }
    }
    if let Ok(cache) = crate::paths::cache_dir() {
        out.push(DebugModelCandidate {
            path: cache.join("decisions").join(pack_file),
            origin: "pack",
        });
    }
    out.push(DebugModelCandidate {
        path: experiments_out().join(default_rel),
        origin: "experiments",
    });
    out
}

/// Try each candidate in order; the FIRST that reads, classifies to
/// `want_fire` and declares the v2 widths the fixed featurizers build wins.
/// Candidates that exist but cannot serve the v2 schema (e.g. a v1 fire
/// model inside an installed pack) are skipped, not errors — the report
/// publishes the winner's path so the fallback is visible.
fn load_debug_model(
    env_key: &str,
    pack_file: &str,
    default_rel: &str,
    want_fire: bool,
) -> anyhow::Result<(ScoreModel, &'static str)> {
    let candidates = debug_model_candidates(env_key, pack_file, default_rel);
    let mut errors = Vec::new();
    for c in &candidates {
        let bytes = match std::fs::read(&c.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                errors.push(format!("{}: {e}", c.path.display()));
                continue;
            },
        };
        match ScoreModel::from_bytes(c.path.to_string_lossy().into_owned(), &bytes) {
            Ok(model) => {
                let kind_ok = if want_fire {
                    model.kind() == &ScoreModelKind::FireTwoHead
                } else {
                    model.kind()
                        == &ScoreModelKind::MoveSectors {
                            sectors: MOVE_SECTOR_COUNT,
                        }
                };
                if kind_ok && model.widths() == (24, ENTITY_DIM_V2, GLOBAL_DIM_V2) {
                    return Ok((model, c.origin));
                }
                errors.push(format!(
                    "{} is not a usable {} debug model ({:?}, widths {:?})",
                    c.path.display(),
                    if want_fire { "fire" } else { "movement" },
                    model.kind(),
                    model.widths()
                ));
            },
            Err(e) => errors.push(format!("{}: {e}", c.path.display())),
        }
    }
    anyhow::bail!(
        "no usable debug model for {env_key} (tried {}; failures: {}) — set {env_key} to an \
         existing ONNX or train the experiment defaults",
        candidates
            .iter()
            .map(|c| c.path.display().to_string())
            .collect::<Vec<_>>()
            .join(" | "),
        if errors.is_empty() {
            "all absent".into()
        } else {
            errors.join("; ")
        }
    )
}

static DEBUG_FIRE_MODEL: OnceLock<anyhow::Result<Mutex<ScoreModel>>> = OnceLock::new();
static DEBUG_MOVE_MODEL: OnceLock<anyhow::Result<Mutex<ScoreModel>>> = OnceLock::new();

/// The process-global debug fire model (sticky load result, the
/// `decision_ai::shared_model` precedent — errors included: a ladder that
/// resolves to nothing stays failed for the whole process, and a model file
/// replaced under the same path is NOT re-read; both need an app restart).
fn debug_fire_model() -> anyhow::Result<&'static Mutex<ScoreModel>> {
    DEBUG_FIRE_MODEL
        .get_or_init(|| {
            load_debug_model(
                "WOWSP_DEBUG_FIRE_MODEL",
                "fire_model.onnx",
                DEBUG_FIRE_MODEL_REL,
                true,
            )
            .map(|(m, _)| Mutex::new(m))
        })
        .as_ref()
        .map_err(|e| anyhow!("{e}"))
}

/// The process-global debug movement model (same cache semantics).
pub(crate) fn debug_move_model() -> anyhow::Result<&'static Mutex<ScoreModel>> {
    DEBUG_MOVE_MODEL
        .get_or_init(|| {
            load_debug_model(
                "WOWSP_DEBUG_MOVE_MODEL",
                "move_model.onnx",
                DEBUG_MOVE_MODEL_REL,
                false,
            )
            .map(|(m, _)| Mutex::new(m))
        })
        .as_ref()
        .map_err(|e| anyhow!("{e}"))
}

// ── the in-process artifact cache (single slot) ──────────────────────────────

/// Cache identity: the replay bytes' path + the LOS directory the features
/// read + both model sources (any change rebuilds).
#[derive(Debug, Clone, PartialEq, Eq)]
struct DebugCacheKey {
    replay_path: String,
    los_dir: Option<String>,
    fire_detail: String,
    move_detail: String,
}

/// The expensive artifacts of one replay: the E17 score report (full
/// timeline) plus the per-ship row lists the movement advice snaps to, and
/// the death-time table for the alive gate.
pub(crate) struct DebugCacheEntry {
    pub(crate) scores: ShipScoreReport,
    /// The replay's recorder entity (the default static-report
    /// perspective — the only always-fully-observable ship).
    pub(crate) recorder: Option<i32>,
    /// entity id → rows sorted by `t` (team-known ships only — the E16
    /// export drops mirror-ambiguous hulls, the recorder included when its
    /// shipId collides; those ships get neither advice nor scores).
    pub(crate) rows: BTreeMap<i32, Vec<MoveDatasetRow>>,
    pub(crate) death: BTreeMap<i32, Option<f32>>,
    pub(crate) los_loaded: bool,
    pub(crate) map_name: Option<String>,
}

static DEBUG_REPORT_CACHE: OnceLock<Mutex<Option<(DebugCacheKey, DebugCacheEntry)>>> =
    OnceLock::new();

/// Run `f` against the cached full-timeline artifacts for one replay
/// (building them under the lock on first use — the same dedupe the debug
/// report enjoys). The static report shares this cache: one scoring pass
/// serves every consumer of a replay.
pub(crate) fn with_debug_cache_entry<T>(
    path: &Path,
    los_dir: Option<&Path>,
    f: impl FnOnce(&DebugCacheEntry) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let fire = debug_fire_model()?;
    let mv = debug_move_model()?;
    let (fire_detail, move_detail) = {
        let f = fire
            .lock()
            .map_err(|_| anyhow!("debug fire model mutex poisoned"))?;
        let m = mv
            .lock()
            .map_err(|_| anyhow!("debug movement model mutex poisoned"))?;
        (f.detail().to_string(), m.detail().to_string())
    };
    let key = DebugCacheKey {
        replay_path: path.to_string_lossy().into_owned(),
        los_dir: los_dir.map(|d| d.to_string_lossy().into_owned()),
        fire_detail,
        move_detail,
    };
    let cache = debug_report_cache();
    let mut guard = cache
        .lock()
        .map_err(|_| anyhow!("decision debug cache mutex poisoned"))?;
    if !guard.as_ref().is_some_and(|(k, _)| *k == key) {
        let entry = build_debug_cache_entry(path, los_dir, &key.fire_detail, &key.move_detail)?;
        *guard = Some((key, entry));
    }
    f(&guard.as_ref().expect("just populated").1)
}

fn debug_report_cache() -> &'static Mutex<Option<(DebugCacheKey, DebugCacheEntry)>> {
    DEBUG_REPORT_CACHE.get_or_init(|| Mutex::new(None))
}

/// The cold build: one movement export + one raw-stream decode + both models
/// over every row. Runs with the model guards held fire→move (the only
/// double-lock site; the advice pass locks move alone).
fn build_debug_cache_entry(
    path: &Path,
    los_dir: Option<&Path>,
    fire_detail: &str,
    move_detail: &str,
) -> anyhow::Result<DebugCacheEntry> {
    let (rows, _stats) = export_move_replay_file(
        path,
        los_dir,
        DEFAULT_EYE_HEIGHT,
        &FireSampleParams::default(),
    )
    .map_err(|e| anyhow!("movement export for {}: {e}", path.display()))?;
    let (stream, _events) =
        super::replay::decode_replay_stream_with_events(&path.to_string_lossy())
            .map_err(|e| anyhow!("decode {}: {e}", path.display()))?;
    let los_loaded = los_dir.is_some_and(|d| los_for_map(stream.map_name.as_deref(), d).is_some());
    let replay_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();
    let death: BTreeMap<i32, Option<f32>> = stream
        .trajectories
        .iter()
        .filter(|t| t.kind.as_ref().is_some_and(|k| k.entity_type == 2))
        .map(|t| (t.entity_id, t.death_time))
        .collect();
    let fire = debug_fire_model()?;
    let mv = debug_move_model()?;
    let mut fire = fire
        .lock()
        .map_err(|_| anyhow!("debug fire model mutex poisoned"))?;
    let mut mv = mv
        .lock()
        .map_err(|_| anyhow!("debug move model mutex poisoned"))?;
    let sources = ScoreModelSources {
        fire: fire_detail.to_string(),
        move_model: move_detail.to_string(),
    };
    let recorder = stream.recorder_vehicle_id;
    let scores = build_ship_scores(&stream, &rows, &replay_id, None, None, sources, |row| {
        let (entity, global, mask) = feature_tensors_v2(row);
        // E24: an attribute-routed fire model gets the routing vector from
        // the embedded table — the row carries every slot's shipId, so the
        // composition dims see exactly what training saw.
        let routing = (fire.attr_dim() > 0)
            .then(|| {
                crate::commands::ship_attrs::embedded_row_vector(
                    row.core.ship_id,
                    &row.core.friends,
                    &row.core.enemies,
                )
            })
            .transpose()?;
        // Same train-time split as `compute_ship_scores`: the fire model
        // (v2plain_std) eats the untouched row, the move model (main,
        // --ablate e11) the e11-zeroed copy (E14's distribution-parity rule).
        let (_logit_a, logit_b) =
            fire.infer_fire(&entity, &global, &mask, routing.as_ref().map(|v| &v[..]))?;
        let (mv_entity, mv_global) = ablate_e11_tensors(&entity, &global, mv.widths().0);
        let logits = mv.infer_move(&mv_entity, &mv_global, &mask)?;
        Ok((sigmoid(logit_b), softmax(&logits)))
    })?;
    // Group rows per ship, t-sorted (the exporter already emits per-ship in
    // t order; sort anyway — the advice binary-searches on it).
    let mut by_ship: BTreeMap<i32, Vec<MoveDatasetRow>> = BTreeMap::new();
    for row in rows {
        by_ship
            .entry(row.core.owner_entity_id)
            .or_default()
            .push(row);
    }
    for ship_rows in by_ship.values_mut() {
        ship_rows.sort_by(|a, b| {
            a.core
                .t
                .partial_cmp(&b.core.t)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    Ok(DebugCacheEntry {
        scores,
        recorder,
        rows: by_ship,
        death,
        los_loaded,
        map_name: stream.map_name.clone(),
    })
}

/// The movement-advice half at one instant: every alive team-known ship's
/// latest row at or before `t` within the staleness cap → one move forward.
fn movement_advice_at(
    entry: &DebugCacheEntry,
    t: f32,
    mv: &mut ScoreModel,
) -> anyhow::Result<Vec<MovementAdvice>> {
    let mut out = Vec::new();
    for (entity_id, rows) in &entry.rows {
        if entry
            .death
            .get(entity_id)
            .is_some_and(|d| d.is_some_and(|d| d <= t))
        {
            continue; // sunk at or before t
        }
        let Some(idx) = rows.partition_point(|r| r.core.t <= t).checked_sub(1) else {
            continue; // no row yet at this battle time
        };
        let row = &rows[idx];
        if t - row.core.t > MOVE_ADVICE_MAX_STALE_S {
            continue; // intel too stale (dark ship / pre-spawn gap)
        }
        let (entity, global, mask) = feature_tensors_v2(row);
        let (mv_entity, mv_global) = ablate_e11_tensors(&entity, &global, mv.widths().0);
        let logits = mv.infer_move(&mv_entity, &mv_global, &mask)?;
        out.push(movement_advice_row(
            row,
            &softmax(&logits),
            entry
                .scores
                .per_ship
                .iter()
                .any(|s| s.entity_id == *entity_id && s.is_recorder),
        ));
    }
    Ok(out)
}

/// The report builder (pure sync core — the command wraps it in
/// `spawn_blocking`, tests call it directly).
pub fn build_debug_report(
    path: &Path,
    time_sec: f32,
    los_dir: Option<&Path>,
) -> anyhow::Result<DecisionDebugReport> {
    let started = Instant::now();
    let fire = debug_fire_model()?;
    let mv = debug_move_model()?;
    let (fire_detail, move_detail) = {
        let f = fire
            .lock()
            .map_err(|_| anyhow!("debug fire model mutex poisoned"))?;
        let m = mv
            .lock()
            .map_err(|_| anyhow!("debug move model mutex poisoned"))?;
        (f.detail().to_string(), m.detail().to_string())
    };
    let key = DebugCacheKey {
        replay_path: path.to_string_lossy().into_owned(),
        los_dir: los_dir.map(|d| d.to_string_lossy().into_owned()),
        fire_detail: fire_detail.clone(),
        move_detail: move_detail.clone(),
    };
    // Single-slot cache; the build runs UNDER the cache lock so concurrent
    // callers for the same replay pay once (the lock is the dedupe).
    let cache = debug_report_cache();
    let mut guard = cache
        .lock()
        .map_err(|_| anyhow!("decision debug cache mutex poisoned"))?;
    let cached = guard.as_ref().is_some_and(|(k, _)| *k == key);
    if !cached {
        let entry = build_debug_cache_entry(path, los_dir, &fire_detail, &move_detail)?;
        *guard = Some((key, entry));
    }
    let (entry_fire_origin, entry_move_origin) = {
        // Origins: recompute cheaply from the ladder (the sticky session
        // already won; find which step its detail matches).
        let origin_of =
            |detail: &str, env_key: &str, pack_file: &str, default_rel: &str| -> String {
                debug_model_candidates(env_key, pack_file, default_rel)
                    .iter()
                    .find(|c| c.path.to_string_lossy() == detail)
                    .map(|c| c.origin.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            };
        (
            origin_of(
                &fire_detail,
                "WOWSP_DEBUG_FIRE_MODEL",
                "fire_model.onnx",
                DEBUG_FIRE_MODEL_REL,
            ),
            origin_of(
                &move_detail,
                "WOWSP_DEBUG_MOVE_MODEL",
                "move_model.onnx",
                DEBUG_MOVE_MODEL_REL,
            ),
        )
    };
    let (_, entry) = guard
        .as_ref()
        .ok_or_else(|| anyhow!("debug cache unexpectedly empty"))?;
    let movement = {
        let mut mv = mv
            .lock()
            .map_err(|_| anyhow!("debug move model mutex poisoned"))?;
        movement_advice_at(entry, time_sec, &mut mv)?
    };
    Ok(DecisionDebugReport {
        time_sec,
        map_name: entry.map_name.clone(),
        fire_model: fire_detail,
        move_model: move_detail,
        fire_model_origin: entry_fire_origin,
        move_model_origin: entry_move_origin,
        los_grid_loaded: entry.los_loaded,
        cached,
        elapsed_ms: started.elapsed().as_millis() as u64,
        movement,
        scores: entry.scores.clone(),
    })
}

/// The E18 debug surface: movement advice for one instant + the embedded
/// full-timeline E17 score report, in one call. `los_grid_dir` optionally
/// points at a directory of E4 rasters laid out as
/// `<dir>/<map short name>/terrain_los.npz` (the `decisions` pack ships
/// exactly that layout and is the default when the argument is omitted).
///
/// A cold call costs one replay export + one decode + two full model passes
/// (~4–8 s per replay); the artifacts are cached in-process, so subsequent
/// calls only re-run the per-instant movement forwards (milliseconds — see
/// the `cached` / `elapsedMs` fields). Runs on the blocking pool: the IPC
/// thread must not stall for seconds.
#[tauri::command]
pub async fn decision_debug_report(
    replay_path: String,
    time_sec: f32,
    los_grid_dir: Option<String>,
) -> CommandResult<DecisionDebugReport> {
    Ok(tokio::task::spawn_blocking(move || {
        build_debug_report(
            &std::path::PathBuf::from(replay_path),
            time_sec,
            los_grid_dir.as_deref().map(Path::new),
        )
    })
    .await
    .map_err(|e| anyhow!("decision debug report task: {e}"))??)
}

/// End-to-end fire suggestions for one replay at one instant — the tactical
/// board's flagship call: decode → tick features → per-decider model
/// inference → [`DecisionSuggestionReport`]. `los_grid_dir` optionally
/// points at a directory of E4 rasters laid out as
/// `<dir>/<map short name>/terrain_los.npz` (the `decisions` pack ships
/// exactly that layout and is the default when the argument is omitted).
#[tauri::command]
pub fn decision_fire_suggestions(
    replay_path: String,
    time_sec: f32,
    los_grid_dir: Option<String>,
) -> CommandResult<DecisionSuggestionReport> {
    let stream = super::replay::decode_replay_stream_sync(&replay_path)?;
    let vehicles = super::replay_probe::read_roster(&replay_path)?;
    // LOS rasters: explicit directory, else the decisions pack cache when
    // installed (missing dirs degrade to feature-less rows, never an error).
    let los_dir = los_grid_dir.map(std::path::PathBuf::from).or_else(|| {
        crate::paths::cache_dir()
            .ok()
            .map(|c| c.join("decisions"))
            .filter(|p| p.is_dir())
    });
    let los = los_dir
        .as_deref()
        .and_then(|d| los_for_map(stream.map_name.as_deref(), d));
    // E24 dual-model split: the advice chain prefers the attribute-routed
    // fire MoE (`advice_fire_model.onnx`, env WOWSP_DEBUG_ADVICE_FIRE_MODEL,
    // or the dev-checkout export); without it the tactical board falls back
    // to the shared scoring fire model — the slot is optional by design.
    let advice = advice_model()?;
    let mut model = match advice {
        Some(m) => m
            .lock()
            .map_err(|_| anyhow!("advice model mutex poisoned"))?,
        None => shared_model()?
            .lock()
            .map_err(|_| anyhow!("decision model mutex poisoned"))?,
    };
    Ok(build_suggestions(
        &stream,
        &vehicles,
        time_sec,
        los.as_ref(),
        DEFAULT_EYE_HEIGHT,
        &mut model,
    )?)
}

#[cfg(test)]
mod tests {
    use super::super::decision_ai::{DecisionModelSource, FIXTURE_MODEL};
    use super::super::decision_score::compute_ship_scores;
    use super::super::fire_dataset::{DecisionRowCore, export_replay_file};
    use super::*;

    fn synth_move_row(owner: i32, t: f32, own_yaw: f32) -> MoveDatasetRow {
        MoveDatasetRow {
            core: DecisionRowCore {
                replay_id: None,
                replay_version: Some("15,8,0,0".into()),
                map_name: Some("spaces/50_Gold_harbor".into()),
                owner_entity_id: owner,
                ship_id: Some(1000 + owner as i64),
                team_id: 1,
                t,
                own_speed_kt: Some(20.0),
                own_hp_frac: Some(1.0),
                own_reload_frac: 1.0,
                own_range_m: 25_000.0,
                zones_owned_0: 0,
                zones_owned_1: 0,
                zones_owned_2: 0,
                zones_owned_other: 0,
                zones_active_progress: 0,
                events_shells_30s: 0,
                events_torps_30s: 0,
                events_explosions_30s: 0,
                events_explosions_near_30s: 0,
                enemies: vec![],
                friends: vec![],
                game_mode: Some("pvp".into()),
                feature_version: 2,
                own_damcon_frac: -1.0,
                own_repair_frac: -1.0,
                own_other_consumable_frac: -1.0,
                own_engine_power: -1.0,
                own_engine_dir: 0.0,
                own_in_smoke: false,
                active_smoke_count_frac: 0.0,
                active_smoke_area_feat: 0.0,
                vision_cap_frac: 1.0,
                weather_incoming_frac: 0.0,
                ally_radar_count_frac: -1.0,
                ally_hydro_count_frac: -1.0,
                e11_events_known: false,
            },
            own_yaw_rad: own_yaw,
            moved_dist_m: 150.0,
            move_bearing_rad: 0.0,
            move_sector: 3,
        }
    }

    /// Top-2 extraction + bearing reconstruction: clear winner, tie handling,
    /// the no-move null bearing and the absolute-angle wrap.
    #[test]
    fn movement_advice_row_top2_and_bearing() {
        let mut probs = [0.01f32; MOVE_SECTOR_COUNT];
        probs[3] = 0.6;
        probs[9] = 0.23;
        let adv = movement_advice_row(&synth_move_row(9, 300.0, 1.0), &probs, true);
        assert_eq!(adv.entity_id, 9);
        assert!(adv.is_recorder);
        assert_eq!(adv.top_sector, 3);
        assert!((adv.top_prob - 0.6).abs() < 1e-6);
        assert_eq!(adv.second_sector, 9);
        assert!((adv.second_prob - 0.23).abs() < 1e-6);
        // Absolute bearing = own yaw + sector × 22.5°, wrapped to [-pi, pi].
        let want = 1.0f32 + 3.0 * MOVE_SECTOR_RAD;
        let got = adv.map_bearing_rad.expect("directional bearing");
        assert!((got - want).abs() < 1e-6, "{got} vs {want}");

        // A yaw near the wrap seam stays in [-pi, pi].
        let adv = movement_advice_row(&synth_move_row(9, 300.0, 3.0), &probs, false);
        let got = adv.map_bearing_rad.expect("directional bearing");
        assert!(got.abs() <= std::f32::consts::PI + 1e-5, "{got}");
        assert!((got - (3.0f32 + 3.0 * MOVE_SECTOR_RAD - std::f32::consts::TAU)).abs() < 1e-6);

        // No-move top class: no bearing to draw.
        let mut nm = [0.05f32; MOVE_SECTOR_COUNT];
        nm[MOVE_SECTOR_NONE as usize] = 0.2;
        let adv = movement_advice_row(&synth_move_row(7, 300.0, 0.5), &nm, false);
        assert_eq!(adv.top_sector, MOVE_SECTOR_NONE);
        assert!(adv.map_bearing_rad.is_none());
        assert_ne!(adv.second_sector, adv.top_sector);

        // Uniform distribution: top is index 0 (first on ties) and second
        // NEVER equals top.
        let uni = [1.0f32 / MOVE_SECTOR_COUNT as f32; MOVE_SECTOR_COUNT];
        let adv = movement_advice_row(&synth_move_row(7, 300.0, 0.0), &uni, false);
        assert_eq!(adv.top_sector, 0);
        assert_ne!(adv.second_sector, 0);
        assert!((adv.second_prob - adv.top_prob).abs() < 1e-6);

        // Regression (review P1): argmax AT index 0 must report the true
        // runner-up, not (top+1)%17 — the old in-loop track could never beat
        // probs[second] == probs[top] == max.
        let mut z = [0.01f32; MOVE_SECTOR_COUNT];
        z[0] = 0.5;
        z[2] = 0.3;
        z[1] = 0.2;
        let adv = movement_advice_row(&synth_move_row(7, 300.0, 0.0), &z, false);
        assert_eq!(adv.top_sector, 0);
        assert_eq!(
            adv.second_sector, 2,
            "runner-up must be the true second argmax"
        );
        assert!((adv.second_prob - 0.3).abs() < 1e-6);
    }

    /// E18 against real replay bytes — run with
    /// `WOWSP_TEST_REPLAY=<path> [WOWSP_TEST_LOS_DIR=<dir>]
    /// [WOWSP_DEBUG_FIRE_MODEL=<onnx>] [WOWSP_DEBUG_MOVE_MODEL=<onnx>]
    /// cargo test -p wowsp_tauri e18_debug -- --nocapture`. Asserts the wire
    /// shape (probDist sums to 1, bearings finite, staleness honored), the
    /// score-timeline parity with the E17 export over the same models, and
    /// the in-process cache. Skips when the env vars or the debug models are
    /// absent.
    #[test]
    fn e18_debug_report_on_real_replay() {
        let Ok(path) = std::env::var("WOWSP_TEST_REPLAY") else {
            eprintln!("[e18] WOWSP_TEST_REPLAY not set - skipping");
            return;
        };
        if let Err(e) = debug_fire_model().and_then(|_| debug_move_model()) {
            eprintln!("[e18] debug models unavailable ({e}) - skipping");
            return;
        }
        let los_dir = match std::env::var("WOWSP_TEST_LOS_DIR") {
            Ok(p) => Some(std::path::PathBuf::from(p)),
            Err(_) => {
                let default = experiments_out();
                default.is_dir().then_some(default)
            },
        };
        let t = 300.0f32;
        let report =
            build_debug_report(Path::new(&path), t, los_dir.as_deref()).expect("debug report");
        assert_eq!(report.time_sec, t);
        assert!(!report.cached, "first call in this process is cold");
        // ── movement advice shape ──
        assert!(!report.movement.is_empty(), "no movement advice at t=300");
        for adv in &report.movement {
            assert_eq!(adv.prob_dist.len(), MOVE_SECTOR_COUNT);
            let sum: f32 = adv.prob_dist.iter().sum();
            assert!((sum - 1.0).abs() < 1e-4, "probDist sum {sum}");
            assert!((0.0..=1.0).contains(&adv.top_prob), "{}", adv.top_prob);
            assert!((0.0..=1.0).contains(&adv.second_prob));
            assert!(adv.top_prob >= adv.second_prob);
            assert_eq!(adv.top_prob, adv.prob_dist[adv.top_sector as usize]);
            assert_eq!(adv.second_prob, adv.prob_dist[adv.second_sector as usize]);
            assert_ne!(adv.top_sector, adv.second_sector);
            match adv.map_bearing_rad {
                Some(b) => {
                    assert_ne!(adv.top_sector, MOVE_SECTOR_NONE);
                    assert!(b.is_finite() && b.abs() <= std::f32::consts::PI, "{b}");
                },
                None => assert_eq!(adv.top_sector, MOVE_SECTOR_NONE),
            }
            assert!(
                adv.row_t <= t && t - adv.row_t <= MOVE_ADVICE_MAX_STALE_S + 1e-4,
                "row {} vs t {t}",
                adv.row_t
            );
            // Every advised ship must also be in the embedded score timeline
            // (the same row set feeds both).
            assert!(
                report
                    .scores
                    .per_ship
                    .iter()
                    .any(|s| s.entity_id == adv.entity_id),
                "advised ship {} missing from scores",
                adv.entity_id
            );
        }
        // The recorder carries advice at t=300 WHENEVER it has score rows at
        // all — mirror-ambiguous hulls are excluded by the E16 export on
        // some replays (the recorder included when its shipId collides).
        match report.scores.per_ship.iter().find(|s| s.is_recorder) {
            Some(rec) => assert!(
                report.movement.iter().any(|a| a.entity_id == rec.entity_id),
                "recorder {} scored but carries no advice at t={}",
                rec.entity_id,
                t
            ),
            None => eprintln!(
                "[e18] recorder has no score rows (mirror-ambiguous hull) - recorder assert skipped"
            ),
        }
        // Ordered by entity id, teams sane.
        let ids: Vec<i32> = report.movement.iter().map(|a| a.entity_id).collect();
        assert!(ids.windows(2).all(|w| w[0] < w[1]), "advice ordered");
        assert!(
            report
                .movement
                .iter()
                .all(|a| a.team_id == 0 || a.team_id == 1)
        );
        // ── score timeline shape ──
        assert!(!report.scores.per_ship.is_empty());
        assert!(report.scores.stats.rows_scored > 0);
        for s in &report.scores.per_ship {
            assert!((0.0..=1.0).contains(&s.whole_game));
            assert!((0.0..=1.0).contains(&s.whole_move));
            if let Some(f) = s.whole_fire {
                assert!((0.0..=1.0).contains(&f));
            }
            assert!(!s.samples.is_empty());
        }
        // ── parity with the E17 export (same replay, same model files) ──
        let e17 = compute_ship_scores(Path::new(&path), None, None, los_dir.as_deref());
        match e17 {
            Ok(e17)
                if e17.model_sources.fire == report.fire_model
                    && e17.model_sources.move_model == report.move_model =>
            {
                assert_eq!(e17.per_ship.len(), report.scores.per_ship.len());
                for theirs in e17.per_ship.iter().take(3) {
                    let mine = report
                        .scores
                        .per_ship
                        .iter()
                        .find(|s| s.entity_id == theirs.entity_id)
                        .expect("same ship set");
                    assert_eq!(mine.whole_game, theirs.whole_game, "wholeGame parity");
                    assert_eq!(mine.whole_fire, theirs.whole_fire);
                    assert_eq!(mine.whole_move, theirs.whole_move);
                    assert_eq!(mine.samples.len(), theirs.samples.len());
                    assert_eq!(
                        mine.samples.first().map(|s| s.t),
                        theirs.samples.first().map(|s| s.t)
                    );
                }
                eprintln!(
                    "[e18] score parity with compute_ship_scores: {} ships identical",
                    e17.per_ship.len()
                );
            },
            Ok(e17) => eprintln!(
                "[e18] score parity skipped (debug ladder differs: {} vs {} / {} vs {})",
                report.fire_model,
                e17.model_sources.fire,
                report.move_model,
                e17.model_sources.move_model
            ),
            Err(e) => eprintln!("[e18] compute_ship_scores unavailable ({e}) - parity skipped"),
        }
        // ── cache: second call hits, costs only the movement forwards ──
        let again = build_debug_report(Path::new(&path), t + 1.0, los_dir.as_deref())
            .expect("cached debug report");
        assert!(again.cached, "second call must hit the cache");
        assert!(
            again.elapsed_ms < 2_000,
            "cached call took {}ms",
            again.elapsed_ms
        );
        eprintln!(
            "[e18] cache hit: elapsed={}ms for {} movement rows",
            again.elapsed_ms,
            again.movement.len()
        );
        // ── report excerpt ──
        eprintln!(
            "[e18] t={} map={:?} fire={} ({}) move={} ({}) LOS={} cold={}ms movement={} ships scores={} ships/{} rows",
            t,
            report.map_name,
            report.fire_model,
            report.fire_model_origin,
            report.move_model,
            report.move_model_origin,
            report.los_grid_loaded,
            report.elapsed_ms,
            report.movement.len(),
            report.scores.per_ship.len(),
            report.scores.stats.rows_scored
        );
        for adv in report.movement.iter().take(6) {
            eprintln!(
                "[e18]   ship {} (team {}, recorder {}) top sector {} p={:.3} second {} p={:.3} bearing {:?}",
                adv.entity_id,
                adv.team_id,
                adv.is_recorder,
                adv.top_sector,
                adv.top_prob,
                adv.second_sector,
                adv.second_prob,
                adv.map_bearing_rad
            );
        }
        for s in report.scores.per_ship.iter().take(3) {
            eprintln!(
                "[e18]   score ship {} whole={:.3} fire={:?} move={:.3} samples={}",
                s.entity_id,
                s.whole_game,
                s.whole_fire,
                s.whole_move,
                s.samples.len()
            );
        }
        let js = serde_json::to_value(&report).expect("serialize report");
        assert!(js.get("probDist").is_none() && js.get("movement").is_some());
        assert!(js.get("cached").is_some() && js.get("elapsedMs").is_some());
        assert!(js.get("scores").is_some());
        assert!(js["movement"][0].get("mapBearingRad").is_some());
        assert!(js["movement"][0].get("rowT").is_some());
    }

    // ── synthetic stream helpers (fire_dataset test pattern) ──────────────

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
            max_health: None,
            radius: None,
            control_point_index: None,
            initial_team: None,
            team_id: None,
        })
    }

    fn trajectory(
        eid: i32,
        ship_id: Option<i64>,
        samples: Vec<PositionSample>,
    ) -> EntityTrajectory {
        EntityTrajectory {
            entity_id: eid,
            kind: kind(2, ship_id),
            samples,
            death_time: None,
            hp_samples: Vec::new(),
            cap_samples: Vec::new(),
            cap_progress: Vec::new(),
            cruise_samples: Vec::new(),
        }
    }

    fn shell(
        time: f32,
        owner: i32,
        salvo: i32,
        barrel: u16,
        muzzle: (f32, f32),
        target: (f32, f32),
    ) -> ShellLaunchEvent {
        ShellLaunchEvent {
            time,
            owner_id: owner,
            params_id: 0,
            salvo_id: salvo,
            shot_id: 0,
            x: muzzle.0,
            y: 2.0,
            z: muzzle.1,
            target_x: target.0,
            target_y: 0.0,
            target_z: target.1,
            server_time_left: 20.0,
            speed: 800.0,
            gun_barrel_id: barrel,
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

    fn minimal_stream() -> ReplayStream {
        ReplayStream {
            ally_builds: Vec::new(),
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
            chat_messages: Vec::new(),
            achievements: Vec::new(),
            arena_players: Vec::new(),
            weather_transitions: Vec::new(),
            weather_notifications: Vec::new(),
            self_team: None,
        }
    }

    /// A 1v1-ish synthetic battle: enemy gun ship 9 (fires 4-shell main
    /// salvos at t=100 and t=124), recorder-side target 8, and a recorder-11
    /// never-fired ally. Reused by the serve tests.
    fn synthetic_stream() -> (ReplayStream, Vec<VehicleEntry>) {
        let mk = |eid: i32, x: f32, sid: i64| {
            trajectory(
                eid,
                Some(sid),
                (0..400)
                    .map(|i| sample(i as f32 * 0.5, eid, x, 0.0))
                    .collect(),
            )
        };
        let mut shells = Vec::new();
        for k in 0..2u32 {
            for b in 0..4u16 {
                shells.push(shell(
                    100.0 + k as f32 * 24.0,
                    9,
                    k as i32,
                    b,
                    (10.0, 0.5),
                    (50.0, 0.0),
                ));
            }
        }
        let stream = ReplayStream {
            ally_builds: Vec::new(),
            trajectories: vec![mk(9, 10.0, 222), mk(8, 50.0, 111), mk(7, 0.0, 110)],
            recorder_vehicle_id: Some(8),
            shell_launches: shells,
            map_name: Some("spaces/50_Gold_harbor".into()),
            ..minimal_stream()
        };
        let vehicles = vec![
            roster_entry(1, 0, 111),
            roster_entry(2, 2, 222),
            roster_entry(3, 0, 110),
        ];
        (stream, vehicles)
    }

    /// The featurizer mirrors the training script's fixed scales: every
    /// value hand-computed from the documented layout.
    #[test]
    fn featurizer_matches_the_documented_scales() {
        let slot = FireDatasetSlot {
            entity_id: 9,
            entity_type: 2,
            ship_id: Some(222),
            dist_m: 15_000.0,
            bearing_rel_rad: std::f32::consts::FRAC_PI_2,
            speed_kt: Some(20.0),
            hp_frac: Some(0.5),
            obs_age_s: 90.0,
            observed_now: false,
            terrain_blocked: Some(true),
            // v2 fields: sentinels, v1 featurizer ignores them.
            spotted_now: None,
            inside_smoke: false,
            radar_lit: false,
            is_enemy: true,
            engine_power_frac: None,
        };
        let f = featurize_slot(&slot);
        let expected = [
            1.5,      // 15000/10000 (below the 2.0 clamp)
            1.0,      // sin(pi/2)
            6.12e-17, // cos(pi/2) in f32
            0.5,      // 20/40
            0.5,      // hp
            1.0,      // min(90/60, 1.0)
            0.0,      // not observed
            1.0,      // terrain blocked
            1.0,      // entity type 2
            1.0,      // speed known
        ];
        for (i, (got, want)) in f.iter().zip(expected.iter()).enumerate() {
            assert!(
                (got - want).abs() < 1e-6,
                "slot feature {i}: {got} vs {want}"
            );
        }
        // Unknown-option sentinels: -1 for speed/hp/terrain, speed flag 0.
        let unknown = FireDatasetSlot {
            speed_kt: None,
            hp_frac: None,
            terrain_blocked: None,
            ..slot
        };
        let f = featurize_slot(&unknown);
        assert_eq!(f[3], -1.0);
        assert_eq!(f[4], -1.0);
        assert_eq!(f[7], -1.0);
        assert_eq!(f[9], 0.0);
        // Globals: log1p scaling and the fixed scales.
        let g = DecisionGlobals {
            t: 600.0,
            own_speed_kt: Some(30.0),
            own_hp_frac: Some(0.75),
            own_reload_frac: 0.5,
            own_range_m: 15_000.0,
            zones_owned_0: 2,
            zones_owned_1: 3,
            zones_owned_2: 0,
            zones_owned_other: 1,
            zones_active_progress: 4,
            events_shells_30s: 138,
            events_torps_30s: 0,
            events_explosions_30s: 7,
            events_explosions_near_30s: 0,
        };
        let gf = featurize_globals(&g);
        assert!((gf[0] - 0.5).abs() < 1e-6); // 600/1200
        assert!((gf[1] - 0.75).abs() < 1e-6); // 30/40
        assert!((gf[3] - 0.5).abs() < 1e-6);
        assert!((gf[4] - 0.5).abs() < 1e-6); // 15000/30000
        assert!((gf[9] - 0.4).abs() < 1e-6); // 4/10
        // log1p(138)/8 ≈ 0.609 (the training script's worked example);
        // log1p(0)/8 is exactly 0.0.
        assert!((gf[10] - (139.0f32).ln() / 8.0).abs() < 1e-6);
        assert_eq!(gf[11], 0.0);
    }

    /// Fixture-path serving on the synthetic battle: gun ship 9 (fire
    /// history) + recorder 8 (no history, still gets its row); the never-
    /// fired ally 7 is excluded. Report shape, camelCase JSON and the E7
    /// hard rule all line up.
    #[test]
    fn synthetic_serve_fixture_path_report() {
        let (stream, vehicles) = synthetic_stream();
        let mut model = DecisionModel::from_bytes(
            DecisionModelSource::Fixture,
            "fixture under test",
            FIXTURE_MODEL,
        )
        .expect("fixture model");
        let report = build_suggestions(
            &stream,
            &vehicles,
            150.0,
            None,
            DEFAULT_EYE_HEIGHT,
            &mut model,
        )
        .expect("suggestions");
        assert_eq!(report.time_sec, 150.0);
        assert_eq!(report.model_source, "fixture");
        assert_eq!(report.model_kind, "fixture8");
        assert!(!report.los_grid_loaded);
        assert_eq!(report.map_name.as_deref(), Some("spaces/50_Gold_harbor"));
        // Deciders: 9 (fire history) + 8 (recorder, no history); 7 excluded.
        let ids: Vec<i32> = report.suggestions.iter().map(|s| s.entity_id).collect();
        assert_eq!(ids, vec![8, 9], "ordered by entity id");
        let s8 = &report.suggestions[0];
        assert!(s8.is_recorder);
        assert_eq!(s8.team_id, Some(0));
        let s9 = &report.suggestions[1];
        assert_eq!(s9.team_id, Some(1));
        assert!(!s9.is_recorder);
        // 9's target at t=150 is recorder-side ships 8/7 — nearest first;
        // the E7 range from the ~40-unit aim distance × 1.15 covers both.
        assert_eq!(s9.target_entity_id, Some(7));
        let want_dist = 10.0f32.hypot(0.0) * METERS_PER_UNIT; // 9 at (10,0), 7 at (0,0)
        assert!((s9.target_distance_m.unwrap() - want_dist).abs() < 1.0);
        // t=150 is 26 s after the last salvo (t=124) with a ~24 s reload →
        // reloaded + target in range → the hard rule fires on the fixture
        // path's head A.
        assert!(s9.can_fire_logit > 0.0, "{}", s9.can_fire_logit);
        for s in &report.suggestions {
            assert!((0.0..=1.0).contains(&s.fire_prob));
            assert!(s.fire_logit.is_finite());
        }
        // The recorder's head A: never fired → always reloaded; enemies 9
        // observed continuously at 40 units (234 m ≪ 25 km fallback) → fires.
        assert!(s8.can_fire_logit > 0.0);
        // camelCase wire shape.
        let js = serde_json::to_value(&report).expect("serialize report");
        assert!(js.get("modelSource").is_some());
        assert!(js.get("losGridLoaded").is_some());
        let row = &js["suggestions"][0];
        assert!(row.get("fireProb").is_some(), "per-row fireProb");
        assert!(row.get("fireLogit").is_some());
        assert!(row.get("canFireLogit").is_some());
        assert!(row.get("targetEntityId").is_some());
        assert!(row.get("targetDistanceM").is_some());
        assert!(row.get("isRecorder").is_some());
        assert!(row.get("shipId").is_some());
    }

    /// The feature tensors of a synthetic decision point: slot order
    /// (enemies then friends), mask coverage, padding zeros.
    #[test]
    fn synthetic_feature_tensors_layout() {
        let (stream, vehicles) = synthetic_stream();
        let state = ServeState::build(&stream, &vehicles, FireSampleParams::default());
        let ship9 = state
            .ships
            .iter()
            .find(|s| s.traj.entity_id == 9)
            .expect("ship 9");
        let point = state
            .decision_point(ship9, 150.0, None, DEFAULT_EYE_HEIGHT, None)
            .expect("decision point");
        // 9 (team 1) sees enemies {7, 8} (team 0) and no friends.
        assert_eq!(point.enemies.len(), 2);
        assert!(point.friends.is_empty());
        let (entity, global, mask) = feature_tensors(&point);
        assert_eq!(entity.len(), SLOTS * ENTITY_DIM);
        assert_eq!(global.len(), GLOBAL_DIM);
        assert_eq!(mask.len(), SLOTS);
        assert_eq!(&mask[..2], &[1.0, 1.0]);
        assert!(mask[2..].iter().all(|&m| m == 0.0));
        // Padding slots are zero rows.
        assert!(entity[2 * ENTITY_DIM..].iter().all(|&v| v == 0.0));
        // First slot = entity 7 (nearest): distance 10 units in metres.
        assert!(
            (entity[0] - 10.0 * METERS_PER_UNIT / DIST_SCALE_M).abs() < 1e-5,
            "{}",
            entity[0]
        );
    }

    /// G4 end-to-end against the real reference replay at t=300 — run with
    /// `WOWSP_TEST_REPLAY=<path> [WOWSP_TEST_MODEL=<onnx>] [WOWSP_TEST_LOS_DIR=<dir>]
    /// cargo test -p wowsp_tauri g4_serve -- --nocapture`. Uses the trained
    /// E9 fire model when available (else the fixture path); asserts the
    /// decider-set criterion independently and prints a JSON excerpt.
    #[test]
    fn g4_serve_on_real_replay() {
        let Ok(path) = std::env::var("WOWSP_TEST_REPLAY") else {
            eprintln!("[g4-serve] WOWSP_TEST_REPLAY not set - skipping");
            return;
        };
        let t = 300.0f32;
        let stream = super::super::replay::decode_replay_stream_sync(&path).expect("decode replay");
        let vehicles = super::super::replay_probe::read_roster(&path).expect("roster");
        let params = FireSampleParams::default();
        // LOS rasters default to the experiments output layout.
        let los_dir = match std::env::var("WOWSP_TEST_LOS_DIR") {
            Ok(p) => Some(std::path::PathBuf::from(p)),
            Err(_) => {
                let default = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../scripts/experiments/out");
                default.exists().then_some(default)
            },
        };
        let los = los_dir
            .as_deref()
            .and_then(|d| los_for_map(stream.map_name.as_deref(), d));
        // Model: the trained fire model when present, else the fixture.
        let model_path = std::env::var("WOWSP_TEST_MODEL")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../scripts/experiments/out/fire_model/fp32.onnx")
            });
        let (mut model, model_note) = match std::fs::read(&model_path) {
            Ok(bytes) => (
                DecisionModel::from_bytes(
                    DecisionModelSource::Pack,
                    model_path.to_string_lossy().into_owned(),
                    &bytes,
                )
                .expect("load fire model"),
                format!("fire model {}", model_path.display()),
            ),
            Err(_) => (
                DecisionModel::from_bytes(
                    DecisionModelSource::Fixture,
                    "embedded fixture (E1)",
                    FIXTURE_MODEL,
                )
                .expect("fixture model"),
                "E1 fixture (no trained model found)".to_string(),
            ),
        };
        let report = build_suggestions(
            &stream,
            &vehicles,
            t,
            los.as_ref(),
            DEFAULT_EYE_HEIGHT,
            &mut model,
        )
        .expect("suggestions");
        // ── decider set, recomputed independently of build_suggestions ──
        let state = ServeState::build(&stream, &vehicles, params);
        let mut expected: Vec<i32> = state
            .ships
            .iter()
            .filter(|s| {
                s.team_id.is_some()
                    && !s.team_ambiguous
                    && s.traj.death_time.is_none_or(|d| d > t)
                    && state
                        .contexts
                        .get(&s.traj.entity_id)
                        .is_some_and(|c| c.has_fire_history)
                    && last_sample_before(&s.traj.samples, t).is_some()
            })
            .map(|s| s.traj.entity_id)
            .collect();
        if let Some(rec) = state
            .ships
            .iter()
            .find(|s| s.is_recorder && s.traj.death_time.is_none_or(|d| d > t))
        {
            if !expected.contains(&rec.traj.entity_id) {
                expected.push(rec.traj.entity_id);
            }
        }
        expected.sort_unstable();
        let got: Vec<i32> = report.suggestions.iter().map(|s| s.entity_id).collect();
        assert_eq!(
            got, expected,
            "decider set must match the weak-supervision criterion"
        );
        eprintln!(
            "[g4-serve] t={} map={:?} model={} ({}), LOS grid {} -> {} suggestions",
            t,
            report.map_name,
            report.model_kind,
            model_note,
            if report.los_grid_loaded {
                "loaded"
            } else {
                "absent"
            },
            report.suggestions.len()
        );
        for s in &report.suggestions {
            assert!((0.0..=1.0).contains(&s.fire_prob), "{}", s.fire_prob);
            assert!(s.fire_logit.is_finite());
            assert!(s.can_fire_logit.is_finite());
            if let Some(d) = s.target_distance_m {
                assert!(d > 0.0 && d < 60_000.0, "target distance {d}");
            }
        }
        let with_target = report
            .suggestions
            .iter()
            .filter(|s| s.target_entity_id.is_some())
            .count();
        assert!(
            with_target >= 1,
            "at t=300 at least one decider must have a target"
        );
        eprintln!(
            "[g4-serve] deciders with a target: {with_target}/{}",
            report.suggestions.len()
        );
        // JSON excerpt for the report: recorder + two gun-ship rows.
        let mut excerpt = serde_json::json!({
            "timeSec": report.time_sec,
            "mapName": report.map_name,
            "modelSource": report.model_source,
            "modelKind": report.model_kind,
            "losGridLoaded": report.los_grid_loaded,
            "suggestionCount": report.suggestions.len(),
        });
        let rows: Vec<&DecisionSuggestion> = report
            .suggestions
            .iter()
            .filter(|s| s.is_recorder || s.target_entity_id.is_some())
            .take(3)
            .collect();
        excerpt["suggestions"] = serde_json::to_value(&rows).expect("serialize rows");
        eprintln!(
            "g4-serve excerpt:\n{}",
            serde_json::to_string_pretty(&excerpt).expect("pretty")
        );
    }

    /// Feature-parity gate: for the same (decider, t) the slots and globals
    /// built here are EXACTLY the exported E9 row's — run with
    /// `WOWSP_TEST_REPLAY=<path> [WOWSP_TEST_LOS_DIR=<dir>] cargo test -p
    /// wowsp_tauri feature_parity -- --nocapture`. Compares the row nearest
    /// t=300 plus one deep-censoring row (right after a salvo).
    #[test]
    fn feature_parity_with_fire_dataset_export() {
        let Ok(path) = std::env::var("WOWSP_TEST_REPLAY") else {
            eprintln!("[parity] WOWSP_TEST_REPLAY not set - skipping");
            return;
        };
        let los_dir = match std::env::var("WOWSP_TEST_LOS_DIR") {
            Ok(p) => Some(std::path::PathBuf::from(p)),
            Err(_) => {
                let default = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../scripts/experiments/out");
                default.exists().then_some(default)
            },
        };
        let params = FireSampleParams::default();
        let (rows, _stats) = export_replay_file(
            std::path::Path::new(&path),
            los_dir.as_deref(),
            DEFAULT_EYE_HEIGHT,
            &params,
        )
        .expect("export dataset");
        assert!(!rows.is_empty(), "export produced no rows");
        let stream = super::super::replay::decode_replay_stream_sync(&path).expect("decode replay");
        let vehicles = super::super::replay_probe::read_roster(&path).expect("roster");
        let los = los_dir
            .as_deref()
            .and_then(|d| los_for_map(stream.map_name.as_deref(), d));
        let state = ServeState::build(&stream, &vehicles, params);
        // The row nearest t=300 and, when present, the first censored row of
        // the same owner after a salvo (reload_frac deep inside (0,1)).
        let near_300 = rows
            .iter()
            .min_by(|a, b| {
                (a.t - 300.0)
                    .abs()
                    .partial_cmp(&(b.t - 300.0).abs())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .expect("a row near t=300");
        let censored = rows.iter().find(|r| {
            r.owner_entity_id == near_300.owner_entity_id
                && (0.05..0.95).contains(&r.own_reload_frac)
        });
        for row in std::iter::once(near_300).chain(censored) {
            let ship = state
                .ships
                .iter()
                .find(|s| s.traj.entity_id == row.owner_entity_id)
                .expect("decider ship");
            let point = state
                .decision_point(ship, row.t, los.as_ref(), DEFAULT_EYE_HEIGHT, None)
                .expect("decision point at the exported (owner, t)");
            // Slots: same length, every field exactly equal.
            assert_eq!(
                point.enemies.len(),
                row.enemies.len(),
                "enemy slot count at t={}",
                row.t
            );
            assert_eq!(
                point.friends.len(),
                row.friends.len(),
                "friend slot count at t={}",
                row.t
            );
            for (mine, theirs) in point.enemies.iter().zip(row.enemies.iter()) {
                assert_eq!(
                    mine.entity_id, theirs.entity_id,
                    "enemy order at t={}",
                    row.t
                );
                assert_eq!(mine.entity_type, theirs.entity_type);
                assert_eq!(mine.ship_id, theirs.ship_id);
                assert_eq!(mine.dist_m, theirs.dist_m, "dist_m");
                assert_eq!(mine.bearing_rel_rad, theirs.bearing_rel_rad, "bearing");
                assert_eq!(mine.speed_kt, theirs.speed_kt, "speed");
                assert_eq!(mine.hp_frac, theirs.hp_frac, "hp");
                assert_eq!(mine.obs_age_s, theirs.obs_age_s, "age");
                assert_eq!(mine.observed_now, theirs.observed_now);
                assert_eq!(mine.terrain_blocked, theirs.terrain_blocked, "terrain");
            }
            for (mine, theirs) in point.friends.iter().zip(row.friends.iter()) {
                assert_eq!(mine.entity_id, theirs.entity_id, "friend order");
                assert_eq!(mine.dist_m, theirs.dist_m);
                assert_eq!(mine.observed_now, theirs.observed_now);
            }
            // Globals: field-for-field.
            let g = &point.globals;
            assert_eq!(g.own_speed_kt, row.own_speed_kt, "own speed");
            assert_eq!(g.own_hp_frac, row.own_hp_frac, "own hp");
            assert_eq!(g.own_reload_frac, row.own_reload_frac, "reload frac");
            assert_eq!(g.own_range_m, row.own_range_m, "range");
            assert_eq!(g.zones_owned_0, row.zones_owned_0);
            assert_eq!(g.zones_owned_1, row.zones_owned_1);
            assert_eq!(g.zones_owned_2, row.zones_owned_2);
            assert_eq!(g.zones_owned_other, row.zones_owned_other);
            assert_eq!(g.zones_active_progress, row.zones_active_progress);
            assert_eq!(g.events_shells_30s, row.events_shells_30s);
            assert_eq!(g.events_torps_30s, row.events_torps_30s);
            assert_eq!(g.events_explosions_30s, row.events_explosions_30s);
            assert_eq!(g.events_explosions_near_30s, row.events_explosions_near_30s);
            // The E7 hard rule must equal the exported labelA.
            assert_eq!(
                point.can_fire_rule, row.label_a_can_fire,
                "labelA parity at t={}",
                row.t
            );
            // And the featurized globals are finite.
            assert!(featurize_globals(g).iter().all(|v| v.is_finite()));
        }
        eprintln!(
            "[parity] slots + globals + labelA identical to the E9 export (row t={:.1}, owner {}; censored row checked: {})",
            near_300.t,
            near_300.owner_entity_id,
            censored.is_some()
        );
    }
}
