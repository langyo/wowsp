//! The translation request pipeline behind one chat line: build the
//! chat-completions request, repair the model's JSON answer, validate it into
//! [LineTranslation], and surface failures only as short user-facing
//! sentences.
//!
//! Flow: build request (prompt.rs system prompt + user payload,
//! response_format json_object, max_tokens 512) -> POST
//! {base}/chat/completions -> choices[0].message.content -> repair (code
//! fences, junk around the object, unclosed/truncated answers and empty
//! content retried at most ONCE) -> validate (only requested target keys,
//! strings only, control characters to spaces, length cap, detected-target
//! passthrough, untranslatable empties) -> [LineTranslation].
//!
//! Transport is injected through [CompletionTransport] so every case in this
//! module is unit-tested against canned responses with zero real network.
//! Production entry points are [translate_line] (caller-owned reqwest client)
//! and [translate_line_configured] (settings + the shared proxy-aware client).
//! [translate_line_traced] runs the exact same pipeline and additionally
//! returns a [LineTrace] of the FINAL attempt (system prompt, user payload,
//! POST body, parsed/raw answer) for the settings page's translation-test
//! window; the production paths pass no trace and pay nothing for it. The
//! trace body NEVER carries the API key — the key only rides the
//! Authorization header — so a trace is safe to show in the UI.
//! Nothing here logs a request or response body.

use anyhow::{Result, anyhow, bail};

use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::{Value, json};

use wowsp_tauri_shared::{ChatTranslateConfig, MatchContext};

use crate::commands::network::build_http_client;

use super::config;
use super::prompt::{SYSTEM_PROMPT, build_user_payload};

/// max_tokens of the first request; the truncation retry doubles it.
const BASE_MAX_TOKENS: u32 = 512;
/// Retry hint appended to the user message when the provider answered with
/// empty content (a known occasional provider behaviour). The JSON-mode
/// guide asks for this nudge when the model returns nothing.
const EMPTY_CONTENT_RETRY_HINT: &str = "Return only the JSON object.";
/// Translation length cap: min(4 * effective original length + 64, 400).
const LENGTH_CAP_BASE: usize = 64;
const LENGTH_CAP_MULTIPLIER: usize = 4;
const LENGTH_CAP_MAX: usize = 400;

/// A borrowed, resolved view of the provider settings one request needs.
/// Built from the stored settings by [ConfigView::from_config]; the API key
/// is already resolved (env override applied on the read side).
pub(crate) struct ConfigView {
    pub base_url: String,
    pub model: String,
    /// Resolved key; None when the user never configured one.
    pub api_key: Option<String>,
    pub timeout_ms: i64,
    pub temperature: f64,
}

impl ConfigView {
    /// Resolve the view from the stored settings. The key comes from
    /// config::effective_api_key - the environment override wins, read-side
    /// only (nothing is written back).
    pub(crate) fn from_config(config: &ChatTranslateConfig) -> Self {
        Self {
            base_url: config.provider.base_url.clone(),
            model: config.provider.model.clone(),
            api_key: config::effective_api_key(config),
            timeout_ms: config.provider.timeout_ms,
            temperature: config.provider.temperature,
        }
    }

    /// {base}/chat/completions, tolerant of a stored trailing slash.
    fn completions_url(&self) -> String {
        format!("{}/chat/completions", self.base_url.trim_end_matches('/'))
    }

    /// Configured timeout (sanitized configs are 3 000..=60 000 ms; the
    /// fallback keeps a hostile hand-edited value from panicking).
    fn timeout(&self) -> Duration {
        Duration::from_millis(u64::try_from(self.timeout_ms).unwrap_or(10_000))
    }
}

/// Where one translated string came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TranslationSource {
    /// Translated by the model.
    Model,
    /// The line was already in the target language - the ORIGINAL text is
    /// passed through untouched.
    Passthrough,
    /// Nothing to translate (symbols/digits/emotes) - the text is empty.
    Untranslatable,
}

/// One line's translation result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LineTranslation {
    /// The model's language tag for the source line, when it answered with
    /// one (canonicalized to the known table where possible).
    pub detected: Option<String>,
    /// (language tag, text, source) in REQUEST target order. Targets the
    /// model did not answer for are omitted; a passthrough target is always
    /// present (the original line needs no model text).
    pub translations: Vec<(String, String, TranslationSource)>,
}

