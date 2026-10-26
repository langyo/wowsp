//! `chat-translate.toml` — persistence, sanitization and the public IPC
//! projection of the chat-translation settings (settings → Chat translation).
//!
//! Settings-store conventions apply (see `crate::settings_store`): a TOML file
//! under the appdata root, a tolerant parse with per-field defaults and
//! clamps, and a heal write whenever the sanitized canonical text differs
//! from what is on disk. The file is NEW in this build — no pre-TOML JSON twin
//! ever wrote it — but the shared helper still takes a legacy name: a file by
//! that name would be parsed as JSON once and migrated, which is harmless.
//!
//! SECRETS (AGENTS.md §7): `provider.apiKey` is stored in plaintext, local
//! only. It never crosses the IPC boundary — [response] returns
//! [ChatTranslateConfigPublic] (key blanked) plus the two booleans the settings
//! UI badges. The `WOWSP_CHAT_TRANSLATE_API_KEY` environment variable
//! overrides the stored key on the READ side only; [load_from]/[save_to] never
//! copy it into the file.

use anyhow::{Result, anyhow};

use serde::Serialize;
use std::path::Path;

use tauri::Emitter;

use wowsp_tauri_shared::{
    ChatTranslateConfig, ChatTranslateConfigPublic, ChatTranslateConfigResponse,
    ChatTranslateConfigUpdate, DEFAULT_BASE_URL, DEFAULT_MODEL, SUPPORTED_LANGS,
};

use crate::commands::overlay::CHAT_PREFS_EVENT;
use crate::paths;
use crate::settings_store::{self, SettingsSource};

/// Canonical settings file under the appdata root.
pub(crate) const CONFIG_FILE: &str = "chat-translate.toml";
/// No pre-TOML build ever wrote this; kept so the shared migration helper has
/// its second file name (a hand-placed file by this name is migrated once).
const LEGACY_CONFIG_FILE: &str = "chat-translate.json";

/// Environment override for the provider key — read-side precedence over the
/// stored value, never written back (dev/CI convenience and a way to keep a
/// portable install key-free on disk).
pub(crate) const API_KEY_ENV: &str = "WOWSP_CHAT_TRANSLATE_API_KEY";

/// Header prepended to the canonical file. Part of the canonical text, so a
/// hand-removed header comes back on the next corrective write.
const FILE_HEADER: &str = "# WoWSP chat translation settings.\n";

/// How many languages the `auto` mode may resolve from one battle.
const MAX_TARGETS_RANGE: (i64, i64) = (1, 6);
/// Per-request timeout band, milliseconds.
const TIMEOUT_MS_RANGE: (i64, i64) = (3_000, 60_000);
/// Sampling temperature band.
const TEMPERATURE_RANGE: (f64, f64) = (0.0, 2.0);
/// Shortest line worth translating, characters.
const MIN_CHARS_RANGE: (i64, i64) = (1, 20);
/// Recent-context lines band.
const RECENT_LINES_RANGE: (i64, i64) = (0, 30);
/// Data-side panel lines band.
const MAX_LINES_RANGE: (i64, i64) = (3, 30);
/// Split threshold band, characters (the in-game chat limit is 140 with
/// margin).
const SPLIT_CHARS_RANGE: (i64, i64) = (40, 138);
/// Inter-message pacing band, milliseconds.
const PACE_MS_RANGE: (i64, i64) = (200, 5_000);
/// Outgoing messages per send band.
const MAX_PER_SEND_RANGE: (i64, i64) = (1, 5);
/// Auto-sent messages per battle band.
const PER_BATTLE_CAP_RANGE: (i64, i64) = (1, 100);
/// Auto-send cooldown band, seconds.
const COOLDOWN_S_RANGE: (i64, i64) = (0, 300);
/// Send-hint lifetime band, seconds.
const HINT_TIMEOUT_S_RANGE: (i64, i64) = (5, 600);

/// A usable base URL: http(s) scheme, a non-empty host part and no
/// whitespace. Trailing slashes are trimmed by [sanitize_base_url] before
/// this check, so only genuinely broken values fail.
fn usable_base_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let host = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"));
    host.is_some_and(|rest| !rest.is_empty()) && !value.chars().any(char::is_whitespace)
}

