//! Stats math: the deep `PvpStats` extraction (career ranked/global modes),
//! the winrate-to-PR proxy family, the selectable PR algorithm and the
//! wows-numbers expected-values aggregation. Split from the former single-file
//! `commands/wg_api.rs`.

use std::collections::HashMap;

use super::trends::ExpectedValues;

/// Career totals for ONE battle mode: ranked (排位) is summed
/// rank_solo/rank_div2/rank_div3 splits (WG realms, extra-gated on
/// account/info) or the summed `seasons` tree (CN, vortex-normalized into
/// the WG seasons shape by `wg_api_cn`); the global view merges the
/// randoms and ranked careers into one (see `global_career_of`). All
/// fields None when the account never played that mode.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct CareerModeStats {
    pub(crate) battles: Option<i64>,
    pub(crate) winrate: Option<f32>,
    pub(crate) avg_damage: Option<f32>,
    pub(crate) pr: Option<i64>,
}

/// Raw per-division counters for one career mode: (battles, wins, damage)
/// × [solo, div2, div3]. Zeroed slots = that division never played. Feeds
/// `ranked_career_of` and the global-mode split merge.
pub(crate) type CareerSplits = [(i64, i64, i64); 3];

/// Extracts deep PvP stats from the WG account/info `statistics.pvp` node.
/// All fields are optional — hidden profiles yield null, and casual accounts
/// may lack division splits. PR is a career rating derived from an
/// ApeRadar-style weighted winrate (see `compute_pr`), not WG's internal
/// hidden score; under the "expected" algorithm callers overwrite `pr` with
/// the wows-numbers value (see `account_expected_pr_for`). Also fed with
/// vortex-normalized nodes by `wg_api_cn`.
pub(crate) struct PvpStats {
    pub(crate) battles: Option<i64>,
    pub(crate) winrate: Option<f32>,
    pub(crate) avg_damage: Option<f32>,
    pub(crate) avg_xp: Option<f32>,
    pub(crate) kd_ratio: Option<f32>,
    pub(crate) survival_rate: Option<f32>,
    pub(crate) hit_rate: Option<f32>,
    pub(crate) pr: Option<i64>,
    pub(crate) ships_played: Option<i64>,
    pub(crate) solo_wr: Option<f32>,
    pub(crate) div2_wr: Option<f32>,
    pub(crate) div3_wr: Option<f32>,
    pub(crate) solo_battles: Option<i64>,
    pub(crate) div2_battles: Option<i64>,
    pub(crate) div3_battles: Option<i64>,
    /// Career ranked stats (see [`CareerModeStats`]).
    pub(crate) ranked: CareerModeStats,
    /// Combined randoms+ranked career totals (see [`global_career_of`]).
    pub(crate) global: CareerModeStats,
}

