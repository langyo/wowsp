//! Core logic of the replay-share drain CLI — everything network-free so
//! it stays unit-testable on the host.
//!
//! The maintainer's collect loop (`replay-drain pull`): list contributors
//! → download each R2 shard → verify every member's sha256 against its
//! `<sha256>.<ext>` filename while storing it content-addressed → drain
//! the contributor (the DO marks members drained and frees the watermark).
//! `replay-drain credits` exports the per-identity lifetime counts as the
//! webui's `contributors.json` envelope.

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// The production relay (overridable via --relay / WOWSP_RELAY_URL).
pub const DEFAULT_RELAY: &str = "https://wowsp.langyo.xyz";
/// Member extensions the packer ever writes (contract §8).
const MEMBER_EXTS: [&str; 2] = ["wowsreplay", "korablireplay"];

// ── wire documents (the /api/replays/admin/* faces) ──────────────────────

#[derive(Debug, Deserialize)]
pub struct AdminListDoc {
    pub contributors: Vec<AdminContributor>,
    pub watermark: WatermarkLite,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminContributor {
    pub anon_id: String,
    pub credited_name: String,
    pub realm: String,
    pub staged_count: u64,
    pub archive_bytes: u64,
    #[allow(dead_code)]
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkLite {
    pub staged_bytes: u64,
    pub limit_bytes: u64,
}

#[derive(Debug, Deserialize)]
pub struct CreditsDoc {
    pub contributors: Vec<CreditRow>,
}

/// One credited identity's lifetime count — the exact row shape the
/// webui's contributors.json ships.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditRow {
    pub name: String,
    pub realm: String,
    pub count: u64,
}

// ── shard verification ───────────────────────────────────────────────────

/// A shard's verification outcome: what stored, and what (if anything)
/// refused. Non-empty `failures` means the contributor must NOT be
/// drained — the shard stays staged for a retry after inspection.
pub struct VerifyReport {
    pub members: usize,
    pub bytes: u64,
    pub failures: Vec<String>,
}

/// Stream one downloaded shard (tar.zstd), hash-verify every member
/// against its `<sha256>.<ext>` basename, and store the raw replay
/// files content-addressed under `<out>/raw/`. Verification and storage
/// happen in the same pass (a member is only committed to its final name
/// once its hash matches), so a partial run never leaves a bad file
/// addressable.
pub fn verify_and_store<R: Read>(shard: R, out: &Path) -> anyhow::Result<VerifyReport> {
    let raw = out.join("raw");
    std::fs::create_dir_all(&raw).with_context(|| format!("creating {}", raw.display()))?;
    let zr = zstd::stream::read::Decoder::new(shard).context("opening the zstd stream")?;
    let mut archive = tar::Archive::new(zr);
    let mut report = VerifyReport {
        members: 0,
        bytes: 0,
        failures: Vec::new(),
    };
    for entry in archive.entries().context("walking the tar members")? {
        let mut entry = entry.context("reading a tar member")?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let name = entry
            .path()
            .context("member path")?
            .to_string_lossy()
            .to_string();
        let fname = name.rsplit(['/', '\\']).next().unwrap_or("");
        let Some((stem, ext)) = fname.split_once('.') else {
            report
                .failures
                .push(format!("{name}: not a <sha256>.<ext> member"));
            continue;
        };
        if stem.len() != 64
            || !stem
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            || !MEMBER_EXTS.contains(&ext)
        {
            report
                .failures
                .push(format!("{name}: malformed member name"));
            continue;
        }
        let tmp = raw.join(format!(".tmp-{stem}.{ext}"));
        let mut writer =
            std::fs::File::create(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 64 * 1024];
        let mut size = 0u64;
        loop {
            let n = entry.read(&mut buf).context("streaming a member")?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            writer.write_all(&buf[..n])?;
            size += n as u64;
        }
        let got = hex::encode(hasher.finalize());
        if got != stem {
            let _ = std::fs::remove_file(&tmp);
            report
                .failures
                .push(format!("{name}: content hashes to {got}, refusing"));
            continue;
        }
        let final_path = raw.join(fname);
        if final_path.exists() {
            // Already archived from an earlier pull — content-addressed,
            // so equal names mean equal bytes; drop the redundant copy.
            let _ = std::fs::remove_file(&tmp);
        } else {
            std::fs::rename(&tmp, &final_path)
                .with_context(|| format!("committing {}", final_path.display()))?;
        }
        report.members += 1;
        report.bytes += size;
    }
    Ok(report)
}

// ── the credits envelope ─────────────────────────────────────────────────

/// Write the webui's `contributors.json` envelope over `path`, bumping
/// the version from whatever the file already carried (a fresh file
/// starts at 1). Returns the version written.
pub fn write_contributors_envelope(
    path: &Path,
    rows: &[CreditRow],
    now: chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<u64> {
    let prev = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("version").and_then(|v| v.as_u64()))
        .unwrap_or(0);
    let version = prev + 1;
    let doc = serde_json::json!({
        "version": version,
        "generatedAt": now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "contributors": rows,
    });
    std::fs::write(path, serde_json::to_vec_pretty(&doc)?)?;
    Ok(version)
}

// ── argv ────────────────────────────────────────────────────────────────

/// The manual arg grammar (no clap — the repo keeps tool deps lean; see
/// main.rs's help text for the full surface).
#[derive(Debug, PartialEq)]
pub enum Command {
    Pull(PullArgs),
    Credits(CreditsArgs),
}

#[derive(Debug, PartialEq)]
pub struct PullArgs {
    pub relay: String,
    pub key: String,
    pub out: PathBuf,
    pub dry_run: bool,
    pub only: Vec<String>,
    pub min_staged: u64,
}

#[derive(Debug, PartialEq)]
pub struct CreditsArgs {
    pub relay: String,
    pub key: String,
    pub out: PathBuf,
}

pub fn parse_args(argv: &[String]) -> anyhow::Result<Command> {
    let env_relay = std::env::var("WOWSP_RELAY_URL").unwrap_or_else(|_| DEFAULT_RELAY.into());
    let env_key = std::env::var("WOWSP_REPLAY_ADMIN_KEY").unwrap_or_default();
    let mut it = argv.iter();
    let Some(cmd) = it.next() else {
        bail!("usage: replay-drain <pull|credits> [options] (see --help)");
    };
    let mut relay = env_relay;
    let mut key = env_key;
    let mut out: Option<PathBuf> = None;
    let mut dry_run = false;
    let mut only = Vec::new();
    let mut min_staged = 1u64;
    while let Some(a) = it.next() {
        match a.as_str() {
            "--relay" => relay = take(&mut it, "--relay")?,
            "--key" => key = take(&mut it, "--key")?,
            "--out" => out = Some(PathBuf::from(take(&mut it, "--out")?)),
            "--dry-run" => dry_run = true,
            "--only" => only.push(take(&mut it, "--only")?),
            "--min-staged" => {
                min_staged = take(&mut it, "--min-staged")?
                    .parse()
                    .context("--min-staged needs a number")?;
            },
            other => bail!("unknown option {other}"),
        }
    }
    if key.trim().is_empty() {
        bail!(
            "no admin key: pass --key or set WOWSP_REPLAY_ADMIN_KEY (the worker's REPLAY_ADMIN_KEY secret)"
        );
    }
    relay = relay.trim_end_matches('/').to_string();
    match cmd.as_str() {
        "pull" => Ok(Command::Pull(PullArgs {
            relay,
            key,
            out: out.unwrap_or_else(|| PathBuf::from("replay-archive")),
            dry_run,
            only,
            min_staged,
        })),
        "credits" => Ok(Command::Credits(CreditsArgs {
            relay,
            key,
            out: out.unwrap_or_else(|| PathBuf::from("contributors.json")),
        })),
        other => bail!("unknown command {other} (pull | credits)"),
    }
}

fn take<'a>(it: &mut impl Iterator<Item = &'a String>, flag: &str) -> anyhow::Result<String> {
    it.next()
        .map(String::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("{flag} needs a value"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha_of(data: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(data);
        hex::encode(h.finalize())
    }

    /// Build an in-memory tar.zstd shard exactly like the app packer:
    /// members named `<sha256>.<ext>`, no directories.
    fn build_shard(members: &[(&[u8], &str)]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let enc = zstd::stream::write::Encoder::new(&mut buf, 3).unwrap();
            let mut tar = tar::Builder::new(enc);
            for (data, ext) in members {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                tar.append_data(&mut header, format!("{}.{ext}", sha_of(data)), *data)
                    .unwrap();
            }
            tar.into_inner().unwrap().finish().unwrap();
        }
        buf
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir()
            .join("replay-drain-tests")
            .join(format!("{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn verify_stores_good_members_content_addressed() {
        let out = tmpdir("good");
        let shard = build_shard(&[
            (b"replay-a" as &[u8], "wowsreplay"),
            (b"replay-b", "korablireplay"),
        ]);
        let report = verify_and_store(&shard[..], &out).unwrap();
        assert_eq!(report.members, 2);
        assert_eq!(report.bytes, 16);
        assert!(report.failures.is_empty());
        assert!(
            out.join("raw")
                .join(format!("{}.{ext}", sha_of(b"replay-a"), ext = "wowsreplay"))
                .exists()
        );

        // Re-running the same shard is idempotent (members already stored).
        let again = verify_and_store(&shard[..], &out).unwrap();
        assert_eq!(again.members, 2);
        assert!(again.failures.is_empty());
    }

    #[test]
    fn verify_refuses_a_member_whose_name_lies() {
        let out = tmpdir("bad");
        // Same content twice under one honest and one lying name: the
        // honest one stores, the liar is refused and named in failures.
        let data: &[u8] = b"replay-x";
        let mut buf = Vec::new();
        {
            let enc = zstd::stream::write::Encoder::new(&mut buf, 3).unwrap();
            let mut tar = tar::Builder::new(enc);
            for name in [
                format!("{}.wowsreplay", sha_of(data)),
                format!("{}.wowsreplay", "0".repeat(64)),
            ] {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                tar.append_data(&mut header, name, data).unwrap();
            }
            tar.into_inner().unwrap().finish().unwrap();
        }
        let report = verify_and_store(&buf[..], &out).unwrap();
        assert_eq!(report.members, 1);
        assert_eq!(report.failures.len(), 1);
        assert!(report.failures[0].contains("refusing"));
        // The liar's target name never materialized.
        assert!(
            !out.join("raw")
                .join(format!("{}.wowsreplay", "0".repeat(64)))
                .exists()
        );
    }

    #[test]
    fn envelope_bumps_version_and_roundtrips() {
        let dir = tmpdir("credits");
        let path = dir.join("contributors.json");
        let rows = vec![CreditRow {
            name: "Player".into(),
            realm: "asia".into(),
            count: 3,
        }];
        let now = chrono::Utc::now();
        assert_eq!(write_contributors_envelope(&path, &rows, now).unwrap(), 1);
        assert_eq!(write_contributors_envelope(&path, &rows, now).unwrap(), 2);
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(doc["version"], serde_json::json!(2));
        assert_eq!(
            doc["contributors"],
            serde_json::json!([{ "name": "Player", "realm": "asia", "count": 3 }])
        );
    }

    #[test]
    fn args_parse_flags_and_env_defaults() {
        // Env vars are read inside parse_args; the explicit flags below
        // override whatever the environment carries.
        let argv: Vec<String> = [
            "pull",
            "--relay",
            "https://example.com/",
            "--key",
            "k1",
            "--out",
            "d",
            "--only",
            "a1",
            "--only",
            "a2",
            "--min-staged",
            "3",
            "--dry-run",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        match parse_args(&argv).unwrap() {
            Command::Pull(p) => {
                assert_eq!(p.relay, "https://example.com");
                assert_eq!(p.key, "k1");
                assert_eq!(p.out, PathBuf::from("d"));
                assert_eq!(p.only, vec!["a1".to_string(), "a2".to_string()]);
                assert_eq!(p.min_staged, 3);
                assert!(p.dry_run);
            },
            other => panic!("wrong command {other:?}"),
        }
        let credits: Vec<String> = ["credits", "--key", "k2"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        match parse_args(&credits).unwrap() {
            Command::Credits(c) => {
                assert_eq!(c.key, "k2");
                assert_eq!(c.out, PathBuf::from("contributors.json"));
            },
            other => panic!("wrong command {other:?}"),
        }
    }
}
