//! E25 · static per-player decision reports — the shareable long-image
//! substrate.
//!
//! `decision_debug_report` is the interactive debugger: it answers "what
//! does the board look like at THIS instant". This module answers the
//! after-action question the user actually asks a coach: "dissect THIS
//! player's key decisions over the whole match, as a report I can step
//! through or export as one long image".
//!
//! Design constraints that shaped it:
//!
//! * **Any player's perspective, honestly bounded.** The replay's feature
//!   stream is recorder-relative: teammates and the recorder are always
//!   observable, enemies only while spotted. A chosen player therefore has
//!   a *coverage* profile — the alive interval cut by data gaps — and the
//!   report states those gaps explicitly (the user's rule: never paper
//!   over "this person was unresolvable during these minutes"). Ships the
//!   exporter dropped entirely (mirror-ambiguous hulls) are listed with
//!   zero samples, never silently omitted.
//! * **Moments, not a wall of numbers.** The 4-second sample series stays
//!   available for the timeline sparkline, but the report proper is a
//!   small set of *key decisions* — windows where something verifiable
//!   happened (damage landed through a fired window, a high-probability
//!   opportunity passed up, a low-probability shot forced) or where the
//!   instant score hit its extremes — each with the situation snapshot,
//!   the action taken, the models' verdict, and the realised outcome.
//! * **Numbers here, words in the UI.** Categories and quantities cross
//!   the wire; the webui localises captions (8 locales) and renders the
//!   long image — Rust stays free of presentation strings.
//!
//! The heavy artifacts (tick export + model scoring of every row) come
//! from the shared single-slot debug cache: opening the 3D board and then
//! requesting a static report pays the scoring pass once.

use anyhow::anyhow;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use wowsp_tauri_shared::CommandResult;

use super::decision_score::{ShipScoreReport, ShipScoreSample, softmax};
use super::decision_serve::{debug_move_model, with_debug_cache_entry};
use super::fire_dataset::MoveDatasetRow;
use super::replay::decode_replay_stream_with_events;

/// Nominal sample grid (the E16 movement export window step), seconds.
const SAMPLE_GRID_S: f32 = 4.0;
/// Consecutive-sample distance that counts as a data gap: three missed
/// grid steps. Tighter would call ordinary scheduling jitter a gap.
const GAP_S: f32 = 3.0 * SAMPLE_GRID_S;
/// Lead-in before the first sample that still counts as covered.
const START_TOLERANCE_S: f32 = 4.0 * SAMPLE_GRID_S;
/// Minimum spacing between two selected key moments — the label/outcome
/// windows (t..t+45s) must not overlap.
const MOMENT_SPACING_S: f32 = 45.0;
/// How many key moments a report dissects.
const MOMENT_BUDGET: usize = 8;

// ── DTOs (wire contract; camelCase, decision_score local-struct precedent) ──

/// One roster row's data-availability profile (the picker's badges).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticRosterEntry {
    pub entity_id: i32,
    pub ship_id: Option<i64>,
    /// Resolved from the replay roster (ship display name preferred).
    pub name: Option<String>,
    /// Recorder-relative team: 0 = recorder's side, 1 = enemy.
    pub team_id: i8,
    pub is_recorder: bool,
    /// Death time, `None` when the ship survived.
    pub died_at: Option<f32>,
    /// Coverage classification over the alive interval.
    pub coverage: StaticCoverage,
    /// Whole-game scores (present whenever the ship has scoreable rows;
    /// `contribution` is null for ships that never fired a can-fire
    /// window — E21 semantics).
    pub whole: Option<StaticWholeScores>,
    /// Battle-results ground truth when joinable (damage/frags/survived),
    /// null for ships the exporter dropped.
    pub outcome: serde_json::Value,
}

/// Data availability over the alive interval.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticCoverage {
    /// Alive interval [from, to]; `to` is the death time or the replay's
    /// scored horizon (last sample overall) for survivors.
    pub alive_from: f32,
    pub alive_to: f32,
    /// Scored samples behind the report.
    pub samples: usize,
    /// Total seconds inside gaps (alive but unobservable — enemy dark,
    /// or censored windows the exporter dropped).
    pub gap_seconds: f32,
    /// covered / alive, clamped to [0, 1].
    pub completeness: f32,
    /// The gap segments themselves ([from, to] pairs, battle seconds) —
    /// the coverage bar paints these as hatched stretches.
    pub gap_segments: Vec<(f32, f32)>,
}