/// Resolve a stored URL onto the default when it could never produce a
/// working request (mirrors `commands/network`'s shallow scheme check; full
/// URL validation belongs to the HTTP stack).
fn sanitize_base_url(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if usable_base_url(trimmed) {
        trimmed.to_string()
    } else {
        DEFAULT_BASE_URL.to_string()
    }
}

/// Case-insensitive match against one of `allowed`, falling back when it is
/// not a listed choice (unknown enums heal instead of failing the parse).
fn normalize_choice(raw: &str, allowed: &[&str], fallback: &str) -> String {
    let trimmed = raw.trim();
    allowed
        .iter()
        .find(|choice| choice.eq_ignore_ascii_case(trimmed))
        .map_or_else(|| fallback.to_string(), |choice| (*choice).to_string())
}

/// Canonical spelling of a known language tag, or `None` when the value is
/// empty / outside [SUPPORTED_LANGS].
fn canonical_lang(raw: &str) -> Option<&'static str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    SUPPORTED_LANGS
        .iter()
        .copied()
        .find(|tag| tag.eq_ignore_ascii_case(trimmed))
}

/// Dedupe + canonicalize a stored tag list, dropping entries outside
/// [SUPPORTED_LANGS] (order preserved).
fn sanitize_lang_list(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(list.len());
    for raw in list {
        if let Some(tag) = canonical_lang(raw) {
            let tag = tag.to_string();
            if !out.contains(&tag) {
                out.push(tag);
            }
        }
    }
    out
}

/// Clamp every out-of-range / unknown field onto its contract default. Runs
/// on EVERY load and before EVERY save, so neither a hand-edited file nor a
/// newer webui can persist a value the app cannot use.
pub(crate) fn sanitize(mut config: ChatTranslateConfig) -> ChatTranslateConfig {
    config.consent_version = config.consent_version.max(0);
    config.provider.base_url = sanitize_base_url(&config.provider.base_url);
    config.provider.model = if config.provider.model.trim().is_empty() {
        DEFAULT_MODEL.to_string()
    } else {
        config.provider.model.trim().to_string()
    };
    // The key is opaque: only trim surrounding whitespace (an all-whitespace
    // value means "no key").
    config.provider.api_key = config.provider.api_key.trim().to_string();
    config.provider.timeout_ms = config
        .provider
        .timeout_ms
        .clamp(TIMEOUT_MS_RANGE.0, TIMEOUT_MS_RANGE.1);
    config.provider.temperature = if config.provider.temperature.is_finite() {
        config
            .provider
            .temperature
            .clamp(TEMPERATURE_RANGE.0, TEMPERATURE_RANGE.1)
    } else {
        0.0
    };
    config.languages.self_lang = canonical_lang(&config.languages.self_lang)
        .unwrap_or_default()
        .to_string();
    config.languages.mode = normalize_choice(&config.languages.mode, &["auto", "fixed"], "auto");
    config.languages.always = sanitize_lang_list(&config.languages.always);
    config.languages.exclude = sanitize_lang_list(&config.languages.exclude);
    config.languages.max_targets = config
        .languages
        .max_targets
        .clamp(MAX_TARGETS_RANGE.0, MAX_TARGETS_RANGE.1);
    config.detect.min_chars = config
        .detect
        .min_chars
        .clamp(MIN_CHARS_RANGE.0, MIN_CHARS_RANGE.1);
    config.context.recent_lines = config
        .context
        .recent_lines
        .clamp(RECENT_LINES_RANGE.0, RECENT_LINES_RANGE.1);
    config.display.max_lines = config
        .display
        .max_lines
        .clamp(MAX_LINES_RANGE.0, MAX_LINES_RANGE.1);
    config.send.mode = normalize_choice(&config.send.mode, &["clipboard", "off"], "off");
    config.send.suffix_format = normalize_choice(
        &config.send.suffix_format,
        &["per-segment", "unified"],
        "per-segment",
    );
    config.send.split_chars = config
        .send
        .split_chars
        .clamp(SPLIT_CHARS_RANGE.0, SPLIT_CHARS_RANGE.1);
    config.send.pace_ms = config.send.pace_ms.clamp(PACE_MS_RANGE.0, PACE_MS_RANGE.1);
    config.send.max_per_send = config
        .send
        .max_per_send
        .clamp(MAX_PER_SEND_RANGE.0, MAX_PER_SEND_RANGE.1);
    config.send.per_battle_cap = config
        .send
        .per_battle_cap
        .clamp(PER_BATTLE_CAP_RANGE.0, PER_BATTLE_CAP_RANGE.1);
    config.send.cooldown_s = config
        .send
        .cooldown_s
        .clamp(COOLDOWN_S_RANGE.0, COOLDOWN_S_RANGE.1);
    config.send.hint_timeout_s = config
        .send
        .hint_timeout_s
        .clamp(HINT_TIMEOUT_S_RANGE.0, HINT_TIMEOUT_S_RANGE.1);
    config
}

