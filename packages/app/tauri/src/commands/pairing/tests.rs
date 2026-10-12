use std::path::PathBuf;

use super::client::*;
use super::gamedata::*;
use super::store::*;
use super::*;
use wowsp_tauri_shared::PairingToken;

/// Shared with the nested `server::tests` module and the relay module's
/// loopback test.
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
fn replay_pulls_with_colliding_names_preserve_both_downloads() {
    let tmp = tempfile_dir();
    // Both transfers selected the same destination before either finished.
    let proposed = tmp.join("same.wowsreplay");
    let first = tmp.join("same.1.part");
    let second = tmp.join("same.2.part");
    std::fs::write(&first, b"first replay").unwrap();
    std::fs::write(&second, b"second replay").unwrap();
    let first_path = finalize_replay_part(&first, &proposed).unwrap();
    let second_path = finalize_replay_part(&second, &proposed).unwrap();
    assert_eq!(std::fs::read(&first_path).unwrap(), b"first replay");
    assert_eq!(std::fs::read(&second_path).unwrap(), b"second replay");
    assert_ne!(first_path, second_path);
    assert!(!first.exists() && !second.exists());
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn replay_pull_preserves_file_created_during_download() {
    let tmp = tempfile_dir();
    let proposed = tmp.join("same.wowsreplay");
    let part = tmp.join("same.1.part");
    std::fs::write(&part, b"downloaded replay").unwrap();
    // A normal game recording or file import lands while the pull runs.
    std::fs::write(&proposed, b"local recording").unwrap();
    let downloaded = finalize_replay_part(&part, &proposed).unwrap();
    assert_eq!(std::fs::read(&proposed).unwrap(), b"local recording");
    assert_eq!(std::fs::read(&downloaded).unwrap(), b"downloaded replay");
    assert_ne!(downloaded, proposed);
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
    assert!(result.unwrap_err().contains("simulated storage failure"));
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

#[test]
fn path_segment_encoding_round_trips() {
    assert_eq!(encode_path_segment("abc-DEF_1.2~"), "abc-DEF_1.2~");
    assert_eq!(encode_path_segment("a b/c"), "a%20b%2Fc");
    assert_eq!(
        super::super::exports::percent_decode(&encode_path_segment(
            "20250622_152405_PJSB719-Hotaka_15_NE_north.wowsreplay"
        ))
        .unwrap(),
        "20250622_152405_PJSB719-Hotaka_15_NE_north.wowsreplay"
    );
    // Non-ASCII names survive the URL layer.
    assert_eq!(
        super::super::exports::percent_decode(&encode_path_segment("源.wowsreplay")).unwrap(),
        "源.wowsreplay"
    );
}

#[test]
fn host_cleaning_strips_scheme_and_slashes() {
    assert_eq!(clean_host(" 192.0.2.10 "), "192.0.2.10");
    assert_eq!(clean_host("http://192.0.2.10/"), "192.0.2.10");
    assert_eq!(clean_host("https://192.0.2.10"), "192.0.2.10");
}

#[cfg(desktop)]
#[test]
fn restarted_gamedata_build_does_not_replace_an_earlier_snapshot() {
    let tmp = tempfile_dir();
    let first = GamedataWorkspace::create(&tmp).unwrap();
    let second = GamedataWorkspace::create(&tmp).unwrap();
    let source = tmp.join("gameparams");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("a.json"), b"first server snapshot").unwrap();
    server::write_gamedata_zip(std::slice::from_ref(&source), &first.archive()).unwrap();
    let original = std::fs::read(first.archive()).unwrap();
    std::fs::write(source.join("a.json"), b"second server snapshot").unwrap();
    server::write_gamedata_zip(&[source], &second.archive()).unwrap();
    assert_eq!(
        std::fs::read(first.archive()).unwrap(),
        original,
        "a later server run must not replace an earlier session's archive"
    );
    assert_ne!(std::fs::read(second.archive()).unwrap(), original);
    let first_dir = first.0.clone();
    let second_dir = second.0.clone();
    drop(first);
    assert!(!first_dir.exists());
    assert!(second.archive().is_file());
    drop(second);
    assert!(!second_dir.exists());
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn gamedata_workspace_outlives_a_cancelled_call_until_its_worker_finishes() {
    let tmp = tempfile_dir();
    let workspace = std::sync::Arc::new(GamedataWorkspace::create(&tmp).unwrap());
    let original_dir = workspace.0.clone();
    let replacement = GamedataWorkspace::create(&tmp).unwrap();
    std::fs::write(replacement.part(), b"new session bytes").unwrap();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (finish_tx, finish_rx) = std::sync::mpsc::channel();
    let worker_workspace = workspace.clone();
    let worker = tokio::task::spawn_blocking(move || {
        started_tx.send(()).unwrap();
        finish_rx.recv().unwrap();
        std::fs::write(worker_workspace.part(), b"old build finishes").unwrap();
    });
    started_rx.await.unwrap();
    // Stopping the session/cancelling the caller cannot stop an already
    // running blocking job. Its owned workspace stays until it exits.
    drop(workspace);
    assert!(original_dir.is_dir());
    finish_tx.send(()).unwrap();
    worker.await.unwrap();
    assert!(!original_dir.exists());
    assert_eq!(
        std::fs::read(replacement.part()).unwrap(),
        b"new session bytes"
    );
    drop(replacement);
    std::fs::remove_dir(&tmp).unwrap();
}

#[cfg(desktop)]
#[test]
fn gamedata_zip_round_trip_and_zip_slip_safety() {
    use std::io::Write;

    let tmp = tempfile_dir();
    let src = tmp.join("gameparams");
    std::fs::create_dir_all(src.join("sub")).unwrap();
    std::fs::write(src.join("a.json"), b"{\"a\":1}").unwrap();
    std::fs::write(src.join("sub").join("b.json"), b"{\"b\":2}").unwrap();
    let zip_path = tmp.join("gd.zip");
    let n = server::write_gamedata_zip(&[src.clone()], &zip_path).unwrap();
    assert_eq!(n, 2);

    let dest = tmp.join("dest");
    let extracted = extract_gamedata_zip(&zip_path, &dest).unwrap();
    assert_eq!(extracted, 2);
    assert_eq!(
        std::fs::read(dest.join("gameparams").join("a.json")).unwrap(),
        b"{\"a\":1}"
    );
    assert_eq!(
        std::fs::read(dest.join("gameparams").join("sub").join("b.json")).unwrap(),
        b"{\"b\":2}"
    );

    // Hostile zip: entries escaping the destination are skipped, never
    // written outside it.
    let evil = tmp.join("evil.zip");
    let file = std::fs::File::create(&evil).unwrap();
    let mut w = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default();
    w.start_file("gameparams/ok.txt", opts).unwrap();
    w.write_all(b"ok").unwrap();
    w.start_file("../evil.txt", opts).unwrap();
    w.write_all(b"evil").unwrap();
    w.start_file("settings.json", opts).unwrap();
    w.write_all(b"replacement settings").unwrap();
    w.start_file("mods/installed.json", opts).unwrap();
    w.write_all(b"replacement ledger").unwrap();
    w.finish().unwrap();
    let out_dir = tmp.join("out2");
    std::fs::create_dir_all(&out_dir).unwrap();
    std::fs::write(out_dir.join("settings.json"), b"original settings").unwrap();
    let extracted = extract_gamedata_zip(&evil, &out_dir).unwrap();
    assert_eq!(extracted, 1);
    assert!(out_dir.join("gameparams/ok.txt").is_file());
    assert!(!tmp.join("evil.txt").exists());
    assert!(!out_dir.join("mods").exists());
    assert_eq!(
        std::fs::read(out_dir.join("settings.json")).unwrap(),
        b"original settings"
    );

    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn gamedata_names_allow_only_cache_trees_without_platform_aliases() {
    for name in ["gameparams/a.json", "encyclopedia/asia/船.json"] {
        assert_eq!(gamedata_entry_path(name, false), Some(PathBuf::from(name)));
    }
    assert_eq!(
        gamedata_entry_path("gameparams/", true),
        Some(PathBuf::from("gameparams"))
    );
    for name in [
        "settings.json",
        "mods/installed.json",
        "gameparams",
        "gameparams.json/a",
        "gameparams/../settings.json",
        "gameparams/.. /settings.json",
        "gameparams/./a.json",
        "gameparams//a.json",
        "gameparams/a/",
        "gameparams/a\\b.json",
        "gameparams/a:stream",
        "gameparams/a.json.",
        "gameparams/a.json ",
        "gameparams/NUL.json",
        "gameparams/com1/x",
        "gameparams/LPT².json",
        "gameparams/a\0.json",
        "/gameparams/a.json",
        "C:/gameparams/a.json",
    ] {
        assert_eq!(gamedata_entry_path(name, false), None, "{name:?}");
    }
}

#[test]
fn gamedata_rejects_archive_symlinks() {
    let tmp = tempfile_dir();
    let archive = tmp.join("cache.zip");
    let mut writer = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
    writer
        .add_symlink(
            "gameparams/link",
            "../../outside",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    writer.finish().unwrap();
    let dest = tmp.join("dest");
    let error = extract_gamedata_zip(&archive, &dest).unwrap_err();
    assert!(error.contains("symbolic link"), "{error}");
    assert!(!dest.join("gameparams/link").exists());
    std::fs::remove_dir_all(tmp).unwrap();
}

#[test]
#[cfg(windows)]
fn gamedata_rejects_existing_directory_junction() {
    use std::io::Write;
    use std::os::windows::process::CommandExt;

    let tmp = tempfile_dir();
    let dest = tmp.join("dest");
    let outside = tmp.join("outside");
    std::fs::create_dir_all(&dest).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("a.json"), b"original").unwrap();
    let link = dest.join("gameparams");
    // Junction creation needs neither administrator privileges nor
    // Developer Mode. Pass paths as data, never as PowerShell source.
    let created = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "New-Item -ItemType Junction -Path $env:WOWSP_TEST_LINK -Target $env:WOWSP_TEST_TARGET -ErrorAction Stop | Out-Null",
            ])
            .env("WOWSP_TEST_LINK", &link)
            .env("WOWSP_TEST_TARGET", &outside)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .unwrap();
    assert!(
        created.status.success(),
        "{}",
        String::from_utf8_lossy(&created.stderr)
    );
    let archive = tmp.join("cache.zip");
    let mut writer = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
    writer
        .start_file(
            "gameparams/a.json",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    writer.write_all(b"replacement").unwrap();
    writer.finish().unwrap();
    let result = extract_gamedata_zip(&archive, &dest);
    let contents = std::fs::read(outside.join("a.json")).unwrap();
    // Unlink the junction itself before recursively cleaning the fixture.
    std::fs::remove_dir(&link).unwrap();
    std::fs::remove_dir_all(tmp).unwrap();
    assert!(result.is_err(), "junction must not be followed: {result:?}");
    assert_eq!(contents, b"original");
}

#[test]
fn gamedata_replacement_does_not_modify_hard_link_target() {
    use std::io::Write;
    let tmp = tempfile_dir();
    let dest = tmp.join("dest");
    std::fs::create_dir_all(dest.join("gameparams")).unwrap();
    let original = tmp.join("original.json");
    std::fs::write(&original, b"original").unwrap();
    let target = dest.join("gameparams/a.json");
    std::fs::hard_link(&original, &target).unwrap();
    let archive = tmp.join("cache.zip");
    let mut writer = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
    writer
        .start_file(
            "gameparams/a.json",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    writer.write_all(b"updated").unwrap();
    writer.finish().unwrap();
    assert_eq!(extract_gamedata_zip(&archive, &dest).unwrap(), 1);
    assert_eq!(std::fs::read(&target).unwrap(), b"updated");
    assert_eq!(std::fs::read(&original).unwrap(), b"original");
    std::fs::remove_dir_all(tmp).unwrap();
}

#[test]
fn gamedata_corrupt_entry_preserves_existing_cache() {
    use std::io::Write;
    let tmp = tempfile_dir();
    let dest = tmp.join("dest");
    std::fs::create_dir_all(dest.join("gameparams")).unwrap();
    let target = dest.join("gameparams/a.json");
    std::fs::write(&target, b"original").unwrap();
    let archive = tmp.join("cache.zip");
    let mut writer = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    writer.start_file("gameparams/a.json", options).unwrap();
    writer.write_all(b"synthetic-cache-payload").unwrap();
    writer.finish().unwrap();
    let mut bytes = std::fs::read(&archive).unwrap();
    let offset = bytes
        .windows(b"synthetic-cache-payload".len())
        .position(|b| b == b"synthetic-cache-payload")
        .unwrap();
    bytes[offset] ^= 1; // Leave the original CRC in the central directory.
    std::fs::write(&archive, bytes).unwrap();
    assert!(extract_gamedata_zip(&archive, &dest).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"original");
    assert_eq!(
        std::fs::read_dir(dest.join("gameparams")).unwrap().count(),
        1
    );
    std::fs::remove_dir_all(tmp).unwrap();
}

#[cfg(desktop)]
#[test]
fn parses_request_heads() {
    let req = server::parse_head(
            b"GET /api/replays?token=abc%20d HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer tok123\r\nContent-Length: 5\r\n",
        )
        .unwrap();
    assert_eq!(req.method, "GET");
    assert_eq!(req.path, "/api/replays");
    assert_eq!(req.query_param("token"), Some("abc d"));
    assert_eq!(req.bearer_token(), Some("tok123"));
    assert_eq!(req.content_length, 5);

    assert!(server::parse_head(b"garbage").is_err());
    assert!(server::parse_head(b"GET\r\n\r\n").is_err());
    assert!(server::parse_head(b"POST /pair HTTP/1.1\r\nContent-Length: abc\r\n\r\n").is_err());
}

#[cfg(desktop)]
#[test]
fn constant_time_compare_behaves() {
    // The property under test is ordinary equality; the constant-time
    // aspect is by construction (see token_eq).
    assert!(server::token_eq("abcdef", "abcdef"));
    assert!(!server::token_eq("abcdef", "abcdeg"));
    assert!(!server::token_eq("abc", "abcd"));
}

// ── end-to-end localhost smoke: pair → list → pull → gamedata → restart ──

#[cfg(desktop)]
#[tokio::test]
async fn pairing_server_end_to_end() {
    // Fixture replay (magic + one JSON block, same shape as replay.rs's
    // synthetic test).
    let tmp = tempfile_dir();
    let replays = tmp.join("replays");
    std::fs::create_dir_all(&replays).unwrap();
    let json = r#"{"matchGroup":"pvp","mapDisplayName":"15_NE_north","mapId":8,"vehicles":[]}"#;
    let mut bytes: Vec<u8> = vec![0x12, 0x32, 0x34, 0x11];
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
    bytes.extend_from_slice(json.as_bytes());
    let replay_name = "20250622_152405_Hotaka_15_NE_north.wowsreplay";
    std::fs::write(replays.join(replay_name), &bytes).unwrap();

    // Gamedata sources.
    let gd = tmp.join("gd");
    std::fs::create_dir_all(gd.join("gameparams")).unwrap();
    std::fs::create_dir_all(gd.join("encyclopedia")).unwrap();
    std::fs::write(gd.join("gameparams").join("a.json"), b"GP-A").unwrap();
    std::fs::write(gd.join("encyclopedia").join("b.json"), b"ENC-B").unwrap();
    let zip_path = tmp.join("gamedata.zip");
    assert_eq!(
        server::write_gamedata_zip(&[gd.join("gameparams"), gd.join("encyclopedia")], &zip_path)
            .unwrap(),
        2
    );

    // Bind on an ephemeral localhost port and start serving.
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let room = server::random_token().unwrap();
    let handle = server::spawn_on(
        listener,
        replays.clone(),
        Some(zip_path.clone()),
        "123456",
        &room,
    )
    .await
    .unwrap();

    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    // ping needs no auth.
    let ping: serde_json::Value = client
        .get(format!("{base}/api/ping"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(ping["ok"], serde_json::json!(true));

    // Unknown route → 404.
    let r = client.get(format!("{base}/nope")).send().await.unwrap();
    assert_eq!(r.status(), 404);

    // Wrong PIN → 403 + "invalid PIN".
    let r = client
        .post(format!("{base}/pair"))
        .json(&serde_json::json!({ "pin": "000000" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["error"], "invalid PIN");

    // Data routes without a token → 401 with the clean string.
    let r = client
        .get(format!("{base}/api/replays"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["error"], "invalid or expired token");

    // Right PIN mints the token; the body now also echoes the run's
    // room key (relay phones address later tunnels by it).
    let paired: PairingToken = client
        .post(format!("{base}/pair"))
        .json(&serde_json::json!({ "pin": "123456" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = paired.token;
    assert!(!token.is_empty());
    assert_eq!(paired.room.as_deref(), Some(room.as_str()));

    // Token also works via ?token=.
    let r = client
        .get(format!("{base}/api/replays?token={token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);

    // List: same DTO as list_replays_meta, path projected to the name.
    let list: Vec<serde_json::Value> = client
        .get(format!("{base}/api/replays"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["path"], serde_json::json!(replay_name));
    assert_eq!(list[0]["mapName"], "15_NE_north");

    // Traversal-looking names are refused before any FS access.
    let r = client
        .get(format!("{base}/api/replay/..%2F..%2Fsecret"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);

    // Pull streams the exact fixture bytes.
    let pulled = client
        .get(format!(
            "{base}/api/replay/{}",
            encode_path_segment(replay_name)
        ))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(pulled.status(), 200);
    assert_eq!(
        pulled
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<usize>().ok()),
        Some(bytes.len())
    );
    let got = pulled.bytes().await.unwrap();
    assert_eq!(&got[..], &bytes[..]);

    // Gamedata zip downloads and extracts cleanly.
    let r = client
        .get(format!("{base}/api/gamedata"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let zip_bytes = r.bytes().await.unwrap();
    let zip_file = tmp.join("pulled.zip");
    std::fs::write(&zip_file, &zip_bytes).unwrap();
    let dest = tmp.join("extracted");
    assert_eq!(extract_gamedata_zip(&zip_file, &dest).unwrap(), 2);
    assert_eq!(
        std::fs::read(dest.join("gameparams").join("a.json")).unwrap(),
        b"GP-A"
    );

    // Stop → port actually freed → restart cleanly (proving the shutdown
    // really ends the old task).
    handle.stop().await;
    let listener2 = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    let handle2 = server::spawn_on(listener2, replays.clone(), None, "654321", &room)
        .await
        .unwrap();
    let paired2: PairingToken = client
        .post(format!("{base}/pair"))
        .json(&serde_json::json!({ "pin": "654321" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_ne!(paired2.token, token);
    // Without gamedata the route now 404s.
    let r = client
        .get(format!("{base}/api/gamedata"))
        .bearer_auth(&paired2.token)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);

    // PIN throttle: five consecutive wrong PINs lock the exchange for
    // a 10 s window — the sixth attempt gets 429 + Retry-After even
    // when it carries the CORRECT pin (the check runs before the
    // comparison). No sleep needed: assert the lock, then stop.
    for _ in 0..5 {
        let r = client
            .post(format!("{base}/pair"))
            .json(&serde_json::json!({ "pin": "000000" }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 403);
    }
    let r = client
        .post(format!("{base}/pair"))
        .json(&serde_json::json!({ "pin": "654321" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 429);
    let retry_after = r
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    assert!(retry_after.is_some_and(|s| (1..=10).contains(&s)));
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["error"], "too many PIN attempts");

    handle2.stop().await;

    let _ = std::fs::remove_dir_all(&tmp);
}
