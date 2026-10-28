//! Tests for the game-crash module. The pure parsers (wevtutil XML,
//! Report.wer key/value, code normalization) and the collectors (history,
//! excerpts, mods inventory, findings, restart-root resolution) all run on
//! synthetic temp-dir fixtures — nothing here touches a real game install
//! or a real client process, and nothing launches anything.

use super::*;
use std::time::Duration;

// ── fixture helpers ──────────────────────────────────────────────────────────

/// A temp root cleaned before + after each use (the mod_hub test pattern).
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("wowsp-gamecrash-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp root");
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn touch(&self, rel: &str, content: &str) -> PathBuf {
        let path = self.0.join(rel);
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdirs");
        fs::write(&path, content).expect("write");
        path
    }

    /// Backdate/advance a file's mtime for recency assertions.
    fn set_mtime(&self, rel: &str, unix: i64) {
        let path = self.0.join(rel);
        let file = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open for mtime");
        file.set_times(
            std::fs::FileTimes::new()
                .set_modified(UNIX_EPOCH + Duration::from_secs(unix.max(0) as u64)),
        )
        .expect("set mtime");
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A synthetic crash record.
fn sample_record(id: &str, root: Option<&str>) -> GameCrashRecord {
    GameCrashRecord {
        id: id.to_string(),
        detected_at: chrono::Utc::now().to_rfc3339(),
        pid: 4242,
        image_name: "worldofwarships64.exe".to_string(),
        game_root: root.map(str::to_string),
        install_kind: None,
        game_build: Some("13187581".to_string()),
        source: SOURCE_EVENT_LOG.to_string(),
        exception_code: Some("0xC0000005".to_string()),
        faulting_module: Some("nvldum.dll".to_string()),
        wer_report_path: None,
        crash_dump_path: None,
        summary: Some("Event 1000 (Application Error)".to_string()),
        mods_active: true,
        status: STATUS_NEW.to_string(),
    }
}

// ── exception-code normalization + dictionary ────────────────────────────────

#[test]
fn normalizes_every_exception_code_spelling() {
    assert_eq!(
        normalize_exception_code("0xc0000005").as_deref(),
        Some("0xC0000005")
    );
    assert_eq!(
        normalize_exception_code("c0000005").as_deref(),
        Some("0xC0000005")
    );
    assert_eq!(
        normalize_exception_code("C0000409").as_deref(),
        Some("0xC0000409")
    );
    assert_eq!(
        normalize_exception_code("  0xC00000FD ").as_deref(),
        Some("0xC00000FD")
    );
    assert_eq!(normalize_exception_code("not-a-code"), None);
    assert_eq!(normalize_exception_code(""), None);
}

#[test]
fn exception_dictionary_maps_known_codes_and_falls_back() {
    let finding = exception_finding("c0000005");
    assert_eq!(finding.code, "exceptionAccessViolation");
    assert_eq!(finding.severity, "critical");
    assert_eq!(finding.detail.as_deref(), Some("0xC0000005"));

    assert_eq!(
        exception_finding("0xC0000409").code,
        "exceptionStackBufferOverrun"
    );
    assert_eq!(
        exception_finding("0xE06D7363").code,
        "exceptionCppException"
    );
    assert_eq!(exception_finding("0x80000003").severity, "info");

    let unknown = exception_finding("0xDEADBEEF");
    assert_eq!(unknown.code, "exceptionUnknown");
    assert_eq!(unknown.severity, "warning");
    assert_eq!(unknown.detail.as_deref(), Some("0xDEADBEEF"));
}

// ── crash history ────────────────────────────────────────────────────────────

#[test]
fn history_appends_newest_first_and_dismisses() {
    let dir = TempDir::new("history");
    append_record_in(dir.path(), &sample_record("gc-1", None)).expect("append 1");
    append_record_in(dir.path(), &sample_record("gc-2", None)).expect("append 2");

    let records = load_history_in(dir.path()).expect("load").expect("present");
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].id, "gc-2", "newest first");
    assert_eq!(records[0].status, STATUS_NEW);

    dismiss_record_in(dir.path(), "gc-1").expect("dismiss");
    let records = load_history_in(dir.path()).expect("load").expect("present");
    assert_eq!(records[1].status, STATUS_DISMISSED);
    assert_eq!(records[0].status, STATUS_NEW);

    let found = find_record_in(dir.path(), "gc-2").expect("find");
    assert_eq!(found.map(|r| r.id).as_deref(), Some("gc-2"));
    assert!(
        find_record_in(dir.path(), "gc-missing")
            .expect("find")
            .is_none(),
        "missing id answers None"
    );
}

