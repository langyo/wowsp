//! Outgoing translation composition: turns one line's `(language, text)`
//! translations into the messages the auto-send path posts back to the game
//! chat (contract §4).
//!
//! The rules this module owns:
//!
//! - ordering — the translations are emitted in a fixed family order
//!   (zh-TW, ja, ko, ru, en) followed by the remaining tags alphabetically,
//!   so the same battle always reads the same way;
//! - two suffix layouts — per segment (`译文 [后缀] | 訳 [Suffix]`) or one
//!   unified suffix at the end of everything;
//! - greedy packing against the display-width budget (`split_chars`): a
//!   translation that does not fit is split at sentence ends first, then at
//!   word boundaries, then hard — every continuation chunk carries an
//!   `(i/n)` marker and still follows the chosen suffix layout;
//! - NEVER an empty message: empty translations are dropped up front, and
//!   packing only ever emits non-empty strings.
//!
//! The suffix table itself lives in `super::lang` (W1 owns the 17-language
//! strings); this module only asks `suffix_for` and uses the results
//! verbatim. Display width is computed here instead of pulling a new
//! dependency: East Asian Wide/Fullwidth and Hangul take two columns, every
//! other scalar one — the same convention the game's chat box budgets with.
//!
//! The kernel is pure: no I/O, no clock, no logging. The chat-panel wave wires
//! it to the live pipeline, so non-test builds currently allow dead code.
#![allow(dead_code)]

use super::lang::suffix_for;

/// Inter-segment separator, exactly as the contract spells it.
const SEPARATOR: &str = " | ";
/// Display width of [`SEPARATOR`] (the ASCII spaces and pipe are all narrow).
const SEPARATOR_WIDTH: usize = 3;
/// Fixed family order for the emitted languages; anything else sorts after
/// these, alphabetically.
const PRIORITY_LANGS: [&str; 5] = ["zh-TW", "ja", "ko", "ru", "en"];
/// Sentence-ending punctuation the splitter cuts AFTER first.
const SENTENCE_ENDS: [char; 8] = ['。', '！', '？', '!', '?', '.', ';', '…'];
/// Room a continuation needs at minimum: the widest marker plus one
/// two-column glyph. Below it the suffix cannot ride along and is dropped
/// (content and the width cap win — see [`render_segments`]).
const MIN_CONTENT_WITH_MARKER: usize = 8;

/// Suffix layout for the composed messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SuffixFormat {
    /// Every segment carries its own language suffix.
    PerSegment,
    /// All translations are joined with separators and the FIRST target
    /// language's suffix closes the whole thing.
    Unified,
}

/// Composition knobs, one-to-one with the settings document's `[send]`
/// section (the caller resolves the stored enum strings into these).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ComposeOptions {
    /// Append the language suffix at all (the `[WOWSP…]` brand marker).
    pub suffix_enabled: bool,
    /// Which of the two layouts to use.
    pub suffix_format: SuffixFormat,
    /// Maximum display width of ONE chat message, in columns.
    pub split_chars: usize,
}

impl Default for ComposeOptions {
    fn default() -> Self {
        Self {
            suffix_enabled: true,
            suffix_format: SuffixFormat::PerSegment,
            split_chars: 120,
        }
    }
}

/// Display width of `text` in the chat box's columns: East Asian Wide and
/// Fullwidth scalars plus the Hangul/Han/Kana blocks count two, everything
/// else one. See the module docs for why this is hand-rolled.
pub(crate) fn width(text: &str) -> usize {
    text.chars().map(char_width).sum()
}

/// Width of one scalar (see [`width`]).
fn char_width(c: char) -> usize {
    match c as u32 {
        // Hangul Jamo (initial consonants) and Jamo Extended-A.
        0x1100..=0x115F | 0xA960..=0xA97F => 2,
        // Angle brackets are East Asian Wide by the Unicode EAW table.
        0x2329..=0x232A => 2,
        // CJK radicals, Kangxi, CJK symbols and punctuation.
        0x2E80..=0x303E => 2,
        // Hiragana, Katakana, Bopomofo, Hangul compat Jamo, CJK compat.
        0x3041..=0x33FF => 2,
        // CJK Unified Ideographs Extension A.
        0x3400..=0x4DBF => 2,
        // CJK Unified Ideographs.
        0x4E00..=0x9FFF => 2,
        // Yi Syllables / Yi Radicals.
        0xA000..=0xA4CF => 2,
        // Hangul Syllables.
        0xAC00..=0xD7A3 => 2,
        // CJK Compatibility Ideographs.
        0xF900..=0xFAFF => 2,
        // Vertical forms and CJK Compatibility Forms.
        0xFE10..=0xFE19 | 0xFE30..=0xFE6F => 2,
        // Fullwidth ASCII / signs.
        0xFF00..=0xFF60 | 0xFFE0..=0xFFE6 => 2,
        // Emoji pictographs (Wide in the Unicode EAW table today).
        0x1F300..=0x1F64F | 0x1F680..=0x1F6FF | 0x1F900..=0x1F9FF | 0x1FA70..=0x1FAFF => 2,
        // CJK Unified Ideographs Extension B and beyond.
        0x20000..=0x2FFFD | 0x30000..=0x3FFFD => 2,
        _ => 1,
    }
}

