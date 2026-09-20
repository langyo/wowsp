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

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;
use wowsp_tauri_shared::{
    EntityTrajectory, PositionSample, ReplayStream, ShellLaunchEvent, VehicleEntry,
};

use super::decision_ai::{DecisionModel, DecisionModelKind, shared_model};
use super::decision_tick::{DEFAULT_EYE_HEIGHT, KT_MS, METERS_PER_UNIT};
use super::fire_dataset::{ENEMY_SLOTS, FRIEND_SLOTS, FireDatasetSlot, FireSampleParams};
use super::replay_probe::{GAP_THRESHOLD, battle_results_conflicts, resolve_team, roster_sides};
use super::terrain_los::{LosGrid, los_blocked};

// ── DTOs (webui contract; camelCase over IPC) ───────────────────────────────

/// One ship's fire-decision suggestion at one instant.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionSuggestion {
    pub entity_id: i32,
    pub ship_id: Option<i64>,
    /// Recorder-relative team: 0 = recorder's side, 1 = enemy. `null` when
    /// the shipId could not be attributed (mirror lineups) — only possible
    /// on the recorder row, deciders require a known team.
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
    ship: &ShipRow<'_>,
    ships: &[ShipRow<'_>],
    own: &PositionSample,
    t: f32,
    range_m: f32,
) -> Option<EnemySighting> {
    let mut best: Option<EnemySighting> = None;
    for other in ships {
        if other.traj.entity_id == ship.traj.entity_id
            || other.team_id.is_none()
            || other.team_ambiguous
            || other.team_id == ship.team_id
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
        let target = nearest_enemy(ship, &self.ships, own, t, ctx.range_m);
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
        DecisionModelKind::Fire24 { .. } => "fire24",
        DecisionModelKind::Fixture8 => "fixture8",
    }
}

/// Run the model over one decision point → one suggestion row.
fn infer_one(
    model: &mut DecisionModel,
    point: &DecisionPoint,
) -> Result<DecisionSuggestion, String> {
    let (can_fire_logit, fire_logit) = match model.kind() {
        DecisionModelKind::Fire24 { .. } => {
            let (entity, global, mask) = feature_tensors(point);
            model.infer_fire(&entity, &global, &mask)?
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
) -> Result<DecisionSuggestionReport, String> {
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
) -> Result<DecisionSuggestionReport, String> {
    let stream = super::replay::read_replay_positions(replay_path.clone())?;
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
    let shared = shared_model()?;
    let mut model = shared
        .lock()
        .map_err(|_| "decision model mutex poisoned".to_string())?;
    build_suggestions(
        &stream,
        &vehicles,
        time_sec,
        los.as_ref(),
        DEFAULT_EYE_HEIGHT,
        &mut model,
    )
}

#[cfg(test)]
mod tests {
    use super::super::decision_ai::{DecisionModelSource, FIXTURE_MODEL};
    use super::super::fire_dataset::export_replay_file;
    use super::*;

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
            radius: None,
            control_point_index: None,
            initial_team: None,
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
        let stream =
            super::super::replay::read_replay_positions(path.clone()).expect("decode replay");
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
        let stream =
            super::super::replay::read_replay_positions(path.clone()).expect("decode replay");
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
