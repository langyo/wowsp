//! The replay-share drain CLI's entry point: argv → HTTP orchestration.
//! All policy lives in the lib (host-testable); this binary only moves
//! bytes between the relay's admin faces and the maintainer's disk.

use anyhow::{Context, bail};
use replay_drain::{
    AdminListDoc, BackfillArgs, BackfillSkip, Command, CreditsArgs, CreditsDoc, PullArgs,
    RenameArgs, ScannedReplay, parse_args, verify_and_store, write_contributors_envelope,
};
use sha2::Digest;
use std::io::Write;
use std::time::Duration;

const HELP: &str = "\
replay-drain — the replay-share maintainer CLI

  replay-drain pull     [options]   collect staged shards: download → verify
                                      (per-member sha256) → archive → drain
  replay-drain credits  [options]   export contributors.json (per-identity
                                      lifetime counts) for the webui res
  replay-drain rename   [options]   correct one contributor's credited name
                                      (the self-reported identity is free
                                      text; typos surface when a lookup by
                                      that name finds nobody)
  replay-drain backfill [options] <paths...>
                                      credit manually collected replays:
                                      parse each header → /check against
                                      the wanted ruleset → one submit per
                                      recorder identity (duplicates skip;
                                      --force credits rule-less ones)

Options (env fallbacks in parentheses):
  --relay <url>    relay base (WOWSP_RELAY_URL, default https://wowsp.langyo.xyz)
  --key <secret>   the worker's REPLAY_ADMIN_KEY (WOWSP_REPLAY_ADMIN_KEY)
  --out <path>     pull: archive dir (default ./replay-archive); credits:
                   output file (default ./contributors.json — copy it to
                   packages/webui/src/data/contributors.json before building)
  --only <anon>    pull only this contributor (repeatable)
  --min-staged <n> pull only contributors with ≥ n staged members (default 1)
  --dry-run        verify + archive, never call drain; backfill: print the
                   per-recorder plan, never submit
  --anon <id>      rename: the contributor's anon id (from the drain
                   console's list or `pull`'s per-contributor lines)
  --name <new>     rename: the corrected credited name
  --realm <code>   backfill: the replays' realm (ru|eu|na|asia|cn) — a file
                   carries no server identity, so this is declared once
  --force          backfill: credit replays no current rule wants
";

#[tokio::main]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let cmd = match parse_args(&argv) {
        Ok(cmd) => cmd,
        Err(e) => {
            eprintln!("{e}\n\n{HELP}");
            std::process::exit(2);
        },
    };
    let run = match cmd {
        Command::Pull(args) => pull(args).await,
        Command::Credits(args) => credits(args).await,
        Command::Rename(args) => rename(args).await,
        Command::Backfill(args) => backfill(args).await,
    };
    if let Err(e) = run {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}

async fn client() -> anyhow::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .connect_timeout(Duration::from_secs(30))
        .build()
        .context("building the HTTP client")
}

