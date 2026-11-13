use std::path::PathBuf;

use super::store::*;

/// Unique temp dir (cleaned best-effort by each test).
pub(crate) fn tempfile_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "wowsp-pairing-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

// ── pure helpers ─────────────────────────────────────────────────────────

#[test]
fn sanitize_strips_paths_and_normalizes_extension() {
    assert_eq!(
        sanitize_replay_name("20250622_152405_Hotaka.wowsreplay").unwrap(),
        "20250622_152405_Hotaka.wowsreplay"
    );
    // Path components collapse to the basename; missing suffix appends.
    assert_eq!(
        sanitize_replay_name("/tmp/evil/20250622_x.wowsreplay").unwrap(),
        "20250622_x.wowsreplay"
    );
    assert_eq!(
        sanitize_replay_name("..\\..\\20250622_y.wowsreplay").unwrap(),
        "20250622_y.wowsreplay"
    );
    assert_eq!(
        sanitize_replay_name("20250622_z").unwrap(),
        "20250622_z.wowsreplay"
    );
    // Case-insensitive suffix match keeps the original casing.
    assert_eq!(
        sanitize_replay_name("20250622_w.WowsReplay").unwrap(),
        "20250622_w.WowsReplay"
    );
    // The Lesta container keeps its own extension — the replay pipeline
    // parses it natively; the extension itself is meaningful metadata.
    assert_eq!(
        sanitize_replay_name("20261001_024940_Kremlin.korablireplay").unwrap(),
        "20261001_024940_Kremlin.korablireplay"
    );
    assert_eq!(
        sanitize_replay_name("20261001_024940_Kremlin.KorabliReplay").unwrap(),
        "20261001_024940_Kremlin.KorabliReplay"
    );
    // Windows-forbidden characters are replaced, not passed through.
    assert_eq!(
        sanitize_replay_name("a<b>:c\"|d?e*.wowsreplay").unwrap(),
        "a_b__c__d_e_.wowsreplay"
    );
    // Junk names are rejected outright.
    assert!(sanitize_replay_name("").is_err());
    assert!(sanitize_replay_name("   ").is_err());
    assert!(sanitize_replay_name("..").is_err());
    assert!(sanitize_replay_name(".hidden.wowsreplay").is_err());
    assert!(sanitize_replay_name(".").is_err());
}

#[test]
fn dedupe_suffixes_before_extension() {
    let tmp = tempfile_dir();
    let first = dedupe_path(&tmp, "20250622_x.wowsreplay");
    assert_eq!(first, tmp.join("20250622_x.wowsreplay"));
    std::fs::write(&first, b"1").unwrap();
    let second = dedupe_path(&tmp, "20250622_x.wowsreplay");
    assert_eq!(second, tmp.join("20250622_x (1).wowsreplay"));
    std::fs::write(&second, b"2").unwrap();
    assert_eq!(
        dedupe_path(&tmp, "20250622_x.wowsreplay"),
        tmp.join("20250622_x (2).wowsreplay")
    );
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn store_replay_bytes_round_trip_and_dedupes() {
    let tmp = tempfile_dir();
    let p1 = store_replay_bytes(&tmp, "20250622_a.wowsreplay", b"bytes-a").unwrap();
    let p2 = store_replay_bytes(&tmp, "20250622_a.wowsreplay", b"bytes-a2").unwrap();
    assert_ne!(p1, p2);
    assert!(p1.ends_with("20250622_a.wowsreplay"));
    assert!(p2.ends_with("20250622_a (1).wowsreplay"));
    assert!(std::fs::read(&p1).unwrap() == b"bytes-a");
    // A smuggled path lands as the basename.
    let p3 = store_replay_bytes(&tmp, "C:\\games\\20250622_b.wowsreplay", b"b").unwrap();
    assert!(p3.ends_with("20250622_b.wowsreplay"));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn replay_write_failure_removes_only_its_reserved_file() {
    let tmp = tempfile_dir();
    let existing = tmp.join("same.wowsreplay");
    std::fs::write(&existing, b"existing replay").unwrap();
    let result = write_replay_file(&tmp, "same.wowsreplay", |file| {
        std::io::Write::write_all(file, b"incomplete")?;
        Err(std::io::Error::other("simulated storage failure"))
    });
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("simulated storage failure")
    );
    assert_eq!(std::fs::read(&existing).unwrap(), b"existing replay");
    assert_eq!(std::fs::read_dir(&tmp).unwrap().count(), 1);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn replay_parallel_writers_claim_different_files() {
    let tmp = tempfile_dir();
    let barrier = std::sync::Barrier::new(2);
    let paths = std::thread::scope(|scope| {
        let writers: Vec<_> = [b"first replay".as_slice(), b"second replay".as_slice()]
            .into_iter()
            .map(|bytes| {
                let dir = &tmp;
                let barrier = &barrier;
                scope.spawn(move || {
                    write_replay_file(dir, "same.wowsreplay", |file| {
                        barrier.wait();
                        std::io::Write::write_all(file, bytes)
                    })
                    .unwrap()
                })
            })
            .collect();
        writers
            .into_iter()
            .map(|writer| writer.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_ne!(paths[0], paths[1]);
    assert_eq!(std::fs::read(&paths[0]).unwrap(), b"first replay");
    assert_eq!(std::fs::read(&paths[1]).unwrap(), b"second replay");
    let _ = std::fs::remove_dir_all(&tmp);
}
