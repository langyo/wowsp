//! Chat-translation wire DTOs — the settings document, its sanitized public
//! IPC projection, the update payload and the provider connectivity probe
//! result.
//!
//! The settings struct doubles as the on-disk shape (`chat-translate.toml`
//! under the appdata root; see `commands/chat_translate/config.rs` in the app
//! crate): one `ChatTranslateConfig` serializes to the same camelCase keys the
//! webui reads and writes, so there is exactly one spelling to keep in sync.
//! The nested provider/languages/detect/context/display/send tables mirror the
//! TOML sections verbatim; the one exception is `languages.selfLang`, the
//! camelCase form of the Rust field `self_lang` (the bare `self` the contract
//! originally proposed is a Rust keyword — the rename_all rule supplies the
//! final wire key instead of a field-level override).
//!
//! The API key never crosses back over the IPC boundary: the public response
//! ([ChatTranslateConfigPublic]) always carries an EMPTY `apiKey`, and
//! [ChatTranslateConfigResponse] adds `apiKeySet` / `envKeyOverride` booleans
//! instead. The config file stores the key in plaintext, local only
//! (AGENTS.md §7 — no real key is ever committed); the app crate's
//! `WOWSP_CHAT_TRANSLATE_API_KEY` environment override is read-side only and
//! is never written back.
//!
//! Every struct here is tolerant on read (serde defaults), because the same
//! document is also hand-editable on disk: the app crate's `sanitize` pass
//! owns the per-field fallbacks and clamps, so an out-of-range value heals
//! instead of failing the whole config parse.

use serde::{Deserialize, Serialize};

/// Known language tags (v1) — the translation targets the settings UI
/// offers, and the only tags a stored `languages.selfLang` / `always` /
/// `exclude` entry may carry. Anything outside this list heals to its
/// default (empty `self`, dropped list entry) on read. The list is
/// deliberately narrower than the game's full client-language set: v1 only
/// guarantees glyph/UI coverage for these.
pub const SUPPORTED_LANGS: &[&str] = &[
    "zh-CN", "zh-TW", "ja", "ko", "ru", "en", "de", "fr", "es", "it", "pl", "cs", "tr", "pt", "uk",
    "th", "vi",
];

/// Default provider base URL — DeepSeek's OpenAI-compatible endpoint. Users
/// may point this at any compatible service (a self-hosted gateway included);
/// the stored URL always keeps its http(s) scheme.
pub const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";

/// Default model id — DeepSeek's current OpenAI-compatible chat model.
pub const DEFAULT_MODEL: &str = "deepseek-chat";

/// Default translation request timeout, milliseconds. Clamped to
/// 3 000..=60 000 on load/save.
pub const DEFAULT_TIMEOUT_MS: i64 = 10_000;

/// One provider (OpenAI-compatible HTTP API) configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatTranslateProviderConfig {
    /// Base URL with its scheme, no trailing slash. Empty/invalid heals to
    /// [DEFAULT_BASE_URL].
    pub base_url: String,
    /// Model id sent in the request body. Empty heals to [DEFAULT_MODEL].
    pub model: String,
    /// LOCAL CREDENTIAL — plaintext in the config file, never logged and
    /// never returned to the webui (see [ChatTranslateConfigPublic]). The
    /// environment override is applied on the read side only.
    pub api_key: String,
    /// Per-request timeout, milliseconds; clamped 3 000..=60 000.
    pub timeout_ms: i64,
    /// Sampling temperature for translation calls; clamped 0.0..=2.0.
    pub temperature: f64,
}

impl Default for ChatTranslateProviderConfig {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_string(),
            model: DEFAULT_MODEL.to_string(),
            api_key: String::new(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
            temperature: 0.0,
        }
    }
}