/// Canonical TOML text (header + the serialized document; nested tables come
/// from the DTO's rustdoc'd shape, so the file reads like the contract).
pub(crate) fn canonical_toml(config: &ChatTranslateConfig) -> Result<String> {
    let body =
        toml::to_string(config).map_err(|e| anyhow!("serialize chat translate config: {e}"))?;
    Ok(format!("{FILE_HEADER}{body}"))
}

/// Testable core of [load]: parse (TOML first, legacy JSON twin second),
/// sanitize, and heal-write when the disk text is not canonical yet.
pub(crate) fn load_from(dir: &Path) -> ChatTranslateConfig {
    let loaded = settings_store::load_raw(dir, CONFIG_FILE, LEGACY_CONFIG_FILE);
    let Some(raw) = loaded.raw else {
        // Fresh install: defaults WITHOUT creating the file — the first
        // explicit save owns the write (same behavior as network config).
        return ChatTranslateConfig::default();
    };
    let parsed = match loaded.source {
        SettingsSource::Toml => toml::from_str::<ChatTranslateConfig>(&raw).ok(),
        SettingsSource::LegacyJson | SettingsSource::Missing => {
            serde_json::from_str::<ChatTranslateConfig>(&raw).ok()
        },
    };
    let config = sanitize(parsed.unwrap_or_default());
    if let Ok(canonical) = canonical_toml(&config) {
        settings_store::heal(
            dir,
            CONFIG_FILE,
            LEGACY_CONFIG_FILE,
            loaded.source,
            Some(&raw),
            &canonical,
        );
    }
    config
}

/// Current settings (defaults when the data dir is unresolvable).
pub(crate) fn load() -> ChatTranslateConfig {
    match paths::ensure_data_dir() {
        Ok(dir) => load_from(&dir),
        Err(_) => ChatTranslateConfig::default(),
    }
}

/// Testable core of [save]: sanitize, then atomically replace the canonical
/// file. Returns the sanitized document that actually landed.
pub(crate) fn save_to(dir: &Path, config: ChatTranslateConfig) -> Result<ChatTranslateConfig> {
    let config = sanitize(config);
    settings_store::store(dir, CONFIG_FILE, &canonical_toml(&config)?)?;
    Ok(config)
}

/// Persist the settings and return the sanitized result (the caller hands it
/// back to the webui so the UI never claims a value the app would reject).
pub(crate) fn save(config: ChatTranslateConfig) -> Result<ChatTranslateConfig> {
    let dir = paths::ensure_data_dir()?;
    save_to(&dir, config)
}

/// Apply one save request onto the stored config. Every field replaces its
/// stored counterpart; the provider key follows the tri-state transport
/// (`None` keeps the stored key, `Some("")` clears it, `Some(value)`
/// replaces it). Sanitization happens afterwards in [save_to].
pub(crate) fn apply_update(
    mut config: ChatTranslateConfig,
    update: ChatTranslateConfigUpdate,
) -> ChatTranslateConfig {
    config.enabled = update.enabled;
    config.consent_version = update.consent_version;
    config.provider.base_url = update.provider.base_url;
    config.provider.model = update.provider.model;
    if let Some(api_key) = update.provider.api_key {
        config.provider.api_key = api_key;
    }
    config.provider.timeout_ms = update.provider.timeout_ms;
    config.provider.temperature = update.provider.temperature;
    config.languages = update.languages;
    config.detect = update.detect;
    config.context = update.context;
    config.display = update.display;
    config.send = update.send;
    config
}