/// One debug snapshot of the FINAL provider attempt (see
/// [translate_line_traced]): exactly what the pipeline sent and what the model
/// answered on its last try, for the settings page's JSON-tree view.
///
/// The request body is the real POST body (prompt + knobs) and deliberately
/// carries NO credential — the API key travels in the Authorization header
/// only, so this struct is safe to hand to the webui.
#[derive(Debug, Clone, Default)]
pub(crate) struct LineTrace {
    /// The stable system prompt of that attempt.
    pub system_prompt: String,
    /// The user message content (request JSON line + newline + context blob).
    pub user_payload: String,
    /// The complete POST body (model/messages/knobs), key-free.
    pub request_body: Value,
    /// The model answer parsed into its JSON object (fence/junk repaired).
    /// None when the answer was not a JSON object (or no answer arrived).
    pub response: Option<Value>,
    /// The model answer's raw content text (unparsed), for the fallback view.
    pub response_raw: Option<String>,
}

/// One raw request to the provider's chat-completions endpoint.
#[derive(Debug, Clone)]
struct CompletionRequest {
    url: String,
    api_key: String,
    body: Value,
    timeout: Duration,
}

/// One raw answer: status code + response body text. Interpretation belongs
/// to the pipeline, not the transport.
#[derive(Debug, Clone)]
struct CompletionResponse {
    status: u16,
    body: String,
}

/// The transport seam. Production uses [ReqwestTransport]; tests inject a
/// canned-response mock, so the whole pipeline runs with zero real network.
trait CompletionTransport {
    fn send<'a>(
        &'a self,
        request: &'a CompletionRequest,
    ) -> BoxFuture<'a, Result<CompletionResponse>>;
}

/// The production transport: the shared proxy-aware reqwest client.
struct ReqwestTransport<'a> {
    client: &'a reqwest::Client,
}

impl CompletionTransport for ReqwestTransport<'_> {
    fn send<'a>(
        &'a self,
        request: &'a CompletionRequest,
    ) -> BoxFuture<'a, Result<CompletionResponse>> {
        Box::pin(async move {
            let response = self
                .client
                .post(&request.url)
                .header("Authorization", format!("Bearer {}", request.api_key))
                .timeout(request.timeout)
                .json(&request.body)
                .send()
                .await
                .map_err(|error| {
                    if error.is_timeout() {
                        anyhow!("translation service request timed out")
                    } else if error.is_connect() {
                        anyhow!("translation service connection failed")
                    } else {
                        anyhow!("translation service request failed")
                    }
                })?;
            let status = response.status().as_u16();
            let body = response
                .text()
                .await
                .map_err(|_| anyhow!("translation service returned an unreadable response"))?;
            Ok(CompletionResponse { status, body })
        })
    }
}

/// Translate one chat line into every requested target language.
///
/// client is the caller's proxy-aware reqwest client (see
/// network::build_http_client); context is the battle summary M2 fills.
pub(crate) async fn translate_line(
    client: &reqwest::Client,
    cfg: &ConfigView,
    text: &str,
    targets: &[String],
    self_lang: &str,
    context: &MatchContext,
) -> Result<LineTranslation> {
    translate_line_with(
        &ReqwestTransport { client },
        cfg,
        text,
        targets,
        self_lang,
        context,
        None,
    )
    .await
}

/// Convenience for callers that only hold the settings document (the live
/// pipeline and the debug command): resolve the view, build the shared
/// proxy-aware client and run the same pipeline.
pub(crate) async fn translate_line_configured(
    config: &ChatTranslateConfig,
    text: &str,
    targets: &[String],
    self_lang: &str,
    context: &MatchContext,
) -> Result<LineTranslation> {
    translate_configured(config, text, targets, self_lang, context, None).await
}

/// Same pipeline as [translate_line_configured], plus the final attempt's
/// [LineTrace] for the settings page's translation-test window. The trace is
/// filled from the pipeline's LAST attempt: the successful retry when one
/// happened, else the failed request/answer.
/// Unlike the translation itself, the trace is ALSO returned when the pipeline
/// fails: the settings window renders the request and the provider's raw answer
/// next to the error, which is exactly the debugging case the window exists
/// for (a malformed answer must not hide what was sent and received).
pub(crate) async fn translate_line_traced(
    config: &ChatTranslateConfig,
    text: &str,
    targets: &[String],
    self_lang: &str,
    context: &MatchContext,
) -> (LineTrace, Result<LineTranslation>) {
    let mut trace = LineTrace::default();
    let line =
        translate_configured(config, text, targets, self_lang, context, Some(&mut trace)).await;
    (trace, line)
}