/// Target-language selection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatTranslateLanguagesConfig {
    /// The line's own language — empty means "follow the UI locale"; a tag
    /// outside [SUPPORTED_LANGS] heals to empty. Wire key `selfLang` (the
    /// camelCase form of `self_lang`; a bare `self` would be a Rust keyword).
    pub self_lang: String,
    /// `auto` (translate into every other language present in the battle,
    /// capped by `max_targets`) or `fixed` (exactly `always`). Anything else
    /// heals to `auto`.
    pub mode: String,
    /// Extra target tags regardless of the battle's own languages.
    pub always: Vec<String>,
    /// Target tags never translated into.
    pub exclude: Vec<String>,
    /// Cap on the number of target languages resolved from the battle;
    /// clamped 1..=6.
    pub max_targets: i64,
}

impl Default for ChatTranslateLanguagesConfig {
    fn default() -> Self {
        Self {
            self_lang: String::new(),
            mode: "auto".to_string(),
            always: Vec::new(),
            exclude: Vec::new(),
            max_targets: 4,
        }
    }
}

/// Foreign-language detection knobs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatTranslateDetectConfig {
    /// Shortest chat line worth classifying/translating, characters;
    /// clamped 1..=20.
    pub min_chars: i64,
}

impl Default for ChatTranslateDetectConfig {
    fn default() -> Self {
        Self { min_chars: 2 }
    }
}

/// Battle-context knobs for the translation prompt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatTranslateContextConfig {
    /// Include the match's ship names.
    pub ship_names: bool,
    /// Include both teams' basic situation.
    pub teams: bool,
    /// Recent chat lines included as conversational context;
    /// clamped 0..=30.
    pub recent_lines: i64,
    /// Include player nicknames in the context.
    pub nicknames: bool,
}

impl Default for ChatTranslateContextConfig {
    fn default() -> Self {
        Self {
            ship_names: true,
            teams: true,
            recent_lines: 8,
            nicknames: false,
        }
    }
}

/// Overlay panel display knobs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatTranslateDisplayConfig {
    /// Data-side cap on panel lines; clamped 3..=30. (The overlay panel's
    /// own `chatPanelMaxLines` lives in `overlay-config.toml` — the smaller
    /// of the two applies at render time.)
    pub max_lines: i64,
}

impl Default for ChatTranslateDisplayConfig {
    fn default() -> Self {
        Self { max_lines: 8 }
    }
}

/// Outgoing translated-message knobs (executed by the in-game bridge, not
/// this app build yet — the config exists so a later probe release and the
/// settings UI share one shape).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatTranslateSendConfig {
    /// `clipboard` (hand the translated lines to the user) or `off`.
    /// Anything else heals to `off`.
    pub mode: String,
    /// Append the translated `[同声传译]` suffix.
    pub suffix_enabled: bool,
    /// `per-segment` (each language bundle carries its own suffix) or
    /// `unified` (one suffix at the end). Anything else heals to
    /// `per-segment`.
    pub suffix_format: String,
    /// Character threshold for splitting one translated message;
    /// clamped 40..=138 (the in-game chat limit is 140 with margin).
    pub split_chars: i64,
    /// Delay between two outgoing messages, milliseconds; clamped
    /// 200..=5 000.
    pub pace_ms: i64,
    /// Maximum outgoing messages per send; clamped 1..=5.
    pub max_per_send: i64,
    /// Maximum auto-sent messages per battle; clamped 1..=100.
    pub per_battle_cap: i64,
    /// Cooldown between two auto-sends, seconds; clamped 0..=300.
    pub cooldown_s: i64,
    /// How long the send hint stays on screen, seconds; clamped 5..=600.
    pub hint_timeout_s: i64,
}

impl Default for ChatTranslateSendConfig {
    fn default() -> Self {
        Self {
            mode: "clipboard".to_string(),
            suffix_enabled: true,
            suffix_format: "per-segment".to_string(),
            split_chars: 120,
            pace_ms: 500,
            max_per_send: 3,
            per_battle_cap: 20,
            cooldown_s: 10,
            hint_timeout_s: 60,
        }
    }
}

