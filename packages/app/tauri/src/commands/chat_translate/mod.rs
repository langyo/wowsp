//! Chat-translation settings, provider connectivity and the try-translation
//! probe (设置 → 聊天翻译).
//!
//! Four concerns, one command surface:
//!
//! - [config] owns `chat-translate.toml` — the settings document, the
//!   sanitize/clamp pass and the public IPC projection. Its module docs spell
//!   out the persistence, healing and SECRET rules (the API key is stored
//!   local-only and never crosses back to the webui);
//! - [client] is the outbound connectivity probe behind
//!   [`test_chat_translate_provider`] (`GET /models` first, one-token
//!   `POST /chat/completions` fallback, shared proxy-aware HTTP client);
//! - the translation engine (language detection, prompt building, the
//!   provider round trip with repair/validation, outgoing composition and
//!   the request cache) lives in the sibling `lang` / `prompt` /
//!   `translate` / `compose` / `cache` modules — pure, unit-tested units
//!   with no UI surface of their own;
//! - [`debug_translate_text`] is the settings card's 试翻译 probe: one line
//!   through the REAL engine pipeline with an empty match context, so the
//!   user can validate endpoint + key + model end to end before a battle.
//!
//! The commands are cross-platform — appdata + the shared HTTP client only,
//! no capture/desktop surface — so the module is registered on every target.
//! The webui keeps the settings section desktop-only on its own. There is no
//! probe (in-game bridge) traffic in this build: the chat file bridge, the
//! overlay panel window and the auto-send path are later waves.

mod cache;
mod client;
mod compose;
mod config;
mod context;
mod flow;
mod lang;
mod live;
pub(crate) mod outgoing;
mod prompt;
pub(crate) mod registry;
mod translate;

use anyhow::anyhow;
use serde::Serialize;
use serde_json::Value;
use std::time::Instant;

use wowsp_tauri_shared::CommandResult;
use wowsp_tauri_shared::{
    ChatTranslateConfigResponse, ChatTranslateConfigUpdate, MatchContext, ProviderTestResult,
};

use translate::TranslationSource;

pub(crate) use live::spawn as spawn_live_chat_source;

/// The chat-translation settings as the webui renders them. Never carries the
/// API key — `ChatTranslateConfigResponse`'s `apiKeySet` / `envKeyOverride`
/// booleans replace it.
#[tauri::command]
pub fn get_chat_translate_config() -> CommandResult<ChatTranslateConfigResponse> {
    Ok(config::response(&config::load()))
}

/// Persist the full settings document (the webui merges the form's dirty
/// fields first) and answer with the SANITIZED result actually stored, so the
/// page never claims a value the backend rejected. `provider.apiKey` is
/// tri-state: absent/null = keep the stored key, `""` = clear, other value =
/// replace.
#[tauri::command]
pub fn set_chat_translate_config(
    app: tauri::AppHandle,
    update: ChatTranslateConfigUpdate,
) -> CommandResult<ChatTranslateConfigResponse> {
    let merged = config::apply_update(config::load(), update);
    let stored = config::save(merged)?;
    // A settings save re-shapes the live chat panel (display.maxLines) — the
    // panel window listens on `wowsp://chat-prefs`. Best-effort; no panel up
    // is the normal case.
    config::emit_prefs(&app, &stored);
    Ok(config::response(&stored))
}

/// Probe the configured provider — the settings card's 测试连接 button.
/// Expected failures (no key, timeout, non-2xx) land in
/// `ProviderTestResult::error` rather than rejecting the command, so the card
/// renders the reason inline.
#[tauri::command]
pub async fn test_chat_translate_provider() -> CommandResult<ProviderTestResult> {
    Ok(client::test_connection(&config::load()).await)
}

/// One target language's line in the try-translation result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugTranslation {
    /// Target language tag, canonicalized by the engine.
    pub lang: String,
    /// Translated text; empty for an untranslatable line.
    pub text: String,
    /// How the line was produced: `model` | `passthrough` | `untranslatable`
    /// (the engine's TranslationSource, flattened for the webui).
    pub source: &'static str,
}