/// Shared client/view resolution for the two configured entry points; the
/// optional trace flows straight into the pipeline core.
async fn translate_configured(
    config: &ChatTranslateConfig,
    text: &str,
    targets: &[String],
    self_lang: &str,
    context: &MatchContext,
    trace: Option<&mut LineTrace>,
) -> Result<LineTranslation> {
    let client = build_http_client()?;
    let cfg = ConfigView::from_config(config);
    match trace {
        // Production path: exactly the caller-owned-client pipeline, no trace
        // bookkeeping (the pipeline core sees None and compiles it away).
        None => translate_line(&client, &cfg, text, targets, self_lang, context).await,
        Some(trace) => {
            translate_line_with(
                &ReqwestTransport { client: &client },
                &cfg,
                text,
                targets,
                self_lang,
                context,
                Some(trace),
            )
            .await
        },
    }
}

/// The pipeline core, generic over the injected transport (unit-test seam).
async fn translate_line_with<T: CompletionTransport + ?Sized>(
    transport: &T,
    cfg: &ConfigView,
    text: &str,
    targets: &[String],
    self_lang: &str,
    context: &MatchContext,
    mut trace: Option<&mut LineTrace>,
) -> Result<LineTranslation> {
    let Some(api_key) = cfg
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    else {
        bail!("no API key configured - save one in Settings -> Chat translation");
    };
    let targets = canonical_targets(targets);
    if targets.is_empty() {
        bail!("no target languages requested");
    }
    let url = cfg.completions_url();
    let mut max_tokens = BASE_MAX_TOKENS;
    let mut retry_hint = false;
    let mut retried = false;
    loop {
        let body = request_body(
            cfg, text, &targets, self_lang, context, max_tokens, retry_hint,
        );
        // Record the attempt BEFORE sending: a transport failure still leaves
        // the request visible, and a later retry overwrites this snapshot so
        // the trace always describes the FINAL attempt.
        if let Some(trace) = trace.as_mut() {
            trace.system_prompt = SYSTEM_PROMPT.to_string();
            trace.user_payload = body
                .get("messages")
                .and_then(Value::as_array)
                .and_then(|messages| messages.get(1))
                .and_then(|message| message.get("content"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            trace.request_body = body.clone();
            trace.response = None;
            trace.response_raw = None;
        }
        let request = CompletionRequest {
            url: url.clone(),
            api_key: api_key.to_string(),
            body,
            timeout: cfg.timeout(),
        };
        let response = transport.send(&request).await?;
        if !(200..300).contains(&response.status) {
            bail!("translation service returned HTTP {}", response.status);
        }
        let completion = parse_completion(&response.body)?;
        let content = completion
            .content
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_string();
        if content.is_empty() {
            if retried {
                bail!("translation service returned an empty answer");
            }
            retried = true;
            retry_hint = true;
            continue;
        }
        let parsed = parse_answer_object(&content);
        if let Some(trace) = trace.as_mut() {
            trace.response_raw = Some(content.clone());
            trace.response = parsed.clone();
        }
        match parsed {
            Some(value) => return validate_answer(value, &targets, text),
            None if !retried && completion.looks_truncated(&content) => {
                // One truncation retry with double the token budget.
                retried = true;
                max_tokens = max_tokens.saturating_mul(2);
                continue;
            },
            None => bail!("translation service returned an unexpected answer"),
        }
    }
}

/// The user message content for one attempt. The optional retry hint is
/// appended on its own line so the context blob's JSON stays intact.
fn request_body(
    cfg: &ConfigView,
    text: &str,
    targets: &[String],
    self_lang: &str,
    context: &MatchContext,
    max_tokens: u32,
    retry_hint: bool,
) -> Value {
    let mut user = build_user_payload(text, targets, self_lang, context);
    if retry_hint {
        user.push('\n');
        user.push_str(EMPTY_CONTENT_RETRY_HINT);
    }
    json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": user },
        ],
        "temperature": cfg.temperature,
        "max_tokens": max_tokens,
        "response_format": { "type": "json_object" },
        "stream": false,
    })
}

/// One parsed chat-completions envelope (content may be absent).
struct Completion {
    content: Option<String>,
    finish_reason: Option<String>,
}

impl Completion {
    /// The contract's truncation signal: the provider said `length` AND the
    /// answer did not close its JSON object. Only then is one retry with a
    /// doubled token budget justified — a plain malformed answer (wrong shape,
    /// prose) is reported instead of re-requested.
    fn looks_truncated(&self, content: &str) -> bool {
        matches!(self.finish_reason.as_deref(), Some("length"))
            && !content.trim_end().ends_with('}')
    }
}