/// Environment override, if present (trimmed; all-whitespace counts as
/// absent). Read at call time so a running app picks it up without a restart.
pub(crate) fn api_key_env_override() -> Option<String> {
    std::env::var(API_KEY_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Pure key resolution: the environment override wins over the stored key;
/// blank values count as absent. Read-side only — nothing is written back.
fn effective_key(stored: &str, env_override: Option<&str>) -> Option<String> {
    env_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            let stored = stored.trim();
            (!stored.is_empty()).then_some(stored)
        })
        .map(str::to_string)
}

/// The key an outbound request must use (environment override first).
pub(crate) fn effective_api_key(config: &ChatTranslateConfig) -> Option<String> {
    effective_key(&config.provider.api_key, api_key_env_override().as_deref())
}

/// The chat panel's display prefs as the panel window receives them
/// (`wowsp://chat-prefs`). One field today — the configured data-side line
/// cap; the overlay window's own `chatPanelMaxLines` caps the same list
/// window-side. camelCase wire shape, mirroring the webui's listener.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatPrefsPayload {
    pub max_lines: i64,
}

/// Payload for [`emit_prefs`]: the sanitized `display.maxLines` (pure, so the
/// wire shape is unit-tested without an app handle).
pub(crate) fn prefs_payload(config: &ChatTranslateConfig) -> ChatPrefsPayload {
    ChatPrefsPayload {
        max_lines: config.display.max_lines,
    }
}

/// Notify the live chat panel that the settings changed (a settings save just
/// landed). Best-effort: no window listening is normal (the panel window is
/// only up while the game runs), so a failed emit is not an error.
pub(crate) fn emit_prefs(app: &tauri::AppHandle, config: &ChatTranslateConfig) {
    if let Err(error) = app.emit(CHAT_PREFS_EVENT, prefs_payload(config)) {
        tracing::debug!(error = %error, "emit chat-prefs failed");
    }
}