/// [`debug_translate_text`]'s result: the detected source language (when the
/// model reported one), one row per requested target language, the wall-clock
/// round trip, and the FINAL provider attempt's trace for the settings page's
/// translation-test window (system prompt, user message, POST body and the
/// parsed/raw model answer). The trace is key-free by construction — the API
/// key only rides the Authorization header, never the body.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugTranslateResult {
    pub detected: Option<String>,
    pub translations: Vec<DebugTranslation>,
    pub elapsed_ms: u64,
    /// The stable system prompt of the final attempt.
    pub system_prompt: String,
    /// The user message content (request JSON line + context blob).
    pub user_payload: String,
    /// The complete POST body (prompt + knobs, no credential).
    pub request_body: Value,
    /// The model answer parsed into its JSON object (None when not JSON).
    pub response: Option<Value>,
    /// The raw model answer text (fallback when `response` is None).
    pub response_raw: Option<String>,
    /// The pipeline's user-facing failure sentence. Present means the request
    /// reached the provider but the answer was unusable (wrong shape, empty,
    /// HTTP error): the window shows this next to the trace. Guard failures
    /// (disabled / no key / empty input) still REJECT instead — they never
    /// reached a request worth tracing.
    pub error: Option<String>,
}

/// The engine's source verdict as the flattened wire string the webui
/// badges (see DebugTranslation::source).
fn debug_source(source: TranslationSource) -> &'static str {
    match source {
        TranslationSource::Model => "model",
        TranslationSource::Passthrough => "passthrough",
        TranslationSource::Untranslatable => "untranslatable",
    }
}

/// Resolve the try-translation target list: the request's non-blank tags,
/// else the stored `languages.always` list, else English (the card's
/// "always configured" fallback). Pure — unit-tested.
fn debug_targets(requested: &[String], always: &[String]) -> Vec<String> {
    let requested: Vec<String> = requested
        .iter()
        .map(|target| target.trim())
        .filter(|target| !target.is_empty())
        .map(str::to_string)
        .collect();
    if !requested.is_empty() {
        requested
    } else if !always.is_empty() {
        always.to_vec()
    } else {
        vec!["en".to_string()]
    }
}