/// The whole-game headline numbers (E21/E22 semantics).
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticWholeScores {
    pub whole_game: f32,
    pub whole_fire: Option<f32>,
    pub whole_move: f32,
    pub contribution: Option<f64>,
    pub contribution_shots: Option<u32>,
}

/// Why a moment was selected — drives the caption in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StaticMomentCategory {
    /// Fired a can-fire window and enemy HP verifiably went down in it.
    DamageRealized,
    /// High model fire probability, no shot taken (the passed-up window).
    MissedOpportunity,
    /// Fired against a low model probability (the forced shot).
    ForcedShot,
    /// Instant-score extreme, high side.
    StrongWindow,
    /// Instant-score extreme, low side.
    WeakWindow,
}

/// The nearest observed enemy at the moment (situation snapshot).
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticEnemySnapshot {
    pub entity_id: i32,
    pub dist_m: f32,
    /// Bearing relative to own heading, radians.
    pub bearing_rel_rad: f32,
    /// `dist_m <= own main-battery range` at the moment.
    pub in_range: bool,
}

/// One dissected key decision.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticMoment {
    pub t: f32,
    pub category: StaticMomentCategory,
    /// Selection weight (ordering/debug aid).
    pub weight: f32,
    // ── situation ──
    pub hp_frac: Option<f32>,
    pub speed_kt: Option<f32>,
    pub enemies_observed: usize,
    pub nearest_enemy: Option<StaticEnemySnapshot>,
    // ── action taken ──
    /// Actual fire action; null off can-fire rows (no decision on the
    /// table).
    pub fired: Option<bool>,
    /// Head-B probability at the moment (null off can-fire rows).
    pub fire_prob: Option<f32>,
    /// Actual move sector (0..15, 16 = no move).
    pub move_sector: u8,
    /// The move model's advised top sector + its softmax mass (recomputed
    /// on this row — the sample series only keeps the mass on the ACTUAL
    /// sector).
    pub advised_sector: u8,
    pub advised_prob: f32,
    // ── verdict + outcome ──
    pub inst: f32,
    pub fire_alignment: Option<f32>,
    pub move_alignment: f32,
    pub confidence: f32,
    /// Enemy HP lost in (t+label window, t+45s] attributed to this ship
    /// (null off can-fire rows). f32 — HP deltas exceed f32 precision
    /// nowhere in this domain.
    pub hp_lost_window: Option<f32>,
    /// Own HP fraction ~20 s later (retreat/read-the-room context).
    pub hp_frac_after: Option<f32>,
}

/// The full static report for one chosen player.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticReport {
    pub replay_path: String,
    pub replay_id: String,
    pub map_name: Option<String>,
    pub game_mode: Option<String>,
    /// The replay's scored horizon (last sample over all ships).
    pub duration_s: f32,
    /// Los rasters were loaded for the feature pass.
    pub los_loaded: bool,
    pub model_sources: serde_json::Value,
    /// The chosen player.
    pub entity_id: i32,
    /// Full roster with per-ship coverage (the picker switches between
    /// these without re-fetching — one scoring pass serves all).
    pub roster: Vec<StaticRosterEntry>,
    /// The chosen player's timeline (4 s grid) for the sparkline.
    pub timeline: Vec<ShipScoreSample>,
    pub moments: Vec<StaticMoment>,
}

// ── pure selection / coverage logic (unit-tested) ───────────────────────────

/// Walk a ship's sample times over its alive interval and emit the gaps.
/// `alive_to` is the death time, or the replay's scored horizon for
/// survivors.
pub(crate) fn coverage_gaps(sample_ts: &[f32], alive_from: f32, alive_to: f32) -> Vec<(f32, f32)> {
    let mut gaps = Vec::new();
    if sample_ts.is_empty() {
        return gaps;
    }
    // Lead-in: data starting noticeably after spawn is a gap too.
    if sample_ts[0] - alive_from > START_TOLERANCE_S {
        gaps.push((alive_from, sample_ts[0]));
    }
    let mut prev = sample_ts[0];
    for &t in &sample_ts[1..] {
        if t - prev > GAP_S {
            gaps.push((prev, t));
        }
        prev = t;
    }
    // Tail: died (or horizon passed) well after the last sample.
    if alive_to - prev > GAP_S {
        gaps.push((prev, alive_to));
    }
    gaps
}

