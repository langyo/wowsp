use std::collections::HashMap;

use super::clans::*;
use super::roster::*;
use super::shared::*;
use super::stats_math::*;
use super::trends::ExpectedValues;
use wowsp_tauri_shared::PlayerStats;

#[test]
fn parse_dog_tag_accepts_standalone_medal_shape() {
    // Live-response fixture (player 627197848, asia id 2028145456): a
    // standalone medal emblem — the patch artwork rides in symbol_id and
    // every other field is zero.
    let raw = serde_json::json!({
        "texture_id": 0,
        "symbol_id": 4238887856_u64,
        "border_color_id": 0,
        "background_color_id": 0,
        "background_id": 0
    });
    let tag = parse_dog_tag(&raw).expect("standalone medal must parse");
    assert_eq!(tag.symbol_id, 4238887856);
    assert_eq!(tag.background_id, 0);
    assert_eq!(tag.background_color, 0);
    assert_eq!(tag.border_color, 0);
}

#[test]
fn parse_dog_tag_rejects_all_zero_tag() {
    let raw = serde_json::json!({
        "texture_id": 0,
        "symbol_id": 0,
        "border_color_id": 0,
        "background_color_id": 0,
        "background_id": 0
    });
    assert!(parse_dog_tag(&raw).is_none());
}

#[test]
fn parse_dog_tag_accepts_full_custom_tag() {
    let raw = serde_json::json!({
        "texture_id": 4293282736_u64,
        "symbol_id": 4274998192_u64,
        "border_color_id": 4283911088_u64,
        "background_color_id": 4293577648_u64,
        "background_id": 4293905328_u64
    });
    assert!(parse_dog_tag(&raw).is_some());
}

#[test]
fn nickname_matches_accepts_exact_name_ignoring_case_and_padding() {
    assert!(nickname_matches("Player_2077", "Player_2077"));
    assert!(nickname_matches("player_2077", "Player_2077"));
    assert!(nickname_matches("  猎风  ", "猎风"));
    assert!(nickname_matches("Иван", "иван"));
}

#[test]
fn nickname_matches_rejects_prefix_lookalikes() {
    assert!(!nickname_matches("Player", "Player_2077"));
    assert!(!nickname_matches("Player", ""));
    assert!(!nickname_matches("", "Player"));
}

#[test]
fn pick_verified_entry_prefers_the_live_nickname_over_a_ghost() {
    // Search index shape observed in the wild: a renamed-away account
    // (ghost, id 7) still listed under its old nickname, the live
    // holder (id 9) behind it. account/info answers both accounts'
    // CURRENT nicknames — only id 9 still bears the query.
    let candidates = vec![
        AccountListEntry {
            account_id: 7,
            nickname: "Myoui_Mina".to_string(),
        },
        AccountListEntry {
            account_id: 9,
            nickname: "Myoui_Mina".to_string(),
        },
    ];
    let info = serde_json::json!({
        "7": { "nickname": "RenamedAway_2017" },
        "9": { "nickname": "myoui_mina" }
    });
    let picked = pick_verified_entry(&candidates, "Myoui_Mina", Some(&info)).unwrap();
    assert_eq!(picked.account_id, 9);
}

#[test]
fn pick_verified_entry_rejects_stale_index_without_live_match() {
    // Index fully stale: the only listed hit renamed away — its live
    // nickname proves it no longer bears the query, so "not found"
    // beats pinning a dormant ghost's profile on the row.
    let candidates = vec![AccountListEntry {
        account_id: 7,
        nickname: "Ghost".to_string(),
    }];
    let info = serde_json::json!({ "7": { "nickname": "RenamedAway" } });
    assert!(pick_verified_entry(&candidates, "Ghost", Some(&info)).is_none());
}

#[test]
fn pick_verified_entry_falls_back_to_the_first_hit_without_evidence() {
    // No info node at all (the sweep missed the id — no evidence either
    // way) → the first index hit answers, today's behavior as the
    // fallback.
    let candidates = vec![AccountListEntry {
        account_id: 7,
        nickname: "Ghost".to_string(),
    }];
    let picked = pick_verified_entry(&candidates, "Ghost", None).unwrap();
    assert_eq!(picked.account_id, 7);
}

#[test]
fn pick_verified_entry_is_none_without_candidates() {
    assert!(pick_verified_entry(&[], "Anyone", None).is_none());
}

