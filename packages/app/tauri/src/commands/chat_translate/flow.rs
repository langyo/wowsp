//! Live chat-line pipeline (M2 WC): the per-line decision + translation step
//! that turns a decoded chat line into a panel row.
//!
//! [`submit`] is the live source's entry point (it calls it once per new
//! `ChatLine`; the ring push itself belongs to the source). The synchronous
//! half ([handle_line]) decides:
//!
//! 1. **master gate** — the feature must be enabled AND consented
//!    (`consentVersion >= 1`), else the whole line is dropped (the live
//!    source silences its ticks in that state anyway; the gate keeps a stale
//!    config from ever posting chat text);
//! 2. **own-echo / detector filter** — [`looks_like_own_echo`] then
//!    [`detect_line`] with the user's reading language: own-language lines,
//!    filler, commands, URLs and our own `[WOWSP…]` output never cost a
//!    request, but they DO get a panel row (original only + the detector's
//!    language hint);
//! 3. **request planning** — the battle's cache ([`CacheCore`]) dedupes the
//!    line, coalesces duplicate in-flight requests, and enforces the sliding
//!    rate window + the failure backoff; a hit applies immediately, a blocked
//!    request leaves the original row untouched (no translation, no error UI);
//! 4. **request** — a fresh line is translated into the user's reading
//!    language ([`context::resolve_self_lang`]) against the battle context
//!    ([`context::build`]) by the engine, then settled into the cache and
//!    written onto the row.
//!
//! Everything that reaches the panel goes through the shared `LiveState`
//! mutators ([`LiveState::set_lang`] / [`LiveState::apply_translation`]),
//! which bump its revision; the live source owns event emission (the panel
//! reads a throttled snapshot). This module NEVER emits and NEVER logs chat
//! text, keys or provider bodies — a failure is just an untranslated row.
//!
//! The clock is injected (`now_ms` parameters; production passes the wall
//! clock after the request returns) so the backoff/rate-window behaviour is
//! unit-tested on exact timelines.

use anyhow::Result;

use std::future::Future;
use std::pin::Pin;

use tauri::AppHandle;

use wowsp_tauri_shared::{
    ChatLine, ChatTranslateConfig, LangVerdict, MatchContext, RecentChatLine,
};

use super::cache::{CacheCore, CacheKey, LookupStart};
use super::context::{self, RecentLine};
use super::lang::{detect_line, looks_like_own_echo};
use super::live::SharedLiveState;
use super::translate::{LineTranslation, TranslationSource};

/// Cache-key glossary version. The cache is battle-scoped (the live source
/// resets it on every battle switch), so a constant is exact for M2; M3's
/// cross-battle glossary warm-up bumps this when the prompt's term list
/// changes within a battle.
const GLOSSARY_VERSION: u32 = 0;

/// What the synchronous half decided for one line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FlowAction {
    /// Feature off / no consent: no panel row, no request, nothing.
    Drop,
    /// Show the original line only (readable already, or not worth a
    /// request). `lang` is the detector's hint when it has one.
    PanelOnly { lang: Option<String> },
    /// Show the line and translate it into the listed targets.
    Translate {
        lang: Option<String>,
        targets: Vec<String>,
    },
}

/// What [`plan_request`] says about one cache key/request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RequestPlan {
    /// Finished translation already cached (may be the empty string for an
    /// untranslatable line).
    Cached(String),
    /// The caller owns a fresh request; run it (the key is in flight).
    Start,
    /// An identical request is already in flight; never duplicate it.
    AlreadyInFlight,
    /// The failure backoff ladder blocks requests right now.
    Backoff { remaining_ms: i64 },
    /// The sliding-window rate limit is full.
    RateLimited,
}

/// The translation result as the panel needs it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TranslationOutcome {
    /// The translated line, when the model produced one.
    pub translated: Option<String>,
    /// The model's source-language tag, when it reported one.
    pub lang: Option<String>,
}

/// One translation request the async half runs.
#[derive(Debug, Clone)]
pub(crate) struct PendingTranslation {
    pub line_id: i64,
    /// The battle the row belonged to when the request started. The async
    /// half re-checks it after the network wait: a battle switch (or the
    /// enable-gate reset) renumbers line ids from 1, so an unguarded finish
    /// would write the stale answer onto an unrelated row of the NEW battle
    /// and settle it into the new battle's cache/backoff.
    pub battle_key: String,
    pub text: String,
    pub targets: Vec<String>,
    pub self_lang: String,
    /// Detector hint to keep on the row if the model reports no language.
    pub lang_hint: Option<String>,
    pub context: MatchContext,
    pub key: CacheKey,
}