/// Order key for the emitted languages: the fixed family first (in the
/// contract's order), then everything else by tag.
fn language_rank(lang: &str) -> (usize, &str) {
    match PRIORITY_LANGS.iter().position(|known| *known == lang) {
        Some(rank) => (rank, ""),
        None => (PRIORITY_LANGS.len(), lang),
    }
}

/// Compose one chat line's translations into sendable messages.
///
/// `original` is the player's own line (kept in the signature for the wave
/// that suppresses echoes and logs what was translated — composition itself
/// never re-emits it, because the game already posted it). `translations`
/// pairs a language tag with the model's translation; entries with an empty
/// or whitespace-only text are dropped (an untranslatable line sends nothing).
///
/// The returned messages are in send order, each at most
/// [`ComposeOptions::split_chars`] display columns wide, never empty.
pub(crate) fn compose_outgoing<L, T>(
    original: &str,
    translations: &[(L, T)],
    opts: &ComposeOptions,
) -> Vec<String>
where
    L: AsRef<str>,
    T: AsRef<str>,
{
    // Own line is informational only for this kernel (see the doc above).
    let _ = original;
    let budget = opts.split_chars.max(1);
    let mut pairs: Vec<(&str, &str)> = translations
        .iter()
        .map(|(lang, text)| (lang.as_ref(), text.as_ref()))
        .filter(|(_, text)| !text.trim().is_empty())
        .collect();
    if pairs.is_empty() {
        return Vec::new();
    }
    pairs.sort_by(|a, b| language_rank(a.0).cmp(&language_rank(b.0)));
    // One entry per language: the first (priority order) translation wins.
    pairs.dedup_by(|a, b| a.0 == b.0);

    let pieces = match opts.suffix_format {
        SuffixFormat::PerSegment => {
            let mut pieces = Vec::new();
            for (lang, text) in &pairs {
                let suffix = opts.suffix_enabled.then(|| suffix_for(lang));
                pieces.extend(render_segments(text, suffix, budget));
            }
            pieces
        },
        SuffixFormat::Unified => render_unified(&pairs, opts, budget),
    };
    pack(pieces, budget)
}

/// Render one translation for the per-segment layout: the plain segment when
/// it fits, or continuation chunks (each carrying `(i/n)` and the suffix).
fn render_segments(text: &str, suffix: Option<&str>, budget: usize) -> Vec<String> {
    let suffix_cost = suffix.map(|s| 1 + width(s)).unwrap_or(0);
    if width(text) + suffix_cost <= budget {
        return vec![render_piece(text, None, suffix)];
    }
    let base = budget.saturating_sub(suffix_cost);
    // Extreme budget: the suffix alone would leave no room for a marker plus
    // one glyph. The width cap and the content win — the suffix is dropped
    // for this translation's continuations instead of truncating the line.
    if suffix.is_some() && base < MIN_CONTENT_WITH_MARKER {
        let chunks = split_with_markers(text, budget);
        let total = chunks.len();
        return chunks
            .into_iter()
            .enumerate()
            .map(|(index, chunk)| render_piece(&chunk, Some((index + 1, total)), None))
            .collect();
    }
    let chunks = split_with_markers(text, base);
    let total = chunks.len();
    chunks
        .into_iter()
        .enumerate()
        .map(|(index, chunk)| render_piece(&chunk, Some((index + 1, total)), suffix))
        .collect()
}

