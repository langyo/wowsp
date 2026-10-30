//! Per-ship decision scoring — instant score + confidence + whole-game score
//! (experiment E17, G6 step 2).
//!
//! E16's movement twin of the fire model answered "where should each ship
//! go"; this module answers "how well did each ship actually decide", by
//! running BOTH trained heads (fire two-head + 17-class movement) over every
//! E16 decision point of a replay and scoring their AGREEMENT with what the
//! ship really did. The whole system is then hard-validated against
//! post-battle ground truth: ships whose decisions the models agree with
//! must end the battle with more damage / XP / frags
//! (`scripts/experiments/validate_scores.py` joins the exported reports to
//! the BattleResults payload and demands a significant positive Spearman ρ).
//!
//! # Scoring semantics (the contract)
//!
//! Decision points are EXACTLY the E16 movement export's
//! ([`super::fire_dataset::export_move_replay_file`]): every team-known
//! ship, 4 s cadence, own-observable gate, label window [t+4, t+16] with
//! honest ground truth at both endpoints. Rows whose window was censored
//! (decider dark inside the window) are ALREADY excluded by that export —
//! this module never sees them, so every aggregate below is
//! censorship-clean by construction. For each row:
//!
//! * **Fire alignment** (can-fire rows only): the E7 hard eligibility rule
//!   (main-battery reload completes within the label window AND an
//!   observed-now enemy sits inside the ship's own engagement range — the
//!   same rule as training labelA) gates a proper-scoring pointwise term
//!   `p(actual action) = fired ? fireProb : 1 − fireProb`: the more the
//!   fire head agrees with the ship's actual fire/hold choice, the higher
//!   the term. "Fired" mirrors training labelB: a MAIN-battery salvo starts
//!   in `(t, t + 2 s]`. Carriers / never-fired hulls pass the rule
//!   trivially (loaded guns, fallback 25 km range) — their fire term is a
//!   mostly-trivial "model also says don't fire" and is reported per class
//!   in the validation, not hidden.
//! * **Move alignment** (all rows): the 17-class softmax's probability
//!   mass on the ACTUAL realised `moveSector` (E16 relative-frame label,
//!   own-yaw reference + no-move class 16) — the multiclass analogue of
//!   the pointwise term.
//! * **Instant score** `inst(t) = 0.5·fire + 0.5·move` on can-fire rows
//!   ([`CAN_FIRE_ROW_FIRE_WEIGHT`] / [`CAN_FIRE_ROW_MOVE_WEIGHT`]), the
//!   move term alone otherwise. Both components live in [0, 1], so does
//!   the mix.
//! * **Confidence** `confidence(t)` — an INDEPENDENT output, not the score:
//!   how sure the models are of their OWN top judgement. Move head:
//!   `max softmax`; fire head: `|fireProb − 0.5| × 2`; combined with the
//!   same availability rule as the score (mean on can-fire rows, move-max
//!   alone otherwise). The UI uses it to FADE low-certainty moments; a
//!   model can be confidently wrong (high confidence, low score) and the
//!   two must stay decoupled (pinned by a synthetic test).
//! * **Whole-game score** `wholeGame` = row mean of `inst` over the
//!   windowed samples (rows sit on a uniform 4 s grid, so the row mean IS
//!   the time mean); `wholeFire` / `wholeMove` are the component means
//!   (`wholeFire` = null for ships with zero can-fire rows, e.g. hulls
//!   that never saw an eligible target).
//!
//! # Model sources
//!
//! Two ONNX sessions, each cached per process behind a [`OnceLock`] of a
//! [`Mutex`] (ORT sessions are not `Sync`; a load error is sticky until
//! restart, mirroring [`super::decision_ai`]'s ladder). Paths: the
//! `WOWSP_FIRE_MODEL` / `WOWSP_MOVE_MODEL` env overrides, else the
//! experiment defaults under `scripts/experiments/out/` —
//! `fire_model/v2plain_std/fp32.onnx` (v2 features, ablate NONE) and
//! `move_model/node3/main/fp32.onnx` (v2, ablate e11). **fp32 is
//! deliberate**: E16 measured that int8 dynamic quantization hurts the
//! 17-class head badly (top1 0.536 → 0.523, max|Δp| up to 0.19). Both
//! models share the fire-v2 feature schema (entity[1,24,15] +
//! global_feat[1,27] + mask[1,24]) but widths are read from EACH session's
//! metadata (the [`super::decision_ai::detect_kind`] pattern) — a
//! re-trained wider model still runs. Because the move model was trained
//! with `--ablate e11`, its inputs get the SAME train-time zeroing (entity
//! cols 10/14, global cols 14–18+26 — [`ablate_e11_tensors`]); the fire
//! model consumes the untouched v2 row. The serve-time source ladder
//! (decisions pack → embedded) is E18's job.
//!
//! # Cost
//!
//! Pure inference, no training: ~1 100 rows/replay × 2 forwards ≈ 0.4 s on
//! a desktop CPU, plus two decode passes (the movement export's own + this
//! module's, which needs the raw stream for fire actions, the recorder id
//! and the battle results).

// Experiment/E18-surface module: the Tauri command lives in
// decision_serve.rs (`decision_debug_report`), which consumes
// `build_ship_scores` / the featurizers / `softmax` below; `compute_ship_scores`
// itself serves the env-gated tests (and stays the E17 export entry point).
// Silence dead_code for the non-test build of the parts only tests call (the
// clippy gate runs --lib --bins without --tests), same as fire_dataset.rs.
#![allow(dead_code)]

use anyhow::{anyhow, bail};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use ort::{session::Session, value::Tensor};
use serde::Serialize;
use wowsp_tauri_shared::{ReplayStream, ShellLaunchEvent};

use super::decision_serve::{
    AGE_SCALE_S, DIST_SCALE_M, EVENT_SCALE, RANGE_SCALE_M, SPEED_SCALE_KT, TIME_SCALE_S, ZONE_SCALE,
};
use super::decision_tick::DEFAULT_EYE_HEIGHT;
use super::fire_dataset::{
    DECISION_INTERVAL_S, DecisionRowCore, ENEMY_SLOTS, FRIEND_SLOTS, FireDatasetSlot,
    FireSampleParams, LABEL_WINDOW_S, MOVE_SECTOR_COUNT, MOVE_SECTOR_NONE, MoveDatasetRow,
    OUTCOME_WINDOW_S, export_move_replay_file, position_at,
};

// ── scoring constants (the documented weights) ──────────────────────────────

/// Weight of the fire-alignment component in `inst(t)` on can-fire rows.
pub const CAN_FIRE_ROW_FIRE_WEIGHT: f32 = 0.5;
/// Weight of the move-alignment component in `inst(t)` on can-fire rows
/// (non-can-fire rows are the move term alone: `1 − fire weight`).
pub const CAN_FIRE_ROW_MOVE_WEIGHT: f32 = 0.5;

/// Muzzle height (world units) separating ship guns from aircraft ordnance —
/// `fire_dataset.rs`'s bound, mirrored for the local salvo grouping.
const AIRBORNE_MUZZLE_Y_UNITS: f32 = 15.0;
/// `gunBarrelID` bound of the main battery (E7), mirrored.
const MAIN_BATTERY_MAX_BARREL_ID: u16 = 32;
/// Reload-estimate clamp band (E7), mirrored.
const MIN_RELOAD_S: f32 = 3.0;
const MAX_RELOAD_S: f32 = 45.0;

// ── small math helpers ──────────────────────────────────────────────────────

fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

/// Softmax over logits (numerically stabilized; empty input → empty output).
pub fn softmax(logits: &[f32]) -> Vec<f32> {
    if logits.is_empty() {
        return Vec::new();
    }
    let max = logits.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let exps: Vec<f32> = logits.iter().map(|l| (l - max).exp()).collect();
    let sum: f32 = exps.iter().sum();
    exps.into_iter().map(|e| e / sum).collect()
}

// ── DTOs (wire contract; camelCase, E12 local-struct precedent) ─────────────

/// One instant's decomposed score (pre-aggregation). `fire` is `None` on
/// non-can-fire rows (no fire decision was on the table). `fired`/`fire_prob`
/// are the raw decision ground truth + head-B probability behind the fire
/// term (E20: the aggregation studies need the (p, fired) pair itself —
/// `fire` alone folds them irreversibly into `p(actual action)`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InstantComponents {
    pub inst: f32,
    pub fire: Option<f32>,
    pub fired: Option<bool>,
    pub fire_prob: Option<f32>,
    pub mv: f32,
    pub confidence: f32,
}

/// One decision point's score sample (the UI slides over this series).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipScoreSample {
    pub t: f32,
    pub inst: f32,
    /// `p(actual fire action)` — `null` on non-can-fire rows.
    pub fire: Option<f32>,
    /// Whether the ship ACTUALLY fired in the label window — `null` on
    /// non-can-fire rows (E20: opportunity-capture aggregation substrate).
    pub fired: Option<bool>,
    /// Head-B raw probability `p(expert fires)` — `null` on non-can-fire
    /// rows. `fire` is recoverable as `fired ? fireProb : 1 − fireProb`.
    pub fire_prob: Option<f32>,
    /// Enemy HP lost in `(t + labelWindow, t + 45 s]` attributable to this
    /// ship's covering impacts (E13 window semantics) — `null` on
    /// non-can-fire rows. E21's realized-outcome substrate.
    pub hp_lost: Option<f32>,
    /// Softmax mass on the actual move sector.
    #[serde(rename = "move")]
    pub mv: f32,
    /// Independent output: the models' own-certainty, see module docs.
    pub confidence: f32,
}

/// Post-battle ground truth joined from the replay's BattleResults payload
/// (the `playersPublicInfo` positional arrays). The join key is the shipId;
/// #1202's lesson is enforced structurally: a shipId the results place on
/// more than one entry (mirror lineups across teams, or two players in the
/// same hull on one team) is `ambiguous` and NEVER guessed.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ShipOutcome {
    /// Exactly one battle-results entry carries this shipId.
    #[serde(rename_all = "camelCase")]
    Ok {
        damage: f64,
        /// Settlement base exp — `null` for bots / short legacy arrays.
        base_exp: Option<f64>,
        frags: f64,
        survived: bool,
    },
    /// >1 entries share the shipId — excluded from all correlations.
    Ambiguous,
    /// No battle-results payload, or the ship is absent from it.
    Missing,
    /// The entity carries no shipId join key at all.
    NoShipId,
}