/// Classify one sample as a key-moment candidate. Returns (category,
/// weight) — `None` when the sample is not moment material.
pub(crate) fn moment_candidate(s: &ShipScoreSample) -> Option<(StaticMomentCategory, f32)> {
    // Weight BANDS decide the report's hierarchy: verifiable fire
    // outcomes (≥2.0) always outrank probability disagreements (≥1.5),
    // which always outrank score extremes (<1.25). A 17k damage window
    // must not lose its slot to a low instant score — the realised
    // outcome is the story the reader signed up for.
    if s.fired == Some(true) {
        if let Some(hp) = s.hp_lost {
            if hp >= 15_000.0 {
                return Some((StaticMomentCategory::DamageRealized, 2.0 + hp / 50_000.0));
            }
        }
    }
    match (s.fire_prob, s.fired) {
        // Passed-up high-probability window.
        (Some(p), Some(false)) if p >= 0.65 => {
            return Some((StaticMomentCategory::MissedOpportunity, 1.5 + p));
        },
        // Forced low-probability shot.
        (Some(p), Some(true)) if p <= 0.25 => {
            return Some((StaticMomentCategory::ForcedShot, 1.5 + (1.0 - p)));
        },
        _ => {},
    }
    // Score extremes anchor the narrative even without fire context.
    if s.inst >= 0.85 {
        return Some((StaticMomentCategory::StrongWindow, (s.inst - 0.6) * 1.25));
    }
    if s.inst <= 0.35 {
        return Some((StaticMomentCategory::WeakWindow, (0.6 - s.inst) * 1.25));
    }
    None
}

/// Greedy moment selection: highest weight first, 45 s apart, ≤ 8 total,
/// returned in time order.
pub(crate) fn select_moments(samples: &[ShipScoreSample]) -> Vec<usize> {
    let mut candidates: Vec<(f32, usize)> = samples
        .iter()
        .enumerate()
        .filter_map(|(i, s)| moment_candidate(s).map(|(_, w)| (w, i)))
        .collect();
    candidates.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    let mut picked: Vec<usize> = Vec::new();
    for (_, i) in candidates {
        if picked.len() >= MOMENT_BUDGET {
            break;
        }
        if picked
            .iter()
            .all(|&j| (samples[j].t - samples[i].t).abs() >= MOMENT_SPACING_S)
        {
            picked.push(i);
        }
    }
    picked.sort_by(|&a, &b| samples[a].t.total_cmp(&samples[b].t));
    picked
}

fn coverage_of(samples: &[ShipScoreSample], alive_from: f32, alive_to: f32) -> StaticCoverage {
    let alive = (alive_to - alive_from).max(0.0);
    if samples.is_empty() {
        // A ship with zero rows (exporter-dropped / never observable) is
        // fully uncovered — visibly excluded, never silently complete.
        return StaticCoverage {
            alive_from,
            alive_to,
            samples: 0,
            gap_seconds: alive,
            completeness: 0.0,
            gap_segments: vec![(alive_from, alive_to)],
        };
    }
    let ts: Vec<f32> = samples.iter().map(|s| s.t).collect();
    let gaps = coverage_gaps(&ts, alive_from, alive_to);
    let gap_seconds: f32 = gaps.iter().map(|(a, b)| (b - a).max(0.0)).sum();
    StaticCoverage {
        alive_from,
        alive_to,
        samples: samples.len(),
        gap_seconds,
        completeness: if alive > 0.0 {
            (1.0 - gap_seconds / alive).clamp(0.0, 1.0)
        } else {
            1.0
        },
        gap_segments: gaps,
    }
}

// ── report assembly ─────────────────────────────────────────────────────────