/// Render the unified layout: every translation joins with separators, one
/// suffix closes the last message. Oversized individual translations are
/// split with `(i/n)` markers exactly like the per-segment path.
fn render_unified(pairs: &[(&str, &str)], opts: &ComposeOptions, budget: usize) -> Vec<String> {
    let suffix = opts
        .suffix_enabled
        .then_some(suffix_for(pairs.first().map(|pair| pair.0).unwrap_or("en")));
    let suffix_cost = suffix.map(|s| 1 + width(s)).unwrap_or(0);
    // Reserve the closing suffix on every message; the final one spends it.
    let content_budget = budget.saturating_sub(suffix_cost).max(1);
    let mut pieces = Vec::new();
    for (_, text) in pairs {
        if width(text) <= content_budget {
            pieces.push((*text).to_string());
        } else {
            let chunks = split_with_markers(text, content_budget);
            let total = chunks.len();
            for (index, chunk) in chunks.into_iter().enumerate() {
                pieces.push(render_piece(&chunk, Some((index + 1, total)), None));
            }
        }
    }
    let mut messages = pack(pieces, content_budget);
    if let (Some(suffix), Some(last)) = (suffix, messages.last_mut()) {
        let grown = width(last) + 1 + width(suffix);
        if grown <= budget {
            last.push(' ');
            last.push_str(suffix);
        }
    }
    messages
}

/// One rendered segment: the text, an optional `(i/n)` continuation marker
/// and an optional language suffix (one space before each).
fn render_piece(text: &str, marker: Option<(usize, usize)>, suffix: Option<&str>) -> String {
    let mut out = text.trim().to_string();
    if let Some((index, total)) = marker {
        out.push_str(&format!(" ({index}/{total})"));
    }
    if let Some(suffix) = suffix {
        out.push(' ');
        out.push_str(suffix);
    }
    out
}

/// Split `text` into display-width-bounded chunks, marking the result with
/// `(i/n)` continuations. Returns one trimmed chunk per piece; a text that
/// cannot be represented at all degrades to a single ellipsis chunk.
fn split_with_markers(text: &str, base: usize) -> Vec<String> {
    // The marker width depends on the total count, so iterate on the count
    // until it settles: n grows, per-chunk room shrinks only by the marker's
    // digit width, and the loop converges in a couple of steps.
    let mut total = 1usize;
    loop {
        let marker = marker_width(total, total);
        let room = base.saturating_sub(marker);
        if room < 2 {
            // Not even one two-column glyph plus the marker fits: hard
            // truncate the whole translation to the budget.
            return vec![truncate_with_ellipsis(
                text,
                base.saturating_sub(marker).max(1),
            )];
        }
        let chunks = split_text(text, room);
        let needed = chunks.len();
        if needed <= total {
            return chunks;
        }
        total = needed;
    }
}

/// Display width of the ` (i/n)` marker for the given pair.
fn marker_width(index: usize, total: usize) -> usize {
    format!(" ({index}/{total})").chars().count()
}

/// Split `text` into chunks no wider than `max_width` columns, preferring a
/// sentence end, then a word boundary, then a hard character cut. Chunks are
/// trimmed (the display never shows the boundary whitespace).
fn split_text(text: &str, max_width: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut rest = text;
    while !rest.trim().is_empty() {
        let (chunk, remainder) = take_chunk(rest, max_width);
        let trimmed = chunk.trim();
        if trimmed.is_empty() {
            // Defensive: whitespace-only progress cannot loop forever.
            break;
        }
        chunks.push(trimmed.to_string());
        rest = remainder;
    }
    if chunks.is_empty() {
        chunks.push(text.trim().to_string());
    }
    chunks
}

/// Take the largest leading chunk of `rest` that fits `max_width`,
/// preferring the tiers described on [`split_text`]. Returns the chunk and
/// the remaining slice.
fn take_chunk(rest: &str, max_width: usize) -> (String, &str) {
    // Fast path: the whole remainder fits, so no tier is consulted and a
    // short tail never lands in a needless extra chunk.
    if width(rest) <= max_width {
        return (rest.to_string(), "");
    }
    let mut used = 0usize;
    let mut end = 0usize;
    let mut sentence_end = 0usize;
    let mut word_boundary = 0usize;
    for (index, c) in rest.char_indices() {
        let next = used + char_width(c);
        if next > max_width {
            break;
        }
        used = next;
        end = index + c.len_utf8();
        if SENTENCE_ENDS.contains(&c) {
            sentence_end = end;
        }
        if c.is_whitespace() {
            word_boundary = index;
        }
    }
    if end == 0 {
        // The very first glyph already exceeds the budget; take it anyway so
        // the caller always makes progress (the caller's budget floor keeps
        // this unreachable in practice).
        let mut chars = rest.char_indices();
        let first = match chars.next() {
            Some((_, c)) => c.len_utf8(),
            None => return (String::new(), ""),
        };
        return (rest[..first].to_string(), &rest[first..]);
    }
    if sentence_end > 0 {
        return (rest[..sentence_end].to_string(), &rest[sentence_end..]);
    }
    if word_boundary > 0 {
        return (rest[..word_boundary].to_string(), &rest[word_boundary..]);
    }
    (rest[..end].to_string(), &rest[end..])
}