/// Translation-test probe — the settings section's dedicated test window.
/// Runs one PRESET battle-chat line (or any text the caller supplies) through
/// the REAL engine pipeline (`translate::translate_line_traced`: prompt +
/// provider + repair/validation) with an EMPTY match context, so the user can
/// validate endpoint, key and model end to end, and returns the pipeline trace
/// (system prompt, user payload, raw model answer) alongside the translation.
/// Targets: the request's non-blank list when given, else the stored
/// `languages.always`, else `["en"]`.
///
/// Expected failures reject with a user-facing sentence (the test window
/// renders it inline): the feature must be enabled and a key must be
/// configured.
/// NOTHING here is logged — the typed line and the provider answer must stay
/// off the tracing sink (a feedback bundle would otherwise carry chat text).
#[tauri::command]
pub async fn debug_translate_text(
    text: String,
    targets: Vec<String>,
) -> CommandResult<DebugTranslateResult> {
    let started = Instant::now();
    let config = config::load();
    if !config.enabled {
        return Err(anyhow!(
            "chat translation is disabled — enable it in Settings → Chat translation"
        )
        .into());
    }
    if config::effective_api_key(&config).is_none() {
        return Err(
            anyhow!("no API key configured — save one in Settings → Chat translation").into(),
        );
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("nothing to translate — type a chat line first").into());
    }
    let targets = debug_targets(&targets, &config.languages.always);
    let (trace, line) = translate::translate_line_traced(
        &config,
        trimmed,
        &targets,
        &config.languages.self_lang,
        &MatchContext::default(),
    )
    .await;
    // A pipeline failure keeps the trace: the window pairs the error sentence
    // with what was sent and what the provider answered (that IS the debug
    // value). Only the guard failures above reject.
    let mut result = DebugTranslateResult {
        detected: None,
        translations: Vec::new(),
        elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        system_prompt: trace.system_prompt,
        user_payload: trace.user_payload,
        request_body: trace.request_body,
        response: trace.response,
        response_raw: trace.response_raw,
        error: None,
    };
    match line {
        Ok(line) => {
            result.detected = line.detected;
            result.translations = line
                .translations
                .into_iter()
                .map(|(lang, text, source)| DebugTranslation {
                    lang,
                    text,
                    source: debug_source(source),
                })
                .collect();
        },
        Err(error) => result.error = Some(error.to_string()),
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::prompt;
    use super::*;
    use serde_json::json;

    fn tags(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    /// The try-translation target fallback chain per the contract: request
    /// tags → the stored `languages.always` list → English. Blank request
    /// tags are dropped, never a reason to skip the fallbacks.
    #[test]
    fn debug_targets_follow_the_contract_fallback_chain() {
        // The request wins, trimmed, blanks dropped.
        assert_eq!(
            debug_targets(&tags(&[" ja ", "", "ko"]), &tags(&["en"])),
            tags(&["ja", "ko"])
        );
        // An empty request falls to the configured `always` list.
        assert_eq!(
            debug_targets(&[], &tags(&["zh-TW", "ru"])),
            tags(&["zh-TW", "ru"])
        );
        // Nothing configured at all falls to English.
        assert_eq!(debug_targets(&[], &[]), tags(&["en"]));
        // A whitespace-only request still falls through to `always`.
        assert_eq!(
            debug_targets(&tags(&["   "]), &tags(&["fr"])),
            tags(&["fr"])
        );
    }

    /// The engine's source verdicts flatten to the wire strings the settings
    /// card's source badges key on.
    #[test]
    fn debug_sources_map_to_the_wire_strings() {
        assert_eq!(debug_source(TranslationSource::Model), "model");
        assert_eq!(debug_source(TranslationSource::Passthrough), "passthrough");
        assert_eq!(
            debug_source(TranslationSource::Untranslatable),
            "untranslatable"
        );
    }

    /// Recursively assert a wire value carries no credential-ish field name or
    /// key material — the trace may show prompt text, never a secret (the key
    /// only ever rides the Authorization header).
    fn assert_key_free(value: &Value) {
        match value {
            Value::Object(map) => {
                for (name, child) in map {
                    let lowered = name.to_ascii_lowercase();
                    assert!(!lowered.contains("key"), "wire field name leaks: {name}");
                    assert!(!lowered.contains("secret"), "wire field name leaks: {name}");
                    assert_key_free(child);
                }
            },
            Value::Array(items) => {
                for child in items {
                    assert_key_free(child);
                }
            },
            Value::String(text) => {
                assert!(!text.contains("sk-"), "wire payload leaks key material");
            },
            _ => {},
        }
    }

    /// The command result round-trips as the camelCase wire shape the webui
    /// mirrors — including the translation-test trace fields — and never grows
    /// a field that could carry the key.
    #[test]
    fn debug_result_serializes_the_camel_case_wire_shape() {
        let request_line = json!({ "text": "hello" }).to_string();
        let user_payload = format!("{request_line}\ncontext: {{}}");
        let request_body = json!({
            "model": "deepseek-flash",
            "messages": [
                { "role": "system", "content": prompt::SYSTEM_PROMPT },
                { "role": "user", "content": user_payload },
            ],
            "temperature": 0.0,
            "max_tokens": 512,
            "response_format": { "type": "json_object" },
            "stream": false,
        });
        let response = json!({ "detected": "ja", "zh-CN": "请保护我" });
        let result = DebugTranslateResult {
            detected: Some("ja".to_string()),
            translations: vec![DebugTranslation {
                lang: "zh-CN".to_string(),
                text: "请保护我".to_string(),
                source: "model",
            }],
            elapsed_ms: 812,
            system_prompt: prompt::SYSTEM_PROMPT.to_string(),
            user_payload: user_payload.clone(),
            request_body: request_body.clone(),
            response: Some(response.clone()),
            response_raw: Some(response.to_string()),
            error: None,
        };
        let value = serde_json::to_value(&result).expect("debug result serializes");
        assert_eq!(value["detected"], "ja");
        assert_eq!(value["elapsedMs"], 812);
        assert_eq!(value["translations"][0]["lang"], "zh-CN");
        assert_eq!(value["translations"][0]["text"], "请保护我");
        assert_eq!(value["translations"][0]["source"], "model");

        // The trace fields the translation-test window renders.
        assert_eq!(value["systemPrompt"], prompt::SYSTEM_PROMPT);
        assert_eq!(value["userPayload"], user_payload);
        assert_eq!(value["requestBody"], request_body);
        assert_eq!(value["response"]["detected"], "ja");
        assert_eq!(value["responseRaw"], response.to_string());
        // The request body itself is key-free, and so is the whole wire shape.
        assert!(!value["requestBody"].to_string().contains("sk-"));
        assert_key_free(&value);

        // An absent answer stays a null field (the wire type is Option).
        let empty = DebugTranslateResult {
            detected: None,
            translations: Vec::new(),
            elapsed_ms: 0,
            system_prompt: String::new(),
            user_payload: String::new(),
            request_body: Value::Null,
            response: None,
            response_raw: None,
            error: None,
        };
        let value = serde_json::to_value(&empty).expect("empty result serializes");
        assert!(value["response"].is_null());
        assert!(value["responseRaw"].is_null());
        assert!(value["error"].is_null());

        // A pipeline failure travels as an Ok result WITH the trace and the
        // error sentence: the window pairs them instead of losing the request.
        let failed = DebugTranslateResult {
            detected: None,
            translations: Vec::new(),
            elapsed_ms: 900,
            system_prompt: prompt::SYSTEM_PROMPT.to_string(),
            user_payload: "{\"text\":\"wp\"}\ncontext: {}".to_string(),
            request_body: json!({ "model": "deepseek-flash", "messages": [] }),
            response: None,
            response_raw: Some("not json, just text".to_string()),
            error: Some("translation service returned an unexpected answer".to_string()),
        };
        let value = serde_json::to_value(&failed).expect("failed trace serializes");
        assert_eq!(
            value["error"],
            "translation service returned an unexpected answer"
        );
        assert_eq!(value["responseRaw"], "not json, just text");
        assert_eq!(value["systemPrompt"], prompt::SYSTEM_PROMPT);
        assert_key_free(&value);
    }

    /// The user payload's first line stays a parseable request JSON (the
    /// translation-test window renders it as a JSON tree) and carries the
    /// typed line; the second line is the context blob.
    #[test]
    fn debug_result_payload_line_parses_and_keeps_the_text() {
        let request_line =
            json!({ "text": "rush B", "targets": ["ja"], "selfLang": "en" }).to_string();
        let user_payload = format!("{request_line}\ncontext: {{}}");
        let result = DebugTranslateResult {
            detected: Some("en".to_string()),
            translations: Vec::new(),
            elapsed_ms: 5,
            system_prompt: prompt::SYSTEM_PROMPT.to_string(),
            user_payload: user_payload.clone(),
            request_body: json!({ "model": "deepseek-flash" }),
            response: None,
            response_raw: None,
            error: None,
        };
        let value = serde_json::to_value(&result).unwrap();
        let payload = value["userPayload"].as_str().unwrap();
        let mut lines = payload.lines();
        let request: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(request["text"], "rush B");
        assert_eq!(request["targets"], json!(["ja"]));
        assert!(lines.next().unwrap().starts_with("context: "));
        assert_key_free(&value);
    }
}