/// Minimal [`RealmHit`] for the cross-realm decision tests — every
/// Option field stays None except the two the decision reads.
fn realm_hit(realm: &str, clan_id: Option<i64>, last_battle_time: Option<i64>) -> RealmHit {
    RealmHit {
        stats: PlayerStats {
            account_id: 42,
            name: "player".to_string(),
            realm: realm.to_string(),
            battles: None,
            winrate: None,
            hidden: false,
            clan_tag: None,
            clan_id,
            avg_damage: None,
            avg_xp: None,
            kd_ratio: None,
            survival_rate: None,
            hit_rate: None,
            pr: None,
            ships_played: None,
            leveling_tier: None,
            leveling_points: None,
            dog_tag: None,
            solo_wr: None,
            div2_wr: None,
            div3_wr: None,
            solo_battles: None,
            div2_battles: None,
            div3_battles: None,
            ranked_battles: None,
            ranked_winrate: None,
            ranked_avg_damage: None,
            ranked_pr: None,
            global_battles: None,
            global_winrate: None,
            global_avg_damage: None,
            global_pr: None,
            last_battle_time,
        },
    }
}

#[test]
fn cross_probe_realms_covers_the_wg_clusters_only() {
    // Only the WG clusters meet each other cross-server; Lesta and CN
    // run isolated account pools, and an unknown home realm probes
    // nothing rather than guessing.
    assert_eq!(
        cross_probe_realms("eu"),
        vec!["na".to_string(), "asia".to_string()]
    );
    assert_eq!(
        cross_probe_realms("na"),
        vec!["eu".to_string(), "asia".to_string()]
    );
    assert_eq!(
        cross_probe_realms("asia"),
        vec!["eu".to_string(), "na".to_string()]
    );
    assert!(cross_probe_realms("ru").is_empty());
    assert!(cross_probe_realms("cn").is_empty());
    assert!(cross_probe_realms("unknown").is_empty());
}

#[test]
fn pick_cross_realm_hit_adopts_a_lone_hit_without_evidence() {
    // The common case: the exact nickname exists on exactly one of the
    // probed clusters — nothing to arbitrate, clan/lbt need not apply.
    let hit = pick_cross_realm_hit(1_000_000, vec![realm_hit("eu", None, None)])
        .expect("a lone verified hit is adopted");
    assert_eq!(hit.stats.realm, "eu");
}

#[test]
fn pick_cross_realm_hit_drops_clanless_namesakes() {
    // CW rosters are clan teams: when any hit is clanned, a clanless
    // exact-name holder on another cluster is a namesake.
    let hit = pick_cross_realm_hit(
        1_000_000,
        vec![
            realm_hit("eu", None, None),
            realm_hit("na", Some(500_001), None),
        ],
    )
    .expect("the clanned hit wins without further evidence");
    assert_eq!(hit.stats.realm, "na");
}

#[test]
fn pick_cross_realm_hit_prefers_the_account_playing_right_now() {
    // The roster player is mid-battle; their previous battle ended
    // within the session, a foreign namesake's ended days ago.
    let now = 1_000_000;
    let hit = pick_cross_realm_hit(
        now,
        vec![
            realm_hit("eu", Some(1), Some(now - 40 * 60)),
            realm_hit("na", Some(2), Some(now - 90 * 24 * 3600)),
        ],
    )
    .expect("the strictly-newer in-window stamp wins");
    assert_eq!(hit.stats.realm, "eu");
}

#[test]
fn pick_cross_realm_hit_rejects_true_ties() {
    let now = 1_000_000;
    // Two clanned hits, neither with a recent stamp: no evidence
    // separates them — None beats a coin flip between strangers.
    assert!(
        pick_cross_realm_hit(
            now,
            vec![
                realm_hit("eu", Some(1), None),
                realm_hit("na", Some(2), None),
            ],
        )
        .is_none()
    );
    // Identical fresh stamps are just as tied.
    assert!(
        pick_cross_realm_hit(
            now,
            vec![
                realm_hit("eu", Some(1), Some(now - 60)),
                realm_hit("na", Some(2), Some(now - 60)),
            ],
        )
        .is_none()
    );
    // A STALE stamp is no evidence at all — it must not beat a
    // stamp-less candidate into a fake win.
    assert!(
        pick_cross_realm_hit(
            now,
            vec![
                realm_hit("eu", Some(1), Some(now - 90 * 24 * 3600)),
                realm_hit("na", Some(2), None),
            ],
        )
        .is_none()
    );
    // Nothing to decide over.
    assert!(pick_cross_realm_hit(now, Vec::new()).is_none());
}