#[test]
fn history_retention_caps_the_file() {
    let dir = TempDir::new("history-cap");
    for i in 0..(MAX_HISTORY + 5) {
        append_record_in(dir.path(), &sample_record(&format!("gc-{i}"), None)).expect("append");
    }
    let records = load_history_in(dir.path()).expect("load").expect("present");
    assert_eq!(records.len(), MAX_HISTORY, "oldest records drop off");
    assert_eq!(records[0].id, format!("gc-{}", MAX_HISTORY + 4));
    assert_eq!(records.last().map(|r| r.id.as_str()), Some("gc-5"));
}

#[test]
fn damaged_history_file_errors_through() {
    let dir = TempDir::new("history-damaged");
    super::super::appdata::write_json_in(dir.path(), HISTORY_FILE, "not json at all")
        .expect("write damaged file");
    assert!(
        load_history_in(dir.path()).is_err(),
        "a damaged file must never silently reset to empty"
    );
}

// ── log excerpts + candidates ────────────────────────────────────────────────

#[test]
fn excerpt_takes_the_tail_and_flags_error_lines() {
    let dir = TempDir::new("excerpt");
    let mut lines: Vec<String> = Vec::new();
    for i in 0..200 {
        lines.push(format!("line {i}"));
    }
    lines.push("13:00:00 ERROR: failed to load texture".to_string());
    lines.push("13:00:01 INFO: port loaded".to_string());
    dir.touch("profile/python.log", &lines.join("\n"));

    let excerpt = excerpt_of(&dir.path().join("profile/python.log"), 50).expect("excerpt");
    assert_eq!(excerpt.name, "python.log");
    // 203 lines total, tail 50: the head starts at line 153.
    assert!(excerpt.tail.starts_with("line 152"), "head lines drop off");
    assert!(excerpt.tail.contains("line 199"), "tail keeps the end");
    assert!(
        excerpt
            .highlights
            .iter()
            .any(|l| l.contains("ERROR: failed to load")),
        "error lines are highlights"
    );
    assert_eq!(excerpt.highlights.len(), 1, "keyword-only lines flag");
}

#[test]
fn game_log_candidates_prefer_profile_then_logs_newest_first() {
    let dir = TempDir::new("candidates");
    let now = unix_secs(std::time::SystemTime::now());
    dir.touch("profile/python.log", "python log");
    dir.touch("profile/clientrunner.log", "Selected realm: eu");
    dir.touch("logs/update.txt", "update text");
    dir.touch("profile/settings.json", "not a log");
    dir.set_mtime("profile/python.log", now - 1000);
    dir.set_mtime("profile/clientrunner.log", now - 500);
    dir.set_mtime("logs/update.txt", now);

    let candidates = game_log_candidates(dir.path());
    let names: Vec<String> = candidates
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["update.txt", "clientrunner.log", "python.log"]);
    assert!(
        !names.contains(&"settings.json".to_string()),
        "non-log files never enter the analysis"
    );
}

// ── mods inventory + findings ────────────────────────────────────────────────

#[test]
fn mods_inventory_reads_active_res_mods_and_falls_back_to_twin() {
    let dir = TempDir::new("mods");
    dir.touch("bin/123/res_mods/gui/some_mod.xml", "x");
    dir.touch("bin/123/res_mods/PnFModsLoader.py", "");

    let entries = mods_inventory_entries(dir.path());
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["PnFModsLoader.py", "gui"]);
    assert_eq!(entries[1].is_dir, true);

    // Quarantine the active res_mods the way safe mode does: the twin is
    // what would load once mods come back, so the inventory must read it.
    let twin = dir.path().join("bin/123/res_mods.wowsp-disabled");
    fs::rename(dir.path().join("bin/123/res_mods"), &twin).expect("quarantine");
    let entries = mods_inventory_entries(dir.path());
    assert_eq!(entries.len(), 2, "the quarantined twin still inventories");
}

