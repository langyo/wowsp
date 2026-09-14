//! WoWSP installer shell.
//!
//! A small Tauri front-end that renders the three WoWSP install modes and
//! drives the shun install flow directly: the payload (staged application
//! directory, packed at build time — see build.rs) is embedded in this
//! single binary, and `shun::targets::install` performs the delivery.
//! Local mode registers the ARP entry and the self-copying uninstaller;
//! no shortcut is created during the flow — the manifest pins both
//! launcher policies to "never", making that structural regardless of
//! wizard answers. The done page applies the Start-menu/desktop
//! shortcuts on confirmation via `set_shortcuts`, and the headless
//! `--silent` run applies them itself after the flow (it never sees the
//! done page). USB and green modes drop the app's `.portable` marker
//! with no registration at all (config `portable-marker`).
//!
//! The shell is itself a Tauri app, so the WebView2 runtime is a hard
//! prerequisite for its own UI: before any window is created we check the
//! Evergreen runtime and, when missing, run the offline installer shipped
//! next to the shell (`MicrosoftEdgeWebView2RuntimeInstallerX64.exe`). If
//! the runtime still cannot be found we fall back to a native message box
//! (no WebView needed) and point the user at the releases page.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::iter::once;
use std::path::{Path, PathBuf};

use serde::Serialize;
use shun::config::{ShunConfig, TargetConfig};
use shun::flow::{Flow, FlowEvent};
use shun::payload::ArchivePayload;
use shun::targets::install::{
    InstallContext, InstallFlow, WindowsRegistration, WizardAnswers, default_aumid,
};
use tauri::Emitter;
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};

/// WebView2 Evergreen runtime product GUID.
const WEBVIEW2_APP_GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
/// Offline WebView2 Evergreen installer file name. Delivered two ways: a
/// file beside the shell (paired delivery), or a `webview2/` subtree
/// inside the embedded payload (the single-file -webview2 build — see
/// scripts/build_installers.py).
const WEBVIEW2_PAYLOAD: &str = "MicrosoftEdgeWebView2RuntimeInstallerX64.exe";
/// Payload-relative directory carrying the offline installer.
const WEBVIEW2_PAYLOAD_PREFIX: &str = "webview2";
/// Page opened when WebView2 is missing and no offline payload is available.
const RELEASES_URL: &str = "https://github.com/langyo/wowsp/releases/latest";

/// The resolved configuration, embedded by build.rs.
const SHUN_CONFIG_JSON: &str = include_str!(concat!(env!("OUT_DIR"), "/shun-config.json"));
/// The payload archive packed by build.rs from `metadata.shun.payload`.
const EMBEDDED_PAYLOAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/wowsp-payload.shun"));
/// Build flavor (lite/full + WebView2 bundling), stamped by build.rs.
const SHUN_FLAVOR: &str = include_str!(concat!(env!("OUT_DIR"), "/shun-flavor.txt"));
/// res-latest asset updated_at the staged models were packed from
/// ("" when unknown — e.g. plain `cargo build`); written as the
/// app's model-cache version stamp after relocation.
const SHUN_MODEL_VERSION: &str = include_str!(concat!(env!("OUT_DIR"), "/shun-model-version.txt"));
/// License texts per wizard locale (SySL + official translations).
const LICENSE_EN: &str = include_str!(concat!(env!("OUT_DIR"), "/license-en.txt"));
const LICENSE_ZH_HANS: &str = include_str!(concat!(env!("OUT_DIR"), "/license-zh-Hans.txt"));
const LICENSE_ZH_HANT: &str = include_str!(concat!(env!("OUT_DIR"), "/license-zh-Hant.txt"));

/// State shared by the commands: the resolved config and the payload
/// (cloned per install run).
struct AppState {
    config: ShunConfig,
    payload: ArchivePayload,
}

