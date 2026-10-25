//! Game-version compatibility guard for catalog packs.
//!
//! Every catalog entry publishes the game range it was built against
//! (`game`, e.g. `">=15.7 <15.8"` — `"*"` when unconstrained), and the
//! client's own `preferences.xml` pin carries the game version it runs
//! (`<last_server_version>15,9,1,13357625</last_server_version>` — see
//! [`crate::commands::game_context::preferences_active_game_version`]).
//! Nothing used to compare the two: a pack one or more game versions
//! stale installed silently, and its prebuilt panel/ship-bar overrides
//! then crash the CURRENT binary mid-battle (the engine-side
//! `Could not find valid vertex primitive format with name <garbage>`
//! class — the 2026-10 field report behind this guard: a 15.7 pack on
//! the 15.9 build 13357625, crashing on the Tab team panel 26–113 s
//! into every battle).
//!
//! Policy: WARN, never block. Community-crawled ranges can lag a live
//! pack that still works, so the guard only surfaces a mismatch on the
//! install report (`InstallReport.warnings`, rendered verbatim by the
//! webui) and in the log — the human decides.

/// Whether `client` (dotted game version, e.g. `15.9.1`) satisfies
/// `range` as published by the catalog.
///
/// Grammar: whitespace-separated conjunction of comparator terms —
/// `">=15.7 <15.8"` means both bounds; a bare version term (`15.7.0`)
/// compares equal; `"*"` and the empty string constrain nothing.
/// Returns `None` whenever no confident verdict exists (unconstrained
/// range, unparseable term, unparsable client): a false alarm would be
/// worse than silence.
fn game_range_allows(range: &str, client: &str) -> Option<bool> {
    let client = parse_version(client)?;
    let range = range.trim();
    if range.is_empty() || range == "*" {
        return None;
    }
    let mut allowed = true;
    for term in range.split_whitespace() {
        let (op, text) = match term {
            t if t.starts_with(">=") => (Op::Ge, &t[2..]),
            t if t.starts_with("<=") => (Op::Le, &t[2..]),
            t if t.starts_with('>') => (Op::Gt, &t[1..]),
            t if t.starts_with('<') => (Op::Lt, &t[1..]),
            t if t.starts_with("==") => (Op::Eq, &t[2..]),
            t if t.starts_with('=') => (Op::Eq, &t[1..]),
            t => (Op::Eq, t),
        };
        let bound = parse_version(text)?;
        let holds = match op {
            Op::Ge => client >= bound,
            Op::Le => client <= bound,
            Op::Gt => client > bound,
            Op::Lt => client < bound,
            Op::Eq => client == bound,
        };
        allowed = allowed && holds;
    }
    Some(allowed)
}

/// The install-report warning for a pack whose published range excludes
/// the local client's game version. `None` when the verdict is absent
/// (client version unknown / range unconstrained or unparseable / range
/// satisfied) — the guard stays silent rather than guessing.
pub(crate) fn compat_warning(range: &str, client: Option<&str>) -> Option<String> {
    let client = client?;
    match game_range_allows(range, client) {
        Some(false) => Some(format!(
            "game version mismatch: pack targets {range} but this client reports {client} — a version-stale pack can crash the game in battle; remove or update it if crashes appear"
        )),
        _ => None,
    }
}

enum Op {
    Ge,
    Le,
    Gt,
    Lt,
    Eq,
}

/// Dotted version → `(major, minor, patch)`, missing parts zero-padded
/// (`15.7` → `(15, 7, 0)`); anything else (empty parts, non-numeric,
/// more than three parts) is `None`.
fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    let mut parts = [0u32; 3];
    for (slot, part) in text.split('.').enumerate() {
        let value = part.trim().parse::<u32>().ok()?;
        match slot {
            0 => parts[0] = value,
            1 => parts[1] = value,
            2 => parts[2] = value,
            _ => return None,
        }
    }
    Some((parts[0], parts[1], parts[2]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The published range grammar: the repo's own index fixtures use
    /// `">=15.7 <15.8"` and `">=15.7"`; `"*"` is the unconstrained mark.
    #[test]
    fn range_terms_decide_by_conjunction() {
        // The report's exact shape: a 15.7-family pack on a 15.9 client.
        assert_eq!(game_range_allows(">=15.7 <15.8", "15.9.1"), Some(false));
        // Inside the range, on either bound spelling.
        assert_eq!(game_range_allows(">=15.7 <15.8", "15.7.0"), Some(true));
        assert_eq!(game_range_allows(">=15.7 <15.8", "15.7.9"), Some(true));
        // Open-ended floors.
        assert_eq!(game_range_allows(">=15.7", "15.9.1"), Some(true));
        assert_eq!(game_range_allows(">=15.7", "15.6.3"), Some(false));
        // Zero-padding: a two-part bound against a three-part client.
        assert_eq!(game_range_allows("<15.8", "15.8.0"), Some(false));
        assert_eq!(game_range_allows("<15.8", "15.7.5"), Some(true));
        // Strict > and <= bounds, on their boundary values.
        assert_eq!(game_range_allows(">15.7", "15.7.0"), Some(false));
        assert_eq!(game_range_allows(">15.7", "15.7.1"), Some(true));
        assert_eq!(game_range_allows("<=15.8", "15.8.0"), Some(true));
        assert_eq!(game_range_allows("<=15.8", "15.8.1"), Some(false));
        // Combined bounds still AND together.
        assert_eq!(game_range_allows(">15.7 <15.8", "15.7.5"), Some(true));
        assert_eq!(game_range_allows(">15.7 <15.8", "15.8.0"), Some(false));
        // Bare and = terms compare equal on the padded tuple.
        assert_eq!(game_range_allows("15.7.0", "15.7.0"), Some(true));
        assert_eq!(game_range_allows("=15.7", "15.7.2"), Some(false));
        assert_eq!(game_range_allows("==15.7.0", "15.7.0"), Some(true));
    }

    /// Silence over guesses: unconstrained or unparseable inputs never
    /// produce a verdict.
    #[test]
    fn unknown_shapes_answer_none() {
        assert_eq!(game_range_allows("*", "15.9.1"), None);
        assert_eq!(game_range_allows("", "15.9.1"), None);
        assert_eq!(game_range_allows(">=15.7", "not-a-version"), None);
        assert_eq!(game_range_allows(">=15.7.0.0", "15.9.1"), None);
        assert_eq!(game_range_allows(">=", "15.9.1"), None);
    }

    /// The warning exists only for a confident mismatch, and carries
    /// both versions plus the actionable advice.
    #[test]
    fn warning_fires_only_on_confident_mismatch() {
        let w = compat_warning(">=15.7 <15.8", Some("15.9.1")).expect("mismatch warns");
        assert!(w.contains(">=15.7 <15.8"), "{w}");
        assert!(w.contains("15.9.1"), "{w}");
        assert!(w.to_lowercase().contains("crash"), "{w}");
        assert!(compat_warning(">=15.7 <15.8", Some("15.7.4")).is_none());
        assert!(compat_warning("*", Some("15.9.1")).is_none());
        assert!(compat_warning(">=15.7 <15.8", None).is_none());
    }
}