async fn pull(args: PullArgs) -> anyhow::Result<()> {
    let client = client().await?;
    println!(
        "relay {} → archive {}{}",
        args.relay,
        args.out.display(),
        if args.dry_run { " (dry-run)" } else { "" }
    );

    let doc: AdminListDoc = client
        .get(format!("{}/api/replays/admin/list", args.relay))
        .header("x-admin-key", &args.key)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .context("GET /api/replays/admin/list")?
        .json()
        .await
        .context("parsing the contributor list")?;
    println!(
        "watermark {} / {} across {} contributor(s)",
        doc.watermark.staged_bytes,
        doc.watermark.limit_bytes,
        doc.contributors.len()
    );

    let selected: Vec<_> = doc
        .contributors
        .iter()
        .filter(|c| c.staged_count >= args.min_staged)
        .filter(|c| args.only.is_empty() || args.only.iter().any(|o| o == &c.anon_id))
        .collect();
    if selected.is_empty() {
        println!("nothing staged to pull");
        return Ok(());
    }

    let mut failures = 0usize;
    for c in &selected {
        println!(
            "[{}] {} ({}) — {} staged, {} bytes",
            c.anon_id, c.credited_name, c.realm, c.staged_count, c.archive_bytes
        );
        let mut resp = client
            .get(format!(
                "{}/api/replays/admin/archive?anon_id={}",
                args.relay, c.anon_id
            ))
            .header("x-admin-key", &args.key)
            .send()
            .await
            .with_context(|| format!("downloading {}'s shard", c.anon_id))?;
        if !resp.status().is_success() {
            bail!(
                "shard download for {} answered {}",
                c.anon_id,
                resp.status()
            );
        }
        // Stream the shard to a scratch file (chunk-by-chunk, never the
        // whole blob in memory), then hand the FILE to the sync verifier.
        let scratch = args.out.join(format!(".shard-{}.tar.zstd", c.anon_id));
        std::fs::create_dir_all(&args.out).ok();
        let mut writer = std::io::BufWriter::new(
            std::fs::File::create(&scratch)
                .with_context(|| format!("creating {}", scratch.display()))?,
        );
        let mut streamed = 0u64;
        while let Some(chunk) = resp
            .chunk()
            .await
            .with_context(|| format!("streaming {}'s shard", c.anon_id))?
        {
            streamed += chunk.len() as u64;
            // The worker's own cap is 256 MiB; anything past that is a
            // hostile or corrupt object, not an archive to verify.
            if streamed > 300 * 1024 * 1024 {
                bail!("{}'s shard exceeds the 300 MiB streaming cap", c.anon_id);
            }
            writer
                .write_all(&chunk)
                .context("writing the shard scratch file")?;
        }
        drop(writer);
        let file = std::fs::File::open(&scratch)
            .with_context(|| format!("reopening {}", scratch.display()))?;
        let out_dir = args.out.clone();
        let anon = c.anon_id.clone();
        let report = tokio::task::spawn_blocking(move || verify_and_store(file, &out_dir))
            .await
            .context("joining the verifier")?
            .with_context(|| format!("verifying {anon}'s shard"))?;
        let _ = std::fs::remove_file(&scratch);
        if !report.failures.is_empty() {
            for f in &report.failures {
                eprintln!("  ! {f}");
            }
            eprintln!(
                "  refusing to drain {} ({} member(s) refused)",
                c.anon_id,
                report.failures.len()
            );
            failures += 1;
            continue;
        }
        println!(
            "  verified {} member(s), {} bytes stored",
            report.members, report.bytes
        );
        if args.dry_run {
            continue;
        }
        let drained: serde_json::Value = client
            .post(format!("{}/api/replays/admin/drain", args.relay))
            .header("x-admin-key", &args.key)
            .json(&serde_json::json!({ "anonIds": [c.anon_id] }))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .with_context(|| format!("draining {}", c.anon_id))?
            .json()
            .await
            .context("parsing the drain reply")?;
        println!("  drained: {}", drained);
    }

    if failures > 0 {
        bail!("{failures} contributor(s) failed verification and stay staged");
    }
    println!("done — {} contributor(s) processed", selected.len());
    Ok(())
}

async fn credits(args: CreditsArgs) -> anyhow::Result<()> {
    let client = client().await?;
    let doc: CreditsDoc = client
        .get(format!("{}/api/replays/admin/credits", args.relay))
        .header("x-admin-key", &args.key)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .context("GET /api/replays/admin/credits")?
        .json()
        .await
        .context("parsing the credits document")?;
    let version = write_contributors_envelope(&args.out, &doc.contributors, chrono::Utc::now())?;
    println!(
        "wrote {} — v{}, {} contributor(s)",
        args.out.display(),
        version,
        doc.contributors.len()
    );
    if args.out != std::path::Path::new("packages/webui/src/data/contributors.json") {
        println!("copy it to packages/webui/src/data/contributors.json before building the webui");
    }
    Ok(())
}