impl AppState {
    fn install_target(&self) -> Result<shun::config::InstallConfig, String> {
        self.config
            .targets
            .iter()
            .find_map(|t| match t {
                TargetConfig::Install(install) => Some(install.clone()),
                _ => None,
            })
            .ok_or_else(|| "此配置未声明安装目标".to_string())
    }

    /// The install context for a wizard run: `local` registers the
    /// install, `usb` / `green` deliver a portable copy.
    fn install_context(
        &self,
        mode: &str,
        dir: &str,
        answers: WizardAnswers,
    ) -> Result<InstallContext, String> {
        let install = self.install_target()?;
        let mut ctx = InstallContext::new(
            self.config.product.name.clone(),
            self.config.product.version.clone(),
            PathBuf::from(dir),
            mode != "local",
        );
        ctx.publisher = self.config.product.publisher.clone();
        ctx.main_exe = install.main_exe.clone();
        ctx.apply_config(&install, answers);
        Ok(ctx)
    }
}

#[derive(Serialize)]
struct DirDefaults {
    dir: String,
    /// True when `dir` points at a removable drive (USB mode).
    removable: bool,
}

fn local_appdata() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .parent()
        .map(|d| d.to_path_buf())
}

/// Fixed Win32 ABI value; windows-sys 0.59 only exposes it via the
/// deprecated `Win32_System_WindowsProgramming` module.
const DRIVE_REMOVABLE: u32 = 2;

/// First removable drive letter (A..Z), the USB-mode default directory.
fn first_removable_drive() -> Option<char> {
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};

    let masks = unsafe { GetLogicalDrives() };
    if masks == 0 {
        return None;
    }
    for i in 0..26u32 {
        if masks & (1 << i) != 0 {
            let root: [u16; 4] = [(b'A' + i as u8) as u16, b':' as u16, b'\\' as u16, 0];
            if unsafe { GetDriveTypeW(root.as_ptr()) } == DRIVE_REMOVABLE {
                return Some((b'A' + i as u8) as char);
            }
        }
    }
    None
}

fn wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(once(0)).collect()
}

fn webview2_installed() -> bool {
    let hives = [
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients",
        ),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\EdgeUpdate\Clients"),
        (HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\EdgeUpdate\Clients"),
    ];
    for (hive, path) in hives {
        let Ok(clients) = RegKey::predef(hive).open_subkey_with_flags(path, KEY_READ) else {
            continue;
        };
        let Ok(runtime) = clients.open_subkey_with_flags(WEBVIEW2_APP_GUID, KEY_READ) else {
            continue;
        };
        let version: String = runtime.get_value("pv").unwrap_or_default();
        if !version.is_empty() {
            return true;
        }
    }
    false
}

/// Runs `exe` with `args`, waiting for exit. Handles executables whose
/// manifest requires elevation (os error 740) by relaunching through UAC
/// (PowerShell Start-Process -RunAs -Wait).
fn run_waiting(exe: &Path, args: &[&str]) -> std::io::Result<std::process::ExitStatus> {
    match std::process::Command::new(exe).args(args).status() {
        Ok(status) => Ok(status),
        Err(e) if e.raw_os_error() == Some(740) => {
            let script = format!(
                "Start-Process -FilePath '{}' -ArgumentList '{}' -Wait",
                exe.display(),
                args.join("' '")
            );
            std::process::Command::new("powershell")
                .args(["-NoProfile", "-Command", &script])
                .status()
        },
        Err(e) => Err(e),
    }
}

fn show_fatal_error(title: &str, text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};

    let title_w = wide_null(title);
    let text_w = wide_null(text);
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text_w.as_ptr(),
            title_w.as_ptr(),
            MB_ICONERROR | MB_OK,
        );
    }
}

fn open_url(url: &str) {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let verb_w = wide_null("open");
    let url_w = wide_null(url);
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb_w.as_ptr(),
            url_w.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
    }
}