impl PvpStats {
    pub(crate) fn extract(stats: Option<&serde_json::Value>) -> Self {
        let statistics = stats.filter(|v| !v.is_null());
        let statistics = match statistics {
            Some(s) => s,
            None => return Self::empty(),
        };
        // Ranked extraction runs BEFORE the pvp early-returns below: an
        // account can carry ranked counters with a null pvp node (randoms
        // never played), and the ranked numbers must survive that.
        let (ranked, ranked_splits) = extract_ranked_parts(statistics);
        let pvp = statistics.get("pvp").filter(|v| !v.is_null());
        let pvp = match pvp {
            Some(p) => p,
            None => {
                // Randoms never played: the global view IS the ranked career.
                let global = global_career_of(None, [None, None, None], ranked, ranked_splits);
                return Self {
                    ranked,
                    global,
                    ..Self::empty()
                };
            },
        };

        let battles = get_i64(pvp, "battles");
        let wins = get_i64(pvp, "wins");
        let winrate = match (wins, battles) {
            (Some(w), Some(b)) if b > 0 => Some(100.0 * w as f32 / b as f32),
            _ => None,
        };

        let damage = get_i64(pvp, "damage_dealt").or_else(|| get_i64(pvp, "damage_caused"));
        let avg_damage = match (damage, battles) {
            (Some(d), Some(b)) if b > 0 => Some(d as f32 / b as f32),
            _ => None,
        };

        let xp = get_i64(pvp, "xp");
        let avg_xp = match (xp, battles) {
            (Some(x), Some(b)) if b > 0 => Some(x as f32 / b as f32),
            _ => None,
        };

        let frags = get_i64(pvp, "frags");
        let survived = get_i64(pvp, "survived_battles");
        let kd_ratio = match (frags, battles, survived) {
            (Some(f), Some(b), Some(s)) if b > s => Some(f as f32 / (b - s) as f32),
            _ => None,
        };
        let survival_rate = match (survived, battles) {
            (Some(s), Some(b)) if b > 0 => Some(100.0 * s as f32 / b as f32),
            _ => None,
        };

        // Main battery shots/hits are nested under a "main_battery" sub-object
        // (WG changed the schema: formerly flat main_battery_shots/hits, now
        // main_battery.{shots,hits}). Try both layouts for compatibility.
        let mb = pvp.get("main_battery");
        let shots = mb
            .and_then(|m| get_i64(m, "shots"))
            .or_else(|| get_i64(pvp, "main_battery_shots"));
        let hits = mb
            .and_then(|m| get_i64(m, "hits"))
            .or_else(|| get_i64(pvp, "main_battery_hits"));
        let hit_rate = match (hits, shots) {
            (Some(h), Some(s)) if s > 0 => Some(100.0 * h as f32 / s as f32),
            _ => None,
        };

        // Always None: `account/info` has no per-ship breakdown, so a real
        // "ships played" count would need the `ships/{shipId}` endpoint (not
        // called here). `battles` must NOT stand in for it — one ship can be
        // played many times, so that number would be wrong rather than merely
        // approximate. The field stays `Option<i64>` so the wire shape does not
        // change once a real source is wired in.
        let ships_played: Option<i64> = None;

        // Career PR: ApeRadar-style weighted winrate over the division
        // splits, falling back to the overall PvP winrate when the account
        // carries no splits.
        let solo = div_stats(statistics, "pvp_solo");
        let div2 = div_stats(statistics, "pvp_div2");
        let div3 = div_stats(statistics, "pvp_div3");
        let pr = compute_pr(solo, div2, div3).or_else(|| match (winrate, battles) {
            (Some(w), Some(b)) if b > 0 => compute_pr(Some((w, b)), None, None),
            _ => None,
        });
        // Global career = randoms + ranked merged (raw pvp totals feed the
        // winrate/damage blend; the split pairs feed the PR bucket merge).
        let global = global_career_of(
            match (battles, wins, damage) {
                (Some(b), Some(w), Some(d)) if b > 0 => Some((b, w, d)),
                _ => None,
            },
            [solo, div2, div3],
            ranked,
            ranked_splits,
        );

        Self {
            battles,
            winrate,
            avg_damage,
            avg_xp,
            kd_ratio,
            survival_rate,
            hit_rate,
            pr,
            ships_played,
            solo_wr: solo.map(|(wr, _)| wr),
            div2_wr: div2.map(|(wr, _)| wr),
            div3_wr: div3.map(|(wr, _)| wr),
            solo_battles: solo.map(|(_, b)| b),
            div2_battles: div2.map(|(_, b)| b),
            div3_battles: div3.map(|(_, b)| b),
            ranked,
            global,
        }
    }

    fn empty() -> Self {
        Self {
            battles: None,
            winrate: None,
            avg_damage: None,
            avg_xp: None,
            kd_ratio: None,
            survival_rate: None,
            hit_rate: None,
            pr: None,
            ships_played: None,
            solo_wr: None,
            div2_wr: None,
            div3_wr: None,
            solo_battles: None,
            div2_battles: None,
            div3_battles: None,
            ranked: CareerModeStats::default(),
            global: CareerModeStats::default(),
        }
    }
}

/// One battle-type stats node's raw counters: (battles, wins, damage).
/// Null / zero-battle nodes read as None so a never-played split never
/// dilutes the sums.
fn mode_split(node: Option<&serde_json::Value>) -> Option<(i64, i64, i64)> {
    let node = node.filter(|v| !v.is_null())?;
    let b = get_i64(node, "battles")?;
    if b <= 0 {
        return None;
    }
    let w = get_i64(node, "wins").unwrap_or(0);
    let d = get_i64(node, "damage_dealt").or_else(|| get_i64(node, "damage_caused"))?;
    Some((b, w, d))
}

