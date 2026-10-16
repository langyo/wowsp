//! The wanted-ruleset matcher — a Rust mirror of relay-core's pure policy
//! (contract §1): absent or empty array/None = "any" for that dimension,
//! `clientVersionMin` compares dot-numeric, and a rule is OPEN only while
//! the watermark accepts and the rule's collected count stays under its
//! cap. Kept pure (facts + doc in, verdict out) so the planner and the
//! pipeline share one deterministic precedence with the server.

use std::collections::HashSet;

use wowsp_tauri_shared::{ContributionVerdict, ReplayFacts, WantedDoc, WantedRule, Watermark};

/// Dot-numeric version compare: `a >= b` component-wise, missing
/// components counting as 0 (`14.5.0` ≥ `14.0`, `14` ≥ `13.9.9`,
/// `14.0.1` < `14.1`). Non-numeric segments parse as 0 so a malformed
/// claim can never crash the matcher — it just fails an honest bound.
pub(super) fn version_ge(a: &str, b: &str) -> bool {
    let nums = |s: &str| {
        s.split('.')
            .map(|part| part.trim().parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    let (mut a, mut b) = (nums(a), nums(b));
    let n = a.len().max(b.len());
    a.resize(n, 0);
    b.resize(n, 0);
    a >= b
}

/// Whether ONE rule's acceptance criteria all hold for the claimed facts.
/// Exact string equality per dimension (realms are canonical lowercase,
/// modes are the canonical match-group keys, maps are the client's
/// `mapDisplayName` spelling — the same string the replay list filter
/// keys on); a facts field of `None` fails every non-"any" constraint
/// that would need it (an unparseable header cannot prove a match).
pub(super) fn rule_matches(rule: &WantedRule, facts: &ReplayFacts) -> bool {
    // A "claim" is a non-empty value: required strings default to "" when
    // unknown, which must satisfy no non-"any" constraint.
    fn claim(value: &str) -> Option<&str> {
        (!value.is_empty()).then_some(value)
    }
    let any_or_has = |dim: &[String], claimed: Option<&str>| match claimed {
        Some(value) => dim.is_empty() || dim.iter().any(|m| m == value),
        // The dimension constrains, but the claim cannot testify.
        None => dim.is_empty(),
    };
    if !any_or_has(&rule.maps, claim(&facts.core.map)) {
        return false;
    }
    if !any_or_has(&rule.modes, claim(&facts.core.mode)) {
        return false;
    }
    if !any_or_has(&rule.scenarios, facts.core.scenario.as_deref()) {
        return false;
    }
    if !any_or_has(&rule.realms, claim(&facts.core.realm)) {
        return false;
    }
    if !any_or_has(&rule.ship_classes, facts.core.ship_class.as_deref()) {
        return false;
    }
    // Numeric dimensions: an absent claim only satisfies an absent bound
    // (ownShipId 0 is the header parse's "no ship" default, i.e. no claim).
    let own_ship = (facts.core.own_ship_id > 0).then_some(facts.core.own_ship_id);
    match own_ship {
        Some(ship) if !rule.ship_ids.is_empty() => {
            if !rule.ship_ids.contains(&(ship as i64)) {
                return false;
            }
        },
        None if !rule.ship_ids.is_empty() => return false,
        _ => {},
    }
    match facts.core.tier {
        Some(tier) if !rule.tiers.is_empty() => {
            if !rule.tiers.contains(&tier) {
                return false;
            }
        },
        None if !rule.tiers.is_empty() => return false,
        _ => {},
    }
    if let Some(min) = rule.player_count_min {
        if facts.core.player_count < min {
            return false;
        }
    }
    if let Some(max) = rule.player_count_max {
        if facts.core.player_count > max {
            return false;
        }
    }
    if let Some(bot_max) = rule.bot_max {
        if facts.core.bot_count > bot_max {
            return false;
        }
    }
    if let Some(min) = rule.client_version_min.as_deref() {
        // An empty (unparsed) version cannot satisfy a bound.
        if facts.core.client_version.is_empty() || !version_ge(&facts.core.client_version, min) {
            return false;
        }
    }
    true
}

/// Whether a rule still has room: `collected < maxCount` (absent cap =
/// unlimited). Drain never reopens a closed rule, so `collected` only
/// ever grows.
pub(super) fn rule_open(rule: &WantedRule, watermark: &Watermark) -> bool {
    watermark.accepting && rule.max_count.is_none_or(|max| rule.collected < max)
}

/// The first OPEN rule (document order — the same scan the relay's
/// `/check` walks) whose criteria match the facts, or `None`.
pub(super) fn matching_open_rule<'a>(
    doc: &'a WantedDoc,
    facts: &ReplayFacts,
) -> Option<&'a WantedRule> {
    doc.rules
        .iter()
        .find(|rule| rule_open(rule, &doc.watermark) && rule_matches(rule, facts))
}