/// Makes sure the WebView2 runtime is present before the Tauri UI starts.
/// The offline installer comes either from beside the shell or, in the
/// single-file -webview2 build, out of the embedded payload (extracted
/// once into a per-user cache). Returns normally once installed;
/// otherwise shows a native error, opens the releases page and exits — a
/// WebView-less shell cannot render UI.
fn ensure_webview2(exe_dir: &Path, payload: &ArchivePayload) {
    if webview2_installed() {
        return;
    }

    // Paired delivery: the offline installer sits next to the shell.
    let beside = exe_dir.join(WEBVIEW2_PAYLOAD);
    if beside.is_file() && run_offline_installer(&beside) {
        return;
    }

    // Single-file delivery: extract the `webview2/` subtree from the
    // embedded payload into a per-user cache and run it from there.
    let cache = local_appdata().join("wowsp-installer").join("webview2");
    if payload
        .extract_prefix(&cache, Path::new(WEBVIEW2_PAYLOAD_PREFIX), &mut |_| {})
        .is_ok()
    {
        let extracted = cache.join(WEBVIEW2_PAYLOAD_PREFIX).join(WEBVIEW2_PAYLOAD);
        if extracted.is_file() && run_offline_installer(&extracted) {
            return;
        }
    }

    show_fatal_error(
        "WoWSP 安装器",
        "本系统缺少 WoWSP 运行所必需的 Microsoft WebView2 运行时。\n\n\
         请从即将打开的发布页下载自带 WebView2 的完整安装包，\
         或先安装 WebView2 运行时后重试。",
    );
    open_url(RELEASES_URL);
    std::process::exit(1);
}

/// Runs the Evergreen offline installer and reports whether the runtime
/// is present afterwards.
fn run_offline_installer(installer: &Path) -> bool {
    if let Ok(status) = run_waiting(installer, &["/silent", "/install"]) {
        return status.success() && webview2_installed();
    }
    false
}

fn install_dir_for(mode: &str) -> PathBuf {
    match mode {
        "usb" => match first_removable_drive() {
            Some(drive) => PathBuf::from(format!("{drive}:\\WoWSP")),
            None => local_appdata().join("WoWSP"),
        },
        "green" => exe_dir()
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
            .join("WoWSP"),
        _ => local_appdata().join("WoWSP"),
    }
}

#[tauri::command]
fn default_dir(mode: String) -> DirDefaults {
    let dir = install_dir_for(&mode);
    let removable = mode == "usb" && first_removable_drive().is_some();
    DirDefaults {
        dir: dir.to_string_lossy().into_owned(),
        removable,
    }
}

fn emit_progress(app: &tauri::AppHandle, event: &FlowEvent) {
    let _ = app.emit("install-progress", event);
}

/// Applies the done-page confirmation in one shot: creates or removes
/// the install's shortcuts per the checkboxes. The wizard flow itself
/// creates nothing (the manifest pins both launcher policies to
/// "never"), so this is the only place the user's shortcut choices take
/// effect; it is called once when the done page's finish button runs.
/// The `.lnk` writes go through COM and can stall under antivirus
/// scanners, so the work runs on a blocking thread — the UI must not
/// freeze while the confirmation applies.
#[tauri::command]
async fn set_shortcuts(
    state: tauri::State<'_, AppState>,
    desktop: Option<bool>,
    menu: Option<bool>,
    dir: String,
    mode: String,
) -> Result<(), String> {
    let aumid = shortcut_aumid_for(&state.config);
    let portable = mode != "local";
    tauri::async_runtime::spawn_blocking(move || {
        apply_shortcut_choices(&aumid, desktop, menu, &dir, portable)
    })
    .await
    .map_err(|e| format!("快捷方式任务异常退出: {e}"))?
}