/// Hard truncate to `max_width` columns ending with an ellipsis (the
/// contract's "拆分不可再分时硬截断加 …").
fn truncate_with_ellipsis(text: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::from("…");
    }
    let limit = max_width.saturating_sub(1);
    let mut used = 0usize;
    let mut end = 0usize;
    for (index, c) in text.char_indices() {
        let next = used + char_width(c);
        if next > limit {
            break;
        }
        used = next;
        end = index + c.len_utf8();
    }
    let mut out = text[..end].trim_end().to_string();
    out.push('…');
    out
}

/// Greedy pack rendered segments into messages no wider than `budget`; a
/// segment that somehow exceeds the budget on its own is truncated, so the
/// width invariant holds even for hostile inputs.
fn pack(pieces: Vec<String>, budget: usize) -> Vec<String> {
    let mut messages: Vec<String> = Vec::new();
    let mut current: Option<(String, usize)> = None;
    for piece in pieces {
        if piece.trim().is_empty() {
            continue;
        }
        let piece = if width(&piece) > budget {
            truncate_with_ellipsis(&piece, budget)
        } else {
            piece
        };
        let piece_width = width(&piece);
        match current.take() {
            None => current = Some((piece, piece_width)),
            Some((mut text, used)) => {
                if used + SEPARATOR_WIDTH + piece_width <= budget {
                    text.push_str(SEPARATOR);
                    text.push_str(&piece);
                    current = Some((text, used + SEPARATOR_WIDTH + piece_width));
                } else {
                    messages.push(text);
                    current = Some((piece, piece_width));
                }
            },
        }
    }
    if let Some((text, _)) = current {
        messages.push(text);
    }
    messages
}
#[cfg(test)]
mod tests {
    use super::*;
    use wowsp_tauri_shared::SUPPORTED_LANGS;