#[test]
fn pvp_stats_extracts_all_fields() {
    // Mirrors the real WG account/info response shape: the top-level is
    // "statistics", with "pvp" as a child. Damage is "damage_dealt" (WG
    // renamed it from "damage_caused"). Main battery shots/hits are nested
    // under a "main_battery" sub-object. Division splits are siblings of
    // "pvp" under "statistics" (pvp_solo / pvp_div2 / pvp_div3).
    let raw = serde_json::json!({
        "pvp": {
            "battles": 1000,
            "wins": 550,
            "damage_dealt": 1_500_000,
            "xp": 1_200_000,
            "frags": 800,
            "survived_battles": 300,
            "main_battery": { "shots": 5000, "hits": 1500 }
        },
        "pvp_solo": { "battles": 600, "wins": 330 },
        "pvp_div2": { "battles": 200, "wins": 110 },
        "pvp_div3": { "battles": 200, "wins": 110 }
    });
    let p = PvpStats::extract(Some(&raw));
    assert_eq!(p.battles, Some(1000));
    assert_eq!(p.winrate, Some(55.0));
    assert_eq!(p.avg_damage, Some(1500.0));
    assert_eq!(p.avg_xp, Some(1200.0));
    // 800 frags / 700 deaths ≈ 1.143
    assert!((p.kd_ratio.unwrap() - 1.143).abs() < 0.01);
    assert_eq!(p.survival_rate, Some(30.0));
    assert_eq!(p.hit_rate, Some(30.0));
    assert_eq!(p.solo_wr, Some(55.0));
    assert_eq!(p.div2_wr, Some(55.0));
    assert_eq!(p.div3_wr, Some(55.0));
    assert_eq!(p.solo_battles, Some(600));
    assert_eq!(p.div2_battles, Some(200));
    assert_eq!(p.div3_battles, Some(200));
    assert!(p.pr.is_some());
}

#[test]
fn pvp_stats_empty_when_null() {
    let raw = serde_json::json!({ "pvp": null });
    let p = PvpStats::extract(Some(&raw));
    assert_eq!(p.battles, None);
    assert_eq!(p.winrate, None);
    assert_eq!(p.pr, None);
    assert_eq!(p.solo_battles, None);
}

#[test]
fn pvp_stats_empty_when_no_statistics_node() {
    let p = PvpStats::extract(None);
    assert_eq!(p.battles, None);
    assert_eq!(p.ranked.battles, None);
}

/// Ranked career extraction off the WG rank_solo/div2/div3 extras: the
/// splits sum into battles / winrate / avg damage, and the PR blends the
/// splits that carry battles.
#[test]
fn ranked_stats_sum_the_wg_rank_splits() {
    let node = serde_json::json!({
        "pvp": { "battles": 5000, "wins": 2500, "damage_dealt": 250_000_000 },
        "rank_solo": { "battles": 80, "wins": 40, "damage_dealt": 4_000_000 },
        "rank_div2": { "battles": 20, "wins": 10, "damage_dealt": 2_000_000 },
        "rank_div3": null
    });
    let p = PvpStats::extract(Some(&node));
    let r = p.ranked;
    assert_eq!(r.battles, Some(100));
    assert!((r.winrate.unwrap() - 50.0).abs() < 0.01);
    assert!((r.avg_damage.unwrap() - 60_000.0).abs() < 1.0);
    assert!(r.pr.is_some());
    // The overall pvp numbers stay untouched by the ranked splits.
    assert_eq!(p.battles, Some(5000));
}

/// A never-ranked account (null splits) answers all-None — an absent
/// mode must not render as a 0% ranked record.
#[test]
fn ranked_stats_absent_splits_stay_none() {
    let node = serde_json::json!({
        "pvp": { "battles": 5000, "wins": 2500, "damage_dealt": 250_000_000 }
    });
    let p = PvpStats::extract(Some(&node));
    assert_eq!(p.ranked.battles, None);
    assert_eq!(p.ranked.winrate, None);
    assert_eq!(p.ranked.avg_damage, None);
    assert_eq!(p.ranked.pr, None);
}

/// The CN shape: no rank_* splits, ranked lives in the seasons tree
/// (already vortex-normalized into WG field names) and sums across
/// seasons and ship types.
#[test]
fn ranked_stats_sum_the_cn_seasons_tree() {
    let node = serde_json::json!({
        "pvp": { "battles": 100, "wins": 50, "damage_dealt": 5_000_000 },
        "seasons": {
            "1024": { "0": { "rank_solo": { "battles": 6, "wins": 4, "damage_dealt": 300_000 } } },
            "1022": {
                "0": {
                    "rank_solo": { "battles": 10, "wins": 5, "damage_dealt": 500_000 },
                    "rank_div3": { "battles": 2, "wins": 1, "damage_dealt": 150_000 }
                },
                "1": { "rank_solo": { "battles": 2, "wins": 2, "damage_dealt": 160_000 } }
            },
            // an unplayed season's empty mode node — skipped, not zeroed
            "1002": { "0": { "rank_solo": {} } }
        }
    });
    let p = PvpStats::extract(Some(&node));
    let r = p.ranked;
    assert_eq!(r.battles, Some(20));
    assert_eq!(r.winrate, Some(60.0));
    assert!((r.avg_damage.unwrap() - 55_500.0).abs() < 1.0);
    assert!(r.pr.is_some());
}

/// An account with ranked battles but NO random battles: the null pvp
/// node must not take the ranked counters down with it.
#[test]
fn ranked_stats_survive_a_null_pvp_node() {
    let node = serde_json::json!({
        "pvp": null,
        "rank_solo": { "battles": 30, "wins": 15, "damage_dealt": 900_000 }
    });
    let p = PvpStats::extract(Some(&node));
    assert_eq!(p.battles, None);
    assert_eq!(p.ranked.battles, Some(30));
    assert_eq!(p.ranked.winrate, Some(50.0));
}