/// One ship's whole score entry.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipScoreEntry {
    pub entity_id: i32,
    pub ship_id: Option<i64>,
    /// Recorder-relative team: 0 = recorder's side, 1 = enemy.
    pub team_id: i8,
    pub is_recorder: bool,
    /// Row (== time) mean of `inst` over the windowed samples.
    pub whole_game: f32,
    /// Mean fire-alignment over can-fire samples; `null` when none.
    pub whole_fire: Option<f32>,
    /// Mean move-alignment over all samples.
    pub whole_move: f32,
    /// E21's validated whole-game semantic: enemy HP lost in the decision
    /// windows where this ship FIRED, attributed to its covering impacts —
    /// `null` when the ship never fired (no can-fire window with a shot).
    pub contribution: Option<f64>,
    /// Fired can-fire windows behind `contribution` (the per-shot mean is
    /// contribution / contribution_shots).
    pub contribution_shots: Option<u32>,
    pub samples: Vec<ShipScoreSample>,
    pub outcome: ShipOutcome,
}

/// Where each scoring head's ONNX came from (path string; fp32 is the
/// deliberate deployment choice, see module docs).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreModelSources {
    pub fire: String,
    pub move_model: String,
}

/// Run-level counters next to the per-ship rows (validation coverage).
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreRunStats {
    pub ships_scored: usize,
    /// Windowed rows the report scored (the E16 export already dropped
    /// censored windows; these are post-censorship survivors).
    pub rows_scored: usize,
    pub rows_can_fire: usize,
    pub rows_fired: usize,
    /// Rows whose realised movement was the no-move class.
    pub rows_no_move: usize,
}

/// The `compute_ship_scores` payload: the FULL timeline in one call — the
/// UI slides over the per-ship `samples` series without re-running models.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipScoreReport {
    pub replay_id: String,
    pub map_name: Option<String>,
    pub game_mode: Option<String>,
    pub replay_version: Option<String>,
    /// Ordered by entity id.
    pub per_ship: Vec<ShipScoreEntry>,
    pub model_sources: ScoreModelSources,
    pub stats: ScoreRunStats,
}

// ── scoring math (pure, unit-testable) ──────────────────────────────────────

/// The instant score decomposition of one decision row. `move_probs` is the
/// 17-class softmax; `move_sector` the realised label; `fire_prob` head B's
/// sigmoid. Availability: `can_fire` decides whether the fire component
/// exists at all (the E7 hard rule — see [`can_fire_at`]).
pub fn instant_components(
    can_fire: bool,
    fired: bool,
    fire_prob: f32,
    move_probs: &[f32],
    move_sector: u8,
) -> InstantComponents {
    let mv = move_probs.get(move_sector as usize).copied().unwrap_or(0.0);
    let move_max = move_probs.iter().copied().fold(0.0f32, f32::max);
    let fire_term = if fired { fire_prob } else { 1.0 - fire_prob };
    let fire_conf = (2.0 * (fire_prob - 0.5).abs()).clamp(0.0, 1.0);
    if can_fire {
        InstantComponents {
            inst: CAN_FIRE_ROW_FIRE_WEIGHT * fire_term + CAN_FIRE_ROW_MOVE_WEIGHT * mv,
            fire: Some(fire_term),
            fired: Some(fired),
            fire_prob: Some(fire_prob),
            mv,
            confidence: 0.5 * move_max + 0.5 * fire_conf,
        }
    } else {
        InstantComponents {
            inst: mv,
            fire: None,
            fired: None,
            fire_prob: None,
            mv,
            confidence: move_max,
        }
    }
}

// ── fire-action context (local E7 mirror) ───────────────────────────────────
//
// `fire_dataset.rs` is frozen this round and its per-owner contexts are
// module-private, so — exactly like decision_serve.rs before it — this file
// re-implements the E7 fire semantics field-for-field: ground-level main-
// battery shells per owner, salvos grouped by ≤2 s time contiguity within a
// battery class (salvoID is pack-level, not click-level), reload = p10 of
// consecutive main-salvo intervals clamped to [3, 45] s (<2 salvos → 0.0,
// guns spawn loaded). The real-model tests keep the behaviours aligned
// with the exporter.

/// Per-owner main-battery salvo starts + reload estimate (the labelA/labelB
/// substrate for scoring).
struct FireActionCtx {
    main_starts: Vec<f32>,
    reload_s: f32,
}