/// Extract choices[0].message.content / choices[0].finish_reason from the
/// HTTP body. A body that is not JSON, or carries no usable choice, leaves
/// content as None and the empty-content path owns the message.
fn parse_completion(body: &str) -> Result<Completion> {
    let value: Value = serde_json::from_str(body)
        .map_err(|_| anyhow!("translation service returned an unexpected response"))?;
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first());
    let content = choice
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let finish_reason = choice
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(Completion {
        content,
        finish_reason,
    })
}

/// Repair and parse the model's answer text into the JSON object it
/// promises. Order: strip a markdown fence, trim junk before the first open
/// brace / after the last close brace, then parse. None means "not a JSON
/// object" (the caller decides between a truncation retry and a hard error).
fn parse_answer_object(content: &str) -> Option<Value> {
    let stripped = strip_code_fences(content);
    let trimmed = stripped.trim();
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&trimmed[start..=end]).ok()
}

/// One backtick as a unicode escape (deliberately not a literal, so the
/// fence handling stays readable in editors and diff tools).
const BACKTICK: char = '\u{60}';

/// The three-backtick fence token (markdown code fence).
fn fence_token() -> String {
    [BACKTICK; 3].into_iter().collect()
}

/// Strip one surrounding markdown fence (with or without an info string) -
/// models occasionally wrap the JSON despite the "no fences" instruction.
fn strip_code_fences(content: &str) -> &str {
    let mut text = content.trim();
    let fence = fence_token();
    if let Some(rest) = text.strip_prefix(fence.as_str()) {
        text = match rest.split_once('\n') {
            Some((_info, body)) => body,
            None => rest,
        };
        text = text.trim_end();
        if let Some(inner) = text.strip_suffix(fence.as_str()) {
            text = inner.trim_end();
        }
    }
    text
}

/// Canonical spelling of a known language tag (mirrors the config heal table),
/// or None for an unknown tag/empty value. The exact table wins first; tags
/// outside it fall back to [`super::lang::normalize_lang`], which also folds
/// the aliases the model may answer with ("zh"/"zh-Hans" → zh-CN,
/// "zh-Hant" → zh-TW, region-suffixed forms like "en-US") so a Passthrough
/// verdict never misses on spelling.
fn canonical_tag(raw: &str) -> Option<&'static str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    wowsp_tauri_shared::SUPPORTED_LANGS
        .iter()
        .copied()
        .find(|tag| tag.eq_ignore_ascii_case(trimmed))
        .or_else(|| super::lang::normalize_lang(trimmed))
}

/// Whether two language tags name the same language (canonical table first,
/// case-insensitive fallback for tags outside it).
fn same_lang(a: &str, b: &str) -> bool {
    match (canonical_tag(a), canonical_tag(b)) {
        (Some(a), Some(b)) => a == b,
        _ => a.trim().eq_ignore_ascii_case(b.trim()),
    }
}

/// Dedupe + canonicalize the requested targets, preserving request order.
/// Unknown tags are kept trimmed so a future language still reaches the
/// model — but note [`validate_answer`] only ACCEPTS answer keys the
/// canonical table knows, so an unknown target is ask-only, never answered
/// (the settings sanitize already narrows targets to the known table, which
/// makes the pair consistent in practice). Blank entries are dropped.
fn canonical_targets(targets: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(targets.len());
    for target in targets {
        let trimmed = target.trim();
        if trimmed.is_empty() {
            continue;
        }
        let tag = canonical_tag(trimmed)
            .map(str::to_string)
            .unwrap_or_else(|| trimmed.to_string());
        if !out.iter().any(|existing| same_lang(existing, &tag)) {
            out.push(tag);
        }
    }
    out
}

