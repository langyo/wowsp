//! The replay-share drain CLI's entry point: argv → HTTP orchestration.
//! All policy lives in the lib (host-testable); this binary only moves
//! bytes between the relay's admin faces and the maintainer's disk.

use anyhow::{Context, bail};
use replay_drain::{
    AdminListDoc, Command, CreditsArgs, CreditsDoc, PullArgs, parse_args, verify_and_store,
    write_contributors_envelope,
};
use std::io::Write;
use std::time::Duration;

const HELP: &str = "\
replay-drain — the replay-share maintainer CLI

  replay-drain pull     [options]   collect staged shards: download → verify
                                      (per-member sha256) → archive → drain
  replay-drain credits  [options]   export contributors.json (per-identity
                                      lifetime counts) for the webui res

Options (env fallbacks in parentheses):
  --relay <url>    relay base (WOWSP_RELAY_URL, default https://wowsp.langyo.xyz)
  --key <secret>   the worker's REPLAY_ADMIN_KEY (WOWSP_REPLAY_ADMIN_KEY)
  --out <path>     pull: archive dir (default ./replay-archive); credits:
                   output file (default ./contributors.json — copy it to
                   packages/webui/src/res/contributors.json before building)
  --only <anon>    pull only this contributor (repeatable)
  --min-staged <n> pull only contributors with ≥ n staged members (default 1)
  --dry-run        verify + archive, never call drain
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
    if args.out != std::path::Path::new("packages/webui/src/res/contributors.json") {
        println!("copy it to packages/webui/src/res/contributors.json before building the webui");
    }
    Ok(())
}