/// Applies one set of shortcut choices: creates or removes the requested
/// `.lnk`s and shell-notifies the changed surfaces. Both operations run
/// even when one fails — the combined error is returned, and a shortcut
/// failure never invalidates the completed install.
fn apply_shortcut_choices(
    aumid: &str,
    desktop: Option<bool>,
    menu: Option<bool>,
    dir: &str,
    portable: bool,
) -> Result<(), String> {
    let dir = dir.trim().trim_end_matches('\\').to_string();
    if dir.is_empty() {
        return Err("安装目录不能为空".into());
    }
    let exe = Path::new(&dir).join("wowsp.exe");
    if !exe.is_file() {
        return Err("安装目录中未找到 wowsp.exe".into());
    }

    let mut changed = Vec::new();
    let mut failures = Vec::new();
    if let Some(want) = menu {
        let link = start_menu_link(&dir, portable);
        if let Err(e) = apply_shortcut(&link, &exe, want, aumid, &mut changed) {
            failures.push(format!("开始菜单快捷方式：{e}"));
        }
    }
    if let Some(want) = desktop {
        if portable {
            failures.push("便携模式不创建桌面快捷方式".into());
        } else if let Err(e) = apply_shortcut(&desktop_link(), &exe, want, aumid, &mut changed) {
            failures.push(format!("桌面快捷方式：{e}"));
        }
    }
    notify_shell_change(&changed);
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("；"))
    }
}

/// The shortcut grouping identity for the configured install target: the
/// manifest's `aumid` when declared, else shun's `{publisher}.{product}`
/// default — the same rule `InstallContext::apply_config` applies.
fn shortcut_aumid_for(config: &ShunConfig) -> String {
    let configured = config.targets.iter().find_map(|t| match t {
        TargetConfig::Install(install) => install.aumid.clone(),
        _ => None,
    });
    configured
        .unwrap_or_else(|| default_aumid(config.product.publisher.as_deref(), &config.product.name))
}

fn start_menu_link(install_dir: &str, portable: bool) -> PathBuf {
    if portable {
        // Self-contained copy: start-menu entry lives in its own data tree.
        return Path::new(install_dir)
            .join("data")
            .join("start-menu")
            .join("WoWSP.lnk");
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    base.join(r"Microsoft\Windows\Start Menu\Programs")
        .join("WoWSP.lnk")
}

fn desktop_link() -> PathBuf {
    use windows_sys::Win32::UI::Shell::{FOLDERID_Desktop, SHGetKnownFolderPath};

    unsafe {
        let mut path = std::ptr::null_mut();
        let hr = SHGetKnownFolderPath(&FOLDERID_Desktop, 0, std::ptr::null_mut(), &mut path);
        if hr == 0 && !path.is_null() {
            let mut len = 0usize;
            while *path.add(len) != 0 {
                len += 1;
            }
            let wide = std::slice::from_raw_parts(path, len);
            let s = String::from_utf16_lossy(wide);
            windows_sys::Win32::System::Com::CoTaskMemFree(path.cast());
            return PathBuf::from(s).join("WoWSP.lnk");
        }
    }
    let base = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    base.join("Desktop").join("WoWSP.lnk")
}

/// Creates or removes one `.lnk`, recording the path in `changed` when
/// the filesystem actually changes. Creation stamps the app's AUMID on
/// the link — best-effort: a failed stamp only warns and never fails
/// the creation.
fn apply_shortcut(
    link: &Path,
    exe: &Path,
    want: bool,
    aumid: &str,
    changed: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if want {
        if link.is_file() {
            return Ok(());
        }
        if let Some(parent) = link.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
        }
        mslnk::ShellLink::new(exe)
            .and_then(|l| l.create_lnk(link))
            .map_err(|e| format!("创建快捷方式失败: {e}"))?;
        if let Err(e) = shun::targets::aumid::stamp(link, aumid) {
            eprintln!("shun: AUMID stamp on {}: {e}", link.display());
        }
        changed.push(link.to_path_buf());
    } else {
        match std::fs::remove_file(link) {
            Ok(()) => changed.push(link.to_path_buf()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            Err(e) => return Err(format!("移除快捷方式失败: {e}")),
        }
    }
    Ok(())
}

/// Tells Explorer the shortcut surfaces changed — a per-path update
/// event plus one association-level refresh — so freshly created or
/// removed `.lnk` files show up (or vanish) without waiting for
/// Explorer's own re-indexing. Mirrors shun's post-install notification.
fn notify_shell_change(paths: &[PathBuf]) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{
        SHCNE_ASSOCCHANGED, SHCNE_UPDATEITEM, SHCNF_PATH, SHChangeNotify,
    };

    unsafe {
        for path in paths {
            let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            SHChangeNotify(
                SHCNE_UPDATEITEM as i32,
                SHCNF_PATH,
                wide.as_ptr().cast(),
                std::ptr::null(),
            );
        }
        SHChangeNotify(
            SHCNE_ASSOCCHANGED as i32,
            0,
            std::ptr::null(),
            std::ptr::null(),
        );
    }
}

