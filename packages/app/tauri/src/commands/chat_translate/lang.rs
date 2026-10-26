//! Local chat-line language detection (M1 W1) — the pure, network-free first
//! stage of the chat-translation pipeline.
//!
//! One decoded battle-chat line goes in; a [LangVerdict] comes out: either
//! "this is in a language the user does not read, translate it" or "leave it
//! alone" plus the diagnostic reason. Everything here is a pure function (no
//! IO, no clock, no network) so the whole rule set is unit-tested in this
//! file — the translation request itself is a later stage.
//!
//! ## Rule order (contract §2 — the order is load-bearing)
//!
//! 1. pre-clean: trim the line; embedded control characters are ignored by
//!    every rule (they are neither alphanumeric nor letters);
//! 2. [VerdictReason::TooShort] — fewer effective characters (letters,
//!    digits, ideographs; whitespace/punctuation excluded) than the caller's
//!    `min_chars` (the settings' `detect.minChars`, clamped 1..=20 there);
//! 3. [VerdictReason::Command] — a game chat command (`/…`);
//! 4. [VerdictReason::Url] — `:://` anywhere, or a lone `www.` token;
//! 5. [VerdictReason::SymbolsOnly] — punctuation/whitespace/emoji only (the
//!    digit-only line lands here too: nothing in it is translatable);
//! 6. [VerdictReason::Filler] — the whole line is chat filler ("gg", "gl hf",
//!    "wp", "o7", …), case/punctuation/emoji tolerated;
//! 7. [VerdictReason::OwnEcho] — our own translated output echoed back (see
//!    [looks_like_own_echo]; W3's compose stage reuses the same predicate);
//! 8. script census — hand-written Unicode range buckets for Han, Hiragana,
//!    Katakana, Hangul, Cyrillic, Greek, Thai, Latin, Arabic and "other
//!    alphabetic"; plus the Hans/Hant exclusive-character counts;
//! 9. expected-script sets per `own_lang` (`expected_scripts` below);
//! 10. decision:
//!     - a non-Latin script outside the expected set → [Verdict::Translate]
//!       with [VerdictReason::ForeignScript] (script_hint names the language
//!       the script maps onto: Hangul→ko, kana→ja, Thai→th, Cyrillic→ru,
//!       pure Han→the Hans/Hant heuristic);
//!     - own Latin-family + Latin-only line: an own-language stopword → skip
//!       as [VerdictReason::SameLangStopwords], else translate as
//!       [VerdictReason::LatinForeign] (a different Latin-script language);
//!     - own non-Latin + Latin-only line → LatinForeign;
//!     - own non-Latin + expected scripts only → SameLangStopwords;
//!     - Zh-family own: a Hans/Hant variant mismatch is FOREIGN even though
//!       both variants are Han — the exclusive-character heuristic (rule 8)
//!       would otherwise never fire, and a Simplified-Chinese reader must see
//!       a Traditional-Chinese line translated (the feature's motivating
//!       case; this is the one deliberate refinement of the literal rule 10,
//!       marked at [detect_line]'s decision block).
//!
//! `script_hint` is only a HINT: pure Latin text cannot name a v1 language,
//! ambiguous Han (no exclusive characters) is deliberately `None`, and the
//! model's own `detected` field stays the authority for those.
//!
//! ## Wiring status
//!
//! W1 lands the detector before the prompt/request (W2) and compose (W3)
//! stages; the module has no in-crate caller yet, so `dead_code` is allowed
//! for this file until those stages import it (the full test suite below
//! exercises every function).
#![allow(dead_code)]

use wowsp_tauri_shared::{LangScript, LangVerdict, SUPPORTED_LANGS, Verdict, VerdictReason};

use wowsp_tauri_shared::VerdictReason::{
    Command, Filler, ForeignScript, LatinForeign, OwnEcho, SameLangStopwords, SymbolsOnly,
    TooShort, Url,
};

// ── Outgoing suffix table (contract §4 — verbatim) ───────────────────────
//
// Brand marker + the target language's own name for "live translation". W3's
// compose stage appends exactly this string; W1 owns the table so the echo
// check and the composer can never drift apart.

/// The English suffix (fallback for unknown/empty target tags).
const SUFFIX_EN: &str = "[WOWSP live translation]";

/// 17 target languages → the outgoing-message suffix, contract §4 verbatim.
const SUFFIXES: &[(&str, &str)] = &[
    ("zh-CN", "[WOWSP同声传译]"),
    ("zh-TW", "[WOWSP同聲傳譯]"),
    ("ja", "[WOWSP同時通訳]"),
    ("ko", "[WOWSP동시통역]"),
    ("ru", "[WOWSP синхроперевод]"),
    ("en", SUFFIX_EN),
    ("de", "[WOWSP Simultandolmetschen]"),
    ("fr", "[WOWSP traduction simultanée]"),
    ("es", "[WOWSP traducción simultánea]"),
    ("it", "[WOWSP traduzione simultanea]"),
    ("pl", "[WOWSP tłumaczenie symultaniczne]"),
    ("cs", "[WOWSP simultánní překlad]"),
    ("tr", "[WOWSP eşzamanlı çeviri]"),
    ("pt", "[WOWSP tradução simultânea]"),
    ("uk", "[WOWSP синхронний переклад]"),
    ("th", "[WOWSP แปลสด]"),
    ("vi", "[WOWSP dịch đồng thời]"),
];

/// The suffix appended to an outgoing translated segment for [lang].
///
/// W3's `compose_outgoing` imports this. Unknown/empty tags (a future
/// language, a junk config value) fall back to the English marker: the
/// outgoing path must always be able to label its own messages, and the echo
/// check below scans the same table.
pub(crate) fn suffix_for(lang: &str) -> &'static str {
    normalize_lang(lang)
        .and_then(|tag| {
            SUFFIXES
                .iter()
                .find(|(code, _)| *code == tag)
                .map(|(_, suffix)| *suffix)
        })
        .unwrap_or(SUFFIX_EN)
}

/// Whether [text] is one of OUR OWN outgoing messages echoed back through the
/// chat stream (or replayed from the live-temp-replay chat decode).
///
/// Two shapes count (contract §2 rule 7 / §4):
/// - it contains ANY of the known suffix strings from [SUFFIXES] (compared
///   case-insensitively, so a client that re-cases Latin text still matches);
/// - it matches the composed shape "<segment> | <segment> [WOWSP…]" — a
///   multi-segment message whose last segment ends with a bracketed marker
///   and that carries the WOWSP brand anywhere (this also catches a suffix
///   from a language newer than this build).
///
/// W3's compose stage imports this so the outgoing composer can refuse to
/// translate its own output when it is injected back into the chat stream.
pub(crate) fn looks_like_own_echo(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_lowercase();
    if SUFFIXES
        .iter()
        .any(|(_, suffix)| lower.contains(&suffix.to_lowercase()))
    {
        return true;
    }
    trimmed.contains(" | ") && trimmed.ends_with(']') && lower.contains("wowsp")
}

// ── Canonical language tags ──────────────────────────────────────────────

