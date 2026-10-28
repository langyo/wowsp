//! Fire-decision supervision sample construction (experiment E7).
//!
//! Question: with the decoding capability already in the tree (E2–E6), can a
//! real replay yield `(state, label)` supervision samples for a FIRE-decision
//! behaviour-cloning classifier, and at what scale? This module answers it
//! with pure analysis functions over [`ReplayStream`] — no Tauri commands,
//! no DTO changes (experiment-only surface, driven by env-gated tests).
//!
//! # What is analysed
//!
//! 1. **Attribution (Q1)** — [`attribute_shell_owners`]: every
//!    `receiveArtilleryShots` shell carries an explicit `ownerID` (the firing
//!    vehicle's entity id). The attribution is validated geometrically: the
//!    muzzle point must sit within a ship length (plus the drift of a stale
//!    position sample) of the owner's last-known position at the fire time,
//!    and the owner should be the NEAREST ship to the muzzle. Reported as
//!    distributions, not assumed.
//! 2. **Salvo / reload structure (Q2)** — [`analyze_salvo_structure`]: shells
//!    group into fire events per battery class by time contiguity (`salvoID`
//!    turns out to be pack-level, not click-level); inter-event interval
//!    distributions imply each ship's reload period; the share of each ship's
//!    alive window spent inside a post-salvo reload interval quantifies the
//!    CENSORING region that must be excluded from negatives.
//! 3. **Decision-point counting (Q3)** — [`count_decision_samples`]: at a fixed
//!    cadence (default 2 s), a decision point is *eligible* when the ship is
//!    reloaded (≥ its estimated reload since its last salvo) and at least one
//!    enemy is observed-now (E3 gap semantics) within the ship's own observed
//!    engagement range; the label is positive when a salvo starts within the
//!    following label window.
//! 4. **Negative-sample semantics (Q4)** — [`audit_negative_samples`]: samples
//!    eligible-but-silent windows and reports which features are available
//!    (nearest-enemy distance, observation staleness, terrain LOS from the E4
//!    raster, turret-bearing offset vs ship heading, own range) plus a
//!    heuristic cause split. Causes NOT expressible with current features
//!    (aim-solution quality, deliberate hold, concealment management, turret
//!    lag behind a recent turn) are the label-noise budget.
//! 5. **CV-recorder limitation (Q5)** — a carrier recorder has no player-fired
//!    main battery: whatever `owner == recorder` shells exist are AI
//!    secondaries / aircraft weapons, not decisions. The analysis reports this
//!    explicitly and evaluates other ships' fire as weak supervision.
//! 6. **Scale extrapolation (Q6)** — [`count_decision_samples`] totals per
//!    replay, from which replays-per-10^6 / 10^7 samples follow.

// Experiment-only analysis surface: no Tauri command consumes it yet — the
// entry points are the env-gated tests at the bottom. Silence dead_code for
// the non-test build (the clippy gate runs --lib --bins without --tests).
#![allow(dead_code)]

use anyhow::bail;
use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use wowsp_tauri_shared::{
    ConsumableUseEvent, EngineStateSample, EntityTrajectory, PlayerBuild, PositionSample,
    ReplayStream, ShellLaunchEvent, ShotKillEvent, SmokeScreenEvent, VehicleEntry, VisionEvent,
    WeatherNotification, WeatherTransition,
};

use super::decision_tick::{METERS_PER_GP_UNIT, METERS_PER_UNIT};
use super::replay_probe::{GAP_THRESHOLD, battle_results_conflicts, resolve_team, roster_sides};
use super::terrain_los::{LosGrid, los_blocked};

/// Decision-point cadence and label-window length (seconds). A decision point
/// at `t` is labelled positive when a salvo starts in `(t, t + LABEL_WINDOW_S]`.
pub const DECISION_INTERVAL_S: f32 = 2.0;
pub const LABEL_WINDOW_S: f32 = 2.0;

/// Muzzle height (world units, 1 unit ≈ 5.86 m) separating ship guns from
/// aircraft-launched ordnance (rockets / bombs): ship muzzles sit a handful of
/// units above the water, aircraft drop from tens of units.
const AIRBORNE_MUZZLE_Y_UNITS: f32 = 15.0;

/// Clamp band for per-owner reload estimation: real main-battery reloads span
/// ~3 s (gunboat DD) to ~40 s (slow BB); anything outside is salvo-grouping
/// noise, not a reload.
const MIN_RELOAD_S: f32 = 3.0;
const MAX_RELOAD_S: f32 = 45.0;

/// `gunBarrelID` values below this bound belong to the main battery: observed
/// barrel ids cluster as 0..~11 (main barrels), then 32/64/96 groups and a
/// 0x7FFF sentinel / 0x8000-flagged range (secondary batteries and AA flak —
/// verified against the reference replay's distribution).
const MAIN_BATTERY_MAX_BARREL_ID: u16 = 32;

/// Slack on a ship's own observed maximum aim distance when judging whether a
/// target is in range (players rarely fire at the exact maximum).
const RANGE_SLACK: f32 = 1.15;

/// Range fallback for ships with no usable fire history (metres).
const RANGE_FALLBACK_M: f32 = 25_000.0;

/// Turret-bearing offset (degrees, ship heading vs bearing-to-target, mod
/// 180°) above which "guns not on target" is flagged in the negative audit.
const TRAVERSE_FLAG_DEG: f32 = 60.0;

/// Observation age above which a negative window's target counts as stale.
const STALE_TARGET_S: f32 = 2.0;

/// Knobs of the sample construction, defaulted to the values used in the E7
/// report.
#[derive(Debug, Clone, Copy)]
pub struct FireSampleParams {
    /// Cadence of decision points (seconds).
    pub decision_interval_s: f32,
    /// Positive-label window after a decision point (seconds).
    pub label_window_s: f32,
    /// Minimum reload clamp (seconds).
    pub min_reload_s: f32,
    /// Maximum reload clamp (seconds).
    pub max_reload_s: f32,
    /// Multiplier on a ship's own max observed aim distance for "in range".
    pub range_slack: f32,
    /// Fallback engagement range when the ship never fired (metres).
    pub range_fallback_m: f32,
}

impl Default for FireSampleParams {
    fn default() -> Self {
        Self {
            decision_interval_s: DECISION_INTERVAL_S,
            label_window_s: LABEL_WINDOW_S,
            min_reload_s: MIN_RELOAD_S,
            max_reload_s: MAX_RELOAD_S,
            range_slack: RANGE_SLACK,
            range_fallback_m: RANGE_FALLBACK_M,
        }
    }
}

// ── small helpers ───────────────────────────────────────────────────────────

/// Latest sample at or before `t` — binary search (streams are time-sorted).
fn last_sample_before(samples: &[PositionSample], t: f32) -> Option<&PositionSample> {
    let idx = samples.partition_point(|s| s.time <= t);
    if idx == 0 {
        None
    } else {
        Some(&samples[idx - 1])
    }
}

/// p-percentile of a non-empty slice (linear interpolation off; nearest-rank
/// like the E5 helper). Takes ownership so callers can pass collected vectors.
fn percentile(mut values: Vec<f32>, p: f32) -> Option<f32> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = (((values.len() as f32 - 1.0) * p).round() as usize).min(values.len() - 1);
    Some(values[idx])
}

/// Planar distance between two samples' positions (units).
fn planar_dist(a: (f32, f32), b: (f32, f32)) -> f32 {
    (a.0 - b.0).hypot(a.1 - b.1)
}

/// Angular offset (degrees, mod 180°) between a ship's heading and the
/// bearing to a point — the turret-traverse proxy: main batteries cover
/// roughly ±150° around the bow, so offsets approaching 180° (stern) or a
/// recent turn imply the guns are still training.
fn bearing_offset_deg(yaw: f32, from: (f32, f32), to: (f32, f32)) -> f32 {
    let bearing = (to.1 - from.1).atan2(to.0 - from.0);
    let d = (bearing - yaw).rem_euclid(std::f32::consts::PI);
    d.min(std::f32::consts::PI - d).to_degrees()
}

/// A ship trajectory joined with its recorder-relative team.
pub struct ShipInfo<'a> {
    traj: &'a EntityTrajectory,
    team_id: Option<i8>,
    team_ambiguous: bool,
    is_recorder: bool,
}

/// Collect type-2 ship trajectories with team attribution (E3 semantics).
fn ship_infos<'a>(stream: &'a ReplayStream, vehicles: &[VehicleEntry]) -> Vec<ShipInfo<'a>> {
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
            ShipInfo {
                traj,
                team_id,
                team_ambiguous,
                is_recorder: stream.recorder_vehicle_id == Some(traj.entity_id),
            }
        })
        .collect()
}

// ── salvo aggregation (shared by Q2/Q3/Q4) ─────────────────────────────────

/// One fire event: one owner's shells of one battery class, contiguous in
/// time (≤ 2 s gaps) — the replay-visible proxy for one player click.
#[derive(Debug, Clone, Copy)]
struct Salvo {
    owner_id: i32,
    start: f32,
    /// Time of the event's last shell.
    last_time: f32,
    /// Shells in the event (ground-level only — see `group_salvos`).
    shell_count: u32,
    /// Whether this event belongs to the main battery.
    main_battery: bool,
    /// Max muzzle→aim distance in the event (units).
    max_aim_dist_units: f32,
}

