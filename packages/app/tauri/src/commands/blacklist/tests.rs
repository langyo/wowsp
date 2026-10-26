//! Unit suite for the blacklist sync's pure cores: realm/platform mapping,
//! the login URL shape, callback parsing, config sanitize + heal, and the
//! snapshot store roundtrip. The network paths (fetch, sweep) are exercised
//! against the live portals only by hand — same policy as the roster batch.

use anyhow::Result;

use wowsp_tauri_shared::{
    BlacklistEntry, BlacklistPlatform, BlacklistSnapshot, BlacklistSyncConfig,
};

use super::auth::{
    AuthSuccess, StoredAuth, build_login_url, canonical_auth_toml, parse_callback_query,
    platform_of, portal_base,
};
use super::sync::{
    CONFIG_FILE, SNAPSHOT_FILE, canonical_config_toml, load_config_from, load_snapshot_from,
    parse_blocked_response, redact_url, sanitize_config, snapshot_path, store_snapshot,
};

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "wowsp-test-blacklist-{tag}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn platform_and_portal_base_agree() {
    assert_eq!(platform_of("ru"), Some(BlacklistPlatform::Lesta));
    assert_eq!(portal_base("ru"), Some("/mk"));
    for realm in ["eu", "na", "asia"] {
        assert_eq!(platform_of(realm), Some(BlacklistPlatform::Wargaming));
        assert_eq!(portal_base(realm), Some("/wgn"));
    }
    // The CN cluster has no public API — the whole feature is off there.
    assert_eq!(platform_of("cn"), None);
    assert_eq!(portal_base("cn"), None);
    assert_eq!(platform_of("xx"), None);
}