/// One request handed to the engine.
pub(crate) struct TranslationRequest<'a> {
    pub config: &'a ChatTranslateConfig,
    pub text: &'a str,
    pub targets: &'a [String],
    pub self_lang: &'a str,
    pub context: &'a MatchContext,
}

/// Boxed future returned by [`LineTranslator`] (the seam that lets tests run
/// the pipeline with canned answers and zero network).
pub(crate) type TranslateFuture<'a> =
    Pin<Box<dyn Future<Output = Result<LineTranslation>> + Send + 'a>>;

/// The translation seam: production calls the engine, tests answer canned.
pub(crate) trait LineTranslator: Send + Sync {
    fn translate<'a>(&'a self, request: TranslationRequest<'a>) -> TranslateFuture<'a>;
}

/// Production translator: the real engine pipeline (prompt + provider +
/// repair/validation), driven by the shared proxy-aware HTTP client.
pub(crate) struct EngineTranslator;

impl LineTranslator for EngineTranslator {
    fn translate<'a>(&'a self, request: TranslationRequest<'a>) -> TranslateFuture<'a> {
        Box::pin(async move {
            super::translate::translate_line_configured(
                request.config,
                request.text,
                request.targets,
                request.self_lang,
                request.context,
            )
            .await
        })
    }
}

/// The sync decision for one line: gate → own-echo → detector → request.
///
/// `own_lang` is the user's reading language ([`context::resolve_self_lang`]
/// in production) and `targets` the resolved target list; empty targets mean
/// there is nothing to request, so the row stays panel-only.
pub(crate) fn decide(
    config: &ChatTranslateConfig,
    text: &str,
    own_lang: &str,
    targets: &[String],
) -> FlowAction {
    if !config.enabled || config.consent_version < 1 {
        return FlowAction::Drop;
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return FlowAction::PanelOnly { lang: None };
    }
    // Our own outgoing translated lines come back through the same chat
    // stream — never translate them again.
    if looks_like_own_echo(trimmed) {
        return FlowAction::PanelOnly { lang: None };
    }
    let verdict: LangVerdict = detect_line(trimmed, own_lang, config.detect.min_chars);
    match verdict.verdict {
        wowsp_tauri_shared::Verdict::Skip => FlowAction::PanelOnly {
            lang: verdict.script_hint,
        },
        wowsp_tauri_shared::Verdict::Translate => {
            if targets.is_empty() {
                FlowAction::PanelOnly {
                    lang: verdict.script_hint,
                }
            } else {
                FlowAction::Translate {
                    lang: verdict.script_hint,
                    targets: targets.to_vec(),
                }
            }
        },
    }
}

/// Plan one request against the battle cache: cache hit, in-flight coalesce,
/// backoff/rate gate, or ownership of a fresh request.
///
/// An `Owner` verdict that then hits the backoff/rate gate releases the key
/// again ([`CacheCore::fail`]) — no waiter may hang on a request that never
/// runs.
pub(crate) fn plan_request(cache: &mut CacheCore, key: &CacheKey, now_ms: i64) -> RequestPlan {
    match cache.begin(key) {
        LookupStart::Cached(value) => return RequestPlan::Cached(value),
        LookupStart::Waiter => return RequestPlan::AlreadyInFlight,
        LookupStart::Owner => {},
    }
    let remaining = cache.backoff_remaining_ms(now_ms);
    if remaining > 0 {
        cache.fail(key);
        return RequestPlan::Backoff {
            remaining_ms: remaining,
        };
    }
    if !cache.try_acquire_send_slot(now_ms) {
        cache.fail(key);
        return RequestPlan::RateLimited;
    }
    RequestPlan::Start
}

/// Map one engine answer onto the panel's outcome (no text = nothing to show,
/// a model-reported language wins as the badge).
pub(crate) fn outcome_of(result: &Result<LineTranslation>) -> TranslationOutcome {
    let Ok(line) = result else {
        return TranslationOutcome::default();
    };
    let translated = line.translations.iter().find_map(|(_, text, source)| {
        if *source == TranslationSource::Untranslatable || text.trim().is_empty() {
            None
        } else {
            Some(text.clone())
        }
    });
    TranslationOutcome {
        translated,
        lang: line.detected.clone(),
    }
}

/// Settle one finished request into the cache: success stores the translation
/// and clears the failure streak; failure releases the key and arms the next
/// backoff step. Returns the panel outcome.
pub(crate) fn settle_request(
    cache: &mut CacheCore,
    key: &CacheKey,
    result: &Result<LineTranslation>,
    now_ms: i64,
) -> TranslationOutcome {
    let outcome = outcome_of(result);
    if result.is_ok() {
        cache.record_success();
        // The empty string caches the "untranslatable" verdict (a repeat of
        // the same line must not re-ask the model).
        cache.finish(key, outcome.translated.as_deref().unwrap_or(""));
    } else {
        cache.fail(key);
        cache.record_failure(now_ms);
    }
    outcome
}

