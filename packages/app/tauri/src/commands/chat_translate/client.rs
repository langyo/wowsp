//! Provider connectivity probe behind the settings page's 测试连接 button
//! (`test_chat_translate_provider`).
//!
//! The probe is deliberately provider-agnostic (any OpenAI-compatible HTTP
//! endpoint, DeepSeek by default):
//!
//!   1. `GET {baseUrl}/models` with the stored/env API key — the cheapest
//!      real handshake. A 200 echoes `data[0].id` as the model the provider
//!      actually serves;
//!   2. an endpoint that only serves chat completions answers 404/405 there,
//!      so the probe falls back to a one-token `POST
//!      {baseUrl}/chat/completions` with the configured model.
//!
//! Every request rides `network::build_http_client()`, so the Settings →
//! Network proxy choice applies. Expected failures (no key, timeout, non-2xx)
//! are REPORTED in [ProviderTestResult] instead of rejecting the command, so
//! the settings card renders the reason inline (the same report-shape
//! pattern the player-marker and network settings use). The API key never
//! appears in a message, and no request
//! header or body is ever logged.

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use wowsp_tauri_shared::{ChatTranslateConfig, ProviderTestResult};

use crate::commands::network::build_http_client;

use super::config::effective_api_key;

/// Cap on the `GET /models` leg: the list is a tiny response and a hanging
/// probe must hand control back to the settings card quickly. The fallback
/// chat leg keeps the configured timeout instead — a cold model may
/// legitimately take a few seconds to produce its first token.
const MODELS_TIMEOUT_CAP: Duration = Duration::from_millis(8_000);

/// `{base}` joined with one API path, tolerant of a stored trailing slash
/// (the sanitizer trims one, but the probe never trusts that on its own).
fn endpoint_url(base_url: &str, path: &str) -> String {
    format!("{}{}", base_url.trim_end_matches('/'), path)
}

/// The provider's reported model id off a models document — `None` when the
/// payload shape is off (the connection is still fine; only the echo is
/// unavailable).
fn models_model_echo(value: &Value) -> Option<String> {
    value
        .get("data")
        .and_then(Value::as_array)
        .and_then(|entries| entries.first())
        .and_then(|entry| entry.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// User-facing copy for a non-2xx answer. The status code is always included
/// and the key never is.
fn status_error(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        code @ (401 | 403) => format!("the provider rejected the API key (HTTP {code})"),
        404 => "the provider endpoint was not found (HTTP 404)".to_string(),
        code => format!("the provider returned HTTP {code}"),
    }
}

/// User-facing copy for a transport failure (`reqwest`'s own Display is only
/// a fallback — it may carry the URL, but never the Authorization header).
fn request_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "the provider did not answer in time (timeout)".to_string()
    } else if error.is_connect() {
        "could not reach the provider — check the base URL and network settings".to_string()
    } else {
        format!("provider request failed: {error}")
    }
}

/// A failed probe result with no model echo.
fn failed(message: impl Into<String>) -> ProviderTestResult {
    ProviderTestResult {
        ok: false,
        latency_ms: 0,
        model_echo: None,
        error: Some(message.into()),
    }
}

/// Stamp the elapsed wall-clock latency into a result (all exit paths go
/// through here, so the card always shows how long the probe took).
fn with_latency(mut result: ProviderTestResult, started: Instant) -> ProviderTestResult {
    result.latency_ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
    result
}

/// Configured request timeout as a Duration (sanitized configs are
/// 3 000..=60 000 ms; the fallback keeps a hostile hand-edited value from
/// panicking the conversion).
fn configured_timeout(config: &ChatTranslateConfig) -> Duration {
    Duration::from_millis(u64::try_from(config.provider.timeout_ms).unwrap_or(10_000))
}