/// Canonical short tag for a caller-provided language, or `None` when it is
/// empty/unknown.
///
/// Accepts the 17 [SUPPORTED_LANGS] tags in any case plus the common BCP-47
/// spellings a UI locale or a hand-edited config can carry ("ja-JP",
/// "en_US", "pt-BR", "zh-Hant"). A compound tag whose primary subtag is a
/// supported language resolves to that language — the primary subtag is the
/// best answer for "en-AU"/"es-419"/… and the settings' self-language is a
/// user preference, not a precise regional claim.
pub(crate) fn normalize_lang(raw: &str) -> Option<&'static str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase().replace('_', "-");
    let primary = lower.split('-').next().unwrap_or("");
    if primary == "zh" {
        // Chinese collapses by SCRIPT: Hant/TW/HK/MO → zh-TW, everything
        // else → zh-CN (the same rule the webui's locale matcher uses).
        let traditional = lower.contains("hant")
            || lower.contains("-tw")
            || lower.contains("-hk")
            || lower.contains("-mo");
        return Some(if traditional { "zh-TW" } else { "zh-CN" });
    }
    SUPPORTED_LANGS
        .iter()
        .copied()
        .find(|tag| tag.to_ascii_lowercase() == primary)
}

// ── Unicode script buckets ───────────────────────────────────────────────

const HAN: u32 = 1 << 0;
const HIRAGANA: u32 = 1 << 1;
const KATAKANA: u32 = 1 << 2;
const HANGUL: u32 = 1 << 3;
const CYRILLIC: u32 = 1 << 4;
const GREEK: u32 = 1 << 5;
const THAI: u32 = 1 << 6;
const LATIN: u32 = 1 << 7;
const ARABIC: u32 = 1 << 8;
const OTHER: u32 = 1 << 9;

/// The non-Latin buckets checked for the "foreign script" rule, in the
/// contract's decision order (Latin is handled by the Latin-family branch,
/// never as a foreign SCRIPT — an English reader seeing Spanish gets
/// [VerdictReason::LatinForeign], not [VerdictReason::ForeignScript]).
const NON_LATIN_SCRIPTS: &[LangScript] = &[
    LangScript::Han,
    LangScript::Hiragana,
    LangScript::Katakana,
    LangScript::Hangul,
    LangScript::Cyrillic,
    LangScript::Greek,
    LangScript::Thai,
    LangScript::Arabic,
    LangScript::Other,
];

fn script_bit(script: LangScript) -> u32 {
    match script {
        LangScript::Han => HAN,
        LangScript::Hiragana => HIRAGANA,
        LangScript::Katakana => KATAKANA,
        LangScript::Hangul => HANGUL,
        LangScript::Cyrillic => CYRILLIC,
        LangScript::Greek => GREEK,
        LangScript::Thai => THAI,
        LangScript::Latin => LATIN,
        LangScript::Arabic => ARABIC,
        LangScript::Other => OTHER,
    }
}

/// Which script family a single character belongs to — hand-written ranges
/// (no unicode-property dependency). `None` for digits (ASCII), punctuation,
/// whitespace, combining marks and symbols.
///
/// Notes:
/// - Han covers the BMP ideographs, the extension planes, 々 (iteration) and
///   〇; Japanese kanji is Han by design — kana presence is what tells the
///   two languages apart.
/// - Arabic includes the Arabic-Indic digits (U+0660-U+0669, U+06F0-U+06F9):
///   they are a strong script signal even though they are digits.
/// - Anything alphabetic that matches no bucket (Hebrew, Devanagari, …)
///   lands in [LangScript::Other], which the foreign-script rule treats as
///   foreign (v1 has no language tag for it, so `script_hint` stays None).
fn script_of(c: char) -> Option<LangScript> {
    let u = c as u32;
    // Han ideographs (+ 々 U+3005, 〇 U+3007).
    if matches!(
        u,
        0x3005 | 0x3007 | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x2FA1F
    ) {
        return Some(LangScript::Han);
    }
    if matches!(u, 0x3040..=0x309F) {
        return Some(LangScript::Hiragana);
    }
    if matches!(u, 0x30A0..=0x30FF | 0x31F0..=0x31FF | 0xFF66..=0xFF9D) {
        return Some(LangScript::Katakana);
    }
    if matches!(
        u,
        0x1100..=0x11FF | 0x3130..=0x318F | 0xA960..=0xA97F | 0xAC00..=0xD7AF | 0xD7B0..=0xD7FF
    ) {
        return Some(LangScript::Hangul);
    }
    if matches!(u, 0x0400..=0x052F | 0x1C80..=0x1C8F | 0x2DE0..=0x2DFF | 0xA640..=0xA69F) {
        return Some(LangScript::Cyrillic);
    }
    if matches!(u, 0x0370..=0x03FF | 0x1F00..=0x1FFF) {
        return Some(LangScript::Greek);
    }
    if matches!(u, 0x0E00..=0x0E7F) {
        return Some(LangScript::Thai);
    }
    if matches!(
        u,
        0x0600..=0x06FF
            | 0x0750..=0x077F
            | 0x08A0..=0x08FF
            | 0xFB50..=0xFDFF
            | 0xFE70..=0xFEFF
    ) {
        return Some(LangScript::Arabic);
    }
    if matches!(
        u,
        0x0041..=0x005A
            | 0x0061..=0x007A
            | 0x00C0..=0x024F
            | 0x1E00..=0x1EFF
            | 0x2C60..=0x2C7F
            | 0xA720..=0xA7FF
            | 0xFB00..=0xFB06
            | 0xFF21..=0xFF3A
            | 0xFF41..=0xFF5A
    ) {
        return Some(LangScript::Latin);
    }
    if c.is_alphabetic() {
        return Some(LangScript::Other);
    }
    None
}

// ── Hans/Hant exclusive-character heuristic ──────────────────────────────

/// Characters used ONLY by Traditional Chinese (a hand-curated ~60-char
/// high-frequency set). Each entry was chosen to be absent from Japanese
/// standard (shinjitai) usage where possible, so a kanji-only Japanese line
/// does not read as Traditional Chinese; the Japanese-only exclusive forms
/// that ARE shared with kanji (時/門/間/語/書/… — see the module docs) are
/// deliberately NOT listed.
const TRADITIONAL_EXCLUSIVE: &str = "們說對發讀齊齒龍這與麼樣還兒賣聽學國圖團體會髮鬥戰爭覺讓嗎來醫藥處辦沒寫裡壞單雜鐵彈擊驅舉錢傳價僅從眾帶幫關舊雖隨歸歡樂歲變邊點滿預證據圍藝顯顏驗黨鬆";

/// Characters used ONLY by Simplified Chinese — the same curation rule: no
/// character the Japanese standard also uses (国/学/会/体/来/乱/点/习… are
/// deliberately absent).
const SIMPLIFIED_EXCLUSIVE: &str = "这们说对发读齐齿龙么样还儿卖听图团边变欢乐岁归带帮关旧虽随仅从众传价战争觉让吗药处办没坏单杂铁弹击驱举见现长门间语书风飞马车贝时话个为应该过进头买东电视园远别爱师张开无阳阴际陆队阶亿优伟伤谁请谢认识讲课费货亲热难网线钱银军舰满预证据围艺显颜验党";

// ── Chat filler ──────────────────────────────────────────────────────────