/// Validate the model's JSON object into a [LineTranslation]: detected must
/// be a string when present (a non-string is treated as missing); only keys
/// inside the requested target set survive (canonicalized and
/// case-insensitive), unknown keys and non-string values are dropped; control
/// characters collapse to single spaces; an over-cap translation is truncated
/// with an ellipsis; a target equal to detected passes the ORIGINAL text
/// through; an empty translation is Untranslatable with empty text.
fn validate_answer(value: Value, targets: &[String], original: &str) -> Result<LineTranslation> {
    let Value::Object(map) = value else {
        bail!("translation service returned an unexpected answer");
    };
    let detected = map
        .get("detected")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(|tag| {
            canonical_tag(tag)
                .map(str::to_string)
                .unwrap_or_else(|| tag.to_string())
        });
    let mut by_lang: Vec<(String, String)> = Vec::new();
    for (key, value) in &map {
        if key == "detected" {
            continue;
        }
        let Some(tag) = canonical_tag(key) else {
            continue; // unknown keys are noise
        };
        if !targets.iter().any(|target| same_lang(target, tag)) {
            continue; // a language we did not ask for
        }
        let Some(text) = value.as_str() else {
            continue; // non-string values are noise
        };
        if !by_lang.iter().any(|(existing, _)| existing == tag) {
            by_lang.push((tag.to_string(), text.to_string()));
        }
    }

    let char_cap = translation_char_cap(original);
    let mut translations = Vec::with_capacity(targets.len());
    for target in targets {
        if let Some(detected) = &detected
            && same_lang(detected, target)
        {
            translations.push((
                target.clone(),
                original.to_string(),
                TranslationSource::Passthrough,
            ));
            continue;
        }
        let tag = canonical_tag(target)
            .map(str::to_string)
            .unwrap_or_else(|| target.clone());
        let Some(index) = by_lang.iter().position(|(lang, _)| lang == &tag) else {
            continue; // the model skipped this target
        };
        let raw = by_lang.remove(index).1;
        let cleaned = clean_translation(&raw);
        if cleaned.is_empty() {
            translations.push((
                target.clone(),
                String::new(),
                TranslationSource::Untranslatable,
            ));
        } else {
            translations.push((
                target.clone(),
                truncate_translation(&cleaned, char_cap),
                TranslationSource::Model,
            ));
        }
    }
    Ok(LineTranslation {
        detected,
        translations,
    })
}

/// Collapse every control character / whitespace run to a single space and
/// trim the edges (a translation must be one clean chat line).
fn clean_translation(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_control() || ch.is_whitespace() {
            if !out.is_empty() && !out.ends_with(' ') {
                out.push(' ');
            }
        } else {
            out.push(ch);
        }
    }
    out.trim().to_string()
}

/// Character cap for one translation: min(4 * effective original length + 64,
/// 400), where effective counts non-whitespace characters of the source line.
fn translation_char_cap(original: &str) -> usize {
    let effective = original
        .chars()
        .filter(|ch| !ch.is_whitespace() && !ch.is_control())
        .count();
    effective
        .saturating_mul(LENGTH_CAP_MULTIPLIER)
        .saturating_add(LENGTH_CAP_BASE)
        .min(LENGTH_CAP_MAX)
}

