use super::*;

fn touch(path: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, b"x").unwrap();
}

#[test]
fn scan_anchors_units_on_installed_mods_manifest() {
    let tmp = std::env::temp_dir().join("wowsp_manifest_scan");
    let _ = fs::remove_dir_all(&tmp);
    let rm = tmp.join("bin/13187581/res_mods");
    fs::create_dir_all(&rm).unwrap();
    fs::write(
        rm.join("installed_mods.xml"),
        "<?xml version=\"1.0\" ?>\n<data>\n\t<mod installer=\"4.3.1\" name=\"SmokeMarker\" version=\"1.4.0\"/>\n\t<mod installer=\"4.3.1\" name=\"BattleFrame_TorpedoDetection\" version=\"1.0\"/>\n\t<mod installer=\"4.3.1\" name=\"Intuitions\" version=\"1.0.0\"/>\n\t<mod installer=\"4.3.1\" name=\"GhostOnly\" version=\"9.9\"/>\n</data>\n",
    )
    .unwrap();
    // PnF script mod claimed by SmokeMarker through the `Py` convention.
    touch(&rm.join("PnFMods/SmokeMarkerPy/Main.py"));
    fs::write(rm.join("PnFMods/SmokeMarkerPy/Main.py"), "print('no ship')").unwrap();
    // Unbound UI group claimed by the BattleFrame row via shared prefix.
    touch(&rm.join("gui/unbound2/!battleframe/label.xml"));
    // Exact-name PnF skin.
    touch(&rm.join("PnFMods/Intuitions/Main.py"));
    fs::write(
        rm.join("PnFMods/Intuitions/Main.py"),
        "contentSdk.registerShipMod('RSC110')",
    )
    .unwrap();
    touch(&rm.join("PnFModsLoader.py"));
    // Leftover voice bank stays standalone.
    touch(&rm.join("banks/mods/Hoshino/mod.xml"));

    let mods = classify_installed_root(&rm);
    let smoke = mods.iter().find(|m| m.name == "SmokeMarker").unwrap();
    assert_eq!(smoke.version.as_deref(), Some("1.4.0"));
    assert_eq!(smoke.kind, ModKind::Script);
    assert!(
        smoke.paths.contains(&"PnFMods/SmokeMarkerPy".to_string()),
        "{:?}",
        smoke.paths
    );
    let bf = mods
        .iter()
        .find(|m| m.name == "BattleFrame_TorpedoDetection")
        .unwrap();
    assert!(
        bf.paths.contains(&"gui/unbound2/!battleframe".to_string()),
        "{:?}",
        bf.paths
    );
    assert!(!bf.paths.contains(&"PnFMods/SmokeMarkerPy".to_string()));
    let intu = mods.iter().find(|m| m.name == "Intuitions").unwrap();
    assert_eq!(intu.kind, ModKind::Skin);
    assert!(intu.paths.contains(&"PnFMods/Intuitions".to_string()));
    // Manifest-only row survives; its key is the unique row name.
    let ghost = mods.iter().find(|m| m.name == "GhostOnly").unwrap();
    assert!(ghost.paths.is_empty());
    assert_eq!(ghost.rel_path, "GhostOnly");
    assert!(!ghost.disabled);
    // Leftover bank keeps heuristic identity, no version.
    let hoshino = mods.iter().find(|m| m.name == "Hoshino").unwrap();
    assert_eq!(hoshino.version, None);
    // The manifest itself is a marker, never a patch unit.
    assert!(!mods.iter().any(|m| m.name == "installed_mods.xml"));

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn toggle_disables_and_reenables_unit_files() {
    let tmp = std::env::temp_dir().join("wowsp_toggle_test");
    let _ = fs::remove_dir_all(&tmp);
    let rm = tmp.join("bin/1/res_mods");
    touch(&rm.join("PnFMods/SmokeMarkerPy/Main.py"));
    touch(&rm.join("PnFMods/SmokeMarkerPy/data.xml"));
    touch(&rm.join("ime_config.xml"));

    let unit = classify_installed_root(&rm)
        .into_iter()
        .find(|m| m.rel_path == "PnFMods/SmokeMarkerPy")
        .unwrap();
    assert!(!unit.disabled);

    // Disable: every file gains `.bak`, the scan reports the unit off.
    let renamed = set_paths_state(&rm, &unit.paths, false).unwrap();
    assert_eq!(renamed, 2);
    assert!(rm.join("PnFMods/SmokeMarkerPy/Main.py.bak").is_file());
    assert!(!rm.join("PnFMods/SmokeMarkerPy/Main.py").exists());
    let unit = classify_installed_root(&rm)
        .into_iter()
        .find(|m| m.rel_path == "PnFMods/SmokeMarkerPy")
        .unwrap();
    assert!(unit.disabled, "rescan must recognize the disabled unit");

    // Disabling a single-file patch keeps its name; the path is the twin.
    let ime_before = classify_installed_root(&rm)
        .into_iter()
        .find(|m| m.name == "ime_config.xml")
        .unwrap();
    assert!(!ime_before.disabled);
    set_paths_state(&rm, &ime_before.paths, false).unwrap();
    let ime = classify_installed_root(&rm)
        .into_iter()
        .find(|m| m.name == "ime_config.xml")
        .unwrap();
    assert!(ime.disabled);
    assert_eq!(ime.paths, vec!["ime_config.xml.bak".to_string()]);

    // Re-enable strips the suffixes again.
    let renamed = set_paths_state(&rm, &unit.paths, true).unwrap();
    assert_eq!(renamed, 2);
    assert!(rm.join("PnFMods/SmokeMarkerPy/Main.py").is_file());
    assert!(!rm.join("PnFMods/SmokeMarkerPy/Main.py.bak").exists());

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn uninstall_unit_removes_files_and_syncs_manifest() {
    let tmp = std::env::temp_dir().join("wowsp_unit_uninstall");
    let _ = fs::remove_dir_all(&tmp);
    let game = tmp.join("game");
    let rm = game.join("bin/1/res_mods");
    fs::create_dir_all(&rm).unwrap();
    touch(&rm.join("PnFMods/SmokeMarkerPy/Main.py"));
    // The loader marker sits at the res_mods root — no unit owns it, so
    // uninstalling any unit must leave it alone.
    touch(&rm.join("PnFModsLoader.py"));
    // A disabled twin must go too.
    touch(&rm.join("gui/unbound2/!battleframe/label.xml.bak"));
    fs::write(
        rm.join("installed_mods.xml"),
        "<data>\n\t<mod installer=\"4\" name=\"SmokeMarker\" version=\"1.0\"/>\n\t<mod installer=\"4\" name=\"BattleFrame_TorpedoDetection\" version=\"1.0\"/>\n</data>\n",
    )
    .unwrap();

    let smoke = classify_installed_root(&rm)
        .into_iter()
        .find(|m| m.name == "SmokeMarker")
        .unwrap();
    let mut installs: Vec<ModInstallRecord> = Vec::new();
    let report = uninstall_unit_core(game.to_str().unwrap(), &rm, &smoke, &mut installs).unwrap();
    assert_eq!(report.removed_files, 1);
    assert!(!rm.join("PnFMods/SmokeMarkerPy").exists());
    assert!(rm.join("PnFModsLoader.py").is_file());
    // The manifest row is gone, the untouched row survives.
    let manifest = fs::read_to_string(rm.join("installed_mods.xml")).unwrap();
    assert!(!manifest.contains("SmokeMarker"));
    assert!(manifest.contains("BattleFrame_TorpedoDetection"));

    // A manifest-backed unit with disabled files clears both variants.
    let bf = classify_installed_root(&rm)
        .into_iter()
        .find(|m| m.name == "BattleFrame_TorpedoDetection")
        .unwrap();
    assert!(bf.disabled);
    let report = uninstall_unit_core(game.to_str().unwrap(), &rm, &bf, &mut installs).unwrap();
    assert_eq!(report.removed_files, 1);
    assert!(!rm.join("gui/unbound2/!battleframe").exists());
    assert!(
        !fs::read_to_string(rm.join("installed_mods.xml"))
            .unwrap()
            .contains("<mod ")
    );

    // A ledger record whose file the unit overwrote: the vanilla
    // snapshot must survive the uninstall — deletion happens first,
    // the restore lands afterwards (not the other way around).
    let restore = tmp.join("restore-cam");
    fs::create_dir_all(&restore).unwrap();
    fs::write(restore.join("camerasConsumer.xml"), b"vanilla").unwrap();
    fs::write(rm.join("camerasConsumer.xml"), b"modded").unwrap();
    installs.push(ModInstallRecord {
        id: "cam".into(),
        name: "Cam".into(),
        version: "1".into(),
        category: "patch".into(),
        source: "local".into(),
        discussion: None,
        preset: None,
        bin_version: "1".into(),
        installed_at: String::new(),
        files: vec!["camerasConsumer.xml".into()],
        restore_dir: Some(restore.to_string_lossy().into_owned()),
        game_root: String::new(),
    });
    let cam = classify_installed_root(&rm)
        .into_iter()
        .find(|m| m.name == "camerasConsumer.xml")
        .unwrap();
    let report = uninstall_unit_core(game.to_str().unwrap(), &rm, &cam, &mut installs).unwrap();
    assert_eq!(report.restored_files, 1);
    assert_eq!(
        fs::read(rm.join("camerasConsumer.xml")).unwrap(),
        b"vanilla",
        "the vanilla snapshot must outlive the unit deletion"
    );
    assert!(installs.is_empty());

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn scans_mixed_res_mods_layout() {
    let tmp = std::env::temp_dir().join("wowsp_scan_test");
    let _ = fs::remove_dir_all(&tmp);
    let rm = tmp.join("bin/12668706/res_mods");
    // banks with BOTH case variants (real OTTO pack uses Mods).
    touch(&rm.join("banks/mods/Hoshino/mod.xml"));
    fs::write(
        rm.join("banks/mods/Hoshino/mod.xml"),
        "<AudioModification><Name>Hoshino</Name></AudioModification>",
    )
    .unwrap();
    touch(&rm.join("banks/Mods/OTTO Ver1.0/mod.xml"));
    // PnF skin
    fs::create_dir_all(rm.join("PnFMods/Hina_Moskva")).unwrap();
    fs::write(
        rm.join("PnFMods/Hina_Moskva/Main.py"),
        "API_VERSION = 'API_v1.0'\ncontentSdk.registerShipMod('RSC110_Pr_66_Moskva')",
    )
    .unwrap();
    touch(&rm.join("PnFModsLoader.py"));
    // gui + patch
    touch(&rm.join("gui/ribbons/ribbon_citadel.png"));
    touch(&rm.join("ime_config.xml"));

    let mods = classify_installed_root(&rm);
    let voices: Vec<_> = mods.iter().filter(|m| m.kind == ModKind::Voice).collect();
    assert_eq!(voices.len(), 2);
    assert!(
        voices
            .iter()
            .any(|m| m.detail.as_deref() == Some("Hoshino"))
    );
    let skins: Vec<_> = mods.iter().filter(|m| m.kind == ModKind::Skin).collect();
    assert_eq!(skins[0].detail.as_deref(), Some("RSC110_Pr_66_Moskva"));
    assert!(mods.iter().any(|m| m.kind == ModKind::Gui));
    assert!(
        mods.iter()
            .any(|m| m.kind == ModKind::Patch && m.rel_path == "ime_config.xml")
    );

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn ship_unit_name_parses_codes_and_readable_parts() {
    assert_eq!(
        ship_unit_name("JSB039_Yamato_1945_Hull_a"),
        Some(("JSB039".into(), "JSB039 Yamato 1945".into()))
    );
    // Premium prefix is just part of the code; the component word ends
    // the readable name.
    assert_eq!(
        ship_unit_name("PJSB011_Yamato_Hull_a"),
        Some(("PJSB011".into(), "PJSB011 Yamato".into()))
    );
    assert_eq!(
        ship_unit_name("RSC110_Pr_66_Moskva_1948"),
        Some(("RSC110".into(), "RSC110 Pr 66 Moskva 1948".into()))
    );
    // No unit code — nothing to infer a model from.
    assert_eq!(ship_unit_name("default_ao"), None);
    assert_eq!(ship_unit_name("wake_01"), None);
    assert_eq!(ship_unit_name("Gun_barrel"), None);
}

#[test]
fn scan_reports_texture_analysis_for_override_trees() {
    let tmp = std::env::temp_dir().join("wowsp_texanalysis_test");
    let _ = fs::remove_dir_all(&tmp);
    let rm = tmp.join("bin/12668706/res_mods");
    // content/: one identified ship unit, a gun-class texture without a
    // code, and a nation-wide unlock icon.
    touch(
        &rm.join("content/gameplay/japan/ship/battleship/textures/JSB039_Yamato_1945_Hull_a.dds"),
    );
    touch(&rm.join("content/gameplay/usa/gun/main/textures/default_ao.dds"));
    touch(&rm.join("content/unlocks/germany/texture/camo_icon.dds"));
    touch(&rm.join("particles/smoke_flare.prt"));
    touch(&rm.join("spaces/35_neighbors/env_water.dds"));
    // Loose files dropped directly under gameplay/ or spaces/ must not
    // leak into the nation / map-name collections.
    touch(&rm.join("content/gameplay/ussr_stray.dds"));
    touch(&rm.join("spaces/root_level.dds"));
    // Disabled twin: the `.bak` suffix must not leak into the extension.
    touch(&rm.join("texts/HUD_font_01.dds.bak"));

    let mods = classify_installed_root(&rm);
    let find = |name: &str| {
        mods.iter()
            .find(|m| m.kind == ModKind::Textures && m.name == name)
            .unwrap_or_else(|| panic!("{name} unit missing"))
    };

    let content = find("content");
    let a = content.texture_analysis.as_ref().expect("content analyzed");
    assert_eq!(a.categories, ["gameplay", "unlocks"]);
    // `ussr_stray.dds` directly under gameplay/ is a file, not a nation.
    assert_eq!(a.nations, ["germany", "japan", "usa"]);
    assert_eq!(a.species, ["battleship", "gun"]);
    assert_eq!(a.ships, ["JSB039 Yamato 1945"]);
    assert_eq!(a.file_count, 4);
    assert!(!a.truncated);

    let a = find("particles").texture_analysis.as_ref().unwrap();
    assert_eq!(a.categories, ["particles"]);
    assert_eq!(a.file_kinds[0].ext, "prt");

    let a = find("spaces").texture_analysis.as_ref().unwrap();
    assert_eq!(a.categories, ["spaces"]);
    // `root_level.dds` directly under spaces/ is a file, not a map.
    assert_eq!(a.space_names, ["35_neighbors"]);

    let a = find("texts").texture_analysis.as_ref().unwrap();
    assert_eq!(a.file_kinds[0].ext, "dds");

    // Every other kind carries no analysis.
    touch(&rm.join("gui/ribbons/ribbon_citadel.png"));
    let mods = classify_installed_root(&rm);
    assert!(
        mods.iter()
            .filter(|m| m.kind != ModKind::Textures)
            .all(|m| m.texture_analysis.is_none())
    );

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn classify_package_reports_texture_analysis() {
    let tmp = std::env::temp_dir().join("wowsp_pkgtex_test");
    let _ = fs::remove_dir_all(&tmp);
    touch(
        &tmp.join("content/gameplay/japan/ship/battleship/textures/JSB039_Yamato_1945_Hull_a.dds"),
    );
    touch(&tmp.join("particles/flak.prt"));

    let plan = classify_package(&tmp).unwrap();
    let tos: Vec<_> = plan.entries.iter().map(|e| e.to_rel.as_str()).collect();
    assert!(tos.contains(&"content"), "{tos:?}");
    assert!(tos.contains(&"particles"), "{tos:?}");
    let a = plan
        .texture_analysis
        .as_ref()
        .expect("override plan analyzed");
    assert_eq!(a.categories, ["gameplay", "particles"]);
    assert_eq!(a.ships, ["JSB039 Yamato 1945"]);

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn classifies_bare_voice_pack_and_wraps_it() {
    let tmp = std::env::temp_dir().join("wowsp_barepack_test");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();
    fs::write(
        tmp.join("mod.xml"),
        "<AudioModification><Name>聖園ミカ</Name></AudioModification>",
    )
    .unwrap();
    touch(&tmp.join("01.wem"));

    let plan = classify_package(&tmp).unwrap();
    assert_eq!(plan.kind, ModKind::Voice);
    assert_eq!(plan.name, "聖園ミカ");
    assert_eq!(plan.entries[0].to_rel, "banks/mods/聖園ミカ");
    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn classify_reports_missing_pnf_loader_and_ship_ids() {
    let tmp = std::env::temp_dir().join("wowsp_pnfcls_test");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(tmp.join("PnFMods/Arisu_Venezia")).unwrap();
    fs::write(
        tmp.join("PnFMods/Arisu_Venezia/Main.py"),
        "API_VERSION='API_v1.0'; contentSdk.registerShipMod('ISC110_Venezia')",
    )
    .unwrap();

    let plan = classify_package(&tmp).unwrap();
    assert_eq!(plan.kind, ModKind::Skin);
    assert_eq!(plan.detail.as_deref(), Some("ISC110_Venezia"));
    assert!(plan.warnings.iter().any(|w| w.contains("PnFModsLoader")));
    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn classify_peels_single_wrapper_layer() {
    let tmp = std::env::temp_dir().join("wowsp_wrapper_test");
    let _ = fs::remove_dir_all(&tmp);
    // <系列>/<本体>/PnFMods/…+content/… — real 莫斯科日奈换色版 shape.
    fs::create_dir_all(tmp.join("莫斯科日奈/PnFMods/Hina_Moskva")).unwrap();
    fs::write(
        tmp.join("莫斯科日奈/PnFMods/Hina_Moskva/Main.py"),
        "API_VERSION='API_v1.0'\ncontentSdk.registerShipMod('RSC110_Pr_66_Moskva')",
    )
    .unwrap();
    touch(&tmp.join("莫斯科日奈/PnFModsLoader.py"));
    touch(&tmp.join("莫斯科日奈/content/gameplay/russia/textures/a.dds"));

    let plan = classify_package(&tmp).unwrap();
    assert_eq!(plan.kind, ModKind::Skin);
    assert_eq!(plan.detail.as_deref(), Some("RSC110_Pr_66_Moskva"));
    let froms: Vec<_> = plan.entries.iter().map(|e| e.from_rel.as_str()).collect();
    assert!(froms.contains(&"莫斯科日奈/PnFMods"), "{froms:?}");
    assert!(froms.contains(&"莫斯科日奈/content"), "{froms:?}");
    assert!(plan.warnings.iter().any(|w| w.contains("unwrapped")));
    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn install_maps_single_file_patches() {
    // Real ime_config patch: the plan's entry is a FILE, not a subtree.
    let pkg = std::env::temp_dir().join("wowsp_inst_ime");
    let game = std::env::temp_dir().join("wowsp_inst_ime_game");
    let _ = fs::remove_dir_all(&pkg);
    let _ = fs::remove_dir_all(&game);
    fs::create_dir_all(&pkg).unwrap();
    touch(&pkg.join("ime_config.xml"));
    fs::create_dir_all(game.join("bin/1")).unwrap();

    let _rr = test_restore_root_in(&game.join("rr"));
    let plan = classify_package(&pkg).unwrap();
    assert_eq!(plan.kind, ModKind::Patch);
    let report = install_plan(
        Path::new(pkg.to_str().unwrap()),
        game.to_str().unwrap(),
        &plan,
    )
    .map(|applied| applied.report)
    .unwrap();
    assert_eq!(report.wrote_files, 1);
    assert!(game.join("bin/1/res_mods/ime_config.xml").is_file());

    fs::remove_dir_all(&pkg).ok();
    fs::remove_dir_all(&game).ok();
}

#[test]
fn install_copies_tree_and_creates_missing_loader() {
    let pkg = std::env::temp_dir().join("wowsp_inst_pkg");
    let game = std::env::temp_dir().join("wowsp_inst_game");
    let _ = fs::remove_dir_all(&pkg);
    let _ = fs::remove_dir_all(&game);
    fs::create_dir_all(pkg.join("PnFMods/Skin")).unwrap();
    touch(&pkg.join("PnFMods/Skin/Main.py"));
    fs::create_dir_all(game.join("bin/12668706")).unwrap();
    let _rr = test_restore_root_in(&game.join("rr"));

    let plan = classify_package(&pkg).unwrap();
    let report = install_plan(
        Path::new(pkg.to_str().unwrap()),
        game.to_str().unwrap(),
        &plan,
    )
    .map(|applied| applied.report)
    .unwrap();
    assert_eq!(report.wrote_files, 1);
    assert_eq!(report.bin_version, "12668706");
    let rm = game.join("bin/12668706/res_mods");
    assert!(rm.join("PnFMods/Skin/Main.py").is_file());
    assert!(rm.join("PnFModsLoader.py").is_file());

    fs::remove_dir_all(&pkg).ok();
    fs::remove_dir_all(&game).ok();
}

#[test]
fn zip_files_get_structured_error() {
    let err = mod_hub_classify_path("Z:/not/here/pack.zip".into()).unwrap_err();
    assert_eq!(err, UNSUPPORTED_ARCHIVE);
}

#[test]
fn install_rolls_back_completely_on_failure() {
    // A mid-install failure must leave res_mods exactly as it was: the
    // files already written disappear, overwritten originals come back.
    // A half-copied mod tree is precisely what crashes the client.
    let pkg = std::env::temp_dir().join("wowsp_rb_pkg");
    let game = std::env::temp_dir().join("wowsp_rb_game");
    let _ = fs::remove_dir_all(&pkg);
    let _ = fs::remove_dir_all(&game);
    fs::create_dir_all(pkg.join("gui/x")).unwrap();
    fs::write(pkg.join("gui/old.png"), b"mod").unwrap();
    fs::write(pkg.join("gui/x/a.png"), b"a").unwrap();
    fs::write(pkg.join("ime_config.xml"), b"<ime/>").unwrap();
    fs::create_dir_all(game.join("bin/1/res_mods/gui")).unwrap();
    fs::write(game.join("bin/1/res_mods/gui/old.png"), b"vanilla").unwrap();
    let _rr = test_restore_root_in(&game.join("rr"));
    // Sabotage: the second plan entry's destination is occupied by a
    // directory, so the final rename fails after `gui/` already copied.
    fs::create_dir_all(game.join("bin/1/res_mods/ime_config.xml")).unwrap();

    let plan = classify_package(&pkg).unwrap();
    let err = match install_plan(&pkg, game.to_str().unwrap(), &plan) {
        Ok(_) => panic!("sabotaged install must fail"),
        Err(e) => e,
    };
    assert!(err.contains("place"), "{err}");
    let rm = game.join("bin/1/res_mods");
    assert_eq!(fs::read(rm.join("gui/old.png")).unwrap(), b"vanilla");
    assert!(!rm.join("gui/x").exists(), "new files must not survive");
    assert!(rm.join("ime_config.xml").is_dir(), "sabotage intact");
    assert!(!rm.join("ime_config.xml.wowsp-part").exists());

    fs::remove_dir_all(&pkg).ok();
    fs::remove_dir_all(&game).ok();
}

#[test]
fn snapshot_failure_refuses_to_overwrite() {
    // A snapshot that cannot be taken aborts the install — the old
    // best-effort copy silently skipped it (nested snapshot dirs were
    // never created), losing the user's original forever.
    let tmp = std::env::temp_dir().join("wowsp_snap_fail");
    let _ = fs::remove_dir_all(&tmp);
    let rm = tmp.join("res_mods");
    let rd = tmp.join("restore");
    fs::create_dir_all(rm.join("gui")).unwrap();
    fs::write(rm.join("gui/old.png"), b"original").unwrap();
    // A directory squatting on the snapshot path makes the copy fail.
    fs::create_dir_all(rd.join("gui/old.png")).unwrap();
    let journal = InstallJournal {
        res_mods: rm.clone(),
        game_root: tmp.clone(),
        restore_dir: rd,
        actions: Vec::new(),
        placed: std::collections::HashSet::new(),
        written: Vec::new(),
    };
    let err = journal
        .snapshot(&rm.join("gui/old.png"), Place::ResMods)
        .unwrap_err();
    assert!(err.contains("refusing to overwrite"), "{err}");
    assert_eq!(fs::read(rm.join("gui/old.png")).unwrap(), b"original");
    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn plan_paths_are_validated_before_touching_disk() {
    assert!(check_plan_rel("../evil", "toRel", false).is_err());
    assert!(check_plan_rel("/abs", "toRel", false).is_err());
    assert!(check_plan_rel(".", "toRel", false).is_err());
    assert!(check_plan_rel("C:\\x", "fromRel", true).is_err());
    assert!(check_plan_rel("a/../b", "fromRel", true).is_err());
    assert!(check_plan_rel(".", "fromRel", true).is_ok());
    assert!(check_plan_rel("gui/unbound2", "toRel", false).is_ok());
}

#[test]
fn unit_uninstall_trims_partially_overlapping_record() {
    // Uninstalling the shared `content` group must NOT uninstall another
    // mod that merely shares it: the record keeps its outside files and
    // the covered files' vanilla snapshots come back.
    let tmp = std::env::temp_dir().join("wowsp_trim_unit");
    let _ = fs::remove_dir_all(&tmp);
    let game = tmp.join("game");
    let rm = game.join("bin/1/res_mods");
    fs::create_dir_all(rm.join("content/gameplay")).unwrap();
    fs::write(rm.join("content/gameplay/x.dds"), b"mod").unwrap();
    fs::create_dir_all(rm.join("PnFMods/ModB")).unwrap();
    fs::write(rm.join("PnFMods/ModB/Main.py"), b"print()").unwrap();
    let restore = tmp.join("restore-modb");
    fs::create_dir_all(restore.join("content/gameplay")).unwrap();
    fs::write(restore.join("content/gameplay/x.dds"), b"vanilla").unwrap();

    let unit = classify_installed_root(&rm)
        .into_iter()
        .find(|m| m.rel_path == "content")
        .expect("content unit");
    let mut installs = vec![ModInstallRecord {
        id: "modb".into(),
        name: "ModB".into(),
        version: "1".into(),
        category: "battle".into(),
        source: "mod-hub".into(),
        discussion: None,
        preset: None,
        bin_version: "1".into(),
        installed_at: String::new(),
        files: vec![
            "content/gameplay/x.dds".into(),
            "PnFMods/ModB/Main.py".into(),
        ],
        restore_dir: Some(restore.to_string_lossy().into_owned()),
        game_root: String::new(),
    }];
    let report = uninstall_unit_core(game.to_str().unwrap(), &rm, &unit, &mut installs).unwrap();
    assert_eq!(report.restored_files, 1);
    // The covered file returns to its vanilla original…
    assert_eq!(
        fs::read(rm.join("content/gameplay/x.dds")).unwrap(),
        b"vanilla"
    );
    // …the mod's outside files stay…
    assert!(rm.join("PnFMods/ModB/Main.py").is_file());
    // …and the record survives, trimmed to what it still owns.
    assert_eq!(installs.len(), 1);
    assert_eq!(installs[0].files, vec!["PnFMods/ModB/Main.py".to_string()]);
    // Its restore dir no longer carries the restored snapshot.
    assert!(!restore.join("content/gameplay/x.dds").exists());

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn half_disable_violation_detects_mods_spanning_the_unit() {
    let mk = |files: &[&str]| ModInstallRecord {
        id: "x".into(),
        name: "X".into(),
        version: String::new(),
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
    let paths = vec!["content".to_string()];
    // Same tree + files outside it: disabling the unit would half-disable
    // the mod.
    assert!(half_disable_violation(
        &mk(&["content/gameplay/x.dds", "PnFMods/X/Main.py"]),
        &paths
    ));
    // A record living fully inside the unit can be disabled as a whole.
    assert!(!half_disable_violation(
        &mk(&["content/gameplay/x.dds", "content/unlocks/y.dds"]),
        &paths
    ));
    // A record with only outside files is unaffected.
    assert!(!half_disable_violation(&mk(&["PnFMods/X/Main.py"]), &paths));
    // A game-root DLL also counts as "outside" (toggles never touch it).
    assert!(half_disable_violation(
        &mk(&["content/gameplay/x.dds", "@game/gettext_x64r.dll"]),
        &paths
    ));
}

#[test]
fn safe_mode_quarantines_and_restores_res_mods() {
    let tmp = std::env::temp_dir().join("wowsp_safemode");
    let _ = fs::remove_dir_all(&tmp);
    let rm = tmp.join("bin/1/res_mods");
    touch(&rm.join("PnFMods/Skin/Main.py"));
    let root = tmp.to_string_lossy().into_owned();

    assert!(!safe_mode_active(&root));
    assert!(set_safe_mode_core(&root, true).unwrap());
    // One rename: the whole tree left the load path, nothing deleted.
    assert!(!rm.exists());
    assert!(
        tmp.join("bin/1/res_mods.wowsp-disabled/PnFMods/Skin/Main.py")
            .is_file()
    );
    // Mutations are refused while quarantined.
    let err = ensure_res_mods_active(&root).unwrap_err();
    assert!(err.contains("safe mode"), "{err}");
    // Re-enabling errors instead of silently merging a second tree.
    let err = set_safe_mode_core(&root, true).unwrap_err();
    assert!(err.contains("already active"), "{err}");

    assert!(!set_safe_mode_core(&root, false).unwrap());
    assert!(rm.join("PnFMods/Skin/Main.py").is_file());
    assert!(!tmp.join("bin/1/res_mods.wowsp-disabled").exists());
    assert!(ensure_res_mods_active(&root).is_ok());

    // Enabling with no res_mods at all is a clear error, not a fake
    // quarantine.
    let _ = fs::remove_dir_all(&rm);
    let err = set_safe_mode_core(&root, true).unwrap_err();
    assert!(err.contains("nothing to quarantine"), "{err}");

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn safe_mode_restores_stranded_twins_after_game_update() {
    // Safe mode was ON when the game updated: the quarantine twin now
    // sits in the OLD version dir where the UI's safe-mode state no
    // longer looks. Turning mods back on must recover it.
    let tmp = std::env::temp_dir().join("wowsp_safemode_update");
    let _ = fs::remove_dir_all(&tmp);
    let stranded = tmp.join("bin/1/res_mods.wowsp-disabled");
    touch(&stranded.join("gui/old.png"));
    touch(&tmp.join("bin/2/res_mods/gui/new.png"));
    let root = tmp.to_string_lossy().into_owned();

    // A stranded twin keeps the safe-mode affordance visible — the game
    // is running without those mods even though the current bin alone
    // would report false.
    assert!(
        safe_mode_active(&root),
        "stranded twins keep safe mode visible"
    );
    assert!(!set_safe_mode_core(&root, false).unwrap());
    assert!(tmp.join("bin/1/res_mods/gui/old.png").is_file());
    assert!(!stranded.exists());
    assert!(tmp.join("bin/2/res_mods/gui/new.png").is_file());

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn scan_warns_about_same_ship_skin_conflicts() {
    let tmp = std::env::temp_dir().join("wowsp_shipconflict");
    let _ = fs::remove_dir_all(&tmp);
    let rm = tmp.join("bin/1/res_mods");
    for skin in ["Hina_Moskva", "Alt_Moskva"] {
        fs::create_dir_all(rm.join("PnFMods").join(skin)).unwrap();
        fs::write(
            rm.join("PnFMods").join(skin).join("Main.py"),
            "contentSdk.registerShipMod('RSC110_Pr_66_Moskva')",
        )
        .unwrap();
    }
    fs::create_dir_all(rm.join("PnFMods/Other_Ship")).unwrap();
    fs::write(
        rm.join("PnFMods/Other_Ship/Main.py"),
        "contentSdk.registerShipMod('ISC110_Venezia')",
    )
    .unwrap();

    let mods = classify_installed_root(&rm);
    let conflicting: Vec<_> = mods
        .iter()
        .filter(|m| m.kind == ModKind::Skin && m.detail.as_deref() == Some("RSC110_Pr_66_Moskva"))
        .collect();
    assert_eq!(conflicting.len(), 2);
    for m in &conflicting {
        assert_eq!(m.warnings.len(), 1, "{:?}", m.warnings);
        assert!(
            m.warnings[0].contains("RSC110_Pr_66_Moskva"),
            "{:?}",
            m.warnings
        );
    }
    let other = mods.iter().find(|m| m.name == "Other_Ship").unwrap();
    assert!(other.warnings.is_empty());

    // A toggled-off duplicate does not count — exactly one live skin
    // remains, no conflict.
    fs::rename(
        rm.join("PnFMods/Alt_Moskva/Main.py"),
        rm.join("PnFMods/Alt_Moskva/Main.py.bak"),
    )
    .unwrap();
    let mods = classify_installed_root(&rm);
    assert!(
        mods.iter()
            .all(|m| m.kind != ModKind::Skin || m.warnings.is_empty()),
        "disabled duplicate must not warn"
    );

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn stale_versions_report_stranded_older_bins() {
    let tmp = std::env::temp_dir().join("wowsp_stale_scan");
    let _ = fs::remove_dir_all(&tmp);
    // Old bin with stranded mods, an EMPTY old bin (ignored), a
    // non-numeric dir (ignored), and the current bin.
    touch(&tmp.join("bin/1/res_mods/PnFMods/Skin/Main.py"));
    touch(&tmp.join("bin/2/res_mods"));
    fs::create_dir_all(tmp.join("bin/notaversion/res_mods")).unwrap();
    touch(&tmp.join("bin/3/res_mods/gui/a.png"));

    let stale = mod_hub_stale_versions(tmp.to_string_lossy().into_owned()).unwrap();
    assert_eq!(stale.len(), 1, "{stale:?}");
    assert_eq!(stale[0].bin_version, "1");
    assert_eq!(stale[0].file_count, 1);
    assert!(stale[0].mods.contains(&"Skin".to_string()));

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn migrate_moves_stranded_files_and_repoints_ledger() {
    let tmp = std::env::temp_dir().join("wowsp_stale_migrate");
    let _ = fs::remove_dir_all(&tmp);
    let game = tmp.join("game");
    let old = game.join("bin/1/res_mods");
    let cur = game.join("bin/2/res_mods");
    // Stranded tree: a skin, a gui file, a DISABLED voice bank (twin
    // must carry over), the shared loader marker, and one file the
    // current tree already ships (keep-new conflict).
    touch(&old.join("PnFMods/Skin/Main.py"));
    touch(&old.join("gui/old.png"));
    touch(&old.join("banks/mods/Hoshino/mod.xml.bak"));
    touch(&old.join("PnFModsLoader.py"));
    fs::write(old.join("ime_config.xml"), b"old").unwrap();
    fs::create_dir_all(&cur).unwrap();
    fs::write(cur.join("ime_config.xml"), b"new").unwrap();
    touch(&cur.join("own.png"));

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
        files: vec!["PnFMods/Skin/Main.py".into()],
        restore_dir: None,
        game_root: String::new(),
    }];
    let report = migrate_ledgerred(&game, "1", &mut installs).unwrap();
    assert_eq!(report.to_version, "2");
    assert_eq!(report.moved_files, 4, "{report:?}");
    assert_eq!(report.skipped_files, 1);
    // Everything landed in the current bin; conflicts kept the new side.
    assert!(cur.join("PnFMods/Skin/Main.py").is_file());
    assert!(cur.join("gui/old.png").is_file());
    assert!(cur.join("banks/mods/Hoshino/mod.xml.bak").is_file());
    assert!(cur.join("PnFModsLoader.py").is_file());
    assert_eq!(fs::read(cur.join("ime_config.xml")).unwrap(), b"new");
    assert!(cur.join("own.png").is_file());
    // The stranded res_mods is gone entirely.
    assert!(!old.exists());
    // The record now describes the current bin.
    assert_eq!(installs[0].bin_version, "2");

    fs::remove_dir_all(&tmp).ok();
}

/// Drive [`migrate_stale_bin_core`] against an in-memory record list by
/// applying the same bin-version rewrite the command performs on the
/// real ledger.
fn migrate_ledgerred(
    game: &Path,
    from: &str,
    installs: &mut Vec<ModInstallRecord>,
) -> Result<MigrateReport, String> {
    let report = migrate_stale_bin_core(&game.to_string_lossy(), from)?;
    for record in installs.iter_mut() {
        if record.bin_version == from {
            record.bin_version = report.to_version.clone();
        }
    }
    Ok(report)
}

#[test]
fn migrate_keeps_new_on_every_twin_combination() {
    // The four live/twin combinations across the stranded and current
    // trees — only the no-counterpart case may move; a stranded twin
    // landing next to a live file would silently break later toggles.
    let tmp = std::env::temp_dir().join("wowsp_stale_twins");
    let _ = fs::remove_dir_all(&tmp);
    let game = tmp.join("game");
    let old = game.join("bin/1/res_mods");
    let cur = game.join("bin/2/res_mods");
    fs::create_dir_all(old.join("live_conflict")).unwrap();
    fs::create_dir_all(old.join("twin_of_live")).unwrap();
    fs::create_dir_all(cur.join("live_conflict")).unwrap();
    fs::create_dir_all(cur.join("twin_of_live")).unwrap();
    // Stranded live file, current live file → keep-new.
    fs::write(old.join("live_conflict/a.png"), b"old").unwrap();
    fs::write(cur.join("live_conflict/a.png"), b"new").unwrap();
    // Stranded TWIN, current LIVE counterpart → the twin must NOT be
    // transplanted next to the live file.
    fs::write(old.join("twin_of_live/b.png.bak"), b"disabled").unwrap();
    fs::write(cur.join("twin_of_live/b.png"), b"new-live").unwrap();

    let report = migrate_stale_bin_core(&game.to_string_lossy(), "1").unwrap();
    assert_eq!(report.moved_files, 0);
    assert_eq!(report.skipped_files, 2);
    assert_eq!(fs::read(cur.join("live_conflict/a.png")).unwrap(), b"new");
    assert!(!cur.join("twin_of_live/b.png.bak").exists());
    assert_eq!(
        fs::read(cur.join("twin_of_live/b.png")).unwrap(),
        b"new-live"
    );

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn migrate_drops_stranded_aslain_manifest() {
    // The old bin's installed_mods.xml is per-install bookkeeping:
    // transplanting it would resurrect ghost rows for conflict-skipped
    // files, so it dies with the stranded directory.
    let tmp = std::env::temp_dir().join("wowsp_stale_manifest");
    let _ = fs::remove_dir_all(&tmp);
    let game = tmp.join("game");
    let old = game.join("bin/1/res_mods");
    fs::create_dir_all(&old).unwrap();
    fs::write(old.join("installed_mods.xml"), b"<data/>").unwrap();
    touch(&old.join("gui/a.png"));
    fs::create_dir_all(game.join("bin/2/res_mods")).unwrap();

    let report = migrate_stale_bin_core(&game.to_string_lossy(), "1").unwrap();
    assert_eq!(report.moved_files, 1);
    assert_eq!(report.skipped_files, 1);
    assert!(game.join("bin/2/res_mods/gui/a.png").is_file());
    assert!(!game.join("bin/2/res_mods/installed_mods.xml").exists());

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn migration_plan_buckets_by_content_and_drops_bookkeeping() {
    // The wizard's plan: identical content on both sides → duplicate,
    // same path with different bytes → superseded (destination wins),
    // stale-only → decide. Per-install bookkeeping never reaches a
    // bucket — it is deleted outright — and planning is read-only.
    let tmp = std::env::temp_dir().join("wowsp_mig_plan");
    let _ = fs::remove_dir_all(&tmp);
    let game = tmp.join("game");
    let old = game.join("bin/1/res_mods");
    let cur = game.join("bin/2/res_mods");
    fs::create_dir_all(old.join("gui")).unwrap();
    fs::create_dir_all(old.join("PnFMods/Mod")).unwrap();
    fs::create_dir_all(old.join("mods")).unwrap();
    fs::create_dir_all(cur.join("gui")).unwrap();
    fs::write(old.join("gui/dup.png"), b"same").unwrap();
    fs::write(cur.join("gui/dup.png"), b"same").unwrap();
    fs::write(old.join("gui/diff.png"), b"old").unwrap();
    fs::write(cur.join("gui/diff.png"), b"new").unwrap();
    touch(&old.join("PnFMods/Mod/Main.py"));
    fs::write(old.join("PnFModsLoader.py"), b"").unwrap();
    fs::write(old.join("installed_mods.xml"), b"<data/>").unwrap();
    fs::write(old.join("mods/installed.json"), b"{}").unwrap();

    let plan = migration_plan_core(&game.to_string_lossy(), "1").unwrap();
    assert_eq!(plan.from_version, "1");
    assert_eq!(plan.to_version, "2");
    let paths = |v: &[PlanFile]| -> Vec<String> { v.iter().map(|f| f.path.clone()).collect() };
    assert_eq!(paths(&plan.duplicate), vec!["gui/dup.png"]);
    assert_eq!(plan.duplicate[0].size, 4);
    assert_eq!(paths(&plan.superseded), vec!["gui/diff.png"]);
    assert_eq!(paths(&plan.decide), vec!["PnFMods/Mod/Main.py"]);

    // Nothing moved, nothing deleted by a plan.
    assert!(old.join("gui/dup.png").is_file());
    assert!(old.join("installed_mods.xml").is_file());
    assert_eq!(fs::read(cur.join("gui/dup.png")).unwrap(), b"same");

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn migration_execute_moves_keeps_and_cleans_the_rest() {
    let tmp = std::env::temp_dir().join("wowsp_mig_exec");
    let _ = fs::remove_dir_all(&tmp);
    let game = tmp.join("game");
    let old = game.join("bin/1/res_mods");
    let cur = game.join("bin/2/res_mods");
    fs::create_dir_all(old.join("gui")).unwrap();
    fs::create_dir_all(old.join("PnFMods/Mod")).unwrap();
    fs::create_dir_all(old.join("PnFMods/Strayed")).unwrap();
    fs::create_dir_all(cur.join("gui")).unwrap();
    fs::write(old.join("gui/dup.png"), b"same").unwrap();
    fs::write(cur.join("gui/dup.png"), b"same").unwrap();
    fs::write(old.join("gui/diff.png"), b"old").unwrap();
    fs::write(cur.join("gui/diff.png"), b"new").unwrap();
    // A kept decide file whose destination counterpart appears BETWEEN
    // plan and execute — the fresh copy must win, the stale one die.
    fs::write(old.join("gui/late.png"), b"stale").unwrap();
    // A kept disabled twin next to a live destination file — the same
    // keep-new rule as the blind migration must drop it.
    fs::write(old.join("gui/disabled.png.bak"), b"off").unwrap();
    fs::write(cur.join("gui/disabled.png"), b"on").unwrap();
    touch(&old.join("PnFMods/Mod/Main.py"));
    touch(&old.join("PnFMods/Strayed/Main.py"));
    fs::write(old.join("PnFModsLoader.py"), b"").unwrap();
    fs::write(old.join("installed_mods.xml"), b"<data/>").unwrap();

    let plan = migration_plan_core(&game.to_string_lossy(), "1").unwrap();
    assert!(plan.decide.iter().any(|f| f.path == "gui/late.png"));
    fs::write(cur.join("gui/late.png"), b"fresh").unwrap();

    // The user keeps two of the three decide files and the disabled
    // twin (Strayed is dropped).
    let keep = vec![
        "gui/late.png".to_string(),
        "gui/disabled.png.bak".to_string(),
        "PnFMods/Mod/Main.py".to_string(),
    ];
    let report = migration_execute_core(&game.to_string_lossy(), "1", &keep, &[]).unwrap();
    assert_eq!(report.to_version, "2");
    // Only the unblocked keep actually moved; everything else —
    // duplicate, superseded, the late destination surprise, the twin,
    // the dropped Strayed, the loader marker and the manifest — was
    // cleaned up (skipped).
    assert_eq!(report.moved_files, 1, "{report:?}");
    assert_eq!(report.skipped_files, 7, "{report:?}");
    assert_eq!(fs::read(cur.join("PnFMods/Mod/Main.py")).unwrap(), b"x");
    assert_eq!(fs::read(cur.join("gui/late.png")).unwrap(), b"fresh");
    assert_eq!(fs::read(cur.join("gui/diff.png")).unwrap(), b"new");
    assert!(!cur.join("gui/disabled.png.bak").exists());
    assert!(!cur.join("PnFMods/Strayed").exists());
    assert!(!cur.join("PnFModsLoader.py").exists());
    assert!(!cur.join("installed_mods.xml").exists());
    // The stale tree emptied out entirely — skeleton dirs included.
    assert!(!old.exists());

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn migration_execute_leaves_ignored_files_in_place() {
    // The wizard's third verdict: "leave alone". Ignored files stay in
    // the stale bin byte-for-byte — neither moved nor cleaned up — so
    // the stale-bin banner keeps counting them, the stale tree survives
    // (its directories must not be pruned away), and bookkeeping still
    // dies even when ignored.
    let tmp = std::env::temp_dir().join("wowsp_mig_ignore");
    let _ = fs::remove_dir_all(&tmp);
    let game = tmp.join("game");
    let old = game.join("bin/1/res_mods");
    let cur = game.join("bin/2/res_mods");
    fs::create_dir_all(old.join("PnFMods/Kept")).unwrap();
    fs::create_dir_all(old.join("PnFMods/Skipped")).unwrap();
    fs::create_dir_all(&cur).unwrap();
    touch(&old.join("PnFMods/Kept/Main.py"));
    fs::write(old.join("PnFMods/Skipped/Main.py"), b"untouched").unwrap();
    fs::write(old.join("installed_mods.xml"), b"<data/>").unwrap();

    // One decide file kept, one ignored; the manifest is ignored too —
    // it must still be deleted (bookkeeping outranks ignore).
    let keep = vec!["PnFMods/Kept/Main.py".to_string()];
    let ignore = vec![
        "PnFMods/Skipped/Main.py".to_string(),
        "installed_mods.xml".to_string(),
    ];
    let report = migration_execute_core(&game.to_string_lossy(), "1", &keep, &ignore).unwrap();
    assert_eq!(report.moved_files, 1, "{report:?}");
    assert_eq!(report.skipped_files, 1, "{report:?}");
    assert_eq!(report.ignored_files, 1, "{report:?}");
    assert_eq!(
        fs::read(old.join("PnFMods/Skipped/Main.py")).unwrap(),
        b"untouched"
    );
    assert!(!old.join("installed_mods.xml").exists());
    assert_eq!(fs::read(cur.join("PnFMods/Kept/Main.py")).unwrap(), b"x");

    // The stale tree survives its ignored residents.
    assert!(old.join("PnFMods/Skipped").is_dir());

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn repoint_and_uninstall_respect_install_identity() {
    // Two game installs share the ledger AND the bin version. Migrating
    // or uninstalling through one root must never touch the other's
    // records.
    let tmp = std::env::temp_dir().join("wowsp_identity");
    let _ = fs::remove_dir_all(&tmp);
    let a = tmp.join("gameA");
    let b = tmp.join("gameB");
    touch(&a.join("bin/1/res_mods/PnFMods/A/Main.py"));
    touch(&a.join("bin/2/res_mods/x.xml"));
    touch(&b.join("bin/1/res_mods/gui/b.png"));
    let mk = |root: &Path, bin: &str, files: &[&str]| ModInstallRecord {
        id: "m".into(),
        name: "M".into(),
        version: "1".into(),
        category: "battle".into(),
        source: "mod-hub".into(),
        discussion: None,
        preset: None,
        bin_version: bin.into(),
        installed_at: String::new(),
        files: files.iter().map(|f| f.to_string()).collect(),
        restore_dir: None,
        game_root: root.to_string_lossy().into_owned(),
    };
    let mut installs = vec![
        mk(&a, "1", &["PnFMods/A/Main.py"]),
        mk(&b, "1", &["gui/b.png"]),
    ];

    // Migrating A's stranded bin re-points only A's record.
    assert!(repoint_records(
        &mut installs,
        "1",
        "2",
        &a.to_string_lossy()
    ));
    assert_eq!(installs[0].bin_version, "2");
    assert_eq!(installs[1].bin_version, "1", "foreign record untouched");

    // Uninstalling "m" through B removes only B's record.
    let mut ledger = crate::commands::mod_catalog::Ledger { installs };
    // A root with no matching record errors instead of touching the
    // other install's record (the rewind precondition must agree).
    assert!(
        crate::commands::mod_catalog::uninstall_from_ledger(
            &mut ledger.installs,
            "m",
            &tmp.join("gameC").to_string_lossy(),
        )
        .is_err()
    );
    let report = crate::commands::mod_catalog::uninstall_from_ledger(
        &mut ledger.installs,
        "m",
        &b.to_string_lossy(),
    )
    .unwrap();
    assert_eq!(report.removed_files, 1);
    assert!(!b.join("bin/1/res_mods/gui/b.png").exists());
    assert_eq!(ledger.installs.len(), 1, "A's record survives");
    assert!(a.join("bin/2/res_mods/x.xml").is_file());

    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn migrate_rejects_current_version_and_unknown_bins() {
    let tmp = std::env::temp_dir().join("wowsp_stale_migrate_err");
    let _ = fs::remove_dir_all(&tmp);
    touch(&tmp.join("bin/1/res_mods/x.xml"));
    let root = tmp.to_string_lossy().into_owned();
    let err = migrate_stale_bin_core(&root, "1").unwrap_err();
    assert!(err.contains("current version"), "{err}");
    // A version newer than (or equal to) the latest is rejected by the
    // numeric guard before any disk lookup.
    let err = migrate_stale_bin_core(&root, "2").unwrap_err();
    assert!(err.contains("current version"), "{err}");
    let err = migrate_stale_bin_core(&root, "notaversion").unwrap_err();
    assert!(err.contains("not a numeric"), "{err}");
    // A leading-zero spelling of the current version must be rejected
    // numerically, not just by string equality.
    fs::create_dir_all(tmp.join("bin/01/res_mods/stray")).unwrap();
    fs::write(tmp.join("bin/01/res_mods/stray/x.xml"), b"x").unwrap();
    let err = migrate_stale_bin_core(&root, "01").unwrap_err();
    assert!(err.contains("current version"), "{err}");
    assert!(tmp.join("bin/01/res_mods/stray/x.xml").is_file());
    fs::remove_dir_all(&tmp).ok();
}

#[test]
fn conflict_warnings_flag_overlapping_records() {
    let mk = |id: &str, name: &str, files: &[&str]| ModInstallRecord {
        id: id.into(),
        name: name.into(),
        version: String::new(),
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
    let installs = vec![
        mk("a", "ModA", &["gui/a.png", "gui/b.png"]),
        mk("b", "ModB", &["content/x.dds"]),
        mk("stale", "Stale", &["gui/a.png"]),
    ];
    let mut stale = installs[2].clone();
    stale.bin_version = "0".into();
    let list = vec![installs[0].clone(), installs[1].clone(), stale];
    let warnings = conflict_warnings(
        &["gui/a.png".to_string(), "gui/c.png".to_string()],
        &list,
        "self",
        "1",
        "D:/Games/WoWs",
    );
    // Only same-bin, other-id records with actual overlap speak up.
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].contains("ModA"), "{warnings:?}");
    assert!(warnings[0].contains("1 file"), "{warnings:?}");
}

#[test]
fn local_record_describes_local_install() {
    let applied = PlanApply {
        report: InstallReport {
            name: "Mod".into(),
            bin_version: "1".into(),
            wrote_files: 2,
            warnings: Vec::new(),
            conflicts: Vec::new(),
        },
        written: vec!["gui/a.png".into(), "ime_config.xml".into()],
        restore_dir: Some(PathBuf::from("R")),
    };
    let plan = PackagePlan {
        kind: ModKind::Gui,
        name: "Mod".into(),
        detail: None,
        entries: Vec::new(),
        warnings: Vec::new(),
        texture_analysis: None,
    };
    let record = local_record(&applied, &plan, "D:/Games/WoWs");
    assert!(record.id.starts_with("local-"), "{}", record.id);
    assert_eq!(record.source, "local");
    assert_eq!(record.category, "local");
    assert_eq!(record.bin_version, "1");
    assert_eq!(record.files, applied.written);
    assert_eq!(record.restore_dir.as_deref(), Some("R"));
    assert_eq!(record.game_root, "D:/Games/WoWs");
}

// ── Real-world sample harness ───────────────────────────────────────────
// Run against a local mod collection (skipped in CI):
//   WOWSP_SAMPLES_DIR="D:\绿色软件\游戏工具\WOWS" cargo test -p wowsp_tauri
//   -- --ignored --nocapture mod_hub_real
//
// `classify` sweep is read-only; the install leg writes only under %TEMP%.

/// Read-only dump of the scan against a real game install — anchors the
/// manifest grouping on what Aslain actually writes (skipped in CI):
///   WOWSP_GAME_ROOT="D:\...\World of Warships" cargo test -p wowsp_tauri
///   -- --ignored --nocapture mod_hub_real_game_scan
#[test]
#[ignore]
fn mod_hub_real_game_scan() {
    let root = std::env::var("WOWSP_GAME_ROOT").expect("set WOWSP_GAME_ROOT");
    let res_mods = scan_root(&root).expect("scan root");
    for m in classify_installed_root(&res_mods) {
        println!(
            "{:?} {:?} v={:?} disabled={} paths={:?}",
            m.kind, m.name, m.version, m.disabled, m.paths
        );
    }
}

/// Every top-level entry of the samples dir must classify cleanly: dirs
/// produce a typed plan, archives hit the structured unpack hint.
#[test]
#[ignore]
fn mod_hub_real_samples_classify() {
    let dir = std::env::var("WOWSP_SAMPLES_DIR").expect("set WOWSP_SAMPLES_DIR");
    let mut seen = 0;
    for ent in fs::read_dir(&dir).unwrap().flatten() {
        let path = ent.path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if name == "desktop.ini" {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        // Shortcuts/readmes/etc. are not packages — only archives must
        // classify through the structured unpack hint.
        if path.is_file() && !lower.ends_with(".zip") && !lower.ends_with(".7z") {
            println!("{name}: SKIP (not a package)");
            continue;
        }
        match mod_hub_classify_path(path.to_string_lossy().into_owned()) {
            Ok(plan) => {
                println!(
                    "{name}: {:?} \"{}\" detail={:?} entries={} warnings={:?}",
                    plan.kind,
                    plan.name,
                    plan.detail,
                    plan.entries.len(),
                    plan.warnings
                );
                assert!(!plan.entries.is_empty(), "{name}: empty plan");
            },
            Err(err) => {
                // Archives must always hit the structured unpack hint.
                // Non-package payloads (SDK/tutorial trees, standalone
                // tools, raw asset dumps, wrapper dirs of zips) fail with
                // "no recognizable structure" by design — log them, don't
                // treat as harness failures.
                if err == UNSUPPORTED_ARCHIVE {
                    assert!(lower.ends_with(".zip") || lower.ends_with(".7z"));
                    println!("{name}: ARCHIVE (needs M10.2 unpack)");
                } else {
                    assert!(err.contains("no recognizable"), "{name}: {err}");
                    println!("{name}: NOT-A-PACKAGE (rejected by design)");
                }
            },
        }
        seen += 1;
    }
    assert!(seen >= 15, "expected the full sample set, got {seen}");
}

/// Install three representative real packs into a throwaway sandbox game
/// and verify the written tree: bare-voice wrapping, banks passthrough and
/// PnF loader-marker creation.
#[test]
#[ignore]
fn mod_hub_real_samples_install_sandbox() {
    let dir = PathBuf::from(std::env::var("WOWSP_SAMPLES_DIR").expect("set WOWSP_SAMPLES_DIR"));
    let game = std::env::temp_dir().join("wowsp_realsample_game");
    let _ = fs::remove_dir_all(&game);
    fs::create_dir_all(game.join("bin/12668706")).unwrap();
    let _rr = test_restore_root_in(&game.join("rr"));

    // 1. ime_config.xml (config-patch, folder layout).
    let ime = find_dir(&dir, "输入法").expect("ime sample");
    let plan = classify_package(&ime).unwrap();
    let report = install_plan(
        Path::new(ime.to_string_lossy().as_ref()),
        &game.to_string_lossy(),
        &plan,
    )
    .map(|applied| applied.report)
    .unwrap();
    assert!(report.wrote_files >= 1);
    assert!(game.join("bin/12668706/res_mods/ime_config.xml").is_file());

    // 2. Miyako_soundmod — standard banks pack.
    let miyako = find_dir(&dir, "Miyako_soundmod").expect("banks sample");
    let plan = classify_package(&miyako).unwrap();
    assert_eq!(plan.kind, ModKind::Voice);
    let report = install_plan(
        Path::new(miyako.to_string_lossy().as_ref()),
        &game.to_string_lossy(),
        &plan,
    )
    .map(|applied| applied.report)
    .unwrap();
    assert!(
        report.wrote_files > 90,
        "banks pack copied {} files",
        report.wrote_files
    );
    assert!(
        game.join("bin/12668706/res_mods/banks/mods/Miyako/mod.xml")
            .is_file()
    );

    // 3. 莫斯科日奈换色版 — PnF skin with its own loader, nested one level.
    let hina = find_dir(&dir, "莫斯科日奈换色版").expect("pnf sample");
    let pnf_root = find_dir_within(&hina, "PnFModsLoader.py")
        .or_else(|| Some(hina.clone()))
        .unwrap();
    let plan = classify_package(&pnf_root).unwrap();
    assert_eq!(plan.kind, ModKind::Skin);
    let report = install_plan(
        Path::new(pnf_root.to_string_lossy().as_ref()),
        &game.to_string_lossy(),
        &plan,
    )
    .map(|applied| applied.report)
    .unwrap();
    assert!(
        report.wrote_files > 100,
        "pnf pack copied {} files",
        report.wrote_files
    );
    assert!(
        game.join("bin/12668706/res_mods/PnFMods/Hina_Moskva/Main.py")
            .is_file()
    );
    assert!(
        game.join("bin/12668706/res_mods/PnFModsLoader.py")
            .is_file()
    );
    assert!(
        game.join("bin/12668706/res_mods/content/gameplay").is_dir(),
        "texture overrides copied alongside"
    );

    fs::remove_dir_all(&game).ok();
}

fn find_dir(root: &Path, needle: &str) -> Option<PathBuf> {
    fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().contains(needle))
                .unwrap_or(false)
        })
}

/// Peel single-wrapper layers until the PNF payload is exposed.
fn find_dir_within(root: &Path, marker: &str) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if dir.join(marker).is_file() {
            return Some(dir);
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            if e.path().is_dir() {
                stack.push(e.path());
            }
        }
    }
    None
}

/// Realistic Aslain-installed layout, end to end: the modpack's manifest
/// rows + its CamelCase PnFMods trees + a voice bank + an orphan gui
/// fragment. Recognition must see EVERY row (foreign section), pair the
/// rows the catalog knows (identity), and the installed-list classification
/// must anchor on the manifest rows (their names, not raw directory names).
#[test]
fn realistic_aslain_layout_recognizes_and_pairs_end_to_end() {
    use wowsp_tauri_shared::{CatalogEntry, CatalogIndex, CatalogPackage};

    let tmp = std::env::temp_dir().join("wowsp_aslain_e2e");
    let _ = std::fs::remove_dir_all(&tmp);
    let res_mods = tmp.join("bin/1/res_mods");
    for dir in [
        "PnFMods/AdjustableMarkers",
        "PnFMods/ShotTimer",
        "PnFMods/TeamPanelTTaro",
        "gui/unbound2/SomeMod",
        "banks/mods/Hoshino",
    ] {
        std::fs::create_dir_all(res_mods.join(dir)).unwrap();
    }
    std::fs::write(res_mods.join("PnFMods/AdjustableMarkers/Main.py"), b"").unwrap();
    std::fs::write(res_mods.join("PnFMods/ShotTimer/Main.py"), b"").unwrap();
    std::fs::write(res_mods.join("PnFMods/TeamPanelTTaro/Main.py"), b"").unwrap();
    std::fs::write(res_mods.join("gui/unbound2/SomeMod/view.xml"), b"<x/>").unwrap();
    std::fs::write(res_mods.join("banks/mods/Hoshino/mod.xml"), b"<voice/>").unwrap();
    std::fs::write(res_mods.join("PnFModsLoader.py"), b"").unwrap();
    // The modpack's own ledger — row names ARE the install directory names
    // (CamelCase), plus a voice pack row with no matching tree here.
    std::fs::write(
        res_mods.join("installed_mods.xml"),
        "<data>\
         <mod name=\"AdjustableMarkers\" version=\"15.7.0\" installer=\"aslain\"/>\
         <mod name=\"ShotTimer\" version=\"15.7.0\" installer=\"aslain\"/>\
         <mod name=\"TeamPanelTTaro\" installer=\"aslain\"/>\
         <mod name=\"HoshinoVoice\" installer=\"aslain\"/>\
         </data>",
    )
    .unwrap();

    let cat = |id: &str, en: &str| CatalogEntry {
        id: id.into(),
        category: "battle".into(),
        discussion: Some(1),
        version: "1".into(),
        game: "*".into(),
        bundled: false,
        delisted: false,
        presets: Vec::new(),
        tags: Vec::new(),
        title: format!("[Mod] {en} {id} 1"),
        name_zh: String::new(),
        name_en: en.into(),
        description: String::new(),
        author_url: String::new(),
        i18n: std::collections::HashMap::new(),
        packages: vec![CatalogPackage {
            url: "https://x/a.zip".into(),
            sha256: String::new(),
            size: 1,
            name: "a.zip".into(),
        }],
    };
    let catalog = CatalogIndex {
        source_version: String::new(),
        game_version: String::new(),
        fetched_at: String::new(),
        mods: vec![
            cat("battle.marker.adjustable", "Adjustable Markers"),
            cat("battle.timer.shot", "Shot Timer"),
            cat("battle.panel.ttaro", "Team Panels by TTaro"),
        ],
    };

    // ── Recognition: every manifest row lands in [foreign.aslain.*] with
    //    the right pairing (CamelCase dir name normalizes onto the catalog's
    //    spaced display name); the catalog-unknown voice row stays unpaired.
    let foreign = super::foreign::scan_foreign(&res_mods, &tmp.join("bin/1/mods"), Some(&catalog));
    let aslain = &foreign["aslain"];
    assert_eq!(aslain.len(), 4, "every row recognized: {aslain:?}");
    assert_eq!(
        aslain["adjustablemarkers"].identity.as_deref(),
        Some("battle.marker.adjustable")
    );
    assert_eq!(
        aslain["shottimer"].identity.as_deref(),
        Some("battle.timer.shot")
    );
    // "TeamPanelTTaro" vs "Team Panels by TTaro" normalize differently —
    // no false-positive pairing for a name the catalog words differently.
    assert_eq!(aslain["teampanelttaro"].identity, None);
    assert_eq!(aslain["hoshinovoice"].identity, None);
    assert!(foreign["modstation"].is_empty());
    assert_eq!(aslain["shottimer"].version.as_deref(), Some("15.7.0"));

    // ── Classification: the installed list anchors on the manifest rows
    //    (row names, file order), trees hang under them; the orphan gui
    //    fragment stays its own (unanchored) group instead of vanishing.
    let units = classify_installed_root(&res_mods);
    let names: Vec<&str> = units.iter().map(|u| u.name.as_str()).collect();
    // Final ordering groups by kind then name (the list's stable display
    // order) — the ANCHORING contract is that every manifest row appears
    // under its own row name, not as raw directory groups.
    for row in [
        "AdjustableMarkers",
        "ShotTimer",
        "TeamPanelTTaro",
        "HoshinoVoice",
    ] {
        assert!(names.contains(&row), "row {row} anchored: {names:?}");
    }
    let adjustable = units
        .iter()
        .find(|u| u.name == "AdjustableMarkers")
        .unwrap();
    assert!(
        adjustable
            .paths
            .iter()
            .any(|p| p.starts_with("PnFMods/AdjustableMarkers")),
        "tree anchored under its row: {:?}",
        adjustable.paths
    );
    // The orphan unbound view stays its own Gui group (real layout:
    // unbound2/<Mod>/ directories are the battle-view mod units).
    let orphan = units
        .iter()
        .find(|u| u.paths.iter().any(|p| p.starts_with("gui/unbound2")))
        .expect("orphan gui group kept");
    assert_eq!(orphan.name, "SomeMod");

    std::fs::remove_dir_all(&tmp).ok();
}