/// Cached value → panel outcome (an empty cached value = untranslatable).
fn cached_outcome(value: String) -> TranslationOutcome {
    TranslationOutcome {
        translated: (!value.is_empty()).then_some(value),
        lang: None,
    }
}

/// The synchronous half of the pipeline for one line: decide, plan, then
/// either apply a cached/blocked result to the row or hand back the request
/// job for the async half to run.
pub(crate) fn handle_line(
    state: &SharedLiveState,
    config: &ChatTranslateConfig,
    line: &ChatLine,
    now_ms: i64,
) -> Option<PendingTranslation> {
    let own_lang = context::resolve_self_lang(config);
    let targets = vec![own_lang.to_string()];
    let action = decide(config, &line.text, own_lang, &targets);
    match action {
        FlowAction::Drop => None,
        FlowAction::PanelOnly { lang } => {
            set_lang(state, line.id, lang);
            None
        },
        FlowAction::Translate { lang, targets } => {
            record_observed_language(state, &lang);
            let key = CacheKey::new(&line.text, &targets, GLOSSARY_VERSION);
            let plan = {
                let Ok(mut guard) = state.lock() else {
                    return None;
                };
                plan_request(&mut guard.cache, &key, now_ms)
            };
            match plan {
                RequestPlan::Cached(value) => {
                    let outcome = cached_outcome(value);
                    set_translation(state, line.id, lang, outcome.translated);
                    None
                },
                RequestPlan::AlreadyInFlight
                | RequestPlan::Backoff { .. }
                | RequestPlan::RateLimited => {
                    // The original row stays up, untranslated; no error UI.
                    set_lang(state, line.id, lang);
                    None
                },
                RequestPlan::Start => {
                    let (battle_key, context) = {
                        let Ok(guard) = state.lock() else {
                            return None;
                        };
                        let recent =
                            recent_lines(&guard.lines, line.id, config.context.recent_lines);
                        (guard.battle_key.clone(), context::build(&recent, &targets))
                    };
                    // The detector hint shows on the row while the request is
                    // in flight; the model's detected language wins later.
                    set_lang(state, line.id, lang.clone());
                    Some(PendingTranslation {
                        line_id: line.id,
                        battle_key,
                        text: line.text.clone(),
                        targets,
                        self_lang: own_lang.to_string(),
                        lang_hint: lang,
                        context,
                        key,
                    })
                },
            }
        },
    }
}

/// The asynchronous half: run the request through the injected translator,
/// then settle it into the cache and onto the row. Holds the state lock only
/// for the two short bookkeeping steps — never across the network wait.
pub(crate) async fn translate_and_publish(
    state: SharedLiveState,
    config: ChatTranslateConfig,
    job: PendingTranslation,
    translator: &dyn LineTranslator,
    now_ms: i64,
) {
    let request = TranslationRequest {
        config: &config,
        text: &job.text,
        targets: &job.targets,
        self_lang: &job.self_lang,
        context: &job.context,
    };
    let result = translator.translate(request).await;
    let Ok(mut guard) = state.lock() else {
        return;
    };
    // Battle moved on (or the gate reset and replayed ids) while the request
    // was in flight: the answer belongs to a battle the panel no longer
    // shows. Drop it BEFORE settling — otherwise the stale translation lands
    // on an unrelated renumbered row and pollutes the new battle's cache.
    if guard.battle_key != job.battle_key {
        return;
    }
    let outcome = settle_request(&mut guard.cache, &job.key, &result, now_ms);
    let lang = outcome.lang.clone().or(job.lang_hint.clone());
    guard.apply_translation(job.line_id, lang.clone(), outcome.translated.clone());
    // Duplicate lines that arrived while this request was in flight keep
    // their original row with NO translation of their own
    // (RequestPlan::AlreadyInFlight attaches no waiter) — the finished
    // answer fills every matching row, so a repeated line is never left
    // permanently untranslated while its twin shows the translation.
    let twins: Vec<i64> = guard
        .lines
        .iter()
        .filter(|line| {
            line.id != job.line_id
                && line.translated.is_none()
                && CacheKey::new(&line.text, &job.targets, GLOSSARY_VERSION) == job.key
        })
        .map(|line| line.id)
        .collect();
    for id in twins {
        guard.apply_translation(id, lang.clone(), outcome.translated.clone());
    }
    drop(guard);
    // The model's own detection is the strongest observed-language signal.
    if let Some(lang) = lang {
        record_observed_language(&state, &Some(lang));
    }
}

