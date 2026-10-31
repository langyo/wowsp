//! Loader/runtime mod health from the client's own `profile/python.log`.
//!
//! The app used to be blind to the failures users actually hit: the game's
//! python loader logs exactly why a mod did not load — a refused signature
//! (ModsAPI 2.0's time-based check), the shared TTaro framework's missing
//! `constants.json` (which silently disables every TTaro dependent), a mod
//! disabled because its dependency published none of the required settings —
//! but none of that reached the UI. This module parses the log's bounded
//! tail into verdicts the Resources view surfaces above the installed list
//! (informational only this round; no auto-repair).
//!
//! Line grammar (attested from this machine's real log, 2026-10-28..31):
//! `YYYY-MM-DD HH:MM:SS.mmm: LEVEL: [Script] [ModsAPI …] <message>; (, …)`
//! — the trailing `; (, …)` is telemetry noise every loader line carries
//! and the bracket tags `[Script]` / `[ModsAPI]` / `[ModsAPI 2.0]` are
//! channel prefixes, not mod names. Parsing is tolerant throughout: unknown
//! shapes are skipped silently and a malformed line can never panic.

use anyhow::Result;

use serde::Serialize;

use wowsp_tauri_shared::CommandResult;

/// How much of `python.log` is read — the seek-based tail window from the
/// END of the file (the same discipline as the crash analysis's excerpts):
/// a multi-hundred-MB log must never be slurped whole to answer "what did
/// the last session load?".
const LOG_TAIL_CAP: u64 = 512 * 1024;

/// Line ceiling inside the tail window (the newest lines win — the log
/// accumulates sessions, and only the recent ones describe the install's
/// current state).
const MAX_LINES: usize = 4096;

/// Verdict ceiling after dedupe + sort: the strip renders rows, and a log
/// with hundreds of verdicts is a support-bundle case, not a list.
const MAX_VERDICTS: usize = 64;

/// The mod's loader signature was refused (ModsAPI 2.0's time-based check)
/// and the load failed — the classic stale/copy-forwarded install.
pub(crate) const KIND_SIGNATURE_REFUSED: &str = "signatureRefused";
/// The shared TTaro framework's `constants.json` is missing or invalid —
/// every TTaro-dependent mod is affected at once.
pub(crate) const KIND_FRAMEWORK_DATA_MISSING: &str = "frameworkDataMissing";
/// The mod disabled itself because a required dependency published none of
/// the settings it needs (in practice the TTaro framework above).
pub(crate) const KIND_DISABLED_BY_DEPENDENCY: &str = "disabledByDependency";
/// The mod loaded fine — the quiet bottom line of the strip.
pub(crate) const KIND_LOADED_OK: &str = "loadedOk";

/// One loader verdict for one mod (or the shared framework), camelCase on
/// the wire.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderHealthVerdict {
    /// The mod name the log line carried; `None` for the shared-framework
    /// verdict (it affects every TTaro dependent, not one mod).
    pub mod_name: Option<String>,
    /// One of the `signatureRefused` / `frameworkDataMissing` /
    /// `disabledByDependency` / `loadedOk` codes.
    pub kind: &'static str,
    /// Short cause line. These log shapes carry no secrets, so the detail
    /// travels unredacted.
    pub detail: String,
    /// The line's raw `YYYY-MM-DD HH:MM:SS.mmm` stamp, kept verbatim (the
    /// client's local clock is the only clock the log speaks).
    pub at: String,
}

/// The parsed health of an install's recent loader sessions.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderHealthReport {
    /// The `<game_root>/profile/python.log` this was parsed from.
    pub log_path: String,
    /// Lines actually scanned (the capped tail window).
    pub lines_scanned: usize,
    /// The newest stamp seen on any scanned line — the last session's
    /// moment, `None` when nothing carried a stamp.
    pub last_session_at: Option<String>,
    /// Verdicts: errors first (`signatureRefused`, then
    /// `frameworkDataMissing`, then `disabledByDependency`), then
    /// `loadedOk`, each group newest first, capped.
    pub verdicts: Vec<LoaderHealthVerdict>,
}

