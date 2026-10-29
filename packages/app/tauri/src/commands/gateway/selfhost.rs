use anyhow::{Result, anyhow, bail};

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::Emitter as _;
use wowsp_tauri_shared::{
    CommandResult, GatewayHealthDoc, GatewaySelfhostEvent, SelfhostEnv, SelfhostStepResult,
};

use super::*;
// ── self-host wizard (desktop, gateway-push §7) ───────────────────────────────
//
// Deploys the repo's own `packages/pairing-relay` wasm as a private
// gateway: probe the toolchain, wrangler login, KV namespace, generate
// `wrangler.selfhost.local.toml` from the tracked example, `npx wrangler
// deploy`, verify the health endpoint. Every spawned tool's output
// streams line-by-line as `wowsp://gateway-selfhost` events
// (`{step, stream: "stdout"|"stderr"|"done", line?, result?}`).
//
// AGENTS.md §7: the CF OAuth token never appears here — wrangler keeps it
// in its own profile, and we only pass wrangler's own output through
// verbatim (it does not print the token). No secrets are written into the
// repo tree; the generated local toml is gitignored and carries only the
// user's domain + KV namespace id.

/// Tracked example the wizard fills in (`relay-gateway`'s template; the
/// placeholders are deliberately-loud invalid values so an unsubstituted
/// deploy cannot silently ship).
const TEMPLATE_FILE: &str = "wrangler.selfhost.toml.example";
/// Generated, gitignored config the deploy runs with.
const LOCAL_CONFIG_FILE: &str = "wrangler.selfhost.local.toml";
const TEMPLATE_DOMAIN_TOKEN: &str = "\"GATEWAY_EXAMPLE_INVALID\"";
const TEMPLATE_KV_TOKEN: &str = "\"GATEWAY_KV_ID_EXAMPLE_INVALID\"";

const STEP_LOGIN: &str = "wrangler-login";
const STEP_LIST_ZONES: &str = "list-zones";
const STEP_KV_ENSURE: &str = "kv-ensure";
const STEP_DEPLOY: &str = "deploy";
const STEP_VERIFY: &str = "verify";

/// Probe budget for quick `--version` tools.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// `npx wrangler` may cold-install on first use.
const WRANGLER_WHOAMI_TIMEOUT: Duration = Duration::from_secs(180);
const WRANGLER_KV_TIMEOUT: Duration = Duration::from_secs(300);
const WRANGLER_DEPLOY_TIMEOUT: Duration = Duration::from_secs(600);
/// `wrangler login` waits for a browser round trip.
const WRANGLER_LOGIN_TIMEOUT: Duration = Duration::from_secs(900);
/// The verify fetch budget (gateway-push §7 step 6).
const VERIFY_TIMEOUT: Duration = Duration::from_secs(15);

/// CREATE_NO_WINDOW: spawned CLI tools must never flash a console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── process plumbing ─────────────────────────────────────────────────────────

fn tool_command(program: &str, args: &[&str], cwd: Option<&Path>) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Wait for a child with a deadline, killing it on expiry.
fn wait_deadline(child: &mut Child, what: &str, deadline: Instant) -> Result<ExitStatus> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                bail!("{what} timed out");
            },
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => bail!("{what} wait failed: {e}"),
        }
    }
}