/// Whole-line chat filler that carries no content worth a request (contract
/// §2 rule 6 requires ≥25; the list is English/abbreviation-based because the
/// in-game battle chat is). Matched after case folding + punctuation/emoji
/// stripping, so "GG WP!", "thx 👍" and "gl hf" all hit.
const FILLERS: &[&str] = &[
    "afk",
    "brb",
    "cya",
    "gg",
    "gg wp",
    "ggwp",
    "gj",
    "gl",
    "gl hf",
    "glhf",
    "good game",
    "good luck",
    "hello",
    "hey",
    "hf",
    "hi",
    "k",
    "lmao",
    "lol",
    "nice",
    "nice job",
    "no",
    "no problem",
    "np",
    "o7",
    "ok",
    "okay",
    "omg",
    "rofl",
    "see you",
    "sup",
    "thank you",
    "thanks",
    "thx",
    "ty",
    "well done",
    "well played",
    "wp",
    "wow",
    "yes",
    "yo",
];

// ── Latin-language stopwords ─────────────────────────────────────────────
//
// The own-language test for Latin-script languages: a line with a hit in the
// caller's own table reads as the caller's language (skip); no hit means a
// different Latin language (translate). ~20 high-frequency function words per
// language (contract §2 rule 10). Tables are lowercase; matching folds the
// text to lowercase words first.

const EN_STOPWORDS: &[&str] = &[
    "the", "you", "are", "and", "is", "not", "we", "to", "of", "in", "that", "it", "for", "on",
    "with", "this", "but", "they", "have", "what",
];
const DE_STOPWORDS: &[&str] = &[
    "der", "die", "das", "und", "nicht", "ist", "ich", "du", "wir", "sie", "ein", "eine", "zu",
    "mit", "auf", "für", "von", "den", "dem", "es",
];
const FR_STOPWORDS: &[&str] = &[
    "le", "la", "les", "est", "pas", "et", "un", "une", "des", "du", "je", "tu", "il", "elle",
    "nous", "vous", "que", "qui", "dans", "pour",
];
const ES_STOPWORDS: &[&str] = &[
    "el", "la", "los", "las", "que", "es", "un", "una", "de", "en", "por", "para", "con", "yo",
    "tú", "él", "nosotros", "pero", "muy", "no",
];
const IT_STOPWORDS: &[&str] = &[
    "il", "lo", "la", "che", "non", "sono", "è", "un", "una", "di", "del", "della", "per", "con",
    "io", "tu", "lui", "noi", "voi", "ma",
];
const PL_STOPWORDS: &[&str] = &[
    "nie", "jest", "to", "si", "tak", "i", "w", "na", "z", "do", "że", "jak", "ale", "co", "ja",
    "ty", "on", "my", "wy", "oni",
];
const CS_STOPWORDS: &[&str] = &[
    "není", "že", "se", "to", "a", "v", "na", "je", "jsem", "jsi", "ale", "jak", "co", "když",
    "pro", "od", "do", "s", "z", "mi",
];
const TR_STOPWORDS: &[&str] = &[
    "bir", "bu", "değil", "ve", "ne", "için", "ben", "sen", "o", "biz", "siz", "onlar", "da", "de",
    "mi", "mı", "çok", "daha", "var", "yok",
];
const PT_STOPWORDS: &[&str] = &[
    "não", "você", "é", "o", "a", "os", "as", "de", "em", "para", "com", "por", "que", "um", "uma",
    "eu", "ele", "ela", "nós", "mas",
];
const VI_STOPWORDS: &[&str] = &[
    "và", "của", "là", "không", "có", "được", "cho", "với", "này", "người", "những", "để", "khi",
    "tôi", "bạn", "anh", "em", "chúng", "một", "hai",
];

fn latin_stopwords(lang: &str) -> Option<&'static [&'static str]> {
    match lang {
        "en" => Some(EN_STOPWORDS),
        "de" => Some(DE_STOPWORDS),
        "fr" => Some(FR_STOPWORDS),
        "es" => Some(ES_STOPWORDS),
        "it" => Some(IT_STOPWORDS),
        "pl" => Some(PL_STOPWORDS),
        "cs" => Some(CS_STOPWORDS),
        "tr" => Some(TR_STOPWORDS),
        "pt" => Some(PT_STOPWORDS),
        // Vietnamese is also a Latin-script v1 language; the contract's
        // 9-family table omits it, but without a table every Vietnamese line
        // would read as foreign to a Vietnamese player.
        "vi" => Some(VI_STOPWORDS),
        _ => None,
    }
}

/// Whether the caller's own language is a Latin-script one (the stopword
/// judgement only makes sense there; Cyrillic Ukrainian is deliberately not
/// in this family).
fn is_latin_family(lang: &str) -> bool {
    matches!(
        lang,
        "en" | "de" | "fr" | "es" | "it" | "pl" | "cs" | "tr" | "pt" | "vi"
    )
}

/// The script families a speaker of `own` is expected to read without help.
/// `0` = unknown own language: no expectation, so any script reads foreign.
fn expected_scripts(own: Option<&'static str>) -> u32 {
    match own {
        None => 0,
        // Both Chinese scripts are Han; rule 8's exclusive-character
        // heuristic refines the variant inside the decision block.
        Some("zh-CN" | "zh-TW") => HAN,
        Some("ja") => HAN | HIRAGANA | KATAKANA,
        Some("ko") => HANGUL | HAN,
        // Ukrainian is a Cyrillic language. The contract's §2 rule 9 lists
        // "uk → Latin" but its own rule 10 notes "uk 属 Cyrillic"; a
        // Latin-only expected set would flag a Ukrainian player's own
        // messages as foreign, so Cyrillic wins.
        Some("ru" | "uk") => CYRILLIC | LATIN,
        Some("th") => THAI,
        Some("en" | "de" | "fr" | "es" | "it" | "pl" | "cs" | "tr" | "pt" | "vi") => LATIN,
        Some(_) => 0,
    }
}

// ── Script census ────────────────────────────────────────────────────────

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct ScriptCounts {
    han: usize,
    hiragana: usize,
    katakana: usize,
    hangul: usize,
    cyrillic: usize,
    greek: usize,
    thai: usize,
    latin: usize,
    arabic: usize,
    other: usize,
    /// Char count from [TRADITIONAL_EXCLUSIVE] (Han chars only).
    traditional_exclusive: usize,
    /// Char count from [SIMPLIFIED_EXCLUSIVE] (Han chars only).
    simplified_exclusive: usize,
}

impl ScriptCounts {
    fn add(&mut self, script: LangScript) {
        match script {
            LangScript::Han => self.han += 1,
            LangScript::Hiragana => self.hiragana += 1,
            LangScript::Katakana => self.katakana += 1,
            LangScript::Hangul => self.hangul += 1,
            LangScript::Cyrillic => self.cyrillic += 1,
            LangScript::Greek => self.greek += 1,
            LangScript::Thai => self.thai += 1,
            LangScript::Latin => self.latin += 1,
            LangScript::Arabic => self.arabic += 1,
            LangScript::Other => self.other += 1,
        }
    }

    fn get(&self, script: LangScript) -> usize {
        match script {
            LangScript::Han => self.han,
            LangScript::Hiragana => self.hiragana,
            LangScript::Katakana => self.katakana,
            LangScript::Hangul => self.hangul,
            LangScript::Cyrillic => self.cyrillic,
            LangScript::Greek => self.greek,
            LangScript::Thai => self.thai,
            LangScript::Latin => self.latin,
            LangScript::Arabic => self.arabic,
            LangScript::Other => self.other,
        }
    }

    fn kana(&self) -> usize {
        self.hiragana + self.katakana
    }

