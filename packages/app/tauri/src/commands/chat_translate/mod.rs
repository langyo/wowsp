//! Chat-translation settings + provider connectivity (设置 → 聊天翻译).
//!
//! Two halves, one command surface:
//!
//! - [config] owns `chat-translate.toml` — the settings document, the
//!   sanitize/clamp pass and the public IPC projection. Its module docs spell
//!   out the persistence, healing and SECRET rules (the API key is stored
//!   local-only and never crosses back to the webui);
//! - [client] is the outbound connectivity probe behind
//!   [`test_chat_translate_provider`] (`GET /models` first, one-token
//!   `POST /chat/completions` fallback, shared proxy-aware HTTP client).
//!
//! The commands are cross-platform — appdata + the shared HTTP client only,
//! no capture/desktop surface — so the module is registered on every target.
//! The webui keeps the settings section desktop-only on its own. There is no
//! probe (in-game bridge) traffic in this build: the chat file bridge, the
//! overlay panel window and the auto-send path are later waves.

mod client;
mod config;

use wowsp_tauri_shared::CommandResult;
use wowsp_tauri_shared::{
    ChatTranslateConfigResponse, ChatTranslateConfigUpdate, ProviderTestResult,
};

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