#[derive(Serialize)]
struct Identity {
    version: String,
    flavor: String,
}

#[derive(Serialize)]
struct ShellPrefs {
    log_level: String,
    log_order: String,
}

/// Install-pane preferences from the manifest's `[shun.shell]` table —
/// log verbosity and line ordering (newest-first is the default).
#[tauri::command]
fn get_shell_prefs(state: tauri::State<'_, AppState>) -> ShellPrefs {
    let shell = state.config.shell.clone().unwrap_or_default();
    ShellPrefs {
        log_level: match shell.log_level {
            Some(shun::config::LogVerbosity::Files) => "files".into(),
            Some(shun::config::LogVerbosity::Scripts) => "scripts".into(),
            Some(shun::config::LogVerbosity::Off) => "off".into(),
            _ => "all".into(),
        },
        log_order: match shell.log_order {
            Some(shun::config::LogOrder::Oldest) => "oldest".into(),
            _ => "newest".into(),
        },
    }
}

/// The installer's identity: product version plus the build flavor
/// (which components the payload carries), shown under the install
/// location.
#[tauri::command]
fn get_identity(state: tauri::State<'_, AppState>) -> Identity {
    Identity {
        version: state.config.product.version.clone(),
        flavor: SHUN_FLAVOR.trim().to_string(),
    }
}

/// The license agreement text for the requested locale (SySL +
/// official translations, resolved at build time).
#[tauri::command]
fn get_license(locale: String) -> String {
    let lower = locale.to_lowercase();
    if lower.starts_with("zh-hant") || lower.starts_with("zh-tw") || lower.starts_with("zh-hk") {
        LICENSE_ZH_HANT.to_string()
    } else if lower.starts_with("zh") {
        LICENSE_ZH_HANS.to_string()
    } else {
        LICENSE_EN.to_string()
    }
}

/// Runs the install flow for the wizard UI. Both launchers are deferred
/// to the done step: the manifest's "never" shortcut knobs make the
/// no-creation guarantee structural (the wizard also answers `false` to
/// both policies), and the done page's confirmation applies the user's
/// choices via `set_shortcuts`. The flow runs on a blocking thread — a
/// sync command would execute on the main thread and stall the whole
/// event loop (renderer IPC, window events, painting) for the extract.
#[tauri::command]
async fn start_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mode: String,
    dir: String,
) -> Result<(), String> {
    let dir = dir.trim().trim_end_matches('\\').to_string();
    if dir.is_empty() {
        return Err("安装目录不能为空".into());
    }
    let answers = WizardAnswers {
        desktop_shortcut: false,
        start_menu_shortcut: false,
        machine: false,
    };
    let ctx = state.install_context(&mode, &dir, answers)?;

    let payload = state.payload.clone();
    let install_dir = ctx.install_dir.clone();
    let portable = ctx.portable;
    let flow_ctx = ctx;
    tauri::async_runtime::spawn_blocking(move || {
        let flow = InstallFlow {
            payload: &payload,
            registration: &WindowsRegistration,
            ctx: flow_ctx,
        };
        flow.run(&mut |event| emit_progress(&app, &event))
            .map_err(|e| e.to_string())?;
        cleanup_bootstrap_payload(&install_dir);
        relocate_model_pack(&install_dir, portable);
        Ok(())
    })
    .await
    .map_err(|e| format!("安装任务异常退出: {e}"))?
}

