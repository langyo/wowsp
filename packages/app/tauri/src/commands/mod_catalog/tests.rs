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

        let (report, written, restore) = unpack_and_install(
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
        let (_report2, _written2, restore2) = unpack_and_install(
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
        let (_r1, written1, restore1) = run(&tmp.join("work1"), b"v1", "res_mods/gui/keep1.png");
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
        }];

        // Reinstall: rewind the old record first (exactly what
        // `mod_catalog_install` now does before unpacking the new version).
        uninstall_from_ledger(&mut installs, "m", &game_root).unwrap();
        assert_eq!(fs::read(game.join("ime_config.xml")).unwrap(), b"vanilla");
        assert!(
            !game.join("gui/keep1.png").exists(),
            "dropped files must go"
        );

        let (_r2, written2, restore2) = run(&tmp.join("work2"), b"v2", "res_mods/gui/keep2.png");
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
        });

        // Final uninstall rewinds to VANILLA, not to v1.
        uninstall_from_ledger(&mut installs, "m", &game_root).unwrap();
        assert_eq!(fs::read(game.join("ime_config.xml")).unwrap(), b"vanilla");
        assert!(!game.join("gui/keep2.png").exists());

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
                    "versions": {
                        "15.7.0.10": {
                            "game": ">=15.7 <15.8",
                            "preview": "https://user-images.githubusercontent.com/x/shot-timer.jpg",
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
        assert_eq!(
            m.preview.as_deref(),
            Some("https://user-images.githubusercontent.com/x/shot-timer.jpg")
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
        let (rep_a, written_a, _) = unpack_and_install(
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
        let (_rep_b, _written_b, _) = unpack_and_install(
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
        let (report, _, _) = unpack_and_install(
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
}