/// Order the verdict groups render in: the three error kinds first (in the
/// spec's fixed order), the quiet `loadedOk` rows last.
fn kind_rank(kind: &str) -> u8 {
    match kind {
        KIND_SIGNATURE_REFUSED => 0,
        KIND_FRAMEWORK_DATA_MISSING => 1,
        KIND_DISABLED_BY_DEPENDENCY => 2,
        _ => 3,
    }
}

/// Split one log line into (stamp, body) when it carries the game's
/// fixed-width leading shape. The stamp is the raw 23-char
/// `YYYY-MM-DD HH:MM:SS.mmm`; the body is what follows the
/// `<LEVEL>: ` tag (a missing/odd level tag keeps the whole remainder —
/// tolerant of loader variants).
fn split_stamp(line: &str) -> Option<(&str, &str)> {
    let bytes = line.as_bytes();
    if bytes.len() < 24 {
        return None;
    }
    let separators = [
        (4usize, b'-'),
        (7, b'-'),
        (10, b' '),
        (13, b':'),
        (16, b':'),
        (19, b'.'),
    ];
    for (at, want) in separators {
        if bytes[at] != want {
            return None;
        }
    }
    for at in [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22] {
        if !bytes[at].is_ascii_digit() {
            return None;
        }
    }
    if bytes[23] != b':' {
        return None;
    }
    let stamp = &line[..23];
    let rest = line[24..].trim_start();
    // One '<LEVEL>: ' tag (ERROR / INFO / WARNING …) — drop it when the
    // first token looks like a level, keep the line whole otherwise.
    let body = match rest.split_once(": ") {
        Some((level, tail))
            if !level.is_empty()
                && level.len() <= 10
                && level
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) =>
        {
            tail
        },
        _ => rest,
    };
    Some((stamp, body))
}

/// Strip the loader's own channel tags (`[Script]`, `[ModsAPI]`,
/// `[ModsAPI 2.0]`) from the head of a body. Only those exact tags go —
/// the mods' own brackets (`[RegenMonitor, ModsAPI]`,
/// `[TTaroModUtils]`) must survive for the extractors below.
fn strip_channel_tags(mut body: &str) -> &str {
    loop {
        let trimmed = body.trim_start();
        let Some(after_open) = trimmed.strip_prefix('[') else {
            break;
        };
        let Some(close) = after_open.find(']') else {
            break;
        };
        let tail = after_open[close + 1..].trim_start();
        if matches!(&after_open[..close], "Script" | "ModsAPI" | "ModsAPI 2.0") {
            body = tail;
        } else {
            break;
        }
    }
    body
}

/// The `[<Name>, ModsAPI]` bracket opener — the mod-bearing tag both the
/// `installed.` and `DISABLED --` shapes start with. Returns (name, tail
/// after the closing bracket).
fn mods_api_bracket(body: &str) -> Option<(&str, &str)> {
    let after_open = body.strip_prefix('[')?;
    let close = after_open.find(']')?;
    let name = after_open[..close].strip_suffix(", ModsAPI")?.trim();
    if name.is_empty() {
        return None;
    }
    Some((name, after_open[close + 1..].trim_start()))
}

/// The telemetry suffix every loader line carries (`; (, 49591186137623,
/// 391)`) — cut the message at its first `; (to keep extracted names and
/// details clean.
fn cut_telemetry(text: &str) -> &str {
    match text.find("; (") {
        Some(at) => text[..at].trim(),
        None => text.trim(),
    }
}