/// Assemble [`CareerModeStats`] out of summed raw counters plus the
/// per-split (winrate, battles) pairs the PR proxy blends. Zero total
/// battles → all-None (never played ranked).
fn ranked_career_of(splits: CareerSplits) -> CareerModeStats {
    let battles: i64 = splits.iter().map(|(b, _, _)| b).sum();
    if battles <= 0 {
        return CareerModeStats::default();
    }
    let wins: i64 = splits.iter().map(|(_, w, _)| w).sum();
    let damage: i64 = splits.iter().map(|(_, _, d)| d).sum();
    let winrate = 100.0 * wins as f32 / battles as f32;
    let wr_pair = |s: (i64, i64, i64)| (100.0 * s.1 as f32 / s.0 as f32, s.0);
    CareerModeStats {
        battles: Some(battles),
        winrate: Some(winrate),
        avg_damage: Some(damage as f32 / battles as f32),
        pr: compute_pr(
            (splits[0].0 > 0).then(|| wr_pair(splits[0])),
            (splits[1].0 > 0).then(|| wr_pair(splits[1])),
            (splits[2].0 > 0).then(|| wr_pair(splits[2])),
        ),
    }
}

/// Career ranked extraction off the account/info `statistics` node. Two
/// shapes, first hit wins: the WG rank_solo/rank_div2/rank_div3 extra
/// fields, then the CN `seasons` tree (season → shipType → rank_* mode,
/// vortex-normalized into the WG field names by `wg_api_cn`) summed across
/// every season and ship type. Returns the career totals PLUS the raw
/// per-division splits — the global-mode merge (`global_career_of`) needs
/// the split granularity even where the ranked PR itself runs on the
/// collapsed overall bucket (the CN seasons tree keeps its historical
/// one-bucket rating; only the global blend consumes its splits).
fn extract_ranked_parts(statistics: &serde_json::Value) -> (CareerModeStats, CareerSplits) {
    let splits = [
        mode_split(statistics.get("rank_solo")),
        mode_split(statistics.get("rank_div2")),
        mode_split(statistics.get("rank_div3")),
    ];
    if splits.iter().any(|s| s.is_some()) {
        let unwrap_or_zero = |s: Option<(i64, i64, i64)>| s.unwrap_or((0, 0, 0));
        let parts = [
            unwrap_or_zero(splits[0]),
            unwrap_or_zero(splits[1]),
            unwrap_or_zero(splits[2]),
        ];
        return (ranked_career_of(parts), parts);
    }
    let Some(seasons) = statistics.get("seasons").and_then(|s| s.as_object()) else {
        return (CareerModeStats::default(), [(0, 0, 0); 3]);
    };
    let mut parts = [(0i64, 0i64, 0i64); 3]; // per-division (battles, wins, damage)
    for ships in seasons.values() {
        let Some(ships) = ships.as_object() else {
            continue;
        };
        for modes in ships.values() {
            let Some(modes) = modes.as_object() else {
                continue;
            };
            for (mode, node) in modes {
                // Only the live ranked modes (rank_old_* never appears here,
                // but the guard keeps the sum honest if one ever does).
                let slot = match mode.as_str() {
                    "rank_solo" => 0,
                    "rank_div2" => 1,
                    "rank_div3" => 2,
                    _ => continue,
                };
                if let Some((b, w, d)) = mode_split(Some(node)) {
                    parts[slot].0 += b;
                    parts[slot].1 += w;
                    parts[slot].2 += d;
                }
            }
        }
    }
    // The seasons-tree rating keeps its historical one-bucket PR (the
    // overall blended bucket) — only the returned splits carry the
    // per-division detail for the global merge.
    let total = (
        parts[0].0 + parts[1].0 + parts[2].0,
        parts[0].1 + parts[1].1 + parts[2].1,
        parts[0].2 + parts[1].2 + parts[2].2,
    );
    (ranked_career_of([total, (0, 0, 0), (0, 0, 0)]), parts)
}

/// Battles-weighted merge of one division's two mode buckets: equivalent to
/// summing the sides' raw wins, expressed over the (winrate, battles) pair
/// shape `compute_pr` consumes. Either side absent → the other verbatim.
fn merged_split(pvp: Option<(f32, i64)>, ranked: Option<(f32, i64)>) -> Option<(f32, i64)> {
    match (pvp, ranked) {
        (Some((wr1, b1)), Some((wr2, b2))) => {
            let b = b1 + b2;
            if b > 0 {
                Some(((wr1 * b1 as f32 + wr2 * b2 as f32) / b as f32, b))
            } else {
                None
            }
        },
        (s, None) | (None, s) => s,
    }
}