#[test]
fn findings_flag_recent_mod_changes_and_mods_in_play() {
    let now = unix_secs(std::time::SystemTime::now());
    let dir = TempDir::new("findings");
    dir.touch("bin/9/res_mods/suspect_mod", "x");
    dir.set_mtime("bin/9/res_mods/suspect_mod", now - 3600);
    dir.touch("bin/9/res_mods/old_mod", "x");
    dir.set_mtime("bin/9/res_mods/old_mod", now - 90 * 24 * 3600);

    let record = sample_record("gc-findings", Some(dir.path().to_str().unwrap()));
    let mods = mods_inventory_entries(dir.path());
    let findings = build_findings(&record, &mods, &[], record.game_root.as_deref());

    let recent = findings
        .iter()
        .find(|f| f.code == "recentModChanges")
        .expect("recent mod change flagged");
    assert_eq!(recent.severity, "warning");
    assert_eq!(recent.detail.as_deref(), Some("suspect_mod"));

    assert!(
        findings.iter().any(|f| f.code == "modsActiveAtCrash"),
        "mods-in-play hint present"
    );
    assert!(
        findings.iter().any(|f| f.code == "evidenceEventLog"),
        "source finding mirrors the record's evidence source"
    );
    let exception = findings
        .iter()
        .find(|f| f.code == "exceptionAccessViolation")
        .expect("exception finding");
    assert_eq!(exception.detail.as_deref(), Some("0xC0000005"));
}

#[test]
fn findings_note_safe_mode_without_reading_the_registry() {
    let dir = TempDir::new("findings-safe");
    dir.touch("bin/7/res_mods.wowsp-disabled/mod", "x");
    let record = sample_record("gc-safe", Some(dir.path().to_str().unwrap()));
    let findings = build_findings(&record, &[], &[], record.game_root.as_deref());
    assert!(
        findings.iter().any(|f| f.code == "safeModeOn"),
        "an already-quarantined install is reported as safe mode on"
    );
}

// ── suspect detection ────────────────────────────────────────────────────────

#[test]
fn suspects_rank_log_mentions_above_recent_changes() {
    let now = unix_secs(std::time::SystemTime::now());
    let dir = TempDir::new("suspects");
    dir.touch("bin/5/res_mods/logged_mod", "x");
    dir.touch("bin/5/res_mods/recent_mod", "x");
    dir.set_mtime("bin/5/res_mods/logged_mod", now - 7200);
    dir.set_mtime("bin/5/res_mods/recent_mod", now - 3600);

    let record = sample_record("gc-suspects", Some(dir.path().to_str().unwrap()));
    let mods = mods_inventory_entries(dir.path());
    // A game-log line naming the mod under res_mods/<version>/ is the
    // stronger evidence even though both entries are equally fresh.
    let raw = [(
        "python.log",
        format!("12:00:00 ERROR: failed loading res_mods/123/logged_mod/gui/x.xml extra",),
    )];
    let raw_refs: Vec<(&str, &str)> = raw
        .iter()
        .map(|(name, text)| (*name, text.as_str()))
        .collect();
    let suspects = detect_suspect_mods(&raw_refs, &mods, parse_rfc3339_unix(&record.detected_at));
    assert_eq!(suspects.len(), 2, "both suspects found");
    assert_eq!(suspects[0].name, "logged_mod");
    assert_eq!(suspects[0].evidence, "logMention");
    assert_eq!(suspects[0].log_lines.len(), 1);
    assert_eq!(suspects[1].name, "recent_mod");
    assert_eq!(suspects[1].evidence, "recentChange");
}