#[test]
fn login_url_targets_the_right_portal() {
    let now = 1_700_000_000;
    let ttl = 14 * 24 * 3600i64;
    let ru = build_login_url("ru", "http://127.0.0.1:58099/callback", now).unwrap();
    assert!(
        ru.starts_with("https://api.korabli.su/mk/auth/login/"),
        "got {ru}"
    );
    assert!(ru.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A58099%2Fcallback"));
    assert!(ru.contains(&format!("expires_at={}", now + ttl)));
    let eu = build_login_url("eu", "http://127.0.0.1:1/cb", now).unwrap();
    assert!(
        eu.starts_with("https://api.worldofwarships.eu/wgn/auth/login/"),
        "got {eu}"
    );
    // No public API on cn: the login URL simply cannot be built.
    assert!(build_login_url("cn", "http://127.0.0.1:1/cb", now).is_err());
}

#[test]
fn callback_parses_success_error_and_noise() {
    let ok = parse_callback_query(
        "status=ok&access_token=abc123&expires_at=1700000000&account_id=12345&nickname=Laneigedc",
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        ok,
        AuthSuccess {
            access_token: "abc123".to_string(),
            expires_at: 1_700_000_000,
            account_id: 12345,
            nickname: "Laneigedc".to_string(),
        }
    );
    // Nicknames arrive percent-encoded (any unicode the portal escapes).
    let encoded = parse_callback_query(
        "status=ok&access_token=t&expires_at=1&account_id=2&nickname=%5BTAG%5DName%20x",
    )
    .unwrap()
    .unwrap();
    assert_eq!(encoded.nickname, "[TAG]Name x");

    // + stays literal — the shared percent_decode is NOT form-urlencoding,
    // and portals percent-encode spaces as %20 in the redirect.
    let portal_error = parse_callback_query("status=error&code=402&message=bad+app").unwrap();
    assert_eq!(portal_error.unwrap_err(), "bad+app");

    // Not a callback at all: the listener must keep waiting.
    assert!(parse_callback_query("theme=dark&lang=en").is_err());
    // status=ok but an incomplete answer: the flow ends with a failure.
    assert!(
        parse_callback_query("status=ok&access_token=t")
            .unwrap()
            .is_err()
    );
}

#[test]
fn auth_toml_roundtrips_with_credential_header() -> Result<()> {
    let auth = StoredAuth {
        realm: "ru".to_string(),
        account_id: 7,
        nickname: "n".to_string(),
        access_token: "tok".to_string(),
        expires_at: 99,
    };
    let text = canonical_auth_toml(&auth)?;
    assert!(text.starts_with("# WoWSP blacklist sync credential"));
    let back: StoredAuth = toml::from_str(&text)?;
    assert_eq!(back, auth);
    Ok(())
}

#[test]
fn config_sanitizes_and_heals_from_disk() {
    let dir = temp_dir("config");
    // Garbage on disk heals to the defaults (settings-store convention).
    std::fs::write(dir.join(CONFIG_FILE), "not [ valid toml {{{").unwrap();
    let healed = load_config_from(&dir);
    assert_eq!(healed, BlacklistSyncConfig::default());
    // The clamp snaps out-of-range intervals onto the default.
    assert_eq!(
        sanitize_config(BlacklistSyncConfig {
            auto_sync: true,
            interval_hours: 5000,
        })
        .interval_hours,
        24
    );
    assert_eq!(
        sanitize_config(BlacklistSyncConfig {
            auto_sync: false,
            interval_hours: 0,
        })
        .interval_hours,
        24
    );
    let sane = BlacklistSyncConfig {
        auto_sync: false,
        interval_hours: 7,
    };
    assert_eq!(sanitize_config(sane), sane);
    // Canonical text on disk reloads untouched (the steady state).
    std::fs::write(dir.join(CONFIG_FILE), canonical_config_toml(&sane).unwrap()).unwrap();
    assert_eq!(load_config_from(&dir), sane);
}

#[test]
fn snapshot_roundtrips_and_filters_by_realm() {
    let dir = temp_dir("snapshot");
    let snap = BlacklistSnapshot {
        realm: "eu".to_string(),
        platform: BlacklistPlatform::Wargaming,
        account_id: 42,
        nickname: Some("me".to_string()),
        last_synced_at: 1,
        unresolved: 1,
        entries: vec![
            BlacklistEntry {
                account_id: 2,
                nickname: None,
            },
            BlacklistEntry {
                account_id: 1,
                nickname: Some("x".to_string()),
            },
        ],
    };
    assert!(load_snapshot_from(&dir, "eu").is_none());
    store_snapshot(&dir, &snap).unwrap();
    assert!(snapshot_path(&dir).ends_with(SNAPSHOT_FILE));
    assert_eq!(load_snapshot_from(&dir, "eu").as_ref(), Some(&snap));
    // A different realm must not see the snapshot (one realm per file).
    assert!(load_snapshot_from(&dir, "na").is_none());
}

#[test]
fn redact_url_cuts_every_query_string() {
    let msg = "error sending request for url (https://api.worldofwarships.eu/wows/account/info/?application_id=abc&access_token=tok) caused by x";
    let out = redact_url(msg);
    assert!(!out.contains("tok"), "token leaked: {out}");
    assert!(!out.contains("application_id"), "query leaked: {out}");
    assert!(out.contains("account/info/?..)"), "path kept: {out}");
    // Messages without a query pass through byte-for-byte.
    assert_eq!(redact_url("plain failure"), "plain failure");
}

#[test]
fn parse_blocked_response_covers_the_branches() {
    use serde_json::json;
    // The full block: ids come back (order untouched — sorting is the
    // caller's job).
    let full = json!({ "42": { "private": { "grouped_contacts": { "blocked": [5, 3] } } } });
    assert_eq!(parse_blocked_response(Some(&full), 42), Some(vec![5, 3]));
    // The PRIVATE node missing = the private_missing signal (None) — the
    // "token transport rejected" shape the sync must not render as a
    // silent empty blacklist.
    let bare = json!({ "42": { "nickname": "x" } });
    assert_eq!(parse_blocked_response(Some(&bare), 42), None);
    // An account that never used contacts returns an EMPTY block — a
    // legitimate empty blacklist, not a failure.
    let blank = json!({ "42": { "private": { "grouped_contacts": { "blocked": [] } } } });
    assert_eq!(
        parse_blocked_response(Some(&blank), 42),
        Some(Vec::<i64>::new())
    );
    // Another account's node must not match.
    assert_eq!(parse_blocked_response(Some(&full), 43), None);
    assert_eq!(parse_blocked_response(None, 42), None);
}