/// Read ONE stamped, channel-stripped body into a verdict; `None` for
/// every shape the rules do not name (skipped silently).
fn verdict_of(body: &str) -> Option<LoaderHealthVerdict> {
    // Shared framework: '[TTaroModUtils] ERROR constants.json missing or
    // invalid' — mod stays None; the framework name rides the detail.
    if let Some(at) = body.find("ERROR constants.json missing or invalid") {
        let head = &body[..at];
        let framework = match head.rfind('[') {
            Some(open) => head
                .get(open + 1..)
                .and_then(|rest| rest.split(']').next())
                .map(str::trim)
                .filter(|name| !name.is_empty()),
            None => None,
        };
        return Some(LoaderHealthVerdict {
            mod_name: None,
            kind: KIND_FRAMEWORK_DATA_MISSING,
            detail: match framework {
                Some(name) => format!("{name}: constants.json missing or invalid"),
                None => "constants.json missing or invalid".to_string(),
            },
            at: String::new(),
        });
    }
    // 'Mod <Name>: signature time is invalid' — the refusal itself.
    if let Some(at) = body.find(": signature time is invalid") {
        let name = body[..at]
            .rsplit_once("Mod ")
            .map(|(_, name)| name.trim())?;
        if name.is_empty() {
            return None;
        }
        return Some(signature_verdict(name));
    }
    // 'Load mod <Name> failed.' — the refusal's consequence; the pair is
    // ONE signatureRefused verdict (the dedupe key folds them), so the
    // detail names the shared cause instead of restating the symptom.
    if let Some(at) = body.find(" failed.") {
        let name = body[..at]
            .rsplit_once("Load mod ")
            .map(|(_, name)| name.trim())?;
        if !name.is_empty() {
            return Some(signature_verdict(name));
        }
    }
    // '[<Mod>, ModsAPI] DISABLED -- <Dep> is a required dependency and did
    // not publish N of N setting(s): …' — the dependent names itself.
    if let Some((name, tail)) = mods_api_bracket(body) {
        if let Some(rest) = tail.strip_prefix("DISABLED -- ") {
            const NEED: &str = " is a required dependency and did not publish ";
            let dep_at = rest.find(NEED)?;
            let dep = rest[..dep_at].trim();
            // 'N of N setting(s)' — the published-count chunk sits before
            // the setting-name list that follows ('… setting(s): a, b, …'),
            // and may end the line outright.
            let after_dep = cut_telemetry(&rest[dep_at + NEED.len()..]);
            let end = after_dep
                .find(" setting(s)")
                .or_else(|| after_dep.find(" settings"))?;
            let chunk = after_dep[..end].trim();
            if dep.is_empty() || chunk.is_empty() {
                return None;
            }
            return Some(LoaderHealthVerdict {
                mod_name: Some(name.to_string()),
                kind: KIND_DISABLED_BY_DEPENDENCY,
                detail: format!("{dep} did not publish {chunk} settings"),
                at: String::new(),
            });
        }
        // '[<Name>, ModsAPI] installed.' — the old-API load receipt.
        if cut_telemetry(tail) == "installed." {
            return Some(LoaderHealthVerdict {
                mod_name: Some(name.to_string()),
                kind: KIND_LOADED_OK,
                detail: "loaded".to_string(),
                at: String::new(),
            });
        }
        return None;
    }
    // 'Loaded user mod: <Name>' — the ModsAPI 2.0 load receipt.
    if let Some(rest) = body.strip_prefix("Loaded user mod: ") {
        let name = cut_telemetry(rest);
        if name.is_empty() {
            return None;
        }
        return Some(LoaderHealthVerdict {
            mod_name: Some(name.to_string()),
            kind: KIND_LOADED_OK,
            detail: "loaded".to_string(),
            at: String::new(),
        });
    }
    None
}

/// The shared signature-refusal verdict for one mod (both the 'signature
/// time is invalid' line and its 'Load mod … failed.' echo fold onto it).
fn signature_verdict(name: &str) -> LoaderHealthVerdict {
    LoaderHealthVerdict {
        mod_name: Some(name.to_string()),
        kind: KIND_SIGNATURE_REFUSED,
        detail: "signature time is invalid".to_string(),
        at: String::new(),
    }
}