    fn total_letters(&self) -> usize {
        self.han
            + self.hiragana
            + self.katakana
            + self.hangul
            + self.cyrillic
            + self.greek
            + self.thai
            + self.latin
            + self.arabic
            + self.other
    }

    /// Whether every letter is Han (the only shape the Hans/Hant heuristic
    /// applies to; "變了 GG" is not "pure Han").
    fn only_han(&self) -> bool {
        self.han > 0 && self.total_letters() == self.han
    }

    /// Letters in the scripts the own language is written in — used to tell
    /// "the whole Latin-only line is foreign" from "mixed own script + Latin"
    /// for non-Latin callers.
    fn own_script_letters(&self, own: &str) -> usize {
        match own {
            "ja" => self.han + self.kana(),
            "ko" => self.hangul + self.han,
            "ru" | "uk" => self.cyrillic,
            "th" => self.thai,
            _ => self.han,
        }
    }
}

fn census(text: &str) -> ScriptCounts {
    let mut counts = ScriptCounts::default();
    for c in text.chars() {
        if let Some(script) = script_of(c) {
            counts.add(script);
        }
        if TRADITIONAL_EXCLUSIVE.contains(c) {
            counts.traditional_exclusive += 1;
        }
        if SIMPLIFIED_EXCLUSIVE.contains(c) {
            counts.simplified_exclusive += 1;
        }
    }
    counts
}

/// Hans vs Hant from the exclusive-character counts (contract §2 rule 8):
/// more Traditional-exclusive chars → zh-TW; otherwise a Simplified-exclusive
/// hit → zh-CN; no exclusive characters at all → `None` (ambiguous Han is
/// handed to the model's `detected` field).
fn han_variant_hint(counts: &ScriptCounts) -> Option<&'static str> {
    if counts.traditional_exclusive > counts.simplified_exclusive {
        return Some("zh-TW");
    }
    if counts.simplified_exclusive > 0 {
        return Some("zh-CN");
    }
    None
}

/// The language `script_hint` names for a line, in the contract's mapping
/// order (Hangul first, then kana, Thai, Cyrillic, then pure Han via the
/// exclusive-character heuristic). Only scripts OUTSIDE the caller's
/// expected set are named — a mixed "Привет 你好" read by a ru speaker is
/// foreign because of the HAN, and naming "ru" (the reader's own script,
/// merely present in the line) would point the pipeline at the wrong
/// language. Latin/Greek/Arabic/other scripts stay `None` — v1 has no
/// deterministic tag for them from writing system alone.
fn script_hint(counts: &ScriptCounts, expected: u32) -> Option<String> {
    if counts.hangul > 0 && expected & HANGUL == 0 {
        return Some("ko".to_string());
    }
    if counts.kana() > 0 && expected & (HIRAGANA | KATAKANA) == 0 {
        return Some("ja".to_string());
    }
    if counts.thai > 0 && expected & THAI == 0 {
        return Some("th".to_string());
    }
    if counts.cyrillic > 0 && expected & CYRILLIC == 0 {
        return Some("ru".to_string());
    }
    if counts.only_han() && expected & HAN == 0 {
        return han_variant_hint(counts).map(str::to_string);
    }
    None
}

// ── Small text helpers ───────────────────────────────────────────────────

/// Lowercase alphanumeric words of [text] — punctuation/emoji/whitespace are
/// separators, combining marks are dropped. Used by the filler match and the
/// own-language stopword match. Zero-width FORMAT characters (ZWSP/ZWJ and
/// friends) are stripped outright — they must not act as separators and let
/// "g<ZWSP>g" dodge the filler table — and fullwidth Latin folds to its
/// narrow form so "ｇｇ" matches "gg".
fn words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        if is_invisible_format(c) {
            continue;
        }
        // Fold FIRST, then classify: a fullwidth letter joins the word as
        // its narrow form, while folded PUNCTUATION stays a separator —
        // "gg！" must read as the single word "gg", not "gg!".
        let effective = fold_fullwidth(c).unwrap_or(c);
        if effective.is_alphanumeric() {
            current.extend(effective.to_lowercase());
        } else if !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Invisible widthless characters that must never split a word: the
/// zero-width joiners/breakers (Cf), bidi controls (Cf) and variation
/// selectors (Mn) that chat clients paste freely.
fn is_invisible_format(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
            | '\u{FE00}'..='\u{FE0F}'
    )
}

/// Fullwidth ASCII (U+FF01–U+FF5E) folds onto its narrow form; everything
/// else stays untouched.
fn fold_fullwidth(c: char) -> Option<char> {
    let code = c as u32;
    if (0xFF01..=0xFF5E).contains(&code) {
        char::from_u32(code - 0xFEE0)
    } else {
        None
    }
}

fn is_filler(text: &str) -> bool {
    let normalized = words(text).join(" ");
    !normalized.is_empty() && FILLERS.contains(&normalized.as_str())
}

fn has_own_stopword(text: &str, own: &str) -> bool {
    let Some(table) = latin_stopwords(own) else {
        return false;
    };
    words(text)
        .iter()
        .any(|word| table.contains(&word.as_str()))
}

/// A game chat command: the trimmed line starts with `/`.
fn is_command(text: &str) -> bool {
    text.starts_with('/')
}

/// `:://` anywhere (a pasted link with words around it is still a link), or
/// a line that is a single `www.` token ("以 www. 开头且无其它文字").
fn is_url(text: &str) -> bool {
    if text.contains("://") {
        return true;
    }
    text.to_ascii_lowercase().starts_with("www.") && text.split_whitespace().count() == 1
}

// ── Verdict constructors ────────────────────────────────────────────────

fn skip(reason: VerdictReason) -> LangVerdict {
    LangVerdict {
        verdict: Verdict::Skip,
        script_hint: None,
        reason,
    }
}

fn translate(reason: VerdictReason, script_hint: Option<String>) -> LangVerdict {
    LangVerdict {
        verdict: Verdict::Translate,
        script_hint,
        reason,
    }
}

// ── Entry point ─────────────────────────────────────────────────────────