/// Group one owner's ground-level shells into fire events: within each
/// battery class (main vs everything else), consecutive shells ≤ 2 s apart
/// merge. `salvoID` is deliberately NOT a grouping key — the reference replay
/// shows one player click arriving as several packs with different salvo ids
/// 0.1–0.3 s apart (sequential turret fire), so only the time gap (and the
/// battery class) separates real fire events. Returns events sorted by start
/// time.
fn group_salvos(shells: &[&ShellLaunchEvent]) -> Vec<Salvo> {
    let mut sorted: Vec<&ShellLaunchEvent> = shells.to_vec();
    sorted.sort_by(|a, b| {
        a.time
            .partial_cmp(&b.time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    // Partition by battery class first: main and secondary bursts interleave
    // within one click, and each class must merge independently.
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
            let aim = planar_dist((s.x, s.z), (s.target_x, s.target_z));
            match current.as_mut() {
                Some(prev) if s.time - prev.last_time <= 2.0 => {
                    prev.shell_count += 1;
                    prev.max_aim_dist_units = prev.max_aim_dist_units.max(aim);
                    prev.last_time = s.time;
                },
                _ => {
                    if let Some(ev) = current.take() {
                        salvos.push(ev);
                    }
                    current = Some(Salvo {
                        owner_id: s.owner_id,
                        start: s.time,
                        last_time: s.time,
                        shell_count: 1,
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
    salvos
}

// ── per-owner fire context ──────────────────────────────────────────────────

/// Fire-derived state per owner needed by Q2–Q4: salvos, reload estimate,
/// observed engagement range.
struct OwnerFireContext {
    salvos: Vec<Salvo>,
    /// Estimated reload (seconds), 0.0 for owners with no fire history
    /// (guns start loaded → always reloaded).
    reload_s: f32,
    /// Max observed muzzle→aim distance × slack (metres); fallback when the
    /// owner has no shells.
    range_m: f32,
    has_fire_history: bool,
}

/// Build the per-owner fire context for every type-2 ship (owners without
/// shells get an empty context with the fallback range).
fn fire_contexts(
    stream: &ReplayStream,
    ships: &[ShipInfo<'_>],
    params: &FireSampleParams,
) -> BTreeMap<i32, OwnerFireContext> {
    // Ground-level shells per owner (aircraft ordnance excluded from salvo
    // semantics — their "reload" is a squadron cycle, not a gun reload).
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
        let salvos = group_salvos(shells);
        let reload_s = estimate_reload(&salvos, params);
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

/// Reload estimate: p10 of the intervals between consecutive MAIN-battery
/// salvos (secondary bursts would drag it to ~1 s), clamped to the plausible
/// band. Owners firing freely sit at their reload; holders show multiples of
/// it — p10 catches the free-firing floor. 0 shells → 0.0 (always reloaded).
fn estimate_reload(salvos: &[Salvo], params: &FireSampleParams) -> f32 {
    let main_starts: Vec<f32> = salvos
        .iter()
        .filter(|s| s.main_battery)
        .map(|s| s.start)
        .collect();
    if main_starts.len() < 2 {
        return 0.0;
    }
    let intervals: Vec<f32> = main_starts.windows(2).map(|w| w[1] - w[0]).collect();
    percentile(intervals, 0.10)
        .unwrap_or(0.0)
        .clamp(params.min_reload_s, params.max_reload_s)
}

// ── Q1: attribution ─────────────────────────────────────────────────────────

/// Per-owner firing volume and attribution-confidence stats.
#[derive(Debug, Clone, Serialize)]
pub struct OwnerFireStats {
    pub owner_id: i32,
    pub team_id: Option<i8>,
    pub team_ambiguous: bool,
    pub is_recorder: bool,
    pub ship_id: Option<i64>,
    pub shells: usize,
    /// Shells with muzzle height above the airborne bound (aircraft weapons).
    pub airborne_shells: usize,
    pub salvos: usize,
    pub muzzle_owner_dist_p50_units: f32,
    pub muzzle_owner_dist_p90_units: f32,
    /// Fraction of this owner's shells where the owner was the nearest ship
    /// to the muzzle (attribution confidence).
    pub owner_nearest_fraction: f32,
    /// Median muzzle height (units) — separates ship guns from aircraft.
    pub median_muzzle_y: f32,
    /// Fraction of shells fired while the owner had a position sample within
    /// [t-4 s, t+6 s] (firing blooms spot the shooter; shells can precede the
    /// position stream resuming).
    pub observed_at_fire_fraction: f32,
    pub first_fire_s: f32,
    pub last_fire_s: f32,
}

/// Q1 report: totals + per-owner rows.
#[derive(Debug, Clone, Serialize)]
pub struct FireAttribution {
    pub total_shells: usize,
    /// Shells whose owner joins a type-2 ship trajectory.
    pub shells_with_ship_owner: usize,
    /// Shells whose owner matches no ship trajectory (other entity kinds or
    /// unknown ids).
    pub unowned_shells: usize,
    /// Shells with an airborne muzzle (aircraft weapons).
    pub airborne_shells: usize,
    /// Overall muzzle→owner-position distance percentiles (units).
    pub muzzle_owner_dist_p50_units: f32,
    pub muzzle_owner_dist_p90_units: f32,
    pub muzzle_owner_dist_max_units: f32,
    /// Fraction of attributed shells whose owner is the nearest ship.
    pub owner_is_nearest_fraction: f32,
    /// Distinct firing ship owners.
    pub firing_ships: usize,
    pub owners: Vec<OwnerFireStats>,
}

/// Attribute every shell to its firing ship and validate the join
/// geometrically (Q1). `ships` from [`ship_infos`].
pub fn attribute_shell_owners(stream: &ReplayStream, ships: &[ShipInfo<'_>]) -> FireAttribution {
    struct Acc {
        shells: usize,
        airborne: usize,
        dists: Vec<f32>,
        nearest: usize,
        nearest_checks: usize,
        ys: Vec<f32>,
        observed: usize,
        first: f32,
        last: f32,
    }
    let mut accs: BTreeMap<i32, Acc> = BTreeMap::new();
    let mut unowned = 0usize;
    let mut total = 0usize;
    let mut all_dists: Vec<f32> = Vec::new();
    let mut nearest_hits = 0usize;
    let mut nearest_checks = 0usize;
    for s in &stream.shell_launches {
        total += 1;
        let Some(ship) = ships.iter().find(|sh| sh.traj.entity_id == s.owner_id) else {
            unowned += 1;
            continue;
        };
        let acc = accs.entry(s.owner_id).or_insert(Acc {
            shells: 0,
            airborne: 0,
            dists: Vec::new(),
            nearest: 0,
            nearest_checks: 0,
            ys: Vec::new(),
            observed: 0,
            first: f32::MAX,
            last: f32::MIN,
        });
        acc.shells += 1;
        if s.y >= AIRBORNE_MUZZLE_Y_UNITS {
            acc.airborne += 1;
        }
        acc.ys.push(s.y);
        acc.first = acc.first.min(s.time);
        acc.last = acc.last.max(s.time);
        // Owner position at fire time (grace band ±: sample within 4 s
        // before or 6 s after — shells can land in the stream a beat before
        // the position resumes after the firing bloom).
        if let Some(p) = last_sample_before(&ship.traj.samples, s.time + 6.0)
            .filter(|p| (s.time - p.time) <= GAP_THRESHOLD || (p.time - s.time) <= 6.0)
        {
            acc.observed += 1;
            let d = planar_dist((s.x, s.z), (p.x, p.z));
            acc.dists.push(d);
            all_dists.push(d);
            // Nearest-ship cross-check: owner vs every other ship's position
            // at the fire time (same grace band).
            let mut best = (f32::MAX, false);
            for other in ships {
                let Some(op) = last_sample_before(&other.traj.samples, s.time + 6.0)
                    .filter(|op| (s.time - op.time).abs() <= 6.0)
                else {
                    continue;
                };
                let od = planar_dist((s.x, s.z), (op.x, op.z));
                if od < best.0 {
                    best = (od, other.traj.entity_id == s.owner_id);
                }
            }
            acc.nearest_checks += 1;
            nearest_checks += 1;
            if best.1 {
                acc.nearest += 1;
                nearest_hits += 1;
            }
        }
    }
    let mut owners = Vec::new();
    for (id, acc) in &accs {
        let ship = ships
            .iter()
            .find(|sh| sh.traj.entity_id == *id)
            .expect("accs are keyed by ship ids");
        owners.push(OwnerFireStats {
            owner_id: *id,
            team_id: ship.team_id,
            team_ambiguous: ship.team_ambiguous,
            is_recorder: ship.is_recorder,
            ship_id: ship.traj.kind.as_ref().and_then(|k| k.ship_id),
            shells: acc.shells,
            airborne_shells: acc.airborne,
            salvos: group_salvos(
                &stream
                    .shell_launches
                    .iter()
                    .filter(|s| s.owner_id == *id && s.y < AIRBORNE_MUZZLE_Y_UNITS)
                    .collect::<Vec<_>>(),
            )
            .len(),
            muzzle_owner_dist_p50_units: percentile(acc.dists.clone(), 0.50).unwrap_or(-1.0),
            muzzle_owner_dist_p90_units: percentile(acc.dists.clone(), 0.90).unwrap_or(-1.0),
            owner_nearest_fraction: if acc.nearest_checks == 0 {
                -1.0
            } else {
                acc.nearest as f32 / acc.nearest_checks as f32
            },
            median_muzzle_y: percentile(acc.ys.clone(), 0.50).unwrap_or(-1.0),
            observed_at_fire_fraction: acc.observed as f32 / acc.shells.max(1) as f32,
            first_fire_s: if acc.first == f32::MAX {
                -1.0
            } else {
                acc.first
            },
            last_fire_s: if acc.last == f32::MIN { -1.0 } else { acc.last },
        });
    }
    FireAttribution {
        total_shells: total,
        shells_with_ship_owner: total - unowned,
        unowned_shells: unowned,
        airborne_shells: stream
            .shell_launches
            .iter()
            .filter(|s| s.y >= AIRBORNE_MUZZLE_Y_UNITS)
            .count(),
        muzzle_owner_dist_p50_units: percentile(all_dists.clone(), 0.50).unwrap_or(-1.0).max(0.0),
        muzzle_owner_dist_p90_units: percentile(all_dists.clone(), 0.90).unwrap_or(-1.0).max(0.0),
        muzzle_owner_dist_max_units: percentile(all_dists, 1.0).unwrap_or(-1.0).max(0.0),
        owner_is_nearest_fraction: if nearest_checks == 0 {
            -1.0
        } else {
            nearest_hits as f32 / nearest_checks as f32
        },
        firing_ships: owners.len(),
        owners,
    }
}

// ── Q2: salvo / reload structure ────────────────────────────────────────────

/// Per-owner salvo structure and reload estimate.
#[derive(Debug, Clone, Serialize)]
pub struct OwnerSalvoStats {
    pub owner_id: i32,
    pub is_recorder: bool,
    pub team_id: Option<i8>,
    pub shells: usize,
    pub salvos: usize,
    /// Salvo size distribution over ground-level salvos.
    pub salvo_size_p50: f32,
    pub salvo_size_max: u32,
    /// Salvos containing at least one main-battery barrel id.
    pub main_salvo_count: usize,
    pub main_salvo_size_p50: f32,
    /// Distinct barrel ids seen (main vs secondary hint).
    pub barrel_ids: Vec<u16>,
    /// Intervals between consecutive main-battery salvo starts.
    pub intervals_p10_s: f32,
    pub intervals_p50_s: f32,
    pub intervals_min_s: f32,
    pub intervals_max_s: f32,
    pub reload_estimate_s: f32,
    /// Share of the alive window inside a post-salvo reload interval — the
    /// censoring region negatives must avoid.
    pub censor_share: f32,
}

/// Q2 report.
#[derive(Debug, Clone, Serialize)]
pub struct SalvoStructure {
    pub owners: Vec<OwnerSalvoStats>,
}

/// Analyse salvo grouping, reload periods and censoring per owner (Q2).
pub fn analyze_salvo_structure(
    stream: &ReplayStream,
    ships: &[ShipInfo<'_>],
    params: &FireSampleParams,
) -> SalvoStructure {
    let contexts = fire_contexts(stream, ships, params);
    let mut owners = Vec::new();
    for ship in ships {
        let id = ship.traj.entity_id;
        let Some(ctx) = contexts.get(&id) else {
            continue;
        };
        if !ctx.has_fire_history {
            continue;
        }
        let sizes: Vec<f32> = ctx.salvos.iter().map(|s| s.shell_count as f32).collect();
        let main: Vec<&Salvo> = ctx.salvos.iter().filter(|s| s.main_battery).collect();
        let main_sizes: Vec<f32> = main.iter().map(|s| s.shell_count as f32).collect();
        let main_intervals: Vec<f32> = main.windows(2).map(|w| w[1].start - w[0].start).collect();
        let mut barrels: Vec<u16> = stream
            .shell_launches
            .iter()
            .filter(|s| s.owner_id == id && s.y < AIRBORNE_MUZZLE_Y_UNITS)
            .map(|s| s.gun_barrel_id)
            .collect();
        barrels.sort_unstable();
        barrels.dedup();
        // Censoring: time inside [salvo_start, salvo_start + reload) capped at
        // the next MAIN-battery salvo's start, over the owner's alive window.
        // Secondary/AA bursts are AI-automatic — they never gate a player's
        // fire decision, so only main-battery salvos censor.
        let alive = alive_window(ship);
        let window = (alive.1 - alive.0).max(0.0);
        let mut censored = 0.0f32;
        for (i, s) in main.iter().enumerate() {
            let seg_end = main
                .get(i + 1)
                .map_or(alive.1, |n| n.start.min(s.start + ctx.reload_s));
            censored += (seg_end - s.start).clamp(0.0, ctx.reload_s);
        }
        owners.push(OwnerSalvoStats {
            owner_id: id,
            is_recorder: ship.is_recorder,
            team_id: ship.team_id,
            shells: ctx
                .salvos
                .iter()
                .map(|s| s.shell_count as usize)
                .sum::<usize>(),
            salvos: ctx.salvos.len(),
            salvo_size_p50: percentile(sizes, 0.50).unwrap_or(0.0),
            salvo_size_max: ctx.salvos.iter().map(|s| s.shell_count).max().unwrap_or(0),
            main_salvo_count: main.len(),
            main_salvo_size_p50: percentile(main_sizes, 0.50).unwrap_or(0.0),
            barrel_ids: barrels,
            intervals_p10_s: percentile(main_intervals.clone(), 0.10)
                .unwrap_or(-1.0)
                .max(0.0),
            intervals_p50_s: percentile(main_intervals.clone(), 0.50)
                .unwrap_or(-1.0)
                .max(0.0),
            intervals_min_s: main_intervals.iter().cloned().fold(f32::MAX, f32::min),
            intervals_max_s: main_intervals.iter().cloned().fold(f32::MIN, f32::max),
            reload_estimate_s: ctx.reload_s,
            censor_share: if window > 0.0 {
                (censored / window).clamp(0.0, 1.0)
            } else {
                0.0
            },
        });
    }
    SalvoStructure { owners }
}

/// Owner alive window: first position sample to death (or last sample).
fn alive_window(ship: &ShipInfo<'_>) -> (f32, f32) {
    let from = ship.traj.samples.first().map(|s| s.time).unwrap_or(0.0);
    let to = ship
        .traj
        .death_time
        .or_else(|| ship.traj.samples.last().map(|s| s.time))
        .unwrap_or(from);
    (from, to.max(from))
}

// ── Q3: decision-point counting ─────────────────────────────────────────────

/// Per-owner decision-sample statistics.
#[derive(Debug, Clone, Serialize)]
pub struct OwnerDecisionStats {
    pub owner_id: i32,
    pub team_id: Option<i8>,
    pub is_recorder: bool,
    pub has_fire_history: bool,
    pub reload_estimate_s: f32,
    pub range_m: f32,
    pub alive_window_s: f32,
    /// Decision points where the owner's own state is observable (fresh own
    /// position sample — recorder-view discipline: unobserved enemies cannot
    /// contribute samples).
    pub observable_points: usize,
    /// …and reloaded (no salvo within the reload window before t).
    pub reloaded_points: usize,
    /// …and with at least one observed-now enemy inside own range.
    pub eligible_points: usize,
    /// Eligible points labelled positive (salvo starts within the label
    /// window).
    pub fired_points: usize,
}

impl OwnerDecisionStats {
    /// Positive-class rate among eligible points.
    pub fn positive_rate(&self) -> f32 {
        if self.eligible_points == 0 {
            return 0.0;
        }
        self.fired_points as f32 / self.eligible_points as f32
    }
}

/// Q3 + Q6 report.
#[derive(Debug, Clone, Serialize)]
pub struct DecisionSampleStats {
    pub owners: Vec<OwnerDecisionStats>,
    /// Totals across all ships with fire history.
    pub total_eligible_with_history: usize,
    pub total_fired_with_history: usize,
    /// Totals across every ship (incl. never-fired).
    pub total_eligible_all: usize,
    pub total_fired_all: usize,
    /// Recorder-only row mirrored for convenience (CV: secondary semantics).
    pub recorder_eligible: usize,
    pub recorder_fired: usize,
    /// Replays needed for 10^6 / 10^7 eligible samples at the per-replay
    /// rate observed here (all ships with fire history).
    pub replays_for_1e6: f32,
    pub replays_for_1e7: f32,
}

/// Count decision samples per owner at the configured cadence (Q3). Eligible =
/// own state observable + reloaded + an observed-now enemy within own range.
pub fn count_decision_samples(
    stream: &ReplayStream,
    ships: &[ShipInfo<'_>],
    params: &FireSampleParams,
) -> DecisionSampleStats {
    let contexts = fire_contexts(stream, ships, params);
    let mut owners = Vec::new();
    for ship in ships {
        // Ambiguous-team owners cannot see an enemy set — excluded, counted
        // in the report narrative.
        if ship.team_ambiguous || ship.team_id.is_none() {
            continue;
        }
        let id = ship.traj.entity_id;
        let Some(ctx) = contexts.get(&id) else {
            continue;
        };
        let (from, to) = alive_window(ship);
        let mut observable = 0usize;
        let mut reloaded = 0usize;
        let mut eligible = 0usize;
        let mut fired = 0usize;
        let mut t = from + 5.0;
        while t <= to {
            // Own state must be observable (recorder view).
            let Some(own) = last_sample_before(&ship.traj.samples, t) else {
                t += params.decision_interval_s;
                continue;
            };
            if t - own.time > GAP_THRESHOLD {
                t += params.decision_interval_s;
                continue;
            }
            observable += 1;
            // Reloaded: reload completes at or before the end of the label
            // window — i.e. no salvo start within (reload − cadence) before
            // t. The margin matters: ships firing the instant their reload
            // completes would otherwise be systematically unlabelable (the
            // decision point just before such a salvo sits inside the reload
            // interval). No fire history → guns start loaded.
            let effective_reload = (ctx.reload_s - params.decision_interval_s).max(0.0);
            // Main battery only: secondary/AA bursts are AI-automatic and
            // never mean the player chose to hold fire.
            let is_reloaded = !ctx
                .salvos
                .iter()
                .filter(|s| s.main_battery)
                .any(|s| s.start <= t && t - s.start < effective_reload);
            if !is_reloaded {
                t += params.decision_interval_s;
                continue;
            }
            reloaded += 1;
            // Target: nearest observed-now enemy within own range.
            let mut target: Option<(f32, f32, f32)> = None; // (dist_m, x, z)
            for other in ships {
                if other.traj.entity_id == id
                    || other.team_id.is_none()
                    || other.team_ambiguous
                    || other.team_id == ship.team_id
                {
                    continue;
                }
                let Some(e) = last_sample_before(&other.traj.samples, t) else {
                    continue;
                };
                if t - e.time > GAP_THRESHOLD {
                    continue;
                }
                if other.traj.death_time.is_some_and(|d| d <= t) {
                    continue;
                }
                let dist_m = planar_dist((own.x, own.z), (e.x, e.z)) * METERS_PER_UNIT;
                if dist_m <= ctx.range_m && target.is_none_or(|c| dist_m < c.0) {
                    target = Some((dist_m, e.x, e.z));
                }
            }
            if target.is_none() {
                t += params.decision_interval_s;
                continue;
            }
            eligible += 1;
            // Label from MAIN-battery salvos only (secondaries fire on AI
            // and would plant false positives on brawling ships).
            let fired_now = ctx
                .salvos
                .iter()
                .filter(|s| s.main_battery)
                .any(|s| s.start > t && s.start <= t + params.label_window_s);
            if fired_now {
                fired += 1;
            }
            t += params.decision_interval_s;
        }
        owners.push(OwnerDecisionStats {
            owner_id: id,
            team_id: ship.team_id,
            is_recorder: ship.is_recorder,
            has_fire_history: ctx.has_fire_history,
            reload_estimate_s: ctx.reload_s,
            range_m: ctx.range_m,
            alive_window_s: to - from,
            observable_points: observable,
            reloaded_points: reloaded,
            eligible_points: eligible,
            fired_points: fired,
        });
    }
    let total_eligible_with_history: usize = owners
        .iter()
        .filter(|o| o.has_fire_history)
        .map(|o| o.eligible_points)
        .sum();
    let total_fired_with_history: usize = owners
        .iter()
        .filter(|o| o.has_fire_history)
        .map(|o| o.fired_points)
        .sum();
    let total_eligible_all: usize = owners.iter().map(|o| o.eligible_points).sum();
    let total_fired_all: usize = owners.iter().map(|o| o.fired_points).sum();
    let recorder_eligible = owners
        .iter()
        .find(|o| o.is_recorder)
        .map(|o| o.eligible_points)
        .unwrap_or(0);
    let recorder_fired = owners
        .iter()
        .find(|o| o.is_recorder)
        .map(|o| o.fired_points)
        .unwrap_or(0);
    let per_replay = total_eligible_with_history.max(1) as f32;
    DecisionSampleStats {
        owners,
        total_eligible_with_history,
        total_fired_with_history,
        total_eligible_all,
        total_fired_all,
        recorder_eligible,
        recorder_fired,
        replays_for_1e6: 1.0e6 / per_replay,
        replays_for_1e7: 1.0e7 / per_replay,
    }
}

// ── Q4: negative-sample audit ───────────────────────────────────────────────

/// One audited eligible-but-silent decision window.
#[derive(Debug, Clone, Serialize)]
pub struct NegativeWindow {
    pub owner_id: i32,
    pub team_id: Option<i8>,
    pub t: f32,
    /// Nearest in-range observed enemy.
    pub nearest_enemy_id: i32,
    pub nearest_enemy_dist_m: f32,
    /// Age of the enemy's last position sample at t.
    pub enemy_observed_age_s: f32,
    /// Terrain-LOS verdict from the E4 raster (`None` without a grid).
    pub terrain_los_blocked: Option<bool>,
    /// Turret-bearing offset: ship heading vs bearing to the enemy (deg,
    /// mod 180°).
    pub turret_bearing_offset_deg: f32,
    /// Own engagement range used for the eligibility test (metres).
    pub own_range_used_m: f32,
    pub enemy_speed_kt: Option<f32>,
    /// Heuristic cause classification (see module docs for the
    /// expressibility split).
    pub plausible_cause: &'static str,
}

/// Audit up to `max_windows` eligible-but-silent decision windows (Q4),
/// evenly strided over the match for determinism. Gun ships with fire history
/// only — their reload estimate is what makes "eligible" meaningful.
pub fn audit_negative_samples(
    stream: &ReplayStream,
    ships: &[ShipInfo<'_>],
    los: Option<&LosGrid>,
    eye_height: f32,
    params: &FireSampleParams,
    max_windows: usize,
) -> Vec<NegativeWindow> {
    let contexts = fire_contexts(stream, ships, params);
    // Collect every eligible non-fired (owner, t) for gun owners.
    let mut candidates: Vec<(i32, f32)> = Vec::new();
    for ship in ships {
        if ship.team_ambiguous || ship.team_id.is_none() {
            continue;
        }
        let id = ship.traj.entity_id;
        let Some(ctx) = contexts.get(&id) else {
            continue;
        };
        if !ctx.has_fire_history || ctx.reload_s < params.min_reload_s {
            continue;
        }
        let (from, to) = alive_window(ship);
        let mut t = from + 5.0;
        while t <= to {
            let Some(own) = last_sample_before(&ship.traj.samples, t) else {
                t += params.decision_interval_s;
                continue;
            };
            if t - own.time > GAP_THRESHOLD {
                t += params.decision_interval_s;
                continue;
            }
            // Same eligibility as the decision counter: reload completes
            // within the label window.
            let effective_reload = (ctx.reload_s - params.decision_interval_s).max(0.0);
            if ctx
                .salvos
                .iter()
                .any(|s| s.start <= t && t - s.start < effective_reload)
            {
                t += params.decision_interval_s;
                continue;
            }
            if ctx
                .salvos
                .iter()
                .any(|s| s.start > t && s.start <= t + params.label_window_s)
            {
                t += params.decision_interval_s;
                continue;
            }
            if nearest_enemy(ship, ships, own, t, ctx.range_m).is_some() {
                candidates.push((id, t));
            }
            t += params.decision_interval_s;
        }
    }
    candidates.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut out = Vec::new();
    if candidates.is_empty() || max_windows == 0 {
        return out;
    }
    let stride = (candidates.len() as f32 / max_windows as f32)
        .max(1.0)
        .ceil() as usize;
    for &(id, t) in candidates.iter().step_by(stride).take(max_windows) {
        let ship = ships
            .iter()
            .find(|sh| sh.traj.entity_id == id)
            .expect("candidates come from ships");
        let ctx = &contexts[&id];
        let own = last_sample_before(&ship.traj.samples, t).expect("checked above");
        let target = nearest_enemy(ship, ships, own, t, ctx.range_m).expect("checked above");
        let los_verdict = los.map(|g| {
            los_blocked(
                g,
                (own.x as f64, own.z as f64, eye_height as f64),
                (target.x as f64, target.z as f64, 0.0),
            )
        });
        let offset = bearing_offset_deg(own.yaw, (own.x, own.z), (target.x, target.z));
        let speed_kt = trailing_speed_kt(ships, target.entity_id, t);
        let cause: &'static str = if los_verdict == Some(true) {
            "terrain-los"
        } else if offset > TRAVERSE_FLAG_DEG {
            "turret-traverse"
        } else if target.age > STALE_TARGET_S {
            "stale-target"
        } else {
            "unexplained-hold"
        };
        out.push(NegativeWindow {
            owner_id: id,
            team_id: ship.team_id,
            t,
            nearest_enemy_id: target.entity_id,
            nearest_enemy_dist_m: target.dist_m,
            enemy_observed_age_s: target.age,
            terrain_los_blocked: los_verdict,
            turret_bearing_offset_deg: offset,
            own_range_used_m: ctx.range_m,
            enemy_speed_kt: speed_kt,
            plausible_cause: cause,
        });
    }
    out
}

/// Nearest observed-now enemy within `range_m` for one owner position.
struct EnemySighting {
    entity_id: i32,
    x: f32,
    z: f32,
    dist_m: f32,
    age: f32,
}

fn nearest_enemy<'a>(
    ship: &ShipInfo<'a>,
    ships: &'a [ShipInfo<'_>],
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
                x: e.x,
                z: e.z,
                dist_m,
                age: t - e.time,
            });
        }
    }
    best
}

/// Trailing speed of one entity (kt) within its current observation streak —
/// the E6 semantics, reimplemented locally to keep this module self-contained.
fn trailing_speed_kt(ships: &[ShipInfo<'_>], entity_id: i32, t: f32) -> Option<f32> {
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
    Some(v * METERS_PER_UNIT / super::decision_tick::KT_MS)
}

// ── E9 step 1: supervision-sample export (the training-data delivery loop) ─
//
// Turns the E7 decision-point analysis into concrete training rows: for every
// ship WITH a fire history (the E7 weak-supervision decider set — reload and
// engagement range are only meaningful for owners that fired), at the 2 s
// decision cadence, one JSON-serialisable row per OBSERVABLE decision point:
// own-view global features, fixed enemy/friend entity slots with a padding
// mask, and the two-head labels from research note B:
//   labelA "physically can fire" — hard rule: the main-battery reload
//        completes within the label window AND an observed-now enemy sits
//        inside the decider's own engagement range (exactly the E7
//        eligibility test, so labelA rows == E7's eligible count);
//   labelB "expert fired"        — a MAIN-battery salvo starts in
//        (t, t+label_window]; censored (None) whenever labelA is false
//        (a hold during reload is not a decision, it is physics).
// Rows with labelA=0 are exported TOO: head A needs negatives, head B's loss
// masks them out on the training side.
//
// E15 · hit-conditioned labels: labelB's plain form treats every fired salvo
// as a full positive — a blap into open water scores the same as a
// devstrike. The outcome fields (E13) allow sharpening the target:
//   labelBHit  — fired ∧ ≥1 server-confirmed hit in the outcome window. The
//        hardest form: a well-chosen salvo that RNG scatters into misses
//        becomes a NEGATIVE, injecting outcome noise the expert does not
//        control (survivor-bias risk — only "lucky" fire moments stay
//        positive).
//   labelBSoft — 0.3 + 0.7·hit on fired rows (held stays 0.0), i.e.
//        fired∧hit → 1.0, fired∧miss → 0.3. The interpolated form: keeps
//        every fired moment above every held moment (ordering information
//        the plain label has) while the outcome only modulates WITHIN the
//        fired class, so dispersion noise moves a target 0.3↔1.0 instead of
//        0↔1. Which form actually helps (vs importing survivor bias) is an
//        empirical question the E15 evaluation answers via the outcome-lift
//        curves — all three variants ride the same rows.

// ── E14: feature v2 sources (E11 events / smoke / weather / ally builds) ───
//
// v1 features stopped at what `ReplayStream` carries. Four already-decoded
// data families were never in the feature rows:
//   * E11 `updateMinimapVisionInfo` — the EXPLICIT spot/unspot timeline (the
//     v1 `observedNow` infers it from position-stream gaps; 89/89 gap ends
//     align with a vision event, so the explicit stream can CORRECT the
//     inference — e.g. radar lighting a ship through a stale position track);
//   * E11 `onConsumableUsed` — consumable activation windows (raw type ids;
//     only 0≈damage-control and 8≈repair-party are NAMED, the id→GameParams
//     name map is deferred exactly as E11 left it — every other id folds
//     into the generic "other consumable" window);
//   * E11 `enginePower`/`engineDir` — per-vehicle engine output level
//     (tenths) and force sign, all ships;
//   * E8 smoke lifecycles + the weather (cyclone) timeline + #1435 ally
//     builds — all on/near `ReplayStream` already but unused by features.
// COVERAGE caveat (drives the sentinel design): the E11 method ids are
// pinned for 15.8.x ONLY (`layout_tables::e11_for`), and ally builds decode
// on 15.9.x only — on other versions those streams are legitimately EMPTY,
// so every dependent feature carries a "known" sentinel (-1 / None / a
// row-level `e11EventsKnown` flag) that lets the model learn when the
// feature is signal and when it is absence.

/// Feature schema version stamped on every exported row (E14). v1 rows
/// (pre-E13/E14 datasets) carry no `featureVersion` key — the training side
/// reads them as version 1 and branches on the layout.
pub const FEATURE_VERSION: u32 = 2;

/// E11 consumable raw type ids with a pinned meaning (E11 report): 0 fires
/// with a ~5 s window on the damage-control immunity, 8 with ~28 s on the
/// repair party. Every other observed id {1,3,4,6,9,10,65} folds into the
/// generic "other" window — naming them is a GameParams-side task.
const CONSUMABLE_ID_DAMCON: u8 = 0;
const CONSUMABLE_ID_REPAIR: u8 = 8;

/// Ally-build ability-entity ids of the RADAR family (GameParams RLSSearch*:
/// PCY/PXY base + premium/super/timebased + the PCT/PCM captain-modified
/// variants). Numeric ids joined from the webui's baked GameParams tables
/// (`gameparam_ids.json` × `consumable_details.json`, 15.x dump — entity ids
/// are stable across these builds). Radar = ship-only detection at 7.5–12 km.
const RADAR_ABILITY_IDS: [u32; 11] = [
    3_960_642_832, // PXY318_RLSSearch_PVP
    4_128_420_784, // PCT158_RLSSearch_Mod_I_5_Ouroboros
    4_137_857_968, // PCT149_RLSSearch_Mod_I_15_Ouroboros
    4_178_746_640, // PXY110_RLSSearchPremium
    4_180_849_584, // PCT108_RLSSearch_Mod_I
    4_224_884_656, // PCY066_RLSSearchPremium_TimeBased
    4_250_062_768, // PCM042_RLSSearch_Mod_I
    4_260_536_240, // PCY032_RLSSearchSuper
    4_273_119_152, // PCY020_RLSSearchPremium
    4_274_167_728, // PCY019_RLSSearch
    4_283_604_240, // PXY010_RLSSearch
];

/// Ally-build ability-entity ids of the HYDROACOUSTIC family (GameParams
/// SonarSearch* — hydrophone — plus the submarine PCY045_Hydrophone; same
/// provenance as [`RADAR_ABILITY_IDS`]). Hydro = ship + torpedo detection
/// at 3–6 km.
const HYDRO_ABILITY_IDS: [u32; 12] = [
    3_961_691_408, // PXY317_SonarSearch_PVP
    4_127_372_208, // PCT159_SonarSearch_Mod_I_5_RDragon
    4_136_809_392, // PCT150_SonarSearch_Mod_I_15_RDragon
    4_181_898_160, // PCT107_SonarSearch_Mod_I
    4_225_933_232, // PCY065_SonarSearchPremium_TimeBased
    4_246_904_752, // PCY045_Hydrophone
    4_251_111_344, // PCM041_SonarSearch_Mod_I
    4_262_633_392, // PCY030_SonarSearchSuper
    4_267_875_600, // PXY025_SonarSearch
    4_277_313_456, // PCY016_SonarSearchPremium
    4_282_555_664, // PXY011_SonarSearch
    4_285_702_064, // PCY008_SonarSearch
];

/// Nominal radar detection range for the "enemy possibly radar-lit" slot
/// flag (metres): the longest radar in the consumable table (15 km on a few
/// late-tier variants; most sit at 9–12 km). The
/// flag is deliberately a POSSIBILITY signal — the corpus carries either
/// build data (who HAS radar, 15.9) or activation events (15.8, unnamed
/// ids), never both, so "has radar AND in range" is the honest bound.
const RADAR_NOMINAL_RANGE_M: f32 = 15_000.0;

/// Unrestricted ship-spotting cap (GlobalWeather world units × 30 m ≈
/// 60 km) — the value every non-restrictive / unknown weather param gets.
const WEATHER_DEFAULT_CAP_UNITS: f32 = 2000.0;
/// Spotting caps below this (world units) count as a restrictive weather
/// state for the approach-warning feature (the webui weather badge's
/// threshold).
const WEATHER_RESTRICTIVE_MAX_UNITS: f32 = 1500.0;
/// Normalizer for the weather approach fraction: an announced restrictive
/// weather ramps the feature 0→1 over the last 300 s before it lands.
const WEATHER_INCOMING_WINDOW_S: f32 = 300.0;

/// GlobalWeather GameParams id → ship-spotting cap in world units, ported
/// from the webui weather table (packages/webui/src/features/holographic/
/// weather.ts; values baked from a 15.8 GameParams dump, ids stable across
/// builds). Only the RESTRICTIVE params are listed — everything else
/// (including unknown ids) is [`WEATHER_DEFAULT_CAP_UNITS`].
const WEATHER_CAP_UNITS: &[(u32, f32)] = &[
    (4_277_454_768, 587.0),    // PCOW016_USS_CL_Storm (event)
    (4_287_940_528, 266.6664), // PCOW006_Storm_Logic (cyclone, 8 km)
    (4_283_746_224, 266.6664), // PCOW010_Rain_Logic (cyclone, 8 km)
    (4_284_794_800, 266.6664), // PCOW009_Snowstorm_Logic (8 km)
    (4_269_066_160, 399.9996), // PCOW024_Rain_Logic_12km
    (4_268_017_584, 399.9996), // PCOW025_Storm_Logic_12km
    (4_275_357_616, 570.0),    // PCOW018_USS_CL_Light_Big
    (4_265_920_432, 1333.332), // PCOW027_CvC_Logic_Cloudy
    (4_264_871_856, 466.6662), // PCOW028_CvC_Logic
    (4_263_823_280, 433.3329), // PCOW029_CvCWeather_Logic_13km
    (4_262_774_704, 1333.332), // PCOW030_CvCWeather_Logic_40km
];

fn weather_cap_units(param: u32) -> f32 {
    WEATHER_CAP_UNITS
        .iter()
        .find(|(p, _)| *p == param)
        .map_or(WEATHER_DEFAULT_CAP_UNITS, |(_, cap)| *cap)
}

/// Whether a replay version decodes the E11 event streams: the method ids
/// are pinned per exact minor (15.8.x — `layout_tables::e11_for`). Mirrors
/// that gate on the exporter side so rows can carry the availability flag.
fn e11_events_expected(version: Option<&str>) -> bool {
    let Some(v) = version else {
        return false;
    };
    let mut parts = v.split(',');
    matches!(
        (parts.next(), parts.next()),
        (Some(a), Some(b)) if a.trim() == "15" && b.trim() == "8"
    )
}

/// The four decode-side event families behind feature v2 (E14), borrowed
/// from the `DecodedReplay` the stream projection drops. `e11_known` mirrors
/// [`e11_events_expected`] and separates "stream unavailable" (-1 sentinels)
/// from genuine "no event".
#[derive(Debug, Clone, Copy)]
pub struct FeatureEvents<'a> {
    pub vision: &'a [VisionEvent],
    pub consumables: &'a [ConsumableUseEvent],
    pub engine: &'a [EngineStateSample],
    pub smokes: &'a [SmokeScreenEvent],
    pub e11_known: bool,
}

impl<'a> FeatureEvents<'a> {
    /// The "no event families at all" view (synthetic v1-style inputs).
    pub fn empty() -> Self {
        Self {
            vision: &[],
            consumables: &[],
            engine: &[],
            smokes: &[],
            e11_known: false,
        }
    }

    /// Assemble from a decode, stamping availability from the replay version.
    pub fn for_version(version: Option<&str>, events: &'a super::replay::ReplayEvents) -> Self {
        Self {
            vision: &events.vision,
            consumables: &events.consumables,
            engine: &events.engine,
            smokes: &events.smokes,
            e11_known: e11_events_expected(version),
        }
    }
}

/// One ACTIVE smoke cloud at a decision time (E8 lifecycles + the drift
/// centre from the smoke entity's own position trail — `decision_tick`'s
/// semantics, reimplemented locally so the exporter stays self-contained).
#[derive(Debug, Clone, Copy)]
struct ActiveSmoke {
    x: f32,
    z: f32,
    /// Radius in metres (GP units × 30). Clouds whose create state did not
    /// decode a radius are dropped entirely (they cannot gate geometry).
    radius_m: f32,
}

/// Every cloud active at `t` (creation ≤ t < observed dissipation; no
/// observed end ⇒ still active), with the drifting centre.
fn active_smokes_at(
    stream: &ReplayStream,
    smokes: &[SmokeScreenEvent],
    t: f32,
) -> Vec<ActiveSmoke> {
    smokes
        .iter()
        .filter(|ev| ev.time <= t && !ev.end_time.is_some_and(|end| t >= end))
        .filter_map(|ev| {
            let radius_m = ev.radius? * METERS_PER_GP_UNIT;
            let (cx, cz) = stream
                .trajectories
                .iter()
                .find(|tr| tr.entity_id == ev.entity_id)
                .and_then(|tr| tr.samples.iter().rfind(|s| s.time <= t))
                .map(|s| (s.x, s.z))
                .unwrap_or((ev.x, ev.z));
            Some(ActiveSmoke {
                x: cx,
                z: cz,
                radius_m,
            })
        })
        .collect()
}

/// Whether a last-known scene position sits inside one of the active clouds
/// (scene-unit distance → metres on the E5 axis vs the GP-unit radius).
fn inside_any_smoke(x: f32, z: f32, active: &[ActiveSmoke]) -> bool {
    active
        .iter()
        .any(|s| (x - s.x).hypot(z - s.z) * METERS_PER_UNIT < s.radius_m)
}

/// Total active-cloud area (km²) — π r² summed, cloud overlaps NOT merged
/// (a deliberate over-count that is uniform across rows).
fn active_smoke_area_km2(active: &[ActiveSmoke]) -> f32 {
    active
        .iter()
        .map(|s| std::f32::consts::PI * (s.radius_m / 1000.0) * (s.radius_m / 1000.0))
        .sum()
}

/// Per-replay feature substrate built once per export (E14): per-entity
/// event views plus the ally radar/hydro holder sets and the sorted weather
/// timelines.
struct FeatureIndex<'a> {
    /// entity → time-sorted (time, visible) vision entries.
    vision: BTreeMap<i32, Vec<(f32, bool)>>,
    /// entity → time-sorted consumable uses.
    consumables: BTreeMap<i32, Vec<&'a ConsumableUseEvent>>,
    /// entity → time-sorted engine-state samples.
    engine: BTreeMap<i32, Vec<&'a EngineStateSample>>,
    /// Recorder-side entity ids whose build mounts radar / hydro.
    radar_holders: BTreeSet<i32>,
    hydro_holders: BTreeSet<i32>,
    /// Whether the replay decoded ANY ally build (the shipConfig layout is
    /// pinned to 15.9.x): false ⇒ the holder sets are unknown, not empty.
    builds_decoded: bool,
    weather_sorted: Vec<WeatherTransition>,
    notifications: Vec<WeatherNotification>,
}

fn build_feature_index<'a>(
    events: &FeatureEvents<'a>,
    ally_builds: &[PlayerBuild],
    weather: &[WeatherTransition],
    notifications: &[WeatherNotification],
) -> FeatureIndex<'a> {
    let mut vision: BTreeMap<i32, Vec<(f32, bool)>> = BTreeMap::new();
    for v in events.vision {
        vision
            .entry(v.entity_id)
            .or_default()
            .push((v.time, v.visible));
    }
    for list in vision.values_mut() {
        list.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    }
    let mut consumables: BTreeMap<i32, Vec<&ConsumableUseEvent>> = BTreeMap::new();
    for c in events.consumables {
        consumables.entry(c.entity_id).or_default().push(c);
    }
    for list in consumables.values_mut() {
        list.sort_by(|a, b| {
            a.time
                .partial_cmp(&b.time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    let mut engine: BTreeMap<i32, Vec<&EngineStateSample>> = BTreeMap::new();
    for e in events.engine {
        engine.entry(e.entity_id).or_default().push(e);
    }
    for list in engine.values_mut() {
        list.sort_by(|a, b| {
            a.time
                .partial_cmp(&b.time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    let mut radar_holders = BTreeSet::new();
    let mut hydro_holders = BTreeSet::new();
    for b in ally_builds {
        if b.abilities.iter().any(|id| RADAR_ABILITY_IDS.contains(id)) {
            radar_holders.insert(b.entity_id);
        }
        if b.abilities.iter().any(|id| HYDRO_ABILITY_IDS.contains(id)) {
            hydro_holders.insert(b.entity_id);
        }
    }
    let mut weather_sorted = weather.to_vec();
    weather_sorted.sort_by(|a, b| {
        a.start_time
            .partial_cmp(&b.start_time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    FeatureIndex {
        vision,
        consumables,
        engine,
        radar_holders,
        hydro_holders,
        builds_decoded: !ally_builds.is_empty(),
        weather_sorted,
        notifications: notifications.to_vec(),
    }
}

impl FeatureIndex<'_> {
    /// EXPLICIT spotted verdict at `t` (the recorder's minimap stream — the
    /// same perspective the position gaps come from): the entity's last
    /// vision entry at or before `t`. `None` when the stream knows nothing
    /// about the entity (or does not exist for this replay version).
    fn spotted_at(&self, entity_id: i32, t: f32) -> Option<bool> {
        let list = self.vision.get(&entity_id)?;
        let idx = list.partition_point(|(time, _)| *time <= t);
        if idx == 0 {
            return None;
        }
        Some(list[idx - 1].1)
    }

    /// Consumable remaining-time fraction at `t` for one id family: the max
    /// `(end - t) / duration` over the uses still covering `t`, 0.0 when the
    /// entity's stream exists but no window of this family covers `t`,
    /// `None` when the entity has no consumable uses at all (the caller
    /// decides unknown-vs-inactive — see [`consumable_frac_or_unknown`]).
    fn consumable_frac_raw(&self, entity_id: i32, t: f32, want_id: Option<u8>) -> Option<f32> {
        let list = self.consumables.get(&entity_id)?;
        let mut best = 0.0f32;
        for c in list.iter().take_while(|c| c.time <= t) {
            let matches = match want_id {
                Some(id) => c.consumable_id == id,
                None => {
                    c.consumable_id != CONSUMABLE_ID_DAMCON
                        && c.consumable_id != CONSUMABLE_ID_REPAIR
                },
            };
            if !matches || c.duration <= 0.0 {
                continue;
            }
            let end = c.time + c.duration;
            if t < end {
                best = best.max(((end - t) / c.duration).clamp(0.0, 1.0));
            }
        }
        Some(best)
    }

    /// Engine output level (0..1, tenths of max) and force direction (+1
    /// ahead / −1 braking) at `t` — the step-fold of the entity's samples
    /// (each sample carries exactly one of the two).
    fn engine_at(&self, entity_id: i32, t: f32) -> (Option<f32>, Option<f32>) {
        let Some(list) = self.engine.get(&entity_id) else {
            return (None, None);
        };
        let mut power: Option<u8> = None;
        let mut dir: Option<i8> = None;
        for e in list.iter().take_while(|e| e.time <= t) {
            if let Some(p) = e.power {
                power = Some(p);
            }
            if let Some(d) = e.dir {
                dir = Some(d);
            }
        }
        let p = power.map(|p| (p as f32 / 10.0).clamp(0.0, 1.0));
        let d = dir.map(|d| d as f32);
        (p, d)
    }

    /// Lerped ship-spotting cap at `t` (metres): walk the sorted transition
    /// windows — a window that has STARTED lerps the running cap toward its
    /// target (linear, matching the server's interpolation), a window that
    /// has ENDED sets the running cap to its target.
    fn vision_cap_m(&self, t: f32) -> f32 {
        let mut cap = WEATHER_DEFAULT_CAP_UNITS;
        for tr in &self.weather_sorted {
            if tr.start_time > t {
                break;
            }
            let to_cap = weather_cap_units(tr.to_param);
            if t < tr.end_time && tr.end_time > tr.start_time {
                let f = ((t - tr.start_time) / (tr.end_time - tr.start_time)).clamp(0.0, 1.0);
                return (cap + (to_cap - cap) * f) * METERS_PER_GP_UNIT;
            }
            cap = to_cap;
        }
        cap * METERS_PER_GP_UNIT
    }

    /// Restrictive-weather approach fraction at `t`: the closest pending
    /// announcement of a restrictive weather ramps 0→1 over the final
    /// [`WEATHER_INCOMING_WINDOW_S`] before it lands. Announcements whose
    /// param is not restrictive (or already landed) contribute nothing.
    fn weather_incoming_frac(&self, t: f32) -> f32 {
        self.notifications
            .iter()
            .filter(|n| n.at_time > t && weather_cap_units(n.param) < WEATHER_RESTRICTIVE_MAX_UNITS)
            .map(|n| 1.0 - ((n.at_time - t) / WEATHER_INCOMING_WINDOW_S).clamp(0.0, 1.0))
            .fold(0.0f32, f32::max)
    }

    /// Whether an enemy slot's last-known position is possibly radar-lit:
    /// some recorder-side radar holder's last-known position at `t` sits
    /// within the nominal radar range of the slot entity. Recorder-side
    /// builds only — an enemy-side decider's "enemies" are the recorder's
    /// team, so the flag is meaningless there and is forced false (same gate
    /// as the ally radar/hydro counts).
    fn radar_lit(
        &self,
        stream: &ReplayStream,
        x: f32,
        z: f32,
        t: f32,
        recorder_side: bool,
    ) -> bool {
        recorder_side
            && self.radar_holders.iter().any(|&id| {
                stream
                    .trajectories
                    .iter()
                    .find(|tr| tr.entity_id == id)
                    .and_then(|tr| tr.samples.iter().rfind(|s| s.time <= t))
                    .is_some_and(|s| {
                        (s.x - x).hypot(s.z - z) * METERS_PER_UNIT <= RADAR_NOMINAL_RANGE_M
                    })
            })
    }
}

/// The decider-level consumable windows with the availability sentinel: -1
/// when the replay has no E11 stream at all, else the raw fraction (0 when
/// inactive).
fn consumable_frac_or_unknown(
    idx: &FeatureIndex<'_>,
    e11_known: bool,
    entity_id: i32,
    t: f32,
    want_id: Option<u8>,
) -> f32 {
    if !e11_known {
        return -1.0;
    }
    idx.consumable_frac_raw(entity_id, t, want_id)
        .unwrap_or(0.0)
}

/// Fixed enemy-slot count of the exported feature rows.
pub const ENEMY_SLOTS: usize = 16;
/// Fixed friend-slot count of the exported feature rows.
pub const FRIEND_SLOTS: usize = 8;

/// Trailing combat-event window (seconds) — E6 semantics.
const EXPORT_EVENT_WINDOW_S: f32 = 30.0;
/// "Near the decider" explosion radius (metres) — E6 semantics.
const EXPORT_EXPLOSION_NEAR_RADIUS_M: f32 = 500.0;
/// InteractiveZone entity types (13 pre-14.5.0, 14 after) — E6 semantics.
const EXPORT_ZONE_TYPES: [i16; 2] = [13, 14];

// ── E13 outcome fields ──────────────────────────────────────────────────────
//
// Every decision row additionally carries POST-DECISION outcome statistics
// over the window `(t + label_window, t + OUTCOME_WINDOW_S]` — the strongest
// offline evaluation evidence of research note B ("post-hoc decile lift"):
// not "does the model agree with the expert" but "do the moments the model
// rates highly actually land hits / remove enemy HP afterwards". Substrate:
// the #1418 damage-attribution capability (shotKills per-hit terminal
// points, hp_samples timelines, arena max-HP anchoring).
//
// UNIT CAVEAT (ported verbatim from the reference implementation): the webui
// claim-partition model (liveSelfStats.ts) names its impact radius
// `HIT_RADIUS_M = 500` but compares it directly in the stream's scene units
// (no metres conversion exists on that side), i.e. effectively ~500 units ≈
// 2.9 km at E5's 5.86 m/unit. This module mirrors that units semantics
// (`OUTCOME_HIT_RADIUS_UNITS = 500.0` compared against raw x/z) so the
// calibration magnitude of #1418 (dealt ledger ≈ 0.62x of authoritative
// damage, median over 119 settled battles) transfers to these fields.

/// Outcome statistics window end offset (E13): outcome fields are counted
/// over `(t + label_window, t + OUTCOME_WINDOW_S]` — after the label window,
/// long enough for a salvo's full flight + splash ticks to resolve.
pub const OUTCOME_WINDOW_S: f32 = 45.0;
/// Impact-to-victim attribution radius, compared in scene units — see the
/// unit caveat above (mirrors the webui's 500 constant exactly).
const OUTCOME_HIT_RADIUS_UNITS: f32 = 500.0;
/// HP-drop attribution envelope around an impact (seconds): a drop sample at
/// `d` is covered by an impact at `i` when `i - 0.4 < d <= i + 0.6` — the
/// #1418 window (HP is sampled just before the hit ticks, then after).
const OUTCOME_HP_BEFORE_S: f32 = 0.4;
const OUTCOME_HP_AFTER_S: f32 = 0.6;
/// Minimum HP drop counted as damage (tick noise floor) — #1418's 50.
const OUTCOME_HP_MIN_DELTA: u32 = 50;

/// One entity slot of the export row. Ordered per ship list: observed-now
/// slots first (by distance), then stale intel (by distance) — slot ORDER is
/// deterministic, truncation (16 enemies / 8 friends) keeps the nearest.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FireDatasetSlot {
    pub entity_id: i32,
    /// EntityCreate type index (ships are 2; the one-hot summary on the
    /// training side is over this vocabulary).
    pub entity_type: i16,
    pub ship_id: Option<i64>,
    /// Planar distance from the decider's position at t (metres, E5 scale).
    pub dist_m: f32,
    /// Bearing to the entity relative to the decider's heading, wrapped to
    /// [-pi, pi] (radians) — the polar-coordinate half of the slot features.
    pub bearing_rel_rad: f32,
    /// Trailing-streak speed estimate (kt); `None` when the streak is too
    /// short to differentiate (E6 gap semantics — never across a gap).
    pub speed_kt: Option<f32>,
    /// HP fraction vs the entity's FIRST observed HP sample (a max-HP proxy —
    /// the stream carries no max), clamped to [0, 1]; `None` without HP data.
    pub hp_frac: Option<f32>,
    /// Age of the entity's last position sample at t (seconds).
    pub obs_age_s: f32,
    pub observed_now: bool,
    /// Terrain-LOS verdict from the E4 raster at the decider's eye height —
    /// only observed-now enemies get one (E6 semantics); `None` without a
    /// grid or for stale/friendly slots.
    pub terrain_blocked: Option<bool>,
    // ── feature v2 (E14) additions; serde defaults keep the JSON shape
    //    additive (v1 datasets simply lack the keys) ──
    /// EXPLICIT spotted verdict from the E11 minimap-vision stream at t —
    /// the dual track next to the gap-inferred `observed_now` (the model
    /// chooses which to trust; this one can CORRECT the inference, e.g.
    /// radar lighting a ship whose position track went stale). `None` when
    /// the replay has no vision stream or the entity never appeared in it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spotted_now: Option<bool>,
    /// The entity's LAST-KNOWN position sits inside an active smoke cloud
    /// (E8 geometry; a stale track inside a cloud is exactly the "gone dark
    /// in smoke" signal).
    #[serde(default)]
    pub inside_smoke: bool,
    /// ENEMY slots only: a recorder-side radar holder's last-known position
    /// is within the nominal 12 km radar range of this entity — the
    /// "possibly radar-lit" possibility flag (build data is has-radar, not
    /// activation; see [`RADAR_NOMINAL_RANGE_M`]).
    #[serde(default)]
    pub radar_lit: bool,
    /// Slot side marker: v1's layout concatenated enemy+friend slots with
    /// no explicit flag (only the terrain sentinel implicitly separated
    /// them) — an explicit marker is cheaper than inferring it.
    #[serde(default)]
    pub is_enemy: bool,
    /// Engine output level at t from the E11 property stream, tenths of
    /// maximum → [0, 1]; `None` without engine samples for the entity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_power_frac: Option<f32>,
}

/// Feature fields shared by every decision-dataset row family (E16): the
/// metadata, own/global features and entity slots of one decider's
/// observable tick state at `t` — everything
/// [`build_decision_row_core`] computes. Flattened into
/// [`FireDatasetRow`] (fire labels + outcome fields) and [`MoveDatasetRow`]
/// (movement labels); flatten does not rename keys, so the fire JSON
/// schema stays byte-compatible with the pre-E16 export.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionRowCore {
    // ── metadata ──
    /// Replay identity for the training side's per-replay grouping
    /// (GroupKFold over replays — entity ids REPEAT across replays, so
    /// `ownerEntityId` must never be the group key). `None` keeps the E9
    /// single-replay export shape forward-compatible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay_id: Option<String>,
    pub replay_version: Option<String>,
    pub map_name: Option<String>,
    pub owner_entity_id: i32,
    pub ship_id: Option<i64>,
    /// Recorder-relative team of the decider (0 = recorder side, 1 = enemy).
    pub team_id: i8,
    /// Decision time (seconds since match start).
    pub t: f32,
    // ── own/global features (the "own ship" is the decider itself) ──
    pub own_speed_kt: Option<f32>,
    pub own_hp_frac: Option<f32>,
    /// `(t - last main salvo) / estimated reload`, clamped to [0, 1]; 1.0
    /// before the first salvo (guns spawn loaded).
    pub own_reload_frac: f32,
    /// Engagement range used by the eligibility test (metres).
    pub own_range_m: f32,
    /// Zone counts at t. NOTE: zone owner values are in the game's absolute
    /// team namespace (cap_samples 0/1/2 + other), NOT recorder-relative —
    /// they are emitted verbatim; the own/enemy mapping is left to training.
    pub zones_owned_0: u32,
    pub zones_owned_1: u32,
    pub zones_owned_2: u32,
    pub zones_owned_other: u32,
    /// Zones with a capture progress strictly inside (0, 1) at t.
    pub zones_active_progress: u32,
    /// Combat-event counts in the trailing 30 s window at t.
    pub events_shells_30s: u32,
    pub events_torps_30s: u32,
    pub events_explosions_30s: u32,
    pub events_explosions_near_30s: u32,
    // ── entity slots (fixed max length; shorter = padding on the consumer) ──
    pub enemies: Vec<FireDatasetSlot>,
    pub friends: Vec<FireDatasetSlot>,
    /// Descriptor header `matchGroup` (pvp / ranked / brawl / …) — row-level
    /// mode metadata next to `replayId` so ops / bot modes can be tagged and
    /// excluded on the training side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_mode: Option<String>,
    // ── feature v2 (E14) additions ──
    /// Feature schema version (see [`FEATURE_VERSION`]); v1 datasets carry
    /// no key and the training side reads them as 1.
    #[serde(default = "default_feature_version")]
    pub feature_version: u32,
    /// Decider's damage-control window remaining fraction at t (0 inactive,
    /// (0,1] while the ~5 s immunity runs); **-1 when the replay has no E11
    /// consumable stream** (non-15.8 versions).
    #[serde(default)]
    pub own_damcon_frac: f32,
    /// Same for the repair-party window (~28 s); -1 = stream unavailable.
    #[serde(default)]
    pub own_repair_frac: f32,
    /// Max remaining fraction of any OTHER consumable window (radar / hydro
    /// / boost / fighter — the raw ids beyond 0 and 8 are unnamed, E11);
    /// -1 = stream unavailable.
    #[serde(default)]
    pub own_other_consumable_frac: f32,
    /// Decider's engine output level at t (tenths of max → [0, 1]); -1 when
    /// the replay has no engine stream.
    #[serde(default)]
    pub own_engine_power: f32,
    /// Decider's engine force direction at t: +1 driving, -1 braking /
    /// astern, 0 unknown (the two real values are exactly ±1).
    #[serde(default)]
    pub own_engine_dir: f32,
    /// The decider's last-known position sits inside an active smoke cloud.
    #[serde(default)]
    pub own_in_smoke: bool,
    /// Clouds active at t, count normalized `min(count / 8, 1)`.
    #[serde(default)]
    pub active_smoke_count_frac: f32,
    /// Total active-cloud area (km², overlaps not merged) through
    /// `log1p(·)/3` — bounded in practice (10 clouds ≈ 1.3).
    #[serde(default)]
    pub active_smoke_area_feat: f32,
    /// Lerped ship-spotting cap at t from the weather (cyclone) timeline,
    /// as a fraction of the unrestricted 60 km cap (1.0 = clear; ~0.13 at
    /// full 8 km cyclone).
    #[serde(default = "default_vision_cap_frac")]
    pub vision_cap_frac: f32,
    /// Restrictive-weather approach ramp at t: the closest pending
    /// announcement ramps 0→1 over its final 300 s.
    #[serde(default)]
    pub weather_incoming_frac: f32,
    /// Teammates of the decider (recorder-side builds only — the stream
    /// never carries enemy builds, so deciders on the OTHER side report -1)
    /// whose build mounts radar, `min(count / 4, 1)`; -1 = builds
    /// unavailable (pre-15.9 replays / enemy-side deciders).
    #[serde(default = "default_unknown_frac")]
    pub ally_radar_count_frac: f32,
    /// Same for hydroacoustic builds.
    #[serde(default = "default_unknown_frac")]
    pub ally_hydro_count_frac: f32,
    /// Whether this replay decodes the E11 event streams at all (15.8.x):
    /// gates the -1 sentinels above ("unknown") against 0 ("known
    /// inactive").
    #[serde(default)]
    pub e11_events_known: bool,
}

/// One exported fire-decision point (one JSONL line): the shared feature
/// core plus the two-head labels from research note B:
///   labelA "physically can fire" — hard rule: the main-battery reload
///        completes within the label window AND an observed-now enemy sits
///        inside the decider's own engagement range (exactly the E7
///        eligibility test, so labelA rows == E7's eligible count);
///   labelB "expert fired"        — a MAIN-battery salvo starts in
///        (t, t+label_window]; censored (None) whenever labelA is false
///        (a hold during reload is not a decision, it is physics).
/// Rows with labelA=0 are exported TOO: head A needs negatives, head B's loss
/// masks them out on the training side.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FireDatasetRow {
    #[serde(flatten)]
    pub core: DecisionRowCore,
    // ── labels ──
    pub label_a_can_fire: bool,
    /// `None` (censored) whenever `label_a_can_fire` is false.
    pub label_b_fired: Option<bool>,
    // ── outcome fields (E13): post-decision results over
    //    (t + label_window, t + OUTCOME_WINDOW_S]; serde defaults keep the
    //    JSON shape additive (older datasets simply lack the keys) ──
    /// The decider's server-confirmed hits (`shotKills` events owned by the
    /// decider — any weapon: main, secondary, torpedoes; the hit counter
    /// semantics, not the salvo semantics).
    #[serde(default)]
    pub owner_shots_hit: u32,
    /// The decider's MAIN-battery ground-shell launches in the window — the
    /// hit-rate denominator (`ownerShotsHit / ownerShotsFired` is the
    /// player-accuracy proxy; secondary/AI fire excluded on both sides is
    /// not possible for `hit`, which is noted here once).
    #[serde(default)]
    pub owner_shots_fired: u32,
    /// Enemy HP drops in the window covered by at least one of the decider's
    /// impacts within the attribution radius — the FULL window total, NOT
    /// the #1418 even split among covering impacts: crossfiring attackers
    /// each get the whole drop in their own row. Deliberate simplification
    /// (see module docs): these fields rank decision moments against each
    /// other, they are not a damage ledger, so the shared-drop inflation
    /// applies uniformly across rows and deciles. vs the #1418 calibration
    /// (dealt ledger 0.62x of server damage) this over-counts crossfire and
    /// under-counts nothing else — the real-replay test reports the ratio.
    #[serde(default)]
    pub enemy_hp_lost_nearby: f32,
    // ── hit-conditioned labels (E15) ──
    /// "Fired AND the outcome window landed at least one server-confirmed
    /// hit": the plain label sharpened by the post-decision outcome. Censored
    /// exactly like `label_b_fired` (None whenever labelA is false).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_b_hit: Option<bool>,
    /// Outcome-smoothed fire label: fired∧hit → 1.0, fired∧missed → 0.3,
    /// held → 0.0 (0.3 + 0.7·hit — the brief's form; see the E15 module
    /// docs for the rationale). Censored with labelA.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_b_soft: Option<f32>,
}

fn default_feature_version() -> u32 {
    1
}

fn default_vision_cap_frac() -> f32 {
    1.0
}

fn default_unknown_frac() -> f32 {
    -1.0
}

/// Export totals (one per replay).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FireDatasetExportStats {
    pub owners: usize,
    pub rows: usize,
    /// Rows with labelA=1 — must equal E7's `total_eligible_with_history`.
    pub rows_can_fire: usize,
    /// Rows with labelB=1 (a main-battery salvo in the label window).
    pub rows_fired: usize,
    pub positive_rate_among_can_fire: f32,
}

/// HP fraction at `t` vs the entity's first observed HP sample (max proxy).
fn hp_frac_at(traj: &wowsp_tauri_shared::EntityTrajectory, t: f32) -> Option<f32> {
    let first = traj.hp_samples.first()?;
    let cur = traj.hp_samples.iter().rev().find(|s| s.time <= t)?;
    if first.value == 0 {
        return None;
    }
    Some((cur.value as f32 / first.value as f32).clamp(0.0, 1.0))
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

/// Build the enemy or friend slot list for one decider position at `t`.
/// Candidates: ships with a KNOWN team on the queried side that have been
/// observed at least once by t and are alive at t. Ordering: observed-now
/// first, then stale, each by ascending distance; truncated to `max_slots`.
#[allow(clippy::too_many_arguments)]
fn build_slots(
    stream: &ReplayStream,
    decider: &ShipInfo<'_>,
    ships: &[ShipInfo<'_>],
    own: &PositionSample,
    t: f32,
    los: Option<&LosGrid>,
    eye_height: f32,
    enemy_side: bool,
    max_slots: usize,
    idx: &FeatureIndex<'_>,
    active: &[ActiveSmoke],
) -> Vec<FireDatasetSlot> {
    let mut candidates: Vec<(bool, f32, &ShipInfo<'_>, &PositionSample)> = Vec::new();
    for other in ships {
        if other.traj.entity_id == decider.traj.entity_id {
            continue;
        }
        let Some(team) = other.team_id else {
            continue;
        };
        let is_side = if enemy_side {
            team != decider.team_id.unwrap_or(0)
        } else {
            team == decider.team_id.unwrap_or(-1)
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
            // Bearing convention matches `bearing_offset_deg`: atan2(dz, dx).
            let bearing = (last.z - own.z).atan2(last.x - own.x);
            let terrain_blocked = if enemy_side && t - last.time <= GAP_THRESHOLD {
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
            let (engine_power, _engine_dir) = idx.engine_at(other.traj.entity_id, t);
            FireDatasetSlot {
                entity_id: other.traj.entity_id,
                entity_type: other.traj.kind.as_ref().map_or(-1, |k| k.entity_type),
                ship_id: other.traj.kind.as_ref().and_then(|k| k.ship_id),
                dist_m,
                bearing_rel_rad: wrap_angle(bearing - own.yaw),
                speed_kt: trailing_speed_kt(ships, other.traj.entity_id, t),
                hp_frac: hp_frac_at(other.traj, t),
                obs_age_s: t - last.time,
                observed_now: t - last.time <= GAP_THRESHOLD,
                terrain_blocked,
                spotted_now: idx.spotted_at(other.traj.entity_id, t),
                inside_smoke: inside_any_smoke(last.x, last.z, active),
                radar_lit: enemy_side
                    && decider.team_id == Some(0)
                    && idx.radar_lit(stream, last.x, last.z, t, true),
                is_enemy: enemy_side,
                engine_power_frac: engine_power,
            }
        })
        .collect()
}

/// Zone + trailing-event summary at `t` (E6 semantics, decider-centric).
fn zone_and_event_summary(
    stream: &ReplayStream,
    own: &PositionSample,
    t: f32,
) -> (u32, u32, u32, u32, u32, u32, u32, u32, u32) {
    let (mut z0, mut z1, mut z2, mut zo, mut zp) = (0u32, 0u32, 0u32, 0u32, 0u32);
    for traj in &stream.trajectories {
        let Some(kind) = traj.kind.as_ref() else {
            continue;
        };
        if !EXPORT_ZONE_TYPES.contains(&kind.entity_type) {
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
            Some(0) => z0 += 1,
            Some(1) => z1 += 1,
            Some(2) => z2 += 1,
            Some(_) => zo += 1,
            None => {},
        }
        if let Some(p) = traj.cap_progress.iter().rev().find(|s| s.time <= t) {
            if p.value > 0 && p.value < 1000 {
                zp += 1;
            }
        }
    }
    let in_window = |tt: f32| tt > t - EXPORT_EVENT_WINDOW_S && tt <= t;
    let near_units = EXPORT_EXPLOSION_NEAR_RADIUS_M / METERS_PER_UNIT;
    let shells = stream
        .shell_launches
        .iter()
        .filter(|e| in_window(e.time))
        .count() as u32;
    let torps = stream
        .torpedoes
        .iter()
        .filter(|e| in_window(e.time))
        .count() as u32;
    let explosions = stream
        .explosions
        .iter()
        .filter(|e| in_window(e.time))
        .count() as u32;
    let near = stream
        .explosions
        .iter()
        .filter(|e| in_window(e.time) && (e.x - own.x).hypot(e.z - own.z) <= near_units)
        .count() as u32;
    (z0, z1, z2, zo, zp, shells, torps, explosions, near)
}

/// Decider-constant ally radar/hydro fractions (E14, extracted for E16):
/// recorder-side builds only (enemy builds never ride the stream), so
/// deciders on the recorder's side get counts of their TEAMMATES and
/// enemy-side deciders get the unknown sentinel. A replay that decoded NO
/// builds at all (the shipConfig layout is pinned to 15.9.x) is unknown for
/// EVERYONE — an empty holder set must not masquerade as "no radar".
fn ally_build_fracs(idx: &FeatureIndex<'_>, ship: &ShipInfo<'_>) -> (f32, f32) {
    if !idx.builds_decoded {
        return (-1.0, -1.0);
    }
    if ship.team_id == Some(0) {
        let id = ship.traj.entity_id;
        let r = idx.radar_holders.iter().filter(|&&aid| aid != id).count();
        let h = idx.hydro_holders.iter().filter(|&&aid| aid != id).count();
        ((r.min(4) as f32 / 4.0), (h.min(4) as f32 / 4.0))
    } else {
        (-1.0, -1.0)
    }
}

/// Build the family-independent feature core of one decision row (E16
/// extraction): every field of [`DecisionRowCore`] for one decider position
/// `own` at time `t`. The fire and movement exporters pass their own
/// `reload_frac` / `range_m` (both fire-context derived but defined for
/// every ship — never-fired hulls report loaded guns and the fallback range)
/// and the per-ship ally-build fractions; everything else is computed here
/// exactly as the pre-E16 inline code did (value-compatible by
/// construction — `decision_serve`'s parity test guards it).
#[allow(clippy::too_many_arguments)]
fn build_decision_row_core(
    stream: &ReplayStream,
    ships: &[ShipInfo<'_>],
    ship: &ShipInfo<'_>,
    own: &PositionSample,
    t: f32,
    los: Option<&LosGrid>,
    eye_height: f32,
    reload_frac: f32,
    range_m: f32,
    ally_radar: f32,
    ally_hydro: f32,
    replay_id: Option<&str>,
    game_mode: Option<&str>,
    events: &FeatureEvents<'_>,
    idx: &FeatureIndex<'_>,
) -> DecisionRowCore {
    let (z0, z1, z2, zo, zp, shells, torps, expl, near) = zone_and_event_summary(stream, own, t);
    let active = active_smokes_at(stream, events.smokes, t);
    let (own_engine_power, own_engine_dir) = idx.engine_at(ship.traj.entity_id, t);
    DecisionRowCore {
        replay_id: replay_id.map(str::to_string),
        replay_version: stream.version.clone(),
        map_name: stream.map_name.clone(),
        owner_entity_id: ship.traj.entity_id,
        ship_id: ship.traj.kind.as_ref().and_then(|k| k.ship_id),
        team_id: ship.team_id.unwrap_or(-1),
        t,
        own_speed_kt: trailing_speed_kt(ships, ship.traj.entity_id, t),
        own_hp_frac: hp_frac_at(ship.traj, t),
        own_reload_frac: reload_frac,
        own_range_m: range_m,
        zones_owned_0: z0,
        zones_owned_1: z1,
        zones_owned_2: z2,
        zones_owned_other: zo,
        zones_active_progress: zp,
        events_shells_30s: shells,
        events_torps_30s: torps,
        events_explosions_30s: expl,
        events_explosions_near_30s: near,
        enemies: build_slots(
            stream,
            ship,
            ships,
            own,
            t,
            los,
            eye_height,
            true,
            ENEMY_SLOTS,
            idx,
            &active,
        ),
        friends: build_slots(
            stream,
            ship,
            ships,
            own,
            t,
            los,
            eye_height,
            false,
            FRIEND_SLOTS,
            idx,
            &active,
        ),
        game_mode: game_mode.map(str::to_string),
        feature_version: FEATURE_VERSION,
        own_damcon_frac: consumable_frac_or_unknown(
            idx,
            events.e11_known,
            ship.traj.entity_id,
            t,
            Some(CONSUMABLE_ID_DAMCON),
        ),
        own_repair_frac: consumable_frac_or_unknown(
            idx,
            events.e11_known,
            ship.traj.entity_id,
            t,
            Some(CONSUMABLE_ID_REPAIR),
        ),
        own_other_consumable_frac: consumable_frac_or_unknown(
            idx,
            events.e11_known,
            ship.traj.entity_id,
            t,
            None,
        ),
        own_engine_power: own_engine_power.unwrap_or(-1.0),
        own_engine_dir: own_engine_dir.unwrap_or(0.0),
        own_in_smoke: inside_any_smoke(own.x, own.z, &active),
        active_smoke_count_frac: (active.len() as f32 / 8.0).min(1.0),
        active_smoke_area_feat: (active_smoke_area_km2(&active) + 1.0).ln() / 3.0,
        vision_cap_frac: (idx.vision_cap_m(t) / (WEATHER_DEFAULT_CAP_UNITS * METERS_PER_GP_UNIT))
            .clamp(0.0, 1.0),
        weather_incoming_frac: idx.weather_incoming_frac(t),
        ally_radar_count_frac: ally_radar,
        ally_hydro_count_frac: ally_hydro,
        e11_events_known: events.e11_known,
    }
}

// ── E13 outcome fields: post-decision hit / damage statistics ────────────────

/// One hull-HP drop between consecutive HP samples (the attribution budget's
/// unit — #1418 semantics: only drops ≥ the noise floor count; heals never
/// produce drops).
#[derive(Debug, Clone, Copy)]
struct HpDrop {
    time: f32,
    delta: f32,
}

/// Precomputed per-replay outcome substrate (E13): time-sorted hit-impact and
/// main-shell timelines per owner plus HP-drop timelines per hull, so each
/// decision row's window query is two binary searches and a short scan.
struct OutcomeContext<'a> {
    /// `shotKills` events per owner (any weapon — the hit counter).
    impacts_by_owner: BTreeMap<i32, Vec<&'a ShotKillEvent>>,
    /// Main-battery ground-shell launch times per owner (hit-rate denominator).
    main_shells_by_owner: BTreeMap<i32, Vec<f32>>,
    /// HP drops per entity id (both teams — the row query filters enemies).
    drops_by_entity: BTreeMap<i32, Vec<HpDrop>>,
}

fn build_outcome_context(stream: &ReplayStream) -> OutcomeContext<'_> {
    let mut impacts_by_owner: BTreeMap<i32, Vec<&ShotKillEvent>> = BTreeMap::new();
    for k in &stream.shot_kills {
        impacts_by_owner.entry(k.owner_id).or_default().push(k);
    }
    for v in impacts_by_owner.values_mut() {
        v.sort_by(|a, b| {
            a.time
                .partial_cmp(&b.time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    let mut main_shells_by_owner: BTreeMap<i32, Vec<f32>> = BTreeMap::new();
    for s in &stream.shell_launches {
        if s.y < AIRBORNE_MUZZLE_Y_UNITS && s.gun_barrel_id < MAIN_BATTERY_MAX_BARREL_ID {
            main_shells_by_owner
                .entry(s.owner_id)
                .or_default()
                .push(s.time);
        }
    }
    for v in main_shells_by_owner.values_mut() {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    }
    let mut drops_by_entity: BTreeMap<i32, Vec<HpDrop>> = BTreeMap::new();
    for traj in &stream.trajectories {
        let mut drops = Vec::new();
        for w in traj.hp_samples.windows(2) {
            let delta = w[0].value.saturating_sub(w[1].value);
            if delta >= OUTCOME_HP_MIN_DELTA {
                drops.push(HpDrop {
                    time: w[1].time,
                    delta: delta as f32,
                });
            }
        }
        drops_by_entity.insert(traj.entity_id, drops);
    }
    OutcomeContext {
        impacts_by_owner,
        main_shells_by_owner,
        drops_by_entity,
    }
}

/// Planar position of one trajectory at time `t` (linear interpolation,
/// clamped at both ends — the reference implementation's `sampleAtTraj`;
/// `None` when the entity has no samples at all).
fn position_at(traj: &EntityTrajectory, t: f32) -> Option<(f32, f32)> {
    let ss = &traj.samples;
    if ss.is_empty() {
        return None;
    }
    let hi = ss.partition_point(|s| s.time < t).min(ss.len() - 1);
    let lo = hi.saturating_sub(1);
    let (a, b) = (&ss[lo], &ss[hi]);
    let f = if b.time <= a.time {
        0.0
    } else {
        ((t - a.time) / (b.time - a.time)).clamp(0.0, 1.0)
    };
    Some((a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f))
}

/// The three numeric outcome fields for one decision row (E13): hits, main
/// shells fired, and enemy HP lost near the decider's impacts, all over
/// `(t + label_window, t + OUTCOME_WINDOW_S]`.
fn outcome_fields(
    ctx: &OutcomeContext<'_>,
    decider: &ShipInfo<'_>,
    ships: &[ShipInfo<'_>],
    t: f32,
    label_window_s: f32,
) -> (u32, u32, f32) {
    let w0 = t + label_window_s;
    let w1 = t + OUTCOME_WINDOW_S;
    if w1 <= w0 {
        return (0, 0, 0.0);
    }
    let id = decider.traj.entity_id;
    let fired = ctx.main_shells_by_owner.get(&id).map_or(0, |times| {
        times.partition_point(|x| *x <= w1) - times.partition_point(|x| *x <= w0)
    }) as u32;
    let empty_impacts: [&ShotKillEvent; 0] = [];
    let impacts = ctx
        .impacts_by_owner
        .get(&id)
        .map_or(&empty_impacts[..], |v| v.as_slice());
    let imp0 = impacts.partition_point(|k| k.time <= w0);
    let imp1 = impacts.partition_point(|k| k.time <= w1);
    let hit = (imp1 - imp0) as u32;
    // Enemy HP lost near the decider's impacts: for every enemy hull's drop
    // in the window, full credit when any of the window's impacts covers the
    // drop (±0.4/0.6 s envelope) and sat within the attribution radius of
    // the hull at the impact time. No even split — see the struct docs.
    let mut hp_lost = 0.0f32;
    let window_impacts = &impacts[imp0..imp1];
    if !window_impacts.is_empty() {
        for other in ships {
            if other.traj.entity_id == id
                || other.team_id.is_none()
                || other.team_ambiguous
                || other.team_id == decider.team_id
            {
                continue;
            }
            let Some(drops) = ctx.drops_by_entity.get(&other.traj.entity_id) else {
                continue;
            };
            let d0 = drops.partition_point(|d| d.time <= w0);
            let d1 = drops.partition_point(|d| d.time <= w1);
            for drop in &drops[d0..d1] {
                // Covering impacts: drop.time in (imp.time - BEFORE, imp.time + AFTER]
                // <=> imp.time in [drop.time - AFTER, drop.time + BEFORE).
                let covered = window_impacts.iter().any(|k| {
                    k.time >= drop.time - OUTCOME_HP_AFTER_S
                        && k.time < drop.time + OUTCOME_HP_BEFORE_S
                        && position_at(other.traj, k.time).is_some_and(|(vx, vz)| {
                            (vx - k.x).hypot(vz - k.z) <= OUTCOME_HIT_RADIUS_UNITS
                        })
                });
                if covered {
                    hp_lost += drop.delta; // full credit once per drop
                }
            }
        }
    }
    (hit, fired, hp_lost)
}

/// Read the descriptor header's `matchGroup` (the row-level game-mode tag,
/// E13) from a replay file — a bounded prefix read: the descriptor is the
/// first block, far under 64 KiB, so the multi-MB payload is never touched.
fn read_game_mode(path: &std::path::Path) -> Option<String> {
    use std::io::Read;
    // Loop until full or EOF: File::read may short-read, and the descriptor
    // being the first block must not depend on the OS filling the buffer.
    let mut buf = vec![0u8; 64 * 1024];
    let mut f = std::fs::File::open(path).ok()?;
    let mut n = 0usize;
    while n < buf.len() {
        match f.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(_) => break,
        }
    }
    buf.truncate(n);
    let json = wowsp_replay_core::meta::extract_descriptor_json(&buf)?;
    let raw: serde_json::Value = serde_json::from_str(&json).ok()?;
    raw.get("matchGroup")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// Build every exportable decision row of the replay (E9 step 1). The decider
/// set is ships with a fire history and a known team; rows follow the E7
/// cadence/gates exactly so `rows_can_fire` reproduces E7's eligible count.
/// `replay_id` (E12) tags every row with the replay's identity for
/// per-replay grouping on the training side — `None` preserves the E9 shape.
/// `game_mode` (E13) carries the descriptor header's `matchGroup` as row-level
/// mode metadata (ops/bot tagging on the training side); `None` keeps the
/// pre-E13 shape. `events` (E14) supplies the feature-v2 sources (explicit
/// vision / consumables / engine / smoke lifecycles).
#[allow(clippy::too_many_arguments)]
pub fn export_decision_dataset(
    stream: &ReplayStream,
    ships: &[ShipInfo<'_>],
    los: Option<&LosGrid>,
    eye_height: f32,
    params: &FireSampleParams,
    replay_id: Option<&str>,
    game_mode: Option<&str>,
    events: &FeatureEvents<'_>,
) -> (Vec<FireDatasetRow>, FireDatasetExportStats) {
    let contexts = fire_contexts(stream, ships, params);
    let outcomes = build_outcome_context(stream);
    let idx = build_feature_index(
        events,
        &stream.ally_builds,
        &stream.weather_transitions,
        &stream.weather_notifications,
    );
    let mut rows = Vec::new();
    let mut owners = 0usize;
    for ship in ships {
        if ship.team_ambiguous || ship.team_id.is_none() {
            continue;
        }
        let id = ship.traj.entity_id;
        let Some(ctx) = contexts.get(&id) else {
            continue;
        };
        if !ctx.has_fire_history {
            continue;
        }
        owners += 1;
        // Ally radar/hydro counts are decider-constant (E14): recorder-side
        // builds only, enemy-side deciders get the unknown sentinel.
        let (ally_radar, ally_hydro) = ally_build_fracs(&idx, ship);
        let (from, to) = alive_window(ship);
        let mut t = from + 5.0;
        while t <= to {
            // Own state must be observable (recorder view) — the E7 gate.
            let Some(own) = last_sample_before(&ship.traj.samples, t) else {
                t += params.decision_interval_s;
                continue;
            };
            if t - own.time > GAP_THRESHOLD {
                t += params.decision_interval_s;
                continue;
            }
            // labelA = the E7 eligibility test verbatim: reload completes
            // within the label window AND an observed-now enemy is in range.
            let effective_reload = (ctx.reload_s - params.decision_interval_s).max(0.0);
            let is_reloaded = !ctx
                .salvos
                .iter()
                .filter(|s| s.main_battery)
                .any(|s| s.start <= t && t - s.start < effective_reload);
            let has_target = nearest_enemy(ship, ships, own, t, ctx.range_m).is_some();
            let label_a = is_reloaded && has_target;
            // labelB: MAIN battery only, salvo starts in (t, t+label_window].
            let label_b = label_a.then(|| {
                ctx.salvos
                    .iter()
                    .filter(|s| s.main_battery)
                    .any(|s| s.start > t && s.start <= t + params.label_window_s)
            });
            let last_main_salvo = ctx
                .salvos
                .iter()
                .rfind(|s| s.main_battery && s.start <= t)
                .map(|s| s.start);
            let reload_frac = match last_main_salvo {
                Some(s) => ((t - s) / ctx.reload_s.max(0.001)).clamp(0.0, 1.0),
                None => 1.0, // guns spawn loaded
            };
            let (out_hit, out_fired, out_hp_lost) =
                outcome_fields(&outcomes, ship, ships, t, params.label_window_s);
            let core = build_decision_row_core(
                stream,
                ships,
                ship,
                own,
                t,
                los,
                eye_height,
                reload_frac,
                ctx.range_m,
                ally_radar,
                ally_hydro,
                replay_id,
                game_mode,
                events,
                &idx,
            );
            rows.push(FireDatasetRow {
                core,
                label_a_can_fire: label_a,
                label_b_fired: label_b,
                owner_shots_hit: out_hit,
                owner_shots_fired: out_fired,
                enemy_hp_lost_nearby: out_hp_lost,
                label_b_hit: label_b.map(|fired| fired && out_hit > 0),
                label_b_soft: label_b.map(|fired| {
                    if fired {
                        if out_hit > 0 { 1.0 } else { 0.3 }
                    } else {
                        0.0
                    }
                }),
            });
            t += params.decision_interval_s;
        }
    }
    let rows_can_fire = rows.iter().filter(|r| r.label_a_can_fire).count();
    let rows_fired = rows
        .iter()
        .filter(|r| r.label_b_fired == Some(true))
        .count();
    let stats = FireDatasetExportStats {
        owners,
        rows: rows.len(),
        rows_can_fire,
        rows_fired,
        positive_rate_among_can_fire: if rows_can_fire == 0 {
            0.0
        } else {
            rows_fired as f32 / rows_can_fire as f32
        },
    };
    (rows, stats)
}

// ── E12 / G2: folder → dataset batch ingestion ─────────────────────────────
//
// Scales the E9 single-replay export to "point at a folder, get a dataset":
// every `*.wowsreplay` under the root (recursively — the game nests replays
// by date) is decoded and exported through the same `export_decision_dataset`
// path; single-file failures (unreadable bytes, bad magic, corrupt packet
// stream, unparseable roster, unsupported layouts) are RECORDED PER FILE and
// skipped, never aborting the batch. Per-replay terrain LOS is resolved from
// an optional directory of E4 rasters (`<los_dir>/<map name>/terrain_los.npz`),
// so mixed-map folders degrade per file exactly like a single export without
// a grid.

/// Row contract of the generic batch ingester (E16): the ingester stamps
/// every exported row with the file's replay identity (overriding whatever
/// the per-file export left there) so summary and rows can never disagree.
pub trait BatchRow {
    fn set_replay_id(&mut self, replay_id: String);
}

/// Stats contract of the generic batch ingester: the two aggregates every
/// family's summary counts over successful files.
pub trait BatchStats {
    fn owners(&self) -> usize;
    fn rows(&self) -> usize;
}

/// One file's outcome in a batch ingestion (any dataset family).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DatasetBatchOutcome<S> {
    /// Decoded and exported; `stats` is the file's own export summary.
    Exported { stats: S },
    /// Skipped after `reason` (read/decode/roster error). The batch went on.
    Failed { reason: String },
}

/// One file's record in a batch report (any dataset family).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetBatchFile<S> {
    /// Replay identity = path relative to the batch root with forward
    /// slashes (unique across nested subfolders). This is the GroupKFold
    /// grouping key on the training side.
    pub replay_id: String,
    /// File name without directory components (for human-readable reports).
    pub file_name: String,
    pub outcome: DatasetBatchOutcome<S>,
}

/// Fire-flavoured batch records (pre-E16 names kept for the fire tests).
pub type FireDatasetBatchOutcome = DatasetBatchOutcome<FireDatasetExportStats>;
pub type FireDatasetBatchFile = DatasetBatchFile<FireDatasetExportStats>;

/// Aggregate summary of one batch ingestion.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FireDatasetBatchSummary {
    pub root_dir: String,
    /// `*.wowsreplay` files found under the root (live `temp.wowsreplay`
    /// excluded, mirroring the replay listing walk).
    pub files_seen: usize,
    pub files_exported: usize,
    pub files_failed: usize,
    /// Summed over exported files.
    pub deciders: usize,
    pub rows: usize,
    pub rows_can_fire: usize,
    pub rows_fired: usize,
    pub positive_rate_among_can_fire: f32,
    pub per_file: Vec<FireDatasetBatchFile>,
}

/// Fault-tolerant ingestion core shared by every dataset family (E12 fire →
/// E16 movement): each `files` entry is processed with `process`; success
/// contributes its rows (stamped with the file's `replay_id` — overriding
/// whatever the closure left there — so summary and rows can never
/// disagree), failure is recorded and the batch CONTINUES. Split from the
/// family-specific summaries so new label families reuse the tolerance core
/// unchanged (unit-testable without real replay bytes). Emits one live
/// progress line per file — hour-long corpora need visible progress under
/// `--nocapture`.
pub fn ingest_batch_files<R, S, I, F>(
    root: &std::path::Path,
    files: I,
    mut process: F,
) -> (Vec<R>, Vec<DatasetBatchFile<S>>)
where
    R: BatchRow,
    S: BatchStats,
    I: IntoIterator<Item = std::path::PathBuf>,
    F: FnMut(&std::path::Path) -> anyhow::Result<(Vec<R>, S)>,
{
    let mut rows = Vec::new();
    let mut per_file = Vec::new();
    for path in files {
        let replay_id = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned()
            .replace('\\', "/");
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| replay_id.clone());
        let outcome = match process(&path) {
            Ok((mut file_rows, stats)) => {
                for r in &mut file_rows {
                    r.set_replay_id(replay_id.clone());
                }
                eprintln!(
                    "[batch] {} -> {} rows, {} owners",
                    replay_id,
                    stats.rows(),
                    stats.owners()
                );
                rows.extend(file_rows);
                DatasetBatchOutcome::Exported { stats }
            },
            Err(e) => {
                eprintln!("[batch] {} -> FAILED: {}", replay_id, e);
                DatasetBatchOutcome::Failed {
                    reason: e.to_string(),
                }
            },
        };
        per_file.push(DatasetBatchFile {
            replay_id,
            file_name,
            outcome,
        });
    }
    (rows, per_file)
}

/// Fire-family wrapper (E12): aggregates the generic per-file records into
/// the fire batch summary (rows_can_fire / rows_fired totals).
pub fn ingest_replay_files<I, F>(
    root: &std::path::Path,
    files: I,
    process: F,
) -> (Vec<FireDatasetRow>, FireDatasetBatchSummary)
where
    I: IntoIterator<Item = std::path::PathBuf>,
    F: FnMut(&std::path::Path) -> anyhow::Result<(Vec<FireDatasetRow>, FireDatasetExportStats)>,
{
    let (rows, per_file) =
        ingest_batch_files::<FireDatasetRow, FireDatasetExportStats, I, F>(root, files, process);
    let mut summary = FireDatasetBatchSummary {
        root_dir: root.to_string_lossy().into_owned(),
        files_seen: per_file.len(),
        files_exported: 0,
        files_failed: 0,
        deciders: 0,
        rows: 0,
        rows_can_fire: 0,
        rows_fired: 0,
        positive_rate_among_can_fire: 0.0,
        per_file: Vec::new(),
    };
    for f in per_file {
        let DatasetBatchFile {
            replay_id,
            file_name,
            outcome,
        } = f;
        let outcome = match outcome {
            DatasetBatchOutcome::Exported { stats } => {
                summary.files_exported += 1;
                summary.deciders += stats.owners;
                summary.rows += stats.rows;
                summary.rows_can_fire += stats.rows_can_fire;
                summary.rows_fired += stats.rows_fired;
                DatasetBatchOutcome::Exported { stats }
            },
            DatasetBatchOutcome::Failed { reason } => {
                summary.files_failed += 1;
                DatasetBatchOutcome::Failed { reason }
            },
        };
        summary.per_file.push(DatasetBatchFile {
            replay_id,
            file_name,
            outcome,
        });
    }
    summary.positive_rate_among_can_fire = if summary.rows_can_fire == 0 {
        0.0
    } else {
        summary.rows_fired as f32 / summary.rows_can_fire as f32
    };
    (rows, summary)
}

/// Walk `dir` recursively collecting `*.wowsreplay` paths, sorted for
/// deterministic batches. Mirrors the replay-listing walk: the live
/// `temp.wowsreplay` is skipped.
fn collect_replay_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for ent in rd.flatten() {
        let path = ent.path();
        let Ok(meta) = ent.metadata() else {
            continue;
        };
        if meta.is_dir() {
            collect_replay_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("wowsreplay") {
            if path.file_name().and_then(|n| n.to_str()) == Some("temp.wowsreplay") {
                continue;
            }
            out.push(path);
        }
    }
}

/// Per-replay terrain raster for the batch: `<los_dir>/<map short name>/
/// terrain_los.npz` when it exists ("spaces/50_Gold_harbor" →
/// "<los_dir>/50_Gold_harbor/terrain_los.npz"). Absent file / absent map
/// name / unparsable raster → `None` (rows lose only the `terrainBlocked`
/// feature, exactly like a single export without a grid).
fn los_for_replay(map_name: Option<&str>, los_dir: Option<&std::path::Path>) -> Option<LosGrid> {
    let short = map_name?.rsplit('/').next()?.trim();
    if short.is_empty() {
        return None;
    }
    LosGrid::load_npz(&los_dir?.join(short).join("terrain_los.npz")).ok()
}

/// Decode + export ONE replay file (the `process` closure used by
/// [`export_decision_dataset_dir`]). Every failure mode surfaces as
/// `Err(reason)` for the batch to record: unreadable file, bad magic /
/// truncated header (no packet stream), decrypt/inflate/decode errors on
/// corrupt bytes, unparseable roster. Version-drifted replays do NOT land
/// here — the decoder warns and falls back to its closest layout, so they
/// export (with whatever the fallback yields) rather than aborting.
pub fn export_replay_file(
    path: &std::path::Path,
    los_dir: Option<&std::path::Path>,
    eye_height: f32,
    params: &FireSampleParams,
) -> anyhow::Result<(Vec<FireDatasetRow>, FireDatasetExportStats)> {
    let path_str = path.to_string_lossy().into_owned();
    // ONE decode pass carrying the E14 event families alongside the stream
    // (the assemble projection drops vision/consumable/engine/smoke).
    let (stream, ev) = super::replay::decode_replay_stream_with_events(&path_str)?;
    let vehicles = super::replay_probe::read_roster(&path_str)?;
    let ships = ship_infos(&stream, &vehicles);
    let los = los_for_replay(stream.map_name.as_deref(), los_dir);
    let game_mode = read_game_mode(path);
    let events = FeatureEvents::for_version(stream.version.as_deref(), &ev);
    Ok(export_decision_dataset(
        &stream,
        &ships,
        los.as_ref(),
        eye_height,
        params,
        None, // stamped by ingest_replay_files from the path
        game_mode.as_deref(),
        &events,
    ))
}

/// Folder → dataset (E12 / G2). Walks `dir` recursively, exports every
/// `*.wowsreplay` through [`export_replay_file`], aggregates rows and
/// per-file summaries. Fails (Err) only when `dir` itself is unusable — a
/// root that does not exist or is not a directory; everything after that is
/// per-file tolerance.
pub fn export_decision_dataset_dir(
    dir: &std::path::Path,
    los_dir: Option<&std::path::Path>,
    eye_height: f32,
    params: &FireSampleParams,
) -> anyhow::Result<(Vec<FireDatasetRow>, FireDatasetBatchSummary)> {
    if !dir.is_dir() {
        bail!("batch root {} is not a directory", dir.to_string_lossy());
    }
    let mut files = Vec::new();
    collect_replay_files(dir, &mut files);
    files.sort();
    let (rows, summary) = ingest_replay_files(dir, files, |path| {
        export_replay_file(path, los_dir, eye_height, params)
    });
    Ok((rows, summary))
}

// ── E16: movement-decision dataset (G6 step 1) ──────────────────────────────
//
// "Given this tick and this intel, where should each ship go?" — the
// movement twin of the E9 fire export. Supervision is the REALISED
// displacement over a 12 s window: 16 directional sectors of 22.5° each,
// measured in the frame RELATIVE to the decider's heading at the decision
// time (WoWS rudder semantics — "hard to starboard" is a relative command,
// and the label is far more learnable relative: the same island-avoidance
// behaviour is one class instead of sixteen), plus one "no obvious
// movement" class for displacements under 100 m (100 m / 12 s ≈ 16.2 kt —
// a straight-cruising slow ship legitimately lands there; the corpus
// histogram decides whether the threshold is informative, it is not tuned
// here). The serve side recovers the absolute bearing from the live yaw.
//
// Design deltas vs the fire export (why they differ):
//   * DECIDERS: every team-known alive ship — carriers and never-fired
//     hulls INCLUDED (positioning is a universal decision; the fire
//     export's has-fire-history gate exists because reload/range semantics
//     need shells, which movement does not).
//   * CADENCE 4 s (half the fire 2 s): ~22 deciders × ~250 points × 162
//     replays ≈ 0.9 M rows must stay inside the 5 GB JSONL budget.
//   * NO censoring label: nothing about movement is physics-gated, every
//     observable point is a legal decision — except rows whose label
//     WINDOW cannot be observed honestly (decider went dark inside
//     [t+4, t+16] — no trailing sample at an endpoint; the recorder's
//     stream simply has no positions there, and interpolating across a
//     dark gap would fabricate truth). Those are counted as censored and
//     dropped, never faked.
//   * Features: the SAME v2 pipeline (same tick state, same slots) — the
//     E14 lesson applies unchanged, cross-version training must ablate the
//     version-gated families (`--ablate e11` on the training side).
//   * Outcome fields are omitted (row budget; the movement-outcome proxy
//     — does the realised landing point sit near cover / cap / high
//     fire-probability areas — is E17's job).

/// Movement-decision cadence (seconds) — half the fire 2 s cadence, sized
/// for the ~0.9 M-row / 5 GB corpus budget.
pub const MOVE_DECISION_INTERVAL_S: f32 = 4.0;
/// Movement label window start offset: displacement measured from t+4.
pub const MOVE_LABEL_START_S: f32 = 4.0;
/// Movement label window end offset: displacement measured to t+16 (a 12 s
/// window — long enough for a committed turn to show, short enough that the
/// decision at t still dominates it).
pub const MOVE_LABEL_END_S: f32 = 16.0;
/// Directional sector width (radians): 16 sectors over the full circle,
/// relative to the decider's heading at t.
pub const MOVE_SECTOR_RAD: f32 = std::f32::consts::FRAC_PI_8; // 22.5°
/// Total movement-label classes: 16 directional + 1 "no obvious movement".
pub const MOVE_SECTOR_COUNT: usize = 17;
/// The "no obvious movement" class id (displacement below the threshold).
pub const MOVE_SECTOR_NONE: u8 = 16;
/// Displacement below this (metres over the 12 s window) is class
/// [`MOVE_SECTOR_NONE`].
pub const MOVE_NONE_THRESHOLD_M: f32 = 100.0;
/// Freshness tolerance for a label-endpoint position sample (seconds): a
/// window endpoint with no trailing sample at most this old sits inside an
/// observation gap — no honest ground truth, the row is censored.
const MOVE_ENDPOINT_TOL_S: f32 = 2.0;

impl BatchRow for FireDatasetRow {
    fn set_replay_id(&mut self, replay_id: String) {
        self.core.replay_id = Some(replay_id);
    }
}

/// Field-access compatibility for pre-E16 consumers (the decision_serve
/// parity test and the fire tests read `row.owner_entity_id` & co.
/// flatly): every feature field lives on the core, and auto-deref keeps
/// those reads working without touching the read-only consumers. New code
/// should prefer the explicit `row.core.…` path.
impl std::ops::Deref for FireDatasetRow {
    type Target = DecisionRowCore;

    fn deref(&self) -> &DecisionRowCore {
        &self.core
    }
}

impl BatchStats for FireDatasetExportStats {
    fn owners(&self) -> usize {
        self.owners
    }

    fn rows(&self) -> usize {
        self.rows
    }
}

/// The 17-class movement label (E16). Sector k = round(rel / 22.5°) mod 16
/// — sector 0 dead ahead (±11.25°), 8 dead astern, halves round AWAY FROM
/// ZERO so a displacement exactly on a 22.5° boundary lands in the boundary
/// sector (deterministic, tested). Displacement under the no-move threshold
/// short-circuits to class 16 regardless of bearing.
pub fn move_sector_label(rel_bearing_rad: f32, moved_dist_m: f32) -> u8 {
    if moved_dist_m < MOVE_NONE_THRESHOLD_M {
        return MOVE_SECTOR_NONE;
    }
    let k = (rel_bearing_rad / MOVE_SECTOR_RAD).round() as i32;
    k.rem_euclid((MOVE_SECTOR_COUNT - 1) as i32) as u8
}

/// Fresh trailing position of one trajectory at `t` (the label-endpoint
/// rule): the last sample at or before `t` when it is at most
/// [`MOVE_ENDPOINT_TOL_S`] old. `None` inside an observation gap — the
/// honest "no ground truth here" verdict (never interpolate across a gap).
fn trailing_position(traj: &EntityTrajectory, t: f32) -> Option<(f32, f32)> {
    let idx = traj.samples.partition_point(|s| s.time <= t);
    if idx == 0 {
        return None;
    }
    let s = &traj.samples[idx - 1];
    (t - s.time <= MOVE_ENDPOINT_TOL_S).then_some((s.x, s.z))
}

/// One exported movement-decision point (E16, one JSONL line): the shared
/// v2 feature core plus the realised-movement labels over
/// [t + 4, t + 16] s.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveDatasetRow {
    #[serde(flatten)]
    pub core: DecisionRowCore,
    /// Own heading at the decision time (radians) — the relative-frame
    /// reference, kept on the row so analysis can rebuild absolute bearings.
    pub own_yaw_rad: f32,
    /// Realised displacement over the window (metres).
    pub moved_dist_m: f32,
    /// Absolute displacement bearing atan2(dz, dx) (radians); 0.0 when the
    /// displacement is zero.
    pub move_bearing_rad: f32,
    /// 17-class label: 0..15 relative sectors, 16 = no obvious movement.
    pub move_sector: u8,
}

impl BatchRow for MoveDatasetRow {
    fn set_replay_id(&mut self, replay_id: String) {
        self.core.replay_id = Some(replay_id);
    }
}

/// Movement-export totals for one replay (E16).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveDatasetExportStats {
    pub owners: usize,
    pub rows: usize,
    /// Rows per moveSector class (17 bins; bin 16 = no movement).
    pub sector_histogram: Vec<usize>,
    pub rows_no_move: usize,
    /// Observable decision points whose label window had no honest ground
    /// truth (decider dark inside [t+4, t+16]) — the censorship rate,
    /// reported, not hidden.
    pub rows_censored_window: usize,
    pub moved_dist_p50_m: f32,
    pub moved_dist_p90_m: f32,
}

impl BatchStats for MoveDatasetExportStats {
    fn owners(&self) -> usize {
        self.owners
    }

    fn rows(&self) -> usize {
        self.rows
    }
}

/// Build every exportable movement-decision row of the replay (E16).
/// Deciders: every team-known ship (carriers and never-fired hulls
/// included). Gates: own state observable at t (E7 own-observable
/// semantics), alive through the full label window, and honest ground truth
/// at both window endpoints. Everything feature-side is the fire v2
/// pipeline via [`build_decision_row_core`].
#[allow(clippy::too_many_arguments)]
pub fn export_move_dataset(
    stream: &ReplayStream,
    ships: &[ShipInfo<'_>],
    los: Option<&LosGrid>,
    eye_height: f32,
    params: &FireSampleParams,
    replay_id: Option<&str>,
    game_mode: Option<&str>,
    events: &FeatureEvents<'_>,
) -> (Vec<MoveDatasetRow>, MoveDatasetExportStats) {
    let contexts = fire_contexts(stream, ships, params);
    let idx = build_feature_index(
        events,
        &stream.ally_builds,
        &stream.weather_transitions,
        &stream.weather_notifications,
    );
    let mut rows = Vec::new();
    let mut owners = 0usize;
    let mut censored = 0usize;
    let mut histogram = vec![0usize; MOVE_SECTOR_COUNT];
    let mut dists: Vec<f32> = Vec::new();
    for ship in ships {
        if ship.team_ambiguous || ship.team_id.is_none() {
            continue;
        }
        owners += 1;
        let id = ship.traj.entity_id;
        let Some(ctx) = contexts.get(&id) else {
            continue;
        };
        let (ally_radar, ally_hydro) = ally_build_fracs(&idx, ship);
        let (from, to) = alive_window(ship);
        // Rows need the FULL label window inside the alive span: a window
        // truncated by death or by the stream's end would fabricate a
        // "stopped" label out of clamped positions.
        let mut t = from + 5.0;
        while t + MOVE_LABEL_END_S <= to {
            // Own state must be observable (recorder view) — the E7 gate.
            let Some(own) = last_sample_before(&ship.traj.samples, t) else {
                t += MOVE_DECISION_INTERVAL_S;
                continue;
            };
            if t - own.time > GAP_THRESHOLD {
                t += MOVE_DECISION_INTERVAL_S;
                continue;
            }
            // Ground truth: displacement between FRESH trailing samples at
            // the two endpoints (dark-gap rows are censored, see module
            // docs — never interpolated).
            let (Some(p0), Some(p1)) = (
                trailing_position(ship.traj, t + MOVE_LABEL_START_S),
                trailing_position(ship.traj, t + MOVE_LABEL_END_S),
            ) else {
                censored += 1;
                t += MOVE_DECISION_INTERVAL_S;
                continue;
            };
            let (dx, dz) = (p1.0 - p0.0, p1.1 - p0.1);
            let moved_dist_m = dx.hypot(dz) * METERS_PER_UNIT;
            let move_bearing_rad = if moved_dist_m > 0.0 {
                dz.atan2(dx)
            } else {
                0.0
            };
            let sector = move_sector_label(wrap_angle(move_bearing_rad - own.yaw), moved_dist_m);
            histogram[sector as usize] += 1;
            dists.push(moved_dist_m);
            // Fire-context features keep their fire semantics for every
            // decider: never-fired hulls report loaded guns (reload 1.0)
            // and the fallback engagement range.
            let reload_frac = ctx
                .salvos
                .iter()
                .rfind(|s| s.main_battery && s.start <= t)
                .map_or(1.0, |s| {
                    ((t - s.start) / ctx.reload_s.max(0.001)).clamp(0.0, 1.0)
                });
            let core = build_decision_row_core(
                stream,
                ships,
                ship,
                own,
                t,
                los,
                eye_height,
                reload_frac,
                ctx.range_m,
                ally_radar,
                ally_hydro,
                replay_id,
                game_mode,
                events,
                &idx,
            );
            rows.push(MoveDatasetRow {
                core,
                own_yaw_rad: own.yaw,
                moved_dist_m,
                move_bearing_rad,
                move_sector: sector,
            });
            t += MOVE_DECISION_INTERVAL_S;
        }
    }
    let stats = MoveDatasetExportStats {
        owners,
        rows: rows.len(),
        sector_histogram: histogram,
        rows_no_move: rows
            .iter()
            .filter(|r| r.move_sector == MOVE_SECTOR_NONE)
            .count(),
        rows_censored_window: censored,
        moved_dist_p50_m: percentile(dists.clone(), 0.5).unwrap_or(0.0),
        moved_dist_p90_m: percentile(dists, 0.9).unwrap_or(0.0),
    };
    (rows, stats)
}

/// Movement batch summary (E16, G6): corpus-level totals plus the summed
/// sector histogram — the inertia-baseline strength read straight off the
/// export.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveDatasetBatchSummary {
    pub root_dir: String,
    pub files_seen: usize,
    pub files_exported: usize,
    pub files_failed: usize,
    pub deciders: usize,
    pub rows: usize,
    pub rows_censored_window: usize,
    pub sector_histogram: Vec<usize>,
    pub rows_no_move: usize,
    pub moved_dist_p50_m: f32,
    pub moved_dist_p90_m: f32,
    pub per_file: Vec<DatasetBatchFile<MoveDatasetExportStats>>,
}

/// Movement-family wrapper over [`ingest_batch_files`]: pools per-file
/// sector histograms and displacement lists for the corpus percentiles.
pub fn ingest_move_replay_files<I, F>(
    root: &std::path::Path,
    files: I,
    process: F,
) -> (Vec<MoveDatasetRow>, MoveDatasetBatchSummary)
where
    I: IntoIterator<Item = std::path::PathBuf>,
    F: FnMut(&std::path::Path) -> anyhow::Result<(Vec<MoveDatasetRow>, MoveDatasetExportStats)>,
{
    let (rows, per_file) =
        ingest_batch_files::<MoveDatasetRow, MoveDatasetExportStats, I, F>(root, files, process);
    let mut summary = MoveDatasetBatchSummary {
        root_dir: root.to_string_lossy().into_owned(),
        files_seen: per_file.len(),
        files_exported: 0,
        files_failed: 0,
        deciders: 0,
        rows: 0,
        rows_censored_window: 0,
        sector_histogram: vec![0usize; MOVE_SECTOR_COUNT],
        rows_no_move: 0,
        moved_dist_p50_m: 0.0,
        moved_dist_p90_m: 0.0,
        per_file: Vec::new(),
    };
    let mut all_dists: Vec<f32> = Vec::new();
    for f in per_file {
        let DatasetBatchFile {
            replay_id,
            file_name,
            outcome,
        } = f;
        let outcome = match outcome {
            DatasetBatchOutcome::Exported { stats } => {
                summary.files_exported += 1;
                summary.deciders += stats.owners;
                summary.rows += stats.rows;
                summary.rows_censored_window += stats.rows_censored_window;
                for (i, n) in stats.sector_histogram.iter().enumerate() {
                    summary.sector_histogram[i] += n;
                }
                summary.rows_no_move += stats.rows_no_move;
                DatasetBatchOutcome::Exported { stats }
            },
            DatasetBatchOutcome::Failed { reason } => {
                summary.files_failed += 1;
                DatasetBatchOutcome::Failed { reason }
            },
        };
        summary.per_file.push(DatasetBatchFile {
            replay_id,
            file_name,
            outcome,
        });
    }
    for r in &rows {
        all_dists.push(r.moved_dist_m);
    }
    summary.moved_dist_p50_m = percentile(all_dists.clone(), 0.5).unwrap_or(0.0);
    summary.moved_dist_p90_m = percentile(all_dists, 0.9).unwrap_or(0.0);
    (rows, summary)
}

/// Decode + export ONE replay file's movement rows (the `process` closure
/// used by [`export_move_dataset_dir`]); failure semantics identical to
/// [`export_replay_file`].
pub fn export_move_replay_file(
    path: &std::path::Path,
    los_dir: Option<&std::path::Path>,
    eye_height: f32,
    params: &FireSampleParams,
) -> anyhow::Result<(Vec<MoveDatasetRow>, MoveDatasetExportStats)> {
    let path_str = path.to_string_lossy().into_owned();
    let (stream, ev) = super::replay::decode_replay_stream_with_events(&path_str)?;
    let vehicles = super::replay_probe::read_roster(&path_str)?;
    let ships = ship_infos(&stream, &vehicles);
    let los = los_for_replay(stream.map_name.as_deref(), los_dir);
    let game_mode = read_game_mode(path);
    let events = FeatureEvents::for_version(stream.version.as_deref(), &ev);
    Ok(export_move_dataset(
        &stream,
        &ships,
        los.as_ref(),
        eye_height,
        params,
        None, // stamped by ingest_move_replay_files from the path
        game_mode.as_deref(),
        &events,
    ))
}

/// Folder → movement dataset (E16 / G6). Same walk and tolerance as
/// [`export_decision_dataset_dir`], movement rows out.
pub fn export_move_dataset_dir(
    dir: &std::path::Path,
    los_dir: Option<&std::path::Path>,
    eye_height: f32,
    params: &FireSampleParams,
) -> anyhow::Result<(Vec<MoveDatasetRow>, MoveDatasetBatchSummary)> {
    if !dir.is_dir() {
        bail!("batch root {} is not a directory", dir.to_string_lossy());
    }
    let mut files = Vec::new();
    collect_replay_files(dir, &mut files);
    files.sort();
    let (rows, summary) = ingest_move_replay_files(dir, files, |path| {
        export_move_replay_file(path, los_dir, eye_height, params)
    });
    Ok((rows, summary))
}

#[cfg(test)]
mod tests {
    use super::super::decision_tick::DEFAULT_EYE_HEIGHT;
    use super::super::replay_probe::read_roster;
    use super::*;

    fn sample(t: f32, eid: i32, x: f32, z: f32) -> PositionSample {
        PositionSample {
            time: t,
            entity_id: eid,
            vehicle_id: 1,
            x,
            y: 0.0,
            z,
            yaw: 0.0,
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
        })
    }

    fn trajectory(
        eid: i32,
        ship_id: Option<i64>,
        samples: Vec<PositionSample>,
    ) -> wowsp_tauri_shared::EntityTrajectory {
        wowsp_tauri_shared::EntityTrajectory {
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

    /// A synthetic gun ship firing 5-shell salvos every 12 s at an enemy in
    /// range, plus a stationary recorder-side target: salvo grouping, reload
    /// estimate, decision counting and the censoring share must all line up.
    #[test]
    fn synthetic_salvo_reload_and_decision_logic() {
        let params = FireSampleParams::default();
        // Gun ship 9 (enemy side, team known): stationary at (10, 0), firing
        // 5-shell main salvos at t=100, 112, 124, 136, 148 at the target.
        let gun = trajectory(
            9,
            Some(222),
            (0..400)
                .map(|i| sample(i as f32 * 0.5, 9, 10.0, 0.0))
                .collect(),
        );
        // Target of 9: recorder-side ship 8 at (50, 0) — 40 units out, inside
        // the ~47-unit engagement range implied by the fired shots.
        let target = trajectory(
            8,
            Some(111),
            (0..400)
                .map(|i| sample(i as f32 * 0.5, 8, 50.0, 0.0))
                .collect(),
        );
        let mut shells = Vec::new();
        let mut salvo_id = 0;
        for k in 0..5u32 {
            for b in 0..5u16 {
                shells.push(shell(
                    100.0 + k as f32 * 12.0,
                    9,
                    salvo_id,
                    b,
                    (10.0 + k as f32 * 0.1, 0.5),
                    (50.0, 0.0),
                ));
            }
            salvo_id += 1;
        }
        let stream = ReplayStream {
            ally_builds: Vec::new(),
            trajectories: vec![gun, target],
            recorder_vehicle_id: Some(8),
            shell_launches: shells,
            ..minimal_stream()
        };
        let vehicles = vec![roster_entry(1, 0, 111), roster_entry(2, 2, 222)];
        let ships = ship_infos(&stream, &vehicles);

        // Q1: all shells attribute to ship 9, muzzle within a ship length.
        let attr = attribute_shell_owners(&stream, &ships);
        assert_eq!(attr.total_shells, 25);
        assert_eq!(attr.shells_with_ship_owner, 25);
        assert_eq!(attr.unowned_shells, 0);
        assert_eq!(attr.firing_ships, 1);
        assert!(attr.owner_is_nearest_fraction > 0.99);
        assert!(attr.muzzle_owner_dist_p90_units < 20.0);

        // Q2: five 5-shell salvos, reload ≈ 12 s, censoring = 5×12 / 200 ≈ 0.3.
        let structure = analyze_salvo_structure(&stream, &ships, &params);
        assert_eq!(structure.owners.len(), 1);
        let o = &structure.owners[0];
        assert_eq!(o.salvos, 5);
        assert!((o.salvo_size_p50 - 5.0).abs() < 1e-6);
        assert_eq!(o.salvo_size_max, 5);
        assert_eq!(o.main_salvo_count, 5);
        assert!(
            (o.reload_estimate_s - 12.0).abs() < 1.0,
            "reload {}",
            o.reload_estimate_s
        );
        assert!(
            (o.censor_share - 0.30).abs() < 0.03,
            "censor {}",
            o.censor_share
        );

        // Q3: decision points every 2 s. Ship 8 never fires (no history →
        // always reloaded); its target (ship 9) is observed continuously and
        // within the fallback range → every observable point is eligible,
        // never positive. Ship 9's own row: eligible whenever reloaded.
        let stats = count_decision_samples(&stream, &ships, &params);
        let s9 = stats
            .owners
            .iter()
            .find(|o| o.owner_id == 9)
            .expect("ship 9 row");
        assert!(s9.eligible_points > 30, "eligible {}", s9.eligible_points);
        // 5 positive windows (one per salvo); the 100 s salvo needs a point
        // at t=98 with label window (98, 100] — cadence hits 98 (from+5 even
        // steps), so all five salvos are caught.
        assert_eq!(s9.fired_points, 5, "fired {}", s9.fired_points);
        let s8 = stats
            .owners
            .iter()
            .find(|o| o.owner_id == 8)
            .expect("ship 8 row");
        assert_eq!(s8.fired_points, 0);
        assert!(s8.eligible_points > 50);
        assert!(!s8.has_fire_history);
    }

    /// Fire-event grouping separates battery classes and > 2 s gaps; salvo
    /// ids are irrelevant (they are pack-level, not click-level).
    #[test]
    fn synthetic_salvo_grouping_splits_on_class_and_gap() {
        // Interleaved main (barrel 0/1) and secondary (barrel 40/41) shells
        // within one click merge into one event per class.
        let shells = vec![
            shell(10.0, 9, 1, 0, (0.0, 0.0), (50.0, 0.0)),
            shell(10.1, 9, 5, 40, (0.0, 0.0), (20.0, 0.0)),
            shell(10.2, 9, 2, 1, (0.0, 0.0), (50.0, 0.0)),
            shell(10.3, 9, 6, 41, (0.0, 0.0), (20.0, 0.0)),
            shell(15.0, 9, 3, 0, (0.0, 0.0), (50.0, 0.0)), // 4.7 s later
        ];
        let grouped = group_salvos(&shells.iter().collect::<Vec<_>>());
        assert_eq!(grouped.len(), 3, "groups {:?}", grouped);
        assert_eq!(grouped[0].shell_count, 2);
        assert!(grouped[0].main_battery);
        assert!((grouped[0].start - 10.0).abs() < 1e-6);
        assert_eq!(grouped[1].shell_count, 2);
        assert!(!grouped[1].main_battery);
        assert_eq!(grouped[2].shell_count, 1);
        assert!(grouped[2].main_battery);
        // A > 2 s gap within one class splits even when the salvo id is
        // identical.
        let shells2 = vec![
            shell(10.0, 9, 1, 0, (0.0, 0.0), (50.0, 0.0)),
            shell(15.0, 9, 1, 1, (0.0, 0.0), (50.0, 0.0)),
        ];
        let grouped2 = group_salvos(&shells2.iter().collect::<Vec<_>>());
        assert_eq!(grouped2.len(), 2);
    }

    /// Negative-audit classification: a silent window with the target behind a
    /// terrain wall is flagged `terrain-los`; one with the target abeam is
    /// `unexplained-hold`.
    #[test]
    fn synthetic_negative_audit_classification() {
        let params = FireSampleParams::default();
        // 16×16 grid, 10-unit cells, one 100-unit wall at column 8.
        let res = 16usize;
        let mut heights = vec![0.0f32; res * res];
        for r in 0..res {
            heights[r * res + 8] = 100.0;
        }
        let grid = LosGrid::from_parts(res, 0.0, 160.0, 0.0, 160.0, heights).expect("grid");
        // Gun ship 9 at (5, 80) firing once at t=100 (establishing a fire
        // history with reload from a second salvo at t=124), target 8 behind
        // the wall at (150, 80) but observed continuously (spotted by air, say).
        let mk = |eid: i32, x: f64, sid: i64| {
            trajectory(
                eid,
                Some(sid),
                (0..400)
                    .map(|i| sample(i as f32 * 0.5, eid, x as f32, 80.0))
                    .collect(),
            )
        };
        let stream = ReplayStream {
            ally_builds: Vec::new(),
            trajectories: vec![mk(9, 5.0, 222), mk(8, 150.0, 111)],
            recorder_vehicle_id: Some(8),
            shell_launches: vec![
                shell(100.0, 9, 1, 0, (5.0, 80.5), (150.0, 80.0)),
                shell(124.0, 9, 2, 0, (5.0, 80.5), (150.0, 80.0)),
            ],
            ..minimal_stream()
        };
        let vehicles = vec![roster_entry(1, 0, 111), roster_entry(2, 2, 222)];
        let ships = ship_infos(&stream, &vehicles);
        let windows = audit_negative_samples(
            &stream,
            &ships,
            Some(&grid),
            DEFAULT_EYE_HEIGHT,
            &params,
            20,
        );
        assert!(!windows.is_empty());
        // Every audited window is ship 9 silent behind the wall.
        for w in &windows {
            assert_eq!(w.owner_id, 9);
            assert_eq!(w.plausible_cause, "terrain-los");
            assert_eq!(w.terrain_los_blocked, Some(true));
        }
        // Without the grid the cause degrades to unexplained (the audit
        // reports the missing feature as None).
        let no_grid = audit_negative_samples(&stream, &ships, None, DEFAULT_EYE_HEIGHT, &params, 5);
        for w in &no_grid {
            assert_eq!(w.terrain_los_blocked, None);
            assert_eq!(w.plausible_cause, "unexplained-hold");
        }
    }

    /// E7 against the real reference replay — run with
    /// `WOWSP_TEST_REPLAY=<path> [WOWSP_TEST_LOS_GRID=<path>] cargo test -p
    /// wowsp_tauri fire_dataset -- --nocapture`. Prints the full Q1–Q6 numbers
    /// and asserts the thresholds measured on the 50_Gold_harbor reference
    /// (margins left for other replays). Skips when the env var is unset.
    #[test]
    fn e7_fire_dataset_on_real_replay() {
        let Ok(path) = std::env::var("WOWSP_TEST_REPLAY") else {
            eprintln!("[e7] WOWSP_TEST_REPLAY not set - skipping");
            return;
        };
        let params = FireSampleParams::default();
        let stream =
            super::super::replay::decode_replay_stream_sync(&path).expect("decode real replay");
        let vehicles = read_roster(&path).expect("roster");
        let ships = ship_infos(&stream, &vehicles);
        let grid_path = match std::env::var("WOWSP_TEST_LOS_GRID") {
            Ok(p) => Some(std::path::PathBuf::from(p)),
            Err(_) => {
                let default = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../scripts/experiments/out/50_Gold_harbor/terrain_los.npz");
                default.exists().then_some(default)
            },
        };
        let grid = grid_path
            .map(|p| LosGrid::load_npz(&p))
            .transpose()
            .expect("load LOS raster when present");
        eprintln!(
            "[e7] replay {} ships, {} shells, recorder={:?}, LOS grid {}",
            ships.len(),
            stream.shell_launches.len(),
            stream.recorder_vehicle_id,
            if grid.is_some() { "loaded" } else { "absent" }
        );

        // Q1 — attribution.
        let attr = attribute_shell_owners(&stream, &ships);
        eprintln!(
            "[e7/Q1] {} shells: {} owned by ships, {} unowned, {} airborne (muzzle y >= {}); muzzle->owner dist p50 {:.1} / p90 {:.1} / max {:.1} units; owner-is-nearest {:.3}; {} firing ships",
            attr.total_shells,
            attr.shells_with_ship_owner,
            attr.unowned_shells,
            attr.airborne_shells,
            AIRBORNE_MUZZLE_Y_UNITS,
            attr.muzzle_owner_dist_p50_units,
            attr.muzzle_owner_dist_p90_units,
            attr.muzzle_owner_dist_max_units,
            attr.owner_is_nearest_fraction,
            attr.firing_ships
        );
        for o in &attr.owners {
            eprintln!(
                "[e7/Q1] owner {} team {:?}{} shipId {:?}: {} shells ({} airborne), {} salvos, muzzle-dist p50 {:.1}/p90 {:.1}, nearest-frac {:.2}, median muzzle y {:.1}, observed-at-fire {:.2}, fires {}..{}",
                o.owner_id,
                o.team_id,
                if o.is_recorder { " RECORDER" } else { "" },
                o.ship_id,
                o.shells,
                o.airborne_shells,
                o.salvos,
                o.muzzle_owner_dist_p50_units,
                o.muzzle_owner_dist_p90_units,
                o.owner_nearest_fraction,
                o.median_muzzle_y,
                o.observed_at_fire_fraction,
                o.first_fire_s,
                o.last_fire_s
            );
        }
        // Attribution must be essentially perfect: explicit ids that join a
        // ship, muzzles within a ship length plus position drift (the
        // ±6 s grace band on stale enemy trajectories inflates the tail),
        // owner the nearest ship.
        assert!(
            attr.shells_with_ship_owner as f32 / attr.total_shells as f32 >= 0.9,
            "ship-owner attribution {:.3}",
            attr.shells_with_ship_owner as f32 / attr.total_shells as f32
        );
        assert!(
            attr.muzzle_owner_dist_p50_units <= 20.0,
            "muzzle p50 {}",
            attr.muzzle_owner_dist_p50_units
        );
        assert!(
            attr.muzzle_owner_dist_p90_units <= 45.0,
            "muzzle p90 {}",
            attr.muzzle_owner_dist_p90_units
        );
        assert!(
            attr.owner_is_nearest_fraction >= 0.85,
            "nearest fraction {}",
            attr.owner_is_nearest_fraction
        );

        // Q2 — salvo structure.
        let structure = analyze_salvo_structure(&stream, &ships, &params);
        for o in &structure.owners {
            eprintln!(
                "[e7/Q2] owner {}{}: {} shells in {} salvos (size p50 {:.1}, max {}, main salvos {} p50 {:.1}), main intervals p10 {:.1} / p50 {:.1} / min {:.1} / max {:.1} s -> reload {:.1} s, censor share {:.2}, barrels {:?}",
                o.owner_id,
                if o.is_recorder { " RECORDER" } else { "" },
                o.shells,
                o.salvos,
                o.salvo_size_p50,
                o.salvo_size_max,
                o.main_salvo_count,
                o.main_salvo_size_p50,
                o.intervals_p10_s,
                o.intervals_p50_s,
                o.intervals_min_s,
                o.intervals_max_s,
                o.reload_estimate_s,
                o.censor_share,
                o.barrel_ids
            );
        }
        let reloads: Vec<f32> = structure
            .owners
            .iter()
            .filter(|o| !o.is_recorder && o.reload_estimate_s > 0.0)
            .map(|o| o.reload_estimate_s)
            .collect();
        let median_reload = percentile(reloads.clone(), 0.5).expect("gun owners exist");
        let median_censor = percentile(
            structure
                .owners
                .iter()
                .filter(|o| !o.is_recorder && o.reload_estimate_s > 0.0)
                .map(|o| o.censor_share)
                .collect(),
            0.5,
        )
        .expect("gun owners exist");
        eprintln!(
            "[e7/Q2] non-recorder reload estimates: median {:.1} s over {} gun owners (min {:.1}, max {:.1}); median censor share {:.2}",
            median_reload,
            reloads.len(),
            reloads.iter().cloned().fold(f32::MAX, f32::min),
            reloads.iter().cloned().fold(f32::MIN, f32::max),
            median_censor
        );
        assert!(
            (5.0..=30.0).contains(&median_reload),
            "median reload {}",
            median_reload
        );
        assert!(
            (0.05..=0.90).contains(&median_censor),
            "median censor share {}",
            median_censor
        );
        assert!(reloads.len() >= 5, "gun owners {}", reloads.len());

        // Q3 — decision samples.
        let stats = count_decision_samples(&stream, &ships, &params);
        for o in &stats.owners {
            eprintln!(
                "[e7/Q3] owner {} team {:?}{} history={}: reload {:.1} s range {:.0} m: observable {} -> reloaded {} -> eligible {}, fired {} (rate {:.3})",
                o.owner_id,
                o.team_id,
                if o.is_recorder { " RECORDER" } else { "" },
                o.has_fire_history,
                o.reload_estimate_s,
                o.range_m,
                o.observable_points,
                o.reloaded_points,
                o.eligible_points,
                o.fired_points,
                o.positive_rate()
            );
        }
        eprintln!(
            "[e7/Q3] totals: with-history eligible {} fired {} (rate {:.3}); all ships eligible {} fired {}; recorder eligible {} fired {}; replays for 1e6: {:.0}, for 1e7: {:.0}",
            stats.total_eligible_with_history,
            stats.total_fired_with_history,
            stats.total_fired_with_history as f32 / stats.total_eligible_with_history.max(1) as f32,
            stats.total_eligible_all,
            stats.total_fired_all,
            stats.recorder_eligible,
            stats.recorder_fired,
            stats.replays_for_1e6,
            stats.replays_for_1e7
        );
        assert!(
            stats.total_eligible_with_history > 500,
            "eligible with history"
        );
        let rate =
            stats.total_fired_with_history as f32 / stats.total_eligible_with_history.max(1) as f32;
        assert!((0.01..=0.60).contains(&rate), "positive rate {rate}");

        // Q4 — negative audit.
        let windows = audit_negative_samples(
            &stream,
            &ships,
            grid.as_ref(),
            DEFAULT_EYE_HEIGHT,
            &params,
            20,
        );
        eprintln!("[e7/Q4] {} audited negative windows:", windows.len());
        for w in &windows {
            eprintln!(
                "[e7/Q4] t={:7.1} owner {} (team {:?}) vs enemy {} @ {:5.0} m (age {:.1} s, {} kt): LOS blocked {:?}, turret offset {:3.0} deg, own range {:.0} m -> {}",
                w.t,
                w.owner_id,
                w.team_id,
                w.nearest_enemy_id,
                w.nearest_enemy_dist_m,
                w.enemy_observed_age_s,
                w.enemy_speed_kt.map(|v| v as i32).unwrap_or(-1),
                w.terrain_los_blocked,
                w.turret_bearing_offset_deg,
                w.own_range_used_m,
                w.plausible_cause
            );
        }
        let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
        for w in &windows {
            *counts.entry(w.plausible_cause).or_default() += 1;
        }
        eprintln!("[e7/Q4] cause histogram: {:?}", counts);
        assert!(windows.len() >= 15, "audited windows {}", windows.len());
        // Every window must carry the full feature set (distance + age always;
        // LOS verdict when the grid loaded).
        for w in &windows {
            assert!(w.nearest_enemy_dist_m > 0.0);
            assert!(w.enemy_observed_age_s >= 0.0);
            if grid.is_some() {
                assert!(w.terrain_los_blocked.is_some());
            }
        }

        // Q5 — recorder (CV) fire semantics.
        let rec = attr.owners.iter().find(|o| o.is_recorder);
        match rec {
            Some(r) => eprintln!(
                "[e7/Q5] RECORDER fired: {} shells ({} airborne), {} salvos, median muzzle y {:.1}, observed-at-fire {:.2} — CV recorder: these are AI secondaries / aircraft weapons, not player main-battery decisions",
                r.shells,
                r.airborne_shells,
                r.salvos,
                r.median_muzzle_y,
                r.observed_at_fire_fraction
            ),
            None => eprintln!(
                "[e7/Q5] RECORDER fired no shells at all — CV recorder yields zero own-fire samples"
            ),
        }
        eprintln!(
            "[e7/Q5] recorder decision row: eligible {} fired {} — CV has no player main-battery salvo semantics",
            stats.recorder_eligible, stats.recorder_fired
        );
        let gun_owners = stats.owners.iter().filter(|o| o.has_fire_history).count();
        let per_gun_ship = stats.total_eligible_with_history as f32 / gun_owners.max(1) as f32;
        eprintln!(
            "[e7/Q6] per-replay yield (all ships, with history): {} eligible / {} fired; {} replays for 1e6, {:.0} for 1e7 (Suphx single-decision models: 4M-15M samples)",
            stats.total_eligible_with_history,
            stats.total_fired_with_history,
            stats.replays_for_1e6.ceil(),
            stats.replays_for_1e7
        );
        eprintln!(
            "[e7/Q6] per gun ship: avg {:.0} eligible -> a gun-ship recorder would harvest ~{:.0} own-fire decision samples per replay -> 1e6 needs ~{:.0} replays, 1e7 ~{:.0} (recorder-only, with full intent labels from E2)",
            per_gun_ship,
            per_gun_ship,
            (1.0e6 / per_gun_ship).ceil(),
            (1.0e7 / per_gun_ship).ceil()
        );
    }

    /// E9 step 1 synthetic: one firing gun ship + one enemy + one ally + one
    /// zone — slot geometry, labels (including the reload-censored rows) and
    /// the with-history decider gate must all line up.
    #[test]
    fn synthetic_dataset_export_slots_and_labels() {
        let params = FireSampleParams::default();
        // Gun ship 9 (enemy of recorder side) stationary at (10, 0), firing
        // 4-shell main salvos at t=100 and t=124 at target 8 (50, 0); ally 7
        // (recorder side, never fires — must produce NO rows).
        let mk = |eid: i32, x: f32, sid: i64| {
            trajectory(
                eid,
                Some(sid),
                (0..400)
                    .map(|i| sample(i as f32 * 0.5, eid, x, 0.0))
                    .collect(),
            )
        };
        let zone = wowsp_tauri_shared::EntityTrajectory {
            entity_id: 21,
            kind: kind(14, Some(999)),
            samples: Vec::new(),
            death_time: None,
            hp_samples: Vec::new(),
            cap_samples: vec![wowsp_tauri_shared::HpSample {
                time: 0.0,
                value: 1,
            }],
            cap_progress: vec![wowsp_tauri_shared::HpSample {
                time: 90.0,
                value: 350,
            }],
            cruise_samples: Vec::new(),
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
            trajectories: vec![mk(9, 10.0, 222), mk(8, 50.0, 111), mk(7, 0.0, 110), zone],
            recorder_vehicle_id: Some(8),
            shell_launches: shells,
            ..minimal_stream()
        };
        let vehicles = vec![
            roster_entry(1, 0, 111),
            roster_entry(2, 2, 222),
            roster_entry(3, 0, 110),
        ];
        let ships = ship_infos(&stream, &vehicles);
        let (rows, stats) = export_decision_dataset(
            &stream,
            &ships,
            None,
            DEFAULT_EYE_HEIGHT,
            &params,
            None,
            None,
            &FeatureEvents::empty(),
        );
        // Only ship 9 has a fire history — it is the sole decider.
        assert_eq!(stats.owners, 1);
        assert!(rows.iter().all(|r| r.owner_entity_id == 9));
        assert!(!rows.is_empty());
        // labelB is censored exactly where labelA is false.
        for r in &rows {
            assert_eq!(r.label_b_fired.is_some(), r.label_a_can_fire);
        }
        // labelA=1 rows must equal the E7 eligible count for the same input.
        let e7 = count_decision_samples(&stream, &ships, &params);
        assert_eq!(stats.rows_can_fire, e7.total_eligible_with_history);
        assert_eq!(stats.rows_fired, e7.total_fired_with_history);
        // The cadence starts at first-sample+5 s and steps 2 s → odd decision
        // times. t=99: reloaded (no salvo before), target 8 observed in the
        // ~47-unit range → labelA=1, and the salvo at t=100 lands in (99,
        // 101] → labelB=Some(true).
        let r99 = rows
            .iter()
            .find(|r| (r.t - 99.0).abs() < 0.1)
            .expect("t=99 row");
        assert!(r99.label_a_can_fire);
        assert_eq!(r99.label_b_fired, Some(true));
        // Slots: 9's (team 1) enemies = {7, 8} (team 0, both observed —
        // ordered by distance: 7 at 10 units ahead-behind, 8 at 40 units dead
        // ahead from 9's yaw-0 heading), friends = {} (no other team-1 ship).
        assert_eq!(r99.enemies.len(), 2);
        assert!(r99.friends.is_empty());
        let e7slot = &r99.enemies[0];
        assert_eq!(e7slot.entity_id, 7);
        assert!(
            (e7slot.dist_m - 10.0 * METERS_PER_UNIT).abs() < 0.5,
            "{}",
            e7slot.dist_m
        );
        assert!((e7slot.bearing_rel_rad - std::f32::consts::PI).abs() < 1e-5);
        let e = &r99.enemies[1];
        assert_eq!(e.entity_id, 8);
        assert!(
            (e.dist_m - 40.0 * METERS_PER_UNIT).abs() < 0.5,
            "{}",
            e.dist_m
        );
        assert!(e.bearing_rel_rad.abs() < 1e-5);
        assert!(e.observed_now);
        assert_eq!(e.terrain_blocked, None, "no grid -> no verdict");
        // Reload windows are exported with labelA=0 (censoring rows for head
        // A's negatives): right after the t=100 salvo the reload (~24 s) is
        // far from completing within the 2 s label window.
        let r103 = rows
            .iter()
            .find(|r| (r.t - 103.0).abs() < 0.1)
            .expect("t=103");
        assert!(!r103.label_a_can_fire);
        assert_eq!(r103.label_b_fired, None);
        assert!(r103.own_reload_frac < 0.15, "frac {}", r103.own_reload_frac);
        // A row before the first salvo reports loaded guns and the zone block
        // (progress strictly inside (0,1) counts as active at t=91).
        let r91 = rows
            .iter()
            .find(|r| (r.t - 91.0).abs() < 0.1)
            .expect("t=91");
        assert!((r91.own_reload_frac - 1.0).abs() < 1e-6);
        assert_eq!(r91.zones_owned_1, 1);
        assert_eq!(r91.zones_active_progress, 1);
        // Serialization: every row is one JSON line with camelCase keys.
        let line = serde_json::to_string(&r99).expect("serialize row");
        assert!(line.contains("\"labelACanFire\":true"));
        assert!(line.contains("\"ownerEntityId\":9"));
        // E13 additive shape: outcome keys present even at zero.
        assert!(line.contains("\"ownerShotsHit\":0"));
        assert!(line.contains("\"enemyHpLostNearby\":0.0"));
        assert!(!line.contains("\"gameMode\""));
        // E14: every row stamps the feature schema version.
        assert!(line.contains("\"featureVersion\":2"));
    }

    /// E13 synthetic: the outcome window `(t + label, t + 45]` must count
    /// exactly the decider's shotKills (any weapon) and MAIN-battery ground
    /// shells, and the enemy HP lost near the decider's impacts — full-drop
    /// credit, enemy side only, impact-envelope coverage, noise floor.
    #[test]
    fn synthetic_dataset_export_outcome_fields() {
        let params = FireSampleParams::default();
        // Decider: gun ship 9 (team 1) at (10, 0) firing main salvos at
        // t=100 (the label-window salvo for the t=99 row), t=102 and t=104
        // (inside its outcome window), one secondary shell at t=103 and one
        // airborne (aircraft) shell at t=103.5 — both excluded from `fired`.
        let mk = |eid: i32, x: f32, z: f32, sid: i64| {
            trajectory(
                eid,
                Some(sid),
                (0..400)
                    .map(|i| sample(i as f32 * 0.5, eid, x, z))
                    .collect(),
            )
        };
        let mut shells = Vec::new();
        for k in 0..2u32 {
            for b in 0..2u16 {
                shells.push(shell(
                    102.0 + k as f32 * 2.0,
                    9,
                    k as i32,
                    b,
                    (10.0, 0.5),
                    (50.0, 0.0),
                ));
            }
        }
        shells.push(shell(100.0, 9, 9, 0, (10.0, 0.5), (50.0, 0.0)));
        shells.push(shell(103.0, 9, 10, 40, (10.0, 0.5), (50.0, 0.0))); // secondary
        // Airborne (aircraft) launch: the helper pins y=2 (ground), so build
        // it inline with a muzzle height above the airborne bound.
        shells.push(ShellLaunchEvent {
            time: 103.5,
            owner_id: 9,
            params_id: 0,
            salvo_id: 11,
            shot_id: 9,
            x: 10.0,
            y: 20.0,
            z: 0.5,
            target_x: 50.0,
            target_y: 0.0,
            target_z: 0.0,
            server_time_left: 20.0,
            speed: 800.0,
            gun_barrel_id: 0,
        });
        // Hits: 9's shotKills near enemy hull 8 at (50, 0).
        let shot_kill = |time: f32, owner: i32, shot: u16, x: f32, z: f32| ShotKillEvent {
            time,
            owner_id: owner,
            hit_type: 0,
            shot_id: shot,
            x,
            y: 0.0,
            z,
        };
        // Enemy hull 8 (team 0, the recorder side): drops 1000 @ 103.4 and
        // 500 @ 105.5 (both covered by 9's impacts), a sub-floor 20 @ 106,
        // and an uncovered 100 @ 110.
        let mut traj8 = mk(8, 50.0, 0.0, 111);
        traj8.hp_samples = vec![
            wowsp_tauri_shared::HpSample {
                time: 99.0,
                value: 40_000,
            },
            wowsp_tauri_shared::HpSample {
                time: 102.9,
                value: 40_000,
            },
            wowsp_tauri_shared::HpSample {
                time: 103.4,
                value: 39_000,
            },
            wowsp_tauri_shared::HpSample {
                time: 105.0,
                value: 39_000,
            },
            wowsp_tauri_shared::HpSample {
                time: 105.5,
                value: 38_500,
            },
            wowsp_tauri_shared::HpSample {
                time: 106.0,
                value: 38_480,
            },
            wowsp_tauri_shared::HpSample {
                time: 110.0,
                value: 38_380,
            },
        ];
        // Second enemy hull 7 (team 0) at (60, 10): a 900 drop no impact of
        // 9 sits near (the nearest impact is ~10.4 units away — inside the
        // ported 500-UNIT radius, so it WOULD count; park it far instead).
        let mut traj7 = mk(7, 300.0, 300.0, 110);
        traj7.hp_samples = vec![
            wowsp_tauri_shared::HpSample {
                time: 100.0,
                value: 20_000,
            },
            wowsp_tauri_shared::HpSample {
                time: 104.0,
                value: 19_100,
            },
        ];
        // FRIEND hull 6 (team 1) near the impacts with a big drop: never
        // counted — not an enemy of the decider.
        let mut traj6 = mk(6, 52.0, 0.0, 109);
        traj6.hp_samples = vec![
            wowsp_tauri_shared::HpSample {
                time: 100.0,
                value: 30_000,
            },
            wowsp_tauri_shared::HpSample {
                time: 103.5,
                value: 10_000,
            },
        ];
        let stream = ReplayStream {
            ally_builds: Vec::new(),
            trajectories: vec![mk(9, 10.0, 0.0, 222), traj8, traj7, traj6],
            recorder_vehicle_id: Some(8),
            shell_launches: shells,
            shot_kills: vec![
                shot_kill(103.0, 9, 1, 50.2, 0.1),
                shot_kill(105.2, 9, 2, 49.8, -0.3),
                // Someone else's impact near 8: counts for 8's coverage only
                // through ITS owner's rows — 9's row must ignore it.
                shot_kill(110.0, 7, 5, 50.1, 0.0),
            ],
            ..minimal_stream()
        };
        let vehicles = vec![
            roster_entry(1, 0, 111),
            roster_entry(2, 0, 110),
            roster_entry(3, 2, 109), // friend hull: relation 2 = team 1
            roster_entry(4, 2, 222),
        ];
        let ships = ship_infos(&stream, &vehicles);
        let (rows, stats) = export_decision_dataset(
            &stream,
            &ships,
            None,
            DEFAULT_EYE_HEIGHT,
            &params,
            Some("replayX"),
            Some("pvp"),
            &FeatureEvents::empty(),
        );
        assert_eq!(stats.owners, 1);
        let r99 = rows
            .iter()
            .find(|r| (r.t - 99.0).abs() < 0.1)
            .expect("t=99 row");
        // Outcome window (101, 144]: 2 impacts (t=103, 105.2 — the t=110
        // impact belongs to owner 7, and 9's window-shells are the 4 launched
        // at 102/104; the t=100 label salvo, the secondary and the airborne
        // shell stay out.
        assert_eq!(r99.owner_shots_hit, 2, "hits {}", r99.owner_shots_hit);
        assert_eq!(r99.owner_shots_fired, 4, "fired {}", r99.owner_shots_fired);
        // HP lost near 9's impacts: 1000 + 500 from hull 8 (full credit, no
        // split, even though hull 6 "shares" the blast zone as a friend);
        // hull 7's 900 drop is uncovered (impacts nowhere near); the 20 drop
        // is under the noise floor; the 100 drop @ 110 is outside every
        // impact envelope of owner 9 (110 - 0.4 > 105.2).
        assert!(
            (r99.enemy_hp_lost_nearby - 1500.0).abs() < 1e-3,
            "hp lost {}",
            r99.enemy_hp_lost_nearby
        );
        assert_eq!(r99.game_mode.as_deref(), Some("pvp"));
        // A row well after all activity: empty outcome window.
        let r200 = rows
            .iter()
            .find(|r| (r.t - 199.0).abs() < 0.1)
            .expect("t=199 row");
        assert_eq!(r200.owner_shots_hit, 0);
        assert_eq!(r200.owner_shots_fired, 0);
        assert_eq!(r200.enemy_hp_lost_nearby, 0.0);
        // Serialization carries the outcome keys (camelCase).
        let line = serde_json::to_string(r99).expect("serialize");
        assert!(line.contains("\"ownerShotsHit\":2"));
        assert!(line.contains("\"ownerShotsFired\":4"));
        assert!(line.contains("\"gameMode\":\"pvp\""));
        // E15 labels: r99 fired (salvo at 100) and its outcome window holds
        // 2 hits → hit/soft at their maxima; a held row (t=97: salvo at 100
        // outside (97,99]) censors nothing (labelA=1) but stays 0 on both.
        assert_eq!(r99.label_b_hit, Some(true));
        assert!((r99.label_b_soft.unwrap() - 1.0).abs() < 1e-6);
        let r97 = rows
            .iter()
            .find(|r| (r.t - 97.0).abs() < 0.1)
            .expect("t=97 row");
        assert_eq!(r97.label_b_fired, Some(false));
        assert_eq!(r97.label_b_hit, Some(false));
        assert!(r97.label_b_soft.unwrap().abs() < 1e-6);
    }

    /// E14/E15 synthetic: every feature-v2 field against hand-computed
    /// values — explicit-vision CORRECTION of the gap inference (stale
    /// position track but spotted), consumable remaining fractions, engine
    /// fold, own/slot smoke flags, cloud count/area, the lerped cyclone
    /// spotting cap, the approach ramp, ally radar/hydro counts from builds,
    /// the radar-lit enemy flag, and the hit/soft label variants — plus the
    /// unknown-stream sentinels under `FeatureEvents::empty`.
    #[test]
    fn synthetic_dataset_export_v2_features() {
        let params = FireSampleParams::default();
        // Decider: gun ship 9, RECORDER side (team 0), firing 4-shell main
        // salvos at t=100 and t=124. Enemy 8 (team 1) observed 0..96 s,
        // dark 97..120 (the gap), back 120..200. Ally 7 (team 0, never
        // fires) at (30, 0).
        let mk = |eid: i32, x: f32, sid: i64| {
            trajectory(
                eid,
                Some(sid),
                (0..400)
                    .map(|i| sample(i as f32 * 0.5, eid, x, 0.0))
                    .collect(),
            )
        };
        // Enemy 8: samples 0..96 then 120..200 (the >4 s gap in between).
        let mut traj8 = mk(8, 50.0, 111);
        traj8.samples = (0..=192)
            .chain(240..400)
            .map(|i| sample(i as f32 * 0.5, 8, 50.0, 0.0))
            .collect();
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
        // Ally 7 mounts radar (PCY019_RLSSearch) — the only radar build.
        let mut radar_build = PlayerBuild::default();
        radar_build.entity_id = 7;
        radar_build.abilities = vec![4_274_167_728];
        let stream = ReplayStream {
            trajectories: vec![mk(9, 10.0, 222), traj8, mk(7, 30.0, 110)],
            recorder_vehicle_id: Some(8),
            shell_launches: shells,
            version: Some("15,8,0,0".into()),
            ally_builds: vec![radar_build],
            weather_transitions: vec![WeatherTransition {
                time: 90.0,
                start_time: 100.0,
                end_time: 200.0,
                from_param: 4_293_183_408, // PCOW001_Sunny (2000 units)
                to_param: 4_287_940_528,   // PCOW006_Storm_Logic (266.6664)
            }],
            weather_notifications: vec![WeatherNotification {
                time: 90.0,
                at_time: 350.0,
                param: 4_287_940_528,
            }],
            shot_kills: vec![ShotKillEvent {
                time: 110.0,
                owner_id: 9,
                hit_type: 0,
                shot_id: 1,
                x: 50.1,
                y: 0.0,
                z: 0.1,
            }],
            ..minimal_stream()
        };
        let vehicles = vec![
            roster_entry(1, 2, 111), // enemy target
            roster_entry(2, 0, 222), // decider, recorder side
            roster_entry(3, 0, 110), // radar ally
        ];
        let ships = ship_infos(&stream, &vehicles);
        let events = FeatureEvents {
            vision: &[
                VisionEvent {
                    time: 0.0,
                    entity_id: 7,
                    visible: true,
                    packed_data: 0,
                },
                // 8 lit at 98 while its position track went dark at 96 — the
                // radar-correction case: stale by gaps, spotted explicitly.
                VisionEvent {
                    time: 98.0,
                    entity_id: 8,
                    visible: true,
                    packed_data: 0,
                },
            ],
            consumables: &[
                ConsumableUseEvent {
                    time: 100.0,
                    entity_id: 9,
                    usage_type: 1,
                    consumable_id: 0,
                    duration: 5.0,
                    target_x: None,
                    target_z: None,
                    target_id: None,
                },
                ConsumableUseEvent {
                    time: 90.0,
                    entity_id: 9,
                    usage_type: 1,
                    consumable_id: 8,
                    duration: 28.0,
                    target_x: None,
                    target_z: None,
                    target_id: None,
                },
                ConsumableUseEvent {
                    time: 95.0,
                    entity_id: 9,
                    usage_type: 1,
                    consumable_id: 3,
                    duration: 20.0,
                    target_x: None,
                    target_z: None,
                    target_id: None,
                },
            ],
            engine: &[
                EngineStateSample {
                    time: 80.0,
                    entity_id: 9,
                    power: Some(8),
                    dir: None,
                },
                EngineStateSample {
                    time: 90.0,
                    entity_id: 9,
                    power: None,
                    dir: Some(-1),
                },
            ],
            smokes: &[SmokeScreenEvent {
                time: 90.0,
                entity_id: 21,
                x: 30.0,
                y: 0.0,
                z: 0.0,
                radius: Some(17.0), // GP units → 510 m
                height: Some(5.0),
                end_time: Some(150.0),
            }],
            e11_known: true,
        };
        let (rows, _stats) = export_decision_dataset(
            &stream,
            &ships,
            None,
            DEFAULT_EYE_HEIGHT,
            &params,
            Some("replayV2"),
            Some("pvp"),
            &events,
        );
        assert!(rows.iter().all(|r| r.owner_entity_id == 9));

        // ── t=101: the feature-probe row (labelA=0 — 8 is dark by gaps). ──
        let r101 = rows
            .iter()
            .find(|r| (r.t - 101.0).abs() < 0.1)
            .expect("t=101 row");
        assert!(!r101.label_a_can_fire);
        assert_eq!(r101.label_b_fired, None);
        assert_eq!(r101.label_b_hit, None);
        assert_eq!(r101.label_b_soft, None);
        assert_eq!(r101.feature_version, 2);
        assert!(r101.e11_events_known);
        // Consumable windows: damcon (100,5 s) → (105-101)/5 = 0.8; repair
        // (90,28 s) → 17/28; other id-3 (95,20 s) → 14/20.
        assert!((r101.own_damcon_frac - 0.8).abs() < 1e-5);
        assert!((r101.own_repair_frac - 17.0 / 28.0).abs() < 1e-5);
        assert!((r101.own_other_consumable_frac - 0.7).abs() < 1e-5);
        // Engine fold: power 8/10 at 80, dir -1 at 90 — both still current.
        assert!((r101.own_engine_power - 0.8).abs() < 1e-5);
        assert!((r101.own_engine_dir - (-1.0)).abs() < 1e-5);
        // Smoke: one cloud (r=17 GP → 510 m) at (30, 0); the decider at
        // (10, 0) is 20 units (117 m) from its centre → inside.
        assert!(r101.own_in_smoke);
        assert!((r101.active_smoke_count_frac - 1.0 / 8.0).abs() < 1e-6);
        let area = std::f32::consts::PI * 0.51f32 * 0.51;
        assert!(
            (r101.active_smoke_area_feat - (area + 1.0).ln() / 3.0).abs() < 1e-4,
            "area {}",
            r101.active_smoke_area_feat
        );
        // Weather: 1 % into the 100 s lerp 2000 → 266.6664 units → cap
        // 1982.67 units = 59 480 m → 0.9913 of the 60 km ceiling; the
        // cyclone announced at 350 s is 249 s out → ramp 0.17.
        assert!(
            (r101.vision_cap_frac - (1982.6666 * 30.0 / 60000.0)).abs() < 1e-3,
            "cap {}",
            r101.vision_cap_frac
        );
        assert!((r101.weather_incoming_frac - 0.17).abs() < 1e-3);
        // Ally builds: exactly one TEAMMATE (7) with radar → 1/4; no hydro.
        assert!((r101.ally_radar_count_frac - 0.25).abs() < 1e-6);
        assert!(r101.ally_hydro_count_frac.abs() < 1e-6);
        // Enemy slot 8: gap-stale but EXPLICITLY spotted (the correction),
        // inside the cloud, radar-lit (ally 7 sits 20 units from 8 — far
        // inside the nominal 12 km), engine unknown (no samples).
        assert_eq!(r101.enemies.len(), 1);
        let e8 = &r101.enemies[0];
        assert_eq!(e8.entity_id, 8);
        assert!(!e8.observed_now);
        assert_eq!(e8.spotted_now, Some(true));
        assert!(e8.inside_smoke);
        assert!(e8.radar_lit);
        assert!(e8.is_enemy);
        assert_eq!(e8.engine_power_frac, None);
        // Friend slot 7: recorder-side, never radar-flagged, spotted since 0.
        assert_eq!(r101.friends.len(), 1);
        let f7 = &r101.friends[0];
        assert_eq!(f7.entity_id, 7);
        assert!(f7.is_enemy == false);
        assert!(!f7.radar_lit);
        assert_eq!(f7.spotted_now, Some(true));
        // Serialization: v2 keys, camelCase.
        let line = serde_json::to_string(r101).expect("serialize");
        assert!(line.contains("\"featureVersion\":2"));
        assert!(line.contains("\"spottedNow\":true"));
        assert!(line.contains("\"radarLit\":true"));
        assert!(line.contains("\"e11EventsKnown\":true"));

        // ── t=123: back in contact; fired (salvo at 124) but the outcome
        //    window (125, 168] holds NO hit → hit=false, soft=0.3. ──
        let r123 = rows
            .iter()
            .find(|r| (r.t - 123.0).abs() < 0.1)
            .expect("t=123 row");
        assert!(r123.label_a_can_fire);
        assert_eq!(r123.label_b_fired, Some(true));
        assert_eq!(r123.owner_shots_hit, 0);
        assert_eq!(r123.label_b_hit, Some(false));
        assert!((r123.label_b_soft.unwrap() - 0.3).abs() < 1e-6);
        // 23 % into the lerp: cap 1601.33 units = 48 040 m → 0.8007.
        assert!(
            (r123.vision_cap_frac - (1601.3333 * 30.0 / 60000.0)).abs() < 1e-3,
            "cap {}",
            r123.vision_cap_frac
        );

        // ── t=99: fired (salvo at 100) and the window (101, 144] contains
        //    the t=110 shotKill → hit=true, soft=1.0. ──
        let r99 = rows
            .iter()
            .find(|r| (r.t - 99.0).abs() < 0.1)
            .expect("t=99 row");
        assert_eq!(r99.label_b_fired, Some(true));
        assert_eq!(r99.owner_shots_hit, 1);
        assert_eq!(r99.label_b_hit, Some(true));
        assert!((r99.label_b_soft.unwrap() - 1.0).abs() < 1e-6);

        // ── no-events export: every E11-derived value takes its unknown
        //    sentinel (-1 / None / flag false); smoke rides the same view
        //    so it goes to zero too, while weather (on the stream) and the
        //    ally builds stay live. ──
        let (rows_v1ish, _) = export_decision_dataset(
            &stream,
            &ships,
            None,
            DEFAULT_EYE_HEIGHT,
            &params,
            None,
            None,
            &FeatureEvents::empty(),
        );
        let s101 = rows_v1ish
            .iter()
            .find(|r| (r.t - 101.0).abs() < 0.1)
            .expect("t=101 row (empty events)");
        assert!(!s101.e11_events_known);
        assert_eq!(s101.own_damcon_frac, -1.0);
        assert_eq!(s101.own_repair_frac, -1.0);
        assert_eq!(s101.own_other_consumable_frac, -1.0);
        assert_eq!(s101.own_engine_power, -1.0);
        assert_eq!(s101.own_engine_dir, 0.0);
        assert_eq!(s101.enemies[0].spotted_now, None);
        assert_eq!(s101.enemies[0].engine_power_frac, None);
        assert!(!s101.own_in_smoke);
        assert_eq!(s101.active_smoke_count_frac, 0.0);
        // Radar geometry (builds) and the cyclone lerp (weather stream)
        // survive the empty-E11 view untouched.
        assert!(s101.enemies[0].radar_lit);
        assert!((s101.ally_radar_count_frac - 0.25).abs() < 1e-6);
        assert!(
            (s101.vision_cap_frac - (1982.6666 * 30.0 / 60000.0)).abs() < 1e-3,
            "cap {}",
            s101.vision_cap_frac
        );
    }

    /// E9 step 1 against the real reference replay — run with
    /// `WOWSP_TEST_REPLAY=<path> [WOWSP_DATASET_OUT=<file>] [WOWSP_TEST_LOS_GRID=<path>]
    /// cargo test -p wowsp_tauri e9_export -- --nocapture`. Writes the JSONL
    /// training set when `WOWSP_DATASET_OUT` is set, prints the export totals
    /// (must reproduce the E7 eligible numbers) and skips when the env var is
    /// unset.
    #[test]
    fn e9_dataset_export_on_real_replay() {
        let Ok(path) = std::env::var("WOWSP_TEST_REPLAY") else {
            eprintln!("[e9] WOWSP_TEST_REPLAY not set - skipping");
            return;
        };
        let params = FireSampleParams::default();
        let (stream, ev) = super::super::replay::decode_replay_stream_with_events(&path)
            .expect("decode real replay");
        let events = FeatureEvents::for_version(stream.version.as_deref(), &ev);
        let vehicles = read_roster(&path).expect("roster");
        let ships = ship_infos(&stream, &vehicles);
        let grid_path = match std::env::var("WOWSP_TEST_LOS_GRID") {
            Ok(p) => Some(std::path::PathBuf::from(p)),
            Err(_) => {
                let default = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../scripts/experiments/out/50_Gold_harbor/terrain_los.npz");
                default.exists().then_some(default)
            },
        };
        let grid = grid_path
            .map(|p| LosGrid::load_npz(&p))
            .transpose()
            .expect("load LOS raster when present");
        let (rows, stats) = export_decision_dataset(
            &stream,
            &ships,
            grid.as_ref(),
            DEFAULT_EYE_HEIGHT,
            &params,
            std::path::Path::new(&path)
                .file_stem()
                .and_then(|s| s.to_str()),
            read_game_mode(std::path::Path::new(&path)).as_deref(),
            &events,
        );
        // Cross-check against E7: labelA=1 rows == eligible-with-history.
        let e7 = count_decision_samples(&stream, &ships, &params);
        assert_eq!(
            stats.rows_can_fire, e7.total_eligible_with_history,
            "labelA rows must reproduce E7 eligible"
        );
        assert_eq!(
            stats.rows_fired, e7.total_fired_with_history,
            "labelB rows must reproduce E7 fired"
        );
        assert!(stats.rows > stats.rows_can_fire, "censoring rows exported");
        assert!(
            stats.rows_can_fire > 500,
            "can-fire rows {}",
            stats.rows_can_fire
        );
        assert!(
            (0.01..=0.60).contains(&stats.positive_rate_among_can_fire),
            "positive rate {}",
            stats.positive_rate_among_can_fire
        );
        for r in &rows {
            assert!(r.enemies.len() <= ENEMY_SLOTS);
            assert!(r.friends.len() <= FRIEND_SLOTS);
            assert_eq!(r.label_b_fired.is_some(), r.label_a_can_fire);
            assert_eq!(r.feature_version, FEATURE_VERSION);
            // E15: the hit/soft variants censor exactly with labelB.
            assert_eq!(r.label_b_hit.is_some(), r.label_b_fired.is_some());
            assert_eq!(r.label_b_soft.is_some(), r.label_b_fired.is_some());
        }
        // E14 coverage: the E11 streams exist iff this replay is 15.8.x —
        // and when they do, the explicit spotted verdicts must cover a real
        // share of slots (the reference 15.8 capture fires ~1.8k events).
        let expect_e11 = e11_events_expected(stream.version.as_deref());
        assert_eq!(
            rows.iter().all(|r| r.e11_events_known == expect_e11),
            true,
            "e11EventsKnown must match the version gate uniformly"
        );
        if expect_e11 {
            let slots: usize = rows.iter().map(|r| r.enemies.len() + r.friends.len()).sum();
            let spotted: usize = rows
                .iter()
                .flat_map(|r| r.enemies.iter().chain(r.friends.iter()))
                .filter(|s| s.spotted_now.is_some())
                .count();
            let corrected: usize = rows
                .iter()
                .flat_map(|r| r.enemies.iter().chain(r.friends.iter()))
                .filter(|s| s.spotted_now == Some(true) && !s.observed_now)
                .count();
            let smoky: usize = rows.iter().filter(|r| r.own_in_smoke).count();
            eprintln!(
                "[e14] v2 coverage on {}: {} slots, {} with explicit vision verdict ({:.1}%), {} gap-vs-vision corrections, {} own-in-smoke rows",
                path,
                slots,
                spotted,
                100.0 * spotted as f32 / slots.max(1) as f32,
                corrected,
                smoky
            );
            assert!(spotted > 0, "explicit vision stream must cover slots");
        }
        // labelA=1 rows must carry at least one observed-now in-range enemy.
        for r in rows.iter().filter(|r| r.label_a_can_fire) {
            assert!(
                r.enemies.iter().any(|e| e.observed_now),
                "can-fire row without an observed enemy at t={}",
                r.t
            );
        }
        // E13 outcome fields: plausible distributions + the game-mode tag.
        // The hit rate among rows that actually fired must land in a human
        // band (real players hit ~15-45% of main-battery shells); the HP-loss
        // window median is reported for the 0.62x calibration comparison.
        let fired_rows: Vec<&FireDatasetRow> = rows
            .iter()
            .filter(|r| r.label_b_fired == Some(true) && r.owner_shots_fired > 0)
            .collect();
        let hit_rates: Vec<f32> = fired_rows
            .iter()
            .map(|r| r.owner_shots_hit as f32 / r.owner_shots_fired as f32)
            .collect();
        let hp_med =
            percentile(rows.iter().map(|r| r.enemy_hp_lost_nearby).collect(), 0.5).unwrap_or(0.0);
        let hp_p90 =
            percentile(rows.iter().map(|r| r.enemy_hp_lost_nearby).collect(), 0.9).unwrap_or(0.0);
        let total_hp_lost: f32 = rows.iter().map(|r| r.enemy_hp_lost_nearby).sum();
        let mode_counts: BTreeMap<Option<&str>, usize> = {
            let mut m: BTreeMap<Option<&str>, usize> = BTreeMap::new();
            for r in &rows {
                *m.entry(r.game_mode.as_deref()).or_default() += 1;
            }
            m
        };
        eprintln!(
            "[e13] outcome fields: {} fired rows with window shells; hit-rate p50 {:.3} (n={} rows with any window hit: {}); enemyHpLostNearby over ALL rows: median {:.0} / p90 {:.0} / total {:.0}; gameMode histogram {:?}",
            fired_rows.len(),
            percentile(hit_rates.clone(), 0.5).unwrap_or(f32::NAN),
            hit_rates.len(),
            rows.iter().filter(|r| r.owner_shots_hit > 0).count(),
            hp_med,
            hp_p90,
            total_hp_lost,
            mode_counts
        );
        // Consistency: the sum of per-row HP-loss windows is window-summed
        // per decision row (rows overlap heavily), so it legitimately exceeds
        // the battle's total enemy HP loss — but every row's window total
        // must stay non-negative and finite, and rows that fired must
        // correlate with non-zero outcome activity more often than not.
        assert!(rows.iter().all(|r| r.enemy_hp_lost_nearby.is_finite()));
        let with_hit = rows.iter().filter(|r| r.owner_shots_hit > 0).count();
        assert!(
            with_hit > 0,
            "expected some rows with window hits on a real gun-ship replay"
        );
        assert!(
            !mode_counts.contains_key(&None),
            "real replay must carry a game-mode tag"
        );
        // #1418 calibration magnitude: over the WHOLE battle (no decision
        // windows — the ledger view), the enemy HP drops covered by any
        // ship's near impacts divided by the enemy side's total HP loss.
        // The webui partition model's dealt ledger measured 0.62x of
        // server-authoritative damage (median over 119 battles); this
        // windowless coverage ratio is the same-order consistency check for
        // the outcome substrate (DoT and impact-less damage stay uncovered
        // in both).
        {
            let mut covered: f32 = 0.0;
            let mut total: f32 = 0.0;
            let impacts = &stream.shot_kills;
            for victim in ships {
                if victim.team_id.is_none() || victim.team_ambiguous {
                    continue;
                }
                let drops: Vec<HpDrop> = victim
                    .traj
                    .hp_samples
                    .windows(2)
                    .filter_map(|w| {
                        let delta = w[0].value.saturating_sub(w[1].value);
                        (delta >= OUTCOME_HP_MIN_DELTA).then_some(HpDrop {
                            time: w[1].time,
                            delta: delta as f32,
                        })
                    })
                    .collect();
                total += drops.iter().map(|d| d.delta).sum::<f32>();
                'drop: for d in &drops {
                    // Any ship's impact (not the victim's own) covering the
                    // drop and near the hull — the claim-partition candidate
                    // set, full-credit relaxation.
                    for k in impacts {
                        if k.owner_id == victim.traj.entity_id {
                            continue;
                        }
                        if k.time >= d.time - OUTCOME_HP_AFTER_S
                            && k.time < d.time + OUTCOME_HP_BEFORE_S
                            && position_at(victim.traj, k.time).is_some_and(|(vx, vz)| {
                                (vx - k.x).hypot(vz - k.z) <= OUTCOME_HIT_RADIUS_UNITS
                            })
                        {
                            covered += d.delta;
                            continue 'drop;
                        }
                    }
                }
            }
            eprintln!(
                "[e13] #1418-calibre check: enemy HP drops covered by any near impact {:.0} / total enemy HP lost {:.0} = {:.2}x (webui partition ledger: 0.62x of server damage)",
                covered,
                total,
                if total > 0.0 {
                    covered / total
                } else {
                    f32::NAN
                }
            );
            // Per-owner shotKills volume (top 5): the hit counter's substrate —
            // sanity scale for the window counts (one battle per ship should
            // be O(100) events; thousands imply the event stream carries
            // splashes on this version).
            let mut per_owner: BTreeMap<i32, usize> = BTreeMap::new();
            for k in &stream.shot_kills {
                *per_owner.entry(k.owner_id).or_default() += 1;
            }
            let mut top: Vec<(i32, usize)> = per_owner.into_iter().collect();
            top.sort_by(|a, b| b.1.cmp(&a.1));
            let top5: Vec<String> = top
                .iter()
                .take(5)
                .map(|(id, n)| format!("{id}:{n}"))
                .collect();
            eprintln!(
                "[e13] shotKills total {} over {} owners; top {}",
                stream.shot_kills.len(),
                top.len(),
                top5.join(", ")
            );
        }
        eprintln!(
            "[e9] export: {} deciders, {} rows ({} can-fire, {} fired, rate {:.3}); E7 eligible {} fired {}",
            stats.owners,
            stats.rows,
            stats.rows_can_fire,
            stats.rows_fired,
            stats.positive_rate_among_can_fire,
            e7.total_eligible_with_history,
            e7.total_fired_with_history
        );
        match std::env::var("WOWSP_DATASET_OUT") {
            Ok(out) => {
                let out_path = std::path::PathBuf::from(&out);
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent).expect("create dataset parent dir");
                }
                use std::io::Write;
                let mut f = std::fs::File::create(&out_path).expect("create dataset file");
                for r in &rows {
                    writeln!(f, "{}", serde_json::to_string(r).expect("serialize row"))
                        .expect("write row");
                }
                let bytes = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
                eprintln!(
                    "[e9] wrote {} rows to {} ({:.1} KiB)",
                    rows.len(),
                    out,
                    bytes as f32 / 1024.0
                );
            },
            Err(_) => eprintln!("[e9] WOWSP_DATASET_OUT not set - dataset not written"),
        }
    }

    /// E12 synthetic: the batch core tolerates per-file failures, aggregates
    /// rows/stats only from successes, stamps every row with the file's
    /// replay id (path relative to the root, forward slashes — also through
    /// nested subfolders), and never aborts. Uses a fake `process` closure so
    /// no real replay bytes are needed: the decoding path itself is covered by
    /// the env-gated real-replay test below.
    #[test]
    fn synthetic_batch_ingestion_tolerance_and_aggregation() {
        let root = std::env::temp_dir().join(format!(
            "wowsp_fire_batch_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(root.join("sub")).expect("mkdir");
        // Empty file (0 rows is a legal success), a "corrupt" file (random
        // bytes — here simulated by the closure failing), a nested success,
        // and a non-replay file that must be ignored by the walker.
        std::fs::write(root.join("a_empty.wowsreplay"), b"").expect("write");
        std::fs::write(
            root.join("b_corrupt.wowsreplay"),
            [0x12u8, 0x32, 0x34, 0x11, 0xFF],
        )
        .expect("write");
        std::fs::write(root.join("sub/c_good.wowsreplay"), b"good").expect("write");
        std::fs::write(root.join("notes.txt"), b"not a replay").expect("write");
        let mut files = Vec::new();
        collect_replay_files(&root, &mut files);
        files.sort();
        assert_eq!(files.len(), 3, "walker must skip non-replay files");
        assert!(files[0].ends_with("a_empty.wowsreplay"));

        // Fake exporter: one file yields 2 rows (1 can-fire / 1 fired), one
        // fails with a reason, one succeeds with zero rows.
        let mk_rows = || -> Vec<FireDatasetRow> {
            let base = FireDatasetRow {
                core: DecisionRowCore {
                    replay_id: None,
                    replay_version: None,
                    map_name: None,
                    owner_entity_id: 9,
                    ship_id: None,
                    team_id: 1,
                    t: 10.0,
                    own_speed_kt: None,
                    own_hp_frac: None,
                    own_reload_frac: 1.0,
                    own_range_m: 10_000.0,
                    zones_owned_0: 0,
                    zones_owned_1: 0,
                    zones_owned_2: 0,
                    zones_owned_other: 0,
                    zones_active_progress: 0,
                    events_shells_30s: 0,
                    events_torps_30s: 0,
                    events_explosions_30s: 0,
                    events_explosions_near_30s: 0,
                    enemies: Vec::new(),
                    friends: Vec::new(),
                    game_mode: None,
                    feature_version: FEATURE_VERSION,
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
                label_a_can_fire: true,
                label_b_fired: Some(true),
                owner_shots_hit: 0,
                owner_shots_fired: 0,
                enemy_hp_lost_nearby: 0.0,
                label_b_hit: None,
                label_b_soft: None,
            };
            let mut negative = base.clone();
            negative.core.t = 12.0;
            negative.label_a_can_fire = false;
            negative.label_b_fired = None;
            vec![base, negative]
        };
        let stats2 = FireDatasetExportStats {
            owners: 1,
            rows: 2,
            rows_can_fire: 1,
            rows_fired: 1,
            positive_rate_among_can_fire: 1.0,
        };
        let empty_stats = FireDatasetExportStats {
            owners: 0,
            rows: 0,
            rows_can_fire: 0,
            rows_fired: 0,
            positive_rate_among_can_fire: 0.0,
        };
        let (rows, summary) = ingest_replay_files(&root, files, |path| {
            match path.file_name().and_then(|n| n.to_str()) {
                Some("a_empty.wowsreplay") => Ok((Vec::new(), empty_stats.clone())),
                Some("b_corrupt.wowsreplay") => {
                    bail!("not a valid wowsreplay (magic mismatch or truncated)")
                },
                _ => Ok((mk_rows(), stats2.clone())),
            }
        });

        // Aggregation: 3 seen / 2 exported / 1 failed; rows only from the
        // success, all stamped with its replay id (nested, forward slashes).
        assert_eq!(summary.files_seen, 3);
        assert_eq!(summary.files_exported, 2);
        assert_eq!(summary.files_failed, 1);
        assert_eq!(summary.rows, 2);
        assert_eq!(summary.rows_can_fire, 1);
        assert_eq!(summary.rows_fired, 1);
        assert_eq!(rows.len(), 2);
        assert!(
            rows.iter()
                .all(|r| r.replay_id.as_deref() == Some("sub/c_good.wowsreplay"))
        );
        // Per-file report carries both outcomes with the failure reason.
        let failed = summary
            .per_file
            .iter()
            .find(|f| f.file_name == "b_corrupt.wowsreplay")
            .expect("failed entry");
        match &failed.outcome {
            FireDatasetBatchOutcome::Failed { reason } => {
                assert!(reason.contains("not a valid wowsreplay"));
            },
            other => panic!("expected Failed, got {other:?}"),
        }
        let ok = summary
            .per_file
            .iter()
            .find(|f| f.file_name == "a_empty.wowsreplay")
            .expect("empty entry");
        assert!(matches!(
            ok.outcome,
            FireDatasetBatchOutcome::Exported { .. }
        ));
        assert_eq!(ok.replay_id, "a_empty.wowsreplay");
        // Rows serialize with the replayId key.
        let line = serde_json::to_string(&rows[0]).expect("serialize");
        assert!(line.contains("\"replayId\":\"sub/c_good.wowsreplay\""));
        // Root errors (not a directory) surface as Err before any walking.
        assert!(
            export_decision_dataset_dir(
                &root.join("does_not_exist"),
                None,
                DEFAULT_EYE_HEIGHT,
                &FireSampleParams::default()
            )
            .is_err()
        );
        std::fs::remove_dir_all(&root).ok();
    }

    /// E12 / G2 against real replay bytes — run with
    /// `WOWSP_TEST_REPLAY_DIR=<dir>` (a folder of replays) or
    /// `WOWSP_TEST_REPLAY=<file>` (copied into a temp folder next to a
    /// corrupt and an empty file, proving the tolerance on real bytes).
    /// `WOWSP_DATASET_OUT` additionally writes the aggregated JSONL (the
    /// multi-replay training input). Skips when neither env var is set.
    #[test]
    fn e12_batch_export_on_real_replays() {
        let replay_dir = match std::env::var("WOWSP_TEST_REPLAY_DIR") {
            Ok(dir) => std::path::PathBuf::from(dir),
            Err(_) => match std::env::var("WOWSP_TEST_REPLAY") {
                Ok(file) => {
                    let root = std::env::temp_dir().join(format!(
                        "wowsp_fire_batch_real_{}_{}",
                        std::process::id(),
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_nanos())
                            .unwrap_or(0)
                    ));
                    std::fs::create_dir_all(&root).expect("mkdir");
                    let name = std::path::Path::new(&file)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "real.wowsreplay".into());
                    std::fs::copy(&file, root.join(&name)).expect("copy real replay");
                    // A corrupt (random bytes) and an empty replay planted
                    // next to the real one: the batch must record both and
                    // still export the real one.
                    std::fs::write(
                        root.join("zz_corrupt.wowsreplay"),
                        [0x5Au8, 0x01, 0xFF, 0x00, 0x33, 0x77, 0x11, 0x42, 0x00, 0x99],
                    )
                    .expect("write corrupt");
                    std::fs::write(root.join("zz_empty.wowsreplay"), b"").expect("write empty");
                    root
                },
                Err(_) => {
                    eprintln!("[e12] WOWSP_TEST_REPLAY_DIR / WOWSP_TEST_REPLAY not set - skipping");
                    return;
                },
            },
        };
        let params = FireSampleParams::default();
        // Per-map LOS raster directory: defaults to the experiments output
        // layout (<out>/<map name>/terrain_los.npz).
        let los_dir = match std::env::var("WOWSP_TEST_LOS_DIR") {
            Ok(p) => Some(std::path::PathBuf::from(p)),
            Err(_) => {
                let default = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../scripts/experiments/out");
                default.exists().then_some(default)
            },
        };
        let (rows, summary) = export_decision_dataset_dir(
            &replay_dir,
            los_dir.as_deref(),
            DEFAULT_EYE_HEIGHT,
            &params,
        )
        .expect("batch runs");
        eprintln!(
            "[e12] batch {}: {} seen / {} exported / {} failed -> {} rows ({} can-fire, {} fired, rate {:.3}), {} deciders",
            summary.root_dir,
            summary.files_seen,
            summary.files_exported,
            summary.files_failed,
            summary.rows,
            summary.rows_can_fire,
            summary.rows_fired,
            summary.positive_rate_among_can_fire,
            summary.deciders
        );
        for f in &summary.per_file {
            match &f.outcome {
                FireDatasetBatchOutcome::Exported { stats } => eprintln!(
                    "[e12] OK   {} -> {} rows / {} can-fire / {} fired / {} owners",
                    f.replay_id, stats.rows, stats.rows_can_fire, stats.rows_fired, stats.owners
                ),
                FireDatasetBatchOutcome::Failed { reason } => {
                    eprintln!("[e12] FAIL {} -> {}", f.replay_id, reason)
                },
            }
        }
        // At least one file exported; every exported row carries a replay id
        // that exists in the per-file report (the GroupKFold key).
        assert!(summary.files_exported >= 1, "nothing exported");
        assert!(summary.rows > 0);
        let ids: std::collections::BTreeSet<&str> = summary
            .per_file
            .iter()
            .filter(|f| matches!(f.outcome, FireDatasetBatchOutcome::Exported { .. }))
            .map(|f| f.replay_id.as_str())
            .collect();
        assert!(
            rows.iter()
                .all(|r| r.replay_id.as_deref().is_some_and(|id| ids.contains(id)))
        );
        // Failure reasons are recorded, never swallowed.
        for f in &summary.per_file {
            if let FireDatasetBatchOutcome::Failed { reason } = &f.outcome {
                assert!(!reason.is_empty());
            }
        }
        // Reference-replay sanity: the known export lands byte-exact (rows
        // are LOS-invariant — the grid only fills terrainBlocked).
        if rows.iter().any(|r| {
            r.replay_id
                .as_deref()
                .is_some_and(|id| id.contains("50_Gold_harbor"))
        }) {
            assert!(
                summary.rows_can_fire >= 500,
                "can-fire {}",
                summary.rows_can_fire
            );
            assert!(
                (0.01..=0.60).contains(&summary.positive_rate_among_can_fire),
                "positive rate {}",
                summary.positive_rate_among_can_fire
            );
        }
        match std::env::var("WOWSP_DATASET_OUT") {
            Ok(out) => {
                let out_path = std::path::PathBuf::from(&out);
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent).expect("create dataset parent dir");
                }
                use std::io::Write;
                let mut f = std::fs::File::create(&out_path).expect("create dataset file");
                for r in &rows {
                    writeln!(f, "{}", serde_json::to_string(r).expect("serialize row"))
                        .expect("write row");
                }
                eprintln!("[e12] wrote {} rows to {}", rows.len(), out);
            },
            Err(_) => eprintln!("[e12] WOWSP_DATASET_OUT not set - dataset not written"),
        }
    }

    /// E16: the 17-class sector label against hand-computed angles —
    /// boundary semantics (exactly on ±22.5° lands in the boundary sector;
    /// the wrap at ±180° agrees), and the no-move threshold (strictly below
    /// 100 m is class 16, AT 100 m is directional).
    #[test]
    fn synthetic_move_sector_label_boundaries() {
        use std::f32::consts::{FRAC_PI_2, FRAC_PI_4, FRAC_PI_8, PI};
        assert_eq!(move_sector_label(0.0, 500.0), 0);
        assert_eq!(move_sector_label(FRAC_PI_8, 500.0), 1); // exactly +22.5°
        assert_eq!(move_sector_label(-FRAC_PI_8, 500.0), 15); // exactly -22.5°
        assert_eq!(move_sector_label(FRAC_PI_4, 500.0), 2); // +45°
        assert_eq!(move_sector_label(-FRAC_PI_2, 500.0), 12); // -90°
        assert_eq!(move_sector_label(PI, 500.0), 8); // dead astern
        assert_eq!(move_sector_label(-PI, 500.0), 8); // wrap agreement
        // Threshold: strict `<`.
        assert_eq!(move_sector_label(0.0, 99.9), MOVE_SECTOR_NONE);
        assert_eq!(move_sector_label(0.0, 100.0), 0);
    }

    /// E16 synthetic: movement export labels, gates and the decider set.
    /// Ships: 9 = the firing gun ship (fire history, stationary → sector
    /// 16); 8 = recorder-side cruiser sailing +x under yaw 0 (sector 0,
    /// movedDistM = 24 units × 5.86); 7 = never-fires ship sailing +x under
    /// yaw π/2 (relative frame: absolute bearing 0 vs heading π/2 → sector
    /// 12 — the CV/never-fired inclusion check); 6 = dies at t=150 (rows
    /// must stop before death − window); 4 = goes dark at t=80 (window
    /// censorship); 5 = ambiguous team (excluded).
    #[test]
    fn synthetic_move_dataset_export_labels_and_gates() {
        use std::f32::consts::PI;
        let params = FireSampleParams::default();
        // Yaw-carrying sample builder (the shared helper pins yaw 0).
        let ms = |t: f32, eid: i32, x: f32, z: f32, yaw: f32| PositionSample {
            time: t,
            entity_id: eid,
            vehicle_id: 1,
            x,
            y: 0.0,
            z,
            yaw,
        };
        // Stationary gun ship 9 (team 1) with two main salvos.
        let gun = trajectory(
            9,
            Some(222),
            (0..400)
                .map(|i| ms(i as f32 * 0.5, 9, 10.0, 0.0, 0.0))
                .collect(),
        );
        // Cruiser 8 (team 0, recorder): +x at 2 u/s, yaw 0.
        let cruiser = trajectory(
            8,
            Some(111),
            (0..400)
                .map(|i| ms(i as f32 * 0.5, 8, 100.0 + i as f32, 0.0, 0.0))
                .collect(),
        );
        // Never-fires ship 7 (team 0): +x at 2 u/s, yaw pi/2.
        let flanker = trajectory(
            7,
            Some(110),
            (0..400)
                .map(|i| ms(i as f32 * 0.5, 7, 200.0 + i as f32, 20.0, PI / 2.0))
                .collect(),
        );
        // Doomed ship 6 (team 1): alive until t=150.
        let mut doomed = trajectory(
            6,
            Some(109),
            (0..300)
                .map(|i| ms(i as f32 * 0.5, 6, 300.0, 300.0, 0.0))
                .collect(),
        );
        doomed.death_time = Some(150.0);
        // Dark-gap ship 4 (team 1): samples 0..80 then 200..300.
        let mut dark = trajectory(4, Some(108), Vec::new());
        dark.samples = (0..=160)
            .chain(400..600)
            .map(|i| ms(i as f32 * 0.5, 4, 400.0, -50.0, 0.0))
            .collect();
        let mut shells = Vec::new();
        for k in 0..2u32 {
            for b in 0..4u16 {
                shells.push(shell(
                    100.0 + k as f32 * 24.0,
                    9,
                    k as i32,
                    b,
                    (10.0, 0.5),
                    (100.0, 0.0),
                ));
            }
        }
        let stream = ReplayStream {
            trajectories: vec![gun, cruiser, flanker, doomed, dark],
            recorder_vehicle_id: Some(8),
            shell_launches: shells,
            ..minimal_stream()
        };
        // Roster: shipId 555 on BOTH sides (via ships 5a/5b trajectories)
        // stays ambiguous — one representative trajectory is enough.
        let amb = trajectory(5, Some(555), vec![ms(0.0, 5, 0.0, 0.0, 0.0)]);
        let mut stream = stream;
        stream.trajectories.push(amb);
        let vehicles = vec![
            roster_entry(1, 0, 111),
            roster_entry(2, 2, 222),
            roster_entry(3, 0, 110),
            roster_entry(4, 2, 109),
            roster_entry(5, 2, 108),
            roster_entry(6, 0, 555),
            roster_entry(7, 2, 555),
        ];
        let ships = ship_infos(&stream, &vehicles);

        let (rows, stats) = export_move_dataset(
            &stream,
            &ships,
            None,
            DEFAULT_EYE_HEIGHT,
            &params,
            Some("replayM"),
            Some("pvp"),
            &FeatureEvents::empty(),
        );
        // Decider set: every team-known ship — including the never-fired 7/8
        // (the fire export on the same stream yields only owner 9).
        assert_eq!(stats.owners, 5, "owners {}", stats.owners);
        let (_, fire_stats) = export_decision_dataset(
            &stream,
            &ships,
            None,
            DEFAULT_EYE_HEIGHT,
            &params,
            None,
            None,
            &FeatureEvents::empty(),
        );
        assert_eq!(fire_stats.owners, 1);
        let present: BTreeSet<i32> = rows.iter().map(|r| r.core.owner_entity_id).collect();
        assert!(
            !present.contains(&5),
            "ambiguous-team ship must have no rows"
        );
        for id in [9, 8, 7, 6, 4] {
            assert!(present.contains(&id), "ship {id} missing from move rows");
        }
        // Histogram consistency.
        assert_eq!(stats.sector_histogram.len(), MOVE_SECTOR_COUNT);
        assert_eq!(stats.sector_histogram.iter().sum::<usize>(), stats.rows);
        assert_eq!(
            stats.rows_no_move,
            stats.sector_histogram[MOVE_SECTOR_NONE as usize]
        );
        assert_eq!(stats.rows, rows.len());

        // Ship 8 at t=101: displacement from x(105) to x(117) = 24 units
        // (140.64 m), bearing 0, yaw 0 → sector 0.
        let r8 = rows
            .iter()
            .find(|r| r.core.owner_entity_id == 8 && (r.core.t - 101.0).abs() < 0.1)
            .expect("ship 8 t=101 row");
        assert!(
            (r8.moved_dist_m - 24.0 * METERS_PER_UNIT).abs() < 0.5,
            "dist {}",
            r8.moved_dist_m
        );
        assert!(r8.move_bearing_rad.abs() < 1e-5);
        assert_eq!(r8.move_sector, 0);
        assert!(r8.own_yaw_rad.abs() < 1e-5);
        // Ship 7 (same displacement, yaw pi/2): relative frame → sector 12.
        let r7 = rows
            .iter()
            .find(|r| r.core.owner_entity_id == 7 && (r.core.t - 101.0).abs() < 0.1)
            .expect("ship 7 t=101 row");
        assert!(
            (r7.moved_dist_m - 24.0 * METERS_PER_UNIT).abs() < 0.5,
            "dist {}",
            r7.moved_dist_m
        );
        assert!((r7.own_yaw_rad - PI / 2.0).abs() < 1e-5);
        assert_eq!(r7.move_sector, 12, "relative-frame conversion");
        // Ship 9: stationary → no-move class; reload features still exported
        // (t=101 sits right after the t=100 salvo, reload ≈ 24 s → frac ~0).
        let r9 = rows
            .iter()
            .find(|r| r.core.owner_entity_id == 9 && (r.core.t - 101.0).abs() < 0.1)
            .expect("ship 9 t=101 row");
        assert_eq!(r9.move_sector, MOVE_SECTOR_NONE);
        assert_eq!(r9.core.owner_entity_id, 9);
        assert!(
            r9.core.own_reload_frac < 0.15,
            "frac {}",
            r9.core.own_reload_frac
        );
        // Ship 6: no rows at/after death, and none with a truncated window
        // (last row at most t = death − 16).
        for r in rows.iter().filter(|r| r.core.owner_entity_id == 6) {
            assert!(r.core.t < 150.0, "row after death at {}", r.core.t);
            assert!(
                r.core.t + MOVE_LABEL_END_S <= 150.0,
                "truncated window at {}",
                r.core.t
            );
        }
        // Ship 4: window endpoints inside the dark gap are censored, never
        // fabricated — its rows all sit before the gap (t ≤ 65: t+16 ≤ 81,
        // the trailing sample at 80 still fresh) or after it resumes
        // (t ≥ 205), never inside, and the censored counter saw the
        // dark-window points (t = 69..81).
        for r in rows.iter().filter(|r| r.core.owner_entity_id == 4) {
            assert!(
                r.core.t <= 65.5 || r.core.t >= 200.5,
                "dark-gap row at {}",
                r.core.t
            );
        }
        assert!(
            stats.rows_censored_window >= 3,
            "censored {}",
            stats.rows_censored_window
        );
        // Serialization: movement label keys ride the flattened core.
        let line = serde_json::to_string(r7).expect("serialize move row");
        assert!(line.contains("\"moveSector\":12"));
        assert!(line.contains("\"movedDistM\":"));
        assert!(line.contains("\"ownYawRad\":1.5707"));
        assert!(line.contains("\"featureVersion\":2"));
        assert!(line.contains("\"replayId\":\"replayM\""));
        assert!(line.contains("\"gameMode\":\"pvp\""));
        // No fire-label keys leak into the movement schema.
        assert!(!line.contains("labelACanFire"));
        assert!(!line.contains("ownerShotsHit"));
    }

    /// E16 against a real replay — run with
    /// `WOWSP_TEST_REPLAY=<path> [WOWSP_TEST_LOS_GRID=<path>]
    /// [WOWSP_MOVE_DATASET_OUT=<file>] cargo test -p wowsp_tauri
    /// e16_move_export -- --nocapture`. Prints the sector histogram (the
    /// inertia-baseline strength) and the censorship rate; asserts the
    /// label invariant (sector == f(bearing − yaw, dist)) over every row.
    /// Skips when the env var is unset.
    #[test]
    fn e16_move_export_on_real_replay() {
        let Ok(path) = std::env::var("WOWSP_TEST_REPLAY") else {
            eprintln!("[e16] WOWSP_TEST_REPLAY not set - skipping");
            return;
        };
        let params = FireSampleParams::default();
        let (stream, ev) = super::super::replay::decode_replay_stream_with_events(&path)
            .expect("decode real replay");
        let events = FeatureEvents::for_version(stream.version.as_deref(), &ev);
        let vehicles = read_roster(&path).expect("roster");
        let ships = ship_infos(&stream, &vehicles);
        let grid_path = match std::env::var("WOWSP_TEST_LOS_GRID") {
            Ok(p) => Some(std::path::PathBuf::from(p)),
            Err(_) => {
                let default = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../scripts/experiments/out/50_Gold_harbor/terrain_los.npz");
                default.exists().then_some(default)
            },
        };
        let grid = grid_path
            .map(|p| LosGrid::load_npz(&p))
            .transpose()
            .expect("load LOS raster when present");
        let (rows, stats) = export_move_dataset(
            &stream,
            &ships,
            grid.as_ref(),
            DEFAULT_EYE_HEIGHT,
            &params,
            std::path::Path::new(&path)
                .file_stem()
                .and_then(|s| s.to_str()),
            read_game_mode(std::path::Path::new(&path)).as_deref(),
            &events,
        );
        eprintln!(
            "[e16] export: {} deciders, {} rows, {} censored windows; movedDist p50 {:.0} m / p90 {:.0} m; no-move share {:.3}",
            stats.owners,
            stats.rows,
            stats.rows_censored_window,
            stats.moved_dist_p50_m,
            stats.moved_dist_p90_m,
            stats.rows_no_move as f32 / stats.rows.max(1) as f32
        );
        let total: usize = stats.sector_histogram.iter().sum();
        for (k, n) in stats.sector_histogram.iter().enumerate() {
            if *n > 0 {
                eprintln!(
                    "[e16] sector {:2}: {} rows ({:.3})",
                    k,
                    n,
                    *n as f32 / total as f32
                );
            }
        }
        // Scale: mode-dependent (a 5v5 brawl carries ~10 deciders / ~270
        // rows, a 12v12 random ~22 / ~5000) — assert per-decoder yield, not
        // absolute row counts.
        assert!(stats.owners >= 10, "owners {}", stats.owners);
        assert!(stats.rows > stats.owners * 25, "rows {}", stats.rows);
        assert_eq!(stats.sector_histogram.len(), MOVE_SECTOR_COUNT);
        assert_eq!(total, stats.rows);
        // Label invariant over every row: the exported sector is exactly
        // the label function of the exported bearing/dist/yaw triple.
        for r in &rows {
            assert!(r.move_sector < MOVE_SECTOR_COUNT as u8);
            assert_eq!(
                r.move_sector,
                move_sector_label(
                    wrap_angle(r.move_bearing_rad - r.own_yaw_rad),
                    r.moved_dist_m
                ),
                "sector invariant at t={}",
                r.core.t
            );
            assert!(r.moved_dist_m.is_finite() && r.moved_dist_m >= 0.0);
        }
        // Plausible movement physics: p50 displacement under 500 m (12 s at
        // 40 kt = 247 m; allow margin for interpolation noise) and a
        // non-degenerate directional distribution.
        assert!(
            stats.moved_dist_p50_m < 500.0,
            "p50 {}",
            stats.moved_dist_p50_m
        );
        assert!(stats.moved_dist_p50_m > 0.0);
        let directional: usize = stats.sector_histogram[..16].iter().sum();
        assert!(
            directional > stats.rows / 10,
            "directional rows {directional}"
        );
        let no_move_share = stats.rows_no_move as f32 / stats.rows as f32;
        assert!(
            (0.02..=0.80).contains(&no_move_share),
            "no-move {no_move_share}"
        );
        match std::env::var("WOWSP_MOVE_DATASET_OUT") {
            Ok(out) => {
                let out_path = std::path::PathBuf::from(&out);
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent).expect("create dataset parent dir");
                }
                use std::io::Write;
                let mut f = std::fs::File::create(&out_path).expect("create dataset file");
                for r in &rows {
                    writeln!(f, "{}", serde_json::to_string(r).expect("serialize row"))
                        .expect("write row");
                }
                eprintln!("[e16] wrote {} rows to {}", rows.len(), out);
            },
            Err(_) => eprintln!("[e16] WOWSP_MOVE_DATASET_OUT not set - dataset not written"),
        }
    }

    /// E16 / G6 against real replay bytes — run with
    /// `WOWSP_TEST_REPLAY_DIR=<dir>` (or `WOWSP_TEST_REPLAY=<file>`, copied
    /// into a temp folder next to planted corrupt/empty files proving the
    /// tolerance on real bytes); `WOWSP_MOVE_DATASET_OUT=<file>` writes the
    /// aggregated movement JSONL (the training input for train_move_model).
    /// Skips when neither env var is set.
    #[test]
    fn e16_move_batch_on_real_replays() {
        let replay_dir = match std::env::var("WOWSP_TEST_REPLAY_DIR") {
            Ok(dir) => std::path::PathBuf::from(dir),
            Err(_) => match std::env::var("WOWSP_TEST_REPLAY") {
                Ok(file) => {
                    let root = std::env::temp_dir().join(format!(
                        "wowsp_move_batch_real_{}_{}",
                        std::process::id(),
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_nanos())
                            .unwrap_or(0)
                    ));
                    std::fs::create_dir_all(&root).expect("mkdir");
                    let name = std::path::Path::new(&file)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "real.wowsreplay".into());
                    std::fs::copy(&file, root.join(&name)).expect("copy real replay");
                    std::fs::write(
                        root.join("zz_corrupt.wowsreplay"),
                        [0x5Au8, 0x01, 0xFF, 0x00, 0x33, 0x77, 0x11, 0x42, 0x00, 0x99],
                    )
                    .expect("write corrupt");
                    std::fs::write(root.join("zz_empty.wowsreplay"), b"").expect("write empty");
                    root
                },
                Err(_) => {
                    eprintln!("[e16] WOWSP_TEST_REPLAY_DIR / WOWSP_TEST_REPLAY not set - skipping");
                    return;
                },
            },
        };
        let params = FireSampleParams::default();
        let los_dir = match std::env::var("WOWSP_TEST_LOS_DIR") {
            Ok(p) => Some(std::path::PathBuf::from(p)),
            Err(_) => {
                let default = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../scripts/experiments/out");
                default.exists().then_some(default)
            },
        };
        let (rows, summary) =
            export_move_dataset_dir(&replay_dir, los_dir.as_deref(), DEFAULT_EYE_HEIGHT, &params)
                .expect("batch runs");
        eprintln!(
            "[e16] batch {}: {} seen / {} exported / {} failed -> {} rows, {} deciders, {} censored; no-move share {:.3}; movedDist p50 {:.0} m / p90 {:.0} m",
            summary.root_dir,
            summary.files_seen,
            summary.files_exported,
            summary.files_failed,
            summary.rows,
            summary.deciders,
            summary.rows_censored_window,
            summary.rows_no_move as f32 / summary.rows.max(1) as f32,
            summary.moved_dist_p50_m,
            summary.moved_dist_p90_m
        );
        for (k, n) in summary.sector_histogram.iter().enumerate() {
            if *n > 0 {
                eprintln!(
                    "[e16] corpus sector {:2}: {} rows ({:.3})",
                    k,
                    n,
                    *n as f32 / summary.rows.max(1) as f32
                );
            }
        }
        assert!(summary.files_exported >= 1, "nothing exported");
        assert!(summary.rows > 0);
        let ids: BTreeSet<&str> = summary
            .per_file
            .iter()
            .filter(|f| matches!(f.outcome, DatasetBatchOutcome::Exported { .. }))
            .map(|f| f.replay_id.as_str())
            .collect();
        assert!(rows.iter().all(|r| {
            r.core
                .replay_id
                .as_deref()
                .is_some_and(|id| ids.contains(id))
        }));
        assert_eq!(summary.sector_histogram.iter().sum::<usize>(), summary.rows);
        for f in &summary.per_file {
            if let DatasetBatchOutcome::Failed { reason } = &f.outcome {
                assert!(!reason.is_empty());
            }
        }
        match std::env::var("WOWSP_MOVE_DATASET_OUT") {
            Ok(out) => {
                let out_path = std::path::PathBuf::from(&out);
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent).expect("create dataset parent dir");
                }
                use std::io::Write;
                let mut f = std::fs::File::create(&out_path).expect("create dataset file");
                for r in &rows {
                    writeln!(f, "{}", serde_json::to_string(r).expect("serialize row"))
                        .expect("write row");
                }
                eprintln!("[e16] wrote {} rows to {}", rows.len(), out);
            },
            Err(_) => eprintln!("[e16] WOWSP_MOVE_DATASET_OUT not set - dataset not written"),
        }
    }
}