async fn rename(args: RenameArgs) -> anyhow::Result<()> {
    let client = client().await?;
    let resp = client
        .post(format!("{}/api/replays/admin/rename", args.relay))
        .header("x-admin-key", &args.key)
        .json(&serde_json::json!({ "anonId": args.anon, "name": args.name }))
        .send()
        .await
        .context("POST /api/replays/admin/rename")?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    match status {
        reqwest::StatusCode::OK => {
            println!("renamed {} → {}", args.anon, body);
        },
        // The DO's own verdicts, kept distinct so the operator can tell a
        // wrong anon id from a rejected name from an auth problem.
        reqwest::StatusCode::NOT_FOUND => bail!(
            "no contributor under {} — the anon id comes from the drain \
             console's list or `pull`'s per-contributor lines",
            args.anon
        ),
        reqwest::StatusCode::UNAUTHORIZED => {
            bail!("relay answered 401 — the admin key is missing or wrong")
        },
        _ => bail!("relay answered {status}: {body}"),
    }
    Ok(())
}

async fn backfill(args: BackfillArgs) -> anyhow::Result<()> {
    // 1. Collect candidate files: explicit files plus top-level scans of
    // explicit directories (no recursion — a replays/ folder walk is the
    // app's job; this path is for the maintainer's collection folders).
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    for p in &args.paths {
        if p.is_dir() {
            let mut found: Vec<std::path::PathBuf> = std::fs::read_dir(p)
                .with_context(|| format!("reading {}", p.display()))?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|path| {
                    path.is_file()
                        && matches!(
                            path.extension().and_then(|e| e.to_str()),
                            Some("wowsreplay") | Some("korablireplay")
                        )
                })
                .collect();
            found.sort();
            if found.is_empty() {
                eprintln!("  ! {} holds no replay files", p.display());
            }
            files.extend(found);
        } else {
            files.push(p.clone());
        }
    }
    files.sort();
    files.dedup();
    if files.is_empty() {
        bail!("no .wowsreplay/.korablireplay files found in the given paths");
    }

    // 2. Scan: sha256 + the lite header projection (the same reader the
    // app's share wizard plans with, so the facts match its shape).
    let mut scanned: Vec<ScannedReplay> = Vec::new();
    let mut skips: Vec<BackfillSkip> = Vec::new();
    for f in &files {
        let file_name = f
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string)
            .with_context(|| format!("unusable file name {}", f.display()))?;
        let mut hasher = sha2::Sha256::new();
        let mut size = 0u64;
        let mut file =
            std::fs::File::open(f).with_context(|| format!("opening {}", f.display()))?;
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = std::io::Read::read(&mut file, &mut buf)?;
            if n == 0 {
                break;
            }
            sha2::Digest::update(&mut hasher, &buf[..n]);
            size += n as u64;
        }
        let sha256 = hex::encode(sha2::Digest::finalize(hasher));
        let scan = std::panic::catch_unwind(|| wowsp_replay_core::meta::lite_and_client_version(f));
        let Ok((lite, client_version)) = scan else {
            skips.push(BackfillSkip {
                sha256,
                file_name,
                reason: "the header did not survive parsing".into(),
            });
            continue;
        };
        // The server validates EVERY fact in a batch and 400s the whole
        // call on the first bad row, so mirror the plausibility gate here
        // and skip degraded parses per-file (a swept folder is exactly
        // where corrupt or foreign files live).
        let map = lite.map_name.clone().unwrap_or_default();
        let mode = lite.match_group.clone().unwrap_or_default();
        let client_version = client_version.unwrap_or_default();
        let plausibility: Option<&str> = if map.is_empty() || map.chars().count() > 64 {
            Some("the header carries no usable map name")
        } else if mode.is_empty() || mode.chars().count() > 32 {
            Some("the header carries no usable match group")
        } else if lite.player_count == 0 || lite.player_count > 64 {
            Some("the header carries no usable player count")
        } else if lite.bot_count > 64 {
            Some("implausible bot count")
        } else if !(1024..=67_108_864).contains(&size) {
            Some("file size outside the accepted range")
        } else if file_name.chars().count() > 128 {
            Some("file name longer than the server accepts")
        } else if lite
            .scenario
            .as_deref()
            .is_some_and(|s| s.is_empty() || s.chars().count() > 64)
        {
            Some("implausible scenario tag")
        } else if client_version.chars().count() > 32 {
            Some("implausible client version stamp")
        } else {
            None
        };
        if let Some(reason) = plausibility {
            skips.push(BackfillSkip {
                sha256,
                file_name,
                reason: reason.into(),
            });
            continue;
        }
        let facts = serde_json::json!({
            "sha256": sha256,
            "fileName": file_name,
            "sizeBytes": size,
            "map": map,
            "mode": mode,
            "scenario": lite.scenario,
            "realm": args.realm,
            "ownShipId": lite.own_ship_id.map_or(0, |id| id.max(0) as u64),
            "shipClass": serde_json::Value::Null,
            "tier": serde_json::Value::Null,
            "playerCount": lite.player_count,
            "botCount": lite.bot_count,
            "clientVersion": client_version,
            "battleTime": "",
        });
        scanned.push(ScannedReplay {
            sha256,
            file_name,
            size_bytes: size,
            player_name: lite.player_name,
            facts,
        });
    }
    println!(
        "scanned {} file(s), {} unusable for backfill",
        scanned.len(),
        skips.len()
    );
    if scanned.is_empty() {
        return Ok(());
    }

    // 3. One batched /check (public — the same matching the upload
    // pipeline uses, rate-limited per IP, so never per-file).
    let client = client().await?;
    let facts: Vec<serde_json::Value> = scanned.iter().map(|s| s.facts.clone()).collect();
    let resp: serde_json::Value = client
        .post(format!("{}/api/replays/check", args.relay))
        .json(&serde_json::json!({ "facts": facts }))
        .send()
        .await
        .context("POST /api/replays/check")?
        .error_for_status()
        .context("POST /api/replays/check")?
        .json()
        .await
        .context("parsing the check reply")?;
    let results: Vec<replay_drain::CheckRow> = serde_json::from_value(
        resp.get("results")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    )
    .context("parsing the check results")?;

    // 4. Plan per recorder identity.
    let (groups, mut plan_skips) =
        replay_drain::plan_backfill(&scanned, &results, &args.realm, args.force);
    plan_skips.extend(skips);
    for s in &plan_skips {
        println!("  - {} ({})", s.file_name, s.reason);
    }
    if groups.is_empty() {
        println!("nothing to backfill");
        return Ok(());
    }
    for g in &groups {
        println!(
            "[{}] {} — {} member(s) to credit",
            g.realm,
            g.name,
            g.members.len()
        );
    }
    if args.dry_run {
        println!("dry-run — nothing submitted");
        return Ok(());
    }

    // 5. One admin/backfill submit per recorder identity. A group that
    // fails records the failure and the loop CONTINUES — one malformed
    // name must not orphan the identities queued behind it (re-runs are
    // cheap: duplicate hashes skip themselves).
    let mut failures = 0usize;
    for g in &groups {
        let members: Vec<serde_json::Value> = g
            .members
            .iter()
            .map(|m| {
                serde_json::json!({
                    "sha256": m.sha256,
                    "fileName": m.file_name,
                    "sizeBytes": m.size_bytes,
                    "ruleId": m.rule_id,
                })
            })
            .collect();
        // The DO caps a submission at MEMBERS_MAX (400) — a hoarder-scale
        // collection splits into sequential chunks.
        for chunk in members.chunks(400) {
            let resp = client
                .post(format!("{}/api/replays/admin/backfill", args.relay))
                .header("x-admin-key", &args.key)
                .json(&serde_json::json!({
                    "name": g.name,
                    "realm": g.realm,
                    "members": chunk,
                }))
                .send()
                .await
                .context("POST /api/replays/admin/backfill")?;
            let status = resp.status();
            let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
            match status {
                reqwest::StatusCode::OK => println!("  credited: {body}"),
                // Auth is broken for every group — stop immediately.
                reqwest::StatusCode::UNAUTHORIZED => {
                    bail!("relay answered 401 — the admin key is missing or wrong")
                },
                _ => {
                    eprintln!(
                        "  ! [{}] {} failed ({}: {body})",
                        g.realm,
                        g.name,
                        if status == reqwest::StatusCode::CONFLICT {
                            "identity conflict — rename instead".to_string()
                        } else {
                            format!("{status}")
                        }
                    );
                    failures += 1;
                },
            }
        }
    }
    if failures > 0 {
        bail!(
            "{failures} of {} identity group(s) failed to backfill",
            groups.len()
        );
    }
    println!("done — {} identity(ies) credited", groups.len());
    Ok(())
}
