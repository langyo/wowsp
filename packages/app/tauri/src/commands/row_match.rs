//! Closed-set matcher pinning recognized row text onto arena-roster names.
//!
//! The overlay row pipeline crops each Tab-table row's name strip, reads raw
//! text with a recognizer (see `row_recognize`), and needs to answer: WHICH
//! roster player is this row? The candidate set is CLOSED — every row must
//! hold one of the players in `tempArenaInfo.json` — so this module never
//! invents a name, it only selects among the roster's own nicknames (and
//! gives up with `None` when nothing scores high enough).
//!
//! Matching is deliberately tolerant of OCR noise:
//!
//! - both sides are NORMALIZED (clan tags stripped, case folded, the
//!   visually-confusable O/0 and l/1 pairs canonicalized to the digit,
//!   whitespace collapsed) — the panel renders `[CLAN] Nickname` while the
//!   roster stores the bare nickname, OCR spacing is unreliable, and its
//!   font renders O-vs-0 ambiguously enough that the engine swaps them;
//! - a clean CONTAINMENT (the full normalized nickname appearing verbatim
//!   inside the recognized line) scores 1.0 — the line usually carries extra
//!   tokens (ship name, damage digits) around the nickname;
//! - a TRUNCATED name read scores 0.9: the panel ellipsizes long nicknames
//!   ("RuaRuaRu…"), so when the line's text before the first ellipsis ends
//!   with a head of the nickname (at least max(4, half its length) chars),
//!   that counts as strong evidence — below a clean containment, above the
//!   generic edit hits;
//! - otherwise a normalized LEVENSHTEIN similarity, taken over the best
//!   name-length window of the line so leading/trailing junk tokens do not
//!   dilute the score, decides.
//!
//! Assignment is one-to-one: each roster player may occupy at most one row,
//! resolved greedily by descending score so the strongest evidence wins. A
//! row left without a partner stays `None` (the frontend shows its silent
//! placeholder) — except when the leftovers make the answer unambiguous: the
//! row set and the candidate set describe the SAME players, so a single
//! unmatched row and a single unassigned candidate are necessarily each
//! other ([`fill_by_elimination`], guarded by the strength of the evidence
//! already placed). Everything here is a pure function — unit-testable
//! without frames.
//!
//! Known collision class, resolved by tie order: a SHORTER roster name can
//! appear inside the noisy line that belongs to a LONGER one. The usual
//! source is a clan tag whose brackets the OCR lost — the panel's
//! "[WOLF] SeaDog" then reads as "wolf seadog", which contains BOTH the
//! roster's "Wolf" and its "SeaDog" as clean 1.0 containments. Equal scores
//! are therefore broken by LONGER normalized name first: the more specific
//! containment claims the row, and the shorter name it was a fragment of
//! stays unmatched (one-to-one does the rest). Ambiguities that survive
//! this rule — a roster deliberately holding BOTH "kami" and "kamikaze"
//! reads the same line either way — are inherent to containment scoring and
//! remain a threshold-tuning concern for PR 3b, not something greedy order
//! can decide.

use wowsp_tauri_shared::VehicleEntry;

/// Similarity floor (0–1) for pinning a roster name onto a row. 0.75 keeps
/// one wrong character in a ≥4-char nickname and two in a ≥8-char one while
/// rejecting unrelated text; with the closed set + one-to-one constraint
/// false positives need TWO similarly-spelled roster members AND a bad read.
pub(crate) const MATCH_THRESHOLD: f32 = 0.75;

/// Score given to a truncated-name read (see [`truncated_prefix_score`]):
/// deliberately BELOW a clean containment (1.0 — a full verbatim read is
/// strictly stronger evidence) and ABOVE the generic edit-similarity hits
/// (which start at [`MATCH_THRESHOLD`]).
const TRUNCATED_PREFIX_SCORE: f32 = 0.9;

/// Quantized floor (see `assign_rows`'s u32 scores) a pair must reach to
/// count as STRONG evidence: a clean containment or a truncated-prefix read,
/// i.e. the nickname was read essentially verbatim rather than reconstructed
/// from fuzzy edit similarity. Only strong-pair assignments unlock the
/// elimination stage ([`fill_by_elimination`]), so the worst a fuzzy read can
/// do is leave a chip silent — never move a leftover name onto a wrong row.
const STRONG_QUANTIZED: u32 = (TRUNCATED_PREFIX_SCORE * 10_000.0) as u32;