#[test]
fn batch_expected_algo_nulls_ranked_and_global_pr() {
    // The winrate-proxy rated modes (ranked / global) sit out under the
    // expected algorithm too — never a different school on one card.
    let mut stats = serde_json::from_value::<PlayerStats>(serde_json::json!({
        "accountId": 42, "name": "player", "realm": "eu", "hidden": false,
        "pr": 2_100, "rankedPr": 1_890, "globalPr": 2_050,
    }))
    .expect("PlayerStats parses with optional fields absent");
    apply_batch_pr_algo(&mut stats, PrAlgo::Expected);
    assert_eq!(stats.pr, None);
    assert_eq!(stats.ranked_pr, None);
    assert_eq!(stats.global_pr, None);
}

#[test]
fn compute_pr_returns_none_for_missing_inputs() {
    assert_eq!(compute_pr(None, None, None), None);
    // A bucket with zero battles carries no weight.
    assert_eq!(compute_pr(Some((55.0, 0)), None, None), None);
    assert!(compute_pr(Some((55.0, 100)), None, None).is_some());
}

#[test]
fn global_career_of_merges_both_modes() {
    // 3000 randoms battles @ 48% wr / 90k avg + 1000 ranked @ 60% / 60k.
    let pvp = Some((3_000i64, 1_440i64, 270_000_000i64));
    let ranked = CareerModeStats {
        battles: Some(1_000),
        winrate: Some(60.0),
        avg_damage: Some(60_000.0),
        pr: Some(2_100),
    };
    let g = global_career_of(pvp, [None, None, None], ranked, [(0, 0, 0); 3]);
    assert_eq!(g.battles, Some(4_000));
    // Battles-weighted means: (48·3000 + 60·1000)/4000 = 51.
    assert!((g.winrate.unwrap() - 51.0).abs() < 0.01);
    assert!((g.avg_damage.unwrap() - 82_500.0).abs() < 1.0);
    // No split detail on either side → the blended overall winrate
    // carries the rating (51% lands between the 47% and 52% anchors).
    assert!(g.pr.unwrap() > 750 && g.pr.unwrap() < 1_350);
}

#[test]
fn global_career_of_handles_absent_sides() {
    // Never played ranked: the global view IS the randoms career.
    let pvp = Some((2_000i64, 1_000i64, 100_000_000i64));
    let g = global_career_of(
        pvp,
        [None, None, None],
        CareerModeStats::default(),
        [(0, 0, 0); 3],
    );
    assert_eq!(g.battles, Some(2_000));
    assert!((g.winrate.unwrap() - 50.0).abs() < 0.01);
    // Null pvp node (randoms never played): the global view IS ranked.
    let ranked = CareerModeStats {
        battles: Some(500),
        winrate: Some(55.0),
        avg_damage: Some(70_000.0),
        pr: Some(1_800),
    };
    let g = global_career_of(None, [None, None, None], ranked, [(0, 0, 0); 3]);
    assert_eq!(g.battles, Some(500));
    assert_eq!(g.winrate, Some(55.0));
    // Hidden profile: both sides absent → all-None.
    let g = global_career_of(
        None,
        [None, None, None],
        CareerModeStats::default(),
        [(0, 0, 0); 3],
    );
    assert_eq!(g.battles, None);
    assert_eq!(g.pr, None);
}

#[test]
fn rating_from_winrate_lands_on_aperadar_color_lines() {
    assert_eq!(rating_from_winrate(30.0), 0);
    assert_eq!(rating_from_winrate(35.0), 0);
    assert_eq!(rating_from_winrate(47.0), 750);
    assert_eq!(rating_from_winrate(52.0), 1350);
    assert_eq!(rating_from_winrate(56.0), 1750);
    assert_eq!(rating_from_winrate(60.0), 2100);
    assert_eq!(rating_from_winrate(65.0), 2450);
    // All-red accounts must stay red — the old damage-term formula
    // scored them ~1600 (green).
    assert_eq!(rating_from_winrate(40.0), 313);
    assert!(rating_from_winrate(45.0) < 750);
    // Monotonic, with extrapolation above the top anchor.
    assert!(rating_from_winrate(66.0) > 2450);
    assert!(rating_from_winrate(100.0) > rating_from_winrate(90.0));
}

#[test]
fn weighted_winrate_blends_divisions_by_battle_count() {
    // ApeRadar defaults: solo ×5, div2 ×2, div3 ×1.
    let wr = weighted_winrate(Some((50.0, 1000)), Some((60.0, 100)), None).unwrap();
    assert!((wr - 50.3846).abs() < 0.001);
    assert!(weighted_winrate(None, None, None).is_none());
    // Zero-battle buckets carry no weight.
    let wr = weighted_winrate(Some((50.0, 0)), Some((60.0, 10)), None).unwrap();
    assert!((wr - 60.0).abs() < 1e-4);
}

