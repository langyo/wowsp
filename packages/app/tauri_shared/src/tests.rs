//! Wire-contract round-trip tests. The TS side hand-mirrors every type
//! here in packages/webui/src/api/client.ts (the manual-locate picker
//! layer included) — these tests pin the
//! JSON keys serde produces so a dropped `rename_all`, a renamed field,
//! or a changed `skip_serializing_if` fails CI instead of silently
//! drifting the IPC contract.
//!
//! Scope: EVERY pub type of this crate whose definition or any field
//! carries a serde attribute (`rename_all`, `rename`, `default`,
//! `skip_serializing_if`, `alias`, or an enum tag) has a round-trip test
//! pinning its renamed keys — types with no serde attributes at all are
//! out of scope by design (nothing on their wire shape can drift through
//! serde). The wire-critical payloads (replay metadata, arena info,
//! player stats, pairing/overlay/res status, the mod catalog entry, the
//! manual-locate context, ...) additionally pin the EXACT top-level key
//! set via `assert_exact_keys`, so an ADDITIVE field fails too until the
//! TS mirror learns it.

use super::*;
use serde::Serialize;

/// Serialize → deserialize → re-serialize must be the identity on the
/// JSON `Value` level. Returns the wire shape for key assertions.
fn round_trips<T>(value: T) -> serde_json::Value
where
    T: Serialize + serde::de::DeserializeOwned,
{
    let first = serde_json::to_value(&value).expect("serializes");
    let back: T = serde_json::from_value(first.clone()).expect("parses its own shape");
    let second = serde_json::to_value(&back).expect("re-serializes");
    assert_eq!(first, second, "JSON round-trip must be stable");
    first
}

/// Pins the EXACT top-level key set: same count, same names. A field
/// merely ADDED on the Rust side (which a `contains_key` list would
/// silently ignore, and the TS interface would silently drop) fails
/// here until the mirror is updated too.
fn assert_exact_keys(v: &serde_json::Value, keys: &[&str]) {
    let obj = v.as_object().unwrap();
    assert_eq!(obj.len(), keys.len(), "key set drifted: {v}");
    for key in keys {
        assert!(obj.contains_key(*key), "missing {key} in {v}");
    }
}

// ── game detection (client.ts: GameInstall / GameProcessInfo) ──────────

/// `GameInstallKind::CnKongzhong` is the drift-prone variant: camelCase
/// yields "cnKongzhong", not "cn_kongzhong" / "CnKongzhong".
#[test]
fn game_install_renames_fields_and_enum_variants() {
    let install = GameInstall {
        kind: GameInstallKind::CnKongzhong,
        path: r"C:\Games\WoWS".into(),
        realm: Some("cn".into()),
    };
    let v = round_trips(install);
    assert_eq!(v["kind"], "cnKongzhong");
    assert_eq!(v["path"], r"C:\Games\WoWS");
    assert_eq!(v["realm"], "cn");
    assert_eq!(v.as_object().unwrap().len(), 3);
}

#[test]
fn game_process_info_renames_exe_path_and_matched_install() {
    let info = GameProcessInfo {
        running: true,
        pid: Some(4242),
        kind: Some(GameInstallKind::Steam),
        realm: None,
        exe_path: Some(r"C:\Steam\...\WorldOfWarships64.exe".into()),
        matched_install: None,
    };
    let v = round_trips(info);
    for key in [
        "running",
        "pid",
        "kind",
        "realm",
        "exePath",
        "matchedInstall",
    ] {
        assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
    }
    assert_eq!(v["pid"], 4242);
    assert_eq!(v["exePath"], r"C:\Steam\...\WorldOfWarships64.exe");
}

/// Every variant of the detection enum, spelled as the TS union members
/// (client.ts: `GameInstallKind = GameInstall["kind"]`).
#[test]
fn game_install_kind_covers_every_variant() {
    assert_eq!(round_trips(GameInstallKind::Wargaming), "wargaming");
    assert_eq!(round_trips(GameInstallKind::Steam), "steam");
    assert_eq!(round_trips(GameInstallKind::Lesta), "lesta");
    assert_eq!(round_trips(GameInstallKind::Cn360), "cn360");
    assert_eq!(round_trips(GameInstallKind::CnKongzhong), "cnKongzhong");
    assert_eq!(round_trips(GameInstallKind::Manual), "manual");
}

// ── replays (client.ts: ReplayMeta / ReplayMetaLite) ────────────────────

#[test]
fn replay_meta_renames_every_multi_word_field() {
    let meta = ReplayMeta {
        path: "replays/20250622.wowsreplay".into(),
        match_group: Some("pvp".into()),
        date_time: Some("20250622_152405".into()),
        map_id: Some(15),
        map_name: Some("15_NE_north".into()),
        scenario: Some("domination_3point".into()),
        event_type: Some("PCVE027".into()),
        bot_count: 2,
        scripted_unit_count: 2,
        vehicles: vec![VehicleEntry {
            id: 7,
            name: ":Bot:".into(),
            relation: 2,
            ship_id: 4282948544,
            ship_name: Some("Montana".into()),
        }],
        raw: serde_json::json!({ "playerName": "recorder" }),
    };
    let v = round_trips(meta);
    for key in [
        "path",
        "matchGroup",
        "dateTime",
        "mapId",
        "mapName",
        "scenario",
        "eventType",
        "botCount",
        "scriptedUnitCount",
        "vehicles",
        "raw",
    ] {
        assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
    }
    let vehicle = &v["vehicles"][0];
    assert_eq!(vehicle["shipId"], 4_282_948_544_i64);
    assert_eq!(vehicle["shipName"], "Montana");
    // bot_count is serde-defaulted: an old payload without it parses
    // (the Option fields already default to None; `raw` stays required).
    let legacy = serde_json::json!({ "path": "p", "vehicles": [], "raw": {} });
    assert!(serde_json::from_value::<ReplayMeta>(legacy).is_ok());
}

#[test]
fn replay_meta_lite_renames_own_ship_fields() {
    let lite = ReplayMetaLite {
        path: "r.wowsreplay".into(),
        date_time: Some("20250622".into()),
        match_group: Some("ranked".into()),
        map_name: Some("15_NE_north".into()),
        map_id: Some(15),
        scenario: None,
        event_type: None,
        bot_count: 0,
        scripted_unit_count: 0,
        own_ship_id: Some(4282948544),
        own_ship_name: Some("Montana".into()),
        player_count: 12,
    };
    let v = round_trips(lite);
    for key in [
        "ownShipId",
        "ownShipName",
        "playerCount",
        "dateTime",
        "matchGroup",
        "scriptedUnitCount",
    ] {
        assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
    }
    assert_eq!(v["ownShipId"], 4_282_948_544_i64);
}

/// Wire-critical payload: pin the EXACT key set so an additive field
/// (which the TS interface would silently drop) fails here too.
#[test]
fn replay_meta_pins_the_exact_wire_key_set() {
    let v = round_trips(ReplayMeta {
        path: "pin.wowsreplay".into(),
        match_group: Some("clan".into()),
        date_time: Some("20260926_101112".into()),
        map_id: Some(40),
        map_name: Some("spaces/40_Okinawa".into()),
        scenario: Some("domination_3point".into()),
        event_type: Some("PCVE027".into()),
        bot_count: 9,
        scripted_unit_count: 0,
        vehicles: Vec::new(),
        raw: serde_json::json!({ "pin": true }),
    });
    assert_exact_keys(
        &v,
        &[
            "path",
            "matchGroup",
            "dateTime",
            "mapId",
            "mapName",
            "scenario",
            "eventType",
            "botCount",
            "scriptedUnitCount",
            "vehicles",
            "raw",
        ],
    );
}

/// Wire-critical payload: pin the EXACT key set of the list view's DTO.
#[test]
fn replay_meta_lite_pins_the_exact_wire_key_set() {
    let v = round_trips(ReplayMetaLite {
        path: "pin-lite.wowsreplay".into(),
        date_time: Some("20260926_101113".into()),
        match_group: Some("event".into()),
        map_name: Some("14_ATL_north".into()),
        map_id: Some(14),
        scenario: Some("epic_3point".into()),
        event_type: Some("PCVE999".into()),
        bot_count: 8,
        scripted_unit_count: 0,
        own_ship_id: Some(4_279_574_672_i64),
        own_ship_name: Some("Kremlin".into()),
        player_count: 7,
    });
    assert_exact_keys(
        &v,
        &[
            "path",
            "dateTime",
            "matchGroup",
            "mapName",
            "mapId",
            "scenario",
            "eventType",
            "botCount",
            "scriptedUnitCount",
            "ownShipId",
            "ownShipName",
            "playerCount",
        ],
    );
}

// ── pairing (client.ts: PairingStatus / PairingToken / PairingTarget /
//    PairingProgress / DiscoveredHost) ────────────────────────────────────