/// Run one tool, return its trimmed stdout on success (`None` on any
/// failure — probes never error the wizard, they report a missing piece).
fn probe_output(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut cmd = tool_command(program, args, None);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let status = wait_deadline(&mut child, program, Instant::now() + timeout).ok()?;
    if !status.success() {
        return None;
    }
    let out = child.stdout?;
    let text = BufReader::new(out)
        .lines()
        .map_while(Result::ok)
        .collect::<Vec<_>>()
        .join("\n");
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// PATH lookup (`where.exe` / `which`). On Windows npm shims need the
/// `.cmd` spelling — a bare `npx` names the POSIX-shell shim, which
/// CreateProcess cannot run.
fn which_tool(name: &str) -> Option<String> {
    #[cfg(windows)]
    {
        let lookup = |query: &str| {
            let mut cmd = tool_command("where", &[query], None);
            cmd.stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            let out = cmd.output().ok()?;
            let text = String::from_utf8_lossy(&out.stdout);
            text.lines()
                .next()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
        };
        lookup(&format!("{name}.cmd")).or_else(|| lookup(name))
    }
    #[cfg(not(windows))]
    {
        let mut cmd = tool_command("which", &[name], None);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let out = cmd.output().ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        text.lines()
            .next()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
    }
}

/// Resolve `npx` (wizard steps refuse early when it is missing).
fn npx_path() -> Result<String> {
    which_tool("npx").ok_or_else(|| anyhow!("npx was not found on PATH — install Node.js first"))
}

/// Spawn a wizard step's tool with piped stdio and per-line streaming
/// readers; every line becomes a `wowsp://gateway-selfhost` event AND
/// lands in a shared collector for result parsing (`id = "…"` from kv
/// create, the account table from whoami) and error reporting.
fn spawn_streaming(
    app: &tauri::AppHandle,
    step: &str,
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
) -> Result<(Child, Arc<Mutex<Vec<String>>>)> {
    let mut cmd = tool_command(program, args, cwd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| anyhow!("spawn {program}: {e}"))?;
    let collected: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let pipes: [(&str, Option<Box<dyn BufRead + Send>>); 2] = [
        (
            "stdout",
            child
                .stdout
                .take()
                .map(|p| Box::new(BufReader::new(p)) as Box<dyn BufRead + Send>),
        ),
        (
            "stderr",
            child
                .stderr
                .take()
                .map(|p| Box::new(BufReader::new(p)) as Box<dyn BufRead + Send>),
        ),
    ];
    for (stream, pipe) in pipes {
        let Some(pipe) = pipe else {
            continue;
        };
        let app = app.clone();
        let collected = Arc::clone(&collected);
        let step_owned = step.to_string();
        let stream_owned = stream.to_string();
        std::thread::spawn(move || {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                if let Ok(mut all) = collected.lock() {
                    all.push(line.clone());
                }
                let _ = app.emit(
                    GATEWAY_SELFHOST_EVENT,
                    GatewaySelfhostEvent {
                        step: step_owned.clone(),
                        stream: stream_owned.clone(),
                        line: Some(line),
                        result: None,
                    },
                );
            }
        });
    }
    Ok((child, collected))
}

/// The step's terminal event (`stream: "done"` + the result).
fn emit_step_done(app: &tauri::AppHandle, result: &SelfhostStepResult) {
    let _ = app.emit(
        GATEWAY_SELFHOST_EVENT,
        GatewaySelfhostEvent {
            step: result.step.clone(),
            stream: "done".into(),
            line: None,
            result: Some(result.clone()),
        },
    );
}

/// A failed step: emit its terminal event, then surface the message
/// (preferring the tool's own last output line — wrangler errors are
/// self-describing).
fn step_failed(
    app: &tauri::AppHandle,
    result: &SelfhostStepResult,
    message: String,
) -> CommandResult<SelfhostStepResult> {
    emit_step_done(app, result);
    Err(anyhow!(message).into())
}

fn tail_line(lines: &[String]) -> Option<String> {
    lines
        .iter()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())
}

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

