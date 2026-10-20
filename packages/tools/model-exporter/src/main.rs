//! Ship model GLB exporter — the bake pipeline's front end over the
//! game-asset VFS.
//!
//! A thin CLI around `game_assets::export::ship` with this repo's
//! conventions baked in: the TOP hull upgrade by default (sorted
//! upgrade-name order, matching the exporter this tool replaced),
//! textures off (the hologram bakes read positions only), and an exact
//! GameParams key lookup before any fuzzy name matching.
//!
//! Supersedes the vendored C++ wows-model-exporter (`-W/-s/-o/-L` flags
//! kept compatible). `--texture-size` and `--no-turrets` are accepted
//! and ignored: texture embedding is a boolean here and the pipeline
//! always wants mounts.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use rootcause::prelude::*;
use game_assets::export::ship::{ShipAssets, ShipExportOptions};
use game_assets::game_params::types::GameParamProvider;

struct Args {
    game_dir: PathBuf,
    ship: Option<String>,
    out: Option<PathBuf>,
    /// JSON manifest for batch mode: `[{"ship": key, "out": path}, …]`.
    /// One process then serves the whole list — the GameParams parse
    /// (~18s) and VFS mount are paid once instead of per ship.
    batch: Option<PathBuf>,
    /// Where the batch run writes its `[{"ship","out","ok","error"}]`
    /// results (defaults to `<batch>.results.json`).
    results: Option<PathBuf>,
    lod: usize,
    hull: Option<String>,
    textures: bool,
    damaged: bool,
}

fn parse_args() -> Option<Args> {
    let mut game_dir: Option<PathBuf> = None;
    let mut ship: Option<String> = None;
    let mut out: Option<PathBuf> = None;
    let mut batch: Option<PathBuf> = None;
    let mut results: Option<PathBuf> = None;
    let mut lod: usize = 2;
    let mut hull: Option<String> = None;
    let mut textures = false;
    let mut damaged = false;

    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str();
        let take = |i: &mut usize| -> Option<String> {
            *i += 1;
            argv.get(*i).cloned()
        };
        match a {
            "-W" | "--game-dir" => game_dir = take(&mut i).map(PathBuf::from),
            "-s" | "--ship" => ship = take(&mut i),
            "-o" | "--output" => out = take(&mut i).map(PathBuf::from),
            "--batch" => batch = take(&mut i).map(PathBuf::from),
            "--results" => results = take(&mut i).map(PathBuf::from),
            "-L" | "--lod" => {
                if let Some(v) = take(&mut i)
                    && let Ok(n) = v.parse()
                {
                    lod = n;
                }
            },
            "--hull" => hull = take(&mut i),
            "-T" | "--textures" => textures = true,
            "--damaged" => damaged = true,
            // Accepted for call-site compatibility, no effect here.
            "--texture-size" | "--no-turrets" | "--no-textures" => {
                if matches!(a, "--texture-size") {
                    let _ = take(&mut i);
                }
            },
            _ => {
                eprintln!("unknown argument: {a}");
                return None;
            },
        }
        i += 1;
    }

    if batch.is_none() && (ship.is_none() || out.is_none()) {
        eprintln!("error: either --batch <manifest> or both -s <ship> and -o <out> are required");
        return None;
    }
    Some(Args {
        game_dir: game_dir?,
        ship,
        out,
        batch,
        results,
        lod,
        hull,
        textures,
        damaged,
    })
}

fn main() -> ExitCode {
    let Some(args) = parse_args() else {
        eprintln!(
            "usage: model-exporter -W <game-dir> (-s <key|name> -o <out.glb> | \\\n\
                      --batch <manifest.json> [--results <results.json>]) \\\n\
                      [-L <lod>] [--hull <upgrade>] [-T] [--damaged]"
        );
        return ExitCode::FAILURE;
    };
    match run(&args) {
        Ok(failed) if failed == 0 => ExitCode::SUCCESS,
        Ok(failed) => {
            eprintln!("error: {failed} of the batch exports failed (see results)");
            ExitCode::FAILURE
        },
        Err(report) => {
            eprintln!("error: {report:?}");
            ExitCode::FAILURE
        },
    }
}