/// Classify one battle-chat line.
///
/// `text` is the raw chat body (the namespace/sender are the caller's
/// concern); `own_lang` is the player's own language tag (empty = unknown,
/// following the UI); `min_chars` is the configured minimum effective
/// character count (the settings' `detect.minChars`; values ≤ 0 disable the
/// too-short rule for the pure-function contract, the settings clamp it to
/// 1..=20 on the way in).
///
/// The returned [LangVerdict] is the whole answer: the decision, the
/// best-effort language hint (see the module docs for when it is `None`) and
/// the reason the decision was reached (the first matching rule, in the
/// contract's order).
pub(crate) fn detect_line(text: &str, own_lang: &str, min_chars: i64) -> LangVerdict {
    // 1. Pre-clean: trim; control characters are ignored by every rule (they
    //    are neither alphanumeric nor letters).
    let trimmed = text.trim();
    let effective = trimmed.chars().filter(|c| c.is_alphanumeric()).count();

    // 2. Too short.
    if (effective as i64) < min_chars.max(0) {
        return skip(TooShort);
    }
    // 3. Game command.
    if is_command(trimmed) {
        return skip(Command);
    }
    // 4. URL.
    if is_url(trimmed) {
        return skip(Url);
    }
    // 5. Symbols only (punctuation/whitespace/emoji). The digit-only line is
    //    caught by the census below: digits are "effective" but carry no
    //    script, and a line with nothing translatable is chat noise.
    if !trimmed.chars().any(|c| c.is_alphanumeric()) {
        return skip(SymbolsOnly);
    }
    // 6. Filler.
    if is_filler(trimmed) {
        return skip(Filler);
    }
    // 7. Our own outgoing output echoed back.
    if looks_like_own_echo(trimmed) {
        return skip(OwnEcho);
    }
    // 8. Script census.
    let counts = census(trimmed);
    if counts.total_letters() == 0 {
        return skip(SymbolsOnly);
    }

    // 9-10. Decision.
    let own = normalize_lang(own_lang);
    let expected = expected_scripts(own);

    // A non-Latin script outside the caller's expected set is foreign,
    // whatever the own language. (Latin is never a "foreign script" — it is
    // the LatinForeign branch below.)
    if NON_LATIN_SCRIPTS
        .iter()
        .copied()
        .any(|script| counts.get(script) > 0 && expected & script_bit(script) == 0)
    {
        return translate(ForeignScript, script_hint(&counts, expected));
    }

    match own {
        // No own language: nothing is "expected", so a Latin-only line is a
        // foreign Latin language and any other script already returned above.
        None => translate(LatinForeign, None),
        // Latin-family own: the only expected script is Latin. A stopword hit
        // means the line reads as the caller's language; otherwise it is a
        // different Latin-script language.
        Some(own) if is_latin_family(own) => {
            if has_own_stopword(trimmed, own) {
                skip(SameLangStopwords)
            } else {
                translate(LatinForeign, None)
            }
        },
        Some(own) => {
            // DELIBERATE refinement of the literal rule 10 (see the module
            // docs): both Chinese variants are Han, so without this a
            // Simplified-Chinese reader would never see a Traditional-Chinese
            // line translated — the feature's motivating case. A Hans/Hant
            // variant mismatch is foreign; same-variant/ambiguous Han stays
            // same-language.
            if matches!(own, "zh-CN" | "zh-TW") && counts.han > 0 {
                if let Some(hint) = han_variant_hint(&counts)
                    && hint != own
                {
                    return translate(ForeignScript, Some(hint.to_string()));
                }
                return skip(SameLangStopwords);
            }
            // A Latin-only line for a non-Latin caller is a foreign Latin
            // language (a Russian player reading English chat); mixed
            // own-script + Latin stays same-language.
            if counts.own_script_letters(own) == 0 && counts.latin > 0 {
                translate(LatinForeign, None)
            } else {
                skip(SameLangStopwords)
            }
        },
    }
}