#[test]
fn player_stats_from_info_builds_visible_profile() {
    let info = serde_json::json!({
        "2024711808": {
            "statistics": {
                "pvp": { "battles": 1000, "wins": 550, "damage_dealt": 1_500_000 },
                "pvp_solo": { "battles": 600, "wins": 330 }
            },
            "leveling_tier": 12,
            "leveling_points": 3400
        }
    });
    let clan_map = HashMap::from([(
        2024711808i64,
        ClanTagInfo {
            tag: "FOO".to_string(),
            clan_id: Some(500123),
        },
    )]);
    let entry = AccountListEntry {
        account_id: 2024711808,
        nickname: "langyo".to_string(),
    };
    let s = player_stats_from_info(entry, "asia".to_string(), Some(&info), &clan_map);
    assert_eq!(s.name, "langyo");
    assert_eq!(s.winrate, Some(55.0));
    assert!(!s.hidden);
    assert_eq!(s.clan_tag.as_deref(), Some("FOO"));
    assert_eq!(s.clan_id, Some(500123));
    assert_eq!(s.leveling_tier, Some(12));
    assert_eq!(s.avg_damage, Some(1500.0));
    assert!(s.pr.is_some());
    // Batch path never pays for Vortex dog tags.
    assert!(s.dog_tag.is_none());
}

#[test]
fn player_stats_from_info_marks_missing_stats_hidden() {
    // A null player node (id absent from the batch info map) counts as a
    // hidden profile — same rule as the single lookup.
    let entry = AccountListEntry {
        account_id: 7,
        nickname: "ghost".to_string(),
    };
    let s = player_stats_from_info(entry, "eu".to_string(), None, &HashMap::new());
    assert!(s.hidden);
    assert_eq!(s.winrate, None);
    assert_eq!(s.clan_tag, None);
    assert_eq!(s.clan_id, None);
}

#[test]
fn encode_query_leaves_unreserved_alone_and_encodes_structural_chars() {
    assert_eq!(encode_query("Black&White"), "Black%26White");
    assert_eq!(encode_query("a#b"), "a%23b");
    assert_eq!(encode_query("a+b"), "a%2Bb");
    assert_eq!(encode_query("a b"), "a%20b");
    assert_eq!(encode_query("Az-09_.~"), "Az-09_.~");
    // Percent-encoding is byte-based: multi-byte UTF-8 encodes per byte.
    assert_eq!(encode_query("公会"), "%E5%85%AC%E4%BC%9A");
}

#[test]
fn clan_list_entry_parses_wg_shape() {
    let raw = serde_json::json!([{
        "clan_id": 500123,
        "tag": "HOOD",
        "name": "Honored Order Of Death",
        "members_count": 42
    }]);
    let list: Vec<ClanListEntry> = serde_json::from_value(raw).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].clan_id, 500123);
    assert_eq!(list[0].members_count, Some(42));
}

#[test]
fn clan_list_entry_tolerates_missing_members_count() {
    let raw = serde_json::json!([{ "clan_id": 1, "tag": "A", "name": "Alpha" }]);
    let list: Vec<ClanListEntry> = serde_json::from_value(raw).unwrap();
    assert_eq!(list[0].members_count, None);
}

#[test]
fn clan_info_from_response_assembles_roster_and_aggregates() {
    // Mirrors the real clans/info (extra=members) + batched account/info
    // shapes: members carries role/joined_at keyed by id; the roster
    // carries nickname + statistics.pvp per id.
    let clan_node = serde_json::json!({
        "tag": "HOOD",
        "name": "Honored Order Of Death",
        "members_count": 2,
        "created_at": 1_600_000_000,
        "description": "test clan",
        "members_ids": [11, 22],
        "members": {
            "11": { "role": "commander", "joined_at": 1_600_000_001 },
            "22": { "role": "private", "joined_at": 1_600_000_002 }
        }
    });
    let roster = serde_json::json!({
        "11": {
            "nickname": "alpha",
            "statistics": { "pvp": { "battles": 100, "wins": 60, "damage_dealt": 150_000 } }
        },
        "22": { "nickname": "ghost", "statistics": { "pvp": null } }
    });
    let info = clan_info_from_response(500123, "asia", &clan_node, &roster, PrAlgo::Winrate);
    assert_eq!(info.tag, "HOOD");
    assert_eq!(info.realm, "asia");
    assert_eq!(info.members_count, 2);
    assert_eq!(info.created_at, Some(1_600_000_000));
    assert_eq!(info.description.as_deref(), Some("test clan"));
    assert_eq!(info.members.len(), 2);
    // Aggregates only count the visible member.
    assert_eq!(info.total_battles, 100);
    assert_eq!(info.total_wins, 60);
    assert!((info.winrate - 60.0).abs() < 0.01);
    assert!((info.avg_damage - 1500.0).abs() < 0.01);
    assert_eq!(info.hidden_count, 1);
    // Deep stats: the fixture's 60% WR has no division splits, so the
    // overall winrate maps through as the solo bucket → 2100 on the
    // ApeRadar-aligned scale; xp/frags/survival absent → None.
    assert_eq!(info.avg_pr, Some(2100));
    let commander = info.members.iter().find(|m| m.account_id == 11).unwrap();
    assert_eq!(commander.name, "alpha");
    assert_eq!(commander.role, "commander");
    assert_eq!(commander.joined_at, Some(1_600_000_001));
    assert_eq!(commander.stats.winrate, Some(60.0));
    assert_eq!(commander.stats.pr, Some(2100));
    assert_eq!(commander.stats.avg_xp, None);
    assert_eq!(commander.stats.kd_ratio, None);
    assert_eq!(commander.stats.survival_rate, None);
    let ghost = info.members.iter().find(|m| m.account_id == 22).unwrap();
    assert!(ghost.stats.hidden);
    assert_eq!(ghost.stats.battles, None);
}

