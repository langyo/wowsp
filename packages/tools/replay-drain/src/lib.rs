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
    Rename(RenameArgs),
    Backfill(BackfillArgs),
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

#[derive(Debug, PartialEq)]
pub struct RenameArgs {
    pub relay: String,
    pub key: String,
    pub anon: String,
    pub name: String,
}

#[derive(Debug, PartialEq)]
pub struct BackfillArgs {
    pub relay: String,
    pub key: String,
    pub realm: String,
    pub paths: Vec<PathBuf>,
    pub force: bool,
    pub dry_run: bool,
}

pub fn parse_args(argv: &[String]) -> anyhow::Result<Command> {
    let env_relay = std::env::var("WOWSP_RELAY_URL").unwrap_or_else(|_| DEFAULT_RELAY.into());
    let env_key = std::env::var("WOWSP_REPLAY_ADMIN_KEY").unwrap_or_default();
    let mut it = argv.iter();
    let Some(cmd) = it.next() else {
        bail!("usage: replay-drain <pull|credits|rename|backfill> [options] (see --help)");
    };
    let mut relay = env_relay;
    let mut key = env_key;
    let mut out: Option<PathBuf> = None;
    let mut dry_run = false;
    let mut only = Vec::new();
    let mut min_staged = 1u64;
    let mut anon: Option<String> = None;
    let mut name: Option<String> = None;
    let mut realm: Option<String> = None;
    let mut force = false;
    let mut paths: Vec<PathBuf> = Vec::new();
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
            "--anon" => anon = Some(take(&mut it, "--anon")?),
            "--name" => name = Some(take(&mut it, "--name")?),
            "--realm" => realm = Some(take(&mut it, "--realm")?),
            "--force" => force = true,
            // Positionals belong to backfill alone — the other commands
            // keep their old strictness (a stray word is a typo, not a
            // silently-ignored argument).
            other if !other.starts_with('-') && cmd == "backfill" => {
                paths.push(PathBuf::from(other));
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
        "rename" => Ok(Command::Rename(RenameArgs {
            relay,
            key,
            anon: anon
                .filter(|a| !a.trim().is_empty())
                .ok_or_else(|| anyhow::anyhow!("rename needs --anon <contributor anon id>"))?,
            name: name
                .filter(|n| !n.trim().is_empty())
                .ok_or_else(|| anyhow::anyhow!("rename needs --name <corrected credited name>"))?,
        })),
        "backfill" => {
            const REALMS: [&str; 5] = ["ru", "eu", "na", "asia", "cn"];
            let realm = realm
                .filter(|r| REALMS.contains(&r.as_str()))
                .ok_or_else(|| anyhow::anyhow!("backfill needs --realm <ru|eu|na|asia|cn>"))?;
            if paths.is_empty() {
                bail!("backfill needs at least one replay file or folder");
            }
            Ok(Command::Backfill(BackfillArgs {
                relay,
                key,
                realm,
                paths,
                force,
                dry_run,
            }))
        },
        other => bail!("unknown command {other} (pull | credits | rename | backfill)"),
    }
}

fn take<'a>(it: &mut impl Iterator<Item = &'a String>, flag: &str) -> anyhow::Result<String> {
    it.next()
        .map(String::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("{flag} needs a value"))
}

// ── backfill planning (pure — unit-tested below) ────────────────────────

/// One scanned replay: the wire facts JSON the /check call consumes plus
/// the recorder identity the grouping needs. Built by main's scan pass.
#[derive(Debug, PartialEq)]
pub struct ScannedReplay {
    pub sha256: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub player_name: Option<String>,
    pub facts: serde_json::Value,
}

/// One /check result row — `verdict` is the server's spelling
/// (`accept` | `own_staged` | `duplicate` | `unwanted`).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRow {
    pub sha256: String,
    pub verdict: String,
    pub rule_id: Option<String>,
}

