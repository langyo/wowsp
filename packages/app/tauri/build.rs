//! Build-time inputs for the app shell:
//!
//! - the shun update-watch table (`[package.metadata.shun.update]`) is
//!   parsed out of this crate's manifest and written to
//!   `OUT_DIR/shun-update.json`, embedded at runtime by
//!   `src/commands/update.rs` via `include_str!`; and
//! - the crate version lands in `OUT_DIR/app-version.txt` so the update
//!   check can compare the `latest` marker against the running build; and
//! - the debug-build identity stamp (`branch:hash7`) is resolved from the
//!   git checkout and exported as the `WOWSP_BUILD_IDENTITY` env var for
//!   `commands::get_build_identity` (the title bar's debug suffix).

use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir =
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo");
    let manifest_dir = Path::new(&manifest_dir);
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set by cargo"));
    let manifest_path = manifest_dir.join("Cargo.toml");

    // 1. Resolve the update-watch config from the manifest metadata.
    //    `ShunConfig::from_cargo_manifest` tolerates a manifest without
    //    `[package.metadata.shun]` (everything defaults) and inherits
    //    `version.workspace = true` from the workspace root — only the
    //    `update` table matters here.
    let config = shun::config::ShunConfig::from_cargo_manifest(&manifest_path)
        .expect("shun update metadata in Cargo.toml parses");
    let update = config
        .update
        .expect("[package.metadata.shun.update] declares the update-watch sources");
    let update_json = serde_json::to_vec_pretty(&update).expect("update-watch config serializes");
    std::fs::write(out_dir.join("shun-update.json"), update_json)
        .expect("write embedded update-watch config");
    println!("cargo:rerun-if-changed={}", manifest_path.display());

    // 2. App version for the update check (workspace version 0.1.0).
    let version = std::env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION is set by cargo");
    std::fs::write(out_dir.join("app-version.txt"), version).expect("write embedded app version");

    // 3. Debug-build identity stamp for the title bar's version subtitle.
    //    Debug profile only: release binaries never render the stamp (the
    //    command gates on `debug_assertions`), and emitting it there would
    //    needlessly rebuild the release cache on every branch switch.
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        watch_git_metadata(manifest_dir);
        let stamp = resolve_build_identity(manifest_dir);
        if !stamp.is_empty() {
            println!("cargo:rustc-env=WOWSP_BUILD_IDENTITY={stamp}");
        }
    }

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // Tauri embeds Common Controls v6 in the app binary's resources,
        // but its resource link argument does not reach library unit tests.
        // Tests that retain dialog code otherwise fail before main with
        // STATUS_ENTRYPOINT_NOT_FOUND (TaskDialogIndirect). This produces
        // an adjacent manifest for test executables that cargo runs in place.
        // Do not add /MANIFEST:EMBED: the app already has manifest resource #1.
        // rustc-link-arg-tests cannot be used here: it excludes lib unit tests.
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }

    // Inlined-plugin ACL for hikari-host: the webview acknowledges the close
    // request through `plugin:hikari-host|ack_close`, so tauri-build must
    // generate that plugin's permission manifest (and only that command).
    tauri_build::try_build(tauri_build::Attributes::new().plugin(
        "hikari-host",
        tauri_build::InlinedPlugin::new().commands(&["ack_close"]),
    ))
    .expect("failed to run tauri-build");
}