#[test]
fn clan_roster_pr_uses_weighted_division_splits() {
    // Regression: the roster batch account/info must request the
    // extra-gated division splits so roster PR blends them like the
    // player card instead of degrading to the overall-WR fallback
    // (which made the clan page disagree with the player's own page).
    let clan_node = serde_json::json!({
        "tag": "W",
        "name": "Weighted",
        "members_count": 1,
        "members_ids": [11]
    });
    // solo 48%/5000, div2 58%/1000, div3 60%/500 → overall 50.54% but
    // weighted (×5/×2/×1) ≈48.95% → PR 983, not the 1175 the overall
    // fallback would print.
    let roster = serde_json::json!({
        "11": {
            "nickname": "alpha",
            "statistics": {
                "pvp": { "battles": 6500, "wins": 3285, "damage_dealt": 130_000_000 },
                "pvp_solo": { "battles": 5000, "wins": 2400 },
                "pvp_div2": { "battles": 1000, "wins": 580 },
                "pvp_div3": { "battles": 500, "wins": 300 }
            }
        }
    });
    let info = clan_info_from_response(9, "eu", &clan_node, &roster, PrAlgo::Winrate);
    let member = &info.members[0];
    assert!((member.stats.winrate.unwrap() - 50.538).abs() < 0.01);
    assert_eq!(member.stats.pr, Some(983));
    assert_ne!(member.stats.pr, Some(1175));
    assert_eq!(info.avg_pr, Some(983));
}

#[test]
fn clan_info_falls_back_to_members_ids_without_extra() {
    // Without extra=members the roles default to private and missing
    // roster entries fall back to "#id" names instead of failing.
    let clan_node = serde_json::json!({
        "tag": "B",
        "name": "Beta",
        "members_count": 1,
        "members_ids": [33]
    });
    let info =
        clan_info_from_response(7, "eu", &clan_node, &serde_json::json!({}), PrAlgo::Winrate);
    assert_eq!(info.members.len(), 1);
    assert_eq!(info.members[0].name, "#33");
    assert_eq!(info.members[0].role, "private");
    assert!(info.members[0].stats.hidden);
    assert_eq!(info.winrate, 0.0);
    assert_eq!(info.avg_damage, 0.0);
    assert_eq!(info.avg_pr, None);
}

#[test]
fn decode_wg_text_decodes_entities_and_normalizes_whitespace() {
    // The exact artifact from the bug report: WG double-writes quotes
    // around section names in clan descriptions.
    assert_eq!(
        decode_wg_text("&quot; OBJECTIVE&quot;* HAVE FUN"),
        "\u{22} OBJECTIVE\u{22}* HAVE FUN"
    );
    // Named table + decimal + hex numeric references.
    assert_eq!(
        decode_wg_text("a&amp;b&lt;c&gt;d&#39;e&#x27;"),
        "a&b<c>d'e'"
    );
    // nbsp keeps its non-breaking character.
    assert_eq!(decode_wg_text("x&nbsp;y"), "x\u{00a0}y");
    // Single pass: `&amp;quot;` must stay `&quot;` (no double decode).
    assert_eq!(decode_wg_text("&amp;quot;"), "&quot;");
    // Unknown named entity, bare '&', and malformed numeric pass through.
    assert_eq!(decode_wg_text("&frobnicate;"), "&frobnicate;");
    assert_eq!(decode_wg_text("100% & more"), "100% & more");
    assert_eq!(decode_wg_text("&#; &#xZZ;"), "&#; &#xZZ;");
    // Out-of-range numeric reference stays literal.
    assert_eq!(decode_wg_text("&#999999999999;"), "&#999999999999;");
    // Numeric control refs decode (WG uses &#10; for line breaks).
    assert_eq!(decode_wg_text("a&#10;b"), "a\nb");
    // CRLF/CR collapse to LF, tabs to spaces.
    assert_eq!(decode_wg_text("a\r\nb\rc\td"), "a\nb\nc d");
    // Multi-byte text passes through untouched.
    assert_eq!(decode_wg_text("公会招人"), "公会招人");
    // Regression: a bare '&' whose 10-byte entity window would end
    // inside a multi-byte char must clamp, not panic.
    assert_eq!(decode_wg_text("R&D部门招聘"), "R&D部门招聘");
    assert_eq!(decode_wg_text("&éééééé"), "&éééééé");
    // A real entity followed by multi-byte text still decodes when the
    // window gets clamped shorter than MAX_ENTITY.
    assert_eq!(decode_wg_text("&quot;公会"), "\"公会");
}