/// The -webview2 build carries the Evergreen offline installer inside the
/// payload purely for the shell's own gate; the installed application has
/// no use for it, so it is removed after the flow delivers the payload.
/// (Uninstall tolerates the missing files — removal ignores errors.)
fn cleanup_bootstrap_payload(install_dir: &Path) {
    let _ = std::fs::remove_dir_all(install_dir.join(WEBVIEW2_PAYLOAD_PREFIX));
}

/// Relocates the payload's shipped model pack into the location the
/// application's model-pack cache resolves to (the paths.rs conventions:
/// portable → `<dir>/data/cache`, local → `%LOCALAPPDATA%\WoWSP`). The
/// extraction lands at `<dir>/models`; a rename usually suffices, falling
/// back to a recursive copy across volumes. After a successful relocation
/// the pack is stamped with the res-latest `updated_at` it was packed
/// from (`<cache>/.version`) so the app treats it as current instead of
/// re-downloading on first launch; no stamp when the version is unknown
/// or the pack is absent (lite flavor).
fn relocate_model_pack(install_dir: &Path, portable: bool) {
    let from = install_dir.join("models");
    if !from.is_dir() {
        return;
    }
    let mut to = if portable {
        install_dir.join("data").join("cache")
    } else {
        local_appdata().join("WoWSP")
    };
    let _ = std::fs::create_dir_all(&to);
    to.push("models");

    // The pack ends up in place when it was already at its final home
    // (nothing to move), when the rename fast path succeeds, or when the
    // recursive-copy fallback lands it across volumes.
    let moved = if to == from {
        true
    } else if std::fs::rename(&from, &to).is_ok() {
        true
    } else {
        let copied = copy_dir_recursive(&from, &to);
        if copied {
            let _ = std::fs::remove_dir_all(&from);
        }
        copied
    };
    if !moved {
        return;
    }

    // Stamp the relocated pack as the res-latest version it was packed
    // from, so the app's update check sees it as current instead of
    // re-downloading ~1.2 GB on first launch. No stamp when the version
    // is unknown; the app then falls back to its normal fetch-or-serve
    // behavior. (Same file the app's write_cached_version uses.)
    let version = SHUN_MODEL_VERSION.trim();
    if !version.is_empty() {
        if let Some(cache) = to.parent() {
            let _ = std::fs::write(cache.join(".version"), version);
        }
    }
}

/// Recursively copies `from` into `to` (creating directories as needed).
/// Existing files are overwritten; unreadable entries are skipped — the
/// app re-downloads the model pack when the cache turns out incomplete.
fn copy_dir_recursive(from: &Path, to: &Path) -> bool {
    let _ = std::fs::create_dir_all(to);
    let Ok(entries) = std::fs::read_dir(from) else {
        return false;
    };
    for entry in entries.flatten() {
        let target = to.join(entry.file_name());
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if !copy_dir_recursive(&entry.path(), &target) {
                return false;
            }
        } else if std::fs::copy(entry.path(), &target).is_err() {
            return false;
        }
    }
    true
}