fn fire_action_contexts(stream: &ReplayStream) -> BTreeMap<i32, FireActionCtx> {
    let mut by_owner: BTreeMap<i32, Vec<&ShellLaunchEvent>> = BTreeMap::new();
    for s in &stream.shell_launches {
        if s.y < AIRBORNE_MUZZLE_Y_UNITS && s.gun_barrel_id < MAIN_BATTERY_MAX_BARREL_ID {
            by_owner.entry(s.owner_id).or_default().push(s);
        }
    }
    by_owner
        .into_iter()
        .map(|(owner, mut shells)| {
            shells.sort_by(|a, b| {
                a.time
                    .partial_cmp(&b.time)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            // Salvo starts: a gap > 2 s from the previous shell opens a new
            // salvo (the merge window measures from the LAST shell of the
            // running group, matching fire_dataset's `Salvo.last_time`).
            let mut main_starts = Vec::new();
            let mut last_time: Option<f32> = None;
            for s in shells {
                if last_time.is_none_or(|prev| s.time - prev > 2.0) {
                    main_starts.push(s.time);
                }
                last_time = Some(s.time);
            }
            (
                owner,
                FireActionCtx {
                    reload_s: estimate_reload(&main_starts),
                    main_starts,
                },
            )
        })
        .collect()
}

// ── E21: per-decision window HP-loss attribution (E13 mirror) ──────────────
//
// fire_dataset's OutcomeContext is module-private, so — exactly like
// FireActionCtx above — the E13 hp-lost window is re-implemented
// field-for-field: hit impacts (shotKills) per owner × enemy hull HP drops,
// full credit to a drop when a window impact of the owner covers it within
// the ±(0.4/0.6) s envelope and sat within the 500-unit attribution radius
// of the hull at the impact time. Timelines are (time, x, z)/(time, delta)
// tuples so the context owns its data with no lifetimes tied to the stream.
// Entity→team comes from the export rows themselves (every scored entity
// has rows); hulls without rows are skipped — a teammate or an unscored
// spectator contributes no attribution either way.
struct WindowOutcomeCtx {
    impacts_by_owner: BTreeMap<i32, Vec<(f32, f32, f32)>>,
    drops_by_entity: BTreeMap<i32, Vec<(f32, f32)>>,
    /// entity id -> index into `stream.trajectories` (position lookups).
    traj_index: BTreeMap<i32, usize>,
}

fn window_outcome_context(stream: &ReplayStream) -> WindowOutcomeCtx {
    let mut impacts_by_owner: BTreeMap<i32, Vec<(f32, f32, f32)>> = BTreeMap::new();
    for k in &stream.shot_kills {
        impacts_by_owner
            .entry(k.owner_id)
            .or_default()
            .push((k.time, k.x, k.z));
    }
    for v in impacts_by_owner.values_mut() {
        v.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    }
    let mut drops_by_entity: BTreeMap<i32, Vec<(f32, f32)>> = BTreeMap::new();
    for traj in &stream.trajectories {
        let mut drops = Vec::new();
        for w in traj.hp_samples.windows(2) {
            let delta = w[0].value.saturating_sub(w[1].value);
            if delta >= 50 {
                drops.push((w[1].time, delta as f32));
            }
        }
        drops_by_entity.insert(traj.entity_id, drops);
    }
    let traj_index = stream
        .trajectories
        .iter()
        .enumerate()
        .map(|(i, tr)| (tr.entity_id, i))
        .collect();
    WindowOutcomeCtx {
        impacts_by_owner,
        drops_by_entity,
        traj_index,
    }
}

/// Enemy HP lost in `(t + label_window, t + OUTCOME_WINDOW_S]` attributable
/// to `owner`'s covering impacts — the E13 `enemyHpLostNearby` semantics,
/// generalized from the recorder row to any scored ship.
fn window_hp_lost(
    ctx: &WindowOutcomeCtx,
    stream: &ReplayStream,
    teams: &BTreeMap<i32, i8>,
    owner: i32,
    decider_team: i8,
    t: f32,
) -> f32 {
    let w0 = t + LABEL_WINDOW_S;
    let w1 = t + OUTCOME_WINDOW_S;
    if w1 <= w0 {
        return 0.0;
    }
    let empty: Vec<(f32, f32, f32)> = Vec::new();
    let impacts = ctx.impacts_by_owner.get(&owner).unwrap_or(&empty);
    let i0 = impacts.partition_point(|k| k.0 <= w0);
    let i1 = impacts.partition_point(|k| k.0 <= w1);
    let window = &impacts[i0..i1];
    if window.is_empty() {
        return 0.0;
    }
    let mut hp_lost = 0.0f32;
    for (entity, team) in teams {
        if *entity == owner || *team == decider_team {
            continue;
        }
        let Some(drops) = ctx.drops_by_entity.get(entity) else {
            continue;
        };
        let d0 = drops.partition_point(|d| d.0 <= w0);
        let d1 = drops.partition_point(|d| d.0 <= w1);
        for &(drop_t, delta) in &drops[d0..d1] {
            let covered = window.iter().any(|&(kt, kx, kz)| {
                kt >= drop_t - 0.6 && kt < drop_t + 0.4 && {
                    let Some(&ti) = ctx.traj_index.get(entity) else {
                        return false;
                    };
                    position_at(&stream.trajectories[ti], kt)
                        .is_some_and(|(vx, vz)| (vx - kx).hypot(vz - kz) <= 500.0)
                }
            });
            if covered {
                hp_lost += delta;
            }
        }
    }
    hp_lost
}

/// p10 (nearest-rank) of the consecutive main-salvo intervals, clamped to
/// the plausible band — `decision_serve::estimate_reload` verbatim.
fn estimate_reload(main_starts: &[f32]) -> f32 {
    if main_starts.len() < 2 {
        return 0.0;
    }
    let mut intervals: Vec<f32> = main_starts.windows(2).map(|w| w[1] - w[0]).collect();
    intervals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = (((intervals.len() as f32 - 1.0) * 0.10).round() as usize).min(intervals.len() - 1);
    intervals[idx].clamp(MIN_RELOAD_S, MAX_RELOAD_S)
}

/// The E7 hard eligibility rule at a movement row's `t` (training labelA's
/// test verbatim): reload completes within the label window AND an
/// observed-now enemy sits inside the ship's own engagement range. The slot
/// list is observed-now-first-by-distance, so a qualifying target exists
/// iff ANY observed-now slot is in range (truncation only drops
/// farther/staler candidates — the nearest observed enemy always survives
/// truncation).
fn can_fire_at(row: &MoveDatasetRow, ctx: Option<&FireActionCtx>) -> bool {
    let reload_s = ctx.map_or(0.0, |c| c.reload_s);
    let effective_reload = (reload_s - DECISION_INTERVAL_S).max(0.0);
    let reloaded = ctx.is_none_or(|c| {
        !c.main_starts
            .iter()
            .any(|&s| s <= row.core.t && row.core.t - s < effective_reload)
    });
    let has_target = row
        .core
        .enemies
        .iter()
        .any(|e| e.observed_now && e.dist_m <= row.core.own_range_m);
    reloaded && has_target
}

/// Training labelB's test: a MAIN-battery salvo starts in `(t, t+window]`.
fn fired_in_label_window(ctx: Option<&FireActionCtx>, t: f32, window_s: f32) -> bool {
    ctx.is_some_and(|c| c.main_starts.iter().any(|&s| s > t && s <= t + window_s))
}

// ── BattleResults join (postBattle.ts semantics, Rust side) ─────────────────

/// One `playersPublicInfo` entry, reduced to the fields the validation
/// needs. Index layout (verified in postBattle.ts against 126 replays):
/// [6] teamId, [7] shipId, [21] survived, [32] frags, [404] base exp,
/// [426] damage — with 14.x legacy arrays (len < 500) carrying the late
/// fields 15 positions earlier (389 / 411).
struct BrPlayer {
    ship_id: i64,
    damage: f64,
    base_exp: Option<f64>,
    frags: f64,
    survived: bool,
}

/// shipId → entries (join ambiguity = entry count ≠ 1).
struct BattleResultsIndex {
    by_ship: BTreeMap<i64, Vec<BrPlayer>>,
}

impl BattleResultsIndex {
    /// `None` when the replay carries no parseable battle results at all.
    fn parse(raw: Option<&str>) -> Option<Self> {
        let raw = raw?;
        let v: serde_json::Value = serde_json::from_str(raw).ok()?;
        let players = v.get("playersPublicInfo")?.as_object()?;
        const LEGACY_LAYOUT_MAX_LEN: usize = 500;
        const LATE_SHIFT: usize = 15;
        const LATE_SHIFT_MIN_INDEX: usize = 404;
        let mut by_ship: BTreeMap<i64, Vec<BrPlayer>> = BTreeMap::new();
        for entry in players.values() {
            let Some(arr) = entry.as_array() else {
                continue;
            };
            let num = |idx: usize| -> Option<f64> {
                arr.get(idx)
                    .and_then(|x| x.as_f64())
                    .filter(|x| x.is_finite())
            };
            let late = |idx: usize| -> usize {
                if arr.len() < LEGACY_LAYOUT_MAX_LEN && idx >= LATE_SHIFT_MIN_INDEX {
                    idx - LATE_SHIFT
                } else {
                    idx
                }
            };
            // teamId [6] is in the game's ABSOLUTE namespace while scoring
            // rows are recorder-relative — deliberately unused: a scored
            // ship's shipId is never mirrored (the E16 export drops
            // mirror-ambiguous deciders), so shipId alone is a unique key.
            let Some(ship_id) = num(7).map(|x| x as i64).filter(|&x| x > 0) else {
                continue;
            };
            by_ship.entry(ship_id).or_default().push(BrPlayer {
                ship_id,
                damage: num(late(426)).unwrap_or(0.0),
                base_exp: num(late(404)),
                frags: num(32).unwrap_or(0.0),
                survived: arr.get(21) == Some(&serde_json::Value::Bool(true)),
            });
        }
        Some(Self { by_ship })
    }

    /// The #1202-safe join: exactly one entry → `Ok`; more (mirror lineup /
    /// same-hull teammates) → `Ambiguous`; none → `Missing`.
    fn join(&self, ship_id: Option<i64>) -> ShipOutcome {
        let Some(ship_id) = ship_id else {
            return ShipOutcome::NoShipId;
        };
        match self.by_ship.get(&ship_id).map(Vec::as_slice) {
            Some([p]) => ShipOutcome::Ok {
                damage: p.damage,
                base_exp: p.base_exp,
                frags: p.frags,
                survived: p.survived,
            },
            Some(_) => ShipOutcome::Ambiguous,
            None => ShipOutcome::Missing,
        }
    }
}

// ── v2 featurization (mirrors train_fire_model.py, keep in sync) ─────────────

/// v2 entity-slot width (v1 was 10; the scoring models are v2).
pub const ENTITY_DIM_V2: usize = 15;
/// v2 global-feature width.
pub const GLOBAL_DIM_V2: usize = 27;

/// E14's `--ablate e11` train-time zeroing, mirrored so the MOVE model (the
/// `main` run was trained with it) sees the same distribution at inference:
/// entity columns 10 (spottedNow) / 14 (enginePowerFrac) and global columns
/// 14–18 (consumables ×3, engine ×2) + 26 (e11EventsKnown) → 0.0. The fire
/// model (`v2plain_std`, ablate none) consumes the untouched tensors.
const ABLATE_E11_ENTITY_COLS: [usize; 2] = [10, 14];
const ABLATE_E11_GLOBAL_COLS: [usize; 6] = [14, 15, 16, 17, 18, 26];

/// One entity slot → 15 v2 floats (`featurize_slot(slot, ver=2)`).
pub fn featurize_slot_v2(slot: &FireDatasetSlot) -> [f32; ENTITY_DIM_V2] {
    [
        (slot.dist_m / DIST_SCALE_M).min(2.0),
        slot.bearing_rel_rad.sin(),
        slot.bearing_rel_rad.cos(),
        slot.speed_kt.map_or(-1.0, |v| v / SPEED_SCALE_KT),
        slot.hp_frac.unwrap_or(-1.0),
        (slot.obs_age_s / AGE_SCALE_S).min(1.0),
        if slot.observed_now { 1.0 } else { 0.0 },
        slot.terrain_blocked
            .map_or(-1.0, |b| if b { 1.0 } else { 0.0 }),
        if slot.entity_type == 2 { 1.0 } else { 0.0 },
        if slot.speed_kt.is_some() { 1.0 } else { 0.0 },
        slot.spotted_now.map_or(-1.0, |s| if s { 1.0 } else { 0.0 }),
        if slot.inside_smoke { 1.0 } else { 0.0 },
        if slot.radar_lit { 1.0 } else { 0.0 },
        if slot.is_enemy { 1.0 } else { 0.0 },
        slot.engine_power_frac.unwrap_or(-1.0),
    ]
}

/// One row's global block → 27 v2 floats (`global_vector(row, ver=2)`;
/// the v2 tail arrives pre-normalized from the Rust export).
pub fn featurize_globals_v2(core: &DecisionRowCore) -> [f32; GLOBAL_DIM_V2] {
    [
        core.t / TIME_SCALE_S,
        core.own_speed_kt.map_or(-1.0, |v| v / SPEED_SCALE_KT),
        core.own_hp_frac.unwrap_or(-1.0),
        core.own_reload_frac,
        core.own_range_m / RANGE_SCALE_M,
        core.zones_owned_0 as f32 / ZONE_SCALE,
        core.zones_owned_1 as f32 / ZONE_SCALE,
        core.zones_owned_2 as f32 / ZONE_SCALE,
        core.zones_owned_other as f32 / ZONE_SCALE,
        core.zones_active_progress as f32 / ZONE_SCALE,
        (core.events_shells_30s as f32 + 1.0).ln() / EVENT_SCALE,
        (core.events_torps_30s as f32 + 1.0).ln() / EVENT_SCALE,
        (core.events_explosions_30s as f32 + 1.0).ln() / EVENT_SCALE,
        (core.events_explosions_near_30s as f32 + 1.0).ln() / EVENT_SCALE,
        core.own_damcon_frac,
        core.own_repair_frac,
        core.own_other_consumable_frac,
        core.own_engine_power,
        core.own_engine_dir,
        if core.own_in_smoke { 1.0 } else { 0.0 },
        core.active_smoke_count_frac,
        core.active_smoke_area_feat,
        core.vision_cap_frac,
        core.weather_incoming_frac,
        core.ally_radar_count_frac,
        core.ally_hydro_count_frac,
        if core.e11_events_known { 1.0 } else { 0.0 },
    ]
}

/// Total entity slots of the v2 feature rows (16 enemies + 8 friends).
pub const SLOTS_V2: usize = ENEMY_SLOTS + FRIEND_SLOTS;

/// The flat v2 tensors of one movement row: entity `[SLOTS×ENTITY_DIM]`
/// row-major (enemies then friends, truncated to the slot budgets, padding
/// zero rows + mask 0), global `[GLOBAL_DIM]`, mask `[SLOTS]`.
pub fn feature_tensors_v2(row: &MoveDatasetRow) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let mut entity = vec![0.0f32; SLOTS_V2 * ENTITY_DIM_V2];
    let mut mask = vec![0.0f32; SLOTS_V2];
    let slots = row
        .core
        .enemies
        .iter()
        .take(ENEMY_SLOTS)
        .chain(row.core.friends.iter().take(FRIEND_SLOTS));
    for (i, slot) in slots.enumerate() {
        entity[i * ENTITY_DIM_V2..(i + 1) * ENTITY_DIM_V2]
            .copy_from_slice(&featurize_slot_v2(slot));
        mask[i] = 1.0;
    }
    (entity, featurize_globals_v2(&row.core).to_vec(), mask)
}

/// Apply the e11 ablation to a copy of the tensors (train-time semantics:
/// ZERO the columns, not -1 sentinels) — see [`ABLATE_E11_ENTITY_COLS`].
pub fn ablate_e11_tensors(entity: &[f32], global: &[f32], slots: usize) -> (Vec<f32>, Vec<f32>) {
    let mut entity = entity.to_vec();
    let mut global = global.to_vec();
    for col in ABLATE_E11_ENTITY_COLS {
        for s in 0..slots {
            if let Some(v) = entity.get_mut(s * ENTITY_DIM_V2 + col) {
                *v = 0.0;
            }
        }
    }
    for col in ABLATE_E11_GLOBAL_COLS {
        if let Some(v) = global.get_mut(col) {
            *v = 0.0;
        }
    }
    (entity, global)
}

// ── ONNX session wrapper (metadata-driven widths, decision_ai pattern) ──────

/// Which head layout a loaded session speaks, detected from its OUTPUT
/// metadata (inputs decide the widths).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScoreModelKind {
    /// `entity` + `global_feat` + `mask` → `logitA` / `logitB` (E9 fire).
    FireTwoHead,
    /// Same inputs → one `[1, sectors]` logits output (E16 movement).
    MoveSectors { sectors: usize },
}

