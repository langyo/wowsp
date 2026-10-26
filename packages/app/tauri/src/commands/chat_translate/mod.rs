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
mod lang;
mod prompt;
mod translate;

use anyhow::anyhow;
use serde::Serialize;
use std::time::Instant;

use wowsp_tauri_shared::CommandResult;
use wowsp_tauri_shared::{
    ChatTranslateConfigResponse, ChatTranslateConfigUpdate, MatchContext, ProviderTestResult,
};

use translate::{LineTranslation, TranslationSource};

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
    update: ChatTranslateConfigUpdate,
) -> CommandResult<ChatTranslateConfigResponse> {
    let merged = config::apply_update(config::load(), update);
    let stored = config::save(merged)?;
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
/// model reported one), one row per requested target language, and the
/// wall-clock round trip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugTranslateResult {
    pub detected: Option<String>,
    pub translations: Vec<DebugTranslation>,
    pub elapsed_ms: u64,
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

/// Try-translation probe — the settings card's 试翻译 row. Runs one typed
/// line through the REAL engine pipeline (`translate::translate_line_configured`:
/// prompt + provider + repair/validation) with an EMPTY match context, so the
/// user can validate endpoint, key and model end to end from the settings
/// page. Targets: the request's non-blank list when given, else the stored
/// `languages.always`, else `["en"]`.
///
/// Expected failures reject with a user-facing sentence (the section renders
/// it inline): the feature must be enabled and a key must be configured.
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
    let line: LineTranslation = translate::translate_line_configured(
        &config,
        trimmed,
        &targets,
        &config.languages.self_lang,
        &MatchContext::default(),
    )
    .await?;
    Ok(DebugTranslateResult {
        detected: line.detected,
        translations: line
            .translations
            .into_iter()
            .map(|(lang, text, source)| DebugTranslation {
                lang,
                text,
                source: debug_source(source),
            })
            .collect(),
        elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// The command result round-trips as the camelCase wire shape the webui
    /// mirrors (and never grows a field that could carry the key).
    #[test]
    fn debug_result_serializes_the_camel_case_wire_shape() {
        let result = DebugTranslateResult {
            detected: Some("ja".to_string()),
            translations: vec![DebugTranslation {
                lang: "zh-CN".to_string(),
                text: "请保护我".to_string(),
                source: "model",
            }],
            elapsed_ms: 812,
        };
        let value = serde_json::to_value(&result).expect("debug result serializes");
        assert_eq!(value["detected"], "ja");
        assert_eq!(value["elapsedMs"], 812);
        assert_eq!(value["translations"][0]["lang"], "zh-CN");
        assert_eq!(value["translations"][0]["text"], "请保护我");
        assert_eq!(value["translations"][0]["source"], "model");
        let object = value.as_object().expect("object");
        assert!(
            !object
                .keys()
                .any(|key| key.to_ascii_lowercase().contains("key")),
            "the wire shape must never carry a key field"
        );
    }
}