#[test]
fn res_mods_path_candidates_carry_both_segments_and_separators() {
    // Current layout: no version segment — the entry IS the first segment.
    let unix_style = "ERROR: res_mods/MyMod/file.py missing";
    assert_eq!(
        res_mods_path_candidates(unix_style),
        Some(("MyMod".to_string(), Some("file.py missing".to_string())))
    );
    // Older spelling with a version segment: first may be the version,
    // the caller resolves against the inventory.
    let versioned = "ERROR: res_mods/123/MyMod/file.py bad";
    assert_eq!(
        res_mods_path_candidates(versioned),
        Some(("123".to_string(), Some("MyMod".to_string())))
    );
    // Backslash separators normalize; no path at all answers None.
    let win_style = format!("ERROR: res_mods{0}Gui{0}x.xml bad", '\\');
    assert_eq!(
        res_mods_path_candidates(&win_style),
        Some(("Gui".to_string(), Some("x.xml bad".to_string())))
    );
    assert_eq!(res_mods_path_candidates("no path here"), None);
    assert_eq!(res_mods_path_candidates("res_mods/"), None);
}
// ── quarantine mutation ──────────────────────────────────────────────────────

#[test]
fn quarantine_moves_entries_and_the_manifest_tracks_them() {
    let dir = TempDir::new("quarantine");
    let root = dir.path().to_str().unwrap().to_string();
    dir.touch("bin/8/res_mods/bad_mod/x.xml", "x");
    dir.touch("bin/8/res_mods/good_mod/y.xml", "y");

    // The known-root guard accepts the synthetic root through the test seam.
    super::super::mod_hub::test_allow_game_root(&root);
    let entries = mutate_quarantine(&root, "bad_mod", Some("gc-q"), true).expect("quarantine");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "bad_mod");
    assert_eq!(entries[0].crash_id.as_deref(), Some("gc-q"));
    assert!(
        !dir.path().join("bin/8/res_mods/bad_mod").exists(),
        "the entry left the load path"
    );
    assert!(
        dir.path()
            .join("bin/8/res_mods.wowsp-quarantine/bad_mod")
            .exists(),
        "the entry sits in the quarantine dir"
    );

    // Name sanitization: path plumbing is refused outright.
    assert!(mutate_quarantine(&root, "../evil", None, true).is_err());
    assert!(mutate_quarantine(&root, "a/b", None, true).is_err());
    assert!(mutate_quarantine(&root, "", None, true).is_err());

    let entries = mutate_quarantine(&root, "bad_mod", None, false).expect("restore");
    assert!(entries.is_empty(), "restore empties the manifest");
    assert!(dir.path().join("bin/8/res_mods/bad_mod").exists());

    // The manifest reader answers empty when nothing was ever quarantined.
    let dir2 = TempDir::new("quarantine-empty");
    dir2.touch("bin/8/res_mods/.keep", "");
    let root2 = dir2.path().to_str().unwrap().to_string();
    let (_, quarantine_dir) = quarantine_dir_of(&root2).expect("dirs");
    assert!(
        load_quarantine_manifest(&quarantine_dir)
            .expect("manifest")
            .is_empty(),
        "no manifest = no quarantined entries"
    );
}

// ── restart resolution ───────────────────────────────────────────────────────

#[test]
fn resolve_restart_root_explicit_argument_wins() {
    let arg = format!("C:\\Games\\WoWS");
    assert_eq!(resolve_restart_root(Some(arg.as_str())).expect("arg"), arg);
}

#[test]
fn stub_resolution_prefers_family_then_any_stub() {
    let dir = TempDir::new("stub");
    assert!(
        stub_exe_for(dir.path().to_str().unwrap()).is_err(),
        "an empty folder has no stub"
    );
    dir.touch("WorldOfWarships.exe", "stub");
    assert!(
        stub_exe_for(dir.path().to_str().unwrap())
            .expect("wg stub")
            .file_name()
            .map(|n| n == "WorldOfWarships.exe")
            .unwrap_or(false),
        "the WG family stub resolves first"
    );
    let dir_lesta = TempDir::new("stub-lesta");
    dir_lesta.touch("Korabli.exe", "stub");
    assert!(
        stub_exe_for(dir_lesta.path().to_str().unwrap())
            .expect("lesta stub")
            .file_name()
            .map(|n| n == "Korabli.exe")
            .unwrap_or(false),
        "a Lesta-only install resolves to its own stub"
    );
}