/// One loaded scoring model. Inference is `&mut self` (ORT sessions are not
/// thread-safe in this ort line) — share behind a [`Mutex`].
pub struct ScoreModel {
    detail: String,
    kind: ScoreModelKind,
    slots: usize,
    entity_dim: usize,
    global_dim: usize,
    /// E24: width of the optional 4th `attrs` input (0 = the model takes
    /// none, i.e. the E19 contract). A model exported with attribute routing
    /// declares it and refuses to run without it.
    attr_dim: usize,
    out_name: String,
    session: Session,
}

/// Read one declared tensor dimension (-1/unknown → `default`).
fn declared_dim(shape: &[i64], idx: usize, default: usize) -> usize {
    shape
        .get(idx)
        .and_then(|d| usize::try_from(*d).ok())
        .filter(|d| *d > 0)
        .unwrap_or(default)
}

impl ScoreModel {
    /// Build from raw ONNX bytes, classifying the schema from session
    /// metadata. Unknown schemas are a hard error — never a wrong-shaped
    /// forward.
    pub fn from_bytes(detail: impl Into<String>, bytes: &[u8]) -> anyhow::Result<Self> {
        let mut builder = Session::builder().map_err(|e| anyhow!("create session builder: {e}"))?;
        let session = builder
            .commit_from_memory(bytes)
            .map_err(|e| anyhow!("load ONNX model: {e}"))?;
        let inputs = session.inputs();
        let names: Vec<&str> = inputs.iter().map(|i| i.name()).collect();
        if !(names.contains(&"entity") && names.contains(&"global_feat") && names.contains(&"mask"))
        {
            bail!(
                "scoring model must take entity/global_feat/mask (inputs: {names:?}) — \
                 the E1 fixture and foreign schemas are rejected"
            );
        }
        let shape_of = |name: &str| -> Vec<i64> {
            inputs
                .iter()
                .find(|i| i.name() == name)
                .and_then(|i| i.dtype().tensor_shape().map(|s| s.to_vec()))
                .unwrap_or_default()
        };
        let slots = declared_dim(&shape_of("entity"), 1, 24);
        let entity_dim = declared_dim(&shape_of("entity"), 2, ENTITY_DIM_V2);
        let global_dim = declared_dim(&shape_of("global_feat"), 1, GLOBAL_DIM_V2);
        // E24 attribute routing: an `attrs` input widens the contract by its
        // declared width. 0 keeps every pre-E24 model byte-identical.
        let attr_dim = if names.contains(&"attrs") {
            let w = declared_dim(&shape_of("attrs"), 1, 0);
            if w == 0 {
                bail!("scoring model declares an `attrs` input with no static width");
            }
            w
        } else {
            0
        };
        let outputs = session.outputs();
        let out_names: Vec<&str> = outputs.iter().map(|o| o.name()).collect();
        let (kind, out_name) = if out_names.contains(&"logitA") && out_names.contains(&"logitB") {
            (ScoreModelKind::FireTwoHead, "logitB".to_string())
        } else if out_names.len() == 1 {
            let name = out_names[0];
            let sectors = outputs[0]
                .dtype()
                .tensor_shape()
                .and_then(|s| s.last().copied())
                .and_then(|d| usize::try_from(d).ok())
                .filter(|d| *d > 0)
                .unwrap_or(MOVE_SECTOR_COUNT);
            (ScoreModelKind::MoveSectors { sectors }, name.to_string())
        } else {
            bail!(
                "scoring model has unexpected outputs {out_names:?} — expected \
                 logitA/logitB (fire) or one logits head (movement)"
            );
        };
        if slots == 0 || entity_dim == 0 || global_dim == 0 {
            bail!(
                "scoring model declares zero-width inputs (slots {slots}, entity {entity_dim}, global {global_dim})"
            );
        }
        Ok(Self {
            detail: detail.into(),
            kind,
            slots,
            entity_dim,
            global_dim,
            attr_dim,
            out_name,
            session,
        })
    }

    pub fn detail(&self) -> &str {
        &self.detail
    }

    pub fn kind(&self) -> &ScoreModelKind {
        &self.kind
    }

    /// Width triple (slots, entity_dim, global_dim) from the session's own
    /// metadata — the tensors a caller must build.
    pub fn widths(&self) -> (usize, usize, usize) {
        (self.slots, self.entity_dim, self.global_dim)
    }

    /// E24: the `attrs` input width the session declares (0 = none). A
    /// caller that wants attribute routing must hand [`Self::infer_fire`]
    /// exactly this many floats.
    pub fn attr_dim(&self) -> usize {
        self.attr_dim
    }

    fn run(
        &mut self,
        entity: &[f32],
        global: &[f32],
        mask: &[f32],
        attrs: Option<&[f32]>,
    ) -> anyhow::Result<Vec<f32>> {
        if entity.len() != self.slots * self.entity_dim
            || global.len() != self.global_dim
            || mask.len() != self.slots
        {
            bail!(
                "feature width mismatch: entity {} (want {}), global {} (want {}), mask {} (want {})",
                entity.len(),
                self.slots * self.entity_dim,
                global.len(),
                self.global_dim,
                mask.len(),
                self.slots
            );
        }
        // The attrs contract is symmetric: a model that declares the input
        // must be fed one, and a model that does not must not be handed one
        // (either direction is a wiring bug, not a silent no-op).
        match (self.attr_dim, attrs) {
            (0, None) => {},
            (0, Some(_)) => {
                bail!("attrs supplied but this model declares no `attrs` input (E19 contract)")
            },
            (n, None) => {
                bail!("this model declares a {n}-wide `attrs` input but no attrs were supplied")
            },
            (n, Some(a)) if a.len() != n => {
                bail!("attrs width mismatch: {} (want {n})", a.len())
            },
            _ => {},
        }
        let entity_t = Tensor::from_array(([1usize, self.slots, self.entity_dim], entity.to_vec()))
            .map_err(|e| anyhow!("build entity tensor: {e}"))?;
        let global_t = Tensor::from_array(([1usize, self.global_dim], global.to_vec()))
            .map_err(|e| anyhow!("build global tensor: {e}"))?;
        let mask_t = Tensor::from_array(([1usize, self.slots], mask.to_vec()))
            .map_err(|e| anyhow!("build mask tensor: {e}"))?;
        let outputs = match attrs {
            Some(a) => {
                let attrs_t = Tensor::from_array(([1usize, self.attr_dim], a.to_vec()))
                    .map_err(|e| anyhow!("build attrs tensor: {e}"))?;
                self.session
                    .run(ort::inputs![
                        "entity" => entity_t,
                        "global_feat" => global_t,
                        "mask" => mask_t,
                        "attrs" => attrs_t,
                    ])
                    .map_err(|e| anyhow!("run inference: {e}"))?
            },
            None => self
                .session
                .run(ort::inputs![
                    "entity" => entity_t,
                    "global_feat" => global_t,
                    "mask" => mask_t,
                ])
                .map_err(|e| anyhow!("run inference: {e}"))?,
        };
        let extract = |name: &str| -> anyhow::Result<Vec<f32>> {
            let v = outputs
                .get(name)
                .ok_or_else(|| anyhow!("output '{name}' missing"))?;
            let view = v
                .try_extract_array::<f32>()
                .map_err(|e| anyhow!("extract {name}: {e}"))?;
            let flat: Vec<f32> = view.iter().copied().collect();
            if flat.iter().any(|x| !x.is_finite()) {
                bail!("output {name} is not finite (shape {:?})", view.shape());
            }
            Ok(flat)
        };
        match self.kind {
            ScoreModelKind::FireTwoHead => {
                // Both heads pulled (callers score with B). A missing/NaN
                // head is a hard error, never a silently poisoned answer.
                let a = extract("logitA")?;
                let b = extract("logitB")?;
                if a.len() != 1 || b.len() != 1 {
                    bail!(
                        "fire heads squeeze to [1], got {} / {} values",
                        a.len(),
                        b.len()
                    );
                }
                Ok(vec![a[0], b[0]])
            },
            ScoreModelKind::MoveSectors { sectors } => {
                let logits = extract(&self.out_name)?;
                if logits.len() != sectors {
                    bail!(
                        "movement logits has {} values, expected {sectors}",
                        logits.len()
                    );
                }
                Ok(logits)
            },
        }
    }

    /// Two-head inference → (logitA, logitB). Errors on a movement-kind
    /// session (never a wrong-shaped forward).
    pub fn infer_fire(
        &mut self,
        entity: &[f32],
        global: &[f32],
        mask: &[f32],
        attrs: Option<&[f32]>,
    ) -> anyhow::Result<(f32, f32)> {
        if self.kind != ScoreModelKind::FireTwoHead {
            bail!("infer_fire on a non-fire session ({:?})", self.kind);
        }
        let out = self.run(entity, global, mask, attrs)?;
        Ok((out[0], out[1]))
    }

    /// Movement inference → `sectors` logits.
    pub fn infer_move(
        &mut self,
        entity: &[f32],
        global: &[f32],
        mask: &[f32],
    ) -> anyhow::Result<Vec<f32>> {
        if !matches!(self.kind, ScoreModelKind::MoveSectors { .. }) {
            bail!("infer_move on a non-movement session ({:?})", self.kind);
        }
        // Movement models never take attrs (routing is a fire-head
        // experiment); a movement export that declared `attrs` errors here.
        self.run(entity, global, mask, None)
    }
}

// ── the process-global model ladder (OnceLock caches) ───────────────────────

/// The experiment outputs root (compile-time path; the decisions-pack
/// serve ladder is E18's work).
fn experiments_out() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../scripts/experiments/out")
}

/// Resolve env override | default path.
fn score_model_path(env_key: &str, default_rel: &str) -> PathBuf {
    match std::env::var(env_key) {
        Ok(p) => PathBuf::from(p),
        Err(_) => experiments_out().join(default_rel),
    }
}