fn run(args: &Args) -> Result<usize, Report> {
    println!(
        "[model-exporter] loading game assets from {} (GameParams parse takes a moment) ...",
        args.game_dir.display()
    );
    let assets = ShipAssets::from_game_dir(&args.game_dir)
        .context("failed to load game assets (bad game dir? missing assets.bin?)")?;

    let options_for = |hull_override: Option<&str>| ShipExportOptions {
        lod: args.lod,
        hull: hull_override.map(str::to_string),
        textures: args.textures,
        damaged: args.damaged,
        ..Default::default()
    };

    let export_one = |ship: &str, out: &Path| -> Result<(), Report> {
        // Exact GameParams key (e.g. "PASS510_Gato") or index ("PASS510")
        // first; the fuzzy display-name search only serves human input.
        let vehicle = assets
            .metadata()
            .game_param_by_name(ship)
            .or_else(|| assets.metadata().game_param_by_index(ship))
            .and_then(|p| p.vehicle().cloned());

        let ctx = match &vehicle {
            Some(v) => {
                // TOP hull by default: the last entry of the sorted upgrade
                // names — the hull set the stats pages show.
                let hull = match &args.hull {
                    Some(h) => Some(h.clone()),
                    None => v
                        .hull_upgrades()
                        .map(|upg| {
                            let mut names: Vec<&String> = upg.keys().collect();
                            names.sort();
                            names.pop().cloned()
                        })
                        .flatten(),
                };
                assets.load_ship_from_vehicle(v, &options_for(hull.as_deref()))?
            },
            None => assets.load_ship(ship, &options_for(args.hull.as_deref()))?,
        };
        // The hull directory is shared across sister ships, so the
        // context's param_index may name a sibling — the requested key is
        // the truth. (Cosmetic only: mounts come from OUR vehicle.)
        let _ = ctx.info();

        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).context("failed to create output directory")?;
        }
        let mut file = std::fs::File::create(out)
            .map_err(|e| rootcause::report!("failed to create {}: {e}", out.display()))?;
        ctx.export_glb(&mut file).context("GLB export failed")?;
        Ok(())
    };

    if let Some(batch_path) = &args.batch {
        return batch_run(args, batch_path, export_one);
    }

    let (ship, out) = (args.ship.as_deref().unwrap(), args.out.as_ref().unwrap());
    match export_one(ship, out) {
        Ok(()) => {
            let size = std::fs::metadata(out).map(|m| m.len()).unwrap_or(0);
            println!("[model-exporter] wrote {} ({} bytes)", out.display(), size);
            Ok(0)
        },
        Err(e) => {
            eprintln!("[model-exporter] FAILED {ship}: {e:?}");
            Err(e)
        },
    }
}

fn batch_run(
    args: &Args,
    batch_path: &Path,
    export_one: impl Fn(&str, &Path) -> Result<(), Report>,
) -> Result<usize, Report> {
    // Simple line manifest: `<ship-key> <out-path>` per line. JSON-free so
    // the driver can append lines cheaply and paths with spaces stay
    // unambiguous (one separator, path runs to end of line).
    let text = std::fs::read_to_string(batch_path)
        .map_err(|e| rootcause::report!("failed to read batch {}: {e}", batch_path.display()))?;
    let entries: Vec<(String, PathBuf)> = text
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .filter_map(|l| {
            let mut it = l.splitn(2, ' ');
            let ship = it.next()?.trim().to_string();
            let out = it.next()?.trim().to_string();
            (!ship.is_empty() && !out.is_empty()).then_some((ship, PathBuf::from(out)))
        })
        .collect();
    let total = entries.len();
    println!(
        "[model-exporter] batch: {total} ships from {}",
        batch_path.display()
    );

    let mut failed = 0usize;
    let results: Vec<(String, bool, String)> = entries
        .into_iter()
        .enumerate()
        .map(|(i, (ship, out))| {
            let res = export_one(&ship, &out);
            let ok = res.is_ok();
            match &res {
                Ok(()) => {
                    let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
                    println!(
                        "[model-exporter] {}/{} ✓ {} ({} bytes)",
                        i + 1,
                        total,
                        ship,
                        size
                    );
                },
                Err(report) => {
                    failed += 1;
                    eprintln!(
                        "[model-exporter] {}/{} ✗ {}: {:?}",
                        i + 1,
                        total,
                        ship,
                        report
                    );
                },
            }
            (
                ship,
                ok,
                res.map_err(|r| format!("{r:?}")).err().unwrap_or_default(),
            )
        })
        .collect();

    let results_path = args
        .results
        .clone()
        .unwrap_or_else(|| PathBuf::from(format!("{}.results.txt", batch_path.display())));
    let mut body = String::new();
    for (ship, ok, err) in &results {
        body.push_str(if *ok { "OK " } else { "FAIL " });
        body.push_str(ship);
        if !err.is_empty() {
            body.push('\t');
            body.push_str(err);
        }
        body.push('\n');
    }
    std::fs::write(&results_path, body)
        .map_err(|e| rootcause::report!("failed to write {}: {e}", results_path.display()))?;
    println!(
        "[model-exporter] batch done: {} ok, {failed} failed -> {}",
        total - failed,
        results_path.display()
    );
    Ok(failed)
}