/// The whole chat-translation settings document: the `chat-translate.toml`
/// shape AND the webui's config shape (minus the key, see
/// [ChatTranslateConfigPublic]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatTranslateConfig {
    /// Master switch. Off by default: chat text leaves the machine for a
    /// third-party API only after the user explicitly enables it.
    pub enabled: bool,
    /// Consent notice version the user accepted (0 = never consented; the
    /// settings UI enables only after bumping this to the current version).
    pub consent_version: i64,
    pub provider: ChatTranslateProviderConfig,
    pub languages: ChatTranslateLanguagesConfig,
    pub detect: ChatTranslateDetectConfig,
    pub context: ChatTranslateContextConfig,
    pub display: ChatTranslateDisplayConfig,
    pub send: ChatTranslateSendConfig,
}

/// The config as the webui receives it: the same shape with the API key
/// replaced by an empty string. The real key state is carried by
/// [ChatTranslateConfigResponse] instead.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatTranslateConfigPublic {
    pub enabled: bool,
    pub consent_version: i64,
    pub provider: ChatTranslateProviderConfig,
    pub languages: ChatTranslateLanguagesConfig,
    pub detect: ChatTranslateDetectConfig,
    pub context: ChatTranslateContextConfig,
    pub display: ChatTranslateDisplayConfig,
    pub send: ChatTranslateSendConfig,
}

impl Default for ChatTranslateConfigPublic {
    fn default() -> Self {
        Self::from(&ChatTranslateConfig::default())
    }
}

impl From<&ChatTranslateConfig> for ChatTranslateConfigPublic {
    /// Public projection: clone the document, then blank the key. Kept as
    /// the ONE place the key is stripped, so no command can accidentally
    /// serialize it to the webview.
    fn from(config: &ChatTranslateConfig) -> Self {
        let mut provider = config.provider.clone();
        provider.api_key.clear();
        Self {
            enabled: config.enabled,
            consent_version: config.consent_version,
            provider,
            languages: config.languages.clone(),
            detect: config.detect.clone(),
            context: config.context.clone(),
            display: config.display.clone(),
            send: config.send.clone(),
        }
    }
}

/// One settings save request. Same shape as the public config, except the
/// provider key is a tri-state transport: `None` = keep the stored key,
/// `Some("")` = clear it, `Some(value)` = replace it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTranslateConfigUpdate {
    pub enabled: bool,
    pub consent_version: i64,
    pub provider: ChatTranslateProviderUpdate,
    pub languages: ChatTranslateLanguagesConfig,
    pub detect: ChatTranslateDetectConfig,
    pub context: ChatTranslateContextConfig,
    pub display: ChatTranslateDisplayConfig,
    pub send: ChatTranslateSendConfig,
}

/// Provider half of a save request — see [ChatTranslateConfigUpdate] for the
/// `api_key` transport semantics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTranslateProviderUpdate {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
    pub timeout_ms: i64,
    pub temperature: f64,
}

/// The stored config as the webui sees it: the key-blanked document plus the
/// two booleans the UI badges ("key configured" / "environment override in
/// effect"). The key itself never appears here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTranslateConfigResponse {
    pub config: ChatTranslateConfigPublic,
    /// A usable key exists (stored file OR environment override).
    pub api_key_set: bool,
    /// The environment override is present and takes precedence over the
    /// stored key (read-side only; nothing is written back).
    pub env_key_override: bool,
}

/// Result of the settings page's "test connection" button. Expected failures
/// (no key, timeout, non-2xx answer) land in `error` with `ok = false`
/// instead of rejecting the command, so the card can render the reason
/// inline — the same shape the player-marker store's report lines use.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestResult {
    pub ok: bool,
    /// Wall-clock latency of the probe request, milliseconds.
    pub latency_ms: i64,
    /// The provider's reported model id (from `GET /models`), or the
    /// configured model when the chat-completions fallback answered.
    #[serde(default)]
    pub model_echo: Option<String>,
    /// User-facing failure reason (never contains the API key).
    #[serde(default)]
    pub error: Option<String>,
}
