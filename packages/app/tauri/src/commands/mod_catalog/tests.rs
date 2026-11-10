mod tests {
    use std::fs;
    use std::path::Path;

    // The file kept its historical inner `mod tests` wrapper; the parent
    // module is therefore TWO levels up, not one.
    use crate::commands::mod_catalog::*;

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"x").unwrap();
    }

    fn zip_fixture(path: &Path, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            zip.start_file(*name, opts).unwrap();
            std::io::Write::write_all(&mut zip, data).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn extracts_zip_and_records_paths() {
        let tmp = std::env::temp_dir().join("wowsp_zipx_test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        zip_fixture(
            &tmp.join("pack.zip"),
            &[
                ("res_mods/gui/a.png", b"a"),
                ("res_mods/ime_config.xml", b"<x/>"),
            ],
        );
        let dest = tmp.join("out");
        let mut visited = Vec::new();
        extract_zip(&tmp.join("pack.zip"), &dest, &mut visited).unwrap();
        assert!(dest.join("res_mods/gui/a.png").is_file());
        assert!(dest.join("res_mods/ime_config.xml").is_file());
        assert_eq!(visited.len(), 2);

        // `..`-escaping entries are skipped, not followed.
        zip_fixture(
            &tmp.join("evil.zip"),
            &[("../evil.txt", b"x"), ("ok.txt", b"y")],
        );
        let mut visited2 = Vec::new();
        extract_zip(&tmp.join("evil.zip"), &tmp.join("out2"), &mut visited2).unwrap();
        assert!(!tmp.join("evil.txt").exists());
        assert_eq!(visited2, vec!["ok.txt"]);
        fs::remove_dir_all(&tmp).ok();
    }

    /// Audit M-11: the extraction budgets abort hostile archives. Tiny
    /// seam caps stand in for multi-GB fixtures; each sub-case breaches a
    /// different cap (entries / per-file / total). The seam lock must be
    /// RELEASED around every `extract_zip` call — it is the SAME mutex the
    /// production path takes (a held guard would self-deadlock).
    #[test]
    fn extraction_caps_abort_hostile_archives() {
        let tmp = std::env::temp_dir().join("wowsp_zipx_caps_test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let dest = tmp.join("out");

        // Entries: a third entry trips the 2-entry cap.
        *TEST_EXTRACT_CAPS.lock().unwrap() = Some((2, 1024, 1024));
        zip_fixture(
            &tmp.join("many.zip"),
            &[("a.txt", b"1"), ("b.txt", b"2"), ("c.txt", b"3")],
        );
        let err = extract_zip(&tmp.join("many.zip"), &dest, &mut Vec::new()).unwrap_err();
        assert!(err.to_string().contains("too many entries"), "{err}");

        // Per-file: one 2 KB file against a 1 KB cap.
        *TEST_EXTRACT_CAPS.lock().unwrap() = Some((100, 1024, 1024));
        zip_fixture(&tmp.join("big.zip"), &[("big.bin", &[0u8; 2048])]);
        let err = extract_zip(&tmp.join("big.zip"), &dest, &mut Vec::new()).unwrap_err();
        assert!(err.to_string().contains("per-file extraction cap"), "{err}");

        // Total: two files that are each fine but sum past the cap.
        *TEST_EXTRACT_CAPS.lock().unwrap() = Some((100, 1024, 1536));
        zip_fixture(
            &tmp.join("sum.zip"),
            &[("a.bin", &[0u8; 1024]), ("b.bin", &[0u8; 1024])],
        );
        let err = extract_zip(&tmp.join("sum.zip"), &dest, &mut Vec::new()).unwrap_err();
        assert!(err.to_string().contains("total extraction cap"), "{err}");

        // Seam cleared: the same archives extract without the caps.
        *TEST_EXTRACT_CAPS.lock().unwrap() = None;
        for archive in ["many.zip", "big.zip", "sum.zip"] {
            extract_zip(&tmp.join(archive), &dest, &mut Vec::new()).unwrap();
        }
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn catalog_workspaces_are_exclusive_and_clean_up_only_their_own_directory() {
        let tmp = std::env::temp_dir().join(format!("wowsp-workdir-test-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let first = WorkDir::create(&tmp).unwrap();
        let second = WorkDir::create(&tmp).unwrap();
        let first_path = first.0.clone();
        assert_eq!(first.0.parent(), Some(tmp.as_path()));
        assert_eq!(second.0.parent(), Some(tmp.as_path()));
        assert_ne!(first.0, second.0);
        fs::write(second.0.join("keep.txt"), b"second download").unwrap();
        drop(first);
        assert!(!first_path.exists());
        assert_eq!(
            fs::read(second.0.join("keep.txt")).unwrap(),
            b"second download"
        );
        drop(second);
        fs::remove_dir(&tmp).unwrap();
    }

    #[test]
    fn catalog_package_names_cannot_select_an_archive_outside_the_workspace() {
        let tmp =
            std::env::temp_dir().join(format!("wowsp-catalog-path-test-{}", std::process::id()));
        let work = tmp.join("work");
        fs::create_dir_all(work.join("00-stage")).unwrap();
        let game = tmp.join("game");
        fs::create_dir_all(game.join("bin/1")).unwrap();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        zip_fixture(
            &tmp.join("outside.zip"),
            &[("res_mods/gui/payload.png", b"outside archive")],
        );
        let packages = vec![CatalogPackage {
            url: "https://example.com/package.zip".into(),
            name: "stage/../../outside.zip".into(),
            size: 0,
            sha256: String::new(),
        }];
        assert!(
            unpack_and_install(
                "example",
                "Example mod",
                &work,
                &game.to_string_lossy(),
                &packages,
                &[],
                &mut Vec::new()
            )
            .is_err(),
            "a catalog name must not select an archive outside the workspace"
        );
        assert!(!game.join("bin/1/res_mods/gui/payload.png").exists());
        zip_fixture(
            &package_archive(&work, 0),
            &[("res_mods/gui/payload.png", b"workspace archive")],
        );
        unpack_and_install(
            "example",
            "Example mod",
            &work,
            &game.to_string_lossy(),
            &packages,
            &[],
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(
            fs::read(game.join("bin/1/res_mods/gui/payload.png")).unwrap(),
            b"workspace archive"
        );
        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn invalid_reinstall_preserves_existing_files_record_and_backups() {
        for valid_zip in [false, true] {
            let tmp = std::env::temp_dir().join(format!(
                "wowsp-catalog-reinstall-test-{}-{valid_zip}",
                std::process::id()
            ));
            let work = tmp.join("work");
            let game = tmp.join("game");
            let rm = game.join("bin/1/res_mods");
            let restore = tmp.join("restore");
            fs::create_dir_all(rm.join("gui")).unwrap();
            fs::create_dir_all(restore.join("gui")).unwrap();
            fs::create_dir_all(&work).unwrap();
            fs::write(rm.join("gui/a.png"), b"installed version").unwrap();
            fs::write(restore.join("gui/a.png"), b"original").unwrap();
            if valid_zip {
                zip_fixture(&package_archive(&work, 0), &[("README.txt", b"not a mod")]);
            } else {
                fs::write(package_archive(&work, 0), b"not a zip").unwrap();
            }
            let mut installs = vec![ModInstallRecord {
                id: "example".into(),
                name: "Example".into(),
                version: "1".into(),
                category: "battle".into(),
                source: "mod-hub".into(),
                discussion: None,
                preset: None,
                bin_version: "1".into(),
                installed_at: String::new(),
                files: vec!["gui/a.png".into()],
                restore_dir: Some(restore.to_string_lossy().into_owned()),
                game_root: game.to_string_lossy().into_owned(),
                hashes: None,
                snapshot_hashes: None,
                shared_roots: Vec::new(),
            }];
            let packages = vec![CatalogPackage {
                url: "https://example.com/pack.zip".into(),
                name: "pack.zip".into(),
                size: 0,
                sha256: String::new(),
            }];
            let before = serde_json::to_value(&installs).unwrap();
            assert!(
                unpack_and_install(
                    "example",
                    "Example mod",
                    &work,
                    &game.to_string_lossy(),
                    &packages,
                    &[],
                    &mut installs,
                )
                .is_err()
            );
            assert_eq!(
                fs::read(rm.join("gui/a.png")).unwrap(),
                b"installed version"
            );
            assert_eq!(fs::read(restore.join("gui/a.png")).unwrap(), b"original");
            assert_eq!(serde_json::to_value(&installs).unwrap(), before);
            fs::remove_dir_all(&tmp).unwrap();
        }
    }

    #[test]
    fn unpack_and_install_full_pipeline() {
        // Exercises the whole catalog install leg without network: two part
        // archives -> unpack -> res_mods peel -> classify -> install, plus a
        // loose game-root DLL, with the written list the ledger stores.
        let tmp = std::env::temp_dir().join("wowsp_catalog_pipeline");
        let _ = fs::remove_dir_all(&tmp);
        let work = tmp.join("work");
        fs::create_dir_all(&work).unwrap();
        zip_fixture(
            &package_archive(&work, 0),
            &[
                ("res_mods/gui/x/a.png", b"a"),
                ("res_mods/ime_config.xml", b"<ime/>"),
            ],
        );
        // Real-shape game-root payload (gettext_x64r.dll on text mods).
        zip_fixture(&package_archive(&work, 1), &[("gettext_x64r.dll", b"dll")]);
        // Asset names are labels; stored archives use private ordinal names.
        let mk = |name: &str| CatalogPackage {
            url: format!("https://example.com/{name}"),
            sha256: String::new(),
            size: 0,
            name: name.into(),
        };
        let packages = vec![mk("part1.zip"), mk("part2.zip")];
        let game = tmp.join("game/bin/1");
        fs::create_dir_all(&game).unwrap();
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));

        let mod_hub::PlanApply {
            report,
            written,
            restore_dir: restore,
            ..
        } = unpack_and_install(
            "test-mod",
            "Test mod",
            &work,
            &game_root,
            &packages,
            &[],
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(report.bin_version, "1");
        let res_mods = tmp.join("game/bin/1/res_mods");
        assert!(res_mods.join("gui/x/a.png").is_file());
        assert!(res_mods.join("ime_config.xml").is_file());
        assert!(tmp.join("game/gettext_x64r.dll").is_file());
        assert!(written.contains(&"ime_config.xml".to_string()));
        assert!(written.contains(&"gui/x/a.png".to_string()));
        assert!(written.contains(&"@game/gettext_x64r.dll".to_string()));
        assert!(restore.is_none(), "fresh install overwrites nothing");

        // Re-install over it: the overwritten originals must be snapshotted.
        let mod_hub::PlanApply {
            restore_dir: restore2,
            ..
        } = unpack_and_install(
            "test-mod",
            "Test mod",
            &work,
            &game_root,
            &packages,
            &[],
            &mut Vec::new(),
        )
        .unwrap();
        let restore2 = restore2.expect("second install snapshots overwritten files");
        assert!(restore2.join("ime_config.xml").is_file());
        assert!(restore2.join("@game/gettext_x64r.dll").is_file());

        // Uninstall removes both roots and restores the snapshots.
        let mut installs = vec![ModInstallRecord {
            id: "test-mod".into(),
            name: "test".into(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: written,
            restore_dir: Some(restore2.to_string_lossy().into_owned()),
            game_root: String::new(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        }];
        let removed = uninstall_from_ledger(&mut installs, "test-mod", &game_root).unwrap();
        assert_eq!(removed.removed_files, 3);
        // All three overwrite victims (both res_mods files + the game-root
        // DLL) come back as install #1's copies: nested snapshots now
        // actually happen — the old best-effort copy silently skipped them
        // whenever the snapshot parent directory did not exist yet.
        assert_eq!(removed.restored_files, 3);
        assert!(res_mods.join("ime_config.xml").is_file());
        assert_eq!(
            fs::read(res_mods.join("ime_config.xml")).unwrap(),
            b"<ime/>"
        );
        assert!(res_mods.join("gui/x/a.png").is_file());
        assert_eq!(fs::read(tmp.join("game/gettext_x64r.dll")).unwrap(), b"dll");
        assert!(installs.is_empty());

        fs::remove_dir_all(&tmp).ok();
        fs::remove_dir_all(mod_hub::restore_root()).ok();
    }

    #[test]
    fn uninstall_removes_disabled_bak_twins() {
        // A mod disabled through the hub lives as `.bak` twins; uninstalling
        // it must remove those too — otherwise the next scan resurrects a
        // ghost unit and the files linger in res_mods forever.
        let tmp = std::env::temp_dir().join("wowsp_twin_uninstall");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("game/bin/1/res_mods/gui");
        fs::create_dir_all(&rm).unwrap();
        fs::write(rm.join("a.png.bak"), b"disabled").unwrap();
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let mut installs = vec![ModInstallRecord {
            id: "m".into(),
            name: "M".into(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: vec!["gui/a.png".into()],
            restore_dir: None,
            game_root: String::new(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        }];
        let report = uninstall_from_ledger(&mut installs, "m", &game_root).unwrap();
        assert_eq!(report.removed_files, 1);
        assert!(!rm.join("a.png.bak").exists());
        assert!(installs.is_empty());
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn reinstall_rewinds_to_vanilla_baseline() {
        // The catalog install rewinds the previous record before writing the
        // new one. This test drives the exact sequence the command performs:
        // after v1 → rewind → v2, the final uninstall must restore the
        // VANILLA file, not v1's modded copy (the old chained-snapshot bug).
        let tmp = std::env::temp_dir().join("wowsp_rewind_reinstall");
        let _ = fs::remove_dir_all(&tmp);
        let game = tmp.join("game/bin/1/res_mods");
        fs::create_dir_all(&game).unwrap();
        fs::write(game.join("ime_config.xml"), b"vanilla").unwrap();
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));

        let run = |work: &Path, ime: &[u8], gui: &str| {
            fs::create_dir_all(work).unwrap();
            zip_fixture(
                &package_archive(work, 0),
                &[("res_mods/ime_config.xml", ime), (gui.as_ref(), b"g")],
            );
            let packages = vec![CatalogPackage {
                url: "https://example.com/part1.zip".into(),
                sha256: String::new(),
                size: 0,
                name: "part1.zip".into(),
            }];
            unpack_and_install("m", "M", work, &game_root, &packages, &[], &mut Vec::new()).unwrap()
        };

        // v1 adds a file the v2 package drops — leftovers must not survive.
        let mod_hub::PlanApply {
            written: written1,
            restore_dir: restore1,
            ..
        } = run(&tmp.join("work1"), b"v1", "res_mods/gui/keep1.png");
        let mut installs = vec![ModInstallRecord {
            id: "m".into(),
            name: "m".into(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: written1,
            restore_dir: restore1.map(|p| p.to_string_lossy().into_owned()),
            game_root: String::new(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        }];

        // Reinstall: rewind the old record first (exactly what
        // `mod_catalog_install` now does before unpacking the new version).
        uninstall_from_ledger(&mut installs, "m", &game_root).unwrap();
        assert_eq!(fs::read(game.join("ime_config.xml")).unwrap(), b"vanilla");
        assert!(
            !game.join("gui/keep1.png").exists(),
            "dropped files must go"
        );

        let mod_hub::PlanApply {
            written: written2,
            restore_dir: restore2,
            ..
        } = run(&tmp.join("work2"), b"v2", "res_mods/gui/keep2.png");
        installs.push(ModInstallRecord {
            id: "m".into(),
            name: "m".into(),
            version: "2".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: written2,
            restore_dir: restore2.map(|p| p.to_string_lossy().into_owned()),
            game_root: String::new(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        });

        // Final uninstall rewinds to VANILLA, not to v1.
        uninstall_from_ledger(&mut installs, "m", &game_root).unwrap();
        assert_eq!(fs::read(game.join("ime_config.xml")).unwrap(), b"vanilla");
        assert!(!game.join("gui/keep2.png").exists());

        fs::remove_dir_all(&tmp).ok();
        fs::remove_dir_all(mod_hub::restore_root()).ok();
    }

    /// Download-time failure regression, part 2: reinstalling an OLDER record
    /// must not be blocked by a newer record that shares a support file. The
    /// reinstall rewind keeps the newer owner's bytes and only rewinds what
    /// this record exclusively owns; the strict user-uninstall guard must
    /// still refuse the same pair.
    #[test]
    fn reinstall_rewind_keeps_files_a_newer_record_owns() {
        let tmp = std::env::temp_dir().join("wowsp_reinstall_shared_rewind");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("game/bin/1/res_mods/gui");
        fs::create_dir_all(&rm).unwrap();
        fs::write(rm.join("shared.css"), b"newer b bytes").unwrap();
        fs::write(rm.join("only-a.css"), b"a v1 bytes").unwrap();
        let restore_a = tmp.join("restore-a");
        fs::create_dir_all(restore_a.join("gui")).unwrap();
        fs::write(restore_a.join("gui/shared.css"), b"vanilla shared").unwrap();
        fs::write(restore_a.join("gui/only-a.css"), b"vanilla only").unwrap();
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let mk = |id: &str, files: &[&str], restore: Option<&Path>| ModInstallRecord {
            id: id.into(),
            name: id.to_uppercase(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: files.iter().map(|f| (*f).to_string()).collect(),
            restore_dir: restore.map(|p| p.to_string_lossy().into_owned()),
            game_root: String::new(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        };
        let mut installs = vec![
            mk("a", &["gui/shared.css", "gui/only-a.css"], Some(&restore_a)),
            mk("b", &["gui/shared.css"], None),
        ];

        // The strict user-uninstall path still refuses the shared claim.
        let err = validate_uninstall_order(&installs, "a", &game_root).unwrap_err();
        assert!(err.to_string().contains("shares gui/shared.css"), "{err}");

        let report = rewind_for_reinstall(&mut installs, "a", &game_root).unwrap();
        // Only only-a.css was removed, and its vanilla snapshot came back.
        assert_eq!(report.removed_files, 1);
        assert_eq!(report.restored_files, 1);
        assert_eq!(fs::read(rm.join("shared.css")).unwrap(), b"newer b bytes");
        assert_eq!(fs::read(rm.join("only-a.css")).unwrap(), b"vanilla only");
        assert_eq!(installs.len(), 1);
        assert_eq!(installs[0].id, "b");
        fs::remove_dir_all(&tmp).ok();
    }

    /// Pre-release mirror fan-out: a reinstall must keep the mirrored copy of
    /// a file another record on the live bin owns, and only remove the
    /// exclusively-owned paths from the PTS twin.
    #[test]
    fn reinstall_rewind_keeps_shared_files_in_preload_mirrors() {
        let tmp = std::env::temp_dir().join("wowsp_reinstall_mirror_rewind");
        let _ = fs::remove_dir_all(&tmp);
        let game = tmp.join("game");
        let live = game.join("bin/100/res_mods/gui");
        let mirror = game.join("bin/200/res_mods/gui");
        fs::create_dir_all(&live).unwrap();
        fs::create_dir_all(&mirror).unwrap();
        fs::create_dir_all(game.join("bin/200/idx")).unwrap();
        fs::write(live.join("shared.css"), b"live shared").unwrap();
        fs::write(live.join("only-a.css"), b"live only").unwrap();
        fs::write(mirror.join("shared.css"), b"mirror shared").unwrap();
        fs::write(mirror.join("only-a.css"), b"mirror only").unwrap();
        // The pin names bin/100 as live; bin/200 is the staged pre-release
        // twin every mutation is mirrored into.
        fs::write(
            game.join("preferences.xml"),
            "<root><last_server_version> 15,8,0,100 </last_server_version></root>",
        )
        .unwrap();
        let game_root = game.to_string_lossy().into_owned();
        let mk = |id: &str, files: &[&str]| ModInstallRecord {
            id: id.into(),
            name: id.to_uppercase(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "100".into(),
            installed_at: String::new(),
            files: files.iter().map(|f| (*f).to_string()).collect(),
            restore_dir: None,
            game_root: String::new(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        };
        let mut installs = vec![
            mk("a", &["gui/shared.css", "gui/only-a.css"]),
            mk("b", &["gui/shared.css"]),
        ];
        rewind_for_reinstall(&mut installs, "a", &game_root).unwrap();
        assert!(
            mirror.join("shared.css").is_file(),
            "a newer owner still mirrors the shared file"
        );
        assert!(
            !mirror.join("only-a.css").exists(),
            "the exclusively-owned file leaves the twin"
        );
        assert!(installs.iter().all(|r| r.id != "a"));
        fs::remove_dir_all(&tmp).ok();
    }

    /// Drive a catalog reinstall of id "a" whose package rewrites
    /// res_mods/gui/shared.css with `bytes` (shared by the snapshot-refresh
    /// assertions below).
    fn reinstall_shared_css(
        work: &Path,
        game_root: &str,
        installs: &mut Vec<ModInstallRecord>,
        bytes: &str,
    ) {
        fs::create_dir_all(work).unwrap();
        zip_fixture(
            &package_archive(work, 0),
            &[("res_mods/gui/shared.css", bytes.as_bytes())],
        );
        let packages = vec![CatalogPackage {
            url: "https://example.com/part.zip".into(),
            sha256: String::new(),
            size: 0,
            name: "part.zip".into(),
        }];
        unpack_and_install("a", "A", work, game_root, &packages, &[], installs).unwrap();
    }

    /// Reinstalling an older owner must refresh a NEWER owner's snapshot of
    /// the shared file it rewrote (otherwise that mod's later uninstall would
    /// restore the previous version). The inverse must hold too: an older
    /// record's snapshot may hold the vanilla original and must stay
    /// untouched when the newer owner is reinstalled.
    #[test]
    fn reinstall_refreshes_newer_snapshots_only() {
        let tmp = std::env::temp_dir().join("wowsp_reinstall_snapshot_refresh");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("game/bin/1/res_mods/gui");
        fs::create_dir_all(&rm).unwrap();
        fs::write(rm.join("shared.css"), b"b v1").unwrap();
        let restore_a = tmp.join("restore-a");
        fs::create_dir_all(restore_a.join("gui")).unwrap();
        fs::write(restore_a.join("gui/shared.css"), b"vanilla shared").unwrap();
        let restore_b = tmp.join("restore-b");
        fs::create_dir_all(restore_b.join("gui")).unwrap();
        fs::write(restore_b.join("gui/shared.css"), b"a v1").unwrap();
        let restore_d = tmp.join("restore-d");
        fs::create_dir_all(restore_d.join("gui")).unwrap();
        fs::write(restore_d.join("gui/shared.css"), b"d stale").unwrap();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let mk = |id: &str, bin: &str, restore: &Path| ModInstallRecord {
            id: id.into(),
            name: id.to_uppercase(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: bin.into(),
            installed_at: String::new(),
            files: vec!["gui/shared.css".into()],
            restore_dir: Some(restore.to_string_lossy().into_owned()),
            game_root: String::new(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        };
        let mut installs = vec![
            mk("a", "1", &restore_a),
            mk("b", "1", &restore_b),
            // Owns the same spelling at ANOTHER bin's res_mods: physically
            // different files, so its snapshot must not be refreshed.
            mk("d", "0", &restore_d),
        ];

        // Reinstall the OLDER owner: B's snapshot follows the new bytes.
        reinstall_shared_css(&tmp.join("work1"), &game_root, &mut installs, "a v2");
        assert_eq!(fs::read(rm.join("shared.css")).unwrap(), b"a v2");
        assert_eq!(fs::read(restore_b.join("gui/shared.css")).unwrap(), b"a v2");
        assert_eq!(
            fs::read(restore_d.join("gui/shared.css")).unwrap(),
            b"d stale"
        );
        assert!(installs.iter().all(|r| r.id != "a"));

        // Now A is newer than B: reinstalling it must NOT touch B's snapshot.
        installs.push(mk("a", "1", &tmp.join("restore-a2")));
        reinstall_shared_css(&tmp.join("work2"), &game_root, &mut installs, "a v3");
        assert_eq!(fs::read(rm.join("shared.css")).unwrap(), b"a v3");
        assert_eq!(
            fs::read(restore_b.join("gui/shared.css")).unwrap(),
            b"a v2",
            "an older record's snapshot must keep the bytes it captured"
        );
        fs::remove_dir_all(&tmp).ok();
        fs::remove_dir_all(mod_hub::restore_root()).ok();
    }

    #[test]
    fn uninstall_drops_shared_loader_only_when_last() {
        // The 0-byte loader marker is ref-counted across records; a
        // non-empty foreign loader is never ours to remove.
        let tmp = std::env::temp_dir().join("wowsp_loader_refcount");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("game/bin/1/res_mods");
        fs::create_dir_all(rm.join("PnFMods/A")).unwrap();
        fs::create_dir_all(rm.join("PnFMods/B")).unwrap();
        fs::write(rm.join("PnFMods/A/Main.py"), b"a").unwrap();
        fs::write(rm.join("PnFMods/B/Main.py"), b"b").unwrap();
        fs::write(rm.join("PnFModsLoader.py"), b"").unwrap();
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let mk = |id: &str, main: &str| ModInstallRecord {
            id: id.into(),
            name: id.into(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: vec![format!("PnFMods/{main}/Main.py"), "PnFModsLoader.py".into()],
            restore_dir: None,
            game_root: String::new(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        };
        let mut installs = vec![mk("a", "A"), mk("b", "B")];
        uninstall_from_ledger(&mut installs, "a", &game_root).unwrap();
        assert!(rm.join("PnFModsLoader.py").is_file(), "still ref-counted");
        uninstall_from_ledger(&mut installs, "b", &game_root).unwrap();
        assert!(!rm.join("PnFModsLoader.py").exists(), "last user gone");

        // A foreign PnF mod still living in the tree keeps the placeholder
        // alive — the client only scans res_mods while the marker exists,
        // so removing it would silence every OTHER PnF mod too.
        fs::create_dir_all(rm.join("PnFMods/A")).unwrap();
        fs::write(rm.join("PnFMods/A/Main.py"), b"a").unwrap();
        fs::create_dir_all(rm.join("PnFMods/Foreign")).unwrap();
        fs::write(rm.join("PnFMods/Foreign/Main.py"), b"f").unwrap();
        fs::write(rm.join("PnFModsLoader.py"), b"").unwrap();
        let mut installs = vec![mk("d", "A")];
        uninstall_from_ledger(&mut installs, "d", &game_root).unwrap();
        assert!(
            rm.join("PnFModsLoader.py").is_file(),
            "foreign PnF content keeps the placeholder marker"
        );

        // A foreign (non-empty) loader survives even the last uninstall.
        fs::remove_dir_all(rm.join("PnFMods/Foreign")).unwrap();
        fs::create_dir_all(rm.join("PnFMods/A")).unwrap();
        fs::write(rm.join("PnFModsLoader.py"), b"# Aslain").unwrap();
        let mut installs = vec![mk("c", "A")];
        fs::write(rm.join("PnFMods/A/Main.py"), b"a").unwrap();
        uninstall_from_ledger(&mut installs, "c", &game_root).unwrap();
        assert!(rm.join("PnFModsLoader.py").is_file());
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn reconcile_drops_ghosts_and_collects_orphan_restore_dirs() {
        let tmp = std::env::temp_dir().join("wowsp_reconcile");
        let _ = fs::remove_dir_all(&tmp);
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let game = tmp.join("game");
        // Alive: current-bin record whose file exists.
        touch(&game.join("bin/2/res_mods/gui/a.png"));
        // Alive: stale-bin record (files exist in the OLD bin).
        touch(&game.join("bin/1/res_mods/PnFMods/B/Main.py"));
        // Alive: current-bin record whose res_mods is quarantined by safe
        // mode — the disabled twin still counts.
        touch(&game.join("bin/2/res_mods.wowsp-disabled/gui/c.png"));
        // Alive: a toggled-off mod — its files live as `.bak` twins.
        touch(&game.join("bin/1/res_mods/gui/d.png.bak"));
        // Ghost: files nowhere on disk.
        // Ghost: @game payload gone.
        let mk = |id: &str, bin: &str, files: &[&str], restore: Option<&str>| ModInstallRecord {
            id: id.into(),
            name: id.into(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: bin.into(),
            installed_at: String::new(),
            files: files.iter().map(|f| f.to_string()).collect(),
            restore_dir: restore.map(str::to_string),
            game_root: String::new(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        };
        let orphan = tmp.join("rr/orphan-restore");
        touch(&orphan.join("gui/dead.png"));
        let referenced = tmp.join("rr/keep-restore");
        touch(&referenced.join("gui/a.png"));
        let mut installs = vec![
            mk(
                "alive",
                "2",
                &["gui/a.png"],
                Some(referenced.to_str().unwrap()),
            ),
            mk("stale", "1", &["PnFMods/B/Main.py"], None),
            mk("quarantined", "2", &["gui/c.png"], None),
            mk("toggled-off", "1", &["gui/d.png"], None),
            mk("ghost", "2", &["gui/gone.png"], None),
            mk("game-gone", "2", &["@game/gettext_x64r.dll"], None),
        ];

        // A dead record stamped with ANOTHER game install must survive —
        // the ledger is global and this root has no say over it.
        installs.push(mk("foreign", "2", &["gui/elsewhere.png"], None));
        installs.last_mut().unwrap().game_root =
            tmp.join("other-game").to_string_lossy().into_owned();
        let report = reconcile_core_with_grace(
            &game.to_string_lossy(),
            &mut installs,
            std::time::Duration::ZERO,
        );
        assert_eq!(report.dropped_records, 2);
        assert_eq!(report.removed_restore_dirs, 1);
        assert!(!orphan.exists(), "unreferenced snapshot dir collected");
        assert!(referenced.exists(), "referenced snapshot dir kept");
        let ids: Vec<&str> = installs.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["alive", "stale", "quarantined", "toggled-off", "foreign"]
        );

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn reconcile_drops_loader_only_zombies_and_orphan_placeholders() {
        // A unit uninstall under pre-fix builds trimmed the first PnF record
        // down to just the shared loader marker. Such zombies must reconcile
        // away (they keep badging the catalog entry as installed and hide
        // its install button), and once no record references the marker any
        // more, the orphaned 0-byte placeholder goes with them.
        let tmp = std::env::temp_dir().join("wowsp_reconcile_loader_zombie");
        let _ = fs::remove_dir_all(&tmp);
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let game = tmp.join("game");
        let rm = game.join("bin/1/res_mods");
        // The shared marker, still on disk — plus a live mod's payload.
        fs::create_dir_all(&rm).unwrap();
        fs::write(rm.join("PnFModsLoader.py"), b"").unwrap();
        touch(&rm.join("PnFMods/Live/Main.py"));
        let mk = |id: &str, files: &[&str]| ModInstallRecord {
            id: id.into(),
            name: id.into(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: files.iter().map(|f| f.to_string()).collect(),
            restore_dir: None,
            game_root: String::new(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        };
        let mut installs = vec![
            mk("zombie", &["PnFModsLoader.py"]),
            mk("live", &["PnFMods/Live/Main.py", "PnFModsLoader.py"]),
        ];
        let report = reconcile_core_with_grace(
            &game.to_string_lossy(),
            &mut installs,
            std::time::Duration::ZERO,
        );
        assert_eq!(report.dropped_records, 1, "the loader-only zombie goes");
        let ids: Vec<&str> = installs.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["live"]);
        // The surviving record still references the marker → it stays.
        assert!(rm.join("PnFModsLoader.py").is_file());

        // Once the live record's payload vanishes too, the next reconcile
        // drops it AND the orphaned placeholder (0-byte, no PnF content).
        fs::remove_dir_all(rm.join("PnFMods/Live")).unwrap();
        let report = reconcile_core_with_grace(
            &game.to_string_lossy(),
            &mut installs,
            std::time::Duration::ZERO,
        );
        assert_eq!(report.dropped_records, 1);
        assert!(installs.is_empty());
        assert!(
            !rm.join("PnFModsLoader.py").exists(),
            "orphaned placeholder collected with its last record"
        );

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn catalog_size_check_tolerates_kib_rounding() {
        // Publisher index: byte-exact sizes keep passing.
        assert!(size_within_catalog(20480, 20480));
        assert!(size_within_catalog(282, 282));
        // Community crawl, floored template: 21095 real bytes are listed as
        // 20480, so the real payload lands anywhere in [listed, listed+1KiB).
        assert!(size_within_catalog(21095, 20480));
        assert!(size_within_catalog(5472, 5120));
        // Community crawl, ceiled listings (Explorer/Finder-style round-up):
        // just-below-listed bodies are honest too — skin.ribbon.azur-lane.zip
        // downloads 362136 bytes against a 354 KB (362496) listing, and
        // voice.ba.yuuka.zip 8545262 against 8545280.
        assert!(size_within_catalog(362136, 362496));
        assert!(size_within_catalog(8545262, 8545280));
        assert!(size_within_catalog(20479, 20480));
        // Sub-KiB assets are all published as "1 KB" (1024) while actually
        // being smaller — battle.meter.mx-part2.zip is 282 bytes on the
        // release, listed as 1024.
        assert!(size_within_catalog(282, 1024));
        assert!(size_within_catalog(1024, 1024));
        // A full KiB (or more) SHORT is a truncated transfer…
        assert!(!size_within_catalog(19456, 20480));
        assert!(!size_within_catalog(0, 1024));
        assert!(!size_within_catalog(0, 282));
        // …and a full KiB (or more) over is a different payload.
        assert!(!size_within_catalog(21504, 20480));
        // A zero listed size means "unknown" — never fails.
        assert!(size_within_catalog(0, 0));
        assert!(size_within_catalog(12345, 0));
    }

    #[test]
    fn reveal_path_segments_reject_traversal() {
        assert_eq!(validate_path_segment("0.11.9").unwrap(), "0.11.9");
        assert_eq!(validate_path_segment("PnFMods").unwrap(), "PnFMods");
        for bad in ["", ".", "..", "a/b", "a\\b", "a\u{0}b"] {
            assert!(
                validate_path_segment(bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn parses_publisher_index_shape() {
        let raw = serde_json::json!({
            "schema": 1,
            "source": {"content_version": "v.15.7.0 #10", "game_version": "15.7.0"},
            "mods": {
                "ui-timers-shot-timer": {
                    "id": "ui-timers-shot-timer",
                    "category": "battle",
                    "discussion": 111,
                    "latest": "15.7.0.10",
                    "game": ">=15.7 <15.8",
                    "aliases": ["ShotTimer", "ShotTimerPy"],
                    "servers": ["ru", "eu", "na", "asia"],
                    "versions": {
                        "15.7.0.10": {
                            "game": ">=15.7 <15.8",
                            "preview": "https://user-images.githubusercontent.com/x/shot-timer.jpg",
                            "preview_video": "https://github.com/langyo/wowsp/releases/download/preview-media/shot-timer.mp4",
                            "title": "Shot Timer",
                            "name_en": "Shot Timer",
                            "name_zh": "开火后倒计时20s",
                            "i18n": {
                                "zh-CN": {"name": "开火后倒计时20s", "desc": "主炮开火被点亮后按 20 秒倒计时提示灭点。"},
                                "ja-JP": {"name": "射撃後タイマー", "desc": "主砲発射後に20秒のカウントダウンを表示。"}
                            },
                            "packages": [
                                {"url": "https://github.com/x/a.zip", "sha256": "aa", "size": 10, "name": "a.zip"}
                            ]
                        }
                    }
                },
                "empty-mod": {"latest": "1", "versions": {"1": {"title": "no packages"}}}
            }
        });
        let index = parse_index(&raw).unwrap();
        assert_eq!(index.source_version, "v.15.7.0 #10");
        assert_eq!(index.game_version, "15.7.0");
        assert_eq!(index.mods.len(), 1, "package-less entries are dropped");
        let m = &index.mods[0];
        assert_eq!(m.id, "ui-timers-shot-timer");
        assert_eq!(m.name_zh, "开火后倒计时20s");
        assert_eq!(m.discussion, Some(111));
        assert_eq!(m.packages[0].size, 10);
        assert_eq!(m.i18n.len(), 2, "both locales survive the round-trip");
        assert_eq!(m.i18n["ja-JP"].name, "射撃後タイマー");
        assert_eq!(m.aliases, vec!["ShotTimer", "ShotTimerPy"]);
        assert_eq!(m.servers, vec!["ru", "eu", "na", "asia"]);
        assert_eq!(
            m.preview.as_deref(),
            Some("https://user-images.githubusercontent.com/x/shot-timer.jpg")
        );
        // The snake_case index key threads into the camelCase DTO.
        assert_eq!(
            m.preview_video.as_deref(),
            Some("https://github.com/langyo/wowsp/releases/download/preview-media/shot-timer.mp4")
        );
    }

    #[test]
    fn preset_entries_parse_with_ordered_schemes() {
        // Presets ride the entry in declaration order; a preset without
        // packages is dropped at the parse boundary (nothing to install).
        // Folded style families additionally carry per-scheme preview and
        // description notes plus the entry-level `supersedes` map (legacy
        // one-entry-per-variant ids → scheme ids).
        let raw = serde_json::json!({
            "schema": 1,
            "mods": {
                "battle.marker.traffic": {
                    "id": "battle.marker.traffic",
                    "category": "battle",
                    "discussion": 122,
                    "latest": "15.7.0.10",
                    "supersedes": {
                        "battle.marker.traffic": "classic",
                        "battle.marker.traffic-v4": "sasagcy"
                    },
                    "versions": {
                        "15.7.0.10": {
                            "game": ">=15.7 <15.8",
                            "title": "SMI",
                            "packages": [
                                {"url": "https://github.com/x/v4.zip", "sha256": "aa", "size": 1, "name": "v4.zip"}
                            ],
                            "presets": [
                                {"id": "sasagcy", "name_zh": "Sasagcy 配色", "name_en": "Sasagcy palette",
                                 "preview": "https://github.com/user-attachments/assets/v4.png",
                                 "desc_zh": "四态配色。", "desc_en": "Four-state palette.",
                                 "packages": [{"url": "https://github.com/x/v4.zip", "sha256": "aa", "size": 1, "name": "v4.zip"}]},
                                {"id": "classic", "name_zh": "经典配色", "name_en": "Classic palette",
                                 "packages": [{"url": "https://github.com/x/v1.zip", "sha256": "bb", "size": 1, "name": "v1.zip"}]},
                                {"id": "ghost", "name_zh": "无包", "name_en": "No packages", "packages": []}
                            ]
                        }
                    }
                }
            }
        });
        let index = parse_index(&raw).unwrap();
        let m = &index.mods[0];
        assert_eq!(m.presets.len(), 2, "package-less presets are dropped");
        assert_eq!(m.presets[0].id, "sasagcy");
        assert_eq!(m.presets[0].name_zh, "Sasagcy 配色");
        assert_eq!(
            m.presets[0].preview.as_deref(),
            Some("https://github.com/user-attachments/assets/v4.png")
        );
        assert_eq!(m.presets[0].desc_zh.as_deref(), Some("四态配色。"));
        assert_eq!(m.presets[0].desc_en.as_deref(), Some("Four-state palette."));
        // A scheme without own notes keeps None (the pane falls back to
        // the entry-level preview/description).
        assert!(m.presets[1].preview.is_none());
        assert!(m.presets[1].desc_zh.is_none());
        assert_eq!(m.presets[1].packages[0].name, "v1.zip");
        // The default list mirrors the first preset (indexer backfill).
        assert_eq!(m.packages.len(), 1);
        assert_eq!(m.packages[0].name, "v4.zip");
        let supersedes = m
            .supersedes
            .as_ref()
            .expect("folded family carries supersedes");
        assert_eq!(
            supersedes
                .get("battle.marker.traffic-v4")
                .map(String::as_str),
            Some("sasagcy")
        );
        assert_eq!(supersedes.len(), 2);
    }

    #[test]
    fn parse_index_leaves_supersedes_absent_on_plain_entries() {
        // Unfolded entries (and pre-fold indexes) parse with no supersedes
        // and no per-scheme media — the Option fields stay None.
        let raw = serde_json::json!({
            "mods": {
                "battle.calculator.penetration": {
                    "category": "battle",
                    "latest": "1",
                    "versions": {"1": {"game": "*", "title": "Pen",
                        "packages": [{"url": "https://github.com/x/p.zip", "sha256": "aa", "size": 1, "name": "p.zip"}]}}
                }
            }
        });
        let m = &parse_index(&raw).unwrap().mods[0];
        assert!(m.supersedes.is_none());
        assert!(m.presets.is_empty());
        assert!(m.preview_video.is_none());
    }

    #[test]
    fn install_of_folded_family_rewinds_superseded_variant_records() {
        // Family styles are mutually exclusive variants of one HUD
        // element: installing the folded entry (battle.panel, any
        // scheme) rewinds ledger rows written under the legacy
        // one-entry-per-variant ids (battle.panel.ttaro…) — the old
        // variant's files leave with its record.
        let tmp = std::env::temp_dir().join("wowsp_catalog_fold_rewind");
        let _ = fs::remove_dir_all(&tmp);
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        fs::create_dir_all(tmp.join("game/bin/1")).unwrap();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let mk = |name: &str| CatalogPackage {
            url: format!("https://example.com/{name}"),
            sha256: String::new(),
            size: 0,
            name: name.into(),
        };

        // The legacy variant, installed under its old own id.
        let work_a = tmp.join("work_a");
        fs::create_dir_all(&work_a).unwrap();
        zip_fixture(
            &package_archive(&work_a, 0),
            &[("res_mods/gui/a.png", b"a")],
        );
        let mut installs = Vec::new();
        let mod_hub::PlanApply {
            report: rep_a,
            written: written_a,
            ..
        } = unpack_and_install(
            "battle.panel.ttaro",
            "TTaro",
            &work_a,
            &game_root,
            &[mk("a.zip")],
            &[],
            &mut installs,
        )
        .unwrap();
        installs.push(ModInstallRecord {
            id: "battle.panel.ttaro".into(),
            name: "TTaro".into(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: rep_a.bin_version.clone(),
            installed_at: String::new(),
            files: written_a,
            restore_dir: None,
            game_root: game_root.clone(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        });

        // The folded entry installs another scheme; supersedes names the
        // legacy ids (one of which, autospy, has no record — tolerated).
        let work_b = tmp.join("work_b");
        fs::create_dir_all(&work_b).unwrap();
        zip_fixture(
            &package_archive(&work_b, 0),
            &[("res_mods/gui/b.png", b"b")],
        );
        let supersedes: Vec<String> = ["battle.panel.ttaro", "battle.panel.autospy"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        unpack_and_install(
            "battle.panel",
            "侧边面板",
            &work_b,
            &game_root,
            &[mk("b.zip")],
            &supersedes,
            &mut installs,
        )
        .unwrap();

        assert!(
            installs.iter().all(|r| r.id != "battle.panel.ttaro"),
            "legacy variant record rewound"
        );
        let res_mods = tmp.join("game/bin/1/res_mods");
        assert!(
            !res_mods.join("gui/a.png").exists(),
            "variant A files removed"
        );
        assert!(res_mods.join("gui/b.png").exists(), "new scheme installed");
        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn uninstall_drops_the_wowsp_toml_row() {
        // uninstall_from_ledger maintains res_mods/wowsp.toml: the row goes
        // with the record, the file self-deletes when nothing remains.
        let tmp = std::env::temp_dir().join("wowsp_toml_uninstall");
        let _ = fs::remove_dir_all(&tmp);
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let res_mods = tmp.join("game/bin/1/res_mods");
        fs::create_dir_all(res_mods.join("gui")).unwrap();
        fs::write(res_mods.join("gui/a.png"), b"a").unwrap();
        manifest::upsert_managed(
            &res_mods,
            "m",
            WowspManifest::entry_from_record(&ModInstallRecord {
                id: "m".into(),
                name: "M".into(),
                version: "1".into(),
                category: "battle".into(),
                source: "mod-hub".into(),
                discussion: None,
                preset: Some("classic".into()),
                bin_version: "1".into(),
                installed_at: String::new(),
                files: vec!["gui/a.png".into()],
                restore_dir: None,
                game_root: game_root.clone(),
                hashes: None,
                snapshot_hashes: None,
                shared_roots: Vec::new(),
            }),
        );
        assert!(res_mods.join("wowsp.toml").is_file());
        let mut installs = vec![ModInstallRecord {
            id: "m".into(),
            name: "M".into(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: vec!["gui/a.png".into()],
            restore_dir: None,
            game_root: String::new(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        }];
        uninstall_from_ledger(&mut installs, "m", &game_root).unwrap();
        assert!(
            !res_mods.join("wowsp.toml").exists(),
            "empty manifest self-deletes"
        );
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn delisted_entries_survive_with_flag() {
        // A closed discussion thread flags the entry as withdrawn: the entry
        // STAYS in the parsed list (deep links need it to explain the state)
        // but carries delisted=true for the UI to filter on.
        let raw = serde_json::json!({
            "schema": 1,
            "mods": {
                "battle.marker.traffic": {
                    "id": "battle.marker.traffic",
                    "category": "battle",
                    "discussion": 118,
                    "latest": "15.7.0.10",
                    "delisted": true,
                    "versions": {
                        "15.7.0.10": {
                            "game": ">=15.7 <15.8",
                            "title": "Ship Movement Indicator",
                            "packages": [
                                {"url": "https://github.com/x/a.zip", "sha256": "aa", "size": 1, "name": "a.zip"}
                            ]
                        }
                    }
                },
                "still-listed": {
                    "id": "still-listed",
                    "category": "battle",
                    "latest": "1",
                    "versions": {
                        "1": {
                            "game": "*",
                            "title": "Live",
                            "packages": [
                                {"url": "https://github.com/x/b.zip", "sha256": "bb", "size": 1, "name": "b.zip"}
                            ]
                        }
                    }
                }
            }
        });
        let index = parse_index(&raw).unwrap();
        assert_eq!(
            index.mods.len(),
            2,
            "delisted entries are kept, not dropped"
        );
        let delisted = index
            .mods
            .iter()
            .find(|m| m.id == "battle.marker.traffic")
            .unwrap();
        assert!(delisted.delisted, "the flag reaches the DTO");
        let live = index.mods.iter().find(|m| m.id == "still-listed").unwrap();
        assert!(!live.delisted, "absent flag defaults to false");
    }

    #[test]
    fn bundled_entries_survive_without_packages() {
        let raw = serde_json::json!({
            "schema": 1,
            "mods": {
                "battle.ingame.stats": {
                    "id": "battle.ingame.stats",
                    "category": "battle",
                    "discussion": 640,
                    "latest": "0.1.0",
                    "versions": {
                        "0.1.0": {
                            "game": "*",
                            "title": "In-Game Tab Stats Plugin",
                            "bundled": true
                        }
                    }
                },
                "still-dropped": {"latest": "1", "versions": {"1": {"title": "no packages, no flag"}}}
            }
        });
        let index = parse_index(&raw).unwrap();
        assert_eq!(index.mods.len(), 1, "only the bundled entry survives");
        let m = &index.mods[0];
        assert_eq!(m.id, "battle.ingame.stats");
        assert!(m.bundled, "bundled flag reaches the DTO");
        assert!(m.packages.is_empty(), "no download packages to offer");
    }

    #[test]
    fn ledger_roundtrips() {
        // Ledger file location follows the app data dir; write through the
        // same helpers the commands use so the shape stays in lock-step.
        let ledger = Ledger {
            installs: vec![ModInstallRecord {
                id: "x".into(),
                name: "X".into(),
                version: "1".into(),
                category: "battle".into(),
                source: "mod-hub".into(),
                discussion: Some(9),
                preset: None,
                bin_version: "1".into(),
                installed_at: "2026-01-01T00:00:00Z".into(),
                files: vec!["a.xml".into()],
                restore_dir: None,
                game_root: String::new(),
                hashes: None,
                snapshot_hashes: None,
                shared_roots: Vec::new(),
            }],
        };
        let json = serde_json::to_string_pretty(&ledger).unwrap();
        let back: Ledger = serde_json::from_str(&json).unwrap();
        assert_eq!(back.installs[0].id, "x");
        assert_eq!(back.installs[0].files, vec!["a.xml"]);
    }

    fn junk_named_record(id: &str, name: &str, files: &[&str]) -> ModInstallRecord {
        ModInstallRecord {
            id: id.into(),
            name: name.into(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: files.iter().map(|f| f.to_string()).collect(),
            restore_dir: None,
            game_root: String::new(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        }
    }

    #[test]
    fn catalog_installs_record_the_entry_title_not_the_classifier_label() {
        let tmp =
            std::env::temp_dir().join(format!("wowsp-catalog-name-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let work = tmp.join("work");
        fs::create_dir_all(&work).unwrap();
        let game = tmp.join("game");
        fs::create_dir_all(game.join("bin/1")).unwrap();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        zip_fixture(
            &package_archive(&work, 0),
            &[("res_mods/gui/ttaro_mod.config/index.css", b"config")],
        );
        let packages = vec![CatalogPackage {
            url: "https://example.com/package.zip".into(),
            name: "package.zip".into(),
            size: 0,
            sha256: String::new(),
        }];
        // A game-root layout zip classifies through the `res_mods` directory —
        // the label that used to leak into the ledger.
        let mod_hub::PlanApply { report, .. } = unpack_and_install(
            "battle.build.viewer",
            "Build Viewer",
            &work,
            &game.to_string_lossy(),
            &packages,
            &[],
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(report.name, "Build Viewer");
        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn reconcile_heals_junk_record_names_from_the_catalog_index() {
        let index = parse_index(&serde_json::json!({
            "mods": {
                "battle.build.viewer": {
                    "latest": "1",
                    "versions": {
                        "1": {
                            "title": "title fallback",
                            "name_zh": "战场内升级品加点查看",
                            "bundled": true
                        }
                    }
                },
                "battle.flat.layout": {
                    "latest": "1",
                    "versions": {"1": {"title": "Flat Mod", "bundled": true}}
                }
            }
        }))
        .unwrap();
        let mut installs = vec![
            junk_named_record("battle.build.viewer", "res_mods", &["gui/a.css"]),
            junk_named_record("battle.flat.layout", "Unpacked", &["gui/b.css"]),
            // No catalog entry answers to this id: nothing to heal from.
            junk_named_record("battle.unlisted.mod", "res_mods", &["gui/c.css"]),
            // A genuine local install keeps its own label even when it
            // happens to be a junk-looking one.
            ModInstallRecord {
                source: "local".into(),
                ..junk_named_record("local-1", "res_mods", &["gui/d.css"])
            },
        ];
        let healed = heal_record_names(&mut installs, Some(&index));
        assert_eq!(healed, 2, "{installs:?}");
        assert_eq!(installs[0].name, "战场内升级品加点查看");
        assert_eq!(installs[1].name, "Flat Mod", "unpacked is junk too");
        assert_eq!(installs[2].name, "res_mods", "unknown ids stay");
        assert_eq!(installs[3].name, "res_mods", "non-catalog ids stay");
        assert_eq!(heal_record_names(&mut installs, None), 0);
    }

    #[test]
    fn duplicate_records_of_one_mod_do_not_deadlock_each_others_uninstall() {
        let older = junk_named_record("battle.build.viewer", "res_mods", &["gui/shared.css"]);
        let mut newer = older.clone();
        newer.installed_at = "later".into();
        let root = "C:\\game";
        // Both records claim the same file; before the same-id exemption the
        // older one could never be uninstalled (or reinstalled-over) while
        // its own duplicate sat on top of it.
        assert!(
            validate_uninstall_order(&[older.clone(), newer], "battle.build.viewer", root).is_ok()
        );
        // A DIFFERENT mod on top still blocks, and the message now carries
        // the blocker's id next to its name.
        let mut other = junk_named_record("battle.heal.assistant", "Heal Assistant", &[]);
        other.files = vec!["gui/shared.css".into()];
        let err =
            validate_uninstall_order(&[older, other], "battle.build.viewer", root).unwrap_err();
        let text = err.to_string();
        assert!(text.contains("Heal Assistant"), "{text}");
        assert!(text.contains("(id battle.heal.assistant)"), "{text}");
    }

    /// The shared-component matcher: Aslain's Implicit runtime trees (and
    /// only those) classify as shared — a dependent's own PnF tree, other
    /// gettext catalogs, the loader marker and lookalike spellings stay
    /// private.
    #[test]
    fn shared_component_matcher_classifies_the_aslain_runtime_trees() {
        for rel in [
            "PnFMods/TTaroModUtils/SchemaScanner.py",
            "pnfmods/ttaromodutils/deep/nested.py",
            "PnFMods/ModForge/Blueprints/bp.json",
            "PnFMods/ModsInstaller_4_3_1/mods/SecondaryArmament.xml",
            // The family prefix survives an Aslain toolkit bump.
            "PnFMods/ModsInstaller_4_4_0/mods/SecondaryArmament.xml",
            "gui/ttaro/index.css",
            "gui/ttaro_mod_config/config.json",
            "gui/unbound2/PnFMods/TTaroModUtils/SchemaScanner.unbound",
            // The real unbound shape: suffixed FILES directly under the
            // root, not a TTaroModUtils/ directory.
            "gui/unbound2/PnFMods/TTaroModUtils2.unbound",
            "texts/en/ttaro-mod-config.mo",
            "texts/zh_CN/ttaro-mod-config.mo",
            "@game/gettext_x64r.dll",
            // OS-native separators from a snapshot layer compare equal.
            "PnFMods\\TTaroModUtils\\Main.py",
        ] {
            assert!(is_shared_component_path(rel), "{rel} must be shared");
        }
        for rel in [
            "PnFMods/ConsumablesMonitor2Py/Main.py",
            // Lookalike spellings that are NOT the component trees.
            "PnFMods/TTaroModUtilsX/other.py",
            "gui/ttaro_mod.config/index.css",
            "gui/own/a.css",
            "texts/en/LC_MESSAGES/other.mo",
            "PnFModsLoader.py",
            "@game/own.dll",
            "content/gameplay/x.dds",
        ] {
            assert!(!is_shared_component_path(rel), "{rel} must stay private");
        }
        // Root granularity: files across one component root agree,
        // distinct components stay distinct, and the single-file
        // components map to their own path.
        assert_eq!(
            shared_component_root("PnFMods/TTaroModUtils/SchemaScanner.py"),
            shared_component_root("pnfmods/ttaromodutils/Other.py")
        );
        assert_ne!(
            shared_component_root("PnFMods/TTaroModUtils/SchemaScanner.py"),
            shared_component_root("PnFMods/ModForge/x.py")
        );
        assert_eq!(
            shared_component_root("@game/gettext_x64r.dll"),
            Some("@game/gettext_x64r.dll".into())
        );
    }

    /// P1 shared-component semantics (Aslain-aligned): a shared runtime
    /// tree cloned into every dependent's file list never blocks an
    /// uninstall. Uninstalling the OLDER consumer now succeeds (it used
    /// to be refused by the newer record's claim), keeps the shared file
    /// at the live bytes and removes only the departing record's private
    /// files; the LAST consumer's uninstall removes the shared file and
    /// restores the snapshot layer its own install captured. A private
    /// file's newer claim keeps refusing exactly as before.
    #[test]
    fn uninstall_keeps_a_shared_component_until_its_last_consumer() {
        let tmp = std::env::temp_dir().join("wowsp_shared_component_uninstall");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("game/bin/1/res_mods");
        touch(&rm.join("PnFMods/TTaroModUtils/SchemaScanner.py"));
        fs::write(
            rm.join("PnFMods/TTaroModUtils/SchemaScanner.py"),
            b"shared b bytes",
        )
        .unwrap();
        touch(&rm.join("gui/a-only.png"));
        // B's install overwrote A's copy, so B's snapshot layer holds the
        // bytes that were live before it (A's era).
        let restore_b = tmp.join("restore-b");
        touch(&restore_b.join("PnFMods/TTaroModUtils/SchemaScanner.py"));
        fs::write(
            restore_b.join("PnFMods/TTaroModUtils/SchemaScanner.py"),
            b"shared a bytes",
        )
        .unwrap();
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let mk = |id: &str, files: &[&str], restore: Option<&Path>| ModInstallRecord {
            id: id.into(),
            name: id.to_uppercase(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: files.iter().map(|f| (*f).to_string()).collect(),
            restore_dir: restore.map(|p| p.to_string_lossy().into_owned()),
            game_root: String::new(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        };
        let mut installs = vec![
            mk(
                "a",
                &["PnFMods/TTaroModUtils/SchemaScanner.py", "gui/a-only.png"],
                None,
            ),
            mk(
                "b",
                &["PnFMods/TTaroModUtils/SchemaScanner.py"],
                Some(&restore_b),
            ),
        ];

        // The older record's uninstall is no longer refused by the newer
        // record's claim on the shared file…
        let report = uninstall_from_ledger(&mut installs, "a", &game_root).unwrap();
        assert_eq!(report.removed_files, 1, "only the private file goes");
        // …the shared file STAYS at the live (newer) bytes…
        assert_eq!(
            fs::read(rm.join("PnFMods/TTaroModUtils/SchemaScanner.py")).unwrap(),
            b"shared b bytes"
        );
        // …while the departing record's private files go as always.
        assert!(!rm.join("gui/a-only.png").exists());
        assert_eq!(installs.len(), 1);
        assert_eq!(installs[0].id, "b");

        // The LAST consumer takes the component with it and restores the
        // snapshot layer its own install captured.
        let report = uninstall_from_ledger(&mut installs, "b", &game_root).unwrap();
        assert_eq!(report.restored_files, 1);
        assert_eq!(
            fs::read(rm.join("PnFMods/TTaroModUtils/SchemaScanner.py")).unwrap(),
            b"shared a bytes"
        );
        assert!(installs.is_empty());
        assert!(
            !restore_b.exists(),
            "the consumed snapshot layer is dropped"
        );

        // A PRIVATE file's newer claim still refuses, unchanged.
        let mut installs = vec![
            mk(
                "c",
                &["gui/private.css", "PnFMods/TTaroModUtils/SchemaScanner.py"],
                None,
            ),
            mk("d", &["gui/private.css"], None),
        ];
        let err = validate_uninstall_order(&installs, "c", &game_root).unwrap_err();
        assert!(err.to_string().contains("shares gui/private.css"), "{err}");
        fs::remove_dir_all(&tmp).ok();
    }

    /// A kept shared path keeps its PRELOAD-MIRROR twin too: the twin's
    /// copy serves the surviving consumer, while the departing record's
    /// private files lose theirs (mirror_removed must only ever see the
    /// non-protected list — reverting that filter to record.files would
    /// fail this test).
    #[test]
    fn shared_uninstall_keeps_the_preload_mirror_twin() {
        let tmp = std::env::temp_dir().join("wowsp_shared_mirror_twin");
        let _ = fs::remove_dir_all(&tmp);
        let game = tmp.join("game");
        // The pin names bin 2 as the live build; bin 3 is the complete
        // staged pre-release twin whose res_mods mirrors the live tree.
        fs::create_dir_all(game.join("bin/2/idx")).unwrap();
        fs::create_dir_all(game.join("bin/3/idx")).unwrap();
        fs::write(
            game.join("preferences.xml"),
            "<root><last_server_version> 15,9,0,2 </last_server_version></root>",
        )
        .unwrap();
        let live = game.join("bin/2/res_mods");
        let twin = game.join("bin/3/res_mods");
        for tree in [&live, &twin] {
            fs::create_dir_all(tree.join("PnFMods/TTaroModUtils")).unwrap();
            fs::write(tree.join("PnFMods/TTaroModUtils/S.py"), b"shared").unwrap();
            fs::create_dir_all(tree.join("gui")).unwrap();
            fs::write(tree.join("gui/a-only.png"), b"png").unwrap();
        }
        let game_root = game.to_string_lossy().into_owned();
        let mk = |id: &str, files: &[&str]| ModInstallRecord {
            id: id.into(),
            name: id.to_uppercase(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "2".into(),
            installed_at: String::new(),
            files: files.iter().map(|f| (*f).to_string()).collect(),
            restore_dir: None,
            game_root: String::new(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        };
        let mut installs = vec![
            mk("a", &["PnFMods/TTaroModUtils/S.py", "gui/a-only.png"]),
            mk("b", &["PnFMods/TTaroModUtils/S.py"]),
        ];

        uninstall_from_ledger(&mut installs, "a", &game_root).unwrap();

        assert!(twin.join("PnFMods/TTaroModUtils/S.py").is_file());
        assert!(
            !twin.join("gui/a-only.png").exists(),
            "the private file's mirrored copy goes with the live one"
        );
        fs::remove_dir_all(&tmp).ok();
    }

    /// The Reinstall-mode protected set is shared claims UNION live
    /// component roots: a shared file NO other record claims by exact
    /// path still survives the reinstall rewind while a sibling consumer
    /// keeps the component alive (the union only ever widens the kept
    /// set — plain reinstalls see zero change).
    #[test]
    fn reinstall_keeps_a_shared_file_a_sibling_consumer_lives_on() {
        let tmp = std::env::temp_dir().join("wowsp_shared_reinstall_union");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("game/bin/1/res_mods");
        fs::create_dir_all(rm.join("PnFMods/ModForge")).unwrap();
        fs::write(rm.join("PnFMods/ModForge/x.json"), b"x").unwrap();
        fs::write(rm.join("PnFMods/ModForge/y.json"), b"y").unwrap();
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let mk = |id: &str, files: &[&str]| ModInstallRecord {
            id: id.into(),
            name: id.to_uppercase(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: files.iter().map(|f| (*f).to_string()).collect(),
            restore_dir: None,
            game_root: String::new(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        };
        // a claims x.json only; b keeps the SAME component root alive via
        // y.json — no exact-path overlap anywhere.
        let mut installs = vec![
            mk("a", &["PnFMods/ModForge/x.json"]),
            mk("b", &["PnFMods/ModForge/y.json"]),
        ];

        rewind_for_reinstall(&mut installs, "a", &game_root).unwrap();

        assert!(
            rm.join("PnFMods/ModForge/x.json").is_file(),
            "the sibling consumer keeps the component — a's file survives the rewind"
        );
        assert!(rm.join("PnFMods/ModForge/y.json").is_file());
        assert_eq!(installs.len(), 1, "the rewound record is dropped");
        fs::remove_dir_all(&tmp).ok();
    }

    /// Component-ROOT granularity: a consumer claiming a DIFFERENT file
    /// under the same shared root keeps files it never listed alive —
    /// the tree belongs to the component, not to any one pack's file
    /// list. Removal stays per-record as before, so a file only the
    /// departed consumer listed is left as an orphan (the real catalog
    /// clones identical file lists, so this shape is hypothetical).
    #[test]
    fn shared_component_root_granularity_spans_unclaimed_files() {
        let tmp = std::env::temp_dir().join("wowsp_shared_component_granularity");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("game/bin/1/res_mods");
        touch(&rm.join("PnFMods/TTaroModUtils/SchemaScanner.py"));
        touch(&rm.join("PnFMods/TTaroModUtils/Other.py"));
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let mk = |id: &str, files: &[&str]| ModInstallRecord {
            id: id.into(),
            name: id.to_uppercase(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: files.iter().map(|f| (*f).to_string()).collect(),
            restore_dir: None,
            game_root: String::new(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        };
        let mut installs = vec![
            mk("a", &["PnFMods/TTaroModUtils/SchemaScanner.py"]),
            mk("b", &["PnFMods/TTaroModUtils/Other.py"]),
        ];
        uninstall_from_ledger(&mut installs, "a", &game_root).unwrap();
        assert!(
            rm.join("PnFMods/TTaroModUtils/SchemaScanner.py").is_file(),
            "another consumer of the same component root keeps unclaimed files"
        );
        // The last consumer's own files still go as always.
        uninstall_from_ledger(&mut installs, "b", &game_root).unwrap();
        assert!(!rm.join("PnFMods/TTaroModUtils/Other.py").exists());
        assert!(installs.is_empty());
        fs::remove_dir_all(&tmp).ok();
    }

    // ── P1 full variant: shared.* component records ───────────────────────
    //
    // Drive a full catalog-style install (extract → classify → journal →
    // split commit) without network: the record commits exactly like the
    // install command does — private files plus shared_roots on the pack,
    // one upserted shared.* record per component root.

    fn install_pack(
        tmp: &Path,
        work_name: &str,
        game_root: &str,
        id: &str,
        version: &str,
        installs: &mut Vec<ModInstallRecord>,
        entries: &[(&str, &[u8])],
    ) -> mod_hub::PlanApply {
        let work = tmp.join(work_name);
        fs::create_dir_all(&work).unwrap();
        zip_fixture(&package_archive(&work, 0), entries);
        let packages = vec![CatalogPackage {
            url: "https://github.com/langyo/wowsp/releases/download/mod-hub/p.zip".into(),
            name: "p.zip".into(),
            size: 0,
            sha256: String::new(),
        }];
        // The same-id records this install is about to rewind — the
        // dropped-component cleanup needs them (mirrors the install
        // command's pre-rewind capture).
        let previous: Vec<ModInstallRecord> = installs
            .iter()
            .filter(|r| r.id == id && (r.game_root.is_empty() || r.game_root == game_root))
            .cloned()
            .collect();
        let applied = unpack_and_install(id, id, &work, game_root, &packages, &[], installs)
            .expect("unpack_and_install");
        // The record the install command builds (full written list, the
        // journal's restore dir, the P4 hash maps) — commit_pack_record
        // then splits the shared-component files out.
        let record = ModInstallRecord {
            id: id.into(),
            name: applied.report.name.clone(),
            version: version.into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: applied.report.bin_version.clone(),
            installed_at: String::new(),
            files: applied.written.clone(),
            restore_dir: applied
                .restore_dir
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            game_root: game_root.into(),
            hashes: applied.hashes.clone(),
            snapshot_hashes: applied.snapshot_hashes.clone(),
            shared_roots: Vec::new(),
        };
        let committed =
            commit_pack_record(installs, record, game_root).expect("commit_pack_record");
        // Same dropped-component cleanup the install command runs after
        // the commit: roots the rewound records consumed that the new
        // pack no longer declares lose their component record.
        drop_removed_shared_roots(installs, &previous, &committed.shared_roots, game_root)
            .expect("drop_removed_shared_roots");
        applied
    }

    /// Every regular file under `dir`, recursively.
    fn tree_files(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for ent in fs::read_dir(&d).unwrap().flatten() {
                let p = ent.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    out.push(p);
                }
            }
        }
        out
    }

    fn sha_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(bytes))
    }

    /// (a) Fresh install: the shared tree lands in ONE per-component
    /// shared.* record (files under the root only, its own restore dir
    /// holding the single pre-install layer), and the pack record keeps
    /// only its private files plus the shared_roots edge — no shared
    /// entries in its file list, no hash maps, no layer copies.
    #[test]
    fn fresh_install_splits_shared_files_into_a_component_record() {
        let tmp = std::env::temp_dir().join("wowsp_shared_split_fresh");
        let _ = fs::remove_dir_all(&tmp);
        let game = tmp.join("game");
        let rm = game.join("bin/1/res_mods");
        fs::create_dir_all(rm.join("gui/ttaro")).unwrap();
        fs::write(rm.join("gui/ttaro/index.css"), b"vanilla original").unwrap();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let game_root = game.to_string_lossy().into_owned();

        let mut installs = Vec::new();
        install_pack(
            &tmp,
            "work-a",
            &game_root,
            "a",
            "1.0",
            &mut installs,
            &[
                ("res_mods/gui/ttaro/index.css", b"gen-1 bytes"),
                ("res_mods/gui/a-only.png", b"png"),
            ],
        );
        assert_eq!(installs.len(), 2, "pack record + one component record");

        let pack = installs.iter().find(|r| r.id == "a").unwrap();
        assert_eq!(pack.files, vec!["gui/a-only.png".to_string()]);
        assert_eq!(pack.shared_roots, vec!["gui/ttaro/".to_string()]);
        assert_eq!(pack.hashes, None);
        assert_eq!(pack.snapshot_hashes, None);
        assert_eq!(pack.restore_dir, None, "no private layer was captured");

        let shared = installs
            .iter()
            .find(|r| r.id == "shared.gui.ttaro")
            .expect("the component record exists");
        assert_eq!(shared.files, vec!["gui/ttaro/index.css".to_string()]);
        assert_eq!(shared.name, "Shared TTaro GUI tree");
        assert_eq!(shared.source, "mod-hub");
        assert_eq!(shared.version, "1.0");
        assert_eq!(shared.bin_version, "1");
        assert_eq!(shared.game_root, game_root);
        assert_eq!(
            shared.hashes.as_ref().unwrap().get("gui/ttaro/index.css"),
            Some(&sha_hex(b"gen-1 bytes"))
        );
        assert_eq!(
            shared
                .snapshot_hashes
                .as_ref()
                .unwrap()
                .get("gui/ttaro/index.css"),
            Some(&sha_hex(b"vanilla original")),
            "the layer map hashes the CAPTURED pre-install bytes"
        );

        // ONE layer, in the component record's restore dir — and nowhere
        // else (the pack's journal dir is gone once its layers moved out).
        let layer_dir = PathBuf::from(shared.restore_dir.as_ref().unwrap());
        let layers = tree_files(&layer_dir);
        assert_eq!(layers.len(), 1, "one layer per content generation");
        assert_eq!(fs::read(&layers[0]).unwrap(), b"vanilla original");
        assert_eq!(
            tree_files(&tmp.join("rr")).len(),
            1,
            "the pack kept no layer copy of its own"
        );
        fs::remove_dir_all(&tmp).ok();
    }

    /// (b) Second dependent shipping IDENTICAL component bytes: the
    /// generation is unchanged — no new layer is captured (the journal's
    /// redundant capture is discarded), the component record keeps its
    /// files and layer exactly, and only the pack record is added.
    #[test]
    fn second_dependent_with_identical_bytes_does_not_relayer() {
        let tmp = std::env::temp_dir().join("wowsp_shared_split_identical");
        let _ = fs::remove_dir_all(&tmp);
        let game = tmp.join("game");
        let rm = game.join("bin/1/res_mods");
        fs::create_dir_all(rm.join("gui/ttaro")).unwrap();
        fs::write(rm.join("gui/ttaro/index.css"), b"vanilla original").unwrap();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let game_root = game.to_string_lossy().into_owned();
        let mut installs = Vec::new();

        install_pack(
            &tmp,
            "work-a",
            &game_root,
            "a",
            "1.0",
            &mut installs,
            &[
                ("res_mods/gui/ttaro/index.css", b"gen-1 bytes"),
                ("res_mods/gui/a-only.png", b"png"),
            ],
        );
        let shared_before = installs
            .iter()
            .find(|r| r.id == "shared.gui.ttaro")
            .cloned()
            .unwrap();
        let before_layers: Vec<Vec<u8>> =
            tree_files(&PathBuf::from(shared_before.restore_dir.as_ref().unwrap()))
                .iter()
                .map(|p| fs::read(p).unwrap())
                .collect();

        let applied = install_pack(
            &tmp,
            "work-b",
            &game_root,
            "b",
            "2.0",
            &mut installs,
            &[
                ("res_mods/gui/ttaro/index.css", b"gen-1 bytes"),
                ("res_mods/gui/b-only.png", b"png b"),
            ],
        );
        assert!(
            !applied
                .report
                .warnings
                .iter()
                .any(|w| w.contains("mixed-version")),
            "identical bytes stay silent: {:?}",
            applied.report.warnings
        );

        assert_eq!(installs.len(), 3, "a + shared + b");
        let shared = installs
            .iter()
            .find(|r| r.id == "shared.gui.ttaro")
            .unwrap();
        assert_eq!(shared.files, shared_before.files);
        assert_eq!(shared.hashes, shared_before.hashes);
        assert_eq!(shared.snapshot_hashes, shared_before.snapshot_hashes);
        assert_eq!(shared.restore_dir, shared_before.restore_dir);
        // The generation layer is BYTE-identical and SINGLE — no re-capture.
        let after_dir = PathBuf::from(shared.restore_dir.as_ref().unwrap());
        let after_layers: Vec<Vec<u8>> = tree_files(&after_dir)
            .iter()
            .map(|p| fs::read(p).unwrap())
            .collect();
        assert_eq!(after_layers, before_layers);
        assert_eq!(
            tree_files(&tmp.join("rr")).len(),
            1,
            "still exactly one layer file in the restore root"
        );
        let pack_b = installs.iter().find(|r| r.id == "b").unwrap();
        assert_eq!(pack_b.files, vec!["gui/b-only.png".to_string()]);
        assert_eq!(pack_b.restore_dir, None);
        fs::remove_dir_all(&tmp).ok();
    }

    /// (c) Second dependent shipping DIFFERENT component bytes: a NEW
    /// generation layer is captured (the old generation's bytes, straight
    /// from the journal), the component record is replaced wholesale with
    /// the new hashes, and the divergence warning path fires unchanged —
    /// naming the file and both record ids.
    #[test]
    fn second_dependent_with_different_bytes_layers_a_new_generation() {
        let tmp = std::env::temp_dir().join("wowsp_shared_split_divergent");
        let _ = fs::remove_dir_all(&tmp);
        let game = tmp.join("game");
        let rm = game.join("bin/1/res_mods");
        fs::create_dir_all(rm.join("gui/ttaro")).unwrap();
        fs::write(rm.join("gui/ttaro/index.css"), b"vanilla original").unwrap();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let game_root = game.to_string_lossy().into_owned();
        let mut installs = Vec::new();

        install_pack(
            &tmp,
            "work-a",
            &game_root,
            "a",
            "1.0",
            &mut installs,
            &[
                ("res_mods/gui/ttaro/index.css", b"gen-1 bytes"),
                ("res_mods/gui/a-only.png", b"png"),
            ],
        );
        let applied = install_pack(
            &tmp,
            "work-b",
            &game_root,
            "b",
            "2.0",
            &mut installs,
            &[
                ("res_mods/gui/ttaro/index.css", b"gen-2 bytes"),
                ("res_mods/gui/b-only.png", b"png b"),
            ],
        );

        // The mixed-version warning is AGGREGATED per component: label +
        // root + differing-file count + both ids — the component record is
        // the recorded claimer now.
        let warning = applied
            .report
            .warnings
            .iter()
            .find(|w| w.contains("mixed-version"))
            .expect("divergence warns");
        assert!(warning.contains("Shared TTaro GUI tree"), "{warning}");
        assert!(warning.contains("gui/ttaro/"), "{warning}");
        assert!(warning.contains("1 file(s)"), "{warning}");
        assert!(warning.contains("(install b)"), "{warning}");
        assert!(warning.contains("(id shared.gui.ttaro)"), "{warning}");

        // Exactly ONE component record — replaced wholesale.
        assert_eq!(
            installs
                .iter()
                .filter(|r| r.id == "shared.gui.ttaro")
                .count(),
            1
        );
        let shared = installs
            .iter()
            .find(|r| r.id == "shared.gui.ttaro")
            .unwrap();
        assert_eq!(
            shared.hashes.as_ref().unwrap().get("gui/ttaro/index.css"),
            Some(&sha_hex(b"gen-2 bytes")),
            "the record describes the NEW generation"
        );
        assert_eq!(
            shared
                .snapshot_hashes
                .as_ref()
                .unwrap()
                .get("gui/ttaro/index.css"),
            Some(&sha_hex(b"gen-1 bytes")),
            "the new generation layer holds the OLD generation's bytes"
        );
        let layers = tree_files(&PathBuf::from(shared.restore_dir.as_ref().unwrap()));
        assert_eq!(layers.len(), 1);
        assert_eq!(fs::read(&layers[0]).unwrap(), b"gen-1 bytes");
        // The live tree carries the new bytes, and the restore root still
        // holds exactly the one generation layer.
        assert_eq!(
            fs::read(rm.join("gui/ttaro/index.css")).unwrap(),
            b"gen-2 bytes"
        );
        assert_eq!(tree_files(&tmp.join("rr")).len(), 1);
        fs::remove_dir_all(&tmp).ok();
    }

    /// (d)+(e) Consumer-bound lifetime: uninstalling one dependent keeps
    /// the tree, the component record and the OTHER dependent's files;
    /// uninstalling the LAST dependent takes the component record with it
    /// — files removed and the ORIGINAL pre-first-install bytes restored
    /// from the generation layer.
    #[test]
    fn last_dependent_uninstall_removes_and_restores_the_component() {
        let tmp = std::env::temp_dir().join("wowsp_shared_split_last_consumer");
        let _ = fs::remove_dir_all(&tmp);
        let game = tmp.join("game");
        let rm = game.join("bin/1/res_mods");
        fs::create_dir_all(rm.join("gui/ttaro")).unwrap();
        fs::write(rm.join("gui/ttaro/index.css"), b"vanilla original").unwrap();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let game_root = game.to_string_lossy().into_owned();
        let mut installs = Vec::new();
        install_pack(
            &tmp,
            "work-a",
            &game_root,
            "a",
            "1.0",
            &mut installs,
            &[
                ("res_mods/gui/ttaro/index.css", b"gen-1 bytes"),
                ("res_mods/gui/a-only.png", b"png"),
            ],
        );
        install_pack(
            &tmp,
            "work-b",
            &game_root,
            "b",
            "1.0",
            &mut installs,
            &[
                ("res_mods/gui/ttaro/index.css", b"gen-1 bytes"),
                ("res_mods/gui/b-only.png", b"png b"),
            ],
        );

        // (d) dependent 1 leaves: tree + component record stay.
        uninstall_from_ledger(&mut installs, "a", &game_root).unwrap();
        assert_eq!(
            installs.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["shared.gui.ttaro", "b"],
            "the pack record goes, the component record stays"
        );
        assert!(
            !rm.join("gui/a-only.png").exists(),
            "the departing pack's private file goes"
        );
        assert_eq!(
            fs::read(rm.join("gui/ttaro/index.css")).unwrap(),
            b"gen-1 bytes",
            "the shared tree stays at the live bytes"
        );

        // (e) the LAST dependent leaves: the component goes with it and
        // the ORIGINAL pre-first-install bytes come back from the layer.
        uninstall_from_ledger(&mut installs, "b", &game_root).unwrap();
        assert!(
            installs.is_empty(),
            "the component record follows its consumers"
        );
        assert_eq!(
            fs::read(rm.join("gui/ttaro/index.css")).unwrap(),
            b"vanilla original",
            "the generation layer restores the pre-first-install bytes"
        );
        assert!(
            !rm.join("gui/b-only.png").exists(),
            "the last pack's private file goes as always"
        );
        fs::remove_dir_all(&tmp).ok();
    }

    /// (f) Legacy coexistence: a record with INLINED shared files (the
    /// pre-split ledger shape) and a new-style dependent both count as
    /// consumers through the union computation — the tree stays while
    /// either lives, and the last one out removes it and restores the
    /// component's generation layer.
    #[test]
    fn legacy_inlined_dependents_count_through_the_union_computation() {
        let tmp = std::env::temp_dir().join("wowsp_shared_split_legacy_union");
        let _ = fs::remove_dir_all(&tmp);
        let game = tmp.join("game");
        let rm = game.join("bin/1/res_mods");
        fs::create_dir_all(rm.join("gui/ttaro")).unwrap();
        // The legacy record's era put its own bytes live; its snapshot
        // layer captured what IT overwrote (never used again — the
        // component record's layer is the generation authority).
        fs::write(rm.join("gui/ttaro/index.css"), b"legacy-era bytes").unwrap();
        fs::write(rm.join("gui/legacy-only.png"), b"legacy png").unwrap();
        let legacy_restore = tmp.join("restore-legacy");
        fs::create_dir_all(legacy_restore.join("gui/ttaro")).unwrap();
        fs::write(
            legacy_restore.join("gui/ttaro/index.css"),
            b"legacy layer bytes",
        )
        .unwrap();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let game_root = game.to_string_lossy().into_owned();
        let mut installs = vec![ModInstallRecord {
            id: "legacy".into(),
            name: "Legacy".into(),
            version: "0.9".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: vec!["gui/ttaro/index.css".into(), "gui/legacy-only.png".into()],
            restore_dir: Some(legacy_restore.to_string_lossy().into_owned()),
            game_root: game_root.clone(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        }];

        // The new-style dependent rewrites the shared file; the component
        // record captures the legacy-era bytes as its generation layer.
        install_pack(
            &tmp,
            "work-d",
            &game_root,
            "d",
            "1.0",
            &mut installs,
            &[
                ("res_mods/gui/ttaro/index.css", b"gen bytes"),
                ("res_mods/gui/d-only.png", b"d png"),
            ],
        );
        assert_eq!(installs.len(), 3, "legacy + d + component record");

        // The new-style dependent leaves FIRST: the legacy record's
        // inlined shared file still consumes the component.
        uninstall_from_ledger(&mut installs, "d", &game_root).unwrap();
        assert!(installs.iter().any(|r| r.id == "shared.gui.ttaro"));
        assert_eq!(
            fs::read(rm.join("gui/ttaro/index.css")).unwrap(),
            b"gen bytes",
            "the tree stays while the legacy consumer lives"
        );

        // The LEGACY record leaves LAST: its rewind keeps the shared file
        // (the component record claims the root), then the last-consumer
        // cleanup removes the component and restores its generation layer.
        uninstall_from_ledger(&mut installs, "legacy", &game_root).unwrap();
        assert!(installs.is_empty());
        assert_eq!(
            fs::read(rm.join("gui/ttaro/index.css")).unwrap(),
            b"legacy-era bytes",
            "the component's generation layer is what comes back"
        );
        assert!(!rm.join("gui/legacy-only.png").exists());
        fs::remove_dir_all(&tmp).ok();
    }

    /// (g) Wire compat: `sharedRoots` is additive. A ledger written
    /// before the field existed loads with an empty list, an empty list
    /// never puts a key on the wire, and a populated list round-trips
    /// verbatim.
    #[test]
    fn install_records_without_shared_roots_deserialize_empty() {
        let old = serde_json::json!({
            "id": "a",
            "name": "A",
            "version": "1",
            "category": "battle",
            "source": "mod-hub",
            "binVersion": "1",
            "installedAt": "2026-01-01T00:00:00Z",
            "files": ["gui/a.png"],
            "restoreDir": null,
            "gameRoot": ""
        });
        let record: ModInstallRecord = serde_json::from_value(old).unwrap();
        assert!(record.shared_roots.is_empty());
        // Empty stays off the wire entirely — old payloads stay
        // byte-identical.
        let wire = serde_json::to_value(&record).unwrap();
        assert!(wire.get("sharedRoots").is_none());
        // Populated lists round-trip verbatim.
        let mut with_roots = record.clone();
        with_roots.shared_roots = vec!["pnfmods/ttaromodutils/".into()];
        let wire = serde_json::to_value(&with_roots).unwrap();
        assert_eq!(
            wire.get("sharedRoots"),
            Some(&serde_json::json!(["pnfmods/ttaromodutils/"]))
        );
        let back: ModInstallRecord = serde_json::from_value(wire).unwrap();
        assert_eq!(back.shared_roots, with_roots.shared_roots);
    }

    /// Identity + the union claim rule: slugs derive from the registry
    /// spelling, shared records recognize themselves, and a record claims
    /// a component root EITHER through a shared_roots edge OR through an
    /// inlined shared file (never both on one well-formed record).
    #[test]
    fn shared_record_identity_and_union_claims() {
        assert_eq!(
            shared_record_id("pnfmods/ttaromodutils/"),
            "shared.pnfmods.ttaromodutils"
        );
        assert_eq!(
            shared_record_id("pnfmods/modsinstaller_"),
            "shared.pnfmods.modsinstaller_"
        );
        assert_eq!(
            shared_record_id("@game/gettext_x64r.dll"),
            "shared.game.gettext_x64r.dll"
        );
        assert_eq!(
            shared_record_id("texts/en/ttaro-mod-config.mo"),
            "shared.texts.en.ttaro-mod-config.mo"
        );
        assert!(is_shared_record_id("shared.gui.ttaro"));
        assert!(!is_shared_record_id("battle.panel.ttaro"));
        assert_eq!(
            shared_record_label("pnfmods/ttaromodutils/"),
            "Shared TTaro runtime (TTaroModUtils)"
        );

        let mut r = ModInstallRecord {
            id: "a".into(),
            name: "A".into(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: vec!["gui/own/a.css".into()],
            restore_dir: None,
            game_root: String::new(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        };
        assert!(!claims_shared_root(&r, "gui/ttaro/"));
        r.shared_roots = vec!["gui/ttaro/".into()];
        assert!(claims_shared_root(&r, "gui/ttaro/"), "the edge claims");
        r.shared_roots.clear();
        r.files.push("gui/ttaro/index.css".into());
        assert!(
            claims_shared_root(&r, "gui/ttaro/"),
            "the inlined file claims"
        );
    }

    /// Decision-6 verify: record aliveness is file-based, so a shared.*
    /// record whose component files exist on disk survives reconcile even
    /// though no catalog entry can ever claim its id; once the files are
    /// gone it drops like any ghost (a future install recreates it).
    #[test]
    fn reconcile_judges_shared_records_by_their_files() {
        let tmp = std::env::temp_dir().join("wowsp_shared_reconcile");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("game/bin/1/res_mods");
        let shared = "gui/ttaro/index.css";
        fs::create_dir_all(rm.join("gui/ttaro")).unwrap();
        fs::write(rm.join(shared), b"gen bytes").unwrap();
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let mut installs = vec![ModInstallRecord {
            id: "shared.gui.ttaro".into(),
            name: "Shared TTaro GUI tree".into(),
            version: "1.0".into(),
            category: "shared".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: vec![shared.to_string()],
            restore_dir: None,
            game_root: game_root.clone(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        }];

        let report =
            reconcile_core_with_grace(&game_root, &mut installs, std::time::Duration::ZERO);
        assert_eq!(report.dropped_records, 0, "files on disk = alive");
        assert_eq!(installs.len(), 1);

        fs::remove_file(rm.join(shared)).unwrap();
        let report =
            reconcile_core_with_grace(&game_root, &mut installs, std::time::Duration::ZERO);
        assert_eq!(report.dropped_records, 1, "files gone = ghost");
        assert!(installs.is_empty());
        fs::remove_dir_all(&tmp).ok();
    }

    /// (R2-1) Purge regression: the purge reinstall set never contains a
    /// per-component `shared.*` record — with one in the loop the install
    /// of an id no catalog carries would fail, the run would go partial
    /// and the crash-resume marker would be stuck retrying the same id
    /// forever. The component comes back through its dependent's own
    /// reinstall (the post-purge ledger is empty; the dependent reinstalls
    /// and the split recreates the component record).
    #[test]
    fn purge_reinstall_set_skips_shared_records_and_dependents_recreate_them() {
        let tmp = std::env::temp_dir().join("wowsp_shared_purge_set");
        let _ = fs::remove_dir_all(&tmp);
        let game = tmp.join("game");
        let rm = game.join("bin/1/res_mods");
        fs::create_dir_all(rm.join("gui/ttaro")).unwrap();
        fs::write(rm.join("gui/ttaro/index.css"), b"vanilla original").unwrap();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let game_root = game.to_string_lossy().into_owned();
        let mut installs = Vec::new();
        install_pack(
            &tmp,
            "work-dep",
            &game_root,
            "dep",
            "1.0",
            &mut installs,
            &[
                ("res_mods/gui/ttaro/index.css", b"gen bytes"),
                ("res_mods/gui/dep-only.png", b"png"),
            ],
        );
        installs.push(ModInstallRecord {
            id: "some-local".into(),
            name: "Some local".into(),
            version: String::new(),
            category: "local".into(),
            source: "local".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: vec!["gui/local.png".into()],
            restore_dir: None,
            game_root: game_root.clone(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        });
        assert_eq!(installs.len(), 3, "dependent + component + local");

        // The purge set: the dependent and the local row, never the
        // component record (and never a foreign-root record either).
        let set = mod_hub::purge::purge_reinstall_set(&installs, &game_root);
        let ids: Vec<&str> = set.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["dep", "some-local"]);
        // The planned half of the marker derives from the same set with
        // the same source filter the command applies.
        let planned: Vec<&str> = set
            .iter()
            .filter(|r| r.source == "mod-hub")
            .map(|r| r.id.as_str())
            .collect();
        assert_eq!(planned, vec!["dep"], "no shared id can ever be planned");

        // The purge dropped the ledger; the dependent's reinstall rebuilds
        // the component record with its generation layer.
        fs::write(rm.join("gui/ttaro/index.css"), b"vanilla original").unwrap();
        let mut fresh = Vec::new();
        install_pack(
            &tmp,
            "work-dep2",
            &game_root,
            "dep",
            "1.0",
            &mut fresh,
            &[
                ("res_mods/gui/ttaro/index.css", b"gen bytes"),
                ("res_mods/gui/dep-only.png", b"png"),
            ],
        );
        let shared = fresh
            .iter()
            .find(|r| r.id == "shared.gui.ttaro")
            .expect("the component record is reborn via the dependent");
        assert_eq!(shared.files, vec!["gui/ttaro/index.css".to_string()]);
        let layers = tree_files(&PathBuf::from(shared.restore_dir.as_ref().unwrap()));
        assert_eq!(layers.len(), 1);
        assert_eq!(fs::read(&layers[0]).unwrap(), b"vanilla original");
        fs::remove_dir_all(&tmp).ok();
    }

    /// (R2-2) A pack update that DROPS a component must not strand it:
    /// reinstalling the same id with a payload that no longer ships the
    /// component removes the component record with its files (the vanilla
    /// layer restored) — updating everything leaves nothing behind.
    #[test]
    fn pack_update_dropping_a_component_cleans_it_up() {
        let tmp = std::env::temp_dir().join("wowsp_shared_update_drops");
        let _ = fs::remove_dir_all(&tmp);
        let game = tmp.join("game");
        let rm = game.join("bin/1/res_mods");
        fs::create_dir_all(rm.join("gui/ttaro")).unwrap();
        fs::write(rm.join("gui/ttaro/index.css"), b"vanilla original").unwrap();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let game_root = game.to_string_lossy().into_owned();
        let mut installs = Vec::new();
        install_pack(
            &tmp,
            "work-v1",
            &game_root,
            "a",
            "1.0",
            &mut installs,
            &[
                ("res_mods/gui/ttaro/index.css", b"gen bytes"),
                ("res_mods/gui/a-only.png", b"png v1"),
            ],
        );
        assert!(installs.iter().any(|r| r.id == "shared.gui.ttaro"));

        // v2 ships only the private file — the component is dropped.
        install_pack(
            &tmp,
            "work-v2",
            &game_root,
            "a",
            "2.0",
            &mut installs,
            &[("res_mods/gui/a-only.png", b"png v2")],
        );
        assert_eq!(
            installs.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["a"],
            "the component record followed the dropped dependency",
        );
        assert!(!installs.iter().any(|r| r.id == "shared.gui.ttaro"));
        assert_eq!(
            fs::read(rm.join("gui/ttaro/index.css")).unwrap(),
            b"vanilla original",
            "the generation layer restored the pre-component bytes",
        );
        assert_eq!(fs::read(rm.join("gui/a-only.png")).unwrap(), b"png v2");
        fs::remove_dir_all(&tmp).ok();
    }

    /// (R2-5i) A same-id REINSTALL of the only dependent keeps the
    /// component alive: the last-consumer cleanup is a STRICT-uninstall
    /// policy, and the reinstall rewind must not fire it (the fresh
    /// install re-declares the same dependency moments later).
    #[test]
    fn same_id_reinstall_keeps_the_component_record() {
        let tmp = std::env::temp_dir().join("wowsp_shared_reinstall_keeps");
        let _ = fs::remove_dir_all(&tmp);
        let game = tmp.join("game");
        let rm = game.join("bin/1/res_mods");
        fs::create_dir_all(rm.join("gui/ttaro")).unwrap();
        fs::write(rm.join("gui/ttaro/index.css"), b"vanilla original").unwrap();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let game_root = game.to_string_lossy().into_owned();
        let mut installs = Vec::new();
        install_pack(
            &tmp,
            "work-v1",
            &game_root,
            "a",
            "1.0",
            &mut installs,
            &[
                ("res_mods/gui/ttaro/index.css", b"gen bytes"),
                ("res_mods/gui/a-only.png", b"png v1"),
            ],
        );
        install_pack(
            &tmp,
            "work-v2",
            &game_root,
            "a",
            "2.0",
            &mut installs,
            &[
                ("res_mods/gui/ttaro/index.css", b"gen bytes"),
                ("res_mods/gui/a-only.png", b"png v2"),
            ],
        );
        assert_eq!(
            installs.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["shared.gui.ttaro", "a"],
            "the component survived its only dependent's reinstall",
        );
        assert_eq!(
            fs::read(rm.join("gui/ttaro/index.css")).unwrap(),
            b"gen bytes",
            "the tree stays at the live bytes",
        );
        fs::remove_dir_all(&tmp).ok();
    }

    /// (R2-5ii) A pack with BOTH private and shared captured layers keeps
    /// its private restore dir after the split — only the shared layers
    /// move out, so the pack's uninstall can still restore what IT
    /// overwrote.
    #[test]
    fn pack_keeps_its_private_layers_after_the_split() {
        let tmp = std::env::temp_dir().join("wowsp_shared_private_layers");
        let _ = fs::remove_dir_all(&tmp);
        let game = tmp.join("game");
        let rm = game.join("bin/1/res_mods");
        fs::create_dir_all(rm.join("gui/ttaro")).unwrap();
        fs::write(rm.join("gui/ttaro/index.css"), b"vanilla shared").unwrap();
        fs::write(rm.join("gui/a-only.png"), b"vanilla private").unwrap();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let game_root = game.to_string_lossy().into_owned();
        let mut installs = Vec::new();
        install_pack(
            &tmp,
            "work-a",
            &game_root,
            "a",
            "1.0",
            &mut installs,
            &[
                ("res_mods/gui/ttaro/index.css", b"gen shared"),
                ("res_mods/gui/a-only.png", b"gen private"),
            ],
        );
        let pack = installs.iter().find(|r| r.id == "a").unwrap();
        let pack_dir = PathBuf::from(pack.restore_dir.as_ref().expect("private layer kept"));
        let pack_layers = tree_files(&pack_dir);
        assert_eq!(pack_layers.len(), 1, "only the private layer stays");
        assert!(pack_layers[0].ends_with("gui/a-only.png"));
        assert_eq!(fs::read(&pack_layers[0]).unwrap(), b"vanilla private");
        let shared = installs
            .iter()
            .find(|r| r.id == "shared.gui.ttaro")
            .unwrap();
        let shared_layers = tree_files(&PathBuf::from(shared.restore_dir.as_ref().unwrap()));
        assert_eq!(shared_layers.len(), 1);
        assert_eq!(fs::read(&shared_layers[0]).unwrap(), b"vanilla shared");
        assert_eq!(
            tree_files(&tmp.join("rr")).len(),
            2,
            "exactly the private layer + the one generation layer",
        );
        fs::remove_dir_all(&tmp).ok();
    }

    /// (R2-5iii) The `@game` layer relocation preserves the `@game/`
    /// spelling — `restore_tree` maps that prefix back to the game root,
    /// and the last-consumer uninstall proves the round trip by putting
    /// the pre-install DLL bytes back at the game root.
    #[test]
    fn at_game_layers_relocate_with_their_prefix_spelling() {
        let tmp = std::env::temp_dir().join("wowsp_shared_atgame_spelling");
        let _ = fs::remove_dir_all(&tmp);
        let game = tmp.join("game");
        fs::create_dir_all(game.join("bin/1/res_mods/gui")).unwrap();
        fs::write(game.join("gettext_x64r.dll"), b"vanilla dll").unwrap();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let game_root = game.to_string_lossy().into_owned();
        let mut installs = Vec::new();
        install_pack(
            &tmp,
            "work-a",
            &game_root,
            "a",
            "1.0",
            &mut installs,
            &[
                ("res_mods/gui/a-only.png", b"png"),
                ("gettext_x64r.dll", b"gen dll"),
            ],
        );
        let shared = installs
            .iter()
            .find(|r| r.id == "shared.game.gettext_x64r.dll")
            .expect("the game-root component record exists");
        assert_eq!(shared.files, vec!["@game/gettext_x64r.dll".to_string()]);
        let layer =
            PathBuf::from(shared.restore_dir.as_ref().unwrap()).join("@game/gettext_x64r.dll");
        assert!(layer.is_file(), "the layer keeps the @game/ spelling");
        assert_eq!(fs::read(&layer).unwrap(), b"vanilla dll");

        // The last consumer's uninstall walks the layer back to the game
        // root through exactly that spelling.
        uninstall_from_ledger(&mut installs, "a", &game_root).unwrap();
        assert!(installs.is_empty());
        assert_eq!(
            fs::read(game.join("gettext_x64r.dll")).unwrap(),
            b"vanilla dll",
            "the pre-install DLL bytes came back",
        );
        fs::remove_dir_all(&tmp).ok();
    }

    /// (R2-3) Cross-bin replace must not delete the freshly written
    /// `@game` DLL: the existing component record keyed at ANOTHER bin
    /// names the physically-single game-root file, and its rewind would
    /// delete the DLL and restore the old layer over the new bytes. The
    /// upsert protects those entries — last writer wins.
    #[test]
    fn cross_bin_component_replace_keeps_the_fresh_at_game_bytes() {
        let tmp = std::env::temp_dir().join("wowsp_shared_crossbin_atgame");
        let _ = fs::remove_dir_all(&tmp);
        let game = tmp.join("game");
        // The pin names bin 2 as the live build (the fresh install's
        // target); bin 1 carries only the old component record's keying.
        fs::create_dir_all(game.join("bin/1/idx")).unwrap();
        fs::create_dir_all(game.join("bin/2/idx")).unwrap();
        fs::write(
            game.join("preferences.xml"),
            "<root><last_server_version> 15,9,0,2 </last_server_version></root>",
        )
        .unwrap();
        fs::create_dir_all(game.join("bin/2/res_mods/gui")).unwrap();
        fs::write(game.join("gettext_x64r.dll"), b"dll gen-1").unwrap();
        // The old component record: bin 1, its layer even older.
        let restore_old = tmp.join("restore-old");
        fs::create_dir_all(restore_old.join("@game")).unwrap();
        fs::write(restore_old.join("@game/gettext_x64r.dll"), b"dll gen-0").unwrap();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let game_root = game.to_string_lossy().into_owned();
        let mut installs = vec![ModInstallRecord {
            id: "shared.game.gettext_x64r.dll".into(),
            name: "Shared gettext runtime (gettext_x64r.dll)".into(),
            version: "1.0".into(),
            category: "shared".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: vec!["@game/gettext_x64r.dll".into()],
            restore_dir: Some(restore_old.to_string_lossy().into_owned()),
            game_root: game_root.clone(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        }];

        // The dependent installs at the LIVE bin 2 and ships a new DLL.
        install_pack(
            &tmp,
            "work-d",
            &game_root,
            "d",
            "1.0",
            &mut installs,
            &[
                ("res_mods/gui/d-only.png", b"png"),
                ("gettext_x64r.dll", b"dll gen-2"),
            ],
        );

        assert_eq!(
            fs::read(game.join("gettext_x64r.dll")).unwrap(),
            b"dll gen-2",
            "the fresh DLL survives the cross-bin replace",
        );
        let shared: Vec<&ModInstallRecord> = installs
            .iter()
            .filter(|r| r.id == "shared.game.gettext_x64r.dll")
            .collect();
        assert_eq!(shared.len(), 1, "exactly one component record");
        assert_eq!(shared[0].bin_version, "2", "keyed at the live bin");
        let layer =
            PathBuf::from(shared[0].restore_dir.as_ref().unwrap()).join("@game/gettext_x64r.dll");
        assert_eq!(
            fs::read(&layer).unwrap(),
            b"dll gen-1",
            "the new generation layer holds the overwritten bytes",
        );
        assert!(!restore_old.exists(), "the old record's layer died with it");
        fs::remove_dir_all(&tmp).ok();
    }

    /// P4 wire compat: the `hashes` field is additive. A record written
    /// before the field existed (no `hashes` key anywhere in the ledger)
    /// deserializes with `hashes: None`, a `None` never puts a key on the
    /// wire, and a populated map round-trips key-for-key.
    #[test]
    fn install_records_without_hashes_deserialize_as_none() {
        let old = serde_json::json!({
            "id": "a",
            "name": "A",
            "version": "1",
            "category": "battle",
            "source": "mod-hub",
            "binVersion": "1",
            "installedAt": "2026-01-01T00:00:00Z",
            "files": ["PnFMods/TTaroModUtils/x.py"],
            "restoreDir": null,
            "gameRoot": ""
        });
        let record: ModInstallRecord = serde_json::from_value(old).unwrap();
        assert_eq!(record.hashes, None);
        assert_eq!(record.snapshot_hashes, None);
        // `None` stays off the wire entirely — old payloads stay
        // byte-identical.
        let wire = serde_json::to_value(&record).unwrap();
        assert!(wire.get("hashes").is_none());
        assert!(wire.get("snapshotHashes").is_none());
        // Populated maps round-trip verbatim — the written-bytes map and
        // the separate capture-time layer map each under their own key.
        let mut with_hashes = record.clone();
        with_hashes.hashes = Some(
            [(
                "pnfmods/ttaromodutils/x.py".to_string(),
                "deadbeef".to_string(),
            )]
            .into_iter()
            .collect(),
        );
        with_hashes.snapshot_hashes = Some(
            [(
                "pnfmods/ttaromodutils/x.py".to_string(),
                "feedface".to_string(),
            )]
            .into_iter()
            .collect(),
        );
        let wire = serde_json::to_value(&with_hashes).unwrap();
        assert_eq!(
            wire.get("hashes")
                .and_then(|h| h.get("pnfmods/ttaromodutils/x.py")),
            Some(&serde_json::json!("deadbeef"))
        );
        assert_eq!(
            wire.get("snapshotHashes")
                .and_then(|h| h.get("pnfmods/ttaromodutils/x.py")),
            Some(&serde_json::json!("feedface"))
        );
        let back: ModInstallRecord = serde_json::from_value(wire).unwrap();
        assert_eq!(back.hashes, with_hashes.hashes);
        assert_eq!(back.snapshot_hashes, with_hashes.snapshot_hashes);
    }

    /// P4 install-side hashing: only SHARED-COMPONENT files gain a content
    /// hash (a private file never gets an entry, whatever else the install
    /// wrote), keys use the normalized ledger spelling, and an install
    /// with no shared file yields `None` so its record keeps `hashes:
    /// None`.
    #[test]
    fn shared_file_hashes_hash_only_shared_component_paths() {
        let tmp = std::env::temp_dir().join("wowsp_shared_hash_scoping");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("game/bin/1/res_mods");
        fs::create_dir_all(rm.join("PnFMods/TTaroModUtils")).unwrap();
        fs::create_dir_all(rm.join("gui")).unwrap();
        fs::write(rm.join("PnFMods/TTaroModUtils/x.py"), b"shared bytes").unwrap();
        fs::write(rm.join("gui/private.css"), b"private bytes").unwrap();
        fs::write(tmp.join("game/gettext_x64r.dll"), b"dll bytes").unwrap();
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let written = vec![
            "PnFMods/TTaroModUtils/x.py".to_string(),
            "gui/private.css".to_string(),
            "@game/gettext_x64r.dll".to_string(),
        ];
        let hashes =
            shared_file_hashes(&game_root, "1", &written).expect("shared files were written");
        assert_eq!(hashes.len(), 2, "the private file gets no entry");
        let expected = |bytes: &[u8]| {
            use sha2::{Digest, Sha256};
            hex::encode(Sha256::digest(bytes))
        };
        assert_eq!(
            hashes.get("pnfmods/ttaromodutils/x.py"),
            Some(&expected(b"shared bytes")),
            "keys are the normalized ledger spelling"
        );
        assert_eq!(
            hashes.get("@game/gettext_x64r.dll"),
            Some(&expected(b"dll bytes")),
            "game-root drops hash against the game root"
        );
        // No shared component written at all -> None (not an empty map).
        assert_eq!(
            shared_file_hashes(&game_root, "1", &["gui/private.css".to_string()]),
            None
        );
        fs::remove_dir_all(&tmp).ok();
    }

    /// P4 verify-before-restore: a snapshot layer whose bytes fail the
    /// record's stored SHA-256 is skipped and counted in the report's
    /// warnings instead of being restored over the tree; a matching layer
    /// still restores as always. One bad layer never fails the uninstall.
    #[test]
    fn uninstall_skips_a_snapshot_that_fails_its_recorded_hash() {
        let tmp = std::env::temp_dir().join("wowsp_restore_verify");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("game/bin/1/res_mods");
        let shared = "PnFMods/TTaroModUtils/SchemaScanner.py";
        fs::create_dir_all(rm.join("PnFMods/TTaroModUtils")).unwrap();
        fs::write(rm.join(shared), b"live bytes").unwrap();
        let sha = |bytes: &[u8]| {
            use sha2::{Digest, Sha256};
            hex::encode(Sha256::digest(bytes))
        };
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let mk = |restore: &Path| ModInstallRecord {
            id: "b".into(),
            name: "B".into(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: "1".into(),
            installed_at: String::new(),
            files: vec![shared.to_string()],
            restore_dir: Some(restore.to_string_lossy().into_owned()),
            game_root: game_root.clone(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        };

        // A tampered snapshot layer: its actual bytes hash to something
        // OTHER than the capture-time LAYER digest the record stored for
        // it (snapshot_hashes — the map restore verification reads).
        let restore_bad = tmp.join("restore-bad");
        fs::create_dir_all(restore_bad.join("PnFMods/TTaroModUtils")).unwrap();
        fs::write(restore_bad.join(shared), b"tampered bytes").unwrap();
        let mut bad = mk(&restore_bad);
        bad.snapshot_hashes = Some(
            [(uninstall_path_key(shared), sha(b"shared a bytes"))]
                .into_iter()
                .collect(),
        );
        let mut installs = vec![bad];
        let report = uninstall_from_ledger(&mut installs, "b", &game_root).unwrap();
        assert_eq!(
            report.restored_files, 0,
            "the tampered layer is not restored"
        );
        assert_eq!(report.warnings.len(), 1, "{:?}", report.warnings);
        assert!(
            report.warnings[0].contains("SHA-256"),
            "{:?}",
            report.warnings
        );
        assert!(
            report.warnings[0].contains(&uninstall_path_key(shared)),
            "{:?}",
            report.warnings
        );
        assert!(installs.is_empty(), "the uninstall itself still completes");
        // The tampered bytes never reached the tree.
        assert!(!rm.join(shared).exists());

        // A snapshot matching its stored hash restores as always (the
        // first uninstall pruned the emptied component dir, so the live
        // tree is recreated first).
        let restore_ok = tmp.join("restore-ok");
        fs::create_dir_all(restore_ok.join("PnFMods/TTaroModUtils")).unwrap();
        fs::write(restore_ok.join(shared), b"shared a bytes").unwrap();
        fs::create_dir_all(rm.join("PnFMods/TTaroModUtils")).unwrap();
        fs::write(rm.join(shared), b"live bytes").unwrap();
        let mut ok = mk(&restore_ok);
        ok.snapshot_hashes = Some(
            [(uninstall_path_key(shared), sha(b"shared a bytes"))]
                .into_iter()
                .collect(),
        );
        let mut installs = vec![ok];
        let report = uninstall_from_ledger(&mut installs, "b", &game_root).unwrap();
        assert_eq!(report.restored_files, 1);
        assert!(report.warnings.is_empty(), "{:?}", report.warnings);
        assert_eq!(fs::read(rm.join(shared)).unwrap(), b"shared a bytes");
        fs::remove_dir_all(&tmp).ok();
    }

    /// Drive a catalog reinstall of id "a" whose package rewrites the
    /// shared ttaro GUI file with `bytes` (P4 divergence fixtures below).
    /// P4 end-to-end layer verification through the REAL pipeline: install
    /// A over a live shared file (the journal captures a layer of the old
    /// bytes; the record stores the capture-time LAYER hash), then
    /// uninstall — the ORIGINAL pre-A bytes come back with no warnings.
    /// Tamper the layer file after the install and the uninstall instead
    /// skips that restore and counts it. The written-bytes map must never
    /// be consulted for restore verification.
    #[test]
    fn layer_hashes_survive_the_real_install_uninstall_pipeline() {
        let tmp = std::env::temp_dir().join("wowsp_layer_hash_e2e");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("game/bin/1/res_mods");
        let shared = "gui/ttaro/index.css";
        fs::create_dir_all(rm.join("gui/ttaro")).unwrap();
        fs::write(rm.join(shared), b"pre-A original").unwrap();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let sha = |bytes: &[u8]| {
            use sha2::{Digest, Sha256};
            hex::encode(Sha256::digest(bytes))
        };
        let game_root = tmp.join("game").to_string_lossy().into_owned();

        // Install A over the live file through the real catalog core.
        let install_a = |work: &Path| -> mod_hub::PlanApply {
            fs::create_dir_all(work).unwrap();
            zip_fixture(
                &package_archive(work, 0),
                &[("res_mods/gui/ttaro/index.css", b"A's new bytes")],
            );
            let packages = vec![CatalogPackage {
                url: "https://example.com/part.zip".into(),
                sha256: String::new(),
                size: 0,
                name: "part.zip".into(),
            }];
            unpack_and_install("a", "A", work, &game_root, &packages, &[], &mut Vec::new()).unwrap()
        };
        // The ledger record the install command pushes for the applied plan.
        let record_of = |applied: &mod_hub::PlanApply| ModInstallRecord {
            id: "a".into(),
            name: "A".into(),
            version: "1".into(),
            category: "battle".into(),
            source: "mod-hub".into(),
            discussion: None,
            preset: None,
            bin_version: applied.report.bin_version.clone(),
            installed_at: String::new(),
            files: applied.written.clone(),
            restore_dir: applied
                .restore_dir
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            game_root: String::new(),
            hashes: applied.hashes.clone(),
            snapshot_hashes: applied.snapshot_hashes.clone(),
            shared_roots: Vec::new(),
        };

        // Clean hand-off: the layer map hashes the CAPTURED PRE-overwrite
        // bytes while the written map hashes what A wrote — two different
        // digests for the same key, never to be confused.
        let applied = install_a(&tmp.join("work1"));
        assert!(
            applied.restore_dir.is_some(),
            "overwriting a live file captures a layer"
        );
        assert_eq!(
            applied
                .hashes
                .as_ref()
                .unwrap()
                .get(&uninstall_path_key(shared)),
            Some(&sha(b"A's new bytes"))
        );
        assert_eq!(
            applied
                .snapshot_hashes
                .as_ref()
                .unwrap()
                .get(&uninstall_path_key(shared)),
            Some(&sha(b"pre-A original")),
            "the layer map hashes the LAYER copy, not the written bytes"
        );
        let mut installs = vec![record_of(&applied)];
        let report = uninstall_from_ledger(&mut installs, "a", &game_root).unwrap();
        assert_eq!(report.restored_files, 1);
        assert!(report.warnings.is_empty(), "{:?}", report.warnings);
        assert_eq!(
            fs::read(rm.join(shared)).unwrap(),
            b"pre-A original",
            "the ORIGINAL bytes come back"
        );

        // Tampered layer: same install sequence, then the layer file is
        // mutated on disk before the uninstall — the restore is skipped
        // and counted instead of putting unknowable bytes back.
        let applied = install_a(&tmp.join("work2"));
        let restore = applied
            .restore_dir
            .as_ref()
            .expect("overwrote a live file")
            .clone();
        fs::write(restore.join(shared), b"tampered layer").unwrap();
        let mut installs = vec![record_of(&applied)];
        let report = uninstall_from_ledger(&mut installs, "a", &game_root).unwrap();
        assert_eq!(
            report.restored_files, 0,
            "the tampered layer is not restored"
        );
        assert_eq!(report.warnings.len(), 1, "{:?}", report.warnings);
        assert!(
            report.warnings[0].contains("SHA-256"),
            "{:?}",
            report.warnings
        );
        assert!(
            !rm.join(shared).exists(),
            "the tampered bytes never reached the tree"
        );
        fs::remove_dir_all(&tmp).ok();
        fs::remove_dir_all(mod_hub::restore_root()).ok();
    }

    fn reinstall_shared_ttaro(
        work: &Path,
        game_root: &str,
        installs: &mut Vec<ModInstallRecord>,
        bytes: &[u8],
    ) -> mod_hub::PlanApply {
        fs::create_dir_all(work).unwrap();
        zip_fixture(
            &package_archive(work, 0),
            &[("res_mods/gui/ttaro/index.css", bytes)],
        );
        let packages = vec![CatalogPackage {
            url: "https://example.com/part.zip".into(),
            sha256: String::new(),
            size: 0,
            name: "part.zip".into(),
        }];
        unpack_and_install("a", "A", work, game_root, &packages, &[], installs).unwrap()
    }

    /// P4 divergence warning: reinstalling pack A over a shared component
    /// file another live record (B) claims WITH a stored hash warns when
    /// the incoming bytes DIFFER (naming the file and both record ids) and
    /// stays silent when they match — the mixed-version shared-tree
    /// signal, carried on the report's warning channel; nothing is refused
    /// either way.
    #[test]
    fn reinstall_over_divergent_shared_bytes_warns_and_matching_stays_silent() {
        let tmp = std::env::temp_dir().join("wowsp_divergence_warning");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("game/bin/1/res_mods");
        let shared = "gui/ttaro/index.css";
        fs::create_dir_all(rm.join("gui/ttaro")).unwrap();
        fs::write(rm.join(shared), b"ttaro v1").unwrap();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let sha = |bytes: &[u8]| {
            use sha2::{Digest, Sha256};
            hex::encode(Sha256::digest(bytes))
        };
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let mk = |id: &str, hashes: Option<std::collections::HashMap<String, String>>| {
            ModInstallRecord {
                id: id.into(),
                name: id.to_uppercase(),
                version: "1".into(),
                category: "battle".into(),
                source: "mod-hub".into(),
                discussion: None,
                preset: None,
                bin_version: "1".into(),
                installed_at: String::new(),
                files: vec![shared.to_string()],
                restore_dir: None,
                game_root: String::new(),
                hashes,
                snapshot_hashes: None,
                shared_roots: Vec::new(),
            }
        };
        // B (the newer owner) hashed the shared file's v1 bytes at ITS
        // install; A is the older owner being reinstalled.
        let b = mk(
            "b",
            Some(
                [(uninstall_path_key(shared), sha(b"ttaro v1"))]
                    .into_iter()
                    .collect(),
            ),
        );
        let mut installs = vec![mk("a", None), b];

        // DIFFERENT bytes: exactly one mixed-version warning naming the
        // file and both record ids, and the install still lands.
        let applied =
            reinstall_shared_ttaro(&tmp.join("work1"), &game_root, &mut installs, b"ttaro v2");
        assert_eq!(
            applied
                .report
                .warnings
                .iter()
                .filter(|w| w.contains("mixed-version"))
                .count(),
            1,
            "{:?}",
            applied.report.warnings
        );
        let warning = applied
            .report
            .warnings
            .iter()
            .find(|w| w.contains("mixed-version"))
            .unwrap();
        // Aggregated per component: the root, not the individual file.
        assert!(warning.contains("gui/ttaro/"), "{warning}");
        assert!(warning.contains("1 file(s)"), "{warning}");
        assert!(warning.contains("(install a)"), "{warning}");
        assert!(warning.contains("(id b)"), "{warning}");
        assert_eq!(fs::read(rm.join(shared)).unwrap(), b"ttaro v2");
        // The fresh record's own hashes describe the bytes it just wrote.
        assert_eq!(
            applied
                .hashes
                .as_ref()
                .unwrap()
                .get(&uninstall_path_key(shared)),
            Some(&sha(b"ttaro v2"))
        );

        // Same-bytes reinstall (B's stored hash matches the incoming
        // bytes): silent.
        installs.push(mk("a", applied.hashes));
        let reapplied =
            reinstall_shared_ttaro(&tmp.join("work2"), &game_root, &mut installs, b"ttaro v1");
        assert!(
            !reapplied
                .report
                .warnings
                .iter()
                .any(|w| w.contains("mixed-version")),
            "{:?}",
            reapplied.report.warnings
        );
        fs::remove_dir_all(&tmp).ok();
        fs::remove_dir_all(mod_hub::restore_root()).ok();
    }

    /// P4 refresh keeps layer hashes truthful: reinstalling the older
    /// owner refreshes the newer owner's captured layer to the new bytes,
    /// and `sync_snapshot_hashes` must move the owner's stored LAYER
    /// digest with it — otherwise the owner's later uninstall would
    /// misread the freshly refreshed layer as tampered and skip restoring
    /// it (the exact healthy-restore false positive round 2 closed).
    #[test]
    fn refreshed_layers_keep_their_stored_hash_in_step() {
        let tmp = std::env::temp_dir().join("wowsp_refresh_hash_sync");
        let _ = fs::remove_dir_all(&tmp);
        let rm = tmp.join("game/bin/1/res_mods");
        let shared = "gui/ttaro/index.css";
        fs::create_dir_all(rm.join("gui/ttaro")).unwrap();
        fs::write(rm.join(shared), b"a v1").unwrap();
        let restore_b = tmp.join("restore-b");
        fs::create_dir_all(restore_b.join("gui/ttaro")).unwrap();
        fs::write(restore_b.join(shared), b"a v1").unwrap();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let sha = |bytes: &[u8]| {
            use sha2::{Digest, Sha256};
            hex::encode(Sha256::digest(bytes))
        };
        let game_root = tmp.join("game").to_string_lossy().into_owned();
        let mk =
            |id: &str,
             restore: Option<&Path>,
             snapshot_hashes: Option<std::collections::HashMap<String, String>>| {
                ModInstallRecord {
                    id: id.into(),
                    name: id.to_uppercase(),
                    version: "1".into(),
                    category: "battle".into(),
                    source: "mod-hub".into(),
                    discussion: None,
                    preset: None,
                    bin_version: "1".into(),
                    installed_at: String::new(),
                    files: vec![shared.to_string()],
                    restore_dir: restore.map(|p| p.to_string_lossy().into_owned()),
                    game_root: String::new(),
                    hashes: None,
                    snapshot_hashes,
                    shared_roots: Vec::new(),
                }
            };
        // B (the newer owner) captured a layer of A's v1 bytes at its
        // install; A is the older owner being reinstalled with v2 bytes.
        let mut installs = vec![
            mk("a", None, None),
            mk(
                "b",
                Some(&restore_b),
                Some(
                    [(uninstall_path_key(shared), sha(b"a v1"))]
                        .into_iter()
                        .collect(),
                ),
            ),
        ];

        reinstall_shared_ttaro(&tmp.join("work"), &game_root, &mut installs, b"a v2");

        // The layer followed the refreshed bytes, and the stored layer
        // digest followed the layer.
        assert_eq!(fs::read(restore_b.join(shared)).unwrap(), b"a v2");
        assert_eq!(
            installs[0]
                .snapshot_hashes
                .as_ref()
                .unwrap()
                .get(&uninstall_path_key(shared)),
            Some(&sha(b"a v2")),
            "the stored layer digest followed the refreshed bytes"
        );

        // …so B's uninstall restores the refreshed bytes WITHOUT a
        // tamper warning.
        let report = uninstall_from_ledger(&mut installs, "b", &game_root).unwrap();
        assert_eq!(report.restored_files, 1);
        assert!(report.warnings.is_empty(), "{:?}", report.warnings);
        assert_eq!(fs::read(rm.join(shared)).unwrap(), b"a v2");
        fs::remove_dir_all(&tmp).ok();
        fs::remove_dir_all(mod_hub::restore_root()).ok();
    }

    fn catalog_package(url: &str, sha256: &str) -> CatalogPackage {
        CatalogPackage {
            url: url.into(),
            sha256: sha256.into(),
            size: 1824,
            name: "battle.cv.hp-center.zip".into(),
        }
    }

    const PACKAGE_URL: &str =
        "https://github.com/langyo/wowsp/releases/download/mod-hub/battle.cv.hp-center.zip";
    const PACKAGE_SHA: &str = "5d2039e2e047042a8a52f110e99dd0dd5e6dc3a21981b87c44c4cf6833bac43a";

    #[test]
    fn official_pinned_package_yields_its_lowercase_sha() {
        assert_eq!(
            checked_package_sha256(&catalog_package(PACKAGE_URL, &PACKAGE_SHA.to_uppercase()))
                .unwrap(),
            PACKAGE_SHA
        );
    }

    #[test]
    fn package_without_a_valid_sha_is_refused() {
        for sha in ["", "abc", &"z".repeat(64), &format!("{PACKAGE_SHA}0")] {
            let err = checked_package_sha256(&catalog_package(PACKAGE_URL, sha)).unwrap_err();
            assert!(
                err.to_string().contains("no valid SHA-256"),
                "{sha:?}: {err}"
            );
        }
    }

    #[test]
    fn only_root_dlls_reach_the_game_directory() {
        let tmp = std::env::temp_dir().join("wowsp_catalog_loose_roots");
        let _ = fs::remove_dir_all(&tmp);
        for name in [
            "gettext_x64r.dll",
            "WorldOfWarships64.exe",
            "readme.txt",
            "res_mods/x.dll",
        ] {
            touch(&tmp.join(name));
        }
        assert_eq!(loose_root_files(&tmp).unwrap(), vec!["gettext_x64r.dll"]);
        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn package_off_the_release_tree_is_refused() {
        for url in [
            "https://example.com/package.zip",
            "http://github.com/langyo/wowsp/releases/download/mod-hub/battle.cv.hp-center.zip",
            "https://github.com/attacker/wowsp/releases/download/mod-hub/battle.cv.hp-center.zip",
            "https://ghfast.top/https://github.com/langyo/wowsp/releases/download/mod-hub/a.zip",
            "https://github.com/langyo/wowsp/releases/download/mod-hub/../../../../x/y.zip",
        ] {
            let err = checked_package_sha256(&catalog_package(url, PACKAGE_SHA)).unwrap_err();
            assert!(
                err.to_string().contains("not hosted on the WoWSP release"),
                "{url}: {err}"
            );
        }
    }

    // ── mod-integrity install gate ──────────────────────────────────────

    /// The gate tests share the process-global client-index seam
    /// (`TEST_CLIENT_INDEX`): every gate test holds the shared
    /// serialization lock (owned by the seam's home module, so BOTH
    /// suites that depend on the seam queue on the same mutex) across
    /// the whole test — the seam value must hold across the entire
    /// unpack_and_install it drives.
    fn gate_seam_guard() -> std::sync::MutexGuard<'static, ()> {
        crate::commands::mod_integrity::TEST_CLIENT_INDEX_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    /// Point the scan's client index at a deterministic fixture set (the
    /// `TEST_RESTORE_ROOT` pattern: never depend on a real install).
    fn gate_client_index(entries: &[&str]) {
        let set: std::collections::HashSet<String> =
            entries.iter().map(|s| (*s).to_string()).collect();
        *crate::commands::mod_integrity::TEST_CLIENT_INDEX
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(std::sync::Arc::new(set));
    }

    fn gate_client_index_clear() {
        *crate::commands::mod_integrity::TEST_CLIENT_INDEX
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// Gate-test package: the classifier-accepted payload plus the glue /
    /// swf files the scenario needs (all under res_mods/gui/).
    fn gate_packages(work: &Path, extra: &[(&str, &[u8])]) -> Vec<CatalogPackage> {
        fs::create_dir_all(work).unwrap();
        let mut entries: Vec<(&str, &[u8])> = vec![("res_mods/gui/x/a.png", b"payload")];
        entries.extend_from_slice(extra);
        zip_fixture(&package_archive(work, 0), &entries);
        vec![CatalogPackage {
            url: "https://example.com/pack.zip".into(),
            sha256: String::new(),
            size: 0,
            name: "pack.zip".into(),
        }]
    }

    /// (a) The gc-20261101232118338-22840 class: glue referencing an asset
    /// the package does not ship, the (empty) existing mods tree does not
    /// provide and the client does not index — the install is REFUSED
    /// before the first res_mods mutation, with every offender named.
    #[test]
    fn install_refuses_package_whose_glue_references_an_unshipped_swf() {
        let _serial = gate_seam_guard();
        let tmp = std::env::temp_dir().join(format!("wowsp-gate-dangling-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let work = tmp.join("work");
        let game = tmp.join("game");
        fs::create_dir_all(game.join("bin/1")).unwrap();
        let game_root = game.to_string_lossy().into_owned();
        let packages = gate_packages(
            &work,
            &[(
                "res_mods/gui/battle.xml",
                b"<element url=\"battle_stats.swf\"/>".as_slice(),
            )],
        );

        gate_client_index(&[]);
        let err = unpack_and_install(
            "broken-mod",
            "Broken mod",
            &work,
            &game_root,
            &packages,
            &[],
            &mut Vec::new(),
        )
        .err()
        .expect("a dangling swf reference must refuse the install");
        gate_client_index_clear();

        let message = err.to_string();
        assert!(message.contains("Broken mod"), "{message}");
        assert!(message.contains("battle_stats.swf"), "{message}");
        assert!(
            message.contains("which the package does not contain"),
            "{message}"
        );
        assert!(
            message.contains("report the package on the mod hub"),
            "{message}"
        );
        // The gate fires BEFORE the rewind/first mutation: res_mods was
        // never created.
        assert!(!game.join("bin/1/res_mods").exists(), "{message}");
        fs::remove_dir_all(&tmp).ok();
    }

    /// (b) Conservatism guard: the same shape, but the EXISTING res_mods
    /// tree provides the referenced asset — the client index still does not
    /// know it, so ONLY the tree's presence can save the install, which it
    /// must (absence of evidence is not an accusation).
    #[test]
    fn install_accepts_reference_provided_by_existing_res_mods() {
        let _serial = gate_seam_guard();
        let tmp = std::env::temp_dir().join(format!("wowsp-gate-existing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let work = tmp.join("work");
        let game = tmp.join("game");
        let res_mods = game.join("bin/1/res_mods");
        fs::create_dir_all(res_mods.join("gui")).unwrap();
        fs::write(res_mods.join("gui/capabilities.swf"), b"CWS0000").unwrap();
        let game_root = game.to_string_lossy().into_owned();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let packages = gate_packages(
            &work,
            &[(
                "res_mods/gui/battle.xml",
                b"<element url=\"capabilities.swf\"/>".as_slice(),
            )],
        );

        gate_client_index(&[]);
        unpack_and_install(
            "tree-provided",
            "Tree provided",
            &work,
            &game_root,
            &packages,
            &[],
            &mut Vec::new(),
        )
        .expect("a reference the existing mods tree provides must install");
        gate_client_index_clear();

        assert!(game.join("bin/1/res_mods/gui/battle.xml").is_file());
        assert!(game.join("bin/1/res_mods/gui/capabilities.swf").is_file());
        fs::remove_dir_all(&tmp).ok();
    }

    /// (c) A package shipping a corrupt .swf (bad magic) is refused — the
    /// Scaleform loader hangs instead of erroring on such payloads.
    #[test]
    fn install_refuses_package_shipping_a_corrupt_swf() {
        let _serial = gate_seam_guard();
        let tmp = std::env::temp_dir().join(format!("wowsp-gate-badswf-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let work = tmp.join("work");
        let game = tmp.join("game");
        fs::create_dir_all(game.join("bin/1")).unwrap();
        let game_root = game.to_string_lossy().into_owned();
        let packages = gate_packages(
            &work,
            &[("res_mods/gui/broken.swf", b"this is text, not a swf")],
        );

        // No client index needed: the magic check is evidence enough.
        let err = unpack_and_install(
            "corrupt-swf",
            "Corrupt swf",
            &work,
            &game_root,
            &packages,
            &[],
            &mut Vec::new(),
        )
        .err()
        .expect("a corrupt .swf must refuse the install");

        let message = err.to_string();
        assert!(message.contains("Corrupt swf"), "{message}");
        assert!(message.contains("gui/broken.swf"), "{message}");
        assert!(message.contains("not a valid SWF file"), "{message}");
        assert!(!game.join("bin/1/res_mods").exists(), "{message}");
        fs::remove_dir_all(&tmp).ok();
    }

    /// (d) Two files of one package claiming the same asset produce an
    /// `overlap` finding — which is advisory and must NOT block the
    /// install (the asset ships; overlap with existing mods is the user's
    /// call, surfaced by the scan elsewhere).
    #[test]
    fn install_accepts_overlap_claims_without_blocking() {
        let _serial = gate_seam_guard();
        let tmp = std::env::temp_dir().join(format!("wowsp-gate-overlap-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let work = tmp.join("work");
        let game = tmp.join("game");
        fs::create_dir_all(game.join("bin/1")).unwrap();
        let game_root = game.to_string_lossy().into_owned();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let packages = gate_packages(
            &work,
            &[
                (
                    "res_mods/gui/one.xml",
                    b"<element url=\"dupe.swf\"/>".as_slice(),
                ),
                (
                    "res_mods/gui/two.xml",
                    b"<url source=\"dupe.swf\"/>".as_slice(),
                ),
                ("res_mods/gui/dupe.swf", b"CWS0000".as_slice()),
            ],
        );

        gate_client_index(&[]);
        unpack_and_install(
            "overlap-mod",
            "Overlap mod",
            &work,
            &game_root,
            &packages,
            &[],
            &mut Vec::new(),
        )
        .expect("overlap claims are advisory and must not block the install");
        gate_client_index_clear();

        assert!(game.join("bin/1/res_mods/gui/one.xml").is_file());
        assert!(game.join("bin/1/res_mods/gui/two.xml").is_file());
        assert!(game.join("bin/1/res_mods/gui/dupe.swf").is_file());
        fs::remove_dir_all(&tmp).ok();
    }

    /// (e) The gc-20261103 class: the EXISTING mods tree carries dangling
    /// references (a half-finished TTaro install left overlays naming
    /// forge outputs nothing provides) and a CLEAN package is installed
    /// next to them. The tree's pre-existing dangles are advisory —
    /// refusing the package neither cures them nor names the culprit —
    /// so the install proceeds and the package's own files land.
    #[test]
    fn install_accepts_clean_package_despite_existing_tree_dangles() {
        let _serial = gate_seam_guard();
        let tmp =
            std::env::temp_dir().join(format!("wowsp-gate-existdangle-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let work = tmp.join("work");
        let game = tmp.join("game");
        let res_mods = game.join("bin/1/res_mods");
        fs::create_dir_all(res_mods.join("gui")).unwrap();
        fs::write(
            res_mods.join("gui/battle.xml"),
            "<element class=\"lesta.unbound2.UbElement\" elementName=\"RadarTimer\" url=\"battle_stats.swf\"/>",
        )
        .unwrap();
        let game_root = game.to_string_lossy().into_owned();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let packages = gate_packages(&work, &[("res_mods/gui/clean.txt", b"payload")]);

        gate_client_index(&[]);
        unpack_and_install(
            "radar-timer",
            "Radar Timer",
            &work,
            &game_root,
            &packages,
            &[],
            &mut Vec::new(),
        )
        .expect("a clean package must install next to a dangling existing tree");
        gate_client_index_clear();

        assert!(res_mods.join("gui/clean.txt").is_file());
        fs::remove_dir_all(&tmp).ok();
    }

    /// (f) The ModForge toolchain carve-out must recognize the STAGED
    /// extraction shape: a catalog batch unpacks into a root that keeps
    /// the archive's own `res_mods/` prefix, and ModForge's manifest
    /// builder names its own boot-time output (ForgeDefinitions.swf) —
    /// a producer reference, not a dangling load (live report
    /// 2026-11-03: the ASIA sync refused Radar Timer + ModForge on
    /// exactly this file).
    #[test]
    fn install_accepts_modforge_toolchain_glue_under_staged_prefix() {
        let _serial = gate_seam_guard();
        let tmp =
            std::env::temp_dir().join(format!("wowsp-gate-forgeprefix-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let work = tmp.join("work");
        let game = tmp.join("game");
        fs::create_dir_all(game.join("bin/1")).unwrap();
        let game_root = game.to_string_lossy().into_owned();
        let _rr = mod_hub::test_restore_root_in(&tmp.join("rr"));
        let packages = gate_packages(
            &work,
            &[(
                "res_mods/PnFMods/ModForge/Manifest.py",
                b"DEFINITIONS_SWF = PAYLOAD_DIR + 'ForgeDefinitions.swf'".as_slice(),
            )],
        );

        gate_client_index(&[]);
        unpack_and_install(
            "modforge",
            "ModForge",
            &work,
            &game_root,
            &packages,
            &[],
            &mut Vec::new(),
        )
        .expect("the producer's own forge-output reference must not block");
        gate_client_index_clear();

        assert!(
            game.join("bin/1/res_mods/PnFMods/ModForge/Manifest.py")
                .is_file()
        );
        fs::remove_dir_all(&tmp).ok();
    }
}