/// Default scoring models (fp32 on purpose — E16 measured int8 hurting the
/// 17-class head; see module docs).
pub const DEFAULT_FIRE_MODEL_REL: &str = "fire_model/v2plain_std/fp32.onnx";
pub const DEFAULT_MOVE_MODEL_REL: &str = "move_model/node3/main/fp32.onnx";

fn load_fire_score_model() -> anyhow::Result<ScoreModel> {
    let path = score_model_path("WOWSP_FIRE_MODEL", DEFAULT_FIRE_MODEL_REL);
    let bytes = std::fs::read(&path).map_err(|e| {
        anyhow!(
            "read fire model {}: {e} — train it with scripts/experiments/train_fire_model.py \
             or point WOWSP_FIRE_MODEL at an existing ONNX",
            path.display()
        )
    })?;
    let model = ScoreModel::from_bytes(path.to_string_lossy().into_owned(), &bytes)?;
    if model.kind() != &ScoreModelKind::FireTwoHead {
        bail!(
            "{:?} is not a two-head fire model ({:?})",
            path.display(),
            model.kind()
        );
    }
    Ok(model)
}

fn load_move_score_model() -> anyhow::Result<ScoreModel> {
    let path = score_model_path("WOWSP_MOVE_MODEL", DEFAULT_MOVE_MODEL_REL);
    let bytes = std::fs::read(&path).map_err(|e| {
        anyhow!(
            "read movement model {}: {e} — train it with scripts/experiments/train_move_model.py \
             or point WOWSP_MOVE_MODEL at an existing ONNX",
            path.display()
        )
    })?;
    let model = ScoreModel::from_bytes(path.to_string_lossy().into_owned(), &bytes)?;
    match model.kind() {
        ScoreModelKind::MoveSectors { sectors: 17 } => Ok(model),
        other => bail!(
            "{} is not the 17-class movement model ({other:?})",
            path.display()
        ),
    }
}

static FIRE_SCORE_MODEL: OnceLock<anyhow::Result<Mutex<ScoreModel>>> = OnceLock::new();
static MOVE_SCORE_MODEL: OnceLock<anyhow::Result<Mutex<ScoreModel>>> = OnceLock::new();

/// The process-global fire scoring model. CACHED PER PROCESS: replacing the
/// file mid-session needs a restart, and a load ERROR is sticky the same
/// way (mirroring `decision_ai::shared_model`).
pub fn score_fire_model() -> anyhow::Result<&'static Mutex<ScoreModel>> {
    FIRE_SCORE_MODEL
        .get_or_init(|| load_fire_score_model().map(Mutex::new))
        .as_ref()
        .map_err(|e| anyhow!("{e}"))
}

/// The process-global movement scoring model (same cache semantics).
pub fn score_move_model() -> anyhow::Result<&'static Mutex<ScoreModel>> {
    MOVE_SCORE_MODEL
        .get_or_init(|| load_move_score_model().map(Mutex::new))
        .as_ref()
        .map_err(|e| anyhow!("{e}"))
}

// ── the report builder (pure core, model-free for testability) ──────────────

/// Build the full report from a replay's movement rows + raw stream.
/// `infer` maps one row to `(fireProb, 17-class move softmax)` — the real
/// path wires the two ONNX sessions ([`compute_ship_scores`]); tests pass a
/// deterministic closure, keeping the scoring/aggregation logic
/// session-free. Rows outside `[t_from, t_to]` (inclusive, `None` =
/// unbounded) are excluded from BOTH the sample series and the whole-game
/// means. The input rows ARE the post-censorship E16 set (censored label
/// windows never made it out of the exporter).
pub fn build_ship_scores<F>(
    stream: &ReplayStream,
    rows: &[MoveDatasetRow],
    replay_id: &str,
    t_from: Option<f32>,
    t_to: Option<f32>,
    model_sources: ScoreModelSources,
    mut infer: F,
) -> anyhow::Result<ShipScoreReport>
where
    F: FnMut(&MoveDatasetRow) -> anyhow::Result<(f32, Vec<f32>)>,
{
    let fire_ctxs = fire_action_contexts(stream);
    let outcome_ctx = window_outcome_context(stream);
    // entity -> team (recorder-relative 0/1) from the rows themselves — the
    // attribution query skips same-team and unknown hulls.
    let teams: BTreeMap<i32, i8> = rows
        .iter()
        .map(|r| (r.core.owner_entity_id, r.core.team_id))
        .collect();
    let outcomes = BattleResultsIndex::parse(stream.battle_results.as_deref());
    let in_window = |t: f32| t_from.is_none_or(|from| t >= from) && t_to.is_none_or(|to| t <= to);
    // owner → running aggregates (samples kept whole — the UI slides).
    struct Acc {
        ship_id: Option<i64>,
        team_id: i8,
        is_recorder: bool,
        samples: Vec<ShipScoreSample>,
        inst_sum: f32,
        fire_sum: f32,
        fire_n: usize,
        mv_sum: f32,
        contrib_sum: f64,
        contrib_shots: u32,
    }
    let mut accs: BTreeMap<i32, Acc> = BTreeMap::new();
    let mut stats = ScoreRunStats::default();
    for row in rows.iter().filter(|r| in_window(r.core.t)) {
        let (fire_prob, move_probs) = infer(row)?;
        if move_probs.len() != MOVE_SECTOR_COUNT {
            bail!(
                "infer returned {} move probabilities, expected {MOVE_SECTOR_COUNT}",
                move_probs.len()
            );
        }
        let ctx = fire_ctxs.get(&row.core.owner_entity_id);
        let can_fire = can_fire_at(row, ctx);
        let fired = can_fire && fired_in_label_window(ctx, row.core.t, LABEL_WINDOW_S);
        let c = instant_components(can_fire, fired, fire_prob, &move_probs, row.move_sector);
        stats.rows_scored += 1;
        stats.rows_can_fire += usize::from(can_fire);
        stats.rows_fired += usize::from(fired);
        stats.rows_no_move += usize::from(row.move_sector == MOVE_SECTOR_NONE);
        let acc = accs.entry(row.core.owner_entity_id).or_insert_with(|| Acc {
            ship_id: row.core.ship_id,
            team_id: row.core.team_id,
            is_recorder: stream.recorder_vehicle_id == Some(row.core.owner_entity_id),
            samples: Vec::new(),
            inst_sum: 0.0,
            fire_sum: 0.0,
            fire_n: 0,
            mv_sum: 0.0,
            contrib_sum: 0.0,
            contrib_shots: 0,
        });
        let hp_lost = can_fire.then(|| {
            window_hp_lost(
                &outcome_ctx,
                stream,
                &teams,
                row.core.owner_entity_id,
                row.core.team_id,
                row.core.t,
            )
        });
        acc.samples.push(ShipScoreSample {
            t: row.core.t,
            inst: c.inst,
            fire: c.fire,
            fired: c.fired,
            fire_prob: c.fire_prob,
            hp_lost,
            mv: c.mv,
            confidence: c.confidence,
        });
        acc.inst_sum += c.inst;
        acc.mv_sum += c.mv;
        if let Some(f) = c.fire {
            acc.fire_sum += f;
            acc.fire_n += 1;
        }
        if let (Some(true), Some(hp)) = (c.fired, hp_lost) {
            acc.contrib_sum += hp as f64;
            acc.contrib_shots += 1;
        }
    }
    let meta = rows.first();
    let per_ship: Vec<ShipScoreEntry> = accs
        .into_iter()
        .map(|(entity_id, acc)| {
            let n = acc.samples.len();
            let outcome = match &outcomes {
                Some(idx) => idx.join(acc.ship_id),
                None => ShipOutcome::Missing,
            };
            ShipScoreEntry {
                entity_id,
                ship_id: acc.ship_id,
                team_id: acc.team_id,
                is_recorder: acc.is_recorder,
                whole_game: if n > 0 { acc.inst_sum / n as f32 } else { 0.0 },
                whole_fire: (acc.fire_n > 0).then(|| acc.fire_sum / acc.fire_n as f32),
                whole_move: if n > 0 { acc.mv_sum / n as f32 } else { 0.0 },
                contribution: (acc.contrib_shots > 0).then_some(acc.contrib_sum),
                contribution_shots: (acc.contrib_shots > 0).then_some(acc.contrib_shots),
                samples: acc.samples,
                outcome,
            }
        })
        .collect();
    stats.ships_scored = per_ship.len();
    Ok(ShipScoreReport {
        replay_id: replay_id.to_string(),
        map_name: stream.map_name.clone(),
        game_mode: meta.and_then(|r| r.core.game_mode.clone()),
        replay_version: stream.version.clone(),
        per_ship,
        model_sources,
        stats,
    })
}