    fn options(format: SuffixFormat, suffix_enabled: bool, split_chars: usize) -> ComposeOptions {
        ComposeOptions {
            suffix_enabled,
            suffix_format: format,
            split_chars,
        }
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(lang, text)| ((*lang).to_string(), (*text).to_string()))
            .collect()
    }

    fn assert_messages(messages: &[String], budget: usize) {
        for message in messages {
            assert!(!message.trim().is_empty(), "empty message in {messages:?}");
            assert!(
                width(message) <= budget,
                "message {message:?} is {} columns wide, budget {budget}",
                width(message)
            );
        }
    }

    fn occurrences(haystack: &str, needle: &str) -> usize {
        if needle.is_empty() {
            0
        } else {
            haystack.match_indices(needle).count()
        }
    }

    fn suffix_count(messages: &[String]) -> usize {
        let joined = messages.join(" ");
        SUPPORTED_LANGS
            .iter()
            .map(|lang| occurrences(&joined, suffix_for(lang)))
            .sum()
    }

    /// Visible content of the composed messages: suffixes, continuation
    /// markers, separators and all whitespace removed. The test corpus never
    /// contains "[" or "|", so stripping cannot eat message content.
    fn payload(messages: &[String]) -> String {
        let mut stripped = messages.join(" ");
        for lang in SUPPORTED_LANGS {
            stripped = stripped.replace(suffix_for(lang), "");
        }
        let stripped = strip_markers(&stripped);
        stripped
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '|')
            .collect()
    }

    /// Remove " (i/n)" continuation markers (plus the space in front).
    fn strip_markers(text: &str) -> String {
        let chars: Vec<char> = text.chars().collect();
        let mut out = String::new();
        let mut index = 0usize;
        while index < chars.len() {
            if chars[index] == '(' {
                let mut cursor = index + 1;
                let mut index_digits = 0usize;
                while cursor < chars.len() && chars[cursor].is_ascii_digit() {
                    index_digits += 1;
                    cursor += 1;
                }
                if index_digits > 0 && cursor < chars.len() && chars[cursor] == '/' {
                    cursor += 1;
                    let mut total_digits = 0usize;
                    while cursor < chars.len() && chars[cursor].is_ascii_digit() {
                        total_digits += 1;
                        cursor += 1;
                    }
                    if total_digits > 0 && cursor < chars.len() && chars[cursor] == ')' {
                        if out.ends_with(' ') {
                            out.pop();
                        }
                        index = cursor + 1;
                        continue;
                    }
                }
            }
            out.push(chars[index]);
            index += 1;
        }
        out
    }

    /// Selected + ordered translations exactly as compose picks them.
    fn selected(translations: &[(String, String)]) -> Vec<(String, String)> {
        let mut pairs: Vec<(&str, &str)> = translations
            .iter()
            .map(|(lang, text)| (lang.as_str(), text.as_str()))
            .filter(|(_, text)| !text.trim().is_empty())
            .collect();
        pairs.sort_by(|a, b| language_rank(a.0).cmp(&language_rank(b.0)));
        pairs.dedup_by(|a, b| a.0 == b.0);
        pairs
            .into_iter()
            .map(|(lang, text)| (lang.to_string(), text.to_string()))
            .collect()
    }

    fn expected_payload(translations: &[(String, String)]) -> String {
        selected(translations)
            .into_iter()
            .map(|(_, text)| text)
            .collect::<String>()
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '|')
            .collect()
    }

    fn texts_in_order(messages: &[String]) -> Vec<String> {
        messages
            .iter()
            .flat_map(|message| message.split(SEPARATOR))
            .map(str::trim)
            .filter(|piece| !piece.is_empty())
            .map(str::to_string)
            .collect()
    }

    // ── deterministic corpus ─────────────────────────────────────────────
    // SplitMix64: the property tests need a fixed seed and this crate has no
    // rand dev-dependency (and must not grow one). Every iteration is a pure
    // function of the seed, so a failure reproduces exactly.
    struct SplitMix64(u64);

    impl SplitMix64 {
        fn new(seed: u64) -> Self {
            Self(seed)
        }

        fn next_u64(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }

        fn below(&mut self, bound: usize) -> usize {
            if bound == 0 {
                0
            } else {
                (self.next_u64() % bound as u64) as usize
            }
        }

        fn chance(&mut self) -> bool {
            self.next_u64() & 1 == 1
        }

        fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
            &items[self.below(items.len())]
        }
    }

    const ASCII: &[&str] = &[
        "hello", "world", "push", "mid", "gg", "wp", "attack", "cap", "defend", "lol", "please",
        "nice",
    ];
    const CJK: &[&str] = &[
        "你", "好", "的", "是", "进", "攻", "中", "路", "快", "撤", "敌", "舰",
    ];
    const KANA: &[&str] = &[
        "こん", "にち", "は", "あり", "がと", "う", "進", "撃", "援", "護",
    ];
    const HANGUL: &[&str] = &["안", "녕", "가", "나", "다", "공", "격", "지", "원"];
    const CYRILLIC: &[&str] = &["при", "вет", "ата", "ка", "сей", "час", "огонь"];
    const PUNCT: &[&str] = &["。", "！", "？", "!", "?", ";", ".", ","];

    fn random_text(rng: &mut SplitMix64, max_units: usize) -> String {
        let units = 1 + rng.below(max_units.max(1));
        let mut out = String::new();
        for unit in 0..units {
            let pool = match rng.below(5) {
                0 => ASCII,
                1 => CJK,
                2 => KANA,
                3 => HANGUL,
                _ => CYRILLIC,
            };
            out.push_str(rng.pick(pool));
            if unit + 1 < units && rng.chance() {
                out.push(' ');
            }
            if rng.below(8) == 0 {
                out.push_str(rng.pick(PUNCT));
            }
        }
        out
    }

    fn random_langs(rng: &mut SplitMix64, count: usize) -> Vec<String> {
        let mut pool: Vec<&str> = SUPPORTED_LANGS.to_vec();
        for index in (1..pool.len()).rev() {
            let swap = rng.below(index + 1);
            pool.swap(index, swap);
        }
        pool.into_iter().take(count).map(str::to_string).collect()
    }

    // ── display width ────────────────────────────────────────────────────
    #[test]
    fn width_counts_east_asian_glyphs_as_two_columns() {
        assert_eq!(width(""), 0);
        assert_eq!(width("abc"), 3);
        assert_eq!(width("你好"), 4);
        assert_eq!(width("こんにちは"), 10);
        assert_eq!(width("안녕"), 4);
        assert_eq!(width("Привет"), 6);
        assert_eq!(width("🎉"), 2);
        assert_eq!(width("ａ"), 2, "fullwidth ASCII is two columns");
        assert_eq!(width("a你b"), 4);
    }

    // ── suffix table cross-check (W1 owns the strings) ────────────────────
    #[test]
    fn suffix_table_matches_the_contract() {
        assert_eq!(suffix_for("zh-TW"), "[WOWSP同聲傳譯]");
        assert_eq!(suffix_for("ja"), "[WOWSP同時通訳]");
        assert_eq!(suffix_for("en"), "[WOWSP live translation]");
        assert_eq!(suffix_for("de"), "[WOWSP Simultandolmetschen]");
        for lang in SUPPORTED_LANGS {
            let suffix = suffix_for(lang);
            assert!(suffix.starts_with("[WOWSP"), "{lang}: {suffix}");
            // The contract's 32-character cap counts the brand text inside
            // the brackets (the brackets themselves are fixed chrome).
            let inner = suffix.trim_matches(|c| c == '[' || c == ']');
            assert!(
                inner.chars().count() <= 32,
                "{lang}: {suffix} over 32 chars"
            );
        }
    }

    // ── exact layouts ────────────────────────────────────────────────────
    #[test]
    fn per_segment_layout_orders_priority_and_attaches_suffixes() {
        let translations = pairs(&[("ja", "こんにちは"), ("zh-TW", "你好"), ("de", "Hallo")]);
        let opts = options(SuffixFormat::PerSegment, true, 138);
        assert_eq!(
            compose_outgoing("ignored original", &translations, &opts),
            vec![
                "你好 [WOWSP同聲傳譯] | こんにちは [WOWSP同時通訳] | Hallo [WOWSP Simultandolmetschen]"
            ]
        );
    }

    #[test]
    fn unified_layout_joins_and_appends_the_first_suffix_once() {
        let translations = pairs(&[("ja", "こんにちは"), ("zh-TW", "你好"), ("de", "Hallo")]);
        let opts = options(SuffixFormat::Unified, true, 138);
        let messages = compose_outgoing("ignored original", &translations, &opts);
        assert_eq!(messages, vec!["你好 | こんにちは | Hallo [WOWSP同聲傳譯]"]);
        assert_eq!(suffix_count(&messages), 1);
    }

    #[test]
    fn suffix_disabled_emits_bare_translations() {
        let translations = pairs(&[("ja", "こんにちは"), ("zh-TW", "你好")]);
        let opts = options(SuffixFormat::PerSegment, false, 138);
        assert_eq!(
            compose_outgoing("", &translations, &opts),
            vec!["你好 | こんにちは"]
        );
        assert_eq!(suffix_count(&compose_outgoing("", &translations, &opts)), 0);
    }

    #[test]
    fn family_priority_precedes_alphabetical_others() {
        // en is in the fixed family, so it precedes es/it; zh-TW leads.
        let translations = pairs(&[
            ("it", "ciao"),
            ("en", "hello"),
            ("es", "hola"),
            ("zh-TW", "你好"),
        ]);
        let opts = options(SuffixFormat::PerSegment, false, 138);
        assert_eq!(
            texts_in_order(&compose_outgoing("", &translations, &opts)),
            vec!["你好", "hello", "hola", "ciao"]
        );
    }

    #[test]
    fn duplicate_and_empty_translations_are_dropped() {
        let translations = pairs(&[("ja", "first"), ("ja", "second"), ("de", "   "), ("", "")]);
        let opts = options(SuffixFormat::PerSegment, false, 138);
        assert_eq!(compose_outgoing("", &translations, &opts), vec!["first"]);
        assert!(compose_outgoing("", &pairs(&[]), &opts).is_empty());
        assert!(compose_outgoing("", &pairs(&[("ja", "  ")]), &opts).is_empty());
    }

    #[test]
    fn the_player_original_never_reaches_the_messages() {
        let translations = pairs(&[("ja", "訳")]);
        let opts = options(SuffixFormat::PerSegment, false, 138);
        let with_original = compose_outgoing("my own line", &translations, &opts);
        let without_original = compose_outgoing("", &translations, &opts);
        assert_eq!(with_original, without_original);
        assert_eq!(with_original, vec!["訳"]);
    }

    // ── splitting ────────────────────────────────────────────────────────
    #[test]
    fn long_texts_split_at_sentence_ends_with_continuation_markers() {
        let translations = pairs(&[("ja", "第一句。第二句。第三句。")]);
        let opts = options(SuffixFormat::PerSegment, false, 20);
        let messages = compose_outgoing("", &translations, &opts);
        assert_eq!(
            messages,
            vec!["第一句。 (1/3)", "第二句。 (2/3)", "第三句。 (3/3)"]
        );
        assert_messages(&messages, 20);
        assert_eq!(payload(&messages), expected_payload(&translations));
    }

    #[test]
    fn split_falls_back_to_word_boundaries_then_hard_cuts() {
        let translations = pairs(&[
            ("en", "hello world again and again and again"),
            ("ja", "abcdefghijklmnopqrstuvwxyz"),
        ]);
        let opts = options(SuffixFormat::PerSegment, false, 20);
        let messages = compose_outgoing("", &translations, &opts);
        assert_messages(&messages, 20);
        assert_eq!(payload(&messages), expected_payload(&translations));
        // The word-boundary tier keeps whole words where the budget allows.
        assert!(messages.iter().any(|message| message.contains("hello")));
        assert!(messages.iter().any(|message| message.contains("again")));
    }

    #[test]
    fn continuation_chunks_still_carry_the_suffix_layout() {
        let translations = pairs(&[("ja", "あいうえおかきくけこさしすせそたちつてと")]);
        let opts = options(SuffixFormat::PerSegment, true, 40);
        let messages = compose_outgoing("", &translations, &opts);
        assert_messages(&messages, 40);
        assert!(messages.len() > 1);
        for message in &messages {
            assert!(
                message.contains(suffix_for("ja")),
                "{message:?} misses the suffix"
            );
            assert!(message.contains('('), "{message:?} misses the marker");
        }
        assert_eq!(payload(&messages), expected_payload(&translations));
    }

    #[test]
    fn extreme_budgets_drop_the_suffix_before_the_content() {
        // pl's suffix costs 34 columns including its leading space; a
        // 40-column budget cannot host a continuation marker + glyph +
        // suffix, so the oversized translation splits WITHOUT the suffix
        // instead of truncating the line (width + content win).
        let translations = pairs(&[(
            "pl",
            "To jest bardzo długi polski tekst o okrętach i bitwach morskich",
        )]);
        let opts = options(SuffixFormat::PerSegment, true, 40);
        let messages = compose_outgoing("", &translations, &opts);
        assert_messages(&messages, 40);
        assert!(messages.len() > 1);
        assert!(
            !messages.iter().any(|message| message.contains('…')),
            "content must survive: {messages:?}"
        );
        assert_eq!(suffix_count(&messages), 0);
        assert_eq!(payload(&messages), expected_payload(&translations));
    }

    /// Regression (R2 BLOCKER): a 400-char CJK translation at the smallest
    /// production budget (40 columns) needs well over 32 chunks. The count
    /// loop must converge and emit EVERY chunk — never degrade to a single
    /// ellipsis chunk that silently drops 98% of the content.
    #[test]
    fn many_chunk_translations_keep_all_content() {
        let long = "舰".repeat(400);
        let translations = pairs(&[("zh-CN", long.as_str())]);
        let opts = options(SuffixFormat::PerSegment, true, 40);
        let messages = compose_outgoing("", &translations, &opts);
        assert_messages(&messages, 40);
        assert!(
            messages.len() > 32,
            "expected the full chunk fan-out, got {} messages: {messages:?}",
            messages.len()
        );
        assert!(
            !messages.iter().any(|message| message.contains('…')),
            "content must survive wholesale: {messages:?}"
        );
        assert_eq!(payload(&messages), expected_payload(&translations));
    }

    #[test]
    fn impossible_budgets_still_never_emit_empty_messages() {
        // Far below the production floor (40 columns): the kernel must
        // degrade to a truncated, non-empty message instead of panicking or
        // emitting "".
        let translations = pairs(&[("ja", "你好世界")]);
        let opts = options(SuffixFormat::PerSegment, false, 4);
        let messages = compose_outgoing("", &translations, &opts);
        assert!(!messages.is_empty());
        assert_messages(&messages, 4);
    }

    // ── property tests (fixed seeds) ─────────────────────────────────────
    #[test]
    fn random_layouts_keep_the_width_and_content_contract() {
        let mut rng = SplitMix64::new(0xC0FF_EE12_3456_789A);
        for case in 0..300 {
            let count = 1 + rng.below(6);
            let langs = random_langs(&mut rng, count);
            let translations: Vec<(String, String)> = langs
                .iter()
                .map(|lang| (lang.clone(), random_text(&mut rng, 24)))
                .collect();
            let suffix_enabled = rng.chance();
            let format = if rng.chance() {
                SuffixFormat::PerSegment
            } else {
                SuffixFormat::Unified
            };
            let split_chars = 40 + rng.below(99); // 40..=138 per the settings clamp
            let opts = options(format, suffix_enabled, split_chars);
            let messages = compose_outgoing("own line", &translations, &opts);
            assert!(!messages.is_empty(), "case {case}: nothing composed");
            assert_messages(&messages, split_chars);
            // Contract-sanctioned degradation: a budget too small for the
            // suffix + marker + one glyph, or a unified line whose reserved
            // suffix leaves no content room, hard-truncates and marks the
            // line with "…" — content is then best-effort by definition.
            let truncated = messages.iter().any(|message| message.contains('…'));
            if !truncated {
                assert_eq!(
                    payload(&messages),
                    expected_payload(&translations),
                    "case {case}: content drift for {translations:?} with {opts:?}"
                );
            }
            let widest_suffix = SUPPORTED_LANGS
                .iter()
                .map(|lang| 1 + width(suffix_for(lang)))
                .max()
                .unwrap_or(0);
            let suffix_room = widest_suffix + MIN_CONTENT_WITH_MARKER <= split_chars;
            let suffixes = suffix_count(&messages);
            if !suffix_enabled {
                assert_eq!(suffixes, 0, "case {case}: suffix leaked");
            } else if format == SuffixFormat::PerSegment && !suffix_room {
                // Extreme corner: the suffix is dropped for oversized
                // translations (content + width win). Presence is best-effort.
            } else if format == SuffixFormat::PerSegment {
                // Every rendered segment carries its language suffix, so each
                // message has at least one and the total is >= the number of
                // translations (a split translation adds more).
                for message in &messages {
                    assert!(
                        SUPPORTED_LANGS
                            .iter()
                            .any(|lang| message.contains(suffix_for(lang))),
                        "case {case}: {message:?} lacks a suffix"
                    );
                }
                assert!(
                    suffixes >= selected(&translations).len(),
                    "case {case}: {suffixes} suffixes for {translations:?}"
                );
            } else {
                // Unified: exactly one suffix, closing the last message.
                assert_eq!(suffixes, 1, "case {case}");
                let first = selected(&translations)
                    .first()
                    .map(|(lang, _)| suffix_for(lang))
                    .expect("non-empty selection");
                assert!(
                    messages.last().expect("non-empty").ends_with(first),
                    "case {case}: unified suffix missing"
                );
            }
        }
    }

    #[test]
    fn random_short_lines_keep_priority_order_and_one_suffix_per_segment() {
        let mut rng = SplitMix64::new(0x5EED_5EED_5EED_5EED);
        for case in 0..200 {
            let count = 1 + rng.below(6);
            let langs = random_langs(&mut rng, count);
            let translations: Vec<(String, String)> = langs
                .iter()
                .map(|lang| (lang.clone(), format!("t{}", rng.below(900))))
                .collect();
            // Suffix off: the segments are the bare texts, so the order is
            // directly readable.
            let opts = options(SuffixFormat::PerSegment, false, 138);
            let messages = compose_outgoing("", &translations, &opts);
            assert_messages(&messages, 138);
            let got = texts_in_order(&messages);
            let want: Vec<String> = selected(&translations)
                .into_iter()
                .map(|(_, text)| text)
                .collect();
            assert_eq!(got, want, "case {case}: priority order drifted");

            // Suffix on: each language's suffix appears exactly once per
            // segment (these lines never split).
            let opts = options(SuffixFormat::PerSegment, true, 138);
            let messages = compose_outgoing("", &translations, &opts);
            assert_messages(&messages, 138);
            let joined = messages.join(" ");
            for (lang, _) in selected(&translations) {
                assert_eq!(
                    occurrences(&joined, suffix_for(&lang)),
                    1,
                    "case {case}: {lang} suffix count"
                );
            }
        }
    }

    #[test]
    fn random_unified_layouts_put_one_suffix_at_the_tail() {
        let mut rng = SplitMix64::new(0xABCD_EF01_2345_6789);
        for case in 0..100 {
            let count = 1 + rng.below(6);
            let langs = random_langs(&mut rng, count);
            let translations: Vec<(String, String)> = langs
                .iter()
                .map(|lang| (lang.clone(), random_text(&mut rng, 12)))
                .collect();
            let opts = options(SuffixFormat::Unified, true, 60 + rng.below(79));
            let messages = compose_outgoing("", &translations, &opts);
            assert_messages(&messages, opts.split_chars);
            assert_eq!(suffix_count(&messages), 1, "case {case}");
            let first = selected(&translations)
                .first()
                .map(|(lang, _)| suffix_for(lang))
                .expect("non-empty selection");
            assert!(
                messages.last().expect("non-empty").ends_with(first),
                "case {case}: {messages:?}"
            );
            assert_eq!(
                payload(&messages),
                expected_payload(&translations),
                "case {case}"
            );
        }
    }
}