/// The client-side verdict merge (contract §4 precedence, mirrored):
/// `duplicate` (hash in the local known-hash cache — already uploaded or
/// already drained) > `own_staged` (hash in the cached `/mine` set) >
/// `accept` (≥1 open rule matches) > `unwanted`. Returns the verdict and
/// the matching rule id for `accept` (None otherwise).
///
/// `known_hashes` / `mine_hashes` are the LOCAL caches (membership only),
/// so a plan taken offline can disagree with the server — the pipeline
/// always re-checks through `POST /check` before packing anything.
pub(super) fn merge_verdict(
    facts: &ReplayFacts,
    known_hashes: &HashSet<String>,
    mine_hashes: &HashSet<String>,
    wanted: &WantedDoc,
) -> (ContributionVerdict, Option<String>) {
    if known_hashes.contains(&facts.sha256) {
        return (ContributionVerdict::Duplicate, None);
    }
    if mine_hashes.contains(&facts.sha256) {
        return (ContributionVerdict::OwnStaged, None);
    }
    match matching_open_rule(wanted, facts) {
        Some(rule) => (ContributionVerdict::Accept, Some(rule.id.clone())),
        None => (ContributionVerdict::Unwanted, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: &str) -> WantedRule {
        WantedRule {
            id: id.to_string(),
            collected: 0,
            max_count: None,
            note: None,
            maps: Vec::new(),
            modes: Vec::new(),
            scenarios: Vec::new(),
            realms: Vec::new(),
            ship_classes: Vec::new(),
            ship_ids: Vec::new(),
            tiers: Vec::new(),
            player_count_min: None,
            player_count_max: None,
            bot_max: None,
            client_version_min: None,
        }
    }

    fn doc(rules: Vec<WantedRule>) -> WantedDoc {
        WantedDoc {
            ruleset_version: 1,
            updated_at: Some("2026-10-14T00:00:00Z".into()),
            watermark: Watermark {
                staged_bytes: 0,
                limit_bytes: 8,
                accepting: true,
            },
            rules,
        }
    }

    fn facts() -> ReplayFacts {
        ReplayFacts {
            sha256: "a".repeat(64),
            file_name: "20261014_090000_x.wowsreplay".into(),
            size_bytes: 8123456,
            core: wowsp_tauri_shared::ReplayFactsCore {
                map: "15_NE_north".into(),
                mode: "standard".into(),
                scenario: None,
                realm: "asia".into(),
                own_ship_id: 4183301234,
                ship_class: Some("Battleship".into()),
                tier: Some(10),
                player_count: 12,
                bot_count: 0,
                client_version: "14.5.0".into(),
                battle_time: "2026-10-14T09:00:00Z".into(),
            },
        }
    }

    #[test]
    fn version_compare_is_dot_numeric() {
        assert!(version_ge("14.5.0", "14.0"));
        assert!(version_ge("14.0", "14.0"));
        assert!(version_ge("14", "13.9.9"));
        assert!(!version_ge("14.0.1", "14.1"));
        assert!(!version_ge("13.12.0", "14.0"));
        assert!(version_ge("26.10.0", "26.9.9"));
        // Malformed segments degrade to 0 instead of panicking.
        assert!(version_ge("x.y.z", "0"));
        assert!(!version_ge("x.y.z", "0.0.1"));
    }

    #[test]
    fn empty_dimensions_mean_any() {
        let mut r = rule("any");
        r.player_count_min = Some(12);
        assert!(rule_matches(&r, &facts()));
        let mut f = facts();
        f.core = wowsp_tauri_shared::ReplayFactsCore::default();
        // A claim-less facts row matches every "any" dimension…
        let unbounded = rule("any");
        assert!(rule_matches(&unbounded, &f));
        // …but fails a numeric bound it cannot satisfy…
        assert!(!rule_matches(&r, &f));
        // …and a version bound it cannot testify.
        r.player_count_min = None;
        r.client_version_min = Some("14.0".into());
        assert!(!rule_matches(&r, &f));
    }

    #[test]
    fn constrained_dimensions_require_exact_claims() {
        let mut r = rule("solomon-std-asia");
        r.maps = vec!["15_NE_north".into()];
        r.modes = vec!["standard".into()];
        r.realms = vec!["asia".into()];
        r.ship_classes = vec!["Battleship".into()];
        r.tiers = vec![10];
        r.player_count_min = Some(12);
        r.player_count_max = Some(12);
        r.bot_max = Some(0);
        r.client_version_min = Some("14.0".into());
        assert!(rule_matches(&r, &facts()));
        for mutate in [
            |f: &mut ReplayFacts| f.core.map = "01_solomon".into(),
            |f: &mut ReplayFacts| f.core.realm = "ru".into(),
            |f: &mut ReplayFacts| f.core.tier = Some(8),
            |f: &mut ReplayFacts| f.core.player_count = 11,
            |f: &mut ReplayFacts| f.core.bot_count = 3,
            |f: &mut ReplayFacts| f.core.client_version = "13.9.1".into(),
            |f: &mut ReplayFacts| f.core.ship_class = None,
        ] {
            let mut f = facts();
            mutate(&mut f);
            assert!(!rule_matches(&r, &f), "mutated facts must not match");
        }
        // A ship-id dimension gates on the claimed id.
        let mut r = rule("by-ship");
        r.ship_ids = vec![4183301234];
        assert!(rule_matches(&r, &facts()));
        let mut f = facts();
        f.core.own_ship_id = 0;
        assert!(!rule_matches(&r, &f));
    }

    #[test]
    fn closed_rules_and_closed_watermarks_never_accept() {
        let mut r = rule("capped");
        r.collected = 200;
        r.max_count = Some(200);
        let d = doc(vec![r]);
        assert!(matching_open_rule(&d, &facts()).is_none());
        let mut r = rule("uncapped");
        r.collected = 10_000;
        let d = doc(vec![r]);
        assert!(matching_open_rule(&d, &facts()).is_some());
        let mut d = d;
        d.watermark.accepting = false;
        assert!(matching_open_rule(&d, &facts()).is_none());
    }

    #[test]
    fn verdict_precedence_is_duplicate_then_own_staged_then_accept() {
        let mut r = rule("open");
        r.realms = vec!["asia".into()];
        let wanted = doc(vec![r]);
        let mut known = HashSet::new();
        let mut mine = HashSet::new();
        let (verdict, rule_id) = merge_verdict(&facts(), &known, &mine, &wanted);
        assert_eq!(verdict, ContributionVerdict::Accept);
        assert_eq!(rule_id.as_deref(), Some("open"));
        // own_staged outranks a matching rule…
        mine.insert("a".repeat(64));
        let (verdict, rule_id) = merge_verdict(&facts(), &known, &mine, &wanted);
        assert_eq!(verdict, ContributionVerdict::OwnStaged);
        assert_eq!(rule_id, None);
        // …and duplicate outranks both.
        known.insert("a".repeat(64));
        let (verdict, _) = merge_verdict(&facts(), &known, &mine, &wanted);
        assert_eq!(verdict, ContributionVerdict::Duplicate);
        // An unmatched wanted doc is unwanted.
        known.clear();
        mine.clear();
        let mut stranger = facts();
        stranger.core.realm = "cn".into();
        let (verdict, rule_id) = merge_verdict(&stranger, &known, &mine, &wanted);
        assert_eq!(verdict, ContributionVerdict::Unwanted);
        assert_eq!(rule_id, None);
    }
}