/// Score one replay end-to-end: movement export (E16 decision points, v2
/// features) + one extra decode of the raw stream (fire actions, recorder
/// id, battle results) + both scoring heads over every row. The full
/// timeline is computed in ONE call — the UI filters/windows client-side.
pub fn compute_ship_scores(
    path: &Path,
    t_from: Option<f32>,
    t_to: Option<f32>,
    los_dir: Option<&Path>,
) -> anyhow::Result<ShipScoreReport> {
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
    let fire = score_fire_model()?;
    let mv = score_move_model()?;
    let mut fire = fire
        .lock()
        .map_err(|_| anyhow!("fire scoring model mutex poisoned"))?;
    let mut mv = mv
        .lock()
        .map_err(|_| anyhow!("movement scoring model mutex poisoned"))?;
    let sources = ScoreModelSources {
        fire: fire.detail().to_string(),
        move_model: mv.detail().to_string(),
    };
    let replay_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();
    build_ship_scores(&stream, &rows, &replay_id, t_from, t_to, sources, |row| {
        let (entity, global, mask) = feature_tensors_v2(row);
        // E24: an attribute-routed fire model (attr_dim > 0) gets the
        // routing vector from the embedded table, slot-for-slot what the
        // training featurization saw.
        let routing = (fire.attr_dim() > 0)
            .then(|| {
                crate::commands::ship_attrs::embedded_row_vector(
                    row.core.ship_id,
                    &row.core.friends,
                    &row.core.enemies,
                )
            })
            .transpose()?;
        // The fire model (v2plain_std) eats the untouched v2 row; the move
        // model (main, --ablate e11) eats the same row with the E11 family
        // zeroed — train/inference distribution parity (E14's lesson).
        let (_logit_a, logit_b) =
            fire.infer_fire(&entity, &global, &mask, routing.as_ref().map(|v| &v[..]))?;
        let (mv_entity, mv_global) = ablate_e11_tensors(&entity, &global, mv.widths().0);
        let logits = mv.infer_move(&mv_entity, &mv_global, &mask)?;
        Ok((sigmoid(logit_b), softmax(&logits)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The synthetic 4-input fixture (fixtures/build_decision_attrs_tiny.py):
    /// entity [1,2,3], global [1,1], mask [1,2], attrs [1,10] with
    /// logitA = sum(entity) + 100*attrs[0] - 100*attrs[1] and
    /// logitB = sum(global) + mask[0] - 0.5 — closed-form outputs, so the
    /// test proves the attrs tensor actually reaches the graph.
    const ATTRS_FIXTURE: &[u8] = include_bytes!("fixtures/decision_attrs_tiny.onnx");

    #[test]
    fn e24_attrs_fixture_detects_and_feeds_the_routing_input() {
        let mut m = ScoreModel::from_bytes("attrs-fixture", ATTRS_FIXTURE).expect("load fixture");
        assert_eq!(m.kind(), &ScoreModelKind::FireTwoHead);
        assert_eq!(m.attr_dim(), 10);
        let entity = vec![1.0f32, 2.0, 3.0, 4.0, 5.0, 6.0]; // [1,2,3]
        let global = vec![7.0f32]; // [1,1]
        let mask = vec![1.0f32, 1.0]; // [1,2]
        let mut attrs = [0.0f32; 10];
        attrs[0] = 0.25;
        attrs[1] = 0.5;
        let (la, lb) = m
            .infer_fire(&entity, &global, &mask, Some(&attrs))
            .expect("infer with attrs");
        assert!(
            (la - (21.0 + 100.0 * 0.25 - 100.0 * 0.5)).abs() < 1e-4,
            "logitA {la}"
        );
        assert!((lb - 7.5).abs() < 1e-4, "logitB {lb}");
        // attrs[0] is the ONLY path into logitA's extra term: change it and
        // the output must move by exactly 100x the delta.
        attrs[0] = 0.75;
        let (la2, _) = m
            .infer_fire(&entity, &global, &mask, Some(&attrs))
            .expect("infer with attrs (2)");
        assert!((la2 - la - 50.0).abs() < 1e-3, "delta {la2} vs {la}");
    }

    #[test]
    fn e24_attrs_contract_violations_are_loud() {
        let mut m = ScoreModel::from_bytes("attrs-fixture", ATTRS_FIXTURE).expect("load fixture");
        let entity = vec![0.0f32; 6];
        let global = vec![0.0f32; 1];
        let mask = vec![0.0f32; 2];
        // Model wants attrs, caller passes none.
        let err = m
            .infer_fire(&entity, &global, &mask, None)
            .expect_err("missing attrs must fail");
        assert!(err.to_string().contains("attrs"), "err: {err}");
        // Wrong width.
        let short = [0.0f32; 3];
        let err = m
            .infer_fire(&entity, &global, &mask, Some(&short))
            .expect_err("short attrs must fail");
        assert!(err.to_string().contains("width"), "err: {err}");
    }

    #[test]
    fn e21_window_hp_lost_attributes_covered_enemy_drops() {
        use wowsp_tauri_shared::{
            EntityTrajectory, HpSample, PositionSample, ReplayStream, ShotKillEvent,
        };
        let mk_stream = |imp_x: f32, drop: u32| ReplayStream {
            trajectories: vec![
                EntityTrajectory {
                    entity_id: 1,
                    kind: None,
                    samples: Vec::new(),
                    death_time: None,
                    cap_samples: Vec::new(),
                    cap_progress: Vec::new(),
                    cruise_samples: Vec::new(),
                    hp_samples: Vec::new(),
                },
                EntityTrajectory {
                    entity_id: 2,
                    kind: None,
                    samples: vec![
                        PositionSample {
                            entity_id: 2,
                            vehicle_id: 0,
                            time: 0.0,
                            x: 0.0,
                            y: 0.0,
                            z: 0.0,
                            yaw: 0.0,
                        },
                        PositionSample {
                            entity_id: 2,
                            vehicle_id: 0,
                            time: 100.0,
                            x: 0.0,
                            y: 0.0,
                            z: 0.0,
                            yaw: 0.0,
                        },
                    ],
                    death_time: None,
                    cap_samples: Vec::new(),
                    cap_progress: Vec::new(),
                    cruise_samples: Vec::new(),
                    hp_samples: vec![
                        HpSample {
                            time: 0.0,
                            value: 40000,
                        },
                        HpSample {
                            time: 20.0,
                            value: 40000 - drop,
                        },
                    ],
                },
            ],
            shot_kills: vec![ShotKillEvent {
                time: 20.1,
                owner_id: 1,
                hit_type: 0,
                shot_id: 0,
                x: imp_x,
                y: 0.0,
                z: 0.0,
            }],
            ..minimal_stream(None)
        };
        let mut teams = BTreeMap::new();
        teams.insert(1, 0i8); // decider
        teams.insert(2, 1i8); // enemy
        // Impact within 500 units of the drop position -> full credit.
        let near_stream = mk_stream(100.0, 500);
        let got = window_hp_lost(
            &window_outcome_context(&near_stream),
            &near_stream,
            &teams,
            1,
            0,
            0.0,
        );
        assert_eq!(got, 500.0);
        // Impact 2000 units away -> no credit.
        let far_stream = mk_stream(2000.0, 500);
        let far = window_hp_lost(
            &window_outcome_context(&far_stream),
            &far_stream,
            &teams,
            1,
            0,
            0.0,
        );
        assert_eq!(far, 0.0);
        // Same-team hull -> never credited.
        let mut ally_teams = teams.clone();
        ally_teams.insert(2, 0i8);
        let ally_stream = mk_stream(100.0, 500);
        let ally = window_hp_lost(
            &window_outcome_context(&ally_stream),
            &ally_stream,
            &ally_teams,
            1,
            0,
            0.0,
        );
        assert_eq!(ally, 0.0);
    }

    use super::*;

    // ── synthetic fixtures (fire_dataset / decision_serve test pattern) ──

    fn shell(time: f32, owner: i32, barrel: u16, y: f32) -> ShellLaunchEvent {
        ShellLaunchEvent {
            time,
            owner_id: owner,
            params_id: 0,
            salvo_id: 0,
            shot_id: 0,
            x: 10.0,
            y,
            z: 0.0,
            target_x: 50.0,
            target_y: 0.0,
            target_z: 0.0,
            server_time_left: 20.0,
            speed: 800.0,
            gun_barrel_id: barrel,
        }
    }

    fn minimal_stream(battle_results: Option<&str>) -> ReplayStream {
        ReplayStream {
            ally_builds: Vec::new(),
            trajectories: Vec::new(),
            recorder_vehicle_id: None,
            shell_launches: Vec::new(),
            explosions: Vec::new(),
            torpedoes: Vec::new(),
            torpedo_steers: Vec::new(),
            weapon_locks: Vec::new(),
            battle_results: battle_results.map(str::to_string),
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

    fn synth_slot(entity_id: i32, dist_m: f32, observed: bool) -> FireDatasetSlot {
        FireDatasetSlot {
            entity_id,
            entity_type: 2,
            ship_id: Some(entity_id as i64),
            dist_m,
            bearing_rel_rad: 0.0,
            speed_kt: Some(20.0),
            hp_frac: Some(1.0),
            obs_age_s: if observed { 1.0 } else { 90.0 },
            observed_now: observed,
            terrain_blocked: Some(false),
            spotted_now: Some(observed),
            inside_smoke: false,
            radar_lit: false,
            is_enemy: true,
            engine_power_frac: Some(0.8),
        }
    }

    fn synth_core(owner: i32, team: i8, t: f32, enemies: Vec<FireDatasetSlot>) -> DecisionRowCore {
        DecisionRowCore {
            replay_id: None,
            replay_version: Some("15,8,0,0".into()),
            map_name: Some("spaces/50_Gold_harbor".into()),
            owner_entity_id: owner,
            ship_id: Some(1000 + owner as i64),
            team_id: team,
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
            enemies,
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
        }
    }

    fn move_row(core: DecisionRowCore, sector: u8) -> MoveDatasetRow {
        MoveDatasetRow {
            core,
            own_yaw_rad: 0.0,
            moved_dist_m: 150.0,
            move_bearing_rad: 0.0,
            move_sector: sector,
        }
    }

    /// A battle-results entry array: `legacy = false` = the 15.2+ layout
    /// (len 538), `true` = the 14.x one (len 485) with the late fields 15
    /// positions earlier — postBattle.ts's rules, mirrored for join tests.
    fn br_entry(
        team: i64,
        ship: i64,
        damage: f64,
        exp: f64,
        frags: f64,
        survived: bool,
        legacy: bool,
    ) -> serde_json::Value {
        let len = if legacy { 485 } else { 538 };
        let (exp_idx, dmg_idx) = if legacy { (389, 411) } else { (404, 426) };
        let mut arr = vec![serde_json::Value::from(0.0); len];
        arr[1] = serde_json::Value::from("tester");
        arr[6] = serde_json::Value::from(team);
        arr[7] = serde_json::Value::from(ship);
        arr[9] = serde_json::Value::from("ru");
        arr[21] = serde_json::Value::Bool(survived);
        arr[32] = serde_json::Value::from(frags);
        arr[exp_idx] = serde_json::Value::from(exp);
        arr[dmg_idx] = serde_json::Value::from(damage);
        serde_json::Value::Array(arr)
    }

    fn br_json(players: serde_json::Map<String, serde_json::Value>) -> String {
        serde_json::json!({ "playersPublicInfo": players }).to_string()
    }

    // ── 1. scoring math ─────────────────────────────────────────────────

    /// The availability rule, the two-component mean, the no-move row shape
    /// and the CONFIDENCE/SCORE decoupling ("confidently disagrees" must be
    /// expressible: low inst, high confidence).
    #[test]
    fn instant_components_semantics() {
        // Can-fire row, model agrees (fired, p=0.8), actual sector carries
        // 0.6 of the mass (also the max).
        let mut probs = [0.025f32; 17];
        probs[3] = 0.6;
        let c = instant_components(true, true, 0.8, &probs, 3);
        assert_eq!(c.fire, Some(0.8));
        assert!((c.mv - 0.6).abs() < 1e-6);
        assert!((c.inst - (0.5 * 0.8 + 0.5 * 0.6)).abs() < 1e-6);
        // confidence = 0.5 * moveMax(0.6) + 0.5 * |0.8-0.5|*2 (0.6) = 0.6.
        assert!((c.confidence - 0.6).abs() < 1e-6);

        // Non-can-fire row (e.g. no-move): fire is None, inst = move term,
        // confidence = move max alone.
        let uniform = vec![1.0f32 / 17.0; 17];
        let c = instant_components(false, false, 0.9, &uniform, MOVE_SECTOR_NONE);
        assert_eq!(c.fire, None);
        assert!((c.inst - 1.0 / 17.0).abs() < 1e-6);
        assert!((c.confidence - 1.0 / 17.0).abs() < 1e-6);

        // DECOUPLING: can-fire, ship HOLDS, model confident it should fire
        // (p=0.95) and the move head is confident about the WRONG sector
        // (0.9 on sector 2, actual 5): score collapses, confidence soars.
        let mut probs = [0.0f32; 17];
        probs[2] = 0.9;
        probs[5] = 0.1;
        let c = instant_components(true, false, 0.95, &probs, 5);
        assert!((c.fire.unwrap() - 0.05).abs() < 1e-6, "1 - p for a hold");
        assert!((c.mv - 0.1).abs() < 1e-6);
        assert!(c.inst < 0.1, "inst {} must be LOW", c.inst);
        assert!(
            c.confidence > 0.85,
            "confidence {} must be HIGH",
            c.confidence
        );
    }

    // ── 2. fire actions (E7 mirror) ─────────────────────────────────────

    /// Salvo grouping (secondary bursts and aircraft ordnance excluded),
    /// the p10 reload estimate, the labelA eligibility gate and the labelB
    /// fired-window test.
    #[test]
    fn fire_action_contexts_group_salvos_and_gate_eligibility() {
        let mut stream = minimal_stream(None);
        let mut shells = Vec::new();
        for base in [100.0f32, 124.0, 151.0] {
            for b in 0..4u16 {
                shells.push(shell(base + b as f32 * 0.2, 9, b, 2.0));
            }
        }
        // Secondary battery burst at 130 — must not touch main salvos.
        shells.push(shell(130.0, 9, 40, 2.0));
        shells.push(shell(130.3, 9, 41, 2.0));
        // Aircraft ordnance (CV rockets) — excluded by muzzle height.
        shells.push(shell(140.0, 9, 1, 25.0));
        stream.shell_launches = shells;
        let ctxs = fire_action_contexts(&stream);
        let ctx = ctxs.get(&9).expect("owner 9 context");
        // Intervals [24, 27] -> p10 (nearest-rank) = 24 s.
        assert_eq!(ctx.main_starts, vec![100.0, 124.0, 151.0]);
        assert!((ctx.reload_s - 24.0).abs() < 1e-5, "{}", ctx.reload_s);

        let row = |t: f32, enemies: Vec<FireDatasetSlot>| move_row(synth_core(9, 1, t, enemies), 0);
        let enemy = || vec![synth_slot(8, 8_000.0, true)];
        // effective reload = 24 - 2 = 22 s.
        assert!(
            !can_fire_at(&row(130.0, enemy()), Some(ctx)),
            "inside reload"
        );
        assert!(
            can_fire_at(&row(150.0, enemy()), Some(ctx)),
            "reloaded + target"
        );
        assert!(!can_fire_at(&row(200.0, vec![]), Some(ctx)), "no target");
        // Stale intel is not a target either.
        assert!(!can_fire_at(
            &row(150.0, vec![synth_slot(8, 8_000.0, false)]),
            Some(ctx)
        ));
        // No fire context at all (never fired): always reloaded.
        assert!(can_fire_at(&row(130.0, enemy()), None));
        // labelB window (t, t+2]: the 151 salvo fires row 150, not row 152.
        assert!(fired_in_label_window(Some(ctx), 150.0, LABEL_WINDOW_S));
        assert!(!fired_in_label_window(Some(ctx), 152.0, LABEL_WINDOW_S));
        assert!(!fired_in_label_window(None, 150.0, LABEL_WINDOW_S));
    }

    // ── 3. BattleResults join ───────────────────────────────────────────

    /// The join's four verdicts + the 14.x legacy layout shift.
    #[test]
    fn battle_results_join_verdicts_and_legacy_layout() {
        let mut players = serde_json::Map::new();
        players.insert(
            "1".into(),
            br_entry(0, 111, 50_000.0, 1_500.0, 2.0, false, false),
        );
        // Mirror lineup: shipId 222 on BOTH teams -> ambiguous (#1202).
        players.insert(
            "2".into(),
            br_entry(0, 222, 1_000.0, 10.0, 0.0, true, false),
        );
        players.insert(
            "3".into(),
            br_entry(1, 222, 2_000.0, 20.0, 1.0, true, false),
        );
        // Same-team duplicate hulls: shipId 555 twice on one team — equally
        // unjoinable at entity level.
        players.insert(
            "4".into(),
            br_entry(0, 555, 3_000.0, 30.0, 0.0, true, false),
        );
        players.insert(
            "5".into(),
            br_entry(0, 555, 4_000.0, 40.0, 0.0, true, false),
        );
        // Legacy 14.x array: exp/damage 15 positions earlier.
        players.insert(
            "6".into(),
            br_entry(1, 333, 7_777.0, 888.0, 1.0, true, true),
        );
        let idx = BattleResultsIndex::parse(Some(&br_json(players))).expect("parse");
        assert!(matches!(
            idx.join(Some(111)),
            ShipOutcome::Ok { damage, base_exp: Some(1_500.0), frags: 2.0, survived: false }
                if (damage - 50_000.0).abs() < 1e-9
        ));
        assert!(matches!(idx.join(Some(222)), ShipOutcome::Ambiguous));
        assert!(matches!(idx.join(Some(555)), ShipOutcome::Ambiguous));
        assert!(matches!(idx.join(Some(444)), ShipOutcome::Missing));
        assert!(matches!(idx.join(None), ShipOutcome::NoShipId));
        // Legacy indices read through the shift.
        assert!(matches!(
            idx.join(Some(333)),
            ShipOutcome::Ok { damage, base_exp: Some(888.0), frags: 1.0, survived: true }
                if (damage - 7_777.0).abs() < 1e-9
        ));
        // A different shipId in a one-entry payload: still Missing.
        let mut solo = serde_json::Map::new();
        solo.insert("1".into(), br_entry(0, 1, 1.0, 1.0, 0.0, true, false));
        assert!(matches!(
            BattleResultsIndex::parse(Some(&br_json(solo)))
                .unwrap()
                .join(Some(111)),
            ShipOutcome::Missing
        ));
        // No battle-results payload at all: everything Missing.
        assert!(BattleResultsIndex::parse(None).is_none());
    }

    // ── 4. report aggregation ───────────────────────────────────────────

    /// The full pure core on a synthetic stream: per-ship aggregation,
    /// wholeFire null for ships with no can-fire rows, the time window
    /// filter (samples AND means), recorder marking, per-ship ordering and
    /// the camelCase wire shape.
    #[test]
    fn build_report_aggregates_windows_and_joins() {
        let raw = br_json({
            let mut players = serde_json::Map::new();
            players.insert(
                "1".into(),
                br_entry(0, 1007, 60_000.0, 2_100.0, 3.0, true, false),
            );
            players.insert("2".into(), br_entry(0, 1009, 1.0, 1.0, 0.0, true, false));
            players.insert("3".into(), br_entry(1, 1009, 2.0, 2.0, 0.0, true, false));
            players
        });
        let mut stream = minimal_stream(Some(&raw));
        let mut shells = Vec::new();
        for base in [100.0f32, 124.0, 151.0] {
            for b in 0..4u16 {
                shells.push(shell(base + b as f32 * 0.2, 9, b, 2.0));
            }
        }
        stream.shell_launches = shells;
        stream.recorder_vehicle_id = Some(7);

        let enemy = synth_slot(8, 8_000.0, true);
        let rows = vec![
            // Ship 9 (team 1, gunship): t=150 can-fire + FIRED; t=200
            // can-fire + held; t=310 outside the [140, 301] window.
            move_row(synth_core(9, 1, 150.0, vec![enemy.clone()]), 0),
            move_row(synth_core(9, 1, 200.0, vec![enemy.clone()]), 1),
            move_row(synth_core(9, 1, 310.0, vec![enemy]), 2),
            // Ship 7 (recorder, no enemies ever): no-move row only.
            move_row(synth_core(7, 0, 300.0, vec![]), MOVE_SECTOR_NONE),
        ];
        // Deterministic fake heads: fireProb 0.8 everywhere; move softmax
        // concentrated on sector 0 (0.84) with 0.01 elsewhere.
        let mut probs = [0.01f32; 17];
        probs[0] = 0.84;
        let probs = probs.to_vec();
        let report = build_ship_scores(
            &stream,
            &rows,
            "syntheticReplay",
            Some(140.0),
            Some(301.0),
            ScoreModelSources {
                fire: "synthetic".into(),
                move_model: "synthetic".into(),
            },
            |_row| Ok((0.8f32, probs.clone())),
        )
        .expect("build report");

        assert_eq!(report.replay_id, "syntheticReplay");
        assert_eq!(report.game_mode.as_deref(), Some("pvp"));
        assert_eq!(report.stats.ships_scored, 2);
        assert_eq!(report.stats.rows_scored, 3); // t=310 windowed out
        assert_eq!(report.stats.rows_can_fire, 2);
        assert_eq!(report.stats.rows_fired, 1);
        assert_eq!(report.stats.rows_no_move, 1);
        let ids: Vec<i32> = report.per_ship.iter().map(|s| s.entity_id).collect();
        assert_eq!(ids, vec![7, 9], "ordered by entity id");

        let s7 = &report.per_ship[0];
        assert!(s7.is_recorder);
        assert!(
            s7.whole_fire.is_none(),
            "no can-fire rows -> null fire mean"
        );
        assert_eq!(s7.samples.len(), 1);
        assert!(
            s7.samples[0].fire.is_none(),
            "no-move row carries no fire term"
        );
        assert!((s7.samples[0].inst - 0.01).abs() < 1e-6);
        assert!(matches!(s7.outcome, ShipOutcome::Ok { damage, .. } if damage == 60_000.0));

        let s9 = &report.per_ship[1];
        assert!(!s9.is_recorder);
        assert_eq!(s9.samples.len(), 2, "t=310 windowed out of samples too");
        assert!(s9.samples.iter().all(|s| s.t != 310.0));
        // t=150: fired with p=0.8 -> fire 0.8; t=200: held -> 0.2.
        assert!((s9.samples[0].fire.unwrap() - 0.8).abs() < 1e-6);
        assert!((s9.samples[1].fire.unwrap() - 0.2).abs() < 1e-6);
        // wholeFire = mean(0.8, 0.2) = 0.5; mv = 0.84 on t=150 (sector 0 =
        // the concentrated one), 0.01 on t=200 (sector 1).
        assert!((s9.whole_fire.unwrap() - 0.5).abs() < 1e-6);
        let want_inst_150 = 0.5 * 0.8 + 0.5 * 0.84;
        let want_inst_200 = 0.5 * 0.2 + 0.5 * 0.01;
        assert!((s9.samples[0].inst - want_inst_150).abs() < 1e-6);
        assert!((s9.samples[1].inst - want_inst_200).abs() < 1e-6);
        let want_whole = (want_inst_150 + want_inst_200) / 2.0;
        assert!((s9.whole_game - want_whole).abs() < 1e-6);
        assert!(
            matches!(s9.outcome, ShipOutcome::Ambiguous),
            "mirror shipId"
        );

        // camelCase wire shape.
        let js = serde_json::to_value(&report).expect("serialize");
        assert!(js.get("perShip").is_some());
        assert!(js.get("modelSources").is_some());
        assert!(js.get("stats").is_some());
        let row = &js["perShip"][1];
        assert!(row.get("wholeFire").is_some());
        assert!(row.get("wholeMove").is_some());
        assert!(row.get("isRecorder").is_some());
        let samp = &row["samples"][0];
        assert!(samp.get("inst").is_some());
        assert!(samp.get("fire").is_some());
        assert!(samp.get("move").is_some(), "per-sample move term");
        assert!(samp.get("confidence").is_some());
        assert_eq!(js["perShip"][0]["outcome"]["status"], "ok");
        assert_eq!(js["perShip"][1]["outcome"]["status"], "ambiguous");
    }

    // ── 5. real models (skips when the experiment artifacts are absent) ──

    /// Both default scoring models load, classify by metadata (widths
    /// 24/15/27; 17-class movement head) and answer a finite forward —
    /// including the e11 ablation path. CI skips (out/ is untracked); this
    /// worktree runs it for real.
    #[test]
    fn score_models_load_and_answer() {
        let fire_path = score_model_path("WOWSP_FIRE_MODEL", DEFAULT_FIRE_MODEL_REL);
        let move_path = score_model_path("WOWSP_MOVE_MODEL", DEFAULT_MOVE_MODEL_REL);
        if !fire_path.is_file() || !move_path.is_file() {
            eprintln!(
                "[e17] scoring models not found ({} / {}) - skipping",
                fire_path.display(),
                move_path.display()
            );
            return;
        }
        let mut fire = load_fire_score_model().expect("fire model");
        let mut mv = load_move_score_model().expect("move model");
        assert_eq!(fire.kind(), &ScoreModelKind::FireTwoHead);
        assert_eq!(mv.kind(), &ScoreModelKind::MoveSectors { sectors: 17 });
        assert_eq!(fire.widths(), (24, 15, 27));
        assert_eq!(mv.widths(), (24, 15, 27));
        // Zero features, full mask: must answer finite (not NaN).
        let entity = vec![0.0f32; 24 * 15];
        let global = vec![0.0f32; 27];
        let mask = vec![1.0f32; 24];
        let (la, lb) = fire
            .infer_fire(&entity, &global, &mask, None)
            .expect("fire forward");
        assert!(la.is_finite() && lb.is_finite());
        let (ab_entity, ab_global) = ablate_e11_tensors(&entity, &global, 24);
        let logits = mv
            .infer_move(&ab_entity, &ab_global, &mask)
            .expect("move forward");
        assert_eq!(logits.len(), 17);
        assert!(logits.iter().all(|l| l.is_finite()));
        let p = softmax(&logits);
        assert!((p.iter().sum::<f32>() - 1.0).abs() < 1e-5);
        // Ablation really zeroes the right columns (and nothing else).
        let mut ent2 = entity.clone();
        ent2[0 * 15 + 10] = 0.7;
        ent2[3 * 15 + 14] = 0.9;
        let mut glb2 = global.clone();
        glb2[14] = 0.5;
        glb2[26] = 1.0;
        glb2[25] = -0.25;
        let (ae, ag) = ablate_e11_tensors(&ent2, &glb2, 24);
        assert_eq!(ae[0 * 15 + 10], 0.0);
        assert_eq!(ae[3 * 15 + 14], 0.0);
        assert_eq!(ag[14], 0.0);
        assert_eq!(ag[26], 0.0);
        assert_eq!(ag[25], -0.25, "non-e11 columns untouched");
    }

    // ── 6. env-gated corpus run (E17 hard validation input) ─────────────

    /// Walk `dir` recursively for `*.wowsreplay` (the live temp excluded),
    /// sorted — mirrors fire_dataset's private walk.
    fn collect_replay_files(dir: &Path, out: &mut Vec<PathBuf>) {
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
            } else if path.extension().and_then(|e| e.to_str()) == Some("wowsreplay")
                && path.file_name().and_then(|n| n.to_str()) != Some("temp.wowsreplay")
            {
                out.push(path);
            }
        }
    }

    /// E17 against real replay bytes — run with
    /// `WOWSP_TEST_REPLAY_DIR=<folder>` (or `WOWSP_TEST_REPLAY=<file>`),
    /// `WOWSP_SCORE_OUT=<absolute path>` dumps one `ShipScoreReport` JSON
    /// per line for `validate_scores.py`. Optional `WOWSP_TEST_LOS_DIR`
    /// (default: the experiments out/ layout). Skips when the env vars or
    /// the scoring models are absent; per-file failures are recorded and
    /// the batch CONTINUES (the e16 tolerance pattern).
    #[test]
    fn e17_score_batch_on_real_replays() {
        let replay_dir = match std::env::var("WOWSP_TEST_REPLAY_DIR") {
            Ok(dir) => PathBuf::from(dir),
            Err(_) => match std::env::var("WOWSP_TEST_REPLAY") {
                Ok(file) => {
                    let root = std::env::temp_dir()
                        .join(format!("wowsp_e17_score_real_{}", std::process::id()));
                    std::fs::create_dir_all(&root).expect("mkdir");
                    let name = Path::new(&file)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "real.wowsreplay".into());
                    std::fs::copy(&file, root.join(&name)).expect("copy real replay");
                    root
                },
                Err(_) => {
                    eprintln!("[e17] WOWSP_TEST_REPLAY_DIR / WOWSP_TEST_REPLAY not set - skipping");
                    return;
                },
            },
        };
        if let Err(e) = score_fire_model().and_then(|_| score_move_model()) {
            eprintln!("[e17] scoring models unavailable ({e}) - skipping");
            return;
        }
        let los_dir = match std::env::var("WOWSP_TEST_LOS_DIR") {
            Ok(p) => Some(PathBuf::from(p)),
            Err(_) => {
                let default = experiments_out();
                default.is_dir().then_some(default)
            },
        };
        let mut files = Vec::new();
        collect_replay_files(&replay_dir, &mut files);
        files.sort();
        assert!(
            !files.is_empty(),
            "no .wowsreplay under {}",
            replay_dir.display()
        );
        let out_path = std::env::var("WOWSP_SCORE_OUT").ok().map(PathBuf::from);
        if let Some(p) = &out_path {
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).expect("create score out parent");
            }
        }
        use std::io::Write;
        let mut out_file = out_path
            .as_ref()
            .map(|p| std::fs::File::create(p).expect("create score JSONL"));
        let (mut exported, mut failed, mut ships, mut rows, mut joined, mut ambiguous) =
            (0usize, 0usize, 0usize, 0usize, 0usize, 0usize);
        for (i, path) in files.iter().enumerate() {
            match compute_ship_scores(path, None, None, los_dir.as_deref()) {
                Ok(report) => {
                    exported += 1;
                    ships += report.per_ship.len();
                    rows += report.stats.rows_scored;
                    let ok = report
                        .per_ship
                        .iter()
                        .filter(|s| matches!(s.outcome, ShipOutcome::Ok { .. }))
                        .count();
                    let amb = report
                        .per_ship
                        .iter()
                        .filter(|s| matches!(s.outcome, ShipOutcome::Ambiguous))
                        .count();
                    joined += ok;
                    ambiguous += amb;
                    assert!(!report.per_ship.is_empty(), "no ships scored");
                    assert!(!report.replay_id.is_empty());
                    for s in &report.per_ship {
                        assert!(!s.samples.is_empty(), "ship {} has no samples", s.entity_id);
                        assert!((0.0..=1.0).contains(&s.whole_game), "{}", s.whole_game);
                        for samp in &s.samples {
                            assert!((0.0..=1.0).contains(&samp.inst));
                            assert!((0.0..=1.0).contains(&samp.confidence));
                            assert!((0.0..=1.0).contains(&samp.mv));
                            if let Some(f) = samp.fire {
                                assert!((0.0..=1.0).contains(&f));
                            }
                        }
                        if let ShipOutcome::Ok { damage, .. } = &s.outcome {
                            assert!(damage.is_finite() && *damage >= 0.0, "damage {damage}");
                        }
                    }
                    if let Some(f) = out_file.as_mut() {
                        writeln!(
                            f,
                            "{}",
                            serde_json::to_string(&report).expect("serialize report")
                        )
                        .expect("write report line");
                    }
                    eprintln!(
                        "[e17] {}/{} {}: {} ships / {} rows / {} joined / {} ambiguous",
                        i + 1,
                        files.len(),
                        report.replay_id,
                        report.per_ship.len(),
                        report.stats.rows_scored,
                        ok,
                        amb
                    );
                },
                Err(e) => {
                    failed += 1;
                    eprintln!("[e17] {} -> FAILED: {e}", path.display());
                },
            }
        }
        eprintln!(
            "[e17] corpus done: {exported} exported / {failed} failed; {ships} ships / {rows} rows; join {joined} ok / {ambiguous} ambiguous"
        );
        assert!(exported >= 1, "nothing exported");
        if let Some(p) = &out_path {
            eprintln!("[e17] score JSONL written to {}", p.display());
        }
    }
}