/// The GLOBAL (全局) career view: randoms and ranked merged into one — the
/// "everything this account played" numbers the stats-mode selector's
/// `global` option shows. Either side may be absent (null pvp node / never
/// played ranked); the global view then IS the present side, and both
/// absent (hidden profile) yields all-None. Winrate/damage blend by battles
/// (exactly what summing the raw counters would produce); PR merges the two
/// modes' division splits bucket-for-bucket BEFORE the weighted blend, so
/// each mode keeps its division mix. When NEITHER side carries split detail
/// (casual accounts, CN's one-bucket seasons tree with no pvp splits), the
/// battles-weighted blend of the two overall winrates carries the rating.
/// When exactly ONE side carries splits, the split-less side's mass moves
/// the global winrate/battles/damage but not the rating (a documented
/// ceiling of the one-bucket source — on WG realms both sides share the
/// same extra gate so the case is theoretical; on CN the pvp side lacks
/// splits too and the overall blend fires).
pub(super) fn global_career_of(
    pvp: Option<(i64, i64, i64)>,
    pvp_splits: [Option<(f32, i64)>; 3],
    ranked: CareerModeStats,
    ranked_splits: CareerSplits,
) -> CareerModeStats {
    let rank_pair =
        |s: (i64, i64, i64)| (s.0 > 0).then_some((100.0 * s.1 as f32 / s.0 as f32, s.0));
    let ranked_pairs = [
        rank_pair(ranked_splits[0]),
        rank_pair(ranked_splits[1]),
        rank_pair(ranked_splits[2]),
    ];
    let pvp_battles = pvp.map(|(b, _, _)| b).unwrap_or(0);
    let pvp_pair = pvp.and_then(|(b, w, _)| (b > 0).then_some((100.0 * w as f32 / b as f32, b)));
    let ranked_pair = match (ranked.winrate, ranked.battles) {
        (Some(wr), Some(b)) if b > 0 => Some((wr, b)),
        _ => None,
    };
    let battles = pvp_battles + ranked.battles.unwrap_or(0);
    if battles <= 0 {
        return CareerModeStats::default();
    }
    // Battles-weighted blend of the sides' winrates / avg damages — the
    // same numbers summing the raw counters would give, derived from the
    // per-side means both extractors already produced.
    let blend = |pvp_v: Option<f32>, rank_v: Option<f32>| -> Option<f32> {
        let v1 = match pvp_v {
            Some(v) if pvp_battles > 0 => v,
            _ => return rank_v,
        };
        match (rank_v, ranked.battles) {
            (Some(v2), Some(b2)) if b2 > 0 => {
                Some((v1 * pvp_battles as f32 + v2 * b2 as f32) / (pvp_battles + b2) as f32)
            },
            _ => Some(v1),
        }
    };
    let merged = [
        merged_split(pvp_splits[0], ranked_pairs[0]),
        merged_split(pvp_splits[1], ranked_pairs[1]),
        merged_split(pvp_splits[2], ranked_pairs[2]),
    ];
    let pr = if merged.iter().any(|s| s.is_some()) {
        compute_pr(merged[0], merged[1], merged[2])
    } else {
        compute_pr(merged_split(pvp_pair, ranked_pair), None, None)
    };
    CareerModeStats {
        battles: Some(battles),
        winrate: blend(
            pvp.and_then(|(b, w, _)| (b > 0).then_some(100.0 * w as f32 / b as f32)),
            ranked.winrate,
        ),
        avg_damage: blend(
            pvp.and_then(|(b, _, d)| (b > 0).then_some(d as f32 / b as f32)),
            ranked.avg_damage,
        ),
        pr,
    }
}

pub(super) fn get_i64(v: &serde_json::Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_i64())
}

/// Extracts (winrate %, battles) from a per-division stats node
/// (pvp_solo / pvp_div2 / pvp_div3).
fn div_stats(statistics: &serde_json::Value, key: &str) -> Option<(f32, i64)> {
    let node = statistics.get(key)?;
    if node.is_null() {
        return None;
    }
    let b = node.get("battles")?.as_i64()?;
    let w = node.get("wins")?.as_i64()?;
    if b > 0 {
        Some((100.0 * w as f32 / b as f32, b))
    } else {
        None
    }
}