/// Build the full report for one entity off a warm cache entry.
pub(crate) fn build_static_report(
    path: &Path,
    los_dir: Option<&Path>,
    entity_id: Option<i32>,
) -> anyhow::Result<StaticReport> {
    use serde_json::json;

    with_debug_cache_entry(path, los_dir, |entry| {
        // None = the recorder (the default perspective: always fully
        // observable — every other ship is bounded by spotting).
        let entity_id = entity_id
            .or(entry.recorder)
            .ok_or_else(|| anyhow!("replay carries no recorder id — pass an explicit entity"))?;
        let scores: &ShipScoreReport = &entry.scores;
        let scored_horizon = scores
            .per_ship
            .iter()
            .filter_map(|e| e.samples.last().map(|s| s.t))
            .fold(0.0f32, f32::max);

        // Roster from the stream's ship trajectories (a superset of the
        // scored rows — ships the exporter dropped appear with zero
        // samples rather than vanishing).
        let (stream, _events) = decode_replay_stream_with_events(&path.to_string_lossy())
            .map_err(|e| anyhow!("decode {}: {e}", path.display()))?;
        // Name joins: the holographic board matches roster `id` against
        // entity ids; the stream doc names `kind.ship_id` the reliable
        // entity→player key. Try the id match first (validating its
        // ship_id), fall back to a unique-ship_id name; ambiguous hulls
        // (two players in one ship) stay unnamed rather than guessed.
        let roster = super::replay_probe::read_roster(&path.to_string_lossy())?;
        let name_by_id: BTreeMap<i64, String> = roster
            .iter()
            .map(|v| (v.id, v.ship_name.clone().unwrap_or_else(|| v.name.clone())))
            .collect();
        let mut name_by_ship: BTreeMap<i64, String> = BTreeMap::new();
        let mut ship_seen_twice: std::collections::HashSet<i64> = std::collections::HashSet::new();
        for v in &roster {
            let n = v.ship_name.clone().unwrap_or_else(|| v.name.clone());
            if name_by_ship.insert(v.ship_id, n).is_some() {
                ship_seen_twice.insert(v.ship_id);
            }
        }
        for sid in ship_seen_twice {
            name_by_ship.remove(&sid);
        }
        let resolve_name = |eid: i32, ship_id: Option<i64>| -> Option<String> {
            if let Some(n) = name_by_id.get(&(eid as i64)) {
                return Some(n.clone());
            }
            ship_id.and_then(|sid| name_by_ship.get(&sid).cloned())
        };

        let mut roster: Vec<StaticRosterEntry> = Vec::new();
        for t in &stream.trajectories {
            if !t.kind.as_ref().is_some_and(|k| k.entity_type == 2) {
                continue;
            }
            let eid = t.entity_id;
            let per_ship = scores.per_ship.iter().find(|e| e.entity_id == eid);
            let samples: &[ShipScoreSample] = per_ship.map_or(&[], |e| &e.samples);
            let died_at = entry.death.get(&eid).copied().flatten();
            let alive_to = died_at.unwrap_or(scored_horizon);
            let coverage = coverage_of(samples, 0.0, alive_to);
            let outcome = per_ship
                .map(|e| serde_json::to_value(&e.outcome).unwrap_or(serde_json::Value::Null))
                .unwrap_or(serde_json::Value::Null);
            let whole = per_ship.map(|e| StaticWholeScores {
                whole_game: e.whole_game,
                whole_fire: e.whole_fire,
                whole_move: e.whole_move,
                contribution: e.contribution,
                contribution_shots: e.contribution_shots,
            });
            let kind_ship_id = t.kind.as_ref().and_then(|k| k.ship_id);
            roster.push(StaticRosterEntry {
                entity_id: eid,
                ship_id: kind_ship_id,
                name: resolve_name(eid, kind_ship_id),
                team_id: per_ship.map_or(1, |e| e.team_id),
                is_recorder: stream.recorder_vehicle_id == Some(eid),
                died_at,
                coverage,
                whole,
                outcome,
            });
        }
        roster.sort_by(|a, b| {
            a.team_id
                .cmp(&b.team_id)
                .then(b.coverage.completeness.total_cmp(&a.coverage.completeness))
        });

        // Focused entity.
        let per_ship = scores
            .per_ship
            .iter()
            .find(|e| e.entity_id == entity_id)
            .ok_or_else(|| {
                anyhow!(
                    "entity {entity_id} has no scoreable rows (excluded by the exporter \
                     or not a ship) — pick another roster entry"
                )
            })?;
        let ship_rows: &[MoveDatasetRow] = entry
            .rows
            .get(&entity_id)
            .map(|v| v.as_slice())
            .ok_or_else(|| anyhow!("entity {entity_id} has no movement rows"))?;

        // Advise-per-moment needs the move model; one lock for all rows.
        let mv = debug_move_model()?;
        let mut mv = mv
            .lock()
            .map_err(|_| anyhow!("debug movement model mutex poisoned"))?;

        let picked = select_moments(&per_ship.samples);
        let mut moments: Vec<StaticMoment> = Vec::with_capacity(picked.len());
        for i in picked {
            let s = &per_ship.samples[i];
            let Some((category, weight)) = moment_candidate(s) else {
                continue;
            };
            // t-match the row (both series are t-sorted per ship; fall
            // back to the last row at-or-before the sample).
            let row_idx = match ship_rows.binary_search_by(|r| r.core.t.total_cmp(&s.t)) {
                Ok(idx) => Some(idx),
                Err(0) => None,
                Err(idx) => Some(idx - 1),
            };
            let Some(row) = row_idx.map(|idx| &ship_rows[idx]) else {
                continue;
            };
            let (entity, global, mask) = super::decision_score::feature_tensors_v2(row);
            let (mv_entity, mv_global) =
                super::decision_score::ablate_e11_tensors(&entity, &global, mv.widths().0);
            let logits = mv.infer_move(&mv_entity, &mv_global, &mask)?;
            let probs = softmax(&logits);
            let Some((advised_sector, advised_prob)) = probs
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .map(|(i, p)| (i as u8, *p))
            else {
                continue;
            };
            let nearest = row
                .core
                .enemies
                .iter()
                .filter(|e| e.observed_now)
                .min_by(|a, b| a.dist_m.total_cmp(&b.dist_m))
                .map(|e| StaticEnemySnapshot {
                    entity_id: e.entity_id,
                    dist_m: e.dist_m,
                    bearing_rel_rad: e.bearing_rel_rad,
                    in_range: e.dist_m <= row.core.own_range_m,
                });
            let hp_frac_after = ship_rows
                .iter()
                .rev()
                .find(|r| r.core.t <= s.t + 20.0)
                .and_then(|r| r.core.own_hp_frac);
            moments.push(StaticMoment {
                t: s.t,
                category,
                weight,
                hp_frac: row.core.own_hp_frac,
                speed_kt: row.core.own_speed_kt,
                enemies_observed: row.core.enemies.iter().filter(|e| e.observed_now).count(),
                nearest_enemy: nearest,
                fired: s.fired,
                fire_prob: s.fire_prob,
                move_sector: row.move_sector,
                advised_sector,
                advised_prob,
                inst: s.inst,
                fire_alignment: s.fire,
                move_alignment: s.mv,
                confidence: s.confidence,
                hp_lost_window: s.hp_lost,
                hp_frac_after,
            });
        }

        let replay_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        Ok(StaticReport {
            replay_path: path.display().to_string(),
            replay_id,
            map_name: entry.map_name.clone(),
            game_mode: scores.game_mode.clone(),
            duration_s: scored_horizon,
            los_loaded: entry.los_loaded,
            model_sources: json!({
                "fire": scores.model_sources.fire,
                "moveModel": scores.model_sources.move_model,
            }),
            entity_id,
            roster,
            timeline: per_ship.samples.clone(),
            moments,
        })
    })
}