#[test]
fn clan_info_from_response_decodes_description_entities() {
    // The clans/info description arrives HTML-escaped from WG; the
    // assembled ClanInfo must carry display-ready text.
    let clan_node = serde_json::json!({
        "tag": "HOOD",
        "name": "Hood Detonation Boom Boom Boom",
        "members_count": 1,
        "members_ids": [11],
        "description": "&quot; OBJECTIVE&quot;* HAVE FUN,\r\nClan QQ:123"
    });
    let info = clan_info_from_response(
        500123,
        "asia",
        &clan_node,
        &serde_json::json!({}),
        PrAlgo::Winrate,
    );
    assert_eq!(
        info.description.as_deref(),
        Some("\" OBJECTIVE\"* HAVE FUN,\nClan QQ:123")
    );
}

// ── expected-values PR (wows-numbers algorithm) ───────────────────────

#[test]
fn pr_algo_param_defaults_and_unknown_values_fall_back_to_winrate() {
    assert_eq!(PrAlgo::from_param(None), PrAlgo::Winrate);
    assert_eq!(PrAlgo::from_param(Some("winrate")), PrAlgo::Winrate);
    assert_eq!(PrAlgo::from_param(Some("")), PrAlgo::Winrate);
    assert_eq!(PrAlgo::from_param(Some("nonsense")), PrAlgo::Winrate);
    // Exact match only — a case typo degrades to winrate, never errors.
    assert_eq!(PrAlgo::from_param(Some("Expected")), PrAlgo::Winrate);
    assert_eq!(PrAlgo::from_param(Some("expected")), PrAlgo::Expected);
}

fn ev(dmg: f64, frags: f64, win_rate: f64) -> ExpectedValues {
    ExpectedValues {
        average_damage_dealt: dmg,
        average_frags: frags,
        win_rate,
    }
}

#[test]
fn expected_ship_pr_matches_wows_numbers_formula() {
    // Small expected profile: 50k damage, 1.0 frags, 52% WR. Actual: 100
    // battles, 6M damage, 120 frags, 56 wins.
    //   rDmg   = 1.2      → nDmg   = (1.2−0.4)/0.6 = 1.3333…
    //   rFrags = 1.2      → nFrags = (1.2−0.1)/0.9 = 1.2222…
    //   rWins  = .56/.52  → nWins  = 1.2564…
    //   PR = 700·1.3333 + 300·1.2222 + 150·1.2564 ≈ 1488.46 → 1488.
    let e = ev(50_000.0, 1.0, 52.0);
    assert_eq!(expected_ship_pr(100, 6_000_000, 120, 56, &e), Some(1488));
    // Playing exactly at the server average lands on 1150 (Average band)
    // — the anchor the normalization constants are calibrated for.
    assert_eq!(expected_ship_pr(100, 5_000_000, 100, 52, &e), Some(1150));
}

#[test]
fn expected_ship_pr_clamps_to_bounds() {
    let e = ev(50_000.0, 1.0, 52.0);
    // All-zero counters floor every normalized term at zero.
    assert_eq!(expected_ship_pr(100, 0, 0, 0, &e), Some(0));
    // Absurd performance clamps at the 10000 cap.
    assert_eq!(
        expected_ship_pr(100, 6_000_000_000, 20_000, 100, &e),
        Some(10_000)
    );
    // No battles → degenerate expected totals → no rating.
    assert_eq!(expected_ship_pr(0, 0, 0, 0, &e), None);
}

