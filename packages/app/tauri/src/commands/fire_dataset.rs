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

use std::collections::BTreeMap;

use serde::Serialize;
use wowsp_tauri_shared::{
    EntityTrajectory, PositionSample, ReplayStream, ShellLaunchEvent, VehicleEntry,
};

use super::decision_tick::METERS_PER_UNIT;
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
}

/// One exported decision point (one JSONL line).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FireDatasetRow {
    // ── metadata ──
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
    // ── labels ──
    pub label_a_can_fire: bool,
    /// `None` (censored) whenever `label_a_can_fire` is false.
    pub label_b_fired: Option<bool>,
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
    decider: &ShipInfo<'_>,
    ships: &[ShipInfo<'_>],
    own: &PositionSample,
    t: f32,
    los: Option<&LosGrid>,
    eye_height: f32,
    enemy_side: bool,
    max_slots: usize,
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

/// Build every exportable decision row of the replay (E9 step 1). The decider
/// set is ships with a fire history and a known team; rows follow the E7
/// cadence/gates exactly so `rows_can_fire` reproduces E7's eligible count.
pub fn export_decision_dataset(
    stream: &ReplayStream,
    ships: &[ShipInfo<'_>],
    los: Option<&LosGrid>,
    eye_height: f32,
    params: &FireSampleParams,
) -> (Vec<FireDatasetRow>, FireDatasetExportStats) {
    let contexts = fire_contexts(stream, ships, params);
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
            let (z0, z1, z2, zo, zp, shells, torps, expl, near) =
                zone_and_event_summary(stream, own, t);
            rows.push(FireDatasetRow {
                replay_version: stream.version.clone(),
                map_name: stream.map_name.clone(),
                owner_entity_id: id,
                ship_id: ship.traj.kind.as_ref().and_then(|k| k.ship_id),
                team_id: ship.team_id.unwrap_or(-1),
                t,
                own_speed_kt: trailing_speed_kt(ships, id, t),
                own_hp_frac: hp_frac_at(ship.traj, t),
                own_reload_frac: reload_frac,
                own_range_m: ctx.range_m,
                zones_owned_0: z0,
                zones_owned_1: z1,
                zones_owned_2: z2,
                zones_owned_other: zo,
                zones_active_progress: zp,
                events_shells_30s: shells,
                events_torps_30s: torps,
                events_explosions_30s: expl,
                events_explosions_near_30s: near,
                enemies: build_slots(ship, ships, own, t, los, eye_height, true, ENEMY_SLOTS),
                friends: build_slots(ship, ships, own, t, los, eye_height, false, FRIEND_SLOTS),
                label_a_can_fire: label_a,
                label_b_fired: label_b,
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
            super::super::replay::read_replay_positions(path.clone()).expect("decode real replay");
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
        let (rows, stats) =
            export_decision_dataset(&stream, &ships, None, DEFAULT_EYE_HEIGHT, &params);
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
        let stream =
            super::super::replay::read_replay_positions(path.clone()).expect("decode real replay");
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
        let (rows, stats) =
            export_decision_dataset(&stream, &ships, grid.as_ref(), DEFAULT_EYE_HEIGHT, &params);
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
        }
        // labelA=1 rows must carry at least one observed-now in-range enemy.
        for r in rows.iter().filter(|r| r.label_a_can_fire) {
            assert!(
                r.enemies.iter().any(|e| e.observed_now),
                "can-fire row without an observed enemy at t={}",
                r.t
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
}
