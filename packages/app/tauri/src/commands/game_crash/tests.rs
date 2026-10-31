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
        evidence_id: None,
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
    let findings = build_findings(&record, &mods, &[], &[], false);

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
fn probe_was_active_reads_the_wide_window_not_the_display_tail() {
    // The probe writes its startup lines early in python.log; a session
    // that runs long enough scrolls them past the 160-line display tail.
    // The finding must still fire off the wide window the analysis reads
    // — a tail-window verdict flips to absent between two crash records
    // of one install and reads to the user as "the probe vanished".
    // (User report 2026-10-31.)
    let dir = TempDir::new("probe-seen");
    let mut lines = vec!["WOWSP_PROBE sandbox builtins=ok".to_string()];
    for i in 0..(EXCERPT_TAIL_LINES + 40) {
        lines.push(format!("filler line {i}"));
    }
    let path = dir.touch("profile/python.log", &lines.join("\n"));

    let excerpt = excerpt_of(&path, EXCERPT_TAIL_LINES).expect("excerpt");
    assert!(
        !excerpt.tail.contains("WOWSP_PROBE"),
        "the fixture really does overflow the display tail"
    );
    let (bytes, _, _) = read_tail(&path, EXCERPT_FILE_CAP).expect("window");
    let probe_seen = String::from_utf8_lossy(&bytes).contains("WOWSP_PROBE");
    assert!(probe_seen, "the wide window still sees the marker");

    let record = sample_record("gc-probe", Some(dir.path().to_str().unwrap()));
    let findings = build_findings(&record, &[], &[], &[], probe_seen);
    let finding = findings
        .iter()
        .find(|f| f.code == "probeWasActive")
        .expect("probe finding present off the wide window");
    assert_eq!(finding.severity, "info");

    let without = build_findings(&record, &[], &[], &[], false);
    assert!(
        !without.iter().any(|f| f.code == "probeWasActive"),
        "no marker anywhere in the window means no finding"
    );
}

#[test]
fn analyze_sync_flags_probe_active_off_the_wide_window() {
    // End-to-end pin for the wiring in analyze_sync: the same overflowing
    // fixture driven through the full analysis pass must carry the finding.
    // The unit test above proves build_findings honors the flag; this one
    // proves the flag is actually computed off the wide window (and could
    // not pass against a display-tail verdict).
    let dir = TempDir::new("probe-seen-sync");
    let mut lines = vec!["WOWSP_PROBE sandbox builtins=ok".to_string()];
    for i in 0..(EXCERPT_TAIL_LINES + 40) {
        lines.push(format!("filler line {i}"));
    }
    dir.touch(
        "profile/python.log",
        &lines.join(
            "
",
        ),
    );

    let record = sample_record("gc-probe-sync", Some(dir.path().to_str().unwrap()));
    let analysis = analyze_sync(&record).expect("analysis");
    assert!(
        analysis.findings.iter().any(|f| f.code == "probeWasActive"),
        "the analysis pass finds the marker outside the display tail"
    );
}