/// ApeRadar's weighted winrate (see the reference implementation in
/// ApeRadar's ApiUtils.CalcWeightedWinrate): division winrates blended by
/// battle count with fixed multipliers (solo ×5 / div2 ×2 / div3 ×1 —
/// ApeRadar's defaults). Returns the blend in percent, or None when no
/// bucket carries battles.
pub(crate) fn weighted_winrate(
    solo: Option<(f32, i64)>,
    div2: Option<(f32, i64)>,
    div3: Option<(f32, i64)>,
) -> Option<f32> {
    const SOLO_WEIGHT: f32 = 5.0;
    const DIV2_WEIGHT: f32 = 2.0;
    const DIV3_WEIGHT: f32 = 1.0;
    let mut weighted_sum = 0.0;
    let mut weight_total = 0.0;
    for (wr, battles, mult) in [
        solo.map(|(wr, b)| (wr, b, SOLO_WEIGHT)),
        div2.map(|(wr, b)| (wr, b, DIV2_WEIGHT)),
        div3.map(|(wr, b)| (wr, b, DIV3_WEIGHT)),
    ]
    .into_iter()
    .flatten()
    {
        if battles <= 0 {
            continue;
        }
        let weight = battles as f32 * mult;
        weighted_sum += wr * weight;
        weight_total += weight;
    }
    if weight_total > 0.0 {
        Some(weighted_sum / weight_total)
    } else {
        None
    }
}

/// Winrate (percent) → community PR scale. The anchors put ApeRadar's color
/// lines (47/52/56/60/65%) exactly on the standard PR boundaries
/// (750/1350/1750/2100/2450); piecewise-linear in between, clamped to 0
/// below 35% and extrapolated along the top segment above 65%. Winrate-only
/// by design: the previous damage-term formula saturated at ~40k avg damage
/// and handed even all-red accounts a green ~1600.
const WR_TO_PR_ANCHORS: [(f32, f32); 6] = [
    (35.0, 0.0),
    (47.0, 750.0),
    (52.0, 1350.0),
    (56.0, 1750.0),
    (60.0, 2100.0),
    (65.0, 2450.0),
];

pub(crate) fn rating_from_winrate(wr: f32) -> i64 {
    let lerp = |(x0, y0): (f32, f32), (x1, y1): (f32, f32)| y0 + (wr - x0) / (x1 - x0) * (y1 - y0);
    if wr <= WR_TO_PR_ANCHORS[0].0 {
        return 0;
    }
    for pair in WR_TO_PR_ANCHORS.windows(2) {
        if wr <= pair[1].0 {
            return lerp(pair[0], pair[1]).round() as i64;
        }
    }
    lerp(WR_TO_PR_ANCHORS[4], WR_TO_PR_ANCHORS[5]).round() as i64
}

/// Career PR proxy: ApeRadar's weighted winrate mapped onto the community PR
/// scale (see `rating_from_winrate`). Returns None when no input bucket
/// carries battles. This is a tier-badge score, not WG's hidden internal
/// rating.
pub(crate) fn compute_pr(
    solo: Option<(f32, i64)>,
    div2: Option<(f32, i64)>,
    div3: Option<(f32, i64)>,
) -> Option<i64> {
    Some(rating_from_winrate(weighted_winrate(solo, div2, div3)?))
}

// ── selectable PR algorithm (frontend `prAlgo` parameter) ─────────────────

/// Which PR algorithm a stats command computes. `Winrate` is the historical
/// default and must stay free of any extra work (no expected-table load, no
/// extra API calls); `Expected` is the wows-numbers personal rating computed
/// against the server-wide expected-values table (see `expected_account_pr`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PrAlgo {
    /// ApeRadar weighted winrate mapped onto the community scale (`compute_pr`).
    Winrate,
    /// wows-numbers expected-values PR (damage/frags/wins vs server averages).
    Expected,
}

impl PrAlgo {
    /// Parse the frontend parameter: only the exact string "expected" selects
    /// the expected algorithm; None, "winrate" and any unknown value keep the
    /// historical winrate behavior — a typo must degrade, never error.
    pub(crate) fn from_param(pr_algo: Option<&str>) -> Self {
        match pr_algo {
            Some("expected") => Self::Expected,
            _ => Self::Winrate,
        }
    }
}

/// One per-ship PvP (randoms) row feeding the account-level expected PR.
pub(crate) struct ExpectedPrRow {
    pub(crate) ship_id: i64,
    pub(crate) battles: i64,
    pub(crate) damage: i64,
    pub(crate) frags: i64,
    pub(crate) wins: i64,
}