/// Automated-install arguments (headless mode): `--silent` skips the UI
/// and runs the flow headlessly with `--mode=local|usb|green`,
/// `--dir=<path>`, `--desktop`/`--no-desktop`, and an optional
/// `--uninstall`. The ARP `UninstallString` invokes the copied shell with
/// `/uninstall` during removal. The flow itself creates no shortcuts
/// (the manifest pins both launcher policies to "never"); because
/// headless runs never see the done page, the shell applies the choices
/// itself after the flow — the start-menu shortcut always, the desktop
/// one following `--desktop`/`--no-desktop` (default on).
fn run_headless(
    args: &[String],
    config: &ShunConfig,
    payload: &ArchivePayload,
) -> Result<(), String> {
    let mut mode = "local".to_string();
    let mut dir: Option<PathBuf> = None;
    let mut uninstall_mode = false;
    let mut desktop: Option<bool> = None;
    for arg in args {
        if let Some(value) = arg.strip_prefix("--mode=") {
            mode = value.to_string();
        } else if let Some(value) = arg.strip_prefix("--dir=") {
            dir = Some(PathBuf::from(value.trim_matches('"')));
        } else if arg == "--uninstall" || arg == "/uninstall" {
            uninstall_mode = true;
        } else if arg == "--desktop" {
            desktop = Some(true);
        } else if arg == "--no-desktop" {
            desktop = Some(false);
        }
    }
    let product = config.product.name.clone();
    let dir = dir.unwrap_or_else(|| install_dir_for(&mode));
    let mut ctx = InstallContext::new(
        product,
        config.product.version.clone(),
        dir,
        mode != "local",
    );
    ctx.publisher = config.product.publisher.clone();
    ctx.main_exe = config.targets.iter().find_map(|t| match t {
        TargetConfig::Install(install) => install.main_exe.clone(),
        _ => None,
    });
    let answers = WizardAnswers {
        desktop_shortcut: desktop.unwrap_or(true),
        start_menu_shortcut: true,
        machine: false,
    };
    if let Some(install) = config.targets.iter().find_map(|t| match t {
        TargetConfig::Install(install) => Some(install),
        _ => None,
    }) {
        ctx.apply_config(install, answers);
    }

    if uninstall_mode {
        shun::targets::install::uninstall(&ctx, &WindowsRegistration).map_err(|e| e.to_string())?;
        println!("shun: uninstalled {}", ctx.install_dir.display());
        return Ok(());
    }
    let install_dir = ctx.install_dir.clone();
    let portable = ctx.portable;
    let flow = InstallFlow {
        payload,
        registration: &WindowsRegistration,
        ctx,
    };
    flow.run(&mut |event| match &event {
        FlowEvent::Progress { step, .. } => println!("shun: {step}"),
        FlowEvent::Completed => println!("shun: install complete"),
        _ => {},
    })
    .map_err(|e| e.to_string())?;
    cleanup_bootstrap_payload(&install_dir);
    relocate_model_pack(&install_dir, portable);
    // The flow created nothing (manifest "never" knobs) and a silent run
    // never sees the done page, so the shell applies the choices itself.
    let aumid = shortcut_aumid_for(config);
    if let Err(e) = apply_shortcut_choices(
        &aumid,
        Some(desktop.unwrap_or(true)),
        Some(true),
        &install_dir.to_string_lossy(),
        mode != "local",
    ) {
        eprintln!("shun: shortcuts: {e}");
    }
    Ok(())
}

fn main() {
    let config: ShunConfig =
        serde_json::from_str(SHUN_CONFIG_JSON).expect("embedded config decodes");
    let payload = ArchivePayload::from_bytes(EMBEDDED_PAYLOAD).expect("embedded payload decodes");

    let args: Vec<String> = std::env::args().skip(1).collect();
    // Headless entry points: explicit `--silent` runs, and the ARP
    // `UninstallString` (`...uninstall.exe" /uninstall`) which must
    // uninstall without opening the wizard.
    let silent = args.iter().any(|a| a == "--silent" || a == "/S");
    let uninstalling = args.iter().any(|a| a == "--uninstall" || a == "/uninstall");
    if silent || uninstalling {
        if let Err(err) = run_headless(&args, &config, &payload) {
            eprintln!("shun: {err}");
            std::process::exit(1);
        }
        return;
    }

    if let Some(dir) = exe_dir() {
        ensure_webview2(&dir, &payload);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { config, payload })
        .invoke_handler(tauri::generate_handler![
            default_dir,
            get_identity,
            get_shell_prefs,
            get_license,
            set_shortcuts,
            start_install
        ])
        .run(tauri::generate_context!())
        .expect("error while running WoWSP installer shell");
}