// ── Tests ───────────────────────────────────────────────────────────────
// Every rule from contract §2 has a positive and a negative case here; the
// simp/trad samples and each Latin stopword table are locked so a table edit
// cannot silently change the decision.

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use wowsp_tauri_shared::Verdict;

    use super::*;

    fn verdict_of(text: &str, own: &str) -> LangVerdict {
        detect_line(text, own, 2)
    }

    fn expect_skip(text: &str, own: &str, reason: VerdictReason) {
        let verdict = verdict_of(text, own);
        assert_eq!(
            verdict.verdict,
            Verdict::Skip,
            "text {text:?} own {own:?}: {verdict:?}"
        );
        assert_eq!(
            verdict.reason, reason,
            "text {text:?} own {own:?}: {verdict:?}"
        );
        // Skip verdicts never name a language: there is nothing to translate.
        assert!(
            verdict.script_hint.is_none(),
            "skip verdicts carry no hint: {verdict:?}"
        );
    }

    fn expect_translate(text: &str, own: &str, reason: VerdictReason, hint: Option<&str>) {
        let verdict = verdict_of(text, own);
        assert_eq!(
            verdict.verdict,
            Verdict::Translate,
            "text {text:?} own {own:?}: {verdict:?}"
        );
        assert_eq!(
            verdict.reason, reason,
            "text {text:?} own {own:?}: {verdict:?}"
        );
        assert_eq!(
            verdict.script_hint.as_deref(),
            hint,
            "text {text:?} own {own:?}: {verdict:?}"
        );
    }

    // ── Language tags ───────────────────────────────────────────────────

    #[test]
    fn normalize_lang_handles_canonical_and_tolerant_tags() {
        for tag in SUPPORTED_LANGS {
            assert_eq!(normalize_lang(tag), Some(*tag), "canonical tag {tag}");
        }
        assert_eq!(normalize_lang("JA-jp"), Some("ja"));
        assert_eq!(normalize_lang("en_US"), Some("en"));
        assert_eq!(normalize_lang("pt-BR"), Some("pt"));
        assert_eq!(normalize_lang("es-419"), Some("es"));
        assert_eq!(normalize_lang("zh"), Some("zh-CN"));
        assert_eq!(normalize_lang("zh-Hans"), Some("zh-CN"));
        assert_eq!(normalize_lang("zh-Hant"), Some("zh-TW"));
        assert_eq!(normalize_lang("zh_HK"), Some("zh-TW"));
        assert_eq!(normalize_lang("zh-MO"), Some("zh-TW"));
        assert_eq!(normalize_lang(""), None);
        assert_eq!(normalize_lang("   "), None);
        assert_eq!(normalize_lang("xx-YY"), None);
    }

    #[test]
    fn suffix_table_locks_the_contract() {
        let expected: &[(&str, &str)] = &[
            ("zh-CN", "[WOWSP同声传译]"),
            ("zh-TW", "[WOWSP同聲傳譯]"),
            ("ja", "[WOWSP同時通訳]"),
            ("ko", "[WOWSP동시통역]"),
            ("ru", "[WOWSP синхроперевод]"),
            ("en", "[WOWSP live translation]"),
            ("de", "[WOWSP Simultandolmetschen]"),
            ("fr", "[WOWSP traduction simultanée]"),
            ("es", "[WOWSP traducción simultánea]"),
            ("it", "[WOWSP traduzione simultanea]"),
            ("pl", "[WOWSP tłumaczenie symultaniczne]"),
            ("cs", "[WOWSP simultánní překlad]"),
            ("tr", "[WOWSP eşzamanlı çeviri]"),
            ("pt", "[WOWSP tradução simultânea]"),
            ("uk", "[WOWSP синхронний переклад]"),
            ("th", "[WOWSP แปลสด]"),
            ("vi", "[WOWSP dịch đồng thời]"),
        ];
        assert_eq!(SUFFIXES, expected, "contract §4 suffix table verbatim");
        assert_eq!(SUFFIXES.len(), 17);
        for (tag, suffix) in expected {
            assert_eq!(suffix_for(tag), *suffix, "suffix for {tag}");
            assert!(suffix.contains("WOWSP"), "{suffix:?} carries the brand");
            assert!(
                suffix.starts_with('[') && suffix.ends_with(']'),
                "{suffix:?} is bracketed"
            );
            assert!(
                suffix.chars().count() <= 48,
                "{suffix:?} stays a chat-sized marker"
            );
        }
        // Tolerant tag spellings + the English fallback for unknown targets.
        assert_eq!(suffix_for("zh-tw"), "[WOWSP同聲傳譯]");
        assert_eq!(suffix_for("EN-us"), SUFFIX_EN);
        assert_eq!(suffix_for("xx"), SUFFIX_EN);
        assert_eq!(suffix_for(""), SUFFIX_EN);
    }

    // ── Script census ───────────────────────────────────────────────────

    #[test]
    fn script_of_buckets_representative_characters() {
        assert_eq!(script_of('漢'), Some(LangScript::Han));
        assert_eq!(script_of('々'), Some(LangScript::Han));
        assert_eq!(script_of('〇'), Some(LangScript::Han));
        assert_eq!(script_of('あ'), Some(LangScript::Hiragana));
        assert_eq!(script_of('ア'), Some(LangScript::Katakana));
        assert_eq!(script_of('한'), Some(LangScript::Hangul));
        assert_eq!(script_of('Ж'), Some(LangScript::Cyrillic));
        assert_eq!(script_of('Δ'), Some(LangScript::Greek));
        assert_eq!(script_of('ก'), Some(LangScript::Thai));
        assert_eq!(script_of('a'), Some(LangScript::Latin));
        assert_eq!(script_of('é'), Some(LangScript::Latin));
        assert_eq!(script_of('Ａ'), Some(LangScript::Latin));
        assert_eq!(script_of('م'), Some(LangScript::Arabic));
        assert_eq!(script_of('١'), Some(LangScript::Arabic));
        assert_eq!(script_of('א'), Some(LangScript::Other));
        // Digits (ASCII), punctuation, whitespace and emoji are not scripts.
        for c in ['1', '!', ' ', '—', '🎉'] {
            assert_eq!(script_of(c), None, "{c:?}");
        }
    }

    #[test]
    fn census_counts_scripts_and_exclusive_han() {
        let counts = census("這是我們的國家");
        assert_eq!(counts.han, 7);
        assert_eq!(counts.traditional_exclusive, 3, "這 們 國");
        assert_eq!(counts.simplified_exclusive, 0);
        assert!(counts.only_han());

        let mixed = census("變了 GG");
        assert_eq!(mixed.han, 2);
        assert_eq!(mixed.latin, 2);
        assert!(!mixed.only_han());
    }

    #[test]
    fn han_variant_hint_uses_exclusive_character_counts() {
        assert_eq!(han_variant_hint(&census("這是我們的國家")), Some("zh-TW"));
        assert_eq!(han_variant_hint(&census("这是我们的国家")), Some("zh-CN"));
        assert_eq!(han_variant_hint(&census("你好世界")), None);
        // Contract §2 rule 8's else-branch: a non-zero tie falls to zh-CN.
        assert_eq!(han_variant_hint(&census("這这")), Some("zh-CN"));
    }

    #[test]
    fn exclusive_han_sets_are_curated_and_disjoint() {
        let trad: Vec<char> = TRADITIONAL_EXCLUSIVE.chars().collect();
        let simp: Vec<char> = SIMPLIFIED_EXCLUSIVE.chars().collect();
        assert!(trad.len() >= 60, "traditional set: {} chars", trad.len());
        assert!(simp.len() >= 60, "simplified set: {} chars", simp.len());
        assert_eq!(
            trad.iter().copied().collect::<HashSet<_>>().len(),
            trad.len(),
            "traditional characters are unique"
        );
        assert_eq!(
            simp.iter().copied().collect::<HashSet<_>>().len(),
            simp.len(),
            "simplified characters are unique"
        );
        for c in &trad {
            assert!(
                !SIMPLIFIED_EXCLUSIVE.contains(*c),
                "{c:?} sits in both exclusive sets"
            );
            assert_eq!(script_of(*c), Some(LangScript::Han), "{c:?} is Han");
        }
        for c in &simp {
            assert_eq!(script_of(*c), Some(LangScript::Han), "{c:?} is Han");
        }
    }

    #[test]
    fn expected_script_sets_follow_the_contract() {
        assert_eq!(expected_scripts(Some("zh-CN")), HAN);
        assert_eq!(expected_scripts(Some("zh-TW")), HAN);
        assert_eq!(expected_scripts(Some("ja")), HAN | HIRAGANA | KATAKANA);
        assert_eq!(expected_scripts(Some("ko")), HANGUL | HAN);
        assert_eq!(expected_scripts(Some("ru")), CYRILLIC | LATIN);
        assert_eq!(expected_scripts(Some("uk")), CYRILLIC | LATIN);
        assert_eq!(expected_scripts(Some("th")), THAI);
        assert_eq!(expected_scripts(Some("en")), LATIN);
        assert_eq!(expected_scripts(Some("vi")), LATIN);
        assert_eq!(expected_scripts(None), 0);
    }

    #[test]
    fn script_hint_maps_the_known_scripts() {
        // expected = 0: nothing is expected, so any known script may name.
        assert_eq!(script_hint(&census("これは"), 0), Some("ja".to_string()));
        assert_eq!(script_hint(&census("한글"), 0), Some("ko".to_string()));
        assert_eq!(script_hint(&census("привет"), 0), Some("ru".to_string()));
        assert_eq!(script_hint(&census("สวัสดี"), 0), Some("th".to_string()));
        assert_eq!(script_hint(&census("這是"), 0), Some("zh-TW".to_string()));
        assert_eq!(script_hint(&census("这是"), 0), Some("zh-CN".to_string()));
        assert_eq!(script_hint(&census("你好"), 0), None);
        assert_eq!(script_hint(&census("hello"), 0), None);
        assert_eq!(script_hint(&census("καλημέρα"), 0), None);
        assert_eq!(script_hint(&census("مرحبا"), 0), None);
    }

    /// Regression (R2 NICE): the hint must name the FOREIGN script, never
    /// the reader's own script that merely happens to be in the line —
    /// "Привет 你好" for a ru reader is foreign because of the Han, and the
    /// old hint answered "ru".
    #[test]
    fn script_hint_never_names_the_readers_own_script() {
        let ru_expected = expected_scripts(Some("ru"));
        let counts = census("Привет 你好");
        assert_eq!(script_hint(&counts, ru_expected), None);
        // The verdict itself still translates (Han is outside ru's set);
        // with Han mixed into Cyrillic the variant heuristic stays silent.
        expect_translate("Привет 你好", "ru", VerdictReason::ForeignScript, None);
        // A ko reader seeing Hangul + Latin: Hangul IS expected → no hint.
        let ko_expected = expected_scripts(Some("ko"));
        assert_eq!(script_hint(&census("한국어 hello"), ko_expected), None);
        // An en reader seeing the same line: Hangul is foreign → ko hint.
        let en_expected = expected_scripts(Some("en"));
        assert_eq!(
            script_hint(&census("한국어 hello"), en_expected),
            Some("ko".to_string())
        );
    }

    /// Zero-width format characters and fullwidth Latin cannot dodge the
    /// filler table (R2 NICE).
    #[test]
    fn filler_match_survives_zero_width_and_fullwidth() {
        expect_skip("g\u{200B}g", "en", VerdictReason::Filler);
        expect_skip("g\u{200D}g\u{200D}", "en", VerdictReason::Filler);
        expect_skip("\u{FF47}\u{FF47}", "en", VerdictReason::Filler);
        expect_skip("\u{FF2C}\u{FF2F}\u{FF2C}", "en", VerdictReason::Filler);
        // Folded PUNCTUATION still separates (R1' B1 regression): the
        // trailing fullwidth signs must not glue themselves onto the word.
        expect_skip("gg\u{FF01}", "en", VerdictReason::Filler);
        expect_skip("wp\u{FF01}", "en", VerdictReason::Filler);
        expect_skip("ok\u{FF1F}", "en", VerdictReason::Filler);
        // Bidi isolates are stripped like the other invisible controls.
        expect_skip("g\u{2066}g", "en", VerdictReason::Filler);
    }

    // ── Rule 2: too short ───────────────────────────────────────────────

    #[test]
    fn too_short_rule_counts_effective_characters() {
        expect_skip("a", "en", VerdictReason::TooShort);
        expect_skip("  a  ", "en", VerdictReason::TooShort);
        expect_skip("", "en", VerdictReason::TooShort);
        expect_skip("a.!?", "en", VerdictReason::TooShort);
        // Exactly min_chars characters is enough.
        assert_eq!(
            detect_line("ab", "en", 2).reason,
            VerdictReason::LatinForeign
        );
        assert_eq!(detect_line("a b", "en", 2).verdict, Verdict::Translate);
        // A caller-provided ≤ 0 disables the rule (the settings clamp it to
        // 1..=20, so this is the pure-function escape hatch).
        assert_ne!(detect_line("ab", "en", -5).reason, VerdictReason::TooShort);
    }

    // ── Rule 3: commands ────────────────────────────────────────────────

    #[test]
    fn command_rule_covers_slash_lines() {
        expect_skip("/help", "en", VerdictReason::Command);
        expect_skip("/invite Somebody", "en", VerdictReason::Command);
        // The empty "/" is too short first (the contract's rule order); with
        // the too-short rule disabled it reads as a command.
        expect_skip("/", "en", VerdictReason::TooShort);
        assert_eq!(detect_line("/", "en", 0).reason, VerdictReason::Command);
        // A slash INSIDE a line is prose, not a command.
        assert_eq!(
            detect_line("gg /help", "en", 2).reason,
            VerdictReason::LatinForeign
        );
    }

    // ── Rule 4: URLs ────────────────────────────────────────────────────

    #[test]
    fn url_rule_handles_scheme_and_www_tokens() {
        expect_skip("https://example.com", "en", VerdictReason::Url);
        expect_skip("see https://example.com/battle", "en", VerdictReason::Url);
        expect_skip("www.example.com", "en", VerdictReason::Url);
        expect_skip("WWW.EXAMPLE.COM", "en", VerdictReason::Url);
        // A www. token followed by other text is prose again.
        assert_eq!(
            detect_line("www.example.com foo", "en", 2).reason,
            VerdictReason::LatinForeign
        );
    }

    // ── Rule 5: symbols only ────────────────────────────────────────────

    #[test]
    fn symbols_only_rule_covers_punctuation_emoji_and_digits() {
        assert_eq!(
            detect_line("!!!", "en", 0).reason,
            VerdictReason::SymbolsOnly
        );
        assert_eq!(
            detect_line("🎉🎉", "en", 0).reason,
            VerdictReason::SymbolsOnly
        );
        assert_eq!(
            detect_line("——", "en", 0).reason,
            VerdictReason::SymbolsOnly
        );
        // Digits are "effective" for the too-short rule but carry no script:
        // a number-only line has nothing to translate.
        assert_eq!(
            detect_line("12345", "en", 2).reason,
            VerdictReason::SymbolsOnly
        );
        // With the default minimum the punctuation-only line is TooShort
        // first (rule order).
        expect_skip("!!", "en", VerdictReason::TooShort);
    }

    // ── Rule 6: filler ──────────────────────────────────────────────────

    #[test]
    fn filler_rule_skips_chat_noise_whole_line_only() {
        for sample in [
            "gg",
            "GG",
            "GG!",
            "gl hf",
            "wp",
            "o7",
            "lol",
            "ty",
            "thx",
            "thanks",
            "thank you",
            "good luck 👍",
            "well played",
            "GG WP",
            "ok",
            "okay",
            "brb",
            "afk",
            "np",
            "cya",
            "nice",
            "no problem",
        ] {
            expect_skip(sample, "en", VerdictReason::Filler);
        }
        // Filler plus ANY content word is prose again.
        expect_translate("gg wp lol no", "en", VerdictReason::LatinForeign, None);
        assert_eq!(
            detect_line("nice job done", "en", 2).reason,
            VerdictReason::LatinForeign
        );
    }

    #[test]
    fn filler_list_shape_is_locked() {
        assert!(FILLERS.len() >= 25, "contract requires ≥25 fillers");
        let mut seen = HashSet::new();
        for entry in FILLERS {
            assert!(!entry.is_empty());
            assert_eq!(*entry, entry.to_lowercase(), "{entry:?} is lowercase");
            assert!(seen.insert(*entry), "{entry:?} is unique");
        }
    }

    // ── Rule 7: own echo ────────────────────────────────────────────────

    #[test]
    fn own_echo_detects_every_suffix_and_the_composed_shape() {
        for (tag, suffix) in SUFFIXES {
            let text = format!("繁体中文|日语 {suffix}");
            assert!(looks_like_own_echo(&text), "{tag} suffix echoed");
            expect_skip(&text, "en", VerdictReason::OwnEcho);
        }
        assert!(looks_like_own_echo("[wowsp LIVE TRANSLATION]"));
        assert!(looks_like_own_echo("繁體中文 | 日語 [WOWSP 同聲傳譯]"));
        assert!(looks_like_own_echo("中文 | English [WOWSP]"));
        assert!(!looks_like_own_echo("hello | world"));
        assert!(!looks_like_own_echo("WOWSP"));
        assert!(!looks_like_own_echo("[WOWSP]"));
        assert!(!looks_like_own_echo(""));
    }

    // ── Rules 8-10: decisions ───────────────────────────────────────────

    #[test]
    fn traditional_and_simplified_han_samples_resolve() {
        expect_translate(
            "這是我們的國家",
            "en",
            VerdictReason::ForeignScript,
            Some("zh-TW"),
        );
        expect_translate(
            "这是我们的国家",
            "en",
            VerdictReason::ForeignScript,
            Some("zh-CN"),
        );
        // Shared characters only: ambiguous Han, no named language.
        expect_translate("你好世界", "en", VerdictReason::ForeignScript, None);
        // Mixed Latin + Han: the script hint is only assigned to pure Han.
        expect_translate("這是 GG", "en", VerdictReason::ForeignScript, None);
    }

    #[test]
    fn foreign_script_triggers_and_hints() {
        expect_translate(
            "これは日本語です",
            "en",
            VerdictReason::ForeignScript,
            Some("ja"),
        );
        expect_translate("안녕하세요", "en", VerdictReason::ForeignScript, Some("ko"));
        expect_translate("สวัสดีครับ", "en", VerdictReason::ForeignScript, Some("th"));
        expect_translate(
            "привет как дела",
            "en",
            VerdictReason::ForeignScript,
            Some("ru"),
        );
        // No v1 language tag for these scripts: translated, hintless.
        expect_translate("καλημέρα", "en", VerdictReason::ForeignScript, None);
        expect_translate("مرحبا", "en", VerdictReason::ForeignScript, None);
        expect_translate("שלום", "en", VerdictReason::ForeignScript, None);
        // Contract mapping order: Hangul wins over kana when both appear.
        expect_translate("한 あ", "en", VerdictReason::ForeignScript, Some("ko"));
    }

    #[test]
    fn same_language_lines_skip_for_every_non_latin_caller() {
        expect_skip("これはテストです", "ja", VerdictReason::SameLangStopwords);
        expect_skip("日本語です", "ja", VerdictReason::SameLangStopwords);
        // Pure Han is inside the Japanese/Korean expected sets (contract
        // rule 10: expected scripts only → not foreign).
        expect_skip("敵艦発見", "ja", VerdictReason::SameLangStopwords);
        expect_skip("안녕하세요 여러분", "ko", VerdictReason::SameLangStopwords);
        expect_skip("你好", "ko", VerdictReason::SameLangStopwords);
        expect_skip("привет, как дела?", "ru", VerdictReason::SameLangStopwords);
        expect_skip("привіт", "uk", VerdictReason::SameLangStopwords);
        expect_skip("สวัสดีครับ", "th", VerdictReason::SameLangStopwords);
        expect_skip("中文", "zh-CN", VerdictReason::SameLangStopwords);
        expect_skip("中文", "zh-TW", VerdictReason::SameLangStopwords);
    }

    #[test]
    fn zh_variant_mismatch_is_foreign_but_same_variant_skips() {
        // The feature's motivating case: a Simplified reader must get the
        // Traditional line translated (and vice versa).
        expect_translate(
            "這是我們的國家",
            "zh-CN",
            VerdictReason::ForeignScript,
            Some("zh-TW"),
        );
        expect_translate(
            "这是我们的国家",
            "zh-TW",
            VerdictReason::ForeignScript,
            Some("zh-CN"),
        );
        assert_eq!(
            detect_line("這是我們的國家", "zh-CN", 2)
                .script_hint
                .as_deref(),
            Some("zh-TW")
        );
        // Same-variant/ambiguous Han is own-language; Latin is a foreign
        // Latin language; kana is foreign script.
        expect_skip("中文", "zh-CN", VerdictReason::SameLangStopwords);
        expect_translate("hello world", "zh-CN", VerdictReason::LatinForeign, None);
        expect_translate("これは", "zh-CN", VerdictReason::ForeignScript, Some("ja"));
    }

    #[test]
    fn latin_only_text_for_non_latin_callers_is_foreign() {
        expect_translate("hello world", "ru", VerdictReason::LatinForeign, None);
        expect_translate("hello world", "ja", VerdictReason::LatinForeign, None);
        expect_translate("hello world", "th", VerdictReason::LatinForeign, None);
        expect_translate("hello world", "uk", VerdictReason::LatinForeign, None);
        // Mixed own script + Latin slang is own-language.
        expect_skip("привет gg", "ru", VerdictReason::SameLangStopwords);
        expect_skip("日本語 ok", "ja", VerdictReason::SameLangStopwords);
        expect_skip("안녕 gg", "ko", VerdictReason::SameLangStopwords);
        expect_skip("สวัสดี gg", "th", VerdictReason::SameLangStopwords);
    }

    #[test]
    fn unknown_or_missing_own_language_treats_scripts_as_foreign() {
        expect_translate(
            "這是我們的國家",
            "",
            VerdictReason::ForeignScript,
            Some("zh-TW"),
        );
        expect_translate("hello world", "", VerdictReason::LatinForeign, None);
        expect_translate("これは", "", VerdictReason::ForeignScript, Some("ja"));
        expect_translate(
            "這是我們的國家",
            "xx",
            VerdictReason::ForeignScript,
            Some("zh-TW"),
        );
    }

    #[test]
    fn latin_stopword_tables_identify_each_own_language() {
        let samples: &[(&str, &[&str])] = &[
            (
                "en",
                &["the quick brown fox is here", "we have what they need"],
            ),
            ("de", &["der Hund ist nicht müde", "ich bin zu Hause"]),
            ("fr", &["le chat est très beau", "je ne sais pas"]),
            ("es", &["el perro es muy grande", "yo no sé"]),
            ("it", &["il cane non è grande", "io sono qui"]),
            ("pl", &["to nie jest prawda", "ja jestem tutaj"]),
            ("cs", &["to není pravda", "jsem tady"]),
            ("tr", &["bu bir araba değil", "biz onlar var"]),
            ("pt", &["não é você", "eu estou aqui"]),
            ("vi", &["xin chào bạn", "tôi không biết"]),
        ];
        for (own, texts) in samples {
            for text in *texts {
                expect_skip(text, own, VerdictReason::SameLangStopwords);
            }
        }
    }

    #[test]
    fn latin_stopword_tables_have_the_contract_shape() {
        for lang in ["en", "de", "fr", "es", "it", "pl", "cs", "tr", "pt", "vi"] {
            let table = latin_stopwords(lang).unwrap_or_else(|| panic!("no table for {lang}"));
            assert!(
                table.len() >= 18,
                "{lang} carries ~20 stopwords, got {}",
                table.len()
            );
            let mut seen = HashSet::new();
            for word in table {
                assert_eq!(*word, word.to_lowercase(), "{lang}: {word:?} lowercase");
                assert!(seen.insert(*word), "{lang}: {word:?} duplicate");
            }
        }
        // Non-Latin families have no stopword table (their own-script check
        // covers same-language detection).
        assert!(latin_stopwords("ru").is_none());
        assert!(latin_stopwords("uk").is_none());
        assert!(latin_stopwords("zh-CN").is_none());
    }

    #[test]
    fn different_latin_languages_are_foreign() {
        expect_translate(
            "der Hund ist sehr groß und schnell",
            "en",
            VerdictReason::LatinForeign,
            None,
        );
        expect_translate(
            "the dog is very big",
            "de",
            VerdictReason::LatinForeign,
            None,
        );
        expect_translate("le chat est beau", "en", VerdictReason::LatinForeign, None);
        expect_translate(
            "hola amigo cómo estás",
            "en",
            VerdictReason::LatinForeign,
            None,
        );
        // Vietnamese table is a W1 extension: English is still foreign to it.
        expect_translate(
            "the dog is very big",
            "vi",
            VerdictReason::LatinForeign,
            None,
        );
    }

    // ── Text helpers / wire shape ───────────────────────────────────────

    #[test]
    fn words_folds_case_and_splits_on_noise() {
        assert_eq!(words("GG WP!"), vec!["gg".to_string(), "wp".to_string()]);
        assert_eq!(words("  ...  "), Vec::<String>::new());
        assert_eq!(
            words("Hello,世界 123"),
            vec!["hello".to_string(), "世界".to_string(), "123".to_string()]
        );
    }

    #[test]
    fn control_characters_are_ignored() {
        let verdict = detect_line("the\u{0} quick", "en", 2);
        assert_eq!(verdict.reason, VerdictReason::SameLangStopwords);
        assert_eq!(
            detect_line("he\u{7}llo", "en", 2).verdict,
            Verdict::Translate
        );
    }

    #[test]
    fn verdicts_serialize_camel_case() {
        let verdict = verdict_of("これは", "en");
        let json = serde_json::to_value(&verdict).expect("serialize verdict");
        assert_eq!(json["verdict"], "translate");
        assert_eq!(json["reason"], "foreignScript");
        assert_eq!(json["scriptHint"], "ja");

        let skip = serde_json::to_value(skip(VerdictReason::SymbolsOnly)).expect("serialize skip");
        assert_eq!(skip["verdict"], "skip");
        assert_eq!(skip["reason"], "symbolsOnly");
        assert!(skip["scriptHint"].is_null());

        assert_eq!(
            serde_json::to_value(LangScript::Han).expect("serialize script"),
            "han"
        );
        assert_eq!(
            serde_json::to_value(LangScript::Other).expect("serialize script"),
            "other"
        );
    }
}