/// wows-numbers personal rating from actual/expected totals. Their published
/// formula (same shape as the vendored reference in wows-toolkit's
/// `util/personal_rating.rs`): each ratio is normalized — damage (r−0.4)/0.6,
/// frags (r−0.1)/0.9, wins (r−0.7)/0.3, each floored at zero — and combined
/// as PR = 700·nDmg + 300·nFrags + 150·nWins. The offsets are calibrated so
/// playing exactly at the server average lands on 1150 (Average band).
/// Rounded to an integer and clamped to [0, 10000]. None when an expected
/// total is unusable (zero battles / missing sample).
fn expected_pr_from_totals(
    actual_damage: f64,
    actual_frags: f64,
    actual_wins: f64,
    expected_damage: f64,
    expected_frags: f64,
    expected_wins: f64,
) -> Option<i64> {
    if expected_damage <= 0.0 || expected_frags <= 0.0 || expected_wins <= 0.0 {
        return None;
    }
    let normalize = |ratio: f64, floor: f64, span: f64| ((ratio - floor) / span).max(0.0);
    let pr = 700.0 * normalize(actual_damage / expected_damage, 0.4, 0.6)
        + 300.0 * normalize(actual_frags / expected_frags, 0.1, 0.9)
        + 150.0 * normalize(actual_wins / expected_wins, 0.7, 0.3);
    Some(pr.round().clamp(0.0, 10_000.0) as i64)
}

/// One ship's wows-numbers PR: the ship's PvP totals against its expected
/// values (expected per-battle averages × battles; wins as a decimal rate —
/// expected wins = win_rate/100 × battles). None when the ship has no battles
/// (degenerate expected totals).
pub(crate) fn expected_ship_pr(
    battles: i64,
    damage: i64,
    frags: i64,
    wins: i64,
    expected: &ExpectedValues,
) -> Option<i64> {
    let battles = battles as f64;
    expected_pr_from_totals(
        damage as f64,
        frags as f64,
        wins as f64,
        expected.average_damage_dealt * battles,
        expected.average_frags * battles,
        expected.win_rate / 100.0 * battles,
    )
}

/// Account-level wows-numbers PR: per-ship totals aggregated with the
/// expected side weighted by each ship's battles — the same battle-weighted
/// aggregation wows-numbers performs (NOT a mean of per-ship PRs). Ships
/// missing from the expected table are skipped on both sides. None when no
/// ship carries expected values.
pub(crate) fn expected_account_pr(
    rows: &[ExpectedPrRow],
    table: &HashMap<i64, ExpectedValues>,
) -> Option<i64> {
    let (mut a_dmg, mut a_frags, mut a_wins) = (0.0f64, 0.0f64, 0.0f64);
    let (mut e_dmg, mut e_frags, mut e_wins) = (0.0f64, 0.0f64, 0.0f64);
    let mut counted = 0usize;
    for row in rows {
        let Some(expected) = table.get(&row.ship_id) else {
            continue; // no expected sample → skip both sides
        };
        let battles = row.battles as f64;
        a_dmg += row.damage as f64;
        a_frags += row.frags as f64;
        a_wins += row.wins as f64;
        e_dmg += expected.average_damage_dealt * battles;
        e_frags += expected.average_frags * battles;
        e_wins += expected.win_rate / 100.0 * battles;
        counted += 1;
    }
    if counted == 0 {
        return None;
    }
    expected_pr_from_totals(a_dmg, a_frags, a_wins, e_dmg, e_frags, e_wins)
}

/// Account-level expected PR for one player: the expected-values table
/// (7-day on-disk cache, downloaded on miss — see `trends::load_expected_values`)
/// plus ONE per-ship stats fetch, the same request `lookup_player_ship_stats`
/// makes, aggregated in Rust. Works for every realm including "cn" (the CN
/// vortex serves the per-ship endpoint too, so both transports behave
/// identically). None when either side is unavailable — the stats lookup
/// itself must not fail over a rating.
pub(crate) async fn account_expected_pr_for(realm: &str, account_id: i64) -> Option<i64> {
    let table = super::trends::load_expected_values().await?;
    let rows = super::ship_stats::fetch_expected_pr_rows(account_id, realm)
        .await
        .ok()?;
    expected_account_pr(&rows, &table)
}