/// `branch:hash7` for the git checkout `start` sits in, or "" when git or
/// the checkout is unavailable (tarball builds land there). Resolution
/// mirrors the celestia family's build-info convention: an explicit
/// `CELESTIA_BUILD_BRANCH`/`CELESTIA_BUILD_HASH` pair passes through, the
/// `celestia-devtools version-string` CLI answers when on PATH (it carries
/// the canonical detached-HEAD naming ladder), and plain `git rev-parse`
/// is the always-available fallback.
fn resolve_build_identity(start: &Path) -> String {
    if let (Ok(branch), Ok(hash)) = (
        std::env::var("CELESTIA_BUILD_BRANCH"),
        std::env::var("CELESTIA_BUILD_HASH"),
    ) {
        // Shape-check the override too — a typo'd passthrough falls through
        // to the checkout instead of stamping garbage.
        let stamp = format!("{branch}:{}", hash.to_lowercase());
        if stamp_is_well_formed(&stamp) {
            return stamp;
        }
    }
    let Some(root) = repo_root(start) else {
        return String::new();
    };
    if let Some(line) = command_output(
        "celestia-devtools",
        &["version-string", "--dir", &root.display().to_string()],
    ) {
        // The CLI prints `<version> <branch>:<hash>`; take the trailing
        // identity token, validated so a surprising output falls through
        // to git instead of stamping garbage. Only the hash is normalized
        // — branch names may carry uppercase.
        if let Some(token) = line.split_whitespace().next_back() {
            if let Some((branch, hash)) = token.split_once(':') {
                if stamp_is_well_formed(token) {
                    return format!("{branch}:{}", hash.to_lowercase());
                }
            }
        }
    }
    let branch = match git_output(&root, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        // A detached checkout answers the literal "HEAD".
        Some(branch) if branch != "HEAD" => branch,
        _ => "detached".to_string(),
    };
    match git_output(&root, &["rev-parse", "--short=7", "HEAD"]) {
        // --short=7 is a minimum: git lengthens the abbreviation when the
        // 7-char prefix collides, so accept what it answers.
        Some(hash) => format!("{branch}:{}", hash.to_lowercase()),
        None => String::new(),
    }
}

/// `<branch>:<hash>` shape shared by every resolver: non-empty branch plus
/// a 7..=40 char hex hash (git's `--short=7` may lengthen on collision).
fn stamp_is_well_formed(stamp: &str) -> bool {
    match stamp.split_once(':') {
        Some((branch, hash)) => {
            !branch.is_empty()
                && (7..=40).contains(&hash.len())
                && hash.chars().all(|c| c.is_ascii_hexdigit())
        },
        None => false,
    }
}

/// Nearest ancestor of `start` holding a `.git` entry — a directory in a
/// plain checkout, a file in a linked worktree (the agent PR workflow).
fn repo_root(start: &Path) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    loop {
        if dir.join(".git").exists() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// Rerun the build script when the checkout moves (branch switch, commit,
/// fetch) so a dev rebuild re-stamps the title bar. Both git dirs matter:
/// in a linked worktree `--git-dir` is the per-worktree dir (holds HEAD)
/// while branch refs live in the shared `--git-common-dir` — watching only
/// the former misses plain commits made inside the worktree.
fn watch_git_metadata(start: &Path) {
    let Some(root) = repo_root(start) else {
        return;
    };
    let mut git_dirs: Vec<PathBuf> = Vec::new();
    for flag in ["--git-dir", "--git-common-dir"] {
        match git_output(&root, &["rev-parse", flag]) {
            Some(dir) => {
                let path = root.join(dir);
                if !git_dirs.contains(&path) {
                    git_dirs.push(path);
                }
            },
            // No git at all: fall back to the plain layout so a `<repo>/.git`
            // checkout still gets watched when rev-parse is unavailable.
            None => {
                let path = root.join(".git");
                if !git_dirs.contains(&path) {
                    git_dirs.push(path);
                }
            },
        }
    }
    for git_dir in &git_dirs {
        for rel in ["HEAD", "refs/heads", "packed-refs"] {
            let path = git_dir.join(rel);
            if path.exists() {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
    // Restamping when an operator overrides the identity by environment.
    for var in ["CELESTIA_BUILD_BRANCH", "CELESTIA_BUILD_HASH"] {
        println!("cargo:rerun-if-env-changed={var}");
    }
}

fn git_output(repo: &Path, args: &[&str]) -> Option<String> {
    std::process::Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .ok()
        .and_then(text_stdout)
}

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    std::process::Command::new(program)
        .args(args)
        .output()
        .ok()
        .and_then(text_stdout)
}

fn text_stdout(out: std::process::Output) -> Option<String> {
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!text.is_empty()).then_some(text)
}