/// Hostname shape the wizard accepts for the target domain: ≥ 2 dot-separated
/// labels, each 1–63 chars of letters/digits/hyphens (no leading/trailing
/// hyphen), no scheme, no path, no port, no userinfo; total ≤ 253.
pub(super) fn valid_hostname(domain: &str) -> bool {
    let d = domain.trim();
    if d.is_empty() || d.len() > 253 || d.contains("://") || d.contains('/') {
        return false;
    }
    let labels: Vec<&str> = d.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    labels.iter().all(|label| {
        (1..=63).contains(&label.len())
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

/// KV namespace id shape wrangler mints: 32 lowercase hex chars.
pub(super) fn valid_kv_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Fill the tracked selfhost template: each placeholder token must appear
/// EXACTLY once and is replaced inside its quotes (the substituted values
/// are re-quoted, never spliced bare).
pub(super) fn fill_selfhost_template(template: &str, domain: &str, kv_id: &str) -> Result<String> {
    let count = |hay: &str, needle: &str| hay.matches(needle).count();
    if count(template, TEMPLATE_DOMAIN_TOKEN) != 1 {
        bail!("selfhost template domain placeholder mismatch — update the wowsp checkout");
    }
    if count(template, TEMPLATE_KV_TOKEN) != 1 {
        bail!("selfhost template KV placeholder mismatch — update the wowsp checkout");
    }
    Ok(template
        .replace(TEMPLATE_DOMAIN_TOKEN, &format!("\"{domain}\""))
        .replace(TEMPLATE_KV_TOKEN, &format!("\"{kv_id}\"")))
}

/// Parse the KV namespace id out of `wrangler kv namespace create` output
/// (the printed TOML/binding block carries `id = "<32 hex>"`).
pub(super) fn parse_kv_id(lines: &[String]) -> Option<String> {
    for line in lines {
        let Some((_, rest)) = line.split_once("id") else {
            continue;
        };
        // The id sits between the first pair of quotes after the `id`
        // key: `{ binding = "GATEWAY_KV", id = "<hex>" }`.
        let mut quoted = rest.split('"');
        quoted.next(); // up to the opening quote
        let Some(id) = quoted.next() else {
            continue;
        };
        if valid_kv_id(id) {
            return Some(id.to_string());
        }
    }
    None
}

/// Parse a KV namespace id out of `wrangler kv namespace list` output
/// (a JSON array; non-JSON preamble tolerated) by title match.
pub(super) fn parse_kv_list_id(lines: &[String], title_hint: &str) -> Option<String> {
    let joined = lines.join("\n");
    let start = joined.find('[')?;
    let end = joined.rfind(']')?;
    let value: serde_json::Value = serde_json::from_str(&joined[start..=end]).ok()?;
    value
        .as_array()?
        .iter()
        .filter(|entry| {
            entry
                .get("title")
                .and_then(|t| t.as_str())
                .is_some_and(|t| t.contains(title_hint))
        })
        .find_map(|entry| {
            entry
                .get("id")
                .and_then(|i| i.as_str())
                .filter(|i| valid_kv_id(i))
                .map(str::to_string)
        })
}

/// Parse the account name out of `wrangler whoami`'s account table (the
/// first table row below the `Account Name` header).
pub(super) fn parse_whoami_account(lines: &[String]) -> Option<String> {
    let header = lines.iter().position(|l| l.contains("Account Name"))?;
    for line in lines.iter().skip(header + 1) {
        if let Some(cell) = line.split('│').nth(1) {
            let cell = cell.trim();
            if !cell.is_empty() && !cell.starts_with('-') {
                return Some(cell.to_string());
            }
        }
    }
    None
}

// ── repo/cwd resolution ───────────────────────────────────────────────────────

/// The `packages/pairing-relay` directory of a wowsp checkout: an
/// explicit argument first (the wizard's repo picker — the repo ROOT or
/// the pairing-relay dir itself), else a dev-checkout probe walking up
/// from this executable (cargo test / `pnpm tauri dev` runs).
fn resolve_relay_dir(explicit: Option<&str>) -> Result<PathBuf> {
    if let Some(raw) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        let path = PathBuf::from(raw);
        let relay = if path.join("wrangler.toml").is_file() {
            path
        } else if path.join("packages/pairing-relay/wrangler.toml").is_file() {
            path.join("packages/pairing-relay")
        } else {
            bail!("no pairing-relay checkout found under {raw}");
        };
        return Ok(relay);
    }
    let mut dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    while let Some(current) = dir {
        let relay = current.join("packages").join("pairing-relay");
        if relay.join("wrangler.toml").is_file() {
            return Ok(relay);
        }
        dir = current.parent().map(Path::to_path_buf);
    }
    bail!("self-host needs the wowsp repo checkout — pick the repository path in the wizard")
}

/// Where a repo-independent wrangler call runs (login, whoami): the relay
/// dir when a checkout is around (its node_modules has wrangler pinned),
/// else the current directory (npx fetches wrangler itself).
fn soft_cwd(explicit: Option<&str>) -> Option<PathBuf> {
    resolve_relay_dir(explicit)
        .ok()
        .or_else(|| std::env::current_dir().ok())
}

// ── probe (gateway-push §7 step 1) ────────────────────────────────────────────

/// `npx wrangler whoami`: whether an authenticated session exists plus
/// the account name (best effort — a missing wrangler reads as "not
/// logged in", which is exactly what the wizard then offers to fix).
fn wrangler_whoami(npx: &str, cwd: Option<&Path>) -> (bool, Option<String>) {
    let mut cmd = tool_command(npx, &["wrangler", "whoami"], cwd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let Ok(mut child) = cmd.spawn() else {
        return (false, None);
    };
    let Ok(status) = wait_deadline(
        &mut child,
        "wrangler whoami",
        Instant::now() + WRANGLER_WHOAMI_TIMEOUT,
    ) else {
        return (false, None);
    };
    let Some(out) = child.stdout else {
        return (false, None);
    };
    let lines: Vec<String> = BufReader::new(out).lines().map_while(Result::ok).collect();
    let account = parse_whoami_account(&lines);
    (status.success() && account.is_some(), account)
}

fn probe_env() -> SelfhostEnv {
    let node_path = which_tool("node");
    let node_version = node_path
        .is_some()
        .then(|| probe_output("node", &["--version"], PROBE_TIMEOUT))
        .flatten();
    let npx_path = which_tool("npx");
    let rustc = probe_output("rustc", &["--version"], PROBE_TIMEOUT);
    let wasm_target = probe_output("rustup", &["target", "list", "--installed"], PROBE_TIMEOUT)
        .filter(|out| out.lines().any(|l| l.trim() == "wasm32-unknown-unknown"))
        .map(|_| "wasm32-unknown-unknown".to_string());
    let worker_build = which_tool("worker-build")
        .is_some()
        .then(|| probe_output("worker-build", &["--version"], PROBE_TIMEOUT))
        .flatten();
    let (wrangler_authed, account) = match npx_path.as_deref() {
        Some(npx) => wrangler_whoami(npx, soft_cwd(None).as_deref()),
        None => (false, None),
    };
    SelfhostEnv {
        node_path,
        node_version,
        npx_path,
        rustc,
        wasm_target,
        worker_build,
        wrangler_authed,
        account,
    }
}

/// Toolchain probe for the wizard's first screen. Every missing piece is
/// `None` — the wizard offers to install it (gateway-push §7).
#[tauri::command]
pub async fn gateway_selfhost_probe() -> CommandResult<SelfhostEnv> {
    let env = tokio::task::spawn_blocking(probe_env)
        .await
        .map_err(|e| anyhow!("wizard task failed: {e}"))?;
    Ok(env)
}

// ── steps (gateway-push §7 steps 2–6) ────────────────────────────────────────

/// One streamed `npx wrangler` invocation: every line becomes an event,
/// the run is deadline-bounded, and the collected output comes back for
/// parsing.
fn run_wrangler_streamed(
    app: &tauri::AppHandle,
    step: &str,
    npx: &str,
    args: &[&str],
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<(ExitStatus, Arc<Mutex<Vec<String>>>)> {
    let (mut child, collected) = spawn_streaming(app, step, npx, args, cwd)?;
    let what = format!("wrangler {step}");
    let status = wait_deadline(&mut child, &what, Instant::now() + timeout)?;
    Ok((status, collected))
}

fn collected_lines(collected: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
    collected.lock().map(|l| l.clone()).unwrap_or_default()
}

/// The wizard step dispatcher. Steps (gateway-push §9):
/// `wrangler-login` | `list-zones` | `kv-ensure` | `deploy` | `verify`.
/// Every step emits its `done` event exactly once — on success with the
/// result, on failure without it plus the rejected promise.
#[tauri::command]
pub async fn gateway_selfhost_step(
    app: tauri::AppHandle,
    step: String,
    domain: Option<String>,
    kv_id: Option<String>,
    repo_dir: Option<String>,
) -> CommandResult<SelfhostStepResult> {
    let mut result = SelfhostStepResult {
        step: step.clone(),
        ..Default::default()
    };
    match step.as_str() {
        STEP_LOGIN => {
            let cwd = soft_cwd(repo_dir.as_deref());
            let npx = match npx_path() {
                Ok(npx) => npx,
                Err(e) => return step_failed(&app, &result, e.to_string()),
            };
            let run = tokio::task::spawn_blocking({
                let app = app.clone();
                let npx = npx.clone();
                move || {
                    run_wrangler_streamed(
                        &app,
                        STEP_LOGIN,
                        &npx,
                        &["wrangler", "login"],
                        cwd.as_deref(),
                        WRANGLER_LOGIN_TIMEOUT,
                    )
                }
            })
            .await;
            let (status, collected) = match run {
                Ok(Ok(pair)) => pair,
                Ok(Err(e)) => return step_failed(&app, &result, e.to_string()),
                Err(e) => return step_failed(&app, &result, format!("wizard task failed: {e}")),
            };
            let lines = collected_lines(&collected);
            if !status.success() {
                let tail = tail_line(&lines).unwrap_or_else(|| "wrangler login failed".into());
                return step_failed(&app, &result, tail);
            }
            // Report the account the wizard will deploy under.
            let (authed, account) = wrangler_whoami(&npx, soft_cwd(repo_dir.as_deref()).as_deref());
            if authed {
                result.account = account;
            }
            emit_step_done(&app, &result);
            Ok(result)
        },
        STEP_LIST_ZONES => {
            // v1 is pragmatic (gateway-push §7 step 3): the account comes
            // from `wrangler whoami`; the zone itself is the domain the
            // user types (validated here) — a custom-domain deploy does
            // not need a zone list API round trip.
            if let Some(domain) = domain.as_deref() {
                if !valid_hostname(domain) {
                    return step_failed(
                        &app,
                        &result,
                        format!("{domain} does not look like a hostname"),
                    );
                }
            }
            let npx = match npx_path() {
                Ok(npx) => npx,
                Err(e) => return step_failed(&app, &result, e.to_string()),
            };
            let cwd = soft_cwd(repo_dir.as_deref());
            let whoami =
                match tokio::task::spawn_blocking(move || wrangler_whoami(&npx, cwd.as_deref()))
                    .await
                {
                    Ok(pair) => pair,
                    Err(e) => {
                        return step_failed(&app, &result, format!("wizard task failed: {e}"));
                    },
                };
            if !whoami.0 {
                return step_failed(
                    &app,
                    &result,
                    "wrangler is not logged in — run the login step first".into(),
                );
            }
            result.account = whoami.1;
            emit_step_done(&app, &result);
            Ok(result)
        },
        STEP_KV_ENSURE => {
            // Reuse the passed id when valid; otherwise create the
            // namespace (falling back to a list when it already exists).
            if let Some(id) = kv_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                if !valid_kv_id(id) {
                    return step_failed(
                        &app,
                        &result,
                        "the passed KV namespace id is malformed".into(),
                    );
                }
                result.kv_id = Some(id.to_string());
                emit_step_done(&app, &result);
                return Ok(result);
            }
            let relay_dir =
                match tokio::task::spawn_blocking(move || resolve_relay_dir(repo_dir.as_deref()))
                    .await
                {
                    Ok(Ok(dir)) => dir,
                    Ok(Err(e)) => return step_failed(&app, &result, e.to_string()),
                    Err(e) => {
                        return step_failed(&app, &result, format!("wizard task failed: {e}"));
                    },
                };
            let npx = match npx_path() {
                Ok(npx) => npx,
                Err(e) => return step_failed(&app, &result, e.to_string()),
            };
            let create = tokio::task::spawn_blocking({
                let app = app.clone();
                let npx = npx.clone();
                let relay_dir = relay_dir.clone();
                move || {
                    run_wrangler_streamed(
                        &app,
                        STEP_KV_ENSURE,
                        &npx,
                        &["wrangler", "kv", "namespace", "create", "GATEWAY_KV"],
                        Some(&relay_dir),
                        WRANGLER_KV_TIMEOUT,
                    )
                }
            })
            .await;
            let created = match create {
                Ok(Ok((status, collected))) => {
                    let lines = collected_lines(&collected);
                    status.success().then(|| parse_kv_id(&lines)).flatten()
                },
                _ => None,
            };
            if let Some(id) = created {
                result.kv_id = Some(id);
                emit_step_done(&app, &result);
                return Ok(result);
            }
            // The namespace may already exist — list and match by title.
            let list = tokio::task::spawn_blocking({
                let app = app.clone();
                let npx = npx.clone();
                let relay_dir = relay_dir.clone();
                move || {
                    run_wrangler_streamed(
                        &app,
                        STEP_KV_ENSURE,
                        &npx,
                        &["wrangler", "kv", "namespace", "list"],
                        Some(&relay_dir),
                        WRANGLER_KV_TIMEOUT,
                    )
                }
            })
            .await;
            let (status, collected) = match list {
                Ok(Ok(pair)) => pair,
                Ok(Err(e)) => return step_failed(&app, &result, e.to_string()),
                Err(e) => return step_failed(&app, &result, format!("wizard task failed: {e}")),
            };
            let lines = collected_lines(&collected);
            if status.success() {
                if let Some(id) = parse_kv_list_id(&lines, "GATEWAY_KV") {
                    result.kv_id = Some(id);
                    emit_step_done(&app, &result);
                    return Ok(result);
                }
                return step_failed(
                    &app,
                    &result,
                    "no GATEWAY_KV namespace found in the account".into(),
                );
            }
            step_failed(
                &app,
                &result,
                tail_line(&lines).unwrap_or_else(|| "wrangler kv failed".into()),
            )
        },
        STEP_DEPLOY => {
            // Owned up front: the template-fill closure must be 'static.
            let Some(domain) = domain
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
            else {
                return step_failed(&app, &result, "deploy needs the target domain".into());
            };
            if !valid_hostname(&domain) {
                return step_failed(
                    &app,
                    &result,
                    format!("{domain} does not look like a hostname"),
                );
            }
            let Some(kv_id) = kv_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
            else {
                return step_failed(
                    &app,
                    &result,
                    "deploy needs the KV namespace id (run kv-ensure first)".into(),
                );
            };
            if !valid_kv_id(&kv_id) {
                return step_failed(&app, &result, "the KV namespace id is malformed".into());
            }
            let prep = match tokio::task::spawn_blocking({
                let repo = repo_dir.clone();
                let domain = domain.clone();
                let kv_id = kv_id.clone();
                move || {
                    let relay_dir = resolve_relay_dir(repo.as_deref())?;
                    let template =
                        std::fs::read_to_string(relay_dir.join(TEMPLATE_FILE)).map_err(|e| {
                            anyhow!("read {TEMPLATE_FILE}: {e} (update the wowsp checkout)")
                        })?;
                    let filled = fill_selfhost_template(&template, &domain, &kv_id)?;
                    let local = relay_dir.join(LOCAL_CONFIG_FILE);
                    std::fs::write(&local, filled).map_err(|e| anyhow!("write {local:?}: {e}"))?;
                    Ok::<PathBuf, anyhow::Error>(relay_dir)
                }
            })
            .await
            {
                Ok(Ok(dir)) => dir,
                Ok(Err(e)) => return step_failed(&app, &result, e.to_string()),
                Err(e) => return step_failed(&app, &result, format!("wizard task failed: {e}")),
            };
            let npx = match npx_path() {
                Ok(npx) => npx,
                Err(e) => return step_failed(&app, &result, e.to_string()),
            };
            let run = tokio::task::spawn_blocking({
                let app = app.clone();
                let config_arg = LOCAL_CONFIG_FILE.to_string();
                move || {
                    run_wrangler_streamed(
                        &app,
                        STEP_DEPLOY,
                        &npx,
                        &["wrangler", "deploy", "--config", &config_arg],
                        Some(&prep),
                        WRANGLER_DEPLOY_TIMEOUT,
                    )
                }
            })
            .await;
            let (status, collected) = match run {
                Ok(Ok(pair)) => pair,
                Ok(Err(e)) => return step_failed(&app, &result, e.to_string()),
                Err(e) => return step_failed(&app, &result, format!("wizard task failed: {e}")),
            };
            let lines = collected_lines(&collected);
            if !status.success() {
                let tail = tail_line(&lines).unwrap_or_else(|| "wrangler deploy failed".into());
                return step_failed(&app, &result, tail);
            }
            // The phone's route entry: the worker binds /gateway/* on the
            // custom domain (the selfhost template's route pattern).
            result.url = Some(format!("https://{domain}/gateway"));
            emit_step_done(&app, &result);
            Ok(result)
        },
        STEP_VERIFY => {
            let Some(domain) = domain.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
                return step_failed(&app, &result, "verify needs the deployed domain".into());
            };
            if !valid_hostname(domain) {
                return step_failed(
                    &app,
                    &result,
                    format!("{domain} does not look like a hostname"),
                );
            }
            let url = format!("https://{domain}/gateway/health");
            let health = match fetch_verify_health(&url).await {
                Ok(doc) => doc,
                Err(e) => return step_failed(&app, &result, e.to_string()),
            };
            result.url = Some(format!("https://{domain}/gateway"));
            result.health = Some(health);
            emit_step_done(&app, &result);
            Ok(result)
        },
        other => step_failed(&app, &result, format!("unknown self-host step: {other}")),
    }
}

/// `GET https://<domain>/gateway/health` (15 s): a successful deploy
/// answers a v1 health document. Deliberately NOT the full client
/// validation — a deployment demanding a newer APP than this build still
/// deployed correctly; only protocol v1 is required here.
async fn fetch_verify_health(url: &str) -> Result<GatewayHealthDoc> {
    let client = super::super::network::build_http_client()?;
    let resp = client
        .get(url)
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .timeout(VERIFY_TIMEOUT)
        .send()
        .await
        .map_err(|e| anyhow!("deployment verify failed: {e}"))?;
    if !resp.status().is_success() {
        bail!("deployment verify failed (HTTP {})", resp.status().as_u16());
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| anyhow!("deployment verify failed: {e}"))?;
    let doc: GatewayHealthDoc = serde_json::from_slice(&body)
        .map_err(|e| anyhow!("deployment verify failed (invalid health document: {e})"))?;
    if !doc.gateway.trim().eq_ignore_ascii_case("v1") {
        bail!(
            "deployment answered an unsupported gateway protocol: {}",
            doc.gateway
        );
    }
    Ok(doc)
}
