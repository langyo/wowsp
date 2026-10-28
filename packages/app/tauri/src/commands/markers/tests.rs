//! Unit suite for the local marker store: upsert semantics, unicode
//! nickname equality, persistence roundtrip, the garbage-file heal, the
//! batch-import upsert and the ApeRadar WatchList.json parser.

use wowsp_tauri_shared::{
    ApeRadarWatchList, MarkerColor, MarkerEntry, MarkerImportItem, MarkerImportResult,
};

use super::aperadar::parse_watchlist;
use super::store::{load_markers_from, same_nickname, store_markers, upsert_import};

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "wowsp-test-markers-{tag}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn entry(nickname: &str, color: MarkerColor) -> MarkerEntry {
    MarkerEntry {
        nickname: nickname.to_string(),
        color,
        note: None,
        account_id: None,
        created_at: 1,
    }
}

#[test]
fn nickname_equality_is_unicode_and_case_insensitive() {
    assert!(same_nickname(" Laneigedc ", "laneigedc"));
    assert!(same_nickname("长城", "长城"));
    assert!(!same_nickname("长城", "长城号"));
    assert!(!same_nickname("abc", "abd"));
}

#[test]
fn list_roundtrips_through_disk() {
    let dir = temp_dir("roundtrip");
    let markers = vec![
        entry("Laneigedc", MarkerColor::Red),
        entry("Somebody", MarkerColor::Purple),
    ];
    assert!(load_markers_from(&dir).is_empty());
    store_markers(&dir, &markers).unwrap();
    assert_eq!(load_markers_from(&dir), markers);
}

#[test]
fn garbage_file_heals_to_empty() {
    let dir = temp_dir("garbage");
    std::fs::write(dir.join("markers.json"), "not json {{{").unwrap();
    assert!(load_markers_from(&dir).is_empty());
}

fn item(nickname: &str, color: MarkerColor, account_id: Option<i64>) -> MarkerImportItem {
    MarkerImportItem {
        nickname: nickname.to_string(),
        color,
        note: None,
        account_id,
    }
}

#[test]
fn import_upserts_adds_updates_and_skips() {
    let mut markers = vec![MarkerEntry {
        nickname: "KeepMe".into(),
        color: MarkerColor::Red,
        note: Some("old".into()),
        account_id: None,
        created_at: 1,
    }];
    // Same nickname (case/space-insensitive) updates in place, the
    // arriving account id replaces the blank; a new nickname appends;
    // a whitespace-only nickname skips and counts.
    let (added, updated, skipped) = upsert_import(
        &mut markers,
        vec![
            item("  keepme ", MarkerColor::Yellow, Some(42)),
            item("Newbie", MarkerColor::Red, None),
            item("   ", MarkerColor::Purple, None),
        ],
    );
    assert_eq!((added, updated, skipped), (1, 1, 1));
    assert_eq!(markers.len(), 2);
    let kept = &markers[0];
    assert_eq!(kept.nickname, "KeepMe");
    assert_eq!(kept.color, MarkerColor::Yellow);
    assert_eq!(kept.account_id, Some(42));
    assert!(kept.note.is_none());
    assert_eq!(markers[1].nickname, "Newbie");
}

#[test]
fn import_none_account_id_keeps_stored_one() {
    let mut markers = vec![entry("Anchor", MarkerColor::Red)];
    markers[0].account_id = Some(7);
    let (added, updated, skipped) = upsert_import(
        &mut markers,
        vec![item("anchor", MarkerColor::Purple, None)],
    );
    assert_eq!((added, updated, skipped), (0, 1, 0));
    assert_eq!(markers[0].account_id, Some(7));
}

#[test]
fn import_wire_shapes_are_camelcase() {
    let incoming = serde_json::from_str::<MarkerImportItem>(
        r#"{"nickname":"A","color":"red","note":null,"accountId":9}"#,
    )
    .unwrap();
    assert_eq!(incoming.account_id, Some(9));
    let outgoing = serde_json::to_string(&MarkerImportResult {
        list: vec![],
        added: 1,
        updated: 2,
        skipped: 3,
    })
    .unwrap();
    assert!(outgoing.contains("\"added\":1"));
    assert!(outgoing.contains("\"skipped\":3"));
}

fn write_watchlist(tag: &str, body: &str) -> std::path::PathBuf {
    let dir = temp_dir(tag);
    let path = dir.join("WatchList.json");
    std::fs::write(&path, body).unwrap();
    path
}

#[test]
fn aperadar_watchlist_parses_and_tolerates_junk() {
    let path = write_watchlist(
        "aperadar-ok",
        r#"{
          "RU": {
            "2010353714": { "name": "Alpha", "status": "Negtive" },
            "not-a-number": { "name": "Beta", "status": "Cheater" }
          },
          "EU": {},
          "NA": { "1": { "status": "Positive" } },
          "ASIA": { "2": { "name": "Gamma" } },
          "CN": { "5520000001": { "name": "长城", "status": "Negtive" } }
        }"#,
    );
    let parsed: ApeRadarWatchList = parse_watchlist(&path).unwrap();
    // Empty (EU) and fully-nameless (NA) blocks drop out; the rest stay
    // in the file's server order (BTreeMap → alphabetical: ASIA, CN, RU).
    let names: Vec<&str> = parsed.servers.iter().map(|s| s.server.as_str()).collect();
    assert_eq!(names, vec!["ASIA", "CN", "RU"]);
    let ru = &parsed.servers[2];
    assert_eq!(ru.players.len(), 2);
    assert_eq!(ru.players[0].name, "Alpha"); // name-sorted within a server
    assert_eq!(ru.players[0].account_id, Some(2_010_353_714));
    assert_eq!(ru.players[1].account_id, None); // non-numeric key survives
    assert_eq!(ru.players[1].status, "Cheater");
    let asia = &parsed.servers[0];
    assert_eq!(asia.players[0].status, ""); // missing status → empty
    assert!(parsed.path.ends_with("WatchList.json"));
}

#[test]
fn aperadar_watchlist_garbage_is_an_error() {
    let path = write_watchlist("aperadar-bad", "definitely not json");
    assert!(parse_watchlist(&path).is_err());
}