/// Truncate to the cap with a trailing ellipsis (the ellipsis is part of the
/// cap, so display widths stay predictable).
fn truncate_translation(text: &str, cap: usize) -> String {
    if text.chars().count() <= cap {
        return text.to_string();
    }
    let mut out: String = text.chars().take(cap.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    /// Canned-response transport: records every request, pops one answer per
    /// call. A missing canned answer is an explicit failure, never a network
    /// fallback.
    struct MockTransport {
        responses: Mutex<VecDeque<Result<CompletionResponse>>>,
        requests: Mutex<Vec<CompletionRequest>>,
    }

    impl MockTransport {
        fn ok(bodies: &[String]) -> Self {
            Self {
                responses: Mutex::new(
                    bodies
                        .iter()
                        .map(|body| {
                            Ok(CompletionResponse {
                                status: 200,
                                body: body.clone(),
                            })
                        })
                        .collect(),
                ),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<CompletionRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl CompletionTransport for MockTransport {
        fn send<'a>(
            &'a self,
            request: &'a CompletionRequest,
        ) -> BoxFuture<'a, Result<CompletionResponse>> {
            Box::pin(async move {
                self.requests.lock().unwrap().push(request.clone());
                self.responses
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_else(|| Err(anyhow!("mock transport exhausted")))
            })
        }
    }

    fn cfg() -> ConfigView {
        ConfigView {
            base_url: "https://api.test".into(),
            model: "deepseek-flash".into(),
            api_key: Some("sk-test".into()),
            timeout_ms: 10_000,
            temperature: 0.0,
        }
    }

    fn ctx() -> MatchContext {
        MatchContext::default()
    }

    fn completion(content: &str, finish_reason: &str) -> String {
        json!({
            "choices": [{
                "message": { "content": content },
                "finish_reason": finish_reason,
            }],
        })
        .to_string()
    }

    fn targets(list: &[&str]) -> Vec<String> {
        list.iter().map(|tag| tag.to_string()).collect()
    }

    async fn run(
        transport: &MockTransport,
        text: &str,
        target_tags: &[&str],
    ) -> Result<LineTranslation> {
        translate_line_with(
            transport,
            &cfg(),
            text,
            &targets(target_tags),
            "en",
            &ctx(),
            None,
        )
        .await
    }

    #[tokio::test]
    async fn normal_answer_parses_and_request_contract_holds() {
        let transport = MockTransport::ok(&[completion(
            &json!({ "detected": "en", "ja": "こんにちは" }).to_string(),
            "stop",
        )]);
        let result = run(&transport, "hello", &["ja"]).await.unwrap();
        assert_eq!(result.detected.as_deref(), Some("en"));
        assert_eq!(
            result.translations,
            vec![(
                "ja".to_string(),
                "こんにちは".to_string(),
                TranslationSource::Model
            )]
        );

        let calls = transport.calls();
        assert_eq!(calls.len(), 1);
        let request = &calls[0];
        assert_eq!(request.url, "https://api.test/chat/completions");
        assert_eq!(request.api_key, "sk-test");
        assert_eq!(request.timeout, Duration::from_millis(10_000));
        assert_eq!(request.body["model"], "deepseek-flash");
        assert_eq!(request.body["temperature"], 0.0);
        assert_eq!(request.body["max_tokens"], 512);
        assert_eq!(request.body["response_format"]["type"], "json_object");
        assert_eq!(request.body["stream"], false);
        assert_eq!(request.body["messages"][0]["role"], "system");
        assert_eq!(request.body["messages"][0]["content"], SYSTEM_PROMPT);
        assert_eq!(request.body["messages"][1]["role"], "user");
        assert_eq!(
            request.body["messages"][1]["content"],
            build_user_payload("hello", &targets(&["ja"]), "en", &ctx())
        );
    }

    #[tokio::test]
    async fn fenced_and_junk_wrapped_answers_are_repaired() {
        let fence = fence_token();
        let fenced = format!("{fence}json\n{}\n{fence}", json!({ "ja": "x" }));
        for body in [
            completion(&fenced, "stop"),
            completion(
                &format!("Sure, here you go: {} - done", json!({ "ja": "x" })),
                "stop",
            ),
        ] {
            let transport = MockTransport::ok(&[body]);
            let result = run(&transport, "hello", &["ja"]).await.unwrap();
            assert_eq!(
                result.translations,
                vec![("ja".to_string(), "x".to_string(), TranslationSource::Model)]
            );
        }
    }

    #[tokio::test]
    async fn truncated_answer_retries_once_with_doubled_max_tokens() {
        let transport = MockTransport::ok(&[
            completion(r#"{"ja":"x"#, "length"),
            completion(&json!({ "ja": "ok" }).to_string(), "stop"),
        ]);
        let result = run(&transport, "hello", &["ja"]).await.unwrap();
        assert_eq!(result.translations[0].1, "ok");
        let calls = transport.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].body["max_tokens"], 512);
        assert_eq!(calls[1].body["max_tokens"], 1024);
    }

    #[tokio::test]
    async fn empty_content_retries_once_with_the_json_hint() {
        let transport = MockTransport::ok(&[
            completion("", "stop"),
            completion(&json!({ "ja": "ok" }).to_string(), "stop"),
        ]);
        let result = run(&transport, "hello", &["ja"]).await.unwrap();
        assert_eq!(result.translations[0].1, "ok");
        let calls = transport.calls();
        assert_eq!(calls.len(), 2);
        let user = calls[1].body["messages"][1]["content"].as_str().unwrap();
        assert!(user.contains(EMPTY_CONTENT_RETRY_HINT));
    }

    #[tokio::test]
    async fn at_most_one_retry_then_error() {
        let transport = MockTransport::ok(&[completion("", "stop"), completion("", "stop")]);
        let error = run(&transport, "hello", &["ja"]).await.unwrap_err();
        assert!(error.to_string().contains("empty answer"), "{error}");
        assert_eq!(transport.calls().len(), 2);
    }

    #[tokio::test]
    async fn unknown_keys_and_non_string_values_are_dropped() {
        let payload = json!({
            "detected": "en",
            "ja": "ok",
            "ko": 42,
            "zz": "no such target",
        });
        let transport = MockTransport::ok(&[completion(&payload.to_string(), "stop")]);
        let result = run(&transport, "hello", &["ja", "ko"]).await.unwrap();
        assert_eq!(
            result.translations,
            vec![("ja".to_string(), "ok".to_string(), TranslationSource::Model)]
        );
    }

    #[tokio::test]
    async fn detected_target_passes_the_original_through() {
        let transport = MockTransport::ok(&[completion(
            &json!({ "detected": "ja", "ja": "model text" }).to_string(),
            "stop",
        )]);
        let result = run(&transport, "こんにちは", &["ja"]).await.unwrap();
        assert_eq!(
            result.translations,
            vec![(
                "ja".to_string(),
                "こんにちは".to_string(),
                TranslationSource::Passthrough
            )]
        );
    }

    /// Regression (R1' N3): a model answering with the BARE alias "zh" must
    /// still map onto the requested zh-CN target and pass the original
    /// through — the alias fallback in [canonical_tag] closes that gap.
    #[tokio::test]
    async fn detected_alias_still_matches_its_canonical_target() {
        let transport = MockTransport::ok(&[completion(
            &json!({ "detected": "zh", "zh-CN": "model text" }).to_string(),
            "stop",
        )]);
        let result = run(&transport, "简体中文原文", &["zh-CN"]).await.unwrap();
        assert_eq!(result.detected.as_deref(), Some("zh-CN"));
        assert_eq!(
            result.translations,
            vec![(
                "zh-CN".to_string(),
                "简体中文原文".to_string(),
                TranslationSource::Passthrough
            )]
        );
    }

    #[tokio::test]
    async fn empty_translation_is_untranslatable() {
        let transport = MockTransport::ok(&[completion(
            &json!({ "detected": "en", "ja": "" }).to_string(),
            "stop",
        )]);
        let result = run(&transport, "!!!", &["ja"]).await.unwrap();
        assert_eq!(
            result.translations,
            vec![(
                "ja".to_string(),
                String::new(),
                TranslationSource::Untranslatable
            )]
        );
    }

    #[tokio::test]
    async fn control_characters_become_spaces_and_runs_collapse() {
        let transport = MockTransport::ok(&[completion(
            &json!({ "ja": "a\nb\r\nc\td" }).to_string(),
            "stop",
        )]);
        let result = run(&transport, "hello", &["ja"]).await.unwrap();
        assert_eq!(result.translations[0].1, "a b c d");
    }

    #[tokio::test]
    async fn overlong_translation_is_truncated_with_an_ellipsis() {
        // Original effective length 2 -> cap = min(4*2+64, 400) = 72.
        let transport = MockTransport::ok(&[completion(
            &json!({ "ja": "x".repeat(300) }).to_string(),
            "stop",
        )]);
        let result = run(&transport, "ab", &["ja"]).await.unwrap();
        let text = &result.translations[0].1;
        assert_eq!(text.chars().count(), 72);
        assert!(text.ends_with('…'));
    }

    #[tokio::test]
    async fn target_tags_are_canonicalized_and_deduped() {
        let transport = MockTransport::ok(&[completion(&json!({ "JA": "x" }).to_string(), "stop")]);
        let result = translate_line_with(
            &transport,
            &cfg(),
            "hello",
            &targets(&["JA", "ja", " "]),
            "en",
            &ctx(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(result.translations.len(), 1);
        assert_eq!(result.translations[0].0, "ja");
        let calls = transport.calls();
        let request_line = calls[0].body["messages"][1]["content"]
            .as_str()
            .unwrap()
            .lines()
            .next()
            .unwrap();
        let request: Value = serde_json::from_str(request_line).unwrap();
        assert_eq!(request["targets"], json!(["ja"]));
    }

    #[tokio::test]
    async fn non_success_status_is_a_user_facing_error() {
        let transport = MockTransport {
            responses: Mutex::new(VecDeque::from(vec![Ok(CompletionResponse {
                status: 500,
                body: "{\"error\":\"boom sk-test\"}".to_string(),
            })])),
            requests: Mutex::new(Vec::new()),
        };
        let error = run(&transport, "hello", &["ja"]).await.unwrap_err();
        let message = error.to_string();
        assert!(message.contains("HTTP 500"), "{message}");
        assert!(!message.contains("sk-test"), "{message}");
        assert!(!message.contains("boom"), "{message}");
        assert_eq!(transport.calls().len(), 1);
    }

    #[tokio::test]
    async fn missing_key_is_a_user_facing_error() {
        let mut config = cfg();
        config.api_key = None;
        let transport = MockTransport::ok(&[]);
        let error = translate_line_with(
            &transport,
            &config,
            "hello",
            &targets(&["ja"]),
            "en",
            &ctx(),
            None,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("no API key"), "{error}");
        assert!(transport.calls().is_empty());
    }

    #[tokio::test]
    async fn unparseable_body_is_an_error_without_a_retry() {
        let transport = MockTransport::ok(&["not json".to_string()]);
        let error = run(&transport, "hello", &["ja"]).await.unwrap_err();
        assert!(error.to_string().contains("unexpected response"), "{error}");
        assert_eq!(transport.calls().len(), 1);
    }

    #[tokio::test]
    async fn malformed_answer_without_truncation_is_an_error() {
        let transport = MockTransport::ok(&[completion("not a json object", "stop")]);
        let error = run(&transport, "hello", &["ja"]).await.unwrap_err();
        assert!(error.to_string().contains("unexpected answer"), "{error}");
        assert_eq!(transport.calls().len(), 1);
    }

    #[test]
    fn config_view_resolves_the_stored_settings() {
        let mut config = ChatTranslateConfig::default();
        config.provider.model = "my-model".into();
        config.provider.api_key = "sk-stored".into();
        config.provider.timeout_ms = 12_000;
        config.provider.temperature = 0.7;
        let view = ConfigView::from_config(&config);
        assert_eq!(view.base_url, config.provider.base_url);
        assert_eq!(view.model, "my-model");
        assert_eq!(view.api_key.as_deref(), Some("sk-stored"));
        assert_eq!(view.timeout_ms, 12_000);
        assert_eq!(view.temperature, 0.7);
        assert_eq!(
            view.completions_url(),
            "https://api.deepseek.com/chat/completions"
        );
    }

    #[test]
    fn length_cap_formula_is_pinned() {
        assert_eq!(translation_char_cap(""), 64);
        assert_eq!(translation_char_cap("ab"), 72);
        assert_eq!(translation_char_cap("a b c d"), 80);
        assert_eq!(translation_char_cap(&"x".repeat(1_000)), 400);
    }

    /// Recursively assert a traced request body carries no credential field or
    /// value: the API key only ever rides the Authorization header.
    fn assert_key_free(value: &Value) {
        match value {
            Value::Object(map) => {
                for (name, child) in map {
                    let lowered = name.to_ascii_lowercase();
                    assert!(!lowered.contains("key"), "trace field name leaks: {name}");
                    assert!(
                        !lowered.contains("secret"),
                        "trace field name leaks: {name}"
                    );
                    assert_key_free(child);
                }
            },
            Value::Array(items) => {
                for child in items {
                    assert_key_free(child);
                }
            },
            Value::String(text) => {
                assert!(!text.contains("sk-"), "trace body leaks key material");
            },
            _ => {},
        }
    }

    #[tokio::test]
    async fn trace_records_the_final_attempt_and_the_parsed_answer() {
        let transport = MockTransport::ok(&[
            completion(r#"{"ja":"x"#, "length"),
            completion(&json!({ "detected": "en", "ja": "ok" }).to_string(), "stop"),
        ]);
        let mut trace = LineTrace::default();
        let result = translate_line_with(
            &transport,
            &cfg(),
            "hello",
            &targets(&["ja"]),
            "en",
            &ctx(),
            Some(&mut trace),
        )
        .await
        .unwrap();
        assert_eq!(result.translations[0].1, "ok");
        assert_eq!(transport.calls().len(), 2);

        // The FINAL attempt is the retry: doubled budget, same stable prompt.
        assert_eq!(trace.request_body["max_tokens"], 1024);
        assert_eq!(trace.system_prompt, SYSTEM_PROMPT);
        assert_eq!(trace.request_body["messages"][0]["content"], SYSTEM_PROMPT);
        assert_eq!(
            trace.request_body["messages"][1]["content"],
            trace.user_payload
        );
        // The user payload starts with the request JSON (text line) then the
        // context blob — both parseable/visible, neither key-bearing.
        let request_line = trace.user_payload.lines().next().unwrap();
        let request: Value = serde_json::from_str(request_line).unwrap();
        assert_eq!(request["text"], "hello");
        assert_eq!(request["targets"], json!(["ja"]));
        assert!(trace.user_payload.contains("context: "));
        assert!(!trace.user_payload.contains("sk-test"));
        assert_key_free(&trace.request_body);

        // The parsed answer + its raw text are both in the trace.
        assert_eq!(
            trace.response,
            Some(json!({ "detected": "en", "ja": "ok" }))
        );
        assert!(
            trace
                .response_raw
                .as_deref()
                .unwrap()
                .contains(r#""ja":"ok""#)
        );
    }

    #[tokio::test]
    async fn trace_keeps_the_last_request_and_raw_answer_on_failure() {
        let transport = MockTransport::ok(&[completion("I cannot help with that.", "stop")]);
        let mut trace = LineTrace::default();
        let error = translate_line_with(
            &transport,
            &cfg(),
            "hello",
            &targets(&["ja"]),
            "en",
            &ctx(),
            Some(&mut trace),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("unexpected answer"), "{error}");
        assert!(trace.response.is_none());
        assert_eq!(
            trace.response_raw.as_deref(),
            Some("I cannot help with that.")
        );
        assert_eq!(trace.system_prompt, SYSTEM_PROMPT);
        assert_eq!(trace.request_body["messages"][0]["content"], SYSTEM_PROMPT);
        assert_key_free(&trace.request_body);
    }
}