/// The report command: any roster perspective, coverage-stated.
#[tauri::command]
pub fn decision_static_report(
    replay_path: String,
    entity_id: Option<i32>,
    los_grid_dir: Option<String>,
) -> CommandResult<StaticReport> {
    let path = Path::new(&replay_path);
    if !path.is_file() {
        return Err(anyhow!("replay not found: {replay_path}").into());
    }
    Ok(build_static_report(
        path,
        los_grid_dir.as_deref().map(Path::new),
        entity_id,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(
        t: f32,
        inst: f32,
        fired: Option<bool>,
        fire_prob: Option<f32>,
        hp: Option<f64>,
    ) -> ShipScoreSample {
        ShipScoreSample {
            t,
            inst,
            fire: None,
            fired,
            fire_prob,
            hp_lost: hp.map(|v| v as f32),
            mv: 0.5,
            confidence: 0.7,
        }
    }

    /// Samples every 4 s over [0, 120] with one 20 s hole and a tail gap.
    #[test]
    fn gaps_cover_lead_hole_and_tail() {
        let mut ts = Vec::new();
        let mut t = 8.0; // data starts 8 s in — under the start tolerance
        while t <= 60.0 {
            ts.push(t);
            t += SAMPLE_GRID_S;
        }
        t = 80.0; // 20 s hole
        while t <= 100.0 {
            ts.push(t);
            t += SAMPLE_GRID_S;
        }
        let gaps = coverage_gaps(&ts, 0.0, 120.0);
        // hole [60, 80] + tail [100, 120]; the 8 s lead-in is tolerated.
        assert_eq!(gaps.len(), 2, "gaps: {gaps:?}");
        assert!((gaps[0].0 - 60.0).abs() < 1e-3 && (gaps[0].1 - 80.0).abs() < 1e-3);
        assert!((gaps[1].0 - 100.0).abs() < 1e-3 && (gaps[1].1 - 120.0).abs() < 1e-3);
    }

    /// An empty series (a ship the exporter dropped) reports zero samples
    /// and zero completeness — visibly excluded, never silently absent.
    #[test]
    fn empty_series_reports_zero_coverage() {
        let c = coverage_of(&[], 0.0, 90.0);
        assert_eq!(c.samples, 0);
        assert_eq!(c.completeness, 0.0);
    }

    #[test]
    fn coverage_completeness_math() {
        let samples: Vec<ShipScoreSample> = (0..30)
            .map(|i| sample(i as f32 * SAMPLE_GRID_S, 0.5, None, None, None))
            .collect();
        let c = coverage_of(&samples, 0.0, 116.0);
        assert_eq!(c.samples, 30);
        assert!(c.completeness > 0.99, "{c:?}");
    }

    #[test]
    fn moment_categories_and_weights() {
        let dmg = sample(10.0, 0.8, Some(true), Some(0.7), Some(84_000.0));
        assert_eq!(
            moment_candidate(&dmg).map(|(c, _)| c),
            Some(StaticMomentCategory::DamageRealized)
        );
        let missed = sample(20.0, 0.5, Some(false), Some(0.9), None);
        assert_eq!(
            moment_candidate(&missed).map(|(c, _)| c),
            Some(StaticMomentCategory::MissedOpportunity)
        );
        let forced = sample(30.0, 0.4, Some(true), Some(0.1), Some(0.0));
        assert_eq!(
            moment_candidate(&forced).map(|(c, _)| c),
            Some(StaticMomentCategory::ForcedShot)
        );
        // Small fired damage with mid probability and a mid score → not
        // moment material.
        let quiet = sample(40.0, 0.6, Some(true), Some(0.5), Some(2_000.0));
        assert_eq!(moment_candidate(&quiet), None);
    }

    /// Selection enforces spacing and the budget, time-sorted output.
    #[test]
    fn selection_spacing_and_budget() {
        let samples: Vec<ShipScoreSample> = (0..40)
            .map(|i| sample(i as f32 * 5.0, 0.5, Some(false), Some(0.9), None))
            .collect();
        let picked = select_moments(&samples);
        assert!(picked.len() <= MOMENT_BUDGET);
        for w in picked.windows(2) {
            assert!(
                samples[w[1]].t - samples[w[0]].t >= MOMENT_SPACING_S,
                "moments closer than the spacing"
            );
        }
        assert!(
            picked
                .iter()
                .all(|&i| moment_candidate(&samples[i]).is_some())
        );
    }

    /// Real-replay end-to-end: env-gated (needs the debug models + a
    /// local replay). `WOWSP_STATIC_REPORT_REPLAY=<file> cargo test -p
    /// wowsp_tauri static_real -- --ignored --nocapture` builds the
    /// recorder's report and checks the invariants the UI depends on.
    /// The JSON lands under the OS temp dir (no arbitrary paths).
    #[test]
    #[ignore = "needs the debug models and a local replay"]
    fn static_real_report_invariants() {
        let replay = std::env::var("WOWSP_STATIC_REPORT_REPLAY")
            .expect("set WOWSP_STATIC_REPORT_REPLAY to a local .wowsreplay");
        // Optional perspective override (any-player demo: an enemy id from
        // a previous run's roster exercises the coverage-gap path); None
        // exercises the recorder-default resolution.
        let entity = std::env::var("WOWSP_STATIC_REPORT_ENTITY")
            .ok()
            .and_then(|v| v.parse::<i32>().ok());
        let report = build_static_report(Path::new(&replay), None, entity).expect("build report");
        assert!(!report.roster.is_empty());
        assert!(!report.timeline.is_empty());
        for r in &report.roster {
            assert!((0.0..=1.0).contains(&r.coverage.completeness));
        }
        assert!(report.moments.len() <= MOMENT_BUDGET);
        for m in &report.moments {
            assert!(m.inst.is_finite());
            assert!(m.advised_prob.is_finite());
        }
        // Deterministic output path under the OS temp dir only.
        let out_dir = std::env::temp_dir().join("wowsp-static-report");
        std::fs::create_dir_all(&out_dir).unwrap();
        let out = out_dir.join(format!("{}_{}.json", report.replay_id, report.entity_id));
        std::fs::write(&out, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        eprintln!(
            "[static] wrote {} ({} moments)",
            out.display(),
            report.moments.len()
        );
    }
}