/// The config as the webui receives it, with the key stripped and the two
/// key-state booleans the settings card badges.
pub(crate) fn response(config: &ChatTranslateConfig) -> ChatTranslateConfigResponse {
    let env_override = api_key_env_override();
    let api_key_set = effective_key(&config.provider.api_key, env_override.as_deref()).is_some();
    ChatTranslateConfigResponse {
        config: ChatTranslateConfigPublic::from(config),
        api_key_set,
        env_key_override: env_override.is_some(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wowsp_tauri_shared::{
        ChatTranslateContextConfig, ChatTranslateDetectConfig, ChatTranslateDisplayConfig,
        ChatTranslateLanguagesConfig, ChatTranslateProviderUpdate, ChatTranslateSendConfig,
    };

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-test-chat-translate-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Build a config through a mutation closure. Keeps the "invalid value"
    /// test tables readable while avoiding clippy's
    /// `field_reassign_with_default` on a `let mut x = Default::default()`
    /// binding.
    fn config_with(apply: impl FnOnce(&mut ChatTranslateConfig)) -> ChatTranslateConfig {
        let mut config = ChatTranslateConfig::default();
        apply(&mut config);
        config
    }

    /// Every default matches the implementation contract, key by key — this
    /// is the file the settings UI presents and the probe will eventually
    /// read, so a silent drift must fail here.
    #[test]
    fn defaults_match_the_contract() {
        let config = ChatTranslateConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.consent_version, 0);
        assert_eq!(config.provider.base_url, "https://api.deepseek.com");
        assert_eq!(config.provider.model, "deepseek-chat");
        assert_eq!(config.provider.api_key, "");
        assert_eq!(config.provider.timeout_ms, 10_000);
        assert_eq!(config.provider.temperature, 0.0);
        assert_eq!(config.languages.self_lang, "");
        assert_eq!(config.languages.mode, "auto");
        assert!(config.languages.always.is_empty());
        assert!(config.languages.exclude.is_empty());
        assert_eq!(config.languages.max_targets, 4);
        assert_eq!(config.detect.min_chars, 2);
        assert!(config.context.ship_names);
        assert!(config.context.teams);
        assert_eq!(config.context.recent_lines, 8);
        assert!(!config.context.nicknames);
        assert_eq!(config.display.max_lines, 8);
        assert_eq!(config.send.mode, "clipboard");
        assert!(config.send.suffix_enabled);
        assert_eq!(config.send.suffix_format, "per-segment");
        assert_eq!(config.send.split_chars, 120);
        assert_eq!(config.send.pace_ms, 500);
        assert_eq!(config.send.max_per_send, 3);
        assert_eq!(config.send.per_battle_cap, 20);
        assert_eq!(config.send.cooldown_s, 10);
        assert_eq!(config.send.hint_timeout_s, 60);
    }

    /// The canonical file carries the contract header and camelCase keys with
    /// the nested sections, and parses back to the same document.
    #[test]
    fn canonical_toml_round_trips_with_header() {
        let config = ChatTranslateConfig::default();
        let text = canonical_toml(&config).unwrap();
        assert!(text.starts_with("# WoWSP chat translation settings."));
        assert!(text.contains("enabled = false"));
        assert!(text.contains("consentVersion = 0"));
        assert!(text.contains("[provider]"));
        assert!(text.contains(r#"baseUrl = "https://api.deepseek.com""#));
        assert!(text.contains(r#"model = "deepseek-chat""#));
        assert!(text.contains(r#"apiKey = """#));
        assert!(text.contains("timeoutMs = 10000"));
        assert!(text.contains("temperature = 0.0"));
        assert!(text.contains("[languages]"));
        assert!(text.contains(r#"selfLang = """#));
        assert!(text.contains(r#"mode = "auto""#));
        assert!(text.contains("maxTargets = 4"));
        assert!(text.contains("[detect]"));
        assert!(text.contains("[context]"));
        assert!(text.contains("[display]"));
        assert!(text.contains("[send]"));
        assert!(text.contains(r#"suffixFormat = "per-segment""#));
        let parsed: ChatTranslateConfig = toml::from_str(&text).unwrap();
        assert_eq!(parsed, config);
    }

    /// Out-of-range, unknown and wrong-shape values heal onto the contract
    /// defaults / clamped bands instead of failing the parse.
    #[test]
    fn sanitize_clamps_and_heals() {
        let config = config_with(|c| {
            c.consent_version = -3;
            c.provider.base_url = "api.deepseek.com".into();
            c.provider.model = "   ".into();
            c.provider.api_key = "  sk-test  ".into();
            c.provider.timeout_ms = 1;
            c.provider.temperature = -1.0;
            c.languages.self_lang = "zh-tw".into();
            c.languages.mode = "FIXED".into();
            c.languages.always = vec!["ja".into(), "JA".into(), "zz".into(), " ko ".into()];
            c.languages.exclude = vec!["ru".into(), "xx".into()];
            c.languages.max_targets = 99;
            c.detect.min_chars = 0;
            c.context.recent_lines = -1;
            c.display.max_lines = 1;
            c.send.mode = "bogus".into();
            c.send.suffix_format = "bogus".into();
            c.send.split_chars = 999;
            c.send.pace_ms = 1;
            c.send.max_per_send = 9;
            c.send.per_battle_cap = 0;
            c.send.cooldown_s = 999;
            c.send.hint_timeout_s = 1;
        });

        let healed = sanitize(config);

        assert_eq!(healed.consent_version, 0);
        assert_eq!(healed.provider.base_url, "https://api.deepseek.com");
        assert_eq!(healed.provider.model, "deepseek-chat");
        assert_eq!(healed.provider.api_key, "sk-test");
        assert_eq!(healed.provider.timeout_ms, 3_000);
        assert_eq!(healed.provider.temperature, 0.0);
        assert_eq!(healed.languages.self_lang, "zh-TW");
        assert_eq!(healed.languages.mode, "fixed");
        assert_eq!(healed.languages.always, vec!["ja", "ko"]);
        assert_eq!(healed.languages.exclude, vec!["ru"]);
        assert_eq!(healed.languages.max_targets, 6);
        assert_eq!(healed.detect.min_chars, 1);
        assert_eq!(healed.context.recent_lines, 0);
        assert_eq!(healed.display.max_lines, 3);
        assert_eq!(healed.send.mode, "off");
        assert_eq!(healed.send.suffix_format, "per-segment");
        assert_eq!(healed.send.split_chars, 138);
        assert_eq!(healed.send.pace_ms, 200);
        assert_eq!(healed.send.max_per_send, 5);
        assert_eq!(healed.send.per_battle_cap, 1);
        assert_eq!(healed.send.cooldown_s, 300);
        assert_eq!(healed.send.hint_timeout_s, 5);

        // Upper bounds, non-finite temperature and unknown languages.
        let upper = config_with(|c| {
            c.provider.timeout_ms = 99_999;
            c.provider.temperature = f64::NAN;
            c.languages.self_lang = "xx".into();
            c.languages.max_targets = 0;
            c.detect.min_chars = 99;
            c.context.recent_lines = 99;
            c.display.max_lines = 99;
            c.send.pace_ms = 99_999;
            c.send.hint_timeout_s = 9_999;
        });
        let healed = sanitize(upper);
        assert_eq!(healed.provider.timeout_ms, 60_000);
        assert_eq!(healed.provider.temperature, 0.0);
        assert_eq!(healed.languages.self_lang, "");
        assert_eq!(healed.languages.max_targets, 1);
        assert_eq!(healed.detect.min_chars, 20);
        assert_eq!(healed.context.recent_lines, 30);
        assert_eq!(healed.display.max_lines, 30);
        assert_eq!(healed.send.pace_ms, 5_000);
        assert_eq!(healed.send.hint_timeout_s, 600);

        // A scheme plus INTERNAL whitespace can never form a working URL —
        // the trim only strips the ends, so this heals to the default.
        let spaced = config_with(|c| c.provider.base_url = " https://api.exa mple.test ".into());
        assert_eq!(
            sanitize(spaced).provider.base_url,
            "https://api.deepseek.com"
        );

        // Trailing slash + https case survive; the default keeps its scheme.
        let url = config_with(|c| c.provider.base_url = "  https://api.example.test/v1/  ".into());
        assert_eq!(
            sanitize(url).provider.base_url,
            "https://api.example.test/v1"
        );
    }

    /// A missing file reads as defaults and is NOT created by a read (the
    /// first explicit save owns the write).
    #[test]
    fn missing_file_reads_defaults_without_writing() {
        let dir = temp_dir("missing");
        let config = load_from(&dir);
        assert_eq!(config, ChatTranslateConfig::default());
        assert!(!dir.join(CONFIG_FILE).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Garbage on disk heals to the canonical defaults (the bad text is
    /// replaced, not preserved).
    #[test]
    fn garbage_heals_to_canonical_defaults() {
        let dir = temp_dir("garbage");
        std::fs::write(dir.join(CONFIG_FILE), "not toml at all [").unwrap();
        let config = load_from(&dir);
        assert_eq!(config, ChatTranslateConfig::default());
        let healed = std::fs::read_to_string(dir.join(CONFIG_FILE)).unwrap();
        assert_eq!(
            healed,
            canonical_toml(&ChatTranslateConfig::default()).unwrap()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A save round-trips through the file, keeps the key on disk (local
    /// plaintext by design) and still NEVER exposes it in the public
    /// projection.
    #[test]
    fn save_round_trips_but_public_projection_blanks_the_key() {
        let dir = temp_dir("roundtrip");
        let config = config_with(|c| {
            c.provider.api_key = "sk-local-test".into();
            c.languages.always = vec!["ja".into(), "ko".into()];
        });
        let stored = save_to(&dir, config).unwrap();
        assert_eq!(stored.provider.api_key, "sk-local-test");

        let on_disk = std::fs::read_to_string(dir.join(CONFIG_FILE)).unwrap();
        assert!(on_disk.contains(r#"apiKey = "sk-local-test""#));

        let loaded = load_from(&dir);
        assert_eq!(loaded, stored);
        // Steady state: a read of the canonical file leaves it byte-identical.
        assert_eq!(
            std::fs::read_to_string(dir.join(CONFIG_FILE)).unwrap(),
            on_disk
        );

        let response = response(&loaded);
        assert_eq!(response.config.provider.api_key, "");
        assert!(response.api_key_set);
        assert_eq!(response.config.languages.always, vec!["ja", "ko"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The provider key transport is tri-state: None keeps the stored key,
    /// Some("") clears it, Some(value) replaces it.
    #[test]
    fn update_api_key_is_tri_state() {
        let stored = config_with(|c| c.provider.api_key = "sk-old".into());
        let mut update = ChatTranslateConfigUpdate {
            enabled: true,
            consent_version: 1,
            provider: ChatTranslateProviderUpdate {
                base_url: "https://api.deepseek.com".into(),
                model: "deepseek-chat".into(),
                api_key: None,
                timeout_ms: 10_000,
                temperature: 0.0,
            },
            languages: ChatTranslateLanguagesConfig::default(),
            detect: ChatTranslateDetectConfig::default(),
            context: ChatTranslateContextConfig::default(),
            display: ChatTranslateDisplayConfig::default(),
            send: ChatTranslateSendConfig::default(),
        };
        let kept = apply_update(stored.clone(), update.clone());
        assert_eq!(kept.provider.api_key, "sk-old");
        assert!(kept.enabled);
        assert_eq!(kept.consent_version, 1);

        update.provider.api_key = Some(String::new());
        assert_eq!(
            apply_update(stored.clone(), update.clone())
                .provider
                .api_key,
            ""
        );

        update.provider.api_key = Some("sk-new".into());
        assert_eq!(apply_update(stored, update).provider.api_key, "sk-new");
    }

    /// Unknown numeric values in a save request are sanitized before they
    /// land (the returned document is what the file holds).
    #[test]
    fn update_sanitizes_before_persisting() {
        let dir = temp_dir("update-sanitize");
        let update = ChatTranslateConfigUpdate {
            enabled: true,
            consent_version: 1,
            provider: ChatTranslateProviderUpdate {
                base_url: "no-scheme".into(),
                model: String::new(),
                api_key: Some("  ".into()),
                timeout_ms: 1,
                temperature: 9.0,
            },
            languages: ChatTranslateLanguagesConfig::default(),
            detect: ChatTranslateDetectConfig::default(),
            context: ChatTranslateContextConfig::default(),
            display: ChatTranslateDisplayConfig::default(),
            send: ChatTranslateSendConfig::default(),
        };
        let merged = apply_update(load_from(&dir), update);
        let stored = save_to(&dir, merged).unwrap();
        assert_eq!(stored.provider.base_url, "https://api.deepseek.com");
        assert_eq!(stored.provider.model, "deepseek-chat");
        assert_eq!(stored.provider.api_key, "");
        assert_eq!(stored.provider.timeout_ms, 3_000);
        assert_eq!(stored.provider.temperature, 2.0);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Key resolution: env wins over stored, blanks count as absent, and the
    /// stored key survives when no override is present.
    #[test]
    fn effective_key_prefers_env_and_ignores_blanks() {
        assert_eq!(
            effective_key("sk-stored", None).as_deref(),
            Some("sk-stored")
        );
        assert_eq!(effective_key("", None), None);
        assert_eq!(effective_key("   ", None), None);
        assert_eq!(
            effective_key("sk-stored", Some("sk-env")).as_deref(),
            Some("sk-env")
        );
        assert_eq!(
            effective_key("sk-stored", Some("  ")).as_deref(),
            Some("sk-stored")
        );
        assert_eq!(effective_key("", Some("sk-env")).as_deref(), Some("sk-env"));
    }

    /// The chat-panel prefs payload is the camelCase wire shape the panel's
    /// `wowsp://chat-prefs` listener reads, carrying the SANITIZED
    /// `display.maxLines` (a hand-edited out-of-range value arrives clamped).
    #[test]
    fn prefs_payload_carries_the_sanitized_display_cap() {
        let config = config_with(|c| c.display.max_lines = 12);
        let payload = prefs_payload(&config);
        assert_eq!(payload.max_lines, 12);
        let value = serde_json::to_value(payload).expect("prefs payload serializes");
        assert_eq!(value["maxLines"], 12);
        assert_eq!(
            value.as_object().map(|object| object.len()),
            Some(1),
            "the panel prefs contract is exactly one field today"
        );

        // Out-of-range stored values sanitize on the way in; the payload only
        // ever carries the clamp.
        let clamped = sanitize(config_with(|c| c.display.max_lines = 999));
        assert_eq!(prefs_payload(&clamped).max_lines, 30);
        let low = sanitize(config_with(|c| c.display.max_lines = 1));
        assert_eq!(prefs_payload(&low).max_lines, 3);
    }
}