#[test]
fn pairing_status_renames_relay_online_and_via_upstream() {
    let status = PairingStatus {
        running: true,
        host: Some("192.0.2.10".into()),
        port: Some(51888),
        pin: Some("123456".into()),
        mode: Some("relay".into()),
        relay_online: true,
        provider: Some("wowsp".into()),
        via_upstream: true,
        notice: Some("maintenance".into()),
    };
    let v = round_trips(status);
    for key in [
        "running",
        "host",
        "port",
        "pin",
        "mode",
        "relayOnline",
        "provider",
        "viaUpstream",
        "notice",
    ] {
        assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
    }
    assert_eq!(v["relayOnline"], true);
    assert_eq!(v["viaUpstream"], true);
    // The v2 manifest fields are additive: a v1 payload without them
    // still deserializes (defaults kick in).
    let v1 = serde_json::json!({ "running": false });
    assert!(serde_json::from_value::<PairingStatus>(v1).is_ok());
}

#[test]
fn pairing_token_renames_room() {
    let v = round_trips(PairingToken {
        token: "bearer-1".into(),
        room: Some("a".repeat(64)),
    });
    assert_eq!(v.as_object().unwrap().len(), 2);
    assert_eq!(v["token"], "bearer-1");
    assert_eq!(v["room"], "a".repeat(64));
}

/// `PairingTarget` is internally tagged (`kind`) — the TS side is a
/// discriminated union, so both the tag and the payload field names are
/// load-bearing.
#[test]
fn pairing_target_serializes_as_a_tagged_union() {
    let lan = round_trips(PairingTarget::Lan {
        host: "192.0.2.10".into(),
        port: 51888,
    });
    assert_eq!(lan["kind"], "lan");
    assert_eq!(lan["host"], "192.0.2.10");
    assert_eq!(lan["port"], 51888);

    let relay = round_trips(PairingTarget::Relay {
        url: "https://worker.example.workers.dev".into(),
        room: Some("b".repeat(64)),
    });
    assert_eq!(relay["kind"], "relay");
    assert_eq!(relay["url"], "https://worker.example.workers.dev");
    assert_eq!(relay["room"], "b".repeat(64));
}

#[test]
fn pairing_progress_renames_remote_name() {
    let v = round_trips(PairingProgress {
        remote_name: ":gamedata:".into(),
        phase: "download".into(),
        received: 1024,
        total: 4096,
        error: None,
    });
    for key in ["remoteName", "phase", "received", "total", "error"] {
        assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
    }
    assert_eq!(v["remoteName"], ":gamedata:");
}

#[test]
fn discovered_host_renames_last_seen_age_sec() {
    let v = round_trips(DiscoveredHost {
        host: "192.0.2.10".into(),
        port: 51888,
        name: "DESKTOP".into(),
        last_seen_age_sec: 3,
        relay: None,
    });
    assert_eq!(v["lastSeenAgeSec"], 3);
    assert_eq!(v.as_object().unwrap().len(), 5);
}

/// Container-level `#[serde(default)]`: an EMPTY JSON object parses back
/// to the relay bridge's default (enabled) — the persisted config is
/// written before the file schema existed (client.ts: RelayConfig).
#[test]
fn relay_config_defaults_from_an_empty_payload() {
    let v = round_trips(RelayConfig::default());
    assert_exact_keys(&v, &["enabled"]);
    assert_eq!(v["enabled"], true);
    let from_empty: RelayConfig = serde_json::from_value(serde_json::json!({})).unwrap();
    assert!(from_empty.enabled);
}

/// Trivial result DTOs whose camelCase is a no-op today — the attribute
/// is still load-bearing the day a multi-word field lands. The TS side
/// inlines `{ path: string }` / `{ files: number }` (client.ts).
#[test]
fn pairing_path_and_gamedata_results_round_trip() {
    let v = round_trips(PairingPathResult {
        path: "replays/20260926_101114.wowsreplay".into(),
    });
    assert_exact_keys(&v, &["path"]);
    let v = round_trips(GamedataSyncResult { files: 17 });
    assert_exact_keys(&v, &["files"]);
}

/// The discovery event's snapshot wrapper (client.ts: DiscoverySnapshot).
#[test]
fn discovery_snapshot_wraps_the_host_list() {
    let v = round_trips(DiscoverySnapshot { hosts: Vec::new() });
    assert_exact_keys(&v, &["hosts"]);
}

/// Wire-critical payload: exact key set. (v1 payloads MISSING these keys
/// must keep parsing via the per-field defaults — see the test above.)
#[test]
fn pairing_status_pins_the_exact_wire_key_set() {
    let v = round_trips(PairingStatus {
        running: true,
        host: Some("192.0.2.20".into()),
        port: Some(51999),
        pin: Some("654321".into()),
        mode: Some("lan-local".into()),
        relay_online: false,
        provider: None,
        via_upstream: false,
        notice: None,
    });
    assert_exact_keys(
        &v,
        &[
            "running",
            "host",
            "port",
            "pin",
            "mode",
            "relayOnline",
            "provider",
            "viaUpstream",
            "notice",
        ],
    );
}

// ── overlay (client.ts: OverlayState / OverlayStatus) ───────────────────

/// `OverlayState` is serde-lowercase, not camelCase — the TS side spells
/// the union members "idle" | "searching" | ... exactly.
#[test]
fn overlay_state_serializes_lowercase() {
    assert_eq!(round_trips(OverlayState::Idle), "idle");
    assert_eq!(round_trips(OverlayState::Searching), "searching");
    assert_eq!(round_trips(OverlayState::Detected), "detected");
    assert_eq!(round_trips(OverlayState::Fallback), "fallback");
    assert_eq!(round_trips(OverlayState::Manual), "manual");
}

#[test]
fn overlay_status_nests_the_state_enum() {
    let v = round_trips(OverlayStatus {
        state: OverlayState::Detected,
        rows: Some(12),
        manual: false,
    });
    assert_eq!(v["state"], "detected");
    assert_eq!(v["rows"], 12);
    assert_eq!(v["manual"], false);
}

/// Wire-critical payload: exact key set (client.ts: OverlayStatus).
#[test]
fn overlay_status_pins_the_exact_wire_key_set() {
    let v = round_trips(OverlayStatus {
        state: OverlayState::Manual,
        rows: None,
        manual: true,
    });
    assert_exact_keys(&v, &["state", "rows", "manual"]);
}

// ── live arena + manual locate (client.ts: ArenaInfo / CaptureResult /
//    OverlayAnchor / Rect / ManualLocateContext / ManualLocateGuides)
//    ─────────────────────────────────────────────────────────

/// The live tempArenaInfo.json mirror of ReplayMeta (client.ts:
/// ArenaInfo). Wire-critical payload: exact key set, plus the nested
/// VehicleEntry's (the roster row the whole overlay joins against).
#[test]
fn arena_info_renames_match_group_date_time_and_map_name() {
    let arena = ArenaInfo {
        match_group: Some("ranked".into()),
        date_time: Some("20260926_202122".into()),
        map_name: Some("spaces/40_Okinawa".into()),
        scenario: Some("domination_tournament_3point".into()),
        event_type: Some("PCVO009_OP_02_02_s06_Atoll_MEDIUM_LVL".into()),
        bot_count: 3,
        scripted_unit_count: 0,
        vehicles: vec![VehicleEntry {
            id: 51_515_151,
            name: "arena-sentinel".into(),
            relation: 0,
            ship_id: 4_180_755_280_i64,
            ship_name: Some("Gearing".into()),
        }],
        raw: serde_json::json!({ "arenaSender": "sentinel" }),
    };
    let v = round_trips(arena);
    assert_exact_keys(
        &v,
        &[
            "matchGroup",
            "dateTime",
            "mapName",
            "scenario",
            "eventType",
            "botCount",
            "scriptedUnitCount",
            "vehicles",
            "raw",
        ],
    );
    let vehicle = &v["vehicles"][0];
    assert_exact_keys(vehicle, &["id", "name", "relation", "shipId", "shipName"]);
    assert_eq!(vehicle["shipId"], 4_180_755_280_i64);
}

/// `anchor` is `#[serde(default)]` WITHOUT `skip_serializing_if`: a
/// capture with no anchor ships `"anchor": null`, not a missing key —
/// the TS side types it optional-but-present. The nested OverlayAnchor
/// pins all eleven chip-alignment keys (client.ts: CaptureResult /
/// OverlayAnchor).
#[test]
fn capture_result_and_overlay_anchor_rename_every_multi_word_field() {
    let anchor = OverlayAnchor {
        game_rect: Rect {
            x: 1,
            y: 2,
            width: 1920,
            height: 1080,
        },
        overlay_rect: Rect {
            x: 3,
            y: 4,
            width: 800,
            height: 600,
        },
        roster_rect: Rect {
            x: 5,
            y: 6,
            width: 700,
            height: 500,
        },
        row_centers: vec![100, 140, 180],
        team_split: 0.5,
        table_detected: true,
        row_alive: Some(vec![true, false]),
        roster_mode: "inferred".into(),
    };
    let full = CaptureResult {
        image_base64: "aGVsbG8=".into(),
        roster_rect: Some(Rect {
            x: 11,
            y: 12,
            width: 640,
            height: 480,
        }),
        anchor: Some(anchor),
    };
    let v = round_trips(full);
    assert_exact_keys(&v, &["imageBase64", "rosterRect", "anchor"]);
    assert_exact_keys(
        &v["anchor"],
        &[
            "gameRect",
            "overlayRect",
            "rosterRect",
            "rowCenters",
            "teamSplit",
            "tableDetected",
            "rowAlive",
            "rosterMode",
        ],
    );

    let bare = CaptureResult {
        image_base64: String::new(),
        roster_rect: None,
        anchor: None,
    };
    let v = round_trips(bare);
    assert_exact_keys(&v, &["imageBase64", "rosterRect", "anchor"]);
    assert!(v["anchor"].is_null());
}