/// Floor (in chars) for a truncated-name head to count as evidence at all —
/// a 1–3 char head could prefix half the roster's short names by accident.
const MIN_TRUNCATED_PREFIX: usize = 4;
/// Cap for the half-length part of that floor: the panel's name column
/// ellipsizes LONG nicknames down to ~10 visible chars ("tomas0312..." out
/// of "tomas0312_gmail_com_toma"), so demanding half of a 24-char name (12)
/// would reject every real truncated read of it. Beyond 16-char names the
/// floor stops growing (measured on the #372 dumps).
const MAX_TRUNCATED_HEAD_FLOOR: usize = 8;

/// The panel's ellipsis glyph OCRs inconsistently: plain dots, the proper
/// '…', or the visually-similar low quote '„' before a dot.
fn is_dot_ish(c: char) -> bool {
    c == '.' || c == '…' || c == '„'
}

/// Normalize a name or a recognized line for comparison: strip bracketed
/// clan tags (anywhere — the panel renders them as prefix or suffix), fold
/// case, canonicalize visually-confusable glyphs, collapse whitespace runs
/// to single spaces and trim.
pub(crate) fn normalize(raw: &str) -> String {
    let mut s = raw.trim().to_lowercase();
    // Canonicalize visually-confusable glyphs: at the panel's render size
    // the font's capital 'O' and digit '0' (likewise 'l' and '1') are near
    // indistinguishable, and the OCR engine swaps them freely (a real #372
    // read came back "rjOOOOOOO..." for the roster's
    // "rj0000000000000000000001"). Collapsing BOTH sides to the digit makes
    // the confusion class vanish from scoring, as does folding '_' to a
    // space (the engine reads the panel's underscores as spaces).
    // Deliberately no more: mapping 'i'→'1' would be equally self-consistent,
    // but 'i' is common in genuine nicknames and every extra canonicalization
    // widens the false-positive surface for cleanly-read names near the 0.75
    // threshold.
    s = s
        .chars()
        .map(|c| match c {
            'o' => '0',
            'l' => '1',
            // Underscores render as whitespace-width gaps at strip size, so
            // the OCR engine reads them as spaces ("M_i_n_g_" came back as
            // "M i n g"). Folding '_' to a space on BOTH sides lets the
            // whitespace collapse below absorb the swap; like the glyph
            // pairs, self-consistency is what matters, not the target.
            '_' => ' ',
            other => other,
        })
        .collect();
    // Nicknames cannot contain brackets, so every balanced [...] group is a
    // tag; rescan until none remain (multiple / adjacent tags included).
    while let Some(open) = s.find('[') {
        let Some(close_rel) = s[open + 1..].find(']') else {
            break;
        };
        let close = open + 1 + close_rel;
        s.replace_range(open..=close, " ");
    }
    // An OCR pass can drop one bracket of a pair; remove the leftovers so
    // the tag letters still separate from the nickname instead of fusing
    // with it.
    s = s.replace(['[', ']'], " ");
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Levenshtein edit distance over chars (not bytes — CJK nicknames must
/// count per glyph). Classic two-row DP; inputs are short (nicknames and
/// name-strip lines, tens of chars), so the quadratic cost is irrelevant.
fn levenshtein(a: &[char], b: &[char]) -> usize {
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur: Vec<usize> = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// Normalized edit similarity: 1.0 = identical, 0.0 = maximally different.
fn similarity(a: &[char], b: &[char]) -> f32 {
    let denom = a.len().max(b.len());
    if denom == 0 {
        return 0.0;
    }
    1.0 - levenshtein(a, b) as f32 / denom as f32
}

/// Evidence for a TRUNCATED panel name: the panel ellipsizes long nicknames
/// to fit the column ("RuaRuaRua1909" renders as "RuaRuaRu..."), so when
/// the recognized line carries an ellipsis marker (see [`is_dot_ish`]) and
/// the text BEFORE it ends with a head of the roster name, that is a strong
/// read. The head must be at least `max(`[`MIN_TRUNCATED_PREFIX`]`,
/// capped half the name's length — see [`MAX_TRUNCATED_HEAD_FLOOR`]`)`
/// chars — a longer head cannot accidentally prefix an unrelated short
/// name. The head is matched as the longest qualifying SUFFIX of the
/// pre-ellipsis text because the OCR may keep (or fuse) the clan tag in
/// front of it. `None` when the line has no truncation marker or no
/// qualifying head.
fn truncated_prefix_score(name: &[char], text: &[char]) -> Option<f32> {
    let cut = text.iter().position(|&c| c == '…').or_else(|| {
        text.windows(2)
            .position(|w| is_dot_ish(w[0]) && is_dot_ish(w[1]))
    })?;
    let mut end = cut;
    while end > 0 && text[end - 1] == ' ' {
        end -= 1;
    }
    let head = &text[..end];
    // Half the name, floored at the 4-char evidence minimum and capped so
    // very long names stay matchable (MAX >= MIN holds for the constants).
    let min_head = (name.len() / 2).clamp(MIN_TRUNCATED_PREFIX, MAX_TRUNCATED_HEAD_FLOOR);
    let max_head = head.len().min(name.len());
    for k in (min_head..=max_head).rev() {
        if head[head.len() - k..] == name[..k] {
            return Some(TRUNCATED_PREFIX_SCORE);
        }
    }
    None
}

/// Best similarity between one normalized roster name and one normalized
/// recognized line: exact containment wins outright, a truncated-name head
/// (ellipsis in the line) scores high, otherwise the best name-length
/// window of the line (and the line as a whole) by edit similarity. Empty
/// on either side can never match.
pub(crate) fn pair_score(name: &[char], text: &[char]) -> f32 {
    if name.is_empty() || text.is_empty() {
        return 0.0;
    }
    if name.len() <= text.len() && text.windows(name.len()).any(|w| w == name) {
        return 1.0;
    }
    let mut best = truncated_prefix_score(name, text).unwrap_or(0.0);
    let window_best = similarity(name, text);
    if window_best > best {
        best = window_best;
    }
    if text.len() >= name.len() {
        for w in text.windows(name.len()) {
            let s = similarity(name, w);
            if s > best {
                best = s;
                if best >= 1.0 {
                    break;
                }
            }
        }
    }
    best
}

/// Assign roster names to table rows. `ocr_texts` holds the recognized line
/// per row (`None` = the row produced no text), aligned 1:1 with the output;
/// `roster` is the CLOSED candidate set for this block of rows — the caller
/// passes each team block's own roster subset (allies first block, enemies
/// second), mirroring the frontend's per-block mapping. Every returned name
/// is the roster's own nickname string, byte-for-byte, so it is exactly the
/// stats-cache key the frontend uses.
///
/// One-to-one: a player can occupy at most one row. Candidate pairs are
/// consumed greedily best-first: descending score, then LONGER normalized
/// name (a longer exact containment is the more specific read — see the
/// module docs' collision class), then row index, then roster order, so the
/// result is deterministic. A row left without a partner stays `None` and
/// the frontend shows its silent placeholder — unless the leftovers make the
/// answer unambiguous ([`fill_by_elimination`]).
pub(crate) fn assign_rows(
    ocr_texts: &[Option<String>],
    roster: &[VehicleEntry],
) -> Vec<Option<String>> {
    let mut out: Vec<Option<String>> = vec![None; ocr_texts.len()];
    if roster.is_empty() {
        return out;
    }
    let roster_norm: Vec<Vec<char>> = roster
        .iter()
        .map(|v| normalize(&v.name).chars().collect())
        .collect();
    // Score every (row, candidate) pair; keep only pairs worth assigning.
    // Scores are quantized to u32 (1e-4 steps) so the ordering below is a
    // total, float-quirk-free order; the name length rides along for the
    // specificity tie-break.
    let mut pairs: Vec<(u32, u32, usize, usize)> = Vec::new();
    for (row, text) in ocr_texts.iter().enumerate() {
        let Some(text) = text else { continue };
        let text_norm: Vec<char> = normalize(text).chars().collect();
        if text_norm.is_empty() {
            continue;
        }
        for (cand, name_norm) in roster_norm.iter().enumerate() {
            let score = pair_score(name_norm, &text_norm);
            if score >= MATCH_THRESHOLD {
                pairs.push((
                    (score * 10_000.0).round() as u32,
                    name_norm.len() as u32,
                    row,
                    cand,
                ));
            }
        }
    }
    pairs.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(b.1.cmp(&a.1))
            .then(a.2.cmp(&b.2))
            .then(a.3.cmp(&b.3))
    });
    let mut taken_row = vec![false; ocr_texts.len()];
    let mut taken_cand = vec![false; roster.len()];
    // Evidence ledger for the elimination stage below: how many pairs were
    // placed, and whether EVERY one of them was a strong read (verbatim
    // containment, or a truncated-prefix one).
    let mut matched = 0usize;
    let mut all_strong = true;
    for (score, _, row, cand) in pairs {
        if taken_row[row] || taken_cand[cand] {
            continue;
        }
        if score < STRONG_QUANTIZED {
            all_strong = false;
        }
        matched += 1;
        taken_row[row] = true;
        taken_cand[cand] = true;
        out[row] = Some(roster[cand].name.clone());
    }
    // At least ONE row must have matched on its own text and every match must
    // be solid, so a block where recognition established nothing (all-`None`
    // reads, unrelated text) keeps its honest silence instead of being filled
    // by pure counting.
    if matched > 0 && all_strong {
        fill_by_elimination(&mut out, &taken_row, &taken_cand, roster);
    }
    out
}

/// Fill the ONE leftover row by elimination: the row set and the candidate
/// set describe the same players — the grid is built from the roster's own
/// team size (and padded to it when a row is occluded), so each side's table
/// lists exactly its roster subset — which makes the unmatched rows and the
/// unassigned candidates the SAME leftover players. When exactly one of each
/// remains, that pairing is a deduction, not a guess, and it is what fills a
/// chip OCR could not read on its own (the reported "one or two rows keep
/// dotting" case). Two or more leftovers stay ambiguous — no pairing is
/// attempted, the chips keep their honest silence.
///
/// Called only with evidence already on screen (at least one matched pair,
/// all of them strong — see the caller): a single false-positive or fuzzy
/// match must not drag the leftover name onto the wrong row, and the
/// closed-set contract every other stage relies on is what makes the
/// deduction sound.
fn fill_by_elimination(
    out: &mut [Option<String>],
    taken_row: &[bool],
    taken_cand: &[bool],
    roster: &[VehicleEntry],
) {
    let mut free_rows = taken_row.iter().enumerate().filter(|(_, t)| !**t);
    let Some((row, _)) = free_rows.next() else {
        return;
    };
    if free_rows.next().is_some() {
        return;
    }
    let mut free_cands = taken_cand.iter().enumerate().filter(|(_, t)| !**t);
    let Some((cand, _)) = free_cands.next() else {
        return;
    };
    if free_cands.next().is_some() {
        return;
    }
    out[row] = Some(roster[cand].name.clone());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn veh(name: &str) -> VehicleEntry {
        VehicleEntry {
            id: 0,
            name: name.into(),
            relation: 0,
            ship_id: 0,
            ship_name: None,
        }
    }

    fn lines(items: &[Option<&str>]) -> Vec<Option<String>> {
        items.iter().map(|t| t.map(|s| s.to_string())).collect()
    }

    // ── normalize ────────────────────────────────────────────────────────

    #[test]
    fn normalize_strips_clan_tags_prefix_suffix_and_repeats() {
        // Expected values carry the o→0 / l→1 glyph canonicalization.
        assert_eq!(normalize("[CLAN] Player"), "p1ayer");
        assert_eq!(normalize("Player [CLAN]"), "p1ayer");
        assert_eq!(normalize("[A][B] Player"), "p1ayer");
        assert_eq!(normalize("[CLAN]Player"), "p1ayer");
        assert_eq!(normalize("Player[CLAN]"), "p1ayer");
    }

    #[test]
    fn normalize_folds_case_and_whitespace() {
        assert_eq!(normalize("  Foo   BAR "), "f00 bar");
        assert_eq!(normalize("\tSpaced\tOut\n"), "spaced 0ut");
        assert_eq!(normalize("   "), "");
        // CJK passes through untouched (case folding and the o/l map are
        // no-ops there).
        assert_eq!(normalize("苍蓝蔷薇"), "苍蓝蔷薇");
    }

    #[test]
    fn normalize_survives_a_lost_bracket() {
        // OCR read only one bracket of the pair: the leftovers are dropped
        // so the tag still separates from the nickname.
        assert_eq!(normalize("[Clan Player"), "c1an p1ayer");
        assert_eq!(normalize("Clan] Player"), "c1an p1ayer");
    }

    #[test]
    fn normalize_canonicalizes_visually_confusable_glyphs() {
        // The panel font renders O/0 and l/1 near-identically and the OCR
        // engine swaps them freely; BOTH sides collapse to the digit.
        assert_eq!(normalize("rjOOOOOOO"), "rj0000000");
        assert_eq!(normalize("HelloWorld"), "he110w0r1d");
        // Canonicalized clan tags still strip as bracketed groups.
        assert_eq!(normalize("[WOLF] SeaWolf"), "seaw01f");
        // 'i' is deliberately NOT mapped — it is common in genuine
        // nicknames and stays out of the confusion set.
        assert_eq!(normalize("iiii"), "iiii");
    }

    #[test]
    fn normalize_folds_underscores_to_spaces() {
        // The panel renders underscores as gap-width strokes the engine
        // reads as spaces; folding '_' to a space on both sides absorbs the
        // swap through the whitespace collapse (a real #372 read:
        // "[VIPI]M i n g" for the roster's "M_i_n_g_").
        assert_eq!(normalize("M_i_n_g_"), "m i n g");
        assert_eq!(normalize("[VIPI]M i n g"), "m i n g");
        // A verbatim read of an underscored name still matches itself
        // (the o→0 canonicalization applies as everywhere).
        assert_eq!(normalize("wocaonimaya_"), "w0ca0nimaya");
    }

    #[test]
    fn underscore_folded_names_match_spaced_reads() {
        // The scoring-level consequence: the spaced OCR read of an
        // underscore-heavy nickname becomes a verbatim match.
        let roster = vec![veh("M_i_n_g_"), veh("PlainName")];
        let out = assign_rows(&lines(&[Some("[VIPI]M i n g"), Some("plainname")]), &roster);
        assert_eq!(out, vec![Some("M_i_n_g_".into()), Some("PlainName".into())]);
    }

    // ── scoring (exercised through assign_rows) ──────────────────────────

    #[test]
    fn exact_line_matches_by_containment() {
        let roster = vec![veh("PlayerOne"), veh("SeaWolf")];
        let out = assign_rows(&lines(&[Some("playerone gneisenau 45k 12"), None]), &roster);
        // Row 0 by clean containment; row 1 is the sole leftover, so the sole
        // remaining roster entry is deduced onto it (see
        // `fill_by_elimination`).
        assert_eq!(out, vec![Some("PlayerOne".into()), Some("SeaWolf".into())]);
    }

    #[test]
    fn noisy_line_still_matches_within_the_threshold() {
        // Two substituted characters in a 9-char name: best window
        // similarity 7/9 ≈ 0.78 ≥ 0.75.
        let roster = vec![veh("PlayerOne")];
        let out = assign_rows(&lines(&[Some("piayexone 120k")]), &roster);
        assert_eq!(out, vec![Some("PlayerOne".into())]);
    }

    // ── visually-confusable glyphs (O/0, l/1) ───────────────────────────

    #[test]
    fn o_for_zero_read_still_matches_a_digit_heavy_name() {
        // Real #372-dump read: the roster name is "rj" + zeros, the OCR
        // returned capital O's for every zero (raw score 0.111 — one shared
        // 'r'). Canonicalization on both sides turns the ellipsized read
        // back into a clean truncated-prefix hit.
        let roster = vec![veh("rj0000000000000000000001")];
        let out = assign_rows(&lines(&[Some("[SRSMC]rjOOOOOOO...")]), &roster);
        assert_eq!(out, vec![Some("rj0000000000000000000001".into())]);
        // Without the truncation marker the short read of the long name
        // still pins nothing — canonicalization collapses the glyph
        // confusion, it does not invent the unread characters.
        let out = assign_rows(&lines(&[Some("[SRSMC]rjOOOOOOO")]), &roster);
        assert_eq!(out, vec![None]);
    }

    #[test]
    fn genuine_o_and_l_names_still_match_their_own_reads() {
        // Canonicalization applies to BOTH sides, so names that really do
        // contain o/l keep matching their verbatim reads...
        let roster = vec![veh("SeaWolf"), veh("BlueLagoon"), veh("Kongo")];
        let out = assign_rows(
            &lines(&[Some("seawolf"), Some("bluelagoon"), Some("xivkongo123")]),
            &roster,
        );
        assert_eq!(
            out,
            vec![
                Some("SeaWolf".into()),
                Some("BlueLagoon".into()),
                Some("Kongo".into())
            ]
        );
        // ...and the mirror image holds too: a genuine-'l' roster name is
        // still reachable through a read that OCR'd the glyph as a '1'.
        let roster = vec![veh("BlueLagoon")];
        let out = assign_rows(&lines(&[Some("b1ue1agoon")]), &roster);
        assert_eq!(out, vec![Some("BlueLagoon".into())]);
    }

    // ── truncated panel names (ellipsis) ─────────────────────────────────

    #[test]
    fn truncated_panel_name_matches_by_prefix() {
        // The panel ellipsizes long nicknames: "RuaRuaRua1909" renders as
        // "RuaRuaRu..." and the OCR reads exactly that. The ellipsis head is
        // a prefix of the roster name (8 chars ≥ max(4, 13/2 = 6)).
        let roster = vec![veh("RuaRuaRua1909")];
        let out = assign_rows(&lines(&[Some("RuaRuaRu...")]), &roster);
        assert_eq!(out, vec![Some("RuaRuaRua1909".into())]);
        // Mid-line ellipsis: more panel columns follow inside the strip.
        let out = assign_rows(&lines(&[Some("RuaRuaRu... VIII 黎塞留")]), &roster);
        assert_eq!(out, vec![Some("RuaRuaRua1909".into())]);
        // The OCR dropped one dot of the glyph.
        let out = assign_rows(&lines(&[Some("RuaRuaRu..")]), &roster);
        assert_eq!(out, vec![Some("RuaRuaRua1909".into())]);
        // A clan tag (kept or fused by the OCR) in front of the head.
        let out = assign_rows(&lines(&[Some("[CLBQ]RuaRuaRu...")]), &roster);
        assert_eq!(out, vec![Some("RuaRuaRua1909".into())]);
        let out = assign_rows(&lines(&[Some("clbq ruaruaru...")]), &roster);
        assert_eq!(out, vec![Some("RuaRuaRua1909".into())]);
    }

    #[test]
    fn truncated_prefix_needs_enough_evidence() {
        let roster = vec![veh("RuaRuaRua1909")];
        // 3 chars < max(4, 13/2 = 6): too short to prefix-match by itself.
        let out = assign_rows(&lines(&[Some("Rua...")]), &roster);
        assert_eq!(out, vec![None]);
        // The same short head WITHOUT the ellipsis marker is no evidence at
        // all — a partial OCR read must not pin a different player's row.
        let out = assign_rows(&lines(&[Some("ruaruaru")]), &roster);
        assert_eq!(out, vec![None]);
    }

    #[test]
    fn truncation_scores_between_containment_and_edit_hits() {
        let name: Vec<char> = normalize("RuaRuaRua1909").chars().collect();
        // Clean containment: the full name verbatim inside the line.
        let contained: Vec<char> = normalize("RuaRuaRua1909 45k").chars().collect();
        assert_eq!(pair_score(&name, &contained), 1.0);
        // Truncated head: exactly the 0.9 tier.
        let truncated: Vec<char> = normalize("RuaRuaRu...").chars().collect();
        assert_eq!(pair_score(&name, &truncated), 0.9);
        // A generic (non-truncation) edit hit lands below the 0.9 tier but
        // above the assignment threshold — two wrong chars in 13.
        let edit_hit: Vec<char> = normalize("RuaRuaRua1807").chars().collect();
        let score = pair_score(&name, &edit_hit);
        assert!(
            (0.75..0.9).contains(&score),
            "generic edit hit {score} must sit in [0.75, 0.9)"
        );
    }

    #[test]
    fn truncated_head_prefers_the_name_it_actually_truncates() {
        // Two roster names sharing a prefix: the truncated head must pin the
        // row to the name it is actually a head OF, not the short one.
        let roster = vec![veh("RuaXYZ1234567"), veh("RuaRuaRua1909")];
        let out = assign_rows(&lines(&[Some("RuaRuaRu...")]), &roster);
        assert_eq!(out, vec![Some("RuaRuaRua1909".into())]);
    }

    #[test]
    fn ellipsis_glyph_ocr_confusions_still_mark_the_cut() {
        // Real reads off the #372 dumps: the panel's ellipsis glyph comes
        // back as the low quote '„' before a dot.
        let roster = vec![veh("RuaRuaRua1909")];
        let out = assign_rows(&lines(&[Some("[TSUGUlRuaRuaRu„.")]), &roster);
        assert_eq!(out, vec![Some("RuaRuaRua1909".into())]);
    }

    #[test]
    fn long_truncated_names_use_the_capped_floor() {
        // "tomas0312_gmail_com_toma" (24 chars) renders as "tomas0312..." —
        // a 9-char head. Half the name (12) would reject every real read of
        // it, so the floor caps at 8; the 9-char head still qualifies.
        let roster = vec![veh("tomas0312_gmail_com_toma")];
        let out = assign_rows(&lines(&[Some("[HEART]tomas0312...")]), &roster);
        assert_eq!(out, vec![Some("tomas0312_gmail_com_toma".into())]);
        // The same head WITHOUT the truncation marker stays insufficient —
        // a 9-char partial read of a 24-char name is not evidence.
        let out = assign_rows(&lines(&[Some("[HEART]tomas0312")]), &roster);
        assert_eq!(out, vec![None]);
    }

    #[test]
    fn substring_inside_noise_tokens_matches() {
        // Ship name + digits squeezed against the nickname, no spaces.
        let roster = vec![veh("Kongo")];
        let out = assign_rows(&lines(&[Some("xivkongo123456")]), &roster);
        assert_eq!(out, vec![Some("Kongo".into())]);
    }

    #[test]
    fn clan_tag_difference_does_not_block_matching() {
        // Roster stores the bare nickname; the panel renders the tag.
        let roster = vec![veh("SeaWolf")];
        let out = assign_rows(&lines(&[Some("[WOLF] SeaWolf 32k")]), &roster);
        assert_eq!(out, vec![Some("SeaWolf".into())]);
        // And the reverse: roster carries the tag, the read line does not.
        let tagged = vec![veh("[WOLF] SeaWolf")];
        let out = assign_rows(&lines(&[Some("seawolf 32k")]), &tagged);
        assert_eq!(out, vec![Some("[WOLF] SeaWolf".into())]);
    }

    #[test]
    fn cjk_names_match_exactly_and_with_one_wrong_glyph() {
        let roster = vec![veh("苍蓝蔷薇")];
        // Clean containment.
        let out = assign_rows(&lines(&[Some("苍蓝蔷薇 大和 45k")]), &roster);
        assert_eq!(out, vec![Some("苍蓝蔷薇".into())]);
        // One wrong glyph in four: similarity exactly 0.75 → still pinned.
        let out = assign_rows(&lines(&[Some("苍蓝蔷微 yamato")]), &roster);
        assert_eq!(out, vec![Some("苍蓝蔷薇".into())]);
        // A different CJK nickname entirely: 0.0 similarity → rejected.
        let out = assign_rows(&lines(&[Some("铁血老兵")]), &roster);
        assert_eq!(out, vec![None]);
    }

    #[test]
    fn unrelated_text_stays_below_threshold() {
        let roster = vec![veh("PlayerOne")];
        let out = assign_rows(&lines(&[Some("zzzzzzzz qqqq 000")]), &roster);
        assert_eq!(out, vec![None]);
        // Empty / whitespace-only reads never match anything.
        let out = assign_rows(&lines(&[Some(""), Some("   ")]), &roster);
        assert_eq!(out, vec![None, None]);
    }

    // ── assignment semantics ─────────────────────────────────────────────

    #[test]
    fn all_none_input_maps_to_all_none() {
        let roster = vec![veh("A"), veh("B")];
        let out = assign_rows(&lines(&[None, None, None]), &roster);
        assert_eq!(out, vec![None, None, None]);
    }

    #[test]
    fn empty_roster_maps_to_all_none() {
        let out = assign_rows(&lines(&[Some("someone"), None]), &[]);
        assert_eq!(out, vec![None, None]);
    }

    #[test]
    fn lookalike_rows_each_take_their_best_candidate() {
        // "alicia" also scores ≥ threshold against "alice", but each row's
        // perfect candidate exists and must win.
        let roster = vec![veh("alice"), veh("alicia")];
        let out = assign_rows(&lines(&[Some("alicia"), Some("alice")]), &roster);
        assert_eq!(out, vec![Some("alicia".into()), Some("alice".into())]);
    }

    #[test]
    fn one_player_cannot_occupy_two_rows() {
        // Two rows both read alice's name; the single roster entry goes to
        // the first row (equal scores → lower row index wins) and the other
        // row stays None instead of being force-matched.
        let roster = vec![veh("alice")];
        let out = assign_rows(&lines(&[Some("alice 1"), Some("alice 2")]), &roster);
        assert_eq!(out, vec![Some("alice".into()), None]);
    }

    #[test]
    fn stronger_evidence_wins_the_conflict() {
        // Row 1's read is a clean containment; row 0's is a typo. PlayerOne
        // must land on row 1 even though row 0 comes first — and row 0, the
        // only row left with the only candidate left ("filler"), is then the
        // elimination deduction (see `fill_by_elimination`) rather than a
        // silent placeholder: the row IS filler, since PlayerOne's row is
        // already spoken for.
        let roster = vec![veh("PlayerOne"), veh("filler")];
        let out = assign_rows(&lines(&[Some("PiayerOue"), Some("playerone 45k")]), &roster);
        assert_eq!(out, vec![Some("filler".into()), Some("PlayerOne".into())]);
    }

    #[test]
    fn longer_containment_wins_the_score_tie() {
        // The row shows "[WOLF] SeaDog" but the OCR lost the tag brackets:
        // the normalized line "wolf seadog" contains BOTH roster names as
        // clean 1.0 containments. The longer name is the more specific read
        // and claims the row; the short tag-letter name it was a fragment of
        // must NOT be pinned to this row — with one row and one candidate
        // left over it goes to the UNREAD row instead, which is the same
        // deduction read the other way round.
        let roster = vec![veh("Wolf"), veh("SeaDog")];
        let out = assign_rows(&lines(&[Some("wolf seadog"), None]), &roster);
        assert_eq!(out, vec![Some("SeaDog".into()), Some("Wolf".into())]);
    }

    // ── elimination (the single leftover row) ────────────────────────────

    #[test]
    fn single_leftover_row_is_filled_by_elimination() {
        // The reported shape: the neighbours read cleanly and one row's strip
        // came back with text that fits nobody (a glare-mangled read, a
        // partly-covered strip) — its chip would otherwise dot for the whole
        // battle. One row and one roster entry left: the pairing is forced.
        let roster = vec![veh("Alpha"), veh("MOCHI91"), veh("Gamma")];
        let out = assign_rows(
            &lines(&[Some("[CLAN]Alpha 45k"), Some("???"), Some("gamma 8k")]),
            &roster,
        );
        assert_eq!(
            out,
            vec![
                Some("Alpha".into()),
                Some("MOCHI91".into()),
                Some("Gamma".into())
            ]
        );
    }

    #[test]
    fn elimination_fills_an_unread_row_next_to_read_ones() {
        // Two clean reads and one row whose strip produced no text at all
        // (occluded / out of frame): the third roster name can only belong to
        // it.
        let roster = vec![veh("Alpha"), veh("Beta"), veh("Gamma")];
        let out = assign_rows(
            &lines(&[Some("alpha 12k"), None, Some("gamma 8k")]),
            &roster,
        );
        assert_eq!(
            out,
            vec![
                Some("Alpha".into()),
                Some("Beta".into()),
                Some("Gamma".into())
            ]
        );
    }

    #[test]
    fn elimination_needs_exactly_one_leftover_each() {
        // Two unread rows against TWO unassigned candidates: any pairing
        // would be a coin flip, so both stay silent.
        let roster = vec![veh("Alpha"), veh("Beta"), veh("Gamma")];
        let out = assign_rows(&lines(&[Some("alpha 12k"), None, None]), &roster);
        assert_eq!(
            out,
            vec![Some("Alpha".into()), None, None],
            "2×2 leftovers must stay ambiguous"
        );
        // A row with no partner candidate (more rows than roster entries, the
        // padded/occluded case) is likewise left alone.
        let out = assign_rows(&lines(&[Some("alpha 12k"), None, None]), &roster[..1]);
        assert_eq!(out, vec![Some("Alpha".into()), None, None]);
    }

    #[test]
    fn elimination_stays_off_without_strong_evidence() {
        let roster = vec![veh("PlayerOne"), veh("filler")];
        // Row 0's read is a FUZZY hit (0.78: two wrong letters in nine) —
        // accepted, but not solid enough to extend the assignment to the row
        // that read nothing. The leftover stays silent.
        let out = assign_rows(&lines(&[Some("PiayerOue"), None]), &roster);
        assert_eq!(
            out,
            vec![Some("PlayerOne".into()), None],
            "a fuzzy match must not unlock the elimination fill"
        );
        // A block where NOTHING matched keeps its honest silence too, even
        // when the counts would line up 1:1.
        let single = vec![veh("苍蓝蔷薇")];
        let out = assign_rows(&lines(&[Some("铁血老兵")]), &single);
        assert_eq!(out, vec![None]);
    }

    #[test]
    fn output_length_always_matches_the_row_count() {
        let roster = vec![veh("a"), veh("b"), veh("c")];
        let out = assign_rows(&lines(&[Some("a"), None]), &roster);
        assert_eq!(out.len(), 2);
        assert_eq!(out, vec![Some("a".into()), None]);
    }
}