#[test]
fn findings_stay_crash_scoped() {
    // Safe mode is a LIVE state the section shows as its own row — it must
    // never read as a crash-time claim (the old finding was misleading
    // whenever the user enabled safe mode after the crash).
    let dir = TempDir::new("findings-safe");
    dir.touch("bin/7/res_mods.wowsp-disabled/mod", "x");
    let record = sample_record("gc-safe", Some(dir.path().to_str().unwrap()));
    let findings = build_findings(&record, &[], &[], &[], false);
    assert!(
        !findings.iter().any(|f| f.code == "safeModeOn"),
        "safe mode is not a crash finding"
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

    pub(super) const EVENT_1000: &str = concat!(
        "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'>",
        "<System><Provider Name='Application Error'/><EventRecordID>460470</EventRecordID><EventID Qualifiers='0'>1000</EventID>",
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
        "<Data Name='StorePath'>\\?\\C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportArchive\\AppCrash_WorldOfWarships64.exe_deadbeef_1234abcd</Data>",
        "</EventData></Event>"
    );
    /// Event 1001 leak PREdiction: names the STILL-RUNNING client in P1,
    /// exactly like a crash report does.
    const EVENT_1001_LEAK: &str = concat!(
        "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'>",
        "<System><Provider Name='Windows Error Reporting'/><EventID>1001</EventID>",
        "<TimeCreated SystemTime='2026-10-31T07:51:47.0000000Z'/></System><EventData>",
        "<Data Name='EventName'>RADAR_PRE_LEAK_64</Data>",
        "<Data Name='P1'>WorldOfWarships64.exe</Data>",
        "<Data Name='P2'>N/A</Data>",
        "<Data Name='P3'>N/A</Data>",
        "<Data Name='P4'>N/A</Data>",
        "<Data Name='P5'>N/A</Data>",
        "<Data Name='P6'>N/A</Data>",
        "<Data Name='P7'>N/A</Data>",
        "<Data Name='P8'>N/A</Data>",
        "</EventData></Event>"
    );
    /// Event 1001 crash report with the same P1 spelling — a real crash
    /// shape that must keep matching.
    const EVENT_1001_APPCRASH: &str = concat!(
        "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'>",
        "<System><Provider Name='Windows Error Reporting'/><EventID>1001</EventID>",
        "<TimeCreated SystemTime='2026-10-31T07:51:47.0000000Z'/></System><EventData>",
        "<Data Name='EventName'>APPCRASH</Data>",
        "<Data Name='P1'>WorldOfWarships64.exe</Data>",
        "<Data Name='P2'>1.0.0.0</Data>",
        "<Data Name='P3'>0c0000005</Data>",
        "<Data Name='P4'>WorldOfWarships64.exe</Data>",
        "<Data Name='P5'>1.0.0.0</Data>",
        "<Data Name='P6'>0c0000005</Data>",
        "<Data Name='P7'>N/A</Data>",
        "<Data Name='P8'>N/A</Data>",
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
        assert_eq!(
            events[0].record_id,
            Some(460470),
            "the backfill dedupe key parses"
        );
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

    /// The observed false positive: a RADAR_PRE_LEAK_64 event 1001 (a leak
    /// PREdiction for a still-running client) names the image in P1 just
    /// like a crash does. It must never match — not live (a later clean exit
    /// inside the lookback would be falsely confirmed) and not in the
    /// backfill's exact-name attribution.
    #[test]
    fn leak_prediction_events_never_match_the_client() {
        let events = parse_wevtutil_xml(&format!("{EVENT_1001_LEAK}{EVENT_1001_APPCRASH}"));
        assert_eq!(events.len(), 2);
        let window = window_around("2026-10-31T07:51:47Z");
        assert!(!event_is_crash_shaped(&events[0]));
        assert!(event_is_crash_shaped(&events[1]));
        assert!(
            !event_matches_client(&events[0], "worldofwarships64.exe", None, window),
            "a memory-leak prediction is not a crash"
        );
        assert!(
            event_matches_client(&events[1], "worldofwarships64.exe", None, window),
            "an APPCRASH-shaped 1001 still confirms the crash"
        );
        // The backfill attributes by exact P1 match without consulting
        // event_matches_client, so the leak filter has to hold there too.
        let images = vec!["worldofwarships64.exe".to_string()];
        assert_eq!(attributed_image(&events[0], &images, window), None);
        assert_eq!(
            attributed_image(&events[1], &images, window).as_deref(),
            Some("worldofwarships64.exe")
        );
    }

    #[test]
    fn event_evidence_extracts_codes_modules_and_report_paths() {
        let events = parse_wevtutil_xml(&format!("{EVENT_1000}{EVENT_1001}"));

        let from_1000 = evidence_from_event(&events[0]);
        assert_eq!(from_1000.source, SOURCE_EVENT_LOG);
        assert_eq!(from_1000.exception_code.as_deref(), Some("0xC0000005"));
        assert_eq!(from_1000.faulting_module.as_deref(), Some("nvldum.dll"));
        assert_eq!(
            from_1000.evidence_id.as_deref(),
            Some("evt:460470"),
            "the live evidence id matches the backfill's"
        );

        let from_1001 = evidence_from_event(&events[1]);
        assert_eq!(
            from_1001.evidence_id, None,
            "a 1001 without EventRecordID carries no evidence id"
        );
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

// ── safeguard switch + backfill merge ────────────────────────────────────────

#[test]
fn safeguard_config_roundtrips_and_defaults_on() {
    let dir = TempDir::new("safeguard");
    // Missing file = enabled (the product default).
    assert!(load_safeguard_in(dir.path()));
    store_safeguard_in(dir.path(), false).expect("store off");
    assert!(!load_safeguard_in(dir.path()));
    // The heal pass rewrote the canonical TOML; a damaged file falls back
    // to the default instead of erroring.
    super::super::appdata::write_json_in(dir.path(), SAFEGUARD_FILE, "garbage")
        .expect("write damaged");
    assert!(load_safeguard_in(dir.path()), "damaged setting heals to ON");
}

#[cfg(windows)]
fn candidate(evidence_id: &str, at: i64, image: &str, priority: u8) -> BackfillCandidate {
    BackfillCandidate {
        evidence_id: evidence_id.to_string(),
        at_unix: at,
        image: image.to_string(),
        priority,
        exception_code: Some("0xC0000005".to_string()),
        faulting_module: None,
        report_path: None,
        dump_path: None,
        summary: String::new(),
    }
}

#[cfg(windows)]
#[test]
fn backfill_merge_clusters_one_crash_across_three_sources() {
    let t = 1_790_000_000;
    let merged = merge_backfill_candidates(vec![
        // Same crash: dump + WER folder + event-log entry within 3 minutes.
        candidate("dmp:a.dmp", t + 120, "worldofwarships64.exe", 2),
        candidate("wer:AppCrash_dir", t + 60, "worldofwarships64.exe", 1),
        candidate("evt:460470", t, "worldofwarships64.exe", 0),
        // A different family never clusters with the WG client.
        candidate("evt:460471", t + 60, "korabli64.exe", 0),
        // An older standalone crash survives on its own.
        candidate("evt:460400", t - 3600, "worldofwarships64.exe", 0),
    ]);
    let ids: Vec<&str> = merged.iter().map(|c| c.evidence_id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["evt:460400", "evt:460470", "evt:460471"],
        "the event-log entry wins its cluster; distinct crashes keep their own records"
    );
    assert_eq!(
        merged[0].at_unix,
        t - 3600,
        "the import batch is chronological (prepend lands newest-first)"
    );
}

/// Two WG crash reports inside the cluster window are TWO crashes — the
/// observed relapse shape (2026-10-31: reports 81 s apart, one crash each,
/// the second a reconnect that died at battle load again). The cluster
/// merge used to swallow the older report whole.
#[cfg(windows)]
#[test]
fn backfill_merge_keeps_both_wgc_reports_of_two_distinct_crashes() {
    let t = 1_790_000_000;
    let merged = merge_backfill_candidates(vec![
        candidate(
            "wgc:WorldOfWarships64-2026-10-31_15-51-47.crash",
            t + 81,
            "worldofwarships64.exe",
            1,
        ),
        candidate(
            "wgc:WorldOfWarships64-2026-10-31_15-50-26.crash",
            t,
            "worldofwarships64.exe",
            1,
        ),
    ]);
    let ids: Vec<&str> = merged.iter().map(|c| c.evidence_id.as_str()).collect();
    assert_eq!(
        ids,
        vec![
            "wgc:WorldOfWarships64-2026-10-31_15-50-26.crash",
            "wgc:WorldOfWarships64-2026-10-31_15-51-47.crash",
        ],
        "two WG reports are two crashes — both import, chronological order kept"
    );
}

/// The exemption is pair-scoped: a WG report still merges into the OTHER
/// sources of the SAME crash, and cross-source pairs cluster as before.
#[cfg(windows)]
#[test]
fn backfill_merge_still_clusters_one_crash_across_wgc_and_event_log() {
    let t = 1_790_000_000;
    let merged = merge_backfill_candidates(vec![
        // One crash: its WG report lands 30 s after the event-log entry.
        candidate(
            "wgc:WorldOfWarships64-2026-10-31_15-50-26.crash",
            t + 30,
            "worldofwarships64.exe",
            1,
        ),
        candidate("evt:460470", t, "worldofwarships64.exe", 0),
        // The Event 1000 + 1001 pair of one crash still merges too.
        candidate("evt:460471", t + 5, "worldofwarships64.exe", 0),
    ]);
    let ids: Vec<&str> = merged.iter().map(|c| c.evidence_id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["evt:460471"],
        "cross-source evidence of one crash keeps importing once (one event-log entry survives)"
    );
}

#[test]
fn backfill_tombstones_roundtrip_cap_and_heal() {
    let dir = TempDir::new("tombstones");
    assert!(
        load_seen_in(dir.path()).is_empty(),
        "no file = no tombstones"
    );
    let ids: Vec<String> = (0..250).rev().map(|i| format!("evt:{i}")).collect();
    save_seen_in(dir.path(), &ids);
    let loaded = load_seen_in(dir.path());
    assert_eq!(loaded.len(), 250.min(BACKFILL_SEEN_CAP));
    assert_eq!(loaded.first().map(String::as_str), Some("evt:249"));
    assert_eq!(loaded.last().map(String::as_str), Some("evt:50"));
    // A damaged tombstone file resets to empty — the time-window dedupe
    // keeps holding the line until the next import rewrites it.
    super::super::appdata::write_json_in(dir.path(), BACKFILL_SEEN_FILE, "not json")
        .expect("write damaged");
    assert!(load_seen_in(dir.path()).is_empty());
}

/// The duplicate-artifact gate the live pass consults before appending: a
/// tombstoned evidence id means this crash is already recorded.
#[test]
fn evidence_already_known_matches_tombstoned_ids() {
    let dir = TempDir::new("evidence-known");
    let id = "wgc:WorldOfWarships64-2026-10-31_15-50-26.crash";
    assert!(!evidence_already_known(dir.path(), id));
    save_seen_in(dir.path(), &[id.to_string()]);
    assert!(evidence_already_known(dir.path(), id));
    assert!(!evidence_already_known(dir.path(), "evt:460470"));
}
#[cfg(windows)]
/// The registry lists the 32-bit image FIRST; the exact pass must win
/// over the fuzzy stem-contains pass or every 64-bit crash splits into
/// phantom candidates (the first-backfill double-import bug).
#[test]
fn attributed_image_prefers_the_exact_name_over_the_substring() {
    let events = parse_wevtutil_xml(evidence_parsers::EVENT_1000);
    let t = parse_rfc3339_unix("2026-10-27T18:52:13Z").unwrap();
    let window = (t - 30, t + 30);
    // 32-bit name first — the trap order.
    let images = vec![
        "worldofwarships.exe".to_string(),
        "worldofwarships64.exe".to_string(),
        "korabli.exe".to_string(),
    ];
    assert_eq!(
        attributed_image(&events[0], &images, window).as_deref(),
        Some("worldofwarships64.exe"),
        "the exact AppName match claims the event before any substring"
    );
}

/// A WER folder of the 64-bit client must not be claimed by the 32-bit
/// stem: the stem matches only as a delimited token.
#[test]
fn wer_name_mentions_requires_a_delimited_token() {
    let dir_64 = "appcrash_worldofwarships64.exe_deadbeef_1234";
    let dir_32 = "appcrash_worldofwarships.exe_deadbeef_1234";
    assert!(
        !wer_name_mentions(dir_64, "worldofwarships"),
        "the 32-bit stem must not claim a 64-bit report"
    );
    assert!(wer_name_mentions(dir_64, "worldofwarships64"));
    assert!(wer_name_mentions(dir_32, "worldofwarships"));
    assert!(wer_name_mentions(dir_32, ""));
    assert!(!wer_name_mentions("appcrash_qq.exe_1", "worldofwarships"));
}

// ── dangling-reference heuristics ─────────────────────────────────────────────

#[test]
fn dangling_urls_extract_from_both_loader_spellings() {
    let text = [
        "2026-10-28 16:49:56.021: ERROR: [Scaleform] Error: Unknown file format at URL \"gui/flash/battle_stats.swf\"",
        "2026-10-28 16:49:56.043: ERROR: [Scaleform Trace] [ERROR][SWF]: url:'battle_stats.swf'",
        "2026-10-28 16:49:55.293: ERROR: [Other] Removing unused block that seems to be added by mistake.",
        "2026-10-28 16:50:01.000: ERROR: [Scaleform] Error: Unknown file format at URL \"gui/flash/battle_stats.swf\"",
    ]
    .join("\n");
    let urls = dangling_urls_from_text(&text);
    assert_eq!(
        urls,
        vec![
            "gui/flash/battle_stats.swf".to_string(),
            "battle_stats.swf".to_string(),
        ],
        "both spellings extract, duplicates collapse in first-seen order"
    );
    assert!(dangling_urls_from_text("no urls here").is_empty());
}

#[test]
fn dangling_ref_suspects_pin_the_referencing_files() {
    let dir = TempDir::new("dangling");
    // The Aslain v1 shape: a battle_elements.xml override declaring the
    // unbound element hosted at the missing SWF.
    dir.touch(
        "bin/7/res_mods/gui/battle_elements.xml",
        "<element class=\"lesta.libs.unbound.UnboundElement\" url=\"battle_stats.swf\">",
    );
    // An unrelated text file never matches.
    dir.touch("bin/7/res_mods/gui/other.xml", "<nothing relevant>");
    // A second reference in another tree (the installer cache).
    dir.touch(
        "bin/7/res_mods/PnFMods/ModsInstaller_4_3_1/mods/SecondaryArmament.xml",
        "<element name=\"unboundSecondaryArmament\" url=\"battle_stats.swf\">",
    );
    // Binary-ish extensions are skipped entirely.
    dir.touch("bin/7/res_mods/gui/skip.swf", "battle_stats.swf");
    let base = dir.path().join("bin/7/res_mods");
    let urls = vec!["battle_stats.swf".to_string()];
    let suspects = dangling_ref_suspects(&base, &urls);
    let names: Vec<&str> = suspects.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "PnFMods/ModsInstaller_4_3_1/mods/SecondaryArmament.xml",
            "gui/battle_elements.xml",
        ],
        "sorted by path; only text files referencing the URL match"
    );
    assert_eq!(suspects[0].evidence, "danglingRef");
    assert_eq!(suspects[0].log_lines, urls);
}

#[test]
fn quarantine_accepts_nested_files_and_rejects_traversal() {
    let dir = TempDir::new("quarantine-nested");
    let root = dir.path().to_str().unwrap().to_string();
    dir.touch("bin/8/res_mods/gui/battle_elements.xml", "x");

    // Traversal and drive spellings are refused outright.
    assert!(mutate_quarantine(&root, "../escape.xml", None, true).is_err());
    assert!(mutate_quarantine(&root, "gui/../../escape.xml", None, true).is_err());
    assert!(mutate_quarantine(&root, "C:/evil.xml", None, true).is_err());
    assert!(mutate_quarantine(&root, "/abs.xml", None, true).is_err());

    // A nested FILE quarantines preserving its relative path, and restores.
    super::super::mod_hub::test_allow_game_root(&root);
    let entries = mutate_quarantine(&root, "gui/battle_elements.xml", Some("gc-9"), true)
        .expect("quarantine file");
    assert_eq!(entries[0].name, "gui/battle_elements.xml");
    assert!(
        !dir.path()
            .join("bin/8/res_mods/gui/battle_elements.xml")
            .exists()
    );
    assert!(
        dir.path()
            .join("bin/8/res_mods.wowsp-quarantine/gui/battle_elements.xml")
            .exists()
    );
    let entries =
        mutate_quarantine(&root, "gui/battle_elements.xml", None, false).expect("restore file");
    assert!(entries.is_empty());
    assert!(
        dir.path()
            .join("bin/8/res_mods/gui/battle_elements.xml")
            .exists()
    );
}

#[test]
fn findings_flag_dangling_ui_references_as_critical() {
    let record = sample_record("gc-dangling", None);
    let urls = vec!["gui/flash/battle_stats.swf".to_string()];
    let findings = build_findings(&record, &[], &[], &urls, false);
    let finding = findings
        .iter()
        .find(|f| f.code == "danglingUiReference")
        .expect("dangling reference flagged");
    assert_eq!(finding.severity, "critical");
    assert_eq!(
        finding.detail.as_deref(),
        Some("gui/flash/battle_stats.swf")
    );
}

// ── WG crash-report harvest ──────────────────────────────────────────────────

#[cfg(windows)]
#[test]
fn crash_report_image_discriminates_the_32_64_names() {
    let stems: Vec<String> = [
        "worldofwarships",
        "worldofwarships64",
        "korabli",
        "korabli64",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    assert_eq!(
        crash_report_image("WorldOfWarships64-2026-10-28_16-49-56.crash", &stems,).as_deref(),
        Some("worldofwarships64.exe"),
        "the 64-bit report belongs to the 64-bit image"
    );
    assert_eq!(
        crash_report_image("WorldOfWarships-2026-05-27_15-08-11.crash", &stems).as_deref(),
        Some("worldofwarships.exe"),
    );
    assert_eq!(
        crash_report_image("Korabli64-2026-01-01_00-00-00.crash", &stems).as_deref(),
        Some("korabli64.exe"),
    );
    assert_eq!(crash_report_image("something-else.crash", &stems), None);
}

/// A synthetic WG crash-handler report: first line names the app + crash
/// time, the Message block carries the actual cause.
#[cfg(windows)]
const REPORT_BODY: &str = concat!(
    "Application D:/SteamLibrary/steamapps/common/World of Warships/bin/123/bin64/WorldOfWarships64.exe crashed 10.31.2026 at 15:50:26\n",
    "\n",
    "Message:\n",
    "Unhandled exception\n"
);

/// The live pass must find a WG crash report written while the app was
/// running — the observed shape where WER/event-log handoff is suppressed
/// and <game>/crashes is the only durable evidence.
#[cfg(windows)]
#[test]
fn game_report_evidence_finds_the_in_window_report() {
    let dir = TempDir::new("game-report");
    let rel = "crashes/WorldOfWarships64-2026-10-31_15-50-26.crash";
    dir.touch(rel, REPORT_BODY);
    // The read_dir spelling (canonical separators), not the fixture's.
    let expected = dir
        .path()
        .join("crashes")
        .join("WorldOfWarships64-2026-10-31_15-50-26.crash");
    // An older in-window report: the newest wins.
    dir.touch(
        "crashes/WorldOfWarships64-2026-10-31_15-50-10.crash",
        "Application D:/.../WorldOfWarships64.exe crashed 10.31.2026 at 15:50:10\n\nMessage:\nOlder failure\n",
    );
    let at = unix_now();
    dir.set_mtime(
        "crashes/WorldOfWarships64-2026-10-31_15-50-10.crash",
        at - 5,
    );
    dir.set_mtime(rel, at);
    let window = (at - EVIDENCE_SLACK_SECS, at + EVIDENCE_SLACK_SECS);
    // A first root without a crashes folder must not abort the hunt.
    let roots = vec![
        dir.path().join("no-install").to_string_lossy().into_owned(),
        dir.path().to_string_lossy().into_owned(),
    ];
    let evidence =
        game_report_evidence("worldofwarships64.exe", &roots, window, None).expect("report found");
    assert_eq!(evidence.source, SOURCE_GAME_REPORT);
    assert_eq!(
        evidence.evidence_id.as_deref(),
        Some("wgc:WorldOfWarships64-2026-10-31_15-50-26.crash"),
        "the live id is the same identity the backfill uses"
    );
    assert_eq!(
        evidence.report_path.as_deref(),
        Some(expected.to_string_lossy().as_ref())
    );
    assert_eq!(
        evidence.summary, "Unhandled exception",
        "the Message block carries the cause"
    );
    assert!(evidence.dump_path.is_none());
}

/// The crash-dialog-left-open shape: the pid lingers for minutes after the
/// report was written, so last_seen (and the old window floor) sits far above
/// the report's mtime. The process' session start is the correct floor.
#[cfg(windows)]
#[test]
fn game_report_evidence_accepts_a_lingering_crashed_process() {
    let dir = TempDir::new("game-report-lingering");
    let root = vec![dir.path().to_string_lossy().into_owned()];
    dir.touch(
        "crashes/WorldOfWarships64-2026-10-31_15-50-26.crash",
        REPORT_BODY,
    );
    let start = unix_now() - 360;
    // The report was written a minute into the session; the process then
    // lingered five more minutes before the watchdog saw it vanish.
    dir.set_mtime(
        "crashes/WorldOfWarships64-2026-10-31_15-50-26.crash",
        start + 60,
    );
    let last_seen = start + 300;
    let window = (
        last_seen - EVIDENCE_SLACK_SECS,
        last_seen + EVIDENCE_SLACK_SECS,
    );
    // Without the session start the old lower bound misses it...
    assert!(game_report_evidence("worldofwarships64.exe", &root, window, None).is_none());
    // ...and the start time widens the floor correctly.
    let evidence = game_report_evidence("worldofwarships64.exe", &root, window, Some(start))
        .expect("lingering report found");
    assert_eq!(evidence.source, SOURCE_GAME_REPORT);
    assert_eq!(
        evidence.evidence_id.as_deref(),
        Some("wgc:WorldOfWarships64-2026-10-31_15-50-26.crash")
    );
}

/// Out-of-window reports and the other bitness' names never match.
#[cfg(windows)]
#[test]
fn game_report_evidence_ignores_out_of_window_and_cross_bit_report() {
    let dir = TempDir::new("game-report-filter");
    let root = vec![dir.path().to_string_lossy().into_owned()];
    let at = unix_now();
    let window = (at - 60, at + 60);
    // In the window but a 32-bit report name: the 64-bit image must not
    // claim it.
    dir.touch(
        "crashes/WorldOfWarships-2026-10-31_15-50-26.crash",
        REPORT_BODY,
    );
    dir.set_mtime("crashes/WorldOfWarships-2026-10-31_15-50-26.crash", at);
    // A 64-bit report name with a stale mtime: outside the window.
    dir.touch(
        "crashes/WorldOfWarships64-2026-10-20_10-00-00.crash",
        REPORT_BODY,
    );
    dir.set_mtime(
        "crashes/WorldOfWarships64-2026-10-20_10-00-00.crash",
        at - 3600,
    );
    assert!(game_report_evidence("worldofwarships64.exe", &root, window, None).is_none());
    // Mirror image: the 32-bit image must not claim the 64-bit report
    // (drop its own in-window 32-bit report first, or it would match that).
    fs::remove_file(
        dir.path()
            .join("crashes/WorldOfWarships-2026-10-31_15-50-26.crash"),
    )
    .expect("remove 32-bit report");
    dir.touch(
        "crashes/WorldOfWarships64-2026-10-31_15-51-47.crash",
        REPORT_BODY,
    );
    dir.set_mtime("crashes/WorldOfWarships64-2026-10-31_15-51-47.crash", at);
    assert!(game_report_evidence("worldofwarships.exe", &root, window, None).is_none());
    // A sibling that is not a .crash report never counts.
    dir.touch("crashes/WorldOfWarships64-notes.txt", REPORT_BODY);
    assert!(game_report_evidence("worldofwarships.exe", &root, window, None).is_none());
}

/// An empty crashes folder, a root without one, and no roots at all all
/// answer "no evidence" instead of panicking.
#[cfg(windows)]
#[test]
fn game_report_evidence_tolerates_missing_and_empty_folders() {
    let at = unix_now();
    let window = (at - 60, at + 60);
    let empty = TempDir::new("game-report-empty");
    fs::create_dir_all(empty.path().join("crashes")).expect("mkdirs");
    let roots = vec![empty.path().to_string_lossy().into_owned()];
    assert!(game_report_evidence("worldofwarships64.exe", &roots, window, None).is_none());
    let bare = TempDir::new("game-report-bare");
    let roots = vec![bare.path().to_string_lossy().into_owned()];
    assert!(game_report_evidence("worldofwarships64.exe", &roots, window, None).is_none());
    assert!(game_report_evidence("worldofwarships64.exe", &[], window, None).is_none());
}

/// Real reports are ~4.5 KB: the Message block sits near the TOP, while the
/// tail is a stack-trace fragment (the old tail read produced summaries like
/// ": WorldOfWarships64.exe!0x00007FF661CB52FC" — not a crash cause).
#[cfg(windows)]
#[test]
fn crash_report_summary_reads_the_message_block_at_the_top() {
    let dir = TempDir::new("game-report-summary");
    let mut body = String::from(REPORT_BODY);
    for i in 0..80 {
        body.push_str(&format!(
            "  {i}: WorldOfWarships64.exe!0x00007FF661CB52FC\n"
        ));
    }
    body.push_str("System info:\n");
    assert!(
        body.len() > 2048,
        "the fixture is a realistic oversized report"
    );
    let path = dir.touch("crashes/WorldOfWarships64-2026-10-31_15-51-47.crash", &body);
    assert_eq!(crash_report_summary(&path), "Unhandled exception");
}

/// The live-bug regression at the collector call site: dropping the
/// game-report hunt (or the root argument) must fail here, not just in the
/// helper's own tests.
#[cfg(windows)]
#[test]
fn collect_crash_evidence_finds_the_live_game_report() {
    let dir = TempDir::new("collect-evidence");
    let root = dir.path().to_string_lossy().into_owned();
    dir.touch(
        "crashes/WorldOfWarships64-2026-10-31_15-51-47.crash",
        REPORT_BODY,
    );
    let at = unix_now();
    dir.set_mtime("crashes/WorldOfWarships64-2026-10-31_15-51-47.crash", at);
    let exe = dir
        .path()
        .join("bin/123/bin64/WorldOfWarships64.exe")
        .to_string_lossy()
        .into_owned();
    let window = (at - EVIDENCE_SLACK_SECS, at + EVIDENCE_SLACK_SECS);
    let evidence = collect_crash_evidence(
        "worldofwarships64.exe",
        Some(&exe),
        Some(&root),
        Some(at - 120),
        4242,
        window,
    )
    .expect("the live pass finds the game's own crash report");
    assert_eq!(evidence.source, SOURCE_GAME_REPORT);
    assert_eq!(
        evidence.evidence_id.as_deref(),
        Some("wgc:WorldOfWarships64-2026-10-31_15-51-47.crash")
    );
    assert_eq!(evidence.summary, "Unhandled exception");
}

/// The live hunt's root chain: the vanished process' validated root first,
/// then the root its exe path implies — the install scan is only a last
/// resort (a multi-install machine must not guess with the root in hand).
#[cfg(windows)]
#[test]
fn live_game_roots_prefers_the_process_roots() {
    let exe = "C:\\Games\\WoWS\\bin\\123\\bin64\\WorldOfWarships64.exe";
    // The validated seen root wins; the exe-derived root is the same folder
    // spelled differently, so the list stays one entry.
    let roots = live_game_roots(Some(exe), Some("C:/Games/WoWS"));
    assert_eq!(roots.len(), 1);
    assert!(super::super::game_context::same_folder(
        &roots[0],
        "C:\\Games\\WoWS"
    ));
    // Without a validated root the exe-derived root still roots the hunt.
    let roots = live_game_roots(Some(exe), None);
    assert_eq!(roots, vec!["C:\\Games\\WoWS".to_string()]);
    // A root the exe resolves into that differs from the seen root is kept
    // after it, in preference order.
    let roots = live_game_roots(
        Some("D:\\Other\\bin\\1\\bin64\\WorldOfWarships64.exe"),
        Some("C:\\Games\\WoWS"),
    );
    assert_eq!(
        roots,
        vec!["C:\\Games\\WoWS".to_string(), "D:\\Other".to_string()]
    );
}

#[test]
fn quarantine_reaches_into_the_safe_mode_twin() {
    let dir = TempDir::new("quarantine-twin");
    let root = dir.path().to_str().unwrap().to_string();
    // Safe mode shape: the active res_mods is EMPTY (game-recreated), the
    // whole mod set lives in the twin — the crash-pinned file included.
    dir.touch("bin/8/res_mods/.keep", "");
    dir.touch(
        "bin/8/res_mods.wowsp-disabled/gui/battle_elements.xml",
        "<element url=battle_stats.swf>",
    );
    super::super::mod_hub::test_allow_game_root(&root);
    let entries = mutate_quarantine(&root, "gui/battle_elements.xml", None, true)
        .expect("quarantine from the twin");
    assert_eq!(entries[0].name, "gui/battle_elements.xml");
    assert!(
        dir.path()
            .join("bin/8/res_mods.wowsp-quarantine/gui/battle_elements.xml")
            .exists()
    );
    assert!(
        !dir.path()
            .join("bin/8/res_mods.wowsp-disabled/gui/battle_elements.xml")
            .exists()
    );
    // Restore lands in the ACTIVE res_mods (mods come back where the game reads them).
    mutate_quarantine(&root, "gui/battle_elements.xml", None, false).expect("restore");
    assert!(
        dir.path()
            .join("bin/8/res_mods/gui/battle_elements.xml")
            .exists()
    );
}

#[cfg(windows)]
#[test]
fn game_root_of_report_extracts_the_install() {
    let root = game_root_of_report(
        "D:\\SteamLibrary\\steamapps\\common\\World of Warships\\crashes\\WorldOfWarships64-2026-10-28_16-49-56.crash",
    );
    assert_eq!(
        root.as_deref(),
        Some("D:\\SteamLibrary\\steamapps\\common\\World of Warships"),
    );
    assert_eq!(game_root_of_report("D:\\elsewhere\\report.txt"), None);
}

// ── suspect management (ignore list + deletion target resolution) ───────────

#[test]
fn ignored_suspects_roundtrip_and_heal() {
    let dir = TempDir::new("ignored");
    assert!(
        load_ignored_in(dir.path()).is_empty(),
        "no file = empty list"
    );
    save_ignored_in(
        dir.path(),
        &[
            IgnoredSuspect {
                name: "gui/battle_elements.xml".to_string(),
                ignored_at: "2026-10-29T00:00:00Z".to_string(),
            },
            IgnoredSuspect {
                name: "PnFMods/Skin".to_string(),
                ignored_at: "2026-10-29T00:00:01Z".to_string(),
            },
        ],
    )
    .expect("save");
    let loaded = load_ignored_in(dir.path());
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0].name, "gui/battle_elements.xml");
    // A damaged file answers empty (the safe direction: warnings reappear).
    super::super::appdata::write_json_in(dir.path(), IGNORED_FILE, "not json")
        .expect("write damaged");
    assert!(load_ignored_in(dir.path()).is_empty());
}

#[test]
fn subject_tree_resolves_active_then_twin() {
    let dir = TempDir::new("subject-tree");
    let root = dir.path().to_str().unwrap().to_string();
    // Active tree wins.
    dir.touch("bin/8/res_mods/gui/a.xml", "x");
    assert_eq!(
        subject_tree(&root, "gui/a.xml").expect("active"),
        dir.path().join("bin/8/res_mods/gui/a.xml")
    );
    // A subject that only exists in the safe-mode twin resolves there.
    dir.touch("bin/8/res_mods.wowsp-disabled/gui/b.xml", "x");
    assert_eq!(
        subject_tree(&root, "gui/b.xml").expect("twin"),
        dir.path().join("bin/8/res_mods.wowsp-disabled/gui/b.xml")
    );
    // Nowhere = a clear error.
    assert!(subject_tree(&root, "gui/nope.xml").is_err());
}

// ── proactive dangling-reference scan ───────────────────────────────────────

#[cfg(windows)]
#[test]
fn swf_references_extract_from_mod_glue() {
    let text = r#"<element url="battle_stats.swf">
        <swffile>../unbound/mods/SecondaryArmament.swf</swffile>
        <path> gui/fonts/WoWsSymbol.ttf </path>
        <format>%s.swf</format>
        <notaref>icon_default.png</notaref>
    "#;
    let refs = swf_refs_in_text(text);
    assert!(refs.contains(&"battle_stats.swf".to_string()), "{refs:?}");
    assert!(
        refs.contains(&"secondaryarmament.swf".to_string()),
        "{refs:?}"
    );
    assert!(!refs.iter().any(|r| r.contains('%')), "{refs:?}");
    assert!(!refs.iter().any(|r| r.ends_with(".png")), "{refs:?}");
}

#[cfg(windows)]
#[test]
fn dangling_mod_references_flags_missing_and_ignores_present() {
    use std::collections::HashSet;
    let dir = TempDir::new("proactive-scan");
    dir.touch("gui/battle_elements.xml", "<element url=battle_stats.swf>");
    dir.touch("gui/other.xml", "<element url=main_hud.swf>");
    let mut client = HashSet::new();
    client.insert("main_hud.swf".to_string());
    let refs = dangling_mod_references(&[dir.path().to_path_buf()], &client);
    assert_eq!(refs.len(), 1, "{refs:?}");
    assert_eq!(refs[0].asset, "battle_stats.swf");
    assert!(refs[0].files[0].contains("battle_elements.xml"));
}

#[cfg(windows)]
#[test]
fn proactive_scan_skips_toolchain_stubs() {
    use std::collections::HashSet;
    let dir = TempDir::new("proactive-noise");
    // A placeholder stub reference in a normal mod file is ignored by name.
    dir.touch(
        "PnFMods/SomeMod/Main.py",
        "stub = \"__forge_stub.swf\"\nlive = \"battle_stats.swf\"\n",
    );
    // A file inside the ModForge toolkit tree is not scanned at all.
    dir.touch(
        "PnFMods/ModForge/Validate.py",
        "x = \"forgedefinitions.swf\"\n",
    );
    let client = HashSet::new();
    let refs = dangling_mod_references(&[dir.path().to_path_buf()], &client);
    let assets: Vec<&str> = refs.iter().map(|r| r.asset.as_str()).collect();
    assert!(assets.contains(&"battle_stats.swf"), "{assets:?}");
    assert!(!assets.contains(&"__forge_stub.swf"), "{assets:?}");
    assert!(!assets.contains(&"forgedefinitions.swf"), "{assets:?}");
}

// ── the pending-record reset (clean-exit + manual dismiss-all) ───────────────

#[test]
fn dismiss_all_resets_only_the_new_records() {
    let dir = TempDir::new("dismiss-all");
    let root = dir.path().to_string_lossy().into_owned();
    append_record_in(dir.path(), &sample_record("gc-keep-new", Some(&root))).unwrap();
    let mut settled = sample_record("gc-already-dismissed", Some(&root));
    settled.status = STATUS_DISMISSED.to_string();
    append_record_in(dir.path(), &settled).unwrap();

    let flipped = dismiss_new_records_in(dir.path()).unwrap();
    assert_eq!(flipped.len(), 1, "{flipped:?}");
    assert_eq!(flipped[0].id, "gc-keep-new");
    assert_eq!(flipped[0].status, STATUS_DISMISSED);

    let records = load_history_in(dir.path()).unwrap().unwrap();
    let status_of = |id: &str| {
        records
            .iter()
            .find(|r| r.id == id)
            .unwrap_or_else(|| panic!("{id} missing"))
            .status
            .clone()
    };
    assert_eq!(status_of("gc-keep-new"), STATUS_DISMISSED);
    assert_eq!(status_of("gc-already-dismissed"), STATUS_DISMISSED);

    // Idempotent: a second pass over the settled history flips nothing.
    assert!(dismiss_new_records_in(dir.path()).unwrap().is_empty());
}

#[test]
fn dismiss_all_without_history_is_an_empty_ok() {
    let dir = TempDir::new("dismiss-all-no-file");
    assert!(dismiss_new_records_in(dir.path()).unwrap().is_empty());
}

#[test]
fn dismiss_all_survives_a_backfill_only_tombstone_dir() {
    // The seen-file alone (no history yet) must not error the reset — the
    // backfill may have run before any record existed.
    let dir = TempDir::new("dismiss-all-seen-only");
    save_seen_in(dir.path(), &["evt:42".to_string()]);
    assert!(dismiss_new_records_in(dir.path()).unwrap().is_empty());
    assert_eq!(load_seen_in(dir.path()), vec!["evt:42".to_string()]);
}

// ── the read watermark (mark viewed) ─────────────────────────────────────────

/// A synthetic crash record pinned to an explicit detection time — the
/// watermark scans the persisted newest-first order, so tests need
/// deterministic timestamps (sample_record uses "now" for every row).
fn record_at(id: &str, at: &str) -> GameCrashRecord {
    let mut record = sample_record(id, None);
    record.detected_at = at.to_string();
    record
}

#[test]
fn mark_viewed_flips_the_record_and_every_older_one() {
    let dir = TempDir::new("mark-viewed");
    // Append oldest first; append_record_in keeps the file newest-first.
    append_record_in(dir.path(), &record_at("gc-old", "2026-10-27T08:00:00Z")).unwrap();
    append_record_in(dir.path(), &record_at("gc-mid", "2026-10-28T08:00:00Z")).unwrap();
    append_record_in(dir.path(), &record_at("gc-new", "2026-10-29T08:00:00Z")).unwrap();

    // Viewing the NEWEST retires it and everything older in one pass —
    // the exact complaint the watermark answers (an older unviewed crash
    // must not re-toast once the newest was seen).
    let flipped = mark_viewed_in(dir.path(), "gc-new").unwrap();
    let flipped_ids: Vec<&str> = flipped.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(flipped_ids, vec!["gc-new", "gc-mid", "gc-old"]);

    let records = load_history_in(dir.path()).unwrap().unwrap();
    assert!(
        records.iter().all(|r| r.status == STATUS_DISMISSED),
        "{records:?}"
    );

    // Settled history: a second pass flips nothing (idempotent).
    assert!(mark_viewed_in(dir.path(), "gc-new").unwrap().is_empty());
}

#[test]
fn mark_viewed_watermarks_from_the_marked_record_down() {
    let dir = TempDir::new("mark-viewed-mid");
    append_record_in(dir.path(), &record_at("gc-old", "2026-10-27T08:00:00Z")).unwrap();
    append_record_in(dir.path(), &record_at("gc-mid", "2026-10-28T08:00:00Z")).unwrap();
    append_record_in(dir.path(), &record_at("gc-new", "2026-10-29T08:00:00Z")).unwrap();

    // Marking a MIDDLE record retires its own tail (itself + older); the
    // newer record keeps its pending state.
    let flipped = mark_viewed_in(dir.path(), "gc-mid").unwrap();
    let flipped_ids: Vec<&str> = flipped.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(flipped_ids, vec!["gc-mid", "gc-old"]);

    let records = load_history_in(dir.path()).unwrap().unwrap();
    let status_of = |id: &str| {
        records
            .iter()
            .find(|r| r.id == id)
            .unwrap_or_else(|| panic!("{id} missing"))
            .status
            .clone()
    };
    assert_eq!(
        status_of("gc-new"),
        STATUS_NEW,
        "newer records stay pending"
    );
    assert_eq!(status_of("gc-mid"), STATUS_DISMISSED);
    assert_eq!(status_of("gc-old"), STATUS_DISMISSED);
}

#[test]
fn mark_viewed_without_history_is_an_empty_ok_and_missing_id_errors() {
    let dir = TempDir::new("mark-viewed-missing");
    // No history file yet — nothing to flip, no error (the command runs
    // unconditionally on every target, like game_crash_list).
    assert!(mark_viewed_in(dir.path(), "gc-none").unwrap().is_empty());
    append_record_in(dir.path(), &record_at("gc-1", "2026-10-29T08:00:00Z")).unwrap();
    // A stale UI marking a purged record must learn it is gone.
    assert!(mark_viewed_in(dir.path(), "gc-missing").is_err());
}

#[cfg(windows)]
#[test]
fn backfill_imports_older_than_a_known_crash_are_born_dismissed() {
    let at = |iso: &str| parse_rfc3339_unix(iso).unwrap();
    let history = vec![record_at("gc-known", "2026-10-29T08:00:00Z")];

    // A harvest NEWER than everything known is genuinely news: born new.
    assert!(!import_superseded_by_newer(
        &history,
        &[],
        at("2026-10-30T08:00:00Z")
    ));
    // An OLDER harvest is born dismissed — the seen newer crash owns the
    // prompt; the stale one must not re-toast on boot.
    assert!(import_superseded_by_newer(
        &history,
        &[],
        at("2026-10-28T08:00:00Z")
    ));
    // The helper also honors in-pass imports (a guard the current
    // oldest-first loop cannot trigger, but the signature promises).
    let imported = vec![record_at("gc-pass", "2026-10-30T08:00:00Z")];
    assert!(import_superseded_by_newer(
        &history,
        &imported,
        at("2026-10-29T12:00:00Z")
    ));
    // Unparseable timestamps never claim supersession.
    let broken = vec![record_at("gc-broken", "not a date")];
    assert!(!import_superseded_by_newer(
        &broken,
        &[],
        at("2026-10-28T08:00:00Z")
    ));
    // An empty history imports everything as news (first-ever boot).
    assert!(!import_superseded_by_newer(
        &[],
        &[],
        at("2026-10-28T08:00:00Z")
    ));
}