/// The picker's snap guides (client.ts: ManualLocateGuides) —
/// defaults keep absent keys parsing as empty.
#[test]
fn manual_locate_guides_renames_table_rect_row_lines_and_seam_x() {
    let v = round_trips(ManualLocateGuides {
        table_rect: Some(Rect {
            x: 21,
            y: 22,
            width: 420,
            height: 330,
        }),
        row_lines: vec![310, 350],
        seam_x: Some(430),
    });
    assert_exact_keys(&v, &["tableRect", "rowLines", "seamX"]);
}

/// Wire-critical payload: exact key set of the picker layer's
/// context (client.ts: ManualLocateContext).
#[test]
fn manual_locate_context_pins_the_exact_wire_key_set() {
    let ctx = ManualLocateContext {
        image_base64: Some("cGlja2Vy".into()),
        image_width: Some(1280),
        image_height: Some(720),
        phys_width: 2560,
        phys_height: 1440,
        captured_at_ms: Some(1_777_777_777_777),
        captured_game_rect: Some(Rect {
            x: 31,
            y: 32,
            width: 2560,
            height: 1440,
        }),
        guides: ManualLocateGuides {
            table_rect: Some(Rect {
                x: 33,
                y: 34,
                width: 510,
                height: 405,
            }),
            row_lines: vec![510, 550],
            seam_x: None,
        },
    };
    let v = round_trips(ctx);
    assert_exact_keys(
        &v,
        &[
            "imageBase64",
            "imageWidth",
            "imageHeight",
            "physWidth",
            "physHeight",
            "capturedAtMs",
            "capturedGameRect",
            "guides",
        ],
    );
    assert_eq!(v["physWidth"], 2560);
    assert!(v["guides"]["seamX"].is_null());
}

/// Single-word pixel tuple — camelCase is a no-op today; the attribute
/// still guards the rect against a future multi-word field (client.ts:
/// Rect).
#[test]
fn rect_keeps_the_four_pixel_keys() {
    let v = round_trips(Rect {
        x: 41,
        y: 42,
        width: 43,
        height: 44,
    });
    assert_exact_keys(&v, &["x", "y", "width", "height"]);
}

/// The sink-attribution event payload (client.ts: SinkAttribution):
/// pre-sink alive-row indices per side, camelCased.
#[test]
fn sink_attribution_renames_both_sides() {
    let v = round_trips(SinkAttribution {
        ally_rows: vec![2],
        enemy_rows: vec![],
    });
    assert_exact_keys(&v, &["allyRows", "enemyRows"]);
    assert_eq!(v["allyRows"][0], 2);
    assert!(v["enemyRows"].as_array().is_some_and(|a| a.is_empty()));
}

// ── replay stream (client.ts: ReplayStream — skip_serializing_if
//    cluster) ─────────────────────────────────────────────────────────────

