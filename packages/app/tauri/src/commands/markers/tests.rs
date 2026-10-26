//! Unit suite for the local marker store: upsert semantics, unicode
//! nickname equality, persistence roundtrip and the garbage-file heal.

use wowsp_tauri_shared::{MarkerColor, MarkerEntry};

use super::store::{load_markers_from, same_nickname, store_markers};

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
