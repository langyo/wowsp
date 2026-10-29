use super::*;

// ── offline unit tests — no network, no sockets (the pairing_relay suite's
// style: pure cores + explicit-dir persistence roundtrips).

use wowsp_tauri_shared::{ArenaInfo, PlayingAccount, VehicleEntry};

/// Unique temp dir per test tag (cleaned best-effort on entry).
fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("wowsp-gateway-test-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

fn health_doc(
    gateway: &str,
    min: Option<&str>,
    turnstile: bool,
    password: bool,
) -> wowsp_tauri_shared::GatewayHealthDoc {
    wowsp_tauri_shared::GatewayHealthDoc {
        gateway: gateway.into(),
        min_client_version: min.map(str::to_string),
        auth: wowsp_tauri_shared::GatewayAuthDoc {
            turnstile: wowsp_tauri_shared::GatewayTurnstileDoc {
                required: turnstile,
                sitekey: turnstile.then(|| "0x4TESTSITEKEY".to_string()),
            },
            password: wowsp_tauri_shared::GatewayPasswordDoc { required: password },
        },
        notice: None,
    }
}

// ── config persistence ────────────────────────────────────────────────────────

#[test]
fn config_roundtrips_and_normalizes_through_the_data_dir() {
    let dir = temp_dir("config");
    // Absent file → the default: official entry, service OFF.
    let first = super::config::load_config_in(&dir);
    assert_eq!(first.root, "https://wowsp.langyo.xyz/gateway/");
    assert!(!first.enabled);
    // Any relay-URL spelling folds onto the normalized https root.
    let stored = wowsp_tauri_shared::GatewayClientConfig {
        root: "wss://Gw.Example.org/gateway/".into(),
        enabled: true,
    };
    std::fs::write(
        dir.join(super::config::GATEWAY_CONFIG_FILE),
        serde_json::to_string(&stored).unwrap(),
    )
    .unwrap();
    let loaded = super::config::load_config_in(&dir);
    assert_eq!(loaded.root, "https://Gw.Example.org/gateway");
    assert!(loaded.enabled);
    let _ = std::fs::remove_dir_all(&dir);
}

// ── health document validation (gateway-push §9 markers) ─────────────────────

#[test]
fn health_validation_gates_in_the_relay_order() {
    // A good v1 document passes whatever the credential demands.
    assert!(
        super::health::validate_gateway_health(
            &health_doc("v1", Some("0.6.8"), true, true),
            "0.6.8"
        )
        .is_ok()
    );
    // A body without a gateway field is a foreign 200, not a gateway.
    let marker =
        super::health::validate_gateway_health(&health_doc("", None, false, false), "0.6.8")
            .unwrap_err()
            .to_string();
    assert_eq!(marker, GATEWAY_UNREACHABLE);
    // The version gate runs FIRST: a too-old app must hear "update the
    // app", never the protocol complaint it cannot act on.
    let marker = super::health::validate_gateway_health(
        &health_doc("v2", Some("99.0"), false, false),
        "0.6.8",
    )
    .unwrap_err()
    .to_string();
    assert_eq!(marker, GATEWAY_TOO_OLD);
    // A gateway past v1 is unsupported — NOT collapsed into "unreachable"
    // (the user cannot fix it by retrying).
    let marker =
        super::health::validate_gateway_health(&health_doc("v2", None, false, false), "0.6.8")
            .unwrap_err()
            .to_string();
    assert_eq!(marker, GATEWAY_UNSUPPORTED);
    // The protocol check is case-insensitive.
    assert!(
        super::health::validate_gateway_health(&health_doc("V1", None, false, false), "0.6.8")
            .is_ok()
    );
}

#[test]
fn health_docs_parse_the_pinned_wire_shape() {
    // Turnstile off ⇒ the sitekey key is OMITTED entirely (relay-gateway's
    // pinned contract), and missing blocks default instead of failing.
    let doc: wowsp_tauri_shared::GatewayHealthDoc = serde_json::from_str(
        r#"{"gateway":"v1","minClientVersion":"0.6.8",
            "auth":{"turnstile":{"required":false},"password":{"required":false}},
            "notice":null}"#,
    )
    .unwrap();
    assert!(doc.auth.turnstile.sitekey.is_none());
    assert!(super::health::validate_gateway_health(&doc, "0.6.8").is_ok());
    let foreign: wowsp_tauri_shared::GatewayHealthDoc =
        serde_json::from_str(r#"{"html":"login"}"#).unwrap();
    assert_eq!(foreign.gateway, "");
}

// ── route ids (gateway-push §2) ───────────────────────────────────────────────

#[test]
fn routes_validate_and_parse() {
    assert!(super::session::valid_route("r:asia:123456"));
    assert!(super::session::valid_route("r:na:1"));
    // Near misses the worker would also refuse.
    assert!(!super::session::valid_route("r:a:1")); // realm too short
    assert!(super::session::valid_route("r:asiap:1")); // 5-char realm is the cap
    assert!(!super::session::valid_route("r:asiapacific:1")); // realm too long
    assert!(!super::session::valid_route("r:ASIA:1")); // uppercase realm
    assert!(!super::session::valid_route("r:asia:")); // empty id
    assert!(!super::session::valid_route("r:asia:12a456"));
    assert!(!super::session::valid_route("asia:123456"));
    assert!(!super::session::valid_route("r:asia:123456 "));
    assert!(!super::session::valid_route(""));
    // Segments parse for the identity fallbacks.
    assert_eq!(super::session::route_realm("r:eu:42"), "eu");
    assert_eq!(super::session::route_account_id("r:eu:42"), Some(42));
    assert_eq!(super::session::route_realm("garbage"), "");
    assert_eq!(super::session::route_account_id("garbage"), None);
}

// ── credential matrix + session request body + error mapping ─────────────────

#[test]
fn credential_matrix_matches_health_demands() {
    use super::session::CredentialReadiness as R;
    let none = health_doc("v1", None, false, false);
    let turnstile = health_doc("v1", None, true, false);
    let password = health_doc("v1", None, false, true);
    let both = health_doc("v1", None, true, true);
    let token = Some("tok");
    let secret = Some("pw");
    assert_eq!(
        super::session::credential_readiness(&none, None, None),
        R::Ready
    );
    // Turnstile demanded, token absent (or blank) ⇒ captcha phase.
    assert_eq!(
        super::session::credential_readiness(&turnstile, None, None),
        R::NeedCaptcha
    );
    assert_eq!(
        super::session::credential_readiness(&turnstile, Some("  "), None),
        R::NeedCaptcha
    );
    assert_eq!(
        super::session::credential_readiness(&turnstile, token, None),
        R::Ready
    );
    // Password demanded, secret absent ⇒ password error (captcha first
    // when both are missing — the challenge renders before the sheet).
    assert_eq!(
        super::session::credential_readiness(&password, None, None),
        R::NeedPassword
    );
    assert_eq!(
        super::session::credential_readiness(&password, None, secret),
        R::Ready
    );
    assert_eq!(
        super::session::credential_readiness(&both, None, None),
        R::NeedCaptcha
    );
    assert_eq!(
        super::session::credential_readiness(&both, token, None),
        R::NeedPassword
    );
    assert_eq!(
        super::session::credential_readiness(&both, token, secret),
        R::Ready
    );
}

#[test]
fn session_request_body_omits_absent_credentials() {
    let bare = super::session::session_request_body("r:asia:1", None, None);
    let value: serde_json::Value = serde_json::from_str(&bare).unwrap();
    assert_eq!(value, serde_json::json!({"route": "r:asia:1"}));
    let full = super::session::session_request_body("r:asia:1", Some("tok"), Some("pw"));
    let value: serde_json::Value = serde_json::from_str(&full).unwrap();
    assert_eq!(
        value,
        serde_json::json!({
            "route": "r:asia:1",
            "cf-turnstile-response": "tok",
            "password": "pw"
        })
    );
    // Blank strings count as absent.
    let blanked = super::session::session_request_body("r:asia:1", Some("  "), Some(""));
    let value: serde_json::Value = serde_json::from_str(&blanked).unwrap();
    assert_eq!(value, serde_json::json!({"route": "r:asia:1"}));
}

#[test]
fn session_errors_map_onto_the_stable_markers() {
    use super::session::map_session_error;
    assert_eq!(
        map_session_error(429, Some("rate_limited"), Some(42)),
        "gateway rate limited, retry after 42s"
    );
    // 429 without a body still carries a retry budget.
    assert_eq!(
        map_session_error(429, None, None),
        "gateway rate limited, retry after 5s"
    );
    assert_eq!(
        map_session_error(403, Some("captcha"), None),
        GATEWAY_CAPTCHA_FAILED
    );
    // The gateway failing to REACH siteverify remints the challenge too.
    assert_eq!(
        map_session_error(502, Some("captcha_unreachable"), None),
        GATEWAY_CAPTCHA_FAILED
    );
    assert_eq!(
        map_session_error(403, Some("missing_captcha"), None),
        GATEWAY_CAPTCHA_FAILED
    );
    assert_eq!(
        map_session_error(403, Some("password"), None),
        GATEWAY_PASSWORD_REJECTED
    );
    assert_eq!(
        map_session_error(400, Some("missing_password"), None),
        GATEWAY_PASSWORD_REJECTED
    );
    assert_eq!(
        map_session_error(400, Some("bad_json"), None),
        "gateway session exchange failed (bad_json)"
    );
    assert_eq!(
        map_session_error(500, None, None),
        "gateway session exchange failed (HTTP 500)"
    );
}

// ── socket URL derivation ─────────────────────────────────────────────────────

#[test]
fn socket_urls_derive_from_the_root_policy() {
    assert_eq!(
        sub_ws_url(
            "https://wowsp.langyo.xyz/gateway",
            "r:asia:1",
            &"a".repeat(32)
        )
        .unwrap(),
        format!(
            "wss://wowsp.langyo.xyz/gateway/sub?route=r:asia:1&ticket={}",
            "a".repeat(32)
        )
    );
    // Loopback dev roots keep plain ws.
    assert_eq!(
        sub_ws_url("http://127.0.0.1:8787", "r:asia:1", &"b".repeat(32)).unwrap(),
        format!(
            "ws://127.0.0.1:8787/sub?route=r:asia:1&ticket={}",
            "b".repeat(32)
        )
    );
}

#[cfg(desktop)]
#[test]
fn pub_socket_url_carries_the_persistent_host_id() {
    let url = pub_ws_url(
        "https://gw.example.org",
        "r:eu:7",
        &"c".repeat(32),
        &"d".repeat(32),
    )
    .unwrap();
    assert_eq!(
        url,
        format!(
            "wss://gw.example.org/pub?route=r:eu:7&ticket={}&hostId={}",
            "c".repeat(32),
            "d".repeat(32)
        )
    );
}

// ── battle frame builder + size guard (desktop publisher core) ────────────────

#[cfg(desktop)]
fn sample_arena(vehicles: Vec<VehicleEntry>) -> ArenaInfo {
    ArenaInfo {
        match_group: Some("pvp".into()),
        date_time: Some("2026-10-29 22:00:00".into()),
        map_name: Some("14_ATL_NavalBase".into()),
        scenario: Some(String::new()),
        event_type: Some(String::new()),
        bot_count: 0,
        scripted_unit_count: 0,
        vehicles,
        raw: serde_json::json!({ "playerName": "langyo", "internal": { "junk": true } }),
    }
}

#[cfg(desktop)]
fn vehicle(id: i64, name: &str, relation: i64, ship: &str) -> VehicleEntry {
    VehicleEntry {
        id,
        name: name.into(),
        relation,
        ship_id: 4_189_570_000 + id,
        ship_name: Some(ship.into()),
    }
}

#[cfg(desktop)]
#[test]
fn battle_frame_carries_the_full_roster_and_drops_raw() {
    let info = sample_arena(vec![
        vehicle(123, "langyo", 0, "Yamato"),
        vehicle(124, "ally-one", 1, "Montana"),
        vehicle(200, ":Bot:", 2, "Kremlin"),
    ]);
    let playing = PlayingAccount {
        realm: "asia".into(),
        nickname: "langyo".into(),
        account_id: Some(555),
    };
    let frame = super::publish::build_battle_frame(&info, "r:asia:555", Some(&playing), None);
    // Identity resolution: the hub's playing account wins.
    assert_eq!(frame.realm, "asia");
    assert_eq!(frame.self_player.account_id, Some(555));
    assert_eq!(frame.self_player.name, "langyo");
    assert_eq!(frame.route, "r:asia:555");
    // The roster rides 1:1 (raw JSON dropped — nothing else leaks).
    assert_eq!(frame.battle.vehicles.len(), 3);
    assert_eq!(frame.battle.vehicles[2].name, ":Bot:");
    let wire = serde_json::to_value(&frame).unwrap();
    let battle = &wire["battle"];
    assert_eq!(battle["vehicles"][0]["shipName"], "Yamato");
    assert_eq!(battle["vehicles"][0]["relation"], 0);
    assert_eq!(battle["dateTime"], "2026-10-29 22:00:00");
    let flat = wire.to_string();
    assert!(!flat.contains("playerName"), "the raw block must not ship");
    assert!(!flat.contains("junk"));
}

#[cfg(desktop)]
#[test]
fn battle_frame_identity_falls_back_to_route_then_running_realm() {
    let info = sample_arena(vec![vehicle(9, "alt-player", 0, "Shimakaze")]);
    // No playing identity: the route's realm+id answer, running realm last.
    let frame = super::publish::build_battle_frame(&info, "r:eu:42", None, Some("na"));
    assert_eq!(frame.realm, "eu");
    assert_eq!(frame.self_player.account_id, Some(42));
    assert_eq!(frame.self_player.name, "alt-player");
    // An empty-realm playing identity (unregistered alt) yields to the
    // route realm, but its account id (when known) still wins over the
    // route's.
    let unregistered = PlayingAccount {
        realm: String::new(),
        nickname: "alt-player".into(),
        account_id: Some(777),
    };
    let frame = super::publish::build_battle_frame(&info, "r:eu:42", Some(&unregistered), None);
    assert_eq!(frame.realm, "eu");
    assert_eq!(frame.self_player.account_id, Some(777));
    // Nothing at all resolves: running install realm, route id, empty name.
    let nameless = sample_arena(Vec::new());
    let frame = super::publish::build_battle_frame(&nameless, "r:na:1", None, Some("na"));
    assert_eq!(frame.realm, "na");
    assert_eq!(frame.self_player.name, "");
}

#[cfg(desktop)]
#[test]
fn roster_heal_republishes_the_fuller_frame() {
    // The empty-roster first read publishes an empty-vehicles frame…
    let empty = sample_arena(Vec::new());
    let frame = super::publish::build_battle_frame(&empty, "r:asia:1", None, None);
    let wire = serde_json::to_value(&frame).unwrap();
    assert_eq!(wire["battle"]["vehicles"].as_array().unwrap().len(), 0);
    // …and the healed delivery (the same builder) carries the full roster.
    let healed = sample_arena(vec![vehicle(1, "langyo", 0, "Yamato")]);
    let frame = super::publish::build_battle_frame(&healed, "r:asia:1", None, None);
    let wire = serde_json::to_value(&frame).unwrap();
    assert_eq!(wire["battle"]["vehicles"].as_array().unwrap().len(), 1);
    assert_eq!(wire["battle"]["vehicles"][0]["name"], "langyo");
}

#[cfg(desktop)]
#[test]
fn oversize_frames_are_refused_before_the_wire() {
    let big_name = "x".repeat(80);
    let roster: Vec<VehicleEntry> = (0..2500)
        .map(|i| {
            vehicle(
                i,
                &format!("{i}-{big_name}"),
                i % 12,
                "SomeVeryLongShipNameIndeed",
            )
        })
        .collect();
    let info = sample_arena(roster);
    let frame = super::publish::build_battle_frame(&info, "r:asia:1", None, None);
    let err = super::publish::serialize_battle_frame(&frame)
        .expect_err("a monster roster must not reach the wire");
    assert!(
        err.to_string().contains("64 KiB"),
        "unexpected message: {err}"
    );
    // A sane roster serializes under the cap.
    let sane = sample_arena(
        (0..24)
            .map(|i| vehicle(i, &format!("player-{i}"), i % 12, "Ship"))
            .collect(),
    );
    let frame = super::publish::build_battle_frame(&sane, "r:asia:1", None, None);
    let text = super::publish::serialize_battle_frame(&frame).unwrap();
    assert!(text.len() <= super::publish::MAX_BATTLE_FRAME_BYTES);
}

#[cfg(desktop)]
#[test]
fn gateway_host_id_persists_and_reuses() {
    let dir = temp_dir("hostid");
    let first = super::publish::gateway_host_id_in(&dir);
    assert_eq!(first.len(), 32);
    assert!(first.bytes().all(|b| b.is_ascii_hexdigit()));
    // Re-read answers the SAME id (minted once, then stable).
    assert_eq!(super::publish::gateway_host_id_in(&dir), first);
    // A corrupted file re-mints rather than trusting garbage.
    std::fs::write(dir.join("gateway-host-id.txt"), "not-hex!").unwrap();
    let reminted = super::publish::gateway_host_id_in(&dir);
    assert_eq!(reminted.len(), 32);
    assert_ne!(reminted, "not-hex!");
    let _ = std::fs::remove_dir_all(&dir);
}

// ── selfhost wizard pure helpers (desktop) ────────────────────────────────────

#[cfg(desktop)]
#[test]
fn wizard_validates_hostnames_and_kv_ids() {
    assert!(super::selfhost::valid_hostname("gateway.example.com"));
    assert!(super::selfhost::valid_hostname("gw.example.co.uk"));
    assert!(!super::selfhost::valid_hostname("gateway.example.com:8443"));
    assert!(!super::selfhost::valid_hostname(
        "https://gateway.example.com"
    ));
    assert!(!super::selfhost::valid_hostname("gateway.example.com/path"));
    assert!(!super::selfhost::valid_hostname("gateway"));
    assert!(!super::selfhost::valid_hostname("-bad.example.com"));
    assert!(!super::selfhost::valid_hostname(&format!(
        "{}.example.com",
        "a".repeat(64)
    )));
    assert!(!super::selfhost::valid_hostname("  "));
    assert!(super::selfhost::valid_kv_id(
        "e29b263ab50e42e9a1de5653fda70c31"
    ));
    assert!(!super::selfhost::valid_kv_id(
        "E29B263AB50E42E9A1DE5653FDA70C31"
    ));
    assert!(!super::selfhost::valid_kv_id(
        "e29b263ab50e42e9a1de5653fda70c3"
    ));
    assert!(!super::selfhost::valid_kv_id(""));
}

#[cfg(desktop)]
#[test]
fn wizard_fills_the_template_exactly_once() {
    let template = "name = \"wowsp-gateway-selfhost\"\nroutes = [{ pattern = \"GATEWAY_EXAMPLE_INVALID\", custom_domain = true }]\nkv_namespaces = [{ binding = \"GATEWAY_KV\", id = \"GATEWAY_KV_ID_EXAMPLE_INVALID\" }]\n";
    let filled = super::selfhost::fill_selfhost_template(
        template,
        "gw.example.com",
        "e29b263ab50e42e9a1de5653fda70c31",
    )
    .unwrap();
    assert!(filled.contains("pattern = \"gw.example.com\""));
    assert!(filled.contains("id = \"e29b263ab50e42e9a1de5653fda70c31\""));
    assert!(!filled.contains("GATEWAY_EXAMPLE_INVALID"));
    // A template missing (or duplicating) a placeholder refuses loudly.
    assert!(
        super::selfhost::fill_selfhost_template("no placeholders here", "a.b", &"e".repeat(32))
            .is_err()
    );
    let doubled = format!("{template}{template}");
    assert!(super::selfhost::fill_selfhost_template(&doubled, "a.b", &"e".repeat(32)).is_err());
}

#[cfg(desktop)]
#[test]
fn wizard_parses_wrangler_outputs() {
    // kv namespace create: the binding block's id line.
    let create_output = vec![
        "🌀 Creating namespace with title \"GATEWAY_KV\"".to_string(),
        "✨ Success!".to_string(),
        "{ binding = \"GATEWAY_KV\", id = \"e29b263ab50e42e9a1de5653fda70c31\" }".to_string(),
    ];
    assert_eq!(
        super::selfhost::parse_kv_id(&create_output).as_deref(),
        Some("e29b263ab50e42e9a1de5653fda70c31")
    );
    // A malformed id never parses.
    let bogus = vec!["id = \"abc\"".to_string()];
    assert!(super::selfhost::parse_kv_id(&bogus).is_none());
    // kv namespace list: JSON with wrangler's preamble.
    let list_output = vec![
        "Getting namespaces...".to_string(),
        "[{\"title\": \"wowsp-GATEWAY_KV\", \"id\": \"e29b263ab50e42e9a1de5653fda70c31\"}]"
            .to_string(),
    ];
    assert_eq!(
        super::selfhost::parse_kv_list_id(&list_output, "GATEWAY_KV").as_deref(),
        Some("e29b263ab50e42e9a1de5653fda70c31")
    );
    // whoami: the account table row under the header.
    let whoami = vec![
        "Getting User settings...".to_string(),
        "┌────────────────┬──────────────────────────────┐".to_string(),
        "│ Account Name   │ Account ID                   │".to_string(),
        "├────────────────┼──────────────────────────────┤".to_string(),
        "│ My Legion      │ 1234567890abcdef1234567890ab │".to_string(),
        "└────────────────┴──────────────────────────────┘".to_string(),
    ];
    assert_eq!(
        super::selfhost::parse_whoami_account(&whoami).as_deref(),
        Some("My Legion")
    );
}