/// The live source's per-line entry point: run the synchronous half, and when
/// it hands back a job, spawn the async half. Never blocks the caller's tick.
pub(crate) fn submit(
    _app: AppHandle,
    state: SharedLiveState,
    config: ChatTranslateConfig,
    line: ChatLine,
) {
    let Some(job) = handle_line(&state, &config, &line, now_ms()) else {
        return;
    };
    // Emission belongs to the live source (its revision watcher); the app
    // handle rides the signature so the source can hand it straight through.
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        translate_and_publish(state, config, job, &EngineTranslator, now_ms()).await;
    });
}

// ── state helpers ───────────────────────────────────────────────────────────

/// Apply the detector/model hint to the pending row (revision bumps inside).
fn set_lang(state: &SharedLiveState, line_id: i64, lang: Option<String>) {
    if let Ok(mut guard) = state.lock() {
        guard.set_lang(line_id, lang);
    }
}

/// Apply a finished translation (and the language badge) to the row.
fn set_translation(
    state: &SharedLiveState,
    line_id: i64,
    lang: Option<String>,
    translated: Option<String>,
) {
    if let Ok(mut guard) = state.lock() {
        guard.apply_translation(line_id, lang, translated);
    }
}

/// Record a detected language for this battle (the future outgoing-target
/// set, see `context::observed_languages`).
///
/// The set is process-global and battle-scoped, so parallel unit tests would
/// fight over it (a sibling module's test asserts the set of ITS battle while
/// a flow test would switch it). The set itself is covered by `context`'s own
/// tests; the flow pipeline skips the side effect under `cfg(test)` only.
#[cfg(not(test))]
fn record_observed_language(state: &SharedLiveState, lang: &Option<String>) {
    let Some(lang) = lang.as_deref().and_then(super::lang::normalize_lang) else {
        return;
    };
    let Ok(guard) = state.lock() else {
        return;
    };
    context::add_observed_language(&guard.battle_key, lang);
}

#[cfg(test)]
fn record_observed_language(_state: &SharedLiveState, _lang: &Option<String>) {}

/// The recent ORIGINAL lines for the prompt, oldest first, excluding the line
/// being translated. `cap` is `context.recentLines` from the settings.
fn recent_lines(
    lines: &std::collections::VecDeque<ChatLine>,
    current_id: i64,
    cap: i64,
) -> Vec<RecentLine> {
    let cap = usize::try_from(cap.max(0)).unwrap_or(0);
    if cap == 0 {
        return Vec::new();
    }
    let mut recent: Vec<RecentLine> = lines
        .iter()
        .filter(|line| line.id != current_id)
        .rev()
        .take(cap)
        .map(|line| RecentChatLine {
            from: line.from.clone(),
            text: line.text.clone(),
        })
        .collect();
    recent.reverse();
    recent
}