/// The stream DTO omits every empty optional section: a minimal stream
/// serializes to `{"trajectories":[...]}` alone, and the TS side reads
/// the missing keys as absent (not null).
#[test]
fn replay_stream_omits_empty_sections() {
    let minimal = ReplayStream {
        trajectories: vec![EntityTrajectory {
            entity_id: 7,
            kind: None,
            samples: vec![PositionSample {
                time: 1.5,
                entity_id: 7,
                vehicle_id: 10513,
                x: 100.0,
                y: 0.0,
                z: -200.0,
                yaw: 1.25,
            }],
            death_time: None,
            hp_samples: Vec::new(),
            cap_samples: Vec::new(),
            cap_progress: Vec::new(),
        }],
        shell_launches: Vec::new(),
        explosions: Vec::new(),
        torpedoes: Vec::new(),
        torpedo_steers: Vec::new(),
        weapon_locks: Vec::new(),
        battle_results: None,
        version: None,
        map_name: None,
        camera: Vec::new(),
        net_stats: Vec::new(),
        leaves: std::collections::BTreeMap::new(),
        camera_modes: Vec::new(),
        diagnostics: DiagnosticCounts::default(),
        squadron_creates: Vec::new(),
        squadron_planes: Vec::new(),
        minimap_squadron_adds: Vec::new(),
        minimap_squadron_moves: Vec::new(),
        minimap_squadron_removes: Vec::new(),
        wards: Vec::new(),
        ward_removes: Vec::new(),
        shot_kills: Vec::new(),
        damage_stats: Vec::new(),
        chat_messages: Vec::new(),
        achievements: Vec::new(),
        arena_players: Vec::new(),
        weather_transitions: Vec::new(),
        weather_notifications: Vec::new(),
        self_team: None,
    };
    let v = round_trips(minimal);
    let obj = v.as_object().unwrap();
    assert_eq!(obj.len(), 1, "only trajectories survives: {v}");
    assert!(obj.contains_key("trajectories"));
    assert_eq!(obj["trajectories"][0]["samples"][0]["entityId"], 7);

    // The arena join serializes with camelCase keys and hides its own
    // empty optionals (playerId 0 / no avatar / not-self stay absent).
    let with_arena = ReplayStream {
        arena_players: vec![ArenaPlayer {
            entity_id: 7_561_151,
            team_id: 1,
            player_id: 601,
            ship_params_id: 4_076_255_216,
            max_health: 12_600,
            name: "langyo".into(),
            is_bot: false,
            avatar_id: Some(7_561_114),
            is_self: true,
        }],
        self_team: Some(1),
        ..serde_json::from_value::<ReplayStream>(serde_json::json!({
            "trajectories": []
        }))
        .unwrap()
    };
    let v = round_trips(with_arena);
    let obj = v.as_object().unwrap();
    assert_eq!(obj["selfTeam"], 1);
    let p = &obj["arenaPlayers"][0];
    assert_eq!(p["entityId"], 7_561_151);
    assert_eq!(p["teamId"], 1);
    assert_eq!(p["playerId"], 601);
    assert_eq!(p["shipParamsId"], 4_076_255_216u64);
    assert_eq!(p["maxHealth"], 12_600);
    assert_eq!(p["name"], "langyo");
    assert_eq!(p["avatarId"], 7_561_114);
    assert_eq!(p["isSelf"], true);
    assert!(!p.as_object().unwrap().contains_key("isBot"));

    // A populated stream keeps the renamed optional keys.
    let rich = ReplayStream {
        battle_results: Some(r#"{"personal":{"wins":1}}"#.into()),
        version: Some("0.14.5".into()),
        map_name: Some("40_Okinawa".into()),
        diagnostics: DiagnosticCounts {
            server_ticks: 5,
            ..Default::default()
        },
        ..serde_json::from_value::<ReplayStream>(serde_json::json!({
            "trajectories": []
        }))
        .unwrap()
    };
    let v = round_trips(rich);
    for key in [
        "trajectories",
        "battleResults",
        "version",
        "mapName",
        "diagnostics",
    ] {
        assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
    }
}

/// `EntityKind` hides its unrecovered optional fields entirely (the TS
/// side types them as optional), and defaults creation_time to -1.
#[test]
fn entity_kind_skips_unrecovered_fields() {
    let bare = EntityKind {
        entity_type: 2,
        vehicle_id: 10513,
        initial_x: 1.0,
        initial_y: 2.0,
        initial_z: 3.0,
        creation_time: 10.0,
        ship_id: None,
        radius: None,
        control_point_index: None,
        initial_team: None,
    };
    let v = round_trips(bare);
    for key in [
        "entityType",
        "vehicleId",
        "initialX",
        "initialY",
        "initialZ",
    ] {
        assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
    }
    for absent in ["shipId", "radius", "controlPointIndex", "initialTeam"] {
        assert!(
            !v.as_object().unwrap().contains_key(absent),
            "{absent} leaked"
        );
    }

    let zone = EntityKind {
        entity_type: 14,
        radius: Some(45.0),
        control_point_index: Some(1),
        initial_team: Some(-1),
        ship_id: Some(4282948544),
        ..serde_json::from_value::<EntityKind>(serde_json::json!({
            "entityType": 14,
            "vehicleId": 10513,
            "initialX": 0.0,
            "initialY": 0.0,
            "initialZ": 0.0
        }))
        .unwrap()
    };
    let v = round_trips(zone);
    assert_eq!(v["radius"], 45.0);
    assert_eq!(v["controlPointIndex"], 1);
    assert_eq!(v["initialTeam"], -1);
    assert_eq!(v["shipId"], 4_282_948_544_i64);
    // creation_time defaulted to -1 (pre-replay start), not 0.
    assert_eq!(v["creationTime"], -1.0);
}

// ── stream DTOs not fully pinned by the replay_stream test above ────────

/// The trajectory DTO itself: the three vec streams + `deathTime`
/// appear ONLY when non-empty/Some (skip_serializing_if), while `kind`
/// (a plain Option) rides as null. PositionSample / HpSample key sets
/// pinned nested (client.ts: EntityTrajectory).
#[test]
fn entity_trajectory_emits_optional_streams_only_when_present() {
    let minimal = EntityTrajectory {
        entity_id: 51,
        kind: None,
        samples: Vec::new(),
        death_time: None,
        hp_samples: Vec::new(),
        cap_samples: Vec::new(),
        cap_progress: Vec::new(),
    };
    let v = round_trips(minimal);
    assert_exact_keys(&v, &["entityId", "kind", "samples"]);
    assert!(v["kind"].is_null());

    let full = EntityTrajectory {
        entity_id: 52,
        kind: Some(EntityKind {
            entity_type: 4,
            vehicle_id: 7770,
            initial_x: 4.0,
            initial_y: 5.0,
            initial_z: 6.0,
            creation_time: 7.0,
            ship_id: None,
            radius: None,
            control_point_index: None,
            initial_team: None,
        }),
        samples: vec![PositionSample {
            time: 8.5,
            entity_id: 52,
            vehicle_id: 10513,
            x: 100.5,
            y: 0.5,
            z: -200.5,
            yaw: 2.5,
        }],
        death_time: Some(610.5),
        hp_samples: vec![HpSample {
            time: 9.5,
            value: 61_238,
        }],
        cap_samples: vec![HpSample {
            time: 10.5,
            value: 2,
        }],
        cap_progress: vec![HpSample {
            time: 11.5,
            value: 1,
        }],
    };
    let v = round_trips(full);
    assert_exact_keys(
        &v,
        &[
            "entityId",
            "kind",
            "samples",
            "deathTime",
            "hpSamples",
            "capSamples",
            "capProgress",
        ],
    );
    assert_eq!(v["deathTime"], 610.5);
    assert_exact_keys(
        &v["samples"][0],
        &["time", "entityId", "vehicleId", "x", "y", "z", "yaw"],
    );
    assert_exact_keys(&v["hpSamples"][0], &["time", "value"]);
}

/// Terminal ballistics (client.ts: ExplosionEvent / ShellLaunchEvent).
#[test]
fn explosion_and_shell_launch_events_rename_ids_and_targets() {
    let v = round_trips(ExplosionEvent {
        time: 61.5,
        x: 1.5,
        y: 2.5,
        z: 3.5,
        params_id: 425_001,
    });
    assert_exact_keys(&v, &["time", "x", "y", "z", "paramsId"]);

    let v = round_trips(ShellLaunchEvent {
        time: 62.5,
        owner_id: 63,
        params_id: 425_002,
        salvo_id: 64,
        shot_id: 65,
        x: 4.5,
        y: 5.5,
        z: 6.5,
        target_x: 7.5,
        target_y: 8.5,
        target_z: 9.5,
        server_time_left: 10.5,
        speed: 780.5,
        gun_barrel_id: 66,
    });
    assert_exact_keys(
        &v,
        &[
            "time",
            "ownerId",
            "paramsId",
            "salvoId",
            "shotId",
            "x",
            "y",
            "z",
            "targetX",
            "targetY",
            "targetZ",
            "serverTimeLeft",
            "speed",
            "gunBarrelId",
        ],
    );
}

/// Torpedo launches + homing updates (client.ts: TorpedoLaunch /
/// TorpedoSteer).
#[test]
fn torpedo_events_rename_direction_and_target_fields() {
    let v = round_trips(TorpedoLaunch {
        time: 71.5,
        owner_id: 72,
        params_id: 425_003,
        salvo_id: 73,
        shot_id: 74,
        x: 1.25,
        y: 2.25,
        z: 3.25,
        dir_x: 4.25,
        dir_y: 5.25,
        dir_z: 6.25,
        armed: true,
    });
    assert_exact_keys(
        &v,
        &[
            "time", "ownerId", "paramsId", "salvoId", "shotId", "x", "y", "z", "dirX", "dirY",
            "dirZ", "armed",
        ],
    );

    let v = round_trips(TorpedoSteer {
        time: 81.5,
        owner_id: 82,
        shot_id: 83,
        x: 1.75,
        y: 2.75,
        z: 3.75,
        target_yaw: 4.75,
    });
    assert_exact_keys(
        &v,
        &["time", "ownerId", "shotId", "x", "y", "z", "targetYaw"],
    );
}

/// Minimap squadron markers + fighter-patrol wards (client.ts:
/// MinimapSquadron* / WardEvent / WardRemoveEvent).
#[test]
fn minimap_squadron_and_ward_events_rename_composite_ids() {
    let v = round_trips(MinimapSquadronAdd {
        time: 91.5,
        plane_id: 92,
        owner_id: 93,
        team_id: 1,
        params_id: 425_004,
        x: 1.5,
        z: 2.5,
    });
    assert_exact_keys(
        &v,
        &["time", "planeId", "ownerId", "teamId", "paramsId", "x", "z"],
    );

    let v = round_trips(MinimapSquadronMove {
        time: 94.5,
        plane_id: 95,
        x: 3.5,
        z: 4.5,
    });
    assert_exact_keys(&v, &["time", "planeId", "x", "z"]);

    let v = round_trips(MinimapSquadronRemove {
        time: 96.5,
        plane_id: 97,
    });
    assert_exact_keys(&v, &["time", "planeId"]);

    let v = round_trips(WardEvent {
        time: 98.5,
        squadron_id: 99,
        owner_id: 100,
        team_id: 0,
        x: 5.5,
        y: 6.5,
        z: 7.5,
        radius: 250.5,
        ward_type: 2,
    });
    assert_exact_keys(
        &v,
        &[
            "time",
            "squadronId",
            "ownerId",
            "teamId",
            "x",
            "y",
            "z",
            "radius",
            "wardType",
        ],
    );

    let v = round_trips(WardRemoveEvent {
        time: 101.5,
        plane_id: 102,
    });
    assert_exact_keys(&v, &["time", "planeId"]);
}

/// Projectile kills + server-authoritative damage ticks (client.ts:
/// ShotKillEvent / DamageStatSample).
#[test]
fn shot_kill_and_damage_stat_events_rename_ids_and_totals() {
    let v = round_trips(ShotKillEvent {
        time: 111.5,
        owner_id: 112,
        hit_type: 3,
        shot_id: 113,
        x: 1.5,
        y: 2.5,
        z: 3.5,
    });
    assert_exact_keys(&v, &["time", "ownerId", "hitType", "shotId", "x", "y", "z"]);

    let v = round_trips(DamageStatSample {
        time: 121.5,
        weapon: 17,
        category: 0,
        count: 114,
        total: 115_000.5,
    });
    assert_exact_keys(&v, &["time", "weapon", "category", "count", "total"]);
}

/// Recorder lock / camera / netstat timelines (client.ts:
/// WeaponLockEvent / CameraSample / NetStatsSample).
#[test]
fn weapon_lock_camera_and_net_stats_samples_rename_multi_word_fields() {
    let v = round_trips(WeaponLockEvent {
        time: 131.5,
        weapon_type: 132,
        lock_type: 2,
        target_id: 133,
    });
    assert_exact_keys(&v, &["time", "weaponType", "lockType", "targetId"]);

    let v = round_trips(CameraSample {
        time: 141.5,
        rot_x: 0.25,
        rot_y: 0.5,
        rot_z: 0.75,
        rot_w: 1.0,
        x: 8.5,
        y: 9.5,
        z: 10.5,
        fov: 1.25,
    });
    assert_exact_keys(
        &v,
        &["time", "rotX", "rotY", "rotZ", "rotW", "x", "y", "z", "fov"],
    );

    let v = round_trips(NetStatsSample {
        time: 151.5,
        fps: 60,
        ping: 116,
        is_lagging: true,
    });
    assert_exact_keys(&v, &["time", "fps", "ping", "isLagging"]);
}

/// Aircraft squadron spawns + per-plane waypoints (client.ts:
/// SquadronCreate / SquadronPlane).
#[test]
fn squadron_events_rename_plane_id_and_formation_index() {
    let v = round_trips(SquadronCreate {
        time: 161.5,
        plane_id: 162,
        params_id: 425_005,
        x: 1.5,
        y: 300.5,
        z: 2.5,
    });
    assert_exact_keys(&v, &["time", "planeId", "paramsId", "x", "y", "z"]);

    let v = round_trips(SquadronPlane {
        time: 171.5,
        plane_id: 172,
        index: 3,
        x: 3.5,
        y: 301.5,
        z: 4.5,
        yaw: 5.5,
    });
    assert_exact_keys(&v, &["time", "planeId", "index", "x", "y", "z", "yaw"]);
}

/// Battle chat + achievements (client.ts: ChatEvent / AchievementEvent).
#[test]
fn chat_and_achievement_events_rename_player_and_achievement_ids() {
    let v = round_trips(ChatEvent {
        time: 181.5,
        player_id: 117,
        namespace: "battle_team".into(),
        message: "chat-sentinel".into(),
    });
    assert_exact_keys(&v, &["time", "playerId", "namespace", "message"]);

    let v = round_trips(AchievementEvent {
        time: 191.5,
        player_id: 118,
        achievement_id: 425_006,
    });
    assert_exact_keys(&v, &["time", "playerId", "achievementId"]);
}

/// The diagnostics block rides `ReplayStream` only when non-default;
/// every counter is multi-word (client.ts: DiagnosticCounts).
#[test]
fn diagnostic_counts_renames_every_counter() {
    let v = round_trips(DiagnosticCounts {
        server_ticks: 201,
        server_timestamps: 202,
        init_flags: 203,
        init_markers: 204,
        base_player_creates: 205,
        create_stubs: 206,
        entity_controls: 207,
        entity_enters: 208,
        camera_modes: 209,
        camera_freelooks: 210,
        sub_controllers: 211,
        cruise_states: 212,
        shot_trackings: 213,
        gun_markers: 214,
    });
    assert_exact_keys(
        &v,
        &[
            "serverTicks",
            "serverTimestamps",
            "initFlags",
            "initMarkers",
            "basePlayerCreates",
            "createStubs",
            "entityControls",
            "entityEnters",
            "cameraModes",
            "cameraFreelooks",
            "subControllers",
            "cruiseStates",
            "shotTrackings",
            "gunMarkers",
        ],
    );
}

// ── ship encyclopedia (client.ts: ShipInfo) ─────────────────────────────

/// `ShipInfo::type_` carries the file's ONLY explicit field rename —
/// the TS side reads `type` (a reserved word it can't spell otherwise).
#[test]
fn ship_info_renames_the_type_field() {
    let ship = ShipInfo {
        ship_id: 4282948544,
        name: "Montana".into(),
        tier: 10,
        type_: "Battleship".into(),
        nation: "usa".into(),
        is_premium: false,
        is_special: false,
        description: "One of the most powerful battleships".into(),
        game_version: "0.11.4".into(),
        default_profile: serde_json::json!({ "hull": { "health": 96300 } }),
        images: ShipImages {
            small: "s.png".into(),
            medium: "m.png".into(),
            large: "l.png".into(),
            contour: "c.png".into(),
        },
    };
    let v = round_trips(ship);
    for key in [
        "shipId",
        "type",
        "isPremium",
        "isSpecial",
        "gameVersion",
        "defaultProfile",
        "images",
    ] {
        assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
    }
    assert_eq!(v["type"], "Battleship");
    assert!(!v.as_object().unwrap().contains_key("type_"));
}

// ── snapshots (client.ts: StatsSnapshot) ────────────────────────────────

#[test]
fn stats_snapshot_renames_game_version_and_avg_damage() {
    let v = round_trips(StatsSnapshot {
        timestamp: 1_700_000_000,
        game_version: "0.11.4".into(),
        battles: 1234,
        wins: 617,
        winrate: 50.0,
        avg_damage: 61_238.5,
        pr: Some(1500),
    });
    for key in [
        "timestamp",
        "gameVersion",
        "battles",
        "wins",
        "winrate",
        "avgDamage",
        "pr",
    ] {
        assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
    }
    assert_eq!(v["gameVersion"], "0.11.4");
}

// ── encyclopedia + per-ship stats + trends (client.ts: GameVersionInfo /
//    ShipImages / PlayerShipStats / ShipModeStats / ShipServerStats /
//    ShipCareerTotals / ShipStatsHistoryPoint / Trend* / PatchNote) ────────

#[test]
fn game_version_info_renames_game_version_and_ships_total() {
    let v = round_trips(GameVersionInfo {
        game_version: "0.14.5".into(),
        ships_total: 615,
        timestamp: 1_777_777_779,
    });
    assert_exact_keys(&v, &["gameVersion", "shipsTotal", "timestamp"]);
}

/// The four WG CDN size keys — single words today, pinned so a fifth
/// size can't appear without the TS mirror learning it (client.ts:
/// ShipImages).
#[test]
fn ship_images_keeps_the_four_size_keys() {
    let v = round_trips(ShipImages {
        small: "img-small.png".into(),
        medium: "img-medium.png".into(),
        large: "img-large.png".into(),
        contour: "img-contour.png".into(),
    });
    assert_exact_keys(&v, &["small", "medium", "large", "contour"]);
}

/// Per-ship table row + its mode breakdown. The breakdown's five mode
/// keys are always present (defaults don't skip): an unplayed mode
/// rides as null, not as a missing key (client.ts: PlayerShipStats /
/// ShipModeStats / ShipModeBreakdown).
#[test]
fn player_ship_stats_renames_damage_survival_and_mode_fields() {
    let stats = PlayerShipStats {
        ship_id: 4_180_755_280_i64,
        name: "Gearing".into(),
        battles: 221,
        wins: 122,
        damage_caused: 9_876_543,
        frags: 231,
        survived_battles: 124,
        winrate: 55.25,
        avg_damage: 44_777.5,
        last_battle_time: 1_777_777_780,
        pr: Some(2_450),
        avg_xp: Some(1_515.5),
        modes: Some(ShipModeBreakdown {
            solo: Some(ShipModeStats {
                battles: 222,
                wins: 123,
                damage_caused: 9_876_544,
                frags: 232,
                survived_battles: 125,
                winrate: 55.5,
                avg_damage: 44_778.5,
            }),
            div2: None,
            div3: None,
            coop: None,
            ranked: None,
        }),
    };
    let v = round_trips(stats);
    assert_exact_keys(
        &v,
        &[
            "shipId",
            "name",
            "battles",
            "wins",
            "damageCaused",
            "frags",
            "survivedBattles",
            "winrate",
            "avgDamage",
            "lastBattleTime",
            "pr",
            "avgXp",
            "modes",
        ],
    );
    assert_exact_keys(&v["modes"], &["solo", "div2", "div3", "coop", "ranked"]);
    assert!(v["modes"]["div2"].is_null());
    assert_exact_keys(
        &v["modes"]["solo"],
        &[
            "battles",
            "wins",
            "damageCaused",
            "frags",
            "survivedBattles",
            "winrate",
            "avgDamage",
        ],
    );
}

/// The ship-history file format (ship-history/<realm>_<accountId>.json
/// points — client.ts: ShipCareerTotals / ShipStatsHistoryPoint).
#[test]
fn ship_career_totals_and_history_point_rename_totals() {
    let v = round_trips(ShipCareerTotals {
        ship_id: 4_279_574_672_i64,
        battles: 241,
        wins: 124,
        damage_caused: 8_765_432,
        frags: 242,
        survived_battles: 125,
        last_battle_time: 1_777_777_781,
    });
    assert_exact_keys(
        &v,
        &[
            "shipId",
            "battles",
            "wins",
            "damageCaused",
            "frags",
            "survivedBattles",
            "lastBattleTime",
        ],
    );

    let v = round_trips(ShipStatsHistoryPoint {
        timestamp: 1_777_777_782,
        ships: Vec::new(),
    });
    assert_exact_keys(&v, &["timestamp", "ships"]);
}

#[test]
fn trend_bucket_renames_winrate_extremes_and_snapshot_count() {
    let v = round_trips(TrendBucket {
        version: "0.14.5".into(),
        start_time: 1_777_777_783,
        end_time: 1_777_777_784,
        snapshot_count: 251,
        battle_delta: 252,
        winrate_avg: 52.25,
        winrate_min: 48.5,
        winrate_max: 55.75,
        avg_damage: 88_888.5,
        pr_avg: Some(2_551),
    });
    assert_exact_keys(
        &v,
        &[
            "version",
            "startTime",
            "endTime",
            "snapshotCount",
            "battleDelta",
            "winrateAvg",
            "winrateMin",
            "winrateMax",
            "avgDamage",
            "prAvg",
        ],
    );
}

/// Career trend + its hand-maintained patch annotations (client.ts:
/// TrendResult / PatchNote).
#[test]
fn trend_result_and_patch_note_rename_ids_and_dates() {
    let v = round_trips(TrendResult {
        account_id: 525_252_525,
        realm: "na".into(),
        buckets: Vec::new(),
        patches: vec![PatchNote {
            version: "0.14.5".into(),
            date: "2026-09-26".into(),
            ship_ids: vec![4_279_574_672_i64],
            summary: "patch-sentinel".into(),
            changes: vec!["change-sentinel".into()],
        }],
    });
    assert_exact_keys(&v, &["accountId", "realm", "buckets", "patches"]);
    assert_exact_keys(
        &v["patches"][0],
        &["version", "date", "shipIds", "summary", "changes"],
    );
}

#[test]
fn community_trend_renames_ship_id() {
    let v = round_trips(CommunityTrend {
        available: true,
        ship_id: 4_279_574_672_i64,
        buckets: Vec::new(),
    });
    assert_exact_keys(&v, &["available", "shipId", "buckets"]);
}

/// The "server average" report (client.ts: ShipServerStats).
#[test]
fn ship_server_stats_renames_generated_at_and_from_cache() {
    let v = round_trips(ShipServerStats {
        ship_id: 4_279_574_672_i64,
        avg_damage: 95_252.5,
        avg_frags: 1.25,
        winrate: 50.75,
        generated_at: 1_777_777_785,
        from_cache: true,
    });
    assert_exact_keys(
        &v,
        &[
            "shipId",
            "avgDamage",
            "avgFrags",
            "winrate",
            "generatedAt",
            "fromCache",
        ],
    );
}

// ── WG player & clan stats (client.ts: DogTag / PlayerStats /
//    PlayerSuggestion / PlayerComposition / ClanSuggestion /
//    ClanMemberStats / ClanMember / ClanInfo) ──────────────────────────────

#[test]
fn dog_tag_renames_texture_symbol_and_color_ids() {
    let v = round_trips(DogTag {
        texture_id: 425_101,
        symbol_id: 425_102,
        border_color: 1_111_111_111,
        background_color: 2_222_222_222,
        background_id: 425_103,
    });
    assert_exact_keys(
        &v,
        &[
            "textureId",
            "symbolId",
            "borderColor",
            "backgroundColor",
            "backgroundId",
        ],
    );
}

/// Wire-critical payload: exact key set of the player card's data —
/// 33 keys, every multi-word one renamed (client.ts: PlayerStats).
#[test]
fn player_stats_renames_every_deep_stat_field() {
    let stats = PlayerStats {
        account_id: 53_155_353,
        name: "player-sentinel".into(),
        realm: "eu".into(),
        battles: Some(12_345),
        winrate: Some(51.25),
        hidden: false,
        clan_tag: Some("[SENT]".into()),
        clan_id: Some(500_005_001),
        avg_damage: Some(81_234.5),
        avg_xp: Some(1_234.5),
        kd_ratio: Some(2.25),
        survival_rate: Some(33.75),
        hit_rate: Some(28.5),
        pr: Some(2_450),
        ships_played: Some(87),
        leveling_tier: Some(42),
        leveling_points: Some(987_654),
        dog_tag: Some(DogTag {
            texture_id: 1,
            symbol_id: 2,
            border_color: 3,
            background_color: 4,
            background_id: 5,
        }),
        solo_wr: Some(48.5),
        div2_wr: Some(52.25),
        div3_wr: Some(56.75),
        solo_battles: Some(9_001),
        div2_battles: Some(9_002),
        div3_battles: Some(9_003),
        ranked_battles: Some(1_234),
        ranked_winrate: Some(54.5),
        ranked_avg_damage: Some(77_777.0),
        ranked_pr: Some(1_890),
        global_battles: Some(13_579),
        global_winrate: Some(51.5),
        global_avg_damage: Some(80_922.0),
        global_pr: Some(2_390),
        last_battle_time: Some(1_760_100_000),
    };
    let v = round_trips(stats);
    assert_exact_keys(
        &v,
        &[
            "accountId",
            "name",
            "realm",
            "battles",
            "winrate",
            "hidden",
            "clanTag",
            "clanId",
            "avgDamage",
            "avgXp",
            "kdRatio",
            "survivalRate",
            "hitRate",
            "pr",
            "shipsPlayed",
            "levelingTier",
            "levelingPoints",
            "dogTag",
            "soloWr",
            "div2Wr",
            "div3Wr",
            "soloBattles",
            "div2Battles",
            "div3Battles",
            "rankedBattles",
            "rankedWinrate",
            "rankedAvgDamage",
            "rankedPr",
            "globalBattles",
            "globalWinrate",
            "globalAvgDamage",
            "globalPr",
            "lastBattleTime",
        ],
    );
    assert_eq!(v["clanTag"], "[SENT]");
    assert_eq!(v["div2Wr"], 52.25);
    assert_eq!(v["rankedPr"], 1_890);
    assert_eq!(v["globalBattles"], 13_579);
    assert_eq!(v["lastBattleTime"], 1_760_100_000);
}

/// Lookup sidebar autocomplete + the Tab-overlay seal verdicts
/// (client.ts: PlayerSuggestion / PlayerComposition).
#[test]
fn player_suggestion_and_composition_rename_account_id() {
    let v = round_trips(PlayerSuggestion {
        account_id: 53_155_354,
        nickname: "suggest-sentinel".into(),
    });
    assert_exact_keys(&v, &["accountId", "nickname"]);

    let v = round_trips(PlayerComposition {
        air: true,
        sub: false,
    });
    assert_exact_keys(&v, &["air", "sub"]);
}

#[test]
fn clan_suggestion_renames_clan_id_and_members_count() {
    let v = round_trips(ClanSuggestion {
        clan_id: 500_005_002,
        tag: "[CLAN]".into(),
        name: "clan-sentinel".into(),
        members_count: Some(30),
    });
    assert_exact_keys(&v, &["clanId", "tag", "name", "membersCount"]);
}

#[test]
fn clan_member_stats_renames_every_deep_stat_field() {
    let v = round_trips(ClanMemberStats {
        battles: Some(23_456),
        wins: Some(11_234),
        winrate: Some(47.75),
        avg_damage: Some(61_238.5),
        pr: Some(1_501),
        avg_xp: Some(1_100.5),
        kd_ratio: Some(1.25),
        survival_rate: Some(40.25),
        hidden: false,
    });
    assert_exact_keys(
        &v,
        &[
            "battles",
            "wins",
            "winrate",
            "avgDamage",
            "pr",
            "avgXp",
            "kdRatio",
            "survivalRate",
            "hidden",
        ],
    );
}

/// A roster row; the nested stats block rides hidden-profile members as
/// all-null keys, never missing keys (client.ts: ClanMember).
#[test]
fn clan_member_renames_account_id_joined_at_and_stats() {
    let member = ClanMember {
        account_id: 53_155_355,
        name: "member-sentinel".into(),
        role: "executive_officer".into(),
        joined_at: Some(1_777_777_786),
        stats: ClanMemberStats::default(),
    };
    let v = round_trips(member);
    assert_exact_keys(&v, &["accountId", "name", "role", "joinedAt", "stats"]);
    assert_exact_keys(
        &v["stats"],
        &[
            "battles",
            "wins",
            "winrate",
            "avgDamage",
            "pr",
            "avgXp",
            "kdRatio",
            "survivalRate",
            "hidden",
        ],
    );
}

#[test]
fn clan_info_renames_totals_and_hidden_count() {
    let clan = ClanInfo {
        clan_id: 500_005_003,
        tag: "[INFO]".into(),
        name: "info-sentinel".into(),
        realm: "asia".into(),
        description: Some("clan-description-sentinel".into()),
        members_count: 2,
        created_at: Some(1_600_000_000),
        members: vec![ClanMember {
            account_id: 53_155_356,
            name: "member-two".into(),
            role: "private".into(),
            joined_at: None,
            stats: ClanMemberStats {
                battles: Some(1_000),
                wins: Some(500),
                winrate: Some(50.0),
                avg_damage: Some(50_000.5),
                pr: Some(1_350),
                avg_xp: Some(1_200.5),
                kd_ratio: Some(1.5),
                survival_rate: Some(45.5),
                hidden: false,
            },
        }],
        total_battles: 1_000,
        total_wins: 500,
        winrate: 50.0,
        avg_damage: 50_000.5,
        avg_pr: Some(1_350),
        hidden_count: 1,
    };
    let v = round_trips(clan);
    assert_exact_keys(
        &v,
        &[
            "clanId",
            "tag",
            "name",
            "realm",
            "description",
            "membersCount",
            "createdAt",
            "members",
            "totalBattles",
            "totalWins",
            "winrate",
            "avgDamage",
            "avgPr",
            "hiddenCount",
        ],
    );
}

// ── mod hub (client.ts: ModKind / InstalledMod / CatalogProgress) ───────

/// `ModKind` mirrors the TS union "voice" | "skin" | ... — single-word
/// variants under camelCase collapse to lowercase.
#[test]
fn mod_kind_serializes_to_the_ts_union_members() {
    assert_eq!(round_trips(ModKind::Voice), "voice");
    assert_eq!(round_trips(ModKind::Skin), "skin");
    assert_eq!(round_trips(ModKind::Script), "script");
    assert_eq!(round_trips(ModKind::Textures), "textures");
    assert_eq!(round_trips(ModKind::Gui), "gui");
    assert_eq!(round_trips(ModKind::Patch), "patch");
}

#[test]
fn installed_mod_skips_texture_analysis_when_absent() {
    let plain = InstalledMod {
        kind: ModKind::Skin,
        name: "Yamato camo".into(),
        detail: Some("PJSB001".into()),
        texture_analysis: None,
        rel_path: "PnFMods/PJSB001".into(),
        paths: vec!["PnFMods/PJSB001".into()],
        disabled: false,
        version: None,
        warnings: Vec::new(),
    };
    let v = round_trips(plain.clone());
    assert!(!v.as_object().unwrap().contains_key("textureAnalysis"));
    // Empty warnings stay off the wire (older payloads have no such
    // field and still deserialize).
    assert!(!v.as_object().unwrap().contains_key("warnings"));
    let legacy = serde_json::json!({
        "kind": "skin",
        "name": "old",
        "detail": null,
        "relPath": "x",
        "paths": [],
        "disabled": false,
        "version": null
    });
    let back: InstalledMod = serde_json::from_value(legacy).unwrap();
    assert!(back.warnings.is_empty());
    let mut warned = plain.clone();
    warned.warnings.push("conflict".into());
    assert_eq!(round_trips(warned)["warnings"][0], "conflict");
    assert_eq!(v["relPath"], "PnFMods/PJSB001");
    assert_eq!(v["kind"], "skin");

    let textured = InstalledMod {
        texture_analysis: Some(TextureAnalysis {
            file_count: 12,
            file_kinds: vec![TextureFileKind {
                ext: "dds".into(),
                count: 9,
            }],
            categories: vec!["camouflage".into()],
            nations: Vec::new(),
            species: Vec::new(),
            ships: Vec::new(),
            space_names: Vec::new(),
            truncated: false,
        }),
        ..plain
    };
    let v = round_trips(textured);
    assert!(v.as_object().unwrap().contains_key("textureAnalysis"));
    assert_eq!(v["textureAnalysis"]["fileKinds"][0]["ext"], "dds");
}

/// Full breakdown key set — the nested assert above only spot-checks
/// `fileKinds[0].ext` (client.ts: TextureAnalysis / TextureFileKind).
#[test]
fn texture_analysis_renames_every_breakdown_key() {
    let v = round_trips(TextureAnalysis {
        file_count: 261,
        file_kinds: vec![TextureFileKind {
            ext: "mfm".into(),
            count: 262,
        }],
        categories: vec!["spaces".into()],
        nations: vec!["japan".into()],
        species: vec!["battleship".into()],
        ships: vec!["JSB039 Yamato 1945".into()],
        space_names: vec!["20_SO_second_test".into()],
        truncated: true,
    });
    assert_exact_keys(
        &v,
        &[
            "fileCount",
            "fileKinds",
            "categories",
            "nations",
            "species",
            "ships",
            "spaceNames",
            "truncated",
        ],
    );
    assert_exact_keys(&v["fileKinds"][0], &["ext", "count"]);
}

/// Result of an enable/disable toggle (client.ts: UnitToggleReport).
#[test]
fn unit_toggle_report_renames_rel_path_and_renamed_files() {
    let v = round_trips(UnitToggleReport {
        rel_path: "PnFMods/PJSB018".into(),
        disabled: true,
        renamed_files: 271,
    });
    assert_exact_keys(&v, &["relPath", "disabled", "renamedFiles"]);
}

/// Install plan preview + its copy list (client.ts: PackagePlanEntry /
/// PackagePlan). `textureAnalysis` is skipped when absent, present when
/// set — same rule as InstalledMod's.
#[test]
fn package_plan_and_entries_rename_relative_paths() {
    let entry = PackagePlanEntry {
        from_rel: "PnFMods/PJSB018".into(),
        to_rel: "res_mods/0.14.5/PnFMods/PJSB018".into(),
    };
    let v = round_trips(entry.clone());
    assert_exact_keys(&v, &["fromRel", "toRel"]);

    let plan = PackagePlan {
        kind: ModKind::Voice,
        name: "voice-sentinel".into(),
        detail: Some("banks/sentinel".into()),
        entries: vec![entry],
        warnings: vec!["overwrite".into()],
        texture_analysis: None,
    };
    let v = round_trips(plan.clone());
    assert_exact_keys(&v, &["kind", "name", "detail", "entries", "warnings"]);

    let textured = PackagePlan {
        texture_analysis: Some(TextureAnalysis {
            file_count: 281,
            file_kinds: Vec::new(),
            categories: Vec::new(),
            nations: Vec::new(),
            species: Vec::new(),
            ships: Vec::new(),
            space_names: Vec::new(),
            truncated: false,
        }),
        ..plan
    };
    let v = round_trips(textured);
    assert_exact_keys(
        &v,
        &[
            "kind",
            "name",
            "detail",
            "entries",
            "warnings",
            "textureAnalysis",
        ],
    );
}

/// Post-install report (client.ts: InstallReport).
#[test]
fn install_report_renames_bin_version_and_wrote_files() {
    let v = round_trips(InstallReport {
        name: "install-sentinel".into(),
        bin_version: "0.14.5".into(),
        wrote_files: 291,
        warnings: Vec::new(),
        conflicts: Vec::new(),
    });
    assert_exact_keys(&v, &["name", "binVersion", "wroteFiles", "warnings"]);
    // A report from a pre-conflicts build (no such field) still
    // deserializes — the field defaults to empty.
    let legacy = serde_json::json!({
        "name": "old",
        "binVersion": "1",
        "wroteFiles": 1,
        "warnings": []
    });
    let back: InstallReport = serde_json::from_value(legacy).unwrap();
    assert_eq!(back.name, "old");
    assert!(back.conflicts.is_empty());
    // Non-empty conflicts serialize under the camelCase name.
    let v = round_trips(InstallReport {
        name: "x".into(),
        bin_version: "1".into(),
        wrote_files: 1,
        warnings: Vec::new(),
        conflicts: vec!["overwrites 2 file(s)".into()],
    });
    assert_eq!(v["conflicts"][0], "overwrites 2 file(s)");
}

#[test]
fn catalog_progress_renames_the_package_pair() {
    let v = round_trips(CatalogProgress {
        id: "aslain".into(),
        phase: "downloading".into(),
        package: 1,
        packages: 3,
        received: 2048,
        total: 8192,
    });
    for key in ["id", "phase", "package", "packages", "received", "total"] {
        assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
    }
    assert_eq!(v["package"], 1);
    assert_eq!(v["packages"], 3);
}

/// Migration wizard plan (client.ts: MigrationPlan / PlanFile). `identity`
/// is absent while the backend leaves it unresolved (the webui does the
/// catalog matching).
#[test]
fn migration_plan_renames_versions_and_buckets() {
    let file = PlanFile {
        path: "gui/penetration.png".into(),
        size: 4_096,
        identity: None,
    };
    let v = round_trips(file);
    assert_exact_keys(&v, &["path", "size"]);

    let plan = MigrationPlan {
        from_version: "1".into(),
        to_version: "2".into(),
        duplicate: vec![PlanFile {
            path: "PnFModsLoader.py".into(),
            size: 0,
            identity: None,
        }],
        superseded: vec![],
        decide: vec![PlanFile {
            path: "gui/a.png".into(),
            size: 12,
            identity: Some("Penetration Calculator".into()),
        }],
    };
    let v = round_trips(plan);
    assert_exact_keys(
        &v,
        &[
            "fromVersion",
            "toVersion",
            "duplicate",
            "superseded",
            "decide",
        ],
    );
    assert_exact_keys(&v["decide"][0], &["path", "size", "identity"]);
}

/// Migration wizard report (client.ts: MigrateReport) — camelCase wire
/// keys with the additive `ignoredFiles` (absent payloads default to 0).
#[test]
fn migrate_report_renames_and_defaults_ignored_files() {
    let report = MigrateReport {
        from_version: "1".into(),
        to_version: "2".into(),
        moved_files: 3,
        skipped_files: 4,
        ignored_files: 5,
    };
    let v = round_trips(report);
    assert_exact_keys(
        &v,
        &[
            "fromVersion",
            "toVersion",
            "movedFiles",
            "skippedFiles",
            "ignoredFiles",
        ],
    );
    assert_eq!(v["ignoredFiles"], 5);

    let old = serde_json::from_str::<MigrateReport>(
        r#"{"fromVersion":"1","toVersion":"2","movedFiles":3,"skippedFiles":4}"#,
    )
    .unwrap();
    assert_eq!(old.ignored_files, 0);
}

/// The catalog's hash field must stay `sha256` — camelCase must not
/// touch the digits (client.ts: CatalogPackage).
#[test]
fn catalog_package_keeps_the_sha256_key() {
    let v = round_trips(CatalogPackage {
        url: "https://github.com/releases/pkg.zip".into(),
        sha256: "deadbeef".repeat(16),
        size: 3_011,
        name: "pkg-sentinel.zip".into(),
    });
    assert_exact_keys(&v, &["url", "sha256", "size", "name"]);
}

/// The hand-written index entries say `desc`; the wire and the TS
/// mirror say `description` — the alias bridges exactly one way
/// (client.ts: CatalogEntryI18n).
#[test]
fn catalog_entry_i18n_accepts_the_desc_alias() {
    let v = round_trips(CatalogEntryI18n {
        name: "name-sentinel".into(),
        description: "desc-sentinel".into(),
    });
    assert_exact_keys(&v, &["name", "description"]);

    let from_index: CatalogEntryI18n =
        serde_json::from_value(serde_json::json!({ "desc": "alias-sentinel" }))
            .expect("desc alias parses");
    assert_eq!(from_index.description, "alias-sentinel");
    // Both fields default: an empty locale block parses to empty strings.
    assert!(serde_json::from_value::<CatalogEntryI18n>(serde_json::json!({})).is_ok());
}

/// Wire-critical payload: exact key set of one `mod-index.json` entry
/// (client.ts: CatalogEntry).
#[test]
fn catalog_entry_renames_localized_names_and_pins_the_key_set() {
    let entry = CatalogEntry {
        id: "sentinel-mod".into(),
        category: "minimap".into(),
        discussion: Some(3_021),
        version: "15.7.0".into(),
        game: ">=15.7 <15.8".into(),
        bundled: false,
        delisted: false,
        presets: Vec::new(),
        tags: Vec::new(),
        title: "title-sentinel".into(),
        name_zh: "name-zh-sentinel".into(),
        name_en: "name-en-sentinel".into(),
        description: "description-sentinel".into(),
        author_url: "https://example.example/author".into(),
        packages: vec![CatalogPackage {
            url: "https://github.com/releases/pkg2.zip".into(),
            sha256: "ab".repeat(32),
            size: 3_022,
            name: "pkg2-sentinel.zip".into(),
        }],
        i18n: [(
            "zh-CN".to_string(),
            CatalogEntryI18n {
                name: "zh-name".into(),
                description: "zh-desc".into(),
            },
        )]
        .into_iter()
        .collect(),
    };
    let v = round_trips(entry);
    assert_exact_keys(
        &v,
        &[
            "id",
            "category",
            "discussion",
            "version",
            "game",
            "bundled",
            "delisted",
            "presets",
            "tags",
            "title",
            "nameZh",
            "nameEn",
            "description",
            "authorUrl",
            "packages",
            "i18n",
        ],
    );
    assert_eq!(v["i18n"]["zh-CN"]["name"], "zh-name");
}

#[test]
fn catalog_index_renames_source_version_game_version_and_fetched_at() {
    let v = round_trips(CatalogIndex {
        source_version: "v.15.7.0 #10 (2026.08.30)".into(),
        game_version: "15.7.0".into(),
        fetched_at: "2026-09-26T00:00:00Z".into(),
        mods: Vec::new(),
    });
    assert_exact_keys(&v, &["sourceVersion", "gameVersion", "fetchedAt", "mods"]);
}

/// The uninstall/migration ledger record (mods/installed.json;
/// client.ts: ModInstallRecord).
#[test]
fn mod_install_record_renames_bin_version_installed_at_and_restore_dir() {
    let v = round_trips(ModInstallRecord {
        id: "record-sentinel".into(),
        name: "record-name".into(),
        version: "15.7.0".into(),
        category: "battle".into(),
        source: "mod-hub".into(),
        discussion: Some(3_031),
        preset: Some("sasagcy".into()),
        bin_version: "0.15.7".into(),
        installed_at: "2026-09-26T12:00:00Z".into(),
        files: vec!["res_mods/0.15.7/gui/unbound/main.xml".into()],
        restore_dir: Some("backups/record-sentinel".into()),
        game_root: "D:/Games/WoWs".into(),
    });
    assert_exact_keys(
        &v,
        &[
            "id",
            "name",
            "version",
            "category",
            "source",
            "discussion",
            "preset",
            "binVersion",
            "installedAt",
            "files",
            "restoreDir",
            "gameRoot",
        ],
    );
}

// ── resource pack (client.ts: ResStatus / ResUpdate / ResProgress) ──────

#[test]
fn res_status_renames_tree_sha256_and_size_bytes() {
    let v = round_trips(ResStatus {
        present: true,
        tree_sha256: Some("abc123def456".into()),
        version: Some("2026-01-01T00:00:00Z".into()),
        legacy_stamp: false,
        size_bytes: 123_456_789,
        downloading: false,
        bundled: false,
    });
    for key in [
        "present",
        "treeSha256",
        "version",
        "legacyStamp",
        "sizeBytes",
        "downloading",
        "bundled",
    ] {
        assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
    }
    assert_eq!(v["treeSha256"], "abc123def456");
}

/// `ResUpdate` is the manifest-LOOKUP-ERROR DTO: an unreachable manifest
/// serializes as explicit nulls (`latestTreeSha256`/`deltaSteps`), which
/// the TS side types `?: ... | null` — null must stay on the wire.
#[test]
fn res_update_keeps_nulls_for_a_failed_lookup() {
    let failed = ResUpdate {
        latest_tree_sha256: None,
        latest_version: None,
        update_available: false,
        delta_steps: None,
    };
    let v = round_trips(failed);
    // The keys must be PRESENT and null — a dropped field would also
    // index as Null, so pin the key set explicitly.
    for key in [
        "latestTreeSha256",
        "latestVersion",
        "updateAvailable",
        "deltaSteps",
    ] {
        assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
    }
    assert!(v["latestTreeSha256"].is_null());
    assert!(v["latestVersion"].is_null());
    assert!(v["deltaSteps"].is_null());

    let ok = ResUpdate {
        latest_tree_sha256: Some("abc123".into()),
        latest_version: Some("2026-01-01T00:00:00Z".into()),
        update_available: true,
        delta_steps: Some(vec![ResDeltaStep {
            from: "abc123".into(),
            to: "def456".into(),
            url: "https://github.com/.../wowsp-res-delta.tar.gz".into(),
            size: 1024,
        }]),
    };
    let v = round_trips(ok);
    assert_eq!(v["latestTreeSha256"], "abc123");
    assert_eq!(v["deltaSteps"][0]["from"], "abc123");
    assert_eq!(v["deltaSteps"][0]["to"], "def456");
}

#[test]
fn res_progress_renames_the_segment_pair() {
    let v = round_trips(ResProgress {
        phase: "error".into(),
        received: 512,
        total: 0,
        segment: 2,
        segments: 4,
        error: Some("download failed".into()),
    });
    for key in ["phase", "received", "total", "segment", "segments", "error"] {
        assert!(v.as_object().unwrap().contains_key(key), "missing {key}");
    }
    assert_eq!(v["segments"], 4);
    assert_eq!(v["error"], "download failed");
}

/// Wire-critical payload: exact key set (the test above only lists
/// contains_key entries — additive drift must fail here).
#[test]
fn res_status_pins_the_exact_wire_key_set() {
    let v = round_trips(ResStatus {
        present: true,
        tree_sha256: Some("feedface".into()),
        version: Some("2026-09-26T00:00:00Z".into()),
        legacy_stamp: true,
        size_bytes: 3_041,
        downloading: false,
        bundled: true,
    });
    assert_exact_keys(
        &v,
        &[
            "present",
            "treeSha256",
            "version",
            "legacyStamp",
            "sizeBytes",
            "downloading",
            "bundled",
        ],
    );
}

/// One clearable cache directory row (client.ts: AuxCacheStatus).
#[test]
fn aux_cache_status_renames_size_bytes() {
    let v = round_trips(AuxCacheStatus {
        scope: "encyclopedia".into(),
        size_bytes: 3_051,
    });
    assert_exact_keys(&v, &["scope", "sizeBytes"]);
}

// ── playtime (client.ts: PlaytimeSource / PlaytimeDay / PlaytimeLaunch /
//    PlaytimeOverview) ─────────────────────────────────────────────────────

/// `PlaytimeSource` mirrors the TS union "local" | "steam" — lowercase, not
/// camelCase (a multi-word variant would drift).
#[test]
fn playtime_source_serializes_to_the_ts_union_members() {
    assert_eq!(round_trips(PlaytimeSource::Local), "local");
    assert_eq!(round_trips(PlaytimeSource::Steam), "steam");
}

#[test]
fn playtime_day_and_launch_rename_their_fields() {
    let v = round_trips(PlaytimeDay {
        date: "2026-10-05".into(),
        seconds: 594,
    });
    assert_exact_keys(&v, &["date", "seconds"]);

    let v = round_trips(PlaytimeLaunch {
        start: 1_791_234_000,
        duration_seconds: 594,
        running: true,
    });
    assert_exact_keys(&v, &["start", "durationSeconds", "running"]);
    assert_eq!(v["durationSeconds"], 594);
}

/// Wire-critical payload: the overview is THE playtime command's response —
/// pin the exact key set so an additive field fails until the TS mirror
/// learns it (client.ts: PlaytimeOverview).
#[test]
fn playtime_overview_pins_the_exact_wire_key_set() {
    let v = round_trips(PlaytimeOverview {
        source: PlaytimeSource::Steam,
        imported_total_seconds: 1_023_840,
        imported_at: Some(1_791_000_000),
        local_total_seconds: 594,
        total_seconds: 1_024_434,
        launch_count: 7,
        days_played: 5,
        first_tracked_day: Some("2026-10-01".into()),
        longest_streak_days: 3,
        longest_streak_start: Some("2026-10-01".into()),
        longest_streak_end: Some("2026-10-03".into()),
        longest_session_seconds: 300,
        longest_session_date: Some("2026-10-02".into()),
        longest_day_seconds: 420,
        longest_day_date: Some("2026-10-03".into()),
        last_launch: Some(PlaytimeLaunch {
            start: 1_791_234_000,
            duration_seconds: 594,
            running: false,
        }),
        daily: vec![PlaytimeDay {
            date: "2026-10-01".into(),
            seconds: 180,
        }],
    });
    assert_exact_keys(
        &v,
        &[
            "source",
            "importedTotalSeconds",
            "importedAt",
            "localTotalSeconds",
            "totalSeconds",
            "launchCount",
            "daysPlayed",
            "firstTrackedDay",
            "longestStreakDays",
            "longestStreakStart",
            "longestStreakEnd",
            "longestSessionSeconds",
            "longestSessionDate",
            "longestDaySeconds",
            "longestDayDate",
            "lastLaunch",
            "daily",
        ],
    );
    assert_eq!(v["source"], "steam");
    assert_eq!(v["lastLaunch"]["durationSeconds"], 594);
    assert_eq!(v["daily"][0]["date"], "2026-10-01");

    // A fresh local install answers all-zero fields with nulls, not
    // missing keys — the TS side types them optional-but-present.
    let fresh = round_trips(PlaytimeOverview {
        source: PlaytimeSource::Local,
        imported_total_seconds: 0,
        imported_at: None,
        local_total_seconds: 0,
        total_seconds: 0,
        launch_count: 0,
        days_played: 0,
        first_tracked_day: None,
        longest_streak_days: 0,
        longest_streak_start: None,
        longest_streak_end: None,
        longest_session_seconds: 0,
        longest_session_date: None,
        longest_day_seconds: 0,
        longest_day_date: None,
        last_launch: None,
        daily: Vec::new(),
    });
    assert!(fresh["lastLaunch"].is_null());
    assert!(fresh["importedAt"].is_null());
}