/// One contributor's credit plan: the members to submit under one
/// (realm, name) identity in a single admin/backfill call. The member
/// shape mirrors the relay's `BackfillMember` wire (camelCase JSON) —
/// deliberately local: the drain CLI stays out of the relay workspace.
pub struct BackfillGroupPlan {
    pub name: String,
    pub realm: String,
    pub members: Vec<BackfillMemberPlan>,
}

pub struct BackfillMemberPlan {
    pub sha256: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub rule_id: Option<String>,
}

/// A replay that will NOT be backfilled, and why.
pub struct BackfillSkip {
    pub sha256: String,
    pub file_name: String,
    pub reason: String,
}

/// Fold /check verdicts into per-identity backfill plans. `accept`
/// groups under the file's recorder; `duplicate` / `own_staged` /
/// `unwanted` skip with the reason — unless `force` credits unwanted
/// members anyway (rule-less), for collections made under an earlier
/// ruleset. Members carry the matched rule id when there is one.
pub fn plan_backfill(
    scanned: &[ScannedReplay],
    results: &[CheckRow],
    realm: &str,
    force: bool,
) -> (Vec<BackfillGroupPlan>, Vec<BackfillSkip>) {
    let mut groups: Vec<BackfillGroupPlan> = Vec::new();
    let mut skips: Vec<BackfillSkip> = Vec::new();
    let group_member = |groups: &mut Vec<BackfillGroupPlan>, name: &str, m: BackfillMemberPlan| {
        if let Some(g) = groups.iter_mut().find(|g| g.name == name) {
            g.members.push(m);
        } else {
            groups.push(BackfillGroupPlan {
                name: name.to_string(),
                realm: realm.to_string(),
                members: vec![m],
            });
        }
    };
    for s in scanned {
        let skip = |reason: &str| BackfillSkip {
            sha256: s.sha256.clone(),
            file_name: s.file_name.clone(),
            reason: reason.to_string(),
        };
        let Some(row) = results.iter().find(|r| r.sha256 == s.sha256) else {
            skips.push(skip("no verdict returned"));
            continue;
        };
        let record = |rule_id: Option<String>| BackfillMemberPlan {
            sha256: s.sha256.clone(),
            file_name: s.file_name.clone(),
            size_bytes: s.size_bytes,
            rule_id,
        };
        match row.verdict.as_str() {
            "accept" => {
                let Some(name) = s
                    .player_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|n| !n.is_empty())
                else {
                    skips.push(skip("no recorder name in the header"));
                    continue;
                };
                group_member(&mut groups, name, record(row.rule_id.clone()));
            },
            "duplicate" => skips.push(skip("already in the ledger")),
            "own_staged" => skips.push(skip("staged by its contributor")),
            "unwanted" if force => {
                let Some(name) = s
                    .player_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|n| !n.is_empty())
                else {
                    skips.push(skip("no recorder name in the header"));
                    continue;
                };
                group_member(&mut groups, name, record(None));
            },
            "unwanted" => skips.push(skip("no wanted rule matches (use --force)")),
            other => skips.push(skip(&format!("unknown verdict {other}"))),
        }
    }
    (groups, skips)
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

    #[test]
    fn rename_parses_the_anon_and_name() {
        let argv: Vec<String> = [
            "rename",
            "--key",
            "k3",
            "--anon",
            "01234567-89ab-4cde-8f01-23456789abcd",
            "--name",
            "万州烤鱼灬椒盐味丨蓝博",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        match parse_args(&argv).unwrap() {
            Command::Rename(r) => {
                assert_eq!(r.key, "k3");
                assert_eq!(r.anon, "01234567-89ab-4cde-8f01-23456789abcd");
                assert_eq!(r.name, "万州烤鱼灬椒盐味丨蓝博");
            },
            other => panic!("wrong command {other:?}"),
        }
        // Either required flag missing is a usage error.
        for argv in [
            vec!["rename", "--key", "k", "--name", "Real"],
            vec!["rename", "--key", "k", "--anon", "anon-id"],
        ] {
            let argv: Vec<String> = argv.into_iter().map(String::from).collect();
            assert!(parse_args(&argv).is_err());
        }
    }

    fn scanned(sha: &str, name: Option<&str>) -> ScannedReplay {
        ScannedReplay {
            sha256: sha.to_string(),
            file_name: format!("replay-{sha}.wowsreplay"),
            size_bytes: 5_000_000,
            player_name: name.map(str::to_string),
            facts: serde_json::json!({ "sha256": sha }),
        }
    }

    fn check_row(sha: &str, verdict: &str, rule: Option<&str>) -> CheckRow {
        CheckRow {
            sha256: sha.to_string(),
            verdict: verdict.to_string(),
            rule_id: rule.map(str::to_string),
        }
    }

    #[test]
    fn plan_groups_accepts_under_their_recorders() {
        let scanned = [
            scanned("a", Some("玩家一号")),
            scanned("b", Some("玩家一号")),
            scanned("c", Some("玩家二号")),
        ];
        let results = [
            check_row("a", "accept", Some("r-all")),
            check_row("b", "accept", Some("r-all")),
            check_row("c", "accept", None),
        ];
        let (groups, skips) = plan_backfill(&scanned, &results, "cn", false);
        assert!(skips.is_empty());
        assert_eq!(groups.len(), 2);
        let g1 = groups.iter().find(|g| g.name == "玩家一号").unwrap();
        assert_eq!(g1.realm, "cn");
        assert_eq!(g1.members.len(), 2);
        assert_eq!(g1.members[0].rule_id.as_deref(), Some("r-all"));
        let g2 = groups.iter().find(|g| g.name == "玩家二号").unwrap();
        assert_eq!(g2.members[0].rule_id, None);
    }

    #[test]
    fn plan_skips_duplicates_and_unwanted_unless_forced() {
        let scanned = [
            scanned("a", Some("玩家一号")),
            scanned("b", Some("玩家一号")),
            scanned("c", Some("玩家一号")),
            scanned("d", None),
        ];
        let results = [
            check_row("a", "duplicate", None),
            check_row("b", "unwanted", None),
            check_row("c", "accept", Some("r-all")),
            check_row("d", "accept", Some("r-all")),
        ];
        let (groups, skips) = plan_backfill(&scanned, &results, "cn", false);
        assert!(groups.len() == 1 && groups[0].members.len() == 1);
        assert_eq!(skips.len(), 3);
        assert!(
            skips
                .iter()
                .any(|s| s.reason.contains("already in the ledger"))
        );
        assert!(skips.iter().any(|s| s.reason.contains("no wanted rule")));
        assert!(skips.iter().any(|s| s.reason.contains("no recorder name")));

        // --force credits the unwanted member too (rule-less), still
        // skipping true duplicates and the nameless header.
        let (groups, skips) = plan_backfill(&scanned, &results, "cn", true);
        assert_eq!(groups[0].members.len(), 2);
        assert_eq!(skips.len(), 2);
        let unwanted = groups[0].members.iter().find(|m| m.sha256 == "b").unwrap();
        assert_eq!(unwanted.rule_id, None);
    }

    #[test]
    fn backfill_parses_realm_paths_and_flags() {
        let argv: Vec<String> = [
            "backfill",
            "--key",
            "k",
            "--realm",
            "cn",
            "--force",
            "D:\\collected",
            "D:\\more\\one.wowsreplay",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        match parse_args(&argv).unwrap() {
            Command::Backfill(b) => {
                assert_eq!(b.realm, "cn");
                assert!(b.force);
                assert_eq!(b.paths.len(), 2);
            },
            other => panic!("wrong command {other:?}"),
        }
        // The realm flag is mandatory and whitelist-checked.
        assert!(
            parse_args(&[
                "backfill".to_string(),
                "--key".into(),
                "k".into(),
                "x".into()
            ])
            .is_err()
        );
        assert!(
            parse_args(&[
                "backfill".to_string(),
                "--key".into(),
                "k".into(),
                "--realm".into(),
                "mars".into(),
                "x".into()
            ])
            .is_err()
        );
    }
}