/// Wall clock in unix milliseconds (the production clock; tests pass fixed
/// instants instead).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};

    use crate::commands::chat_translate::live::LiveState;

    use wowsp_tauri_shared::{
        ChatTranslateContextConfig, ChatTranslateDetectConfig, ChatTranslateDisplayConfig,
        ChatTranslateLanguagesConfig,
    };

    // ── fixtures ─────────────────────────────────────────────────────────

    fn enabled_config() -> ChatTranslateConfig {
        ChatTranslateConfig {
            enabled: true,
            consent_version: 1,
            languages: ChatTranslateLanguagesConfig {
                self_lang: "en".to_string(),
                ..ChatTranslateLanguagesConfig::default()
            },
            detect: ChatTranslateDetectConfig { min_chars: 2 },
            display: ChatTranslateDisplayConfig { max_lines: 8 },
            context: ChatTranslateContextConfig {
                recent_lines: 8,
                ..ChatTranslateContextConfig::default()
            },
            ..ChatTranslateConfig::default()
        }
    }

    fn line(id: i64, text: &str) -> ChatLine {
        ChatLine {
            id,
            t: id,
            from: "Foe03".to_string(),
            ns: "battle_common".to_string(),
            lang: None,
            text: text.to_string(),
            translated: None,
            self_line: false,
        }
    }

    fn state_with(lines: Vec<ChatLine>) -> SharedLiveState {
        let mut state = LiveState {
            battle_key: "battle-1".to_string(),
            lines: VecDeque::new(),
            next_line_id: 1,
            revision: 0,
            cache: CacheCore::new("battle-1"),
            max_lines: 8,
        };
        for line in lines {
            state.lines.push_back(line);
        }
        Arc::new(Mutex::new(state))
    }

    fn settle_ok(
        state: &SharedLiveState,
        line: &ChatLine,
        targets: &[String],
        text: &str,
        now: i64,
    ) {
        let key = CacheKey::new(&line.text, targets, GLOSSARY_VERSION);
        let result: Result<LineTranslation> = Ok(LineTranslation {
            detected: Some("ja".to_string()),
            translations: vec![(
                targets[0].clone(),
                text.to_string(),
                TranslationSource::Model,
            )],
        });
        let mut guard = state.lock().unwrap();
        let _ = settle_request(&mut guard.cache, &key, &result, now);
    }

    /// A canned translator: records the calls and returns the queued answer
    /// (never a network fallback).
    struct MockTranslator {
        calls: AtomicU32,
        answers: Mutex<VecDeque<Result<LineTranslation>>>,
    }

    impl MockTranslator {
        fn ok(text: &str) -> Self {
            Self::with(vec![Ok(LineTranslation {
                detected: Some("ja".to_string()),
                translations: vec![("en".to_string(), text.to_string(), TranslationSource::Model)],
            })])
        }

        fn failing() -> Self {
            Self::with(vec![Err(anyhow::anyhow!("synthetic provider failure"))])
        }

        fn with(answers: Vec<Result<LineTranslation>>) -> Self {
            Self {
                calls: AtomicU32::new(0),
                answers: Mutex::new(answers.into()),
            }
        }

        fn calls(&self) -> u32 {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl LineTranslator for MockTranslator {
        fn translate<'a>(&'a self, _request: TranslationRequest<'a>) -> TranslateFuture<'a> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.answers
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_else(|| Err(anyhow::anyhow!("mock translator exhausted")))
            })
        }
    }

    // ── decide: gates and filters ────────────────────────────────────────

    #[test]
    fn disabled_or_unconsented_lines_are_dropped() {
        let mut config = enabled_config();
        config.enabled = false;
        assert_eq!(
            decide(&config, "こんにちは", "en", &targets("en")),
            FlowAction::Drop
        );
        config.enabled = true;
        config.consent_version = 0;
        assert_eq!(
            decide(&config, "こんにちは", "en", &targets("en")),
            FlowAction::Drop,
            "consentVersion 0 must never post chat text"
        );
    }

    fn targets(lang: &str) -> Vec<String> {
        vec![lang.to_string()]
    }

    #[test]
    fn own_language_filler_commands_and_urls_never_request() {
        let config = enabled_config();
        for text in [
            "gg",
            "gl hf",
            "gg wp!",
            "lol",
            "o7",
            "/help",
            "https://example.com/foo",
            ":-)",
        ] {
            match decide(&config, text, "en", &targets("en")) {
                FlowAction::PanelOnly { .. } => {},
                other => panic!("{text:?} must stay panel-only, got {other:?}"),
            }
        }
        // Plain own-language English (a stopword hit) is readable already.
        match decide(
            &config,
            "the destroyer is not on the left side",
            "en",
            &targets("en"),
        ) {
            FlowAction::PanelOnly { .. } => {},
            other => panic!("own-language line must stay panel-only, got {other:?}"),
        }
    }

    #[test]
    fn our_own_translated_echo_never_requests() {
        let config = enabled_config();
        for text in [
            "[WOWSP同声传译] こんにちは",
            "line one [WOWSP live translation]",
            "你好 [WOWSP同聲傳譯] | こんにちは",
        ] {
            match decide(&config, text, "en", &targets("en")) {
                FlowAction::PanelOnly { .. } => {},
                other => panic!("own echo must stay panel-only, got {other:?}"),
            }
        }
    }

    #[test]
    fn foreign_language_lines_request_the_self_target() {
        let config = enabled_config();
        let action = decide(&config, "こんにちは、元気ですか", "en", &targets("en"));
        match action {
            FlowAction::Translate { lang, targets } => {
                assert_eq!(targets, vec!["en".to_string()]);
                assert_eq!(
                    lang.as_deref(),
                    Some("ja"),
                    "detector hint rides the action"
                );
            },
            other => panic!("foreign line must request, got {other:?}"),
        }
        // No target resolved: nothing to request even for a foreign line.
        match decide(&config, "こんにちは", "en", &[]) {
            FlowAction::PanelOnly { .. } => {},
            other => panic!("empty targets must stay panel-only, got {other:?}"),
        }
    }

    #[test]
    fn whitespace_only_lines_get_a_bare_panel_row() {
        let config = enabled_config();
        assert_eq!(
            decide(&config, "   ", "en", &targets("en")),
            FlowAction::PanelOnly { lang: None }
        );
    }

    // ── request planning / cache ────────────────────────────────────────

    #[test]
    fn plan_dedupes_in_flight_requests_and_hits_the_cache() {
        let mut cache = CacheCore::new("battle");
        let key = CacheKey::new("hello", &targets("en"), GLOSSARY_VERSION);
        assert_eq!(plan_request(&mut cache, &key, 0), RequestPlan::Start);
        assert_eq!(
            plan_request(&mut cache, &key, 0),
            RequestPlan::AlreadyInFlight,
            "a duplicate in-flight key must never issue a second request"
        );
        cache.finish(&key, "translated");
        assert_eq!(
            plan_request(&mut cache, &key, 0),
            RequestPlan::Cached("translated".to_string())
        );
    }

    #[test]
    fn plan_enforces_the_backoff_ladder_after_failures() {
        let mut cache = CacheCore::new("battle");
        let key = CacheKey::new("hello", &targets("en"), GLOSSARY_VERSION);
        assert_eq!(plan_request(&mut cache, &key, 0), RequestPlan::Start);
        cache.fail(&key);
        cache.record_failure(0);
        match plan_request(&mut cache, &key, 1_000) {
            RequestPlan::Backoff { remaining_ms } => assert_eq!(remaining_ms, 1_000),
            other => panic!("backoff must gate the retry, got {other:?}"),
        }
        assert_eq!(plan_request(&mut cache, &key, 2_000), RequestPlan::Start);
    }

    #[test]
    fn plan_enforces_the_sliding_rate_window() {
        let mut cache = CacheCore::new("battle");
        for index in 0..10 {
            let key = CacheKey::new(&format!("line {index}"), &targets("en"), GLOSSARY_VERSION);
            assert_eq!(plan_request(&mut cache, &key, 0), RequestPlan::Start);
            cache.fail(&key);
        }
        let key = CacheKey::new("one more", &targets("en"), GLOSSARY_VERSION);
        assert_eq!(plan_request(&mut cache, &key, 0), RequestPlan::RateLimited);
        // A window later a slot frees up.
        assert_eq!(plan_request(&mut cache, &key, 60_000), RequestPlan::Start);
    }

    #[test]
    fn settle_success_caches_and_clears_the_failure_streak() {
        let mut cache = CacheCore::new("battle");
        let key = CacheKey::new("hello", &targets("en"), GLOSSARY_VERSION);
        cache.record_failure(0);
        let result: Result<LineTranslation> = Ok(LineTranslation {
            detected: Some("ja".to_string()),
            translations: vec![(
                "en".to_string(),
                "translated".to_string(),
                TranslationSource::Model,
            )],
        });
        let outcome = settle_request(&mut cache, &key, &result, 100);
        assert_eq!(outcome.translated.as_deref(), Some("translated"));
        assert_eq!(outcome.lang.as_deref(), Some("ja"));
        assert_eq!(cache.consecutive_failures(), 0);
        assert_eq!(
            plan_request(&mut cache, &key, 100),
            RequestPlan::Cached("translated".to_string())
        );
    }

    #[test]
    fn settle_failure_stores_nothing_and_arms_the_backoff() {
        let mut cache = CacheCore::new("battle");
        let key = CacheKey::new("hello", &targets("en"), GLOSSARY_VERSION);
        let result: Result<LineTranslation> = Err(anyhow::anyhow!("synthetic failure"));
        let outcome = settle_request(&mut cache, &key, &result, 1_000);
        assert_eq!(outcome, TranslationOutcome::default());
        assert!(cache.consecutive_failures() >= 1);
        match plan_request(&mut cache, &key, 1_001) {
            RequestPlan::Backoff { remaining_ms } => assert!(remaining_ms > 0),
            other => panic!("a failed request must back off, got {other:?}"),
        }
    }

    #[test]
    fn untranslatable_answers_cache_the_empty_verdict() {
        let mut cache = CacheCore::new("battle");
        let key = CacheKey::new("12345", &targets("en"), GLOSSARY_VERSION);
        let result: Result<LineTranslation> = Ok(LineTranslation {
            detected: None,
            translations: vec![(
                "en".to_string(),
                String::new(),
                TranslationSource::Untranslatable,
            )],
        });
        let outcome = settle_request(&mut cache, &key, &result, 0);
        assert_eq!(outcome.translated, None);
        // A repeat of the same line gets the empty verdict back, not a request.
        assert_eq!(
            plan_request(&mut cache, &key, 0),
            RequestPlan::Cached(String::new())
        );
    }

    #[test]
    fn outcome_maps_model_passthrough_and_untranslatable_answers() {
        let model: Result<LineTranslation> = Ok(LineTranslation {
            detected: Some("ja".to_string()),
            translations: vec![(
                "en".to_string(),
                "hello".to_string(),
                TranslationSource::Model,
            )],
        });
        assert_eq!(
            outcome_of(&model),
            TranslationOutcome {
                translated: Some("hello".to_string()),
                lang: Some("ja".to_string())
            }
        );
        let passthrough: Result<LineTranslation> = Ok(LineTranslation {
            detected: Some("en".to_string()),
            translations: vec![(
                "en".to_string(),
                "original".to_string(),
                TranslationSource::Passthrough,
            )],
        });
        assert_eq!(
            outcome_of(&passthrough).translated.as_deref(),
            Some("original")
        );
        let untranslatable: Result<LineTranslation> = Ok(LineTranslation {
            detected: None,
            translations: vec![(
                "en".to_string(),
                String::new(),
                TranslationSource::Untranslatable,
            )],
        });
        assert_eq!(outcome_of(&untranslatable), TranslationOutcome::default());
        let failed: Result<LineTranslation> = Err(anyhow::anyhow!("nope"));
        assert_eq!(outcome_of(&failed), TranslationOutcome::default());
    }

    // ── sync half against the live state ────────────────────────────────

    #[test]
    fn handle_line_leaves_skip_rows_untranslated_with_their_hint() {
        let config = enabled_config();
        let line = line(7, "gg");
        let state = state_with(vec![line.clone()]);
        assert!(handle_line(&state, &config, &line, 0).is_none());
        let guard = state.lock().unwrap();
        assert_eq!(guard.lines.front().unwrap().translated, None);
        assert_eq!(
            guard.lines.front().unwrap().lang,
            None,
            "filler carries no hint"
        );
    }

    #[test]
    fn handle_line_applies_a_cache_hit_without_a_request() {
        let config = enabled_config();
        let line = line(3, "こんにちは");
        let state = state_with(vec![line.clone()]);
        settle_ok(&state, &line, &targets("en"), "hello", 0);
        assert!(handle_line(&state, &config, &line, 1).is_none());
        let guard = state.lock().unwrap();
        assert_eq!(
            guard.lines.front().unwrap().translated.as_deref(),
            Some("hello")
        );
    }

    #[test]
    fn handle_line_returns_the_request_job_and_marks_the_row_pending() {
        let config = enabled_config();
        let previous = line(1, "earlier line");
        let line = line(2, "こんにちは、元気ですか");
        let state = state_with(vec![previous, line.clone()]);
        let job = handle_line(&state, &config, &line, 0).expect("a fresh foreign line requests");
        assert_eq!(job.line_id, 2);
        assert_eq!(job.targets, vec!["en".to_string()]);
        assert_eq!(job.self_lang, "en");
        assert_eq!(job.context.recent.len(), 1, "the previous line is context");
        let guard = state.lock().unwrap();
        assert_eq!(
            guard.lines.back().unwrap().lang.as_deref(),
            Some("ja"),
            "the detector hint shows while the request runs"
        );
        assert_eq!(guard.lines.back().unwrap().translated, None);
    }

    #[test]
    fn disabled_config_never_touches_the_state() {
        let mut config = enabled_config();
        config.enabled = false;
        let line = line(1, "こんにちは");
        let state = state_with(vec![line.clone()]);
        assert!(handle_line(&state, &config, &line, 0).is_none());
        let guard = state.lock().unwrap();
        assert_eq!(guard.revision, 0, "a disabled pipeline mutates nothing");
        assert_eq!(guard.lines.front().unwrap().lang, None);
    }

    // ── async half ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn translate_and_publish_writes_the_translation_onto_the_row() {
        let config = enabled_config();
        let line = line(5, "こんにちは、元気ですか");
        let state = state_with(vec![line.clone()]);
        let job = handle_line(&state, &config, &line, 0).expect("job");
        let translator = MockTranslator::ok("hello there");
        translate_and_publish(state.clone(), config, job, &translator, 10).await;
        assert_eq!(translator.calls(), 1);
        let guard = state.lock().unwrap();
        let row = guard.lines.back().unwrap();
        assert_eq!(row.translated.as_deref(), Some("hello there"));
        assert_eq!(row.lang.as_deref(), Some("ja"));
        assert!(
            guard.revision > 0,
            "the live source emits on revision bumps"
        );
    }

    /// Regression (R2 NICE-1): a battle switch (or the enable-gate reset)
    /// renumbers line ids while a request is in flight — the stale answer
    /// must neither land on the new battle's renumbered row nor settle into
    /// the new battle's cache.
    #[tokio::test]
    async fn a_stale_request_never_lands_on_the_next_battle() {
        let config = enabled_config();
        let template = line(1, "");
        let original = line(1, "こんにちは、元気ですか");
        let state = state_with(vec![original.clone()]);
        let job = handle_line(&state, &config, &original, 0).expect("job");
        // The battle flips while the request is in flight; the new battle
        // replays id 1 with DIFFERENT text.
        {
            let mut guard = state.lock().unwrap();
            guard.battle_key = "battle-2".to_string();
            guard.cache = CacheCore::new("battle-2");
            guard.lines.clear();
            guard.next_line_id = 1;
            guard.lines.push_back(ChatLine {
                id: 1,
                text: "новое сообщение".to_string(),
                ..template.clone()
            });
        }
        let translator = MockTranslator::ok("hello there");
        translate_and_publish(state.clone(), config, job, &translator, 10).await;
        let mut guard = state.lock().unwrap();
        let row = guard.lines.back().unwrap();
        assert_eq!(row.text, "новое сообщение");
        assert_eq!(row.translated, None, "the stale answer must not land");
        assert_eq!(row.lang, None);
        // And nothing settled into the new battle's cache either.
        let targets = vec!["en".to_string()];
        let key = CacheKey::new("こんにちは、元気ですか", &targets, GLOSSARY_VERSION);
        assert!(matches!(
            plan_request(&mut guard.cache, &key, 10_000),
            RequestPlan::Start
        ));
    }

    /// Regression (R1 NICE-2): a duplicate line that arrived while the
    /// first request was in flight gets no waiter of its own — the owner's
    /// finished answer must backfill every matching row.
    #[tokio::test]
    async fn translate_and_publish_backfills_in_flight_duplicates() {
        let config = enabled_config();
        let original = line(5, "こんにちは、元気ですか");
        let duplicate = ChatLine {
            id: 6,
            ..original.clone()
        };
        let state = state_with(vec![original.clone(), duplicate.clone()]);
        let job = handle_line(&state, &config, &original, 0).expect("job");
        // The duplicate arrives mid-flight: no second request, no waiter.
        assert!(handle_line(&state, &config, &duplicate, 1).is_none());
        let translator = MockTranslator::ok("hello there");
        translate_and_publish(state.clone(), config, job, &translator, 10).await;
        assert_eq!(translator.calls(), 1);
        let guard = state.lock().unwrap();
        for row in guard.lines.iter() {
            assert_eq!(
                row.translated.as_deref(),
                Some("hello there"),
                "row {} must be backfilled",
                row.id
            );
        }
    }

    #[tokio::test]
    async fn translate_and_publish_failure_keeps_the_row_untranslated_and_backs_off() {
        let config = enabled_config();
        let line = line(9, "こんにちは、元気ですか");
        let state = state_with(vec![line.clone()]);
        let job = handle_line(&state, &config, &line, 0).expect("job");
        let key = job.key.clone();
        let translator = MockTranslator::failing();
        translate_and_publish(state.clone(), config, job, &translator, 1_000).await;
        assert_eq!(translator.calls(), 1);
        let mut guard = state.lock().unwrap();
        assert_eq!(guard.lines.back().unwrap().translated, None);
        match plan_request(&mut guard.cache, &key, 1_001) {
            RequestPlan::Backoff { remaining_ms } => assert!(remaining_ms > 0),
            other => panic!("failure must arm the backoff, got {other:?}"),
        }
    }

    #[test]
    fn recent_lines_exclude_the_current_line_and_keep_oldest_first() {
        let lines: VecDeque<ChatLine> = vec![
            line(1, "one"),
            line(2, "two"),
            line(3, "three"),
            line(4, "four"),
        ]
        .into();
        // Current line id 5 (not in the ring): the last two predecessors
        // survive, oldest first.
        assert_eq!(
            recent_lines(&lines, 5, 2),
            vec![
                RecentChatLine {
                    from: "Foe03".to_string(),
                    text: "three".to_string()
                },
                RecentChatLine {
                    from: "Foe03".to_string(),
                    text: "four".to_string()
                },
            ]
        );
        // The line being translated is never its own context.
        assert_eq!(
            recent_lines(&lines, 4, 2),
            vec![
                RecentChatLine {
                    from: "Foe03".to_string(),
                    text: "two".to_string()
                },
                RecentChatLine {
                    from: "Foe03".to_string(),
                    text: "three".to_string()
                },
            ]
        );
        assert!(recent_lines(&lines, 4, 0).is_empty());
    }
}