/// The one-token chat-completions fallback for providers without a
/// `GET /models` route.
async fn chat_completions_probe(
    client: &reqwest::Client,
    config: &ChatTranslateConfig,
    api_key: &str,
) -> ProviderTestResult {
    let url = endpoint_url(&config.provider.base_url, "/chat/completions");
    let body = json!({
        "model": config.provider.model,
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 1,
        "stream": false,
    });
    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .timeout(configured_timeout(config))
        .json(&body)
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => ProviderTestResult {
            ok: true,
            latency_ms: 0,
            model_echo: Some(config.provider.model.clone()),
            error: None,
        },
        Ok(response) => failed(status_error(response.status())),
        Err(error) => failed(request_error(&error)),
    }
}

/// Run the connectivity probe. Never panics and never puts the key, the
/// Authorization header or a request body into the result.
pub(crate) async fn test_connection(config: &ChatTranslateConfig) -> ProviderTestResult {
    let started = Instant::now();
    let Some(api_key) = effective_api_key(config) else {
        return with_latency(
            failed("no API key configured — save one in Settings → Chat translation"),
            started,
        );
    };
    let client = match build_http_client() {
        Ok(client) => client,
        Err(error) => {
            return with_latency(
                failed(format!("could not build the HTTP client: {error}")),
                started,
            );
        },
    };
    let models_url = endpoint_url(&config.provider.base_url, "/models");
    let response = client
        .get(&models_url)
        .header("Authorization", format!("Bearer {api_key}"))
        .timeout(MODELS_TIMEOUT_CAP.min(configured_timeout(config)))
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => {
            // A 200 with an unexpected body still proves reachability; the
            // echo merely stays empty (the card shows the plain ✓).
            let model_echo = response
                .json::<Value>()
                .await
                .ok()
                .as_ref()
                .and_then(models_model_echo);
            with_latency(
                ProviderTestResult {
                    ok: true,
                    latency_ms: 0,
                    model_echo,
                    error: None,
                },
                started,
            )
        },
        Ok(response) if matches!(response.status().as_u16(), 404 | 405) => with_latency(
            chat_completions_probe(&client, config, &api_key).await,
            started,
        ),
        Ok(response) => with_latency(failed(status_error(response.status())), started),
        Err(error) => with_latency(failed(request_error(&error)), started),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_url_joins_with_a_single_slash() {
        assert_eq!(
            endpoint_url("https://api.deepseek.com", "/models"),
            "https://api.deepseek.com/models"
        );
        assert_eq!(
            endpoint_url("https://api.deepseek.com/", "/models"),
            "https://api.deepseek.com/models"
        );
        assert_eq!(
            endpoint_url("http://127.0.0.1:8787/v1", "/chat/completions"),
            "http://127.0.0.1:8787/v1/chat/completions"
        );
    }

    #[test]
    fn models_echo_reads_the_first_data_id() {
        let payload = json!({
            "object": "list",
            "data": [{ "id": "deepseek-chat" }, { "id": "deepseek-reasoner" }],
        });
        assert_eq!(
            models_model_echo(&payload).as_deref(),
            Some("deepseek-chat")
        );
        assert_eq!(models_model_echo(&json!({ "data": [] })), None);
        assert_eq!(models_model_echo(&json!({ "data": "nope" })), None);
        assert_eq!(models_model_echo(&json!({ "data": [{ "id": 42 }] })), None);
        assert_eq!(models_model_echo(&json!({})), None);
    }

    #[test]
    fn status_copy_is_user_facing_and_key_free() {
        for code in [401u16, 403, 404, 429, 500] {
            let status = reqwest::StatusCode::from_u16(code).unwrap();
            let message = status_error(status);
            assert!(
                message.contains(&code.to_string()),
                "status code must appear: {message}"
            );
            assert!(!message.contains("Bearer"), "no header copy: {message}");
            assert!(!message.contains("sk-"), "no key copy: {message}");
        }
        assert!(status_error(reqwest::StatusCode::UNAUTHORIZED).contains("API key"));
    }
}