/// Parse the bounded tail of a `python.log` into a health report. Pure:
/// no filesystem, no panics — empty or garbage input yields an empty
/// report (`log_path` is the caller's to fill).
pub(crate) fn parse_loader_health(text: &str) -> LoaderHealthReport {
    // The newest lines are the interesting ones — cap the window from the
    // end so a huge log's oldest sessions cannot flood the verdicts.
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(MAX_LINES);
    let mut newest_stamp: Option<String> = None;
    // (mod, kind) → verdict, newest line winning the 'at' stamp (and its
    // detail — the same key's details only ever restate the same cause).
    let mut by_key: std::collections::HashMap<(Option<String>, &'static str), LoaderHealthVerdict> =
        std::collections::HashMap::new();
    let mut order: Vec<(Option<String>, &'static str)> = Vec::new();
    for line in &lines[start..] {
        let Some((stamp, body)) = split_stamp(line) else {
            continue;
        };
        if newest_stamp.as_deref().is_none_or(|seen| stamp > seen) {
            newest_stamp = Some(stamp.to_string());
        }
        let Some(mut verdict) = verdict_of(strip_channel_tags(body)) else {
            continue;
        };
        verdict.at = stamp.to_string();
        let key = (verdict.mod_name.clone(), verdict.kind);
        match by_key.get_mut(&key) {
            Some(existing) => {
                if verdict.at >= existing.at {
                    *existing = verdict;
                }
            },
            None => {
                by_key.insert(key.clone(), verdict);
                order.push(key);
            },
        }
    }
    let mut verdicts: Vec<LoaderHealthVerdict> = order
        .into_iter()
        .filter_map(|k| by_key.remove(&k))
        .collect();
    // Cross-kind supersession: a mod that FAILED earlier in the window and
    // loaded fine later is healthy — its stale error row would pin a red
    // verdict under a "last session" title forever (the window spans many
    // sessions). The shared-framework verdict (mod None) never supersedes:
    // no loadedOk line proves constants.json healed.
    let ok_newest: std::collections::HashMap<Option<String>, String> = verdicts
        .iter()
        .filter(|v| v.kind == "loadedOk")
        .map(|v| (v.mod_name.clone(), v.at.clone()))
        .collect();
    verdicts.retain(|v| {
        v.kind == "loadedOk"
            || match &v.mod_name {
                None => true,
                Some(name) => match ok_newest.get(&Some(name.clone())) {
                    Some(ok_at) => v.at > *ok_at,
                    None => true,
                },
            }
    });
    verdicts.sort_by(|a, b| {
        let key = |v: &LoaderHealthVerdict| (kind_rank(v.kind), std::cmp::Reverse(v.at.clone()));
        key(a).cmp(&key(b))
    });
    verdicts.truncate(MAX_VERDICTS);
    LoaderHealthReport {
        log_path: String::new(),
        lines_scanned: lines.len() - start,
        last_session_at: newest_stamp,
        verdicts,
    }
}

/// The read core behind the command: bound the read, parse the tail.
/// A missing or unreadable log is an empty report, not an error — the
/// strip only exists when an error verdict exists, so a never-launched
/// install stays quiet.
pub(crate) fn loader_health_report(game_root: &str) -> Result<LoaderHealthReport> {
    super::ensure_known_game_root(game_root)?;
    let log = std::path::Path::new(game_root)
        .join("profile")
        .join("python.log");
    let mut report = match super::super::game_crash::read_tail(&log, LOG_TAIL_CAP) {
        Ok((bytes, _, _)) => parse_loader_health(&String::from_utf8_lossy(&bytes)),
        Err(_) => parse_loader_health(""),
    };
    report.log_path = log.to_string_lossy().into_owned();
    Ok(report)
}

/// Loader/runtime mod health of an install's last sessions — read-only
/// (the log is only ever read), so no mod-hub gate and no window param.
#[tauri::command]
pub fn mod_hub_loader_health(game_root: String) -> CommandResult<LoaderHealthReport> {
    Ok(loader_health_report(&game_root)?)
}