#[test]
fn expected_account_pr_aggregates_by_battles() {
    let table = HashMap::from([(1, ev(40_000.0, 0.8, 50.0)), (2, ev(80_000.0, 1.6, 54.0))]);
    // Ship 1 (100 battles) exactly at expected; ship 2 (300 battles) at
    // double the expected damage/frags with a 100% winrate; ship 3 is not
    // in the table and must count on neither side.
    let rows = [
        ExpectedPrRow {
            ship_id: 1,
            battles: 100,
            damage: 4_000_000,
            frags: 80,
            wins: 50,
        },
        ExpectedPrRow {
            ship_id: 2,
            battles: 300,
            damage: 48_000_000,
            frags: 960,
            wins: 300,
        },
        ExpectedPrRow {
            ship_id: 3,
            battles: 1_000,
            damage: 500_000_000,
            frags: 5_000,
            wins: 900,
        },
    ];
    // Totals: damage 52M vs 28M and frags 1040 vs 560 (ratio 13/7),
    // wins 350 vs 212.
    //   nDmg   = (13/7−0.4)/0.6 = 2.4286…   → 700·2.4286 = 1700.0
    //   nFrags = (13/7−0.1)/0.9 = 1.9524…   → 300·1.9524 =  585.7
    //   nWins  = (350/212−0.7)/0.3 = 3.1698 → 150·3.1698 =  475.5
    //   PR ≈ 2761.19 → 2761.
    assert_eq!(expected_account_pr(&rows, &table), Some(2761));
    // Same per-ship performances with the battle mix flipped (300/100)
    // must yield a different PR — the aggregation is battle-weighted over
    // the counters, not a mean of per-ship PRs.
    let flipped = [
        ExpectedPrRow {
            ship_id: 1,
            battles: 300,
            damage: 12_000_000,
            frags: 240,
            wins: 150,
        },
        ExpectedPrRow {
            ship_id: 2,
            battles: 100,
            damage: 16_000_000,
            frags: 320,
            wins: 100,
        },
        ExpectedPrRow {
            ship_id: 3,
            battles: 1_000,
            damage: 500_000_000,
            frags: 5_000,
            wins: 900,
        },
    ];
    // rDmg = rFrags = 28M/20M = 1.4, rWins = 250/204:
    //   700·(1.4−0.4)/0.6 + 300·(1.4−0.1)/0.9 + 150·(250/204−0.7)/0.3
    //   = 1166.67 + 433.33 + 262.75 ≈ 1862.75 → 1863.
    assert_eq!(expected_account_pr(&flipped, &table), Some(1863));
    // Every ship at its expected values (any battle mix) → 1150; ships
    // missing from the table alone → None.
    let at_expected = [
        ExpectedPrRow {
            ship_id: 1,
            battles: 100,
            damage: 4_000_000,
            frags: 80,
            wins: 50,
        },
        ExpectedPrRow {
            ship_id: 2,
            battles: 50,
            damage: 4_000_000,
            frags: 80,
            wins: 27,
        },
    ];
    assert_eq!(expected_account_pr(&at_expected, &table), Some(1150));
    let unrated = [ExpectedPrRow {
        ship_id: 3,
        battles: 100,
        damage: 1,
        frags: 1,
        wins: 1,
    }];
    assert_eq!(expected_account_pr(&unrated, &table), None);
    assert_eq!(expected_account_pr(&[], &table), None);
}

#[test]
fn clan_roster_expected_algo_yields_no_pr() {
    // The roster cannot afford per-member ships/stats fetches, so the
    // expected algorithm answers None instead of a winrate proxy.
    let clan_node = serde_json::json!({
        "tag": "E", "name": "Expected", "members_count": 1, "members_ids": [11]
    });
    let roster = serde_json::json!({
        "11": {
            "nickname": "alpha",
            "statistics": { "pvp": { "battles": 100, "wins": 60, "damage_dealt": 150_000 } }
        }
    });
    let info = clan_info_from_response(500123, "eu", &clan_node, &roster, PrAlgo::Expected);
    assert_eq!(info.members[0].stats.pr, None);
    assert_eq!(info.avg_pr, None);
    // The default algorithm keeps the historical winrate PR.
    let info = clan_info_from_response(500123, "eu", &clan_node, &roster, PrAlgo::Winrate);
    assert_eq!(info.members[0].stats.pr, Some(2100));
}

/// Minimal `PlayerStats` for the batch-policy test — Option fields are
/// absent from the JSON (serde reads them as None), only the required
/// primitives are supplied.
fn batch_player(pr: Option<i64>) -> PlayerStats {
    serde_json::from_value(serde_json::json!({
        "accountId": 42, "name": "player", "realm": "eu", "hidden": false, "pr": pr,
    }))
    .expect("PlayerStats parses with optional fields absent")
}

#[test]
fn batch_roster_expected_algo_yields_no_pr() {
    // The live-roster fast path cannot afford one ships/stats fetch per
    // roster row (see `apply_batch_pr_algo`), so the expected algorithm
    // blanks the PR instead of answering a winrate proxy.
    let mut stats = batch_player(Some(2100));
    apply_batch_pr_algo(&mut stats, PrAlgo::Winrate);
    assert_eq!(stats.pr, Some(2100));
    apply_batch_pr_algo(&mut stats, PrAlgo::Expected);
    assert_eq!(stats.pr, None);
    // A profile that already had no PR (hidden) stays PR-less under both
    // algorithms — the policy never invents a rating.
    let mut hidden = batch_player(None);
    apply_batch_pr_algo(&mut hidden, PrAlgo::Winrate);
    assert_eq!(hidden.pr, None);
}