// ── date helpers ─────────────────────────────────────────────────────────────

#[test]
fn rfc3339_unix_roundtrip() {
    assert_eq!(parse_rfc3339_unix("1970-01-02T00:00:00Z"), Some(86400));
    assert_eq!(parse_rfc3339_unix("not a date"), None);
}

// ── evidence parsers (Windows-shaped fixtures) ───────────────────────────────

#[cfg(target_os = "windows")]
mod evidence_parsers {
    use super::*;

    const EVENT_1000: &str = concat!(
        "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'>",
        "<System><Provider Name='Application Error'/><EventID Qualifiers='0'>1000</EventID>",
        "<TimeCreated SystemTime='2026-10-27T18:52:13.0000000Z'/>",
        "<Channel>Application</Channel></System><EventData>",
        "<Data Name='AppName'>WorldOfWarships64.exe</Data>",
        "<Data Name='AppPath'>C:\\Games\\WoWS\\bin\\123\\bin64\\WorldOfWarships64.exe</Data>",
        "<Data Name='ModuleName'>nvldum.dll</Data>",
        "<Data Name='ExceptionCode'>0xc0000005</Data>",
        "</EventData></Event>"
    );
    const EVENT_1001: &str = concat!(
        "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'>",
        "<System><Provider Name='Windows Error Reporting'/><EventID>1001</EventID>",
        "<TimeCreated SystemTime='2026-10-27T18:52:20.0000000Z'/></System><EventData>",
        "<Data Name='EventName'>BEX64</Data>",
        "<Data Name='P1'>worldofwarships64.exe</Data>",
        "<Data Name='P4'>QQNT.dll_unloaded</Data>",
        "<Data Name='P8'>c0000005</Data>",
        "<Data Name='StorePath'>\\\\?\\C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportArchive\\AppCrash_WorldOfWarships64.exe_deadbeef_1234abcd</Data>",
        "</EventData></Event>"
    );

    fn window_around(iso: &str) -> (i64, i64) {
        let t = parse_rfc3339_unix(iso).expect("fixture time");
        (t - EVIDENCE_SLACK_SECS, t + EVIDENCE_SLACK_SECS)
    }

    #[test]
    fn decodes_utf8_utf16_bom_and_bare_utf16_output() {
        assert_eq!(decode_command_output(b"plain text"), "plain text");
        let mut bom = vec![0xFF, 0xFE];
        for unit in "plain text".encode_utf16() {
            bom.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_command_output(&bom), "plain text");
        // Bare UTF-16LE: the NUL-density heuristic kicks in.
        let mut bare = Vec::new();
        for unit in "crash report".encode_utf16() {
            bare.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_command_output(&bare), "crash report");
    }

    #[test]
    fn parses_wevtutil_xml_events_with_data_pairs() {
        let events = parse_wevtutil_xml(&format!("{EVENT_1000}{EVENT_1001}"));
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_id, Some(1000));
        assert_eq!(events[0].provider, "Application Error");
        assert_eq!(
            parse_rfc3339_unix("2026-10-27T18:52:13Z"),
            events[0].time_unix,
            "fractional seconds parse"
        );
        let value = |event: &ParsedEvent, name: &str| {
            event
                .data
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        };
        assert_eq!(
            value(&events[0], "exceptioncode").as_deref(),
            Some("0xc0000005")
        );
        assert_eq!(value(&events[1], "p8").as_deref(), Some("c0000005"));
    }

    #[test]
    fn events_match_the_client_by_every_recorded_shape() {
        let events = parse_wevtutil_xml(&format!("{EVENT_1000}{EVENT_1001}"));
        let window = window_around("2026-10-27T18:52:13Z");
        let exe = format!("C:\\Games\\WoWS\\bin\\123\\bin64\\WorldOfWarships64.exe");
        assert!(event_matches_client(
            &events[0],
            "worldofwarships64.exe",
            Some(exe.as_str()),
            window
        ));
        assert!(event_matches_client(
            &events[1],
            "worldofwarships64.exe",
            None,
            window
        ));
        // A different image never matches, even inside the window.
        assert!(!event_matches_client(
            &events[0],
            "chrome.exe",
            None,
            window
        ));
        // Outside the window (a day earlier) never matches.
        let stale_window = (window.0 - 24 * 3600 - 10, window.1 - 24 * 3600 - 10);
        assert!(!event_matches_client(
            &events[0],
            "worldofwarships64.exe",
            None,
            stale_window
        ));
    }

    #[test]
    fn event_evidence_extracts_codes_modules_and_report_paths() {
        let events = parse_wevtutil_xml(&format!("{EVENT_1000}{EVENT_1001}"));

        let from_1000 = evidence_from_event(&events[0]);
        assert_eq!(from_1000.source, SOURCE_EVENT_LOG);
        assert_eq!(from_1000.exception_code.as_deref(), Some("0xC0000005"));
        assert_eq!(from_1000.faulting_module.as_deref(), Some("nvldum.dll"));

        let from_1001 = evidence_from_event(&events[1]);
        assert_eq!(from_1001.exception_code.as_deref(), Some("0xC0000005"));
        assert_eq!(
            from_1001.faulting_module.as_deref(),
            Some("QQNT.dll"),
            "the WER _unloaded suffix is stripped"
        );
        assert!(
            from_1001
                .report_path
                .as_deref()
                .is_some_and(|p| p.contains("AppCrash_WorldOfWarships64.exe")),
            "the StorePath report folder is adopted: {:?}",
            from_1001.report_path
        );
    }

    #[test]
    fn wer_report_fields_are_found_through_the_sig_pairs() {
        let text = [
            "UI[2]=C:\\Games\\WoWS\\bin\\123\\bin64\\WorldOfWarships64.exe",
            "Signature\\Sig[0].Name=Application Name",
            "Signature\\Sig[0].Value=WorldOfWarships64.exe",
            "Signature\\Sig[3].Name=Exception code",
            "Signature\\Sig[3].Value=0c0000005",
            "Signature\\Sig[5].Name=Fault Module Name",
            "Signature\\Sig[5].Value=nvldum.dll",
            "DynamicSig\\[1].Name=OS Version",
            "DynamicSig\\[1].Value=10.0.0.2.0",
        ]
        .join("\n");
        let kv = parse_wer_kv(&text);
        assert_eq!(kv.len(), 9);
        let code = wer_field(&kv, "exception code")
            .and_then(|raw| normalize_exception_code(&raw))
            .expect("exception code found");
        assert_eq!(code, "0xC0000005");
        assert_eq!(
            wer_field(&kv, "fault module name").as_deref(),
            Some("nvldum.dll")
        );
        assert_eq!(
            wer_field(&kv, "application name").as_deref(),
            Some("WorldOfWarships64.exe")
        );
        assert_eq!(wer_field(&kv, "nonexistent"), None);
    }

    #[test]
    fn wer_bytes_decode_from_utf16_without_bom() {
        let text =
            format!("Signature\\Sig[3].Name=Exception code\nSignature\\Sig[3].Value=0c0000005");
        let mut bytes = Vec::new();
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let decoded = decode_wer_bytes(&bytes);
        assert!(decoded.contains("Exception code"));
        let kv = parse_wer_kv(&decoded);
        assert_eq!(
            wer_field(&kv, "exception code").as_deref(),
            Some("0c0000005")
        );
    }

    #[test]
    fn xml_entities_in_data_values_unescape() {
        assert_eq!(xml_unescape("a &amp; b &lt;c&gt;"), "a & b <c>");
        assert_eq!(
            xml_unescape("path &quot;q&quot; &apos;p&apos;"),
            "path \"q\" 'p'"
        );
    }
}
