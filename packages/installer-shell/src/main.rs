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
//! shortcuts on confirmation via `set_shortcuts` and — when the 立即启动
//! box stays checked — starts the freshly installed app (`launch_app`)
//! before closing; the headless `--silent` run applies the shortcuts
//! itself after the flow (it never sees the done page). USB and green
//! modes drop the app's `.portable` marker with no registration at all
//! (config `portable-marker`).
//!
//! The shell is itself a Tauri app, so the WebView2 runtime is a hard
//! prerequisite for its own UI: before any window is created we check the
//! Evergreen runtime and, when missing, run the offline installer shipped
//! next to the shell (`MicrosoftEdgeWebView2RuntimeInstallerX64.exe`). If
//! the runtime still cannot be found we fall back to a native message box
//! (no WebView needed) and point the user at the releases page.
//!
//! Uninstall entry points: `/uninstall` (the ARP `UninstallString`) opens
//! a dedicated uninstall page in the same Tauri window — confirm →
//! indeterminate progress → done, plus a 修复安装 (repair) action that
//! re-runs the local delivery flow over the install dir the uninstaller
//! sits in (`current_install_dir` + `start_install`: the payload is
//! re-extracted and the registration refreshed, user data preserved).
//! Without a WebView2 runtime the uninstall flow runs in a minimal egui
//! window instead (`uninstall_egui`) — the zero-cost floor for machines
//! with nothing at all. `--silent`/`/S` combined with `/uninstall` keeps
//! the fully headless uninstall.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::iter::once;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};

use serde::Serialize;
use shun::config::{ShunConfig, TargetConfig};
use shun::flow::{Flow, FlowEvent, FlowPhase};
use shun::payload::{ArchivePayload, MANIFEST_PATH, PayloadEntry};
use shun::targets::install::{
    InstallContext, InstallFlow, UNINSTALLER_NAME, WindowsRegistration, WizardAnswers,
    default_aumid,
};
use tauri::Emitter;
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};

mod uninstall_egui;

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
/// Build flavor identity (model-pack + WebView2 bundling), stamped by build.rs.
const SHUN_FLAVOR: &str = include_str!(concat!(env!("OUT_DIR"), "/shun-flavor.txt"));
/// res-latest asset updated_at the staged models were packed from
/// ("" when unknown — e.g. plain `cargo build`); written as the
/// app's model-cache version stamp after relocation.
const SHUN_MODEL_VERSION: &str = include_str!(concat!(env!("OUT_DIR"), "/shun-model-version.txt"));
/// License texts per wizard locale (SySL + official translations).
const LICENSE_EN: &str = include_str!(concat!(env!("OUT_DIR"), "/license-en.txt"));
const LICENSE_ZH_HANS: &str = include_str!(concat!(env!("OUT_DIR"), "/license-zh-Hans.txt"));
const LICENSE_ZH_HANT: &str = include_str!(concat!(env!("OUT_DIR"), "/license-zh-Hant.txt"));

/// State shared by the commands: the resolved config, the payload
/// (cloned per install run), and whether this run drives the uninstall
/// page instead of the install wizard.
struct AppState {
    config: ShunConfig,
    payload: ArchivePayload,
    uninstall_mode: bool,
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
/// (PowerShell Start-Process -RunAs -Wait). Every child is started with
/// CREATE_NO_WINDOW — console-subsystem tools (the PowerShell fallback)
/// must never flash a console window in front of the wizard.
fn run_waiting(exe: &Path, args: &[&str]) -> std::io::Result<std::process::ExitStatus> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    match std::process::Command::new(exe)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
    {
        Ok(status) => Ok(status),
        Err(e) if e.raw_os_error() == Some(740) => {
            let script = format!(
                "Start-Process -FilePath '{}' -ArgumentList '{}' -Wait",
                exe.display(),
                args.join("' '")
            );
            std::process::Command::new("powershell")
                .args(["-NoProfile", "-Command", &script])
                .creation_flags(CREATE_NO_WINDOW)
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
    // The LOCAL install must not land on `%LOCALAPPDATA%\WoWSP` — that path
    // is ALSO the application's model-pack cache root (paths.rs), and the
    // two sharing one directory means every reinstall churns the cache and
    // a stray uninstall can take the models with it. Per-user installs
    // belong under `...\Programs\`; the cache stays alone.
    let local_install = || local_appdata().join("Programs").join("WoWSP");
    match mode {
        "usb" => match first_removable_drive() {
            Some(drive) => PathBuf::from(format!("{drive}:\\WoWSP")),
            None => local_install(),
        },
        "green" => exe_dir()
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
            .join("WoWSP"),
        _ => local_install(),
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

/// Pads one folder layer under a bare filesystem root target (a picked
/// drive like `D:\`) so the payload never lands directly on the root —
/// shun 0.3's root-drive guard. The wizard rewrites the path box with
/// the result whenever a root is picked or typed; the install itself
/// re-applies the same guard via shun's `apply_config`.
#[tauri::command]
fn nest_root_dir(state: tauri::State<'_, AppState>, dir: String) -> String {
    let install = state.install_target().ok();
    shun::targets::install::nest_root_dir(
        Path::new(dir.trim()),
        &state.config.product.name,
        install.as_ref().and_then(|i| i.root_dir_folder.as_deref()),
    )
    .to_string_lossy()
    .into_owned()
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
    // Same root-drive guard as the install: the shortcuts point at the
    // padded directory the flow delivered.
    let install = state.install_target().ok();
    let dir = shun::targets::install::nest_root_dir(
        Path::new(dir.trim()),
        &state.config.product.name,
        install.as_ref().and_then(|i| i.root_dir_folder.as_deref()),
    )
    .to_string_lossy()
    .into_owned();
    let portable = mode != "local";
    tauri::async_runtime::spawn_blocking(move || {
        apply_shortcut_choices(&aumid, desktop, menu, &dir, portable)
    })
    .await
    .map_err(|e| format!("快捷方式任务异常退出: {e}"))?
}

/// Launches the freshly installed/copied application (done-page option)
/// through shun's launch helper.
#[tauri::command]
fn launch_app(state: tauri::State<'_, AppState>, dir: String) -> Result<(), String> {
    let install = state.install_target()?;
    // Same root-drive guard as the install: the padded path is what the
    // flow delivered, so the launch resolves the same directory.
    let dir = shun::targets::install::nest_root_dir(
        Path::new(dir.trim().trim_end_matches('\\')),
        &state.config.product.name,
        install.root_dir_folder.as_deref(),
    );
    let mut ctx = InstallContext::new(
        state.config.product.name.clone(),
        state.config.product.version.clone(),
        dir,
        false,
    );
    ctx.main_exe = install.main_exe.clone();
    // The done-page checkbox is the answer: reaching this command means
    // the user asked for a launch.
    ctx.launch_after_install = true;
    shun::targets::install::launch(&ctx).map_err(|e| e.to_string())
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

/// The directory holding the running executable — the install dir for
/// the copied uninstaller, which sits INSIDE the install target (see
/// `uninstall_context`). Shared by the uninstall flow and the uninstall
/// page's repair action (`current_install_dir`).
fn current_exe_dir() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| format!("无法定位卸载程序: {e}"))?
        .parent()
        .ok_or_else(|| "无法定位卸载程序目录".to_string())
        .map(Path::to_path_buf)
}

/// The uninstall context shared by both uninstall UIs (Tauri page and
/// egui fallback): the copied uninstaller (`uninstall.exe`, the ARP
/// `UninstallString` target) sits INSIDE the install dir, so the running
/// executable's directory is the install target. Local-install semantics
/// only — a portable copy has no ARP entry, so the uninstall UI is
/// unreachable for it.
pub(crate) fn uninstall_context(config: &ShunConfig) -> Result<InstallContext, String> {
    let exe_dir = current_exe_dir()?;
    let install = config
        .targets
        .iter()
        .find_map(|t| match t {
            TargetConfig::Install(install) => Some(install.clone()),
            _ => None,
        })
        .ok_or_else(|| "此配置未声明安装目标".to_string())?;
    let mut ctx = InstallContext::new(
        config.product.name.clone(),
        config.product.version.clone(),
        exe_dir,
        false,
    );
    ctx.publisher = config.product.publisher.clone();
    ctx.main_exe = install.main_exe.clone();
    ctx.apply_config(
        &install,
        WizardAnswers {
            desktop_shortcut: false,
            start_menu_shortcut: true,
            launch_after_install: false,
            machine: false,
        },
    );
    Ok(ctx)
}

/// Whether this run drives the uninstall page (`/uninstall` without
/// `--silent`): the frontend renders it instead of the install wizard.
#[tauri::command]
fn is_uninstall_mode(state: tauri::State<'_, AppState>) -> bool {
    state.uninstall_mode
}

/// The install dir this uninstaller lives in — the target the uninstall
/// page's 修复安装 (repair) action re-installs over via `start_install`.
#[tauri::command]
fn current_install_dir() -> Result<String, String> {
    current_exe_dir().map(|d| d.to_string_lossy().into_owned())
}

/// Runs the shun uninstall for the install dir this uninstaller lives
/// in. shun's uninstall is silent (no event callback), so the UI shows
/// an indeterminate progress state while this runs. Deleting the
/// directory the running uninstaller sits in is handled inside shun
/// (scheduled self-delete + best-effort directory removal). The work
/// runs on a blocking thread — the UI must not freeze while the
/// registry and filesystem work proceeds.
#[tauri::command]
async fn perform_uninstall(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let ctx = uninstall_context(&state.config)?;
    tauri::async_runtime::spawn_blocking(move || {
        shun::targets::install::uninstall(&ctx, &WindowsRegistration).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("卸载任务异常退出: {e}"))?
}

/// Stops a running WoWSP before an overwrite install replaces its
/// payload: Windows locks a running executable, so extracting a new
/// `wowsp.exe` under it fails with os error 5. An existing install is
/// detected by the main exe sitting in the install dir; the kill goes by
/// image name (every instance, across install dirs — the same contract
/// the silent update path has always had). Returns whether a previous
/// install was detected.
fn stop_running_app(install_dir: &Path) -> bool {
    if !install_dir.join("wowsp.exe").is_file() {
        return false;
    }
    println!("shun: existing install detected — stopping the running application");
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/IM", "wowsp.exe"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .status();
    std::thread::sleep(std::time::Duration::from_millis(800));
    true
}

/// The installer-owned files that live in the install dir but are never
/// payload entries: the flow's on-disk manifest, the copied uninstaller,
/// and the portable marker (pinned as `.portable` in the manifest and by
/// the app's paths.rs). The stale-file pass must leave them alone even
/// if a damaged old manifest happens to list them. Compared
/// case-insensitively — Windows resolves paths that way, and an
/// exact-case check would let `Shun-Manifest.json` dodge the guard.
fn is_installer_artifact(path: &Path) -> bool {
    let name = path.to_string_lossy().to_lowercase();
    name == MANIFEST_PATH || name == UNINSTALLER_NAME || name == ".portable"
}

/// Whether a manifest entry path may be joined under the install dir
/// for deletion: archive-relative (no drive/root component) and free of
/// `..`. The old manifest is external input as far as this pass is
/// concerned, and the pass deletes files.
fn entry_path_is_unsafe(path: &Path) -> bool {
    path.components().any(|c| {
        matches!(
            c,
            std::path::Component::Prefix(_)
                | std::path::Component::RootDir
                | std::path::Component::ParentDir
        )
    })
}

/// Reads the on-disk payload manifest a previous InstallFlow run left
/// behind. `None` when absent or unparsable — no previous install to
/// diff against, or one too damaged to trust.
fn read_installed_manifest(install_dir: &Path) -> Option<Vec<PayloadEntry>> {
    let bytes = std::fs::read(install_dir.join(MANIFEST_PATH)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Deletes the files the PREVIOUS payload delivered that the new one no
/// longer carries — the diff between a manifest captured before the flow
/// ran and the manifest the flow just wrote. Without it, overwrite
/// installs accumulate renamed/dropped files forever (uninstall deletes
/// only what the CURRENT manifest lists). Runs only after a successful
/// flow — a failed extract must not thin out the old install — and every
/// removal is best-effort. Directories the pass empties are pruned
/// afterwards. One known gap: the flow writes the new manifest before
/// registering, so a flow that fails at registration leaves the NEW
/// manifest on disk and a retried install loses the old baseline (the
/// diff becomes new-vs-new). Returns how many files were removed.
fn remove_stale_payload_files(install_dir: &Path, previous: &[PayloadEntry]) -> usize {
    if previous.is_empty() {
        return 0;
    }
    // The flow just wrote the new manifest; when it cannot be read back,
    // skip the pass entirely rather than guess what is still current.
    let Some(current) = read_installed_manifest(install_dir) else {
        return 0;
    };
    // Keyed case-insensitively: Windows resolves paths that way, so a
    // payload path that changes only casing between versions must count
    // as kept — the old-case join would otherwise resolve to (and delete)
    // the freshly extracted file.
    let current: std::collections::HashSet<String> = current
        .iter()
        .map(|entry| entry.path.to_string_lossy().to_lowercase())
        .collect();
    let mut removed = 0usize;
    for entry in previous {
        let path = entry.path.as_path();
        if current.contains(&path.to_string_lossy().to_lowercase())
            || entry_path_is_unsafe(path)
            || is_installer_artifact(path)
        {
            continue;
        }
        if std::fs::remove_file(install_dir.join(path)).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        prune_empty_dirs_below(install_dir);
    }
    removed
}

/// Removes empty directories under `root`, deepest first — mirroring
/// shun's own uninstall pass. `remove_dir` refuses non-empty dirs, so
/// only dirs the stale pass emptied (plus pre-existing empty ones) go.
fn prune_empty_dirs_below(root: &Path) {
    fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                let path = entry.path();
                collect(&path, out);
                out.push(path);
            }
        }
    }
    let mut dirs = Vec::new();
    collect(root, &mut dirs);
    for dir in dirs {
        let _ = std::fs::remove_dir(dir);
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
        // The done page owns the launch decision (its checkbox drives the
        // launch_app command); the flow itself never launches.
        launch_after_install: false,
        machine: false,
    };
    let ctx = state.install_context(&mode, &dir, answers)?;

    let payload = state.payload.clone();
    let install_dir = ctx.install_dir.clone();
    let portable = ctx.portable;
    let flow_ctx = ctx;
    tauri::async_runtime::spawn_blocking(move || {
        // Capture what a previous install left behind before the flow
        // replaces the on-disk manifest — the stale-file pass diffs
        // against it after a successful extract.
        let previous = read_installed_manifest(&install_dir).unwrap_or_default();
        // An overwrite install must stop the running application first:
        // its locked executable would fail the extraction (os error 5).
        // The label is emitted BEFORE the blocking helper so it covers the
        // taskkill + settle window too.
        if install_dir.join("wowsp.exe").is_file() {
            emit_progress(
                &app,
                &FlowEvent::Progress {
                    phase: FlowPhase::Prepare,
                    step: "Stopping wowsp.exe".into(),
                    percent: None,
                },
            );
        }
        stop_running_app(&install_dir);
        let flow = InstallFlow {
            payload: &payload,
            registration: &WindowsRegistration,
            ctx: flow_ctx,
        };
        flow.run(&mut |event| emit_progress(&app, &event))
            .map_err(|e| e.to_string())?;
        let stale = remove_stale_payload_files(&install_dir, &previous);
        if stale > 0 {
            emit_progress(
                &app,
                &FlowEvent::Progress {
                    phase: FlowPhase::Extract,
                    step: format!("Removed {stale} stale file(s)"),
                    percent: None,
                },
            );
        }
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
/// or the pack is absent (plain `cargo build` payload).
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
    let moved = if to == from || std::fs::rename(&from, &to).is_ok() {
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
/// `--dir=<path>`, `--desktop`/`--no-desktop`, optional
/// `--shortcut-menu=<0|1>` / `--shortcut-desktop=<0|1>`, and an optional
/// `--uninstall`. `/uninstall` alone opens the uninstall UI instead;
/// only `--silent`/`/S` plus the uninstall switch lands here (the ARP
/// `UninstallString` is a bare `/uninstall`). The flow itself creates no
/// shortcuts (the manifest pins both launcher policies to "never");
/// because headless runs never see the done page, the shell applies the
/// choices itself after the flow. A fresh install applies the explicit
/// `--shortcut-*` flags, falling back to the legacy defaults (start menu
/// always, desktop following `--desktop`/`--no-desktop`, default on). An
/// update NEVER creates new shortcuts: existing `.lnk`s point at a
/// stable path and stay valid across updates, so explicit flags are
/// honored (a flip removes the `.lnk`) while absent flags only re-apply
/// launchers that already exist (a no-op refresh through
/// `apply_shortcut`). The updated application is relaunched at the end:
/// the shell killed the running build before extracting, so the update
/// puts the app back where the user left it.
fn run_headless(
    args: &[String],
    config: &ShunConfig,
    payload: &ArchivePayload,
) -> Result<(), String> {
    let mut mode = "local".to_string();
    let mut dir: Option<PathBuf> = None;
    let mut uninstall_mode = false;
    let mut desktop: Option<bool> = None;
    let mut shortcut_menu: Option<bool> = None;
    let mut shortcut_desktop: Option<bool> = None;
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
        } else if let Some(value) = arg.strip_prefix("--shortcut-menu=") {
            // "0"/"1" per the caller (the app's update command); anything
            // unparsable counts as absent.
            shortcut_menu = value.trim().parse::<u8>().ok().map(|v| v != 0);
        } else if let Some(value) = arg.strip_prefix("--shortcut-desktop=") {
            shortcut_desktop = value.trim().parse::<u8>().ok().map(|v| v != 0);
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
        // Silent installs never launch the app; the manifest knob can pin
        // `launch-after-install` for other products.
        launch_after_install: false,
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

    // Update semantics: a wowsp.exe already sitting in the install dir
    // means this silent run is an in-place update. The helper stops the
    // running application (its locked executable would fail the
    // extraction) and reports the update so the shortcut/relaunch policy
    // below can act on it.
    let updating = stop_running_app(&install_dir);
    let previous = read_installed_manifest(&install_dir).unwrap_or_default();

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
    let stale = remove_stale_payload_files(&install_dir, &previous);
    if stale > 0 {
        println!("shun: removed {stale} stale file(s) from the previous install");
    }
    cleanup_bootstrap_payload(&install_dir);
    relocate_model_pack(&install_dir, portable);
    // Shortcut policy on the silent path:
    //
    // - Update (`wowsp.exe` already sat in the install dir): **nothing to
    //   do** — every launcher points at the same executable at the same
    //   path, so an update must not touch them (explicit `--shortcut-*`
    //   flags are ignored here by design).
    // - Fresh install: the flow created nothing (manifest "never" knobs)
    //   and a silent run never sees the done page, so the shell applies
    //   the choices itself — the explicit flags when present, else the
    //   legacy defaults.
    if updating {
        println!("shun: update complete — shortcuts left untouched");
    } else {
        let aumid = shortcut_aumid_for(config);
        if let Err(e) = apply_shortcut_choices(
            &aumid,
            Some(shortcut_desktop.or(desktop).unwrap_or(true)),
            Some(shortcut_menu.unwrap_or(true)),
            &install_dir.to_string_lossy(),
            portable,
        ) {
            eprintln!("shun: shortcuts: {e}");
        }
    }
    // An update must put the app back where the user left it: the shell
    // killed the running build before extracting, so relaunch the freshly
    // installed one (detached; this installer process exits right after).
    if updating {
        let mut launch_ctx = InstallContext::new(
            config.product.name.clone(),
            config.product.version.clone(),
            install_dir.clone(),
            portable,
        );
        launch_ctx.main_exe = config.targets.iter().find_map(|t| match t {
            TargetConfig::Install(install) => install.main_exe.clone(),
            _ => None,
        });
        launch_ctx.launch_after_install = true;
        println!("shun: relaunching the updated application");
        if let Err(e) = shun::targets::install::launch(&launch_ctx) {
            eprintln!("shun: relaunch failed: {e}");
        }
    }
    Ok(())
}

fn main() {
    let config: ShunConfig =
        serde_json::from_str(SHUN_CONFIG_JSON).expect("embedded config decodes");
    let payload = ArchivePayload::from_bytes(EMBEDDED_PAYLOAD).expect("embedded payload decodes");

    let args: Vec<String> = std::env::args().skip(1).collect();
    // Headless entry points: explicit `--silent` runs, and `--silent`
    // combined with the uninstall switch. A bare `/uninstall` (the ARP
    // `UninstallString`) opens the uninstall UI below instead.
    let silent = args.iter().any(|a| a == "--silent" || a == "/S");
    let uninstalling = args.iter().any(|a| a == "--uninstall" || a == "/uninstall")
        // The ARP maintenance entries (修改/修复) that older shun
        // releases registered launch the copied uninstaller with no
        // switch — and so does double-clicking it — so a bare run of
        // that copy must land in the uninstall UI, never the install
        // wizard.
        || (args.is_empty()
            && std::env::current_exe().is_ok_and(|exe| {
                exe.file_stem()
                    .is_some_and(|stem| stem.eq_ignore_ascii_case("uninstall"))
            }));
    if silent {
        if let Err(err) = run_headless(&args, &config, &payload) {
            eprintln!("shun: {err}");
            std::process::exit(1);
        }
        return;
    }

    // Uninstall UI: prefer the Tauri window when WebView2 is present —
    // which this check just proved, so the `ensure_webview2` gate (whose
    // job is installing a missing runtime) is skipped entirely. Without
    // the runtime, run the egui fallback: the same flow in a native
    // window with no webview dependency at all.
    if uninstalling && !webview2_installed() {
        if let Err(err) = uninstall_egui::run(&config) {
            eprintln!("shun: {err}");
            std::process::exit(1);
        }
        return;
    }
    if !uninstalling {
        if let Some(dir) = exe_dir() {
            ensure_webview2(&dir, &payload);
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            config,
            payload,
            uninstall_mode: uninstalling,
        })
        .setup(move |app| {
            use tauri::Manager;

            // The uninstall page is a compact dialog — the wizard-sized
            // window from tauri.conf would dwarf it.
            if uninstalling {
                if let Some(w) = app.get_webview_window("installer") {
                    use tauri::LogicalSize;
                    let _ = w.set_size(LogicalSize::new(520.0, 400.0));
                    let _ = w.center();
                    let _ = w.set_title("WoWSP 卸载");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            default_dir,
            nest_root_dir,
            get_identity,
            get_shell_prefs,
            get_license,
            current_install_dir,
            is_uninstall_mode,
            launch_app,
            perform_uninstall,
            set_shortcuts,
            start_install
        ])
        .run(tauri::generate_context!())
        .expect("error while running WoWSP installer shell");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch dir under the temp root, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn scratch(name: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-installer-tests-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    fn entry(path: &str) -> PayloadEntry {
        PayloadEntry {
            path: PathBuf::from(path),
            size: 1,
            sha256: "0".repeat(64),
        }
    }

    fn write_manifest(dir: &Path, entries: &[PayloadEntry]) {
        std::fs::write(
            dir.join(MANIFEST_PATH),
            serde_json::to_vec(entries).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn unsafe_entry_paths_are_rejected() {
        assert!(!entry_path_is_unsafe(Path::new("wowsp.exe")));
        assert!(!entry_path_is_unsafe(Path::new("models/pack/model.bin")));
        assert!(entry_path_is_unsafe(Path::new("../escape.txt")));
        assert!(entry_path_is_unsafe(Path::new("ok/../escape.txt")));
        #[cfg(windows)]
        {
            assert!(entry_path_is_unsafe(Path::new("C:\\Windows\\evil.dll")));
            assert!(entry_path_is_unsafe(Path::new("\\rooted.dll")));
        }
    }

    #[test]
    fn stale_files_from_the_previous_payload_are_removed() {
        let guard = scratch("stale-cleanup");
        let dir = guard.path();
        // The previous install delivered a.txt, sub/old.bin and
        // shared.txt; the flow has since extracted the new payload
        // (shared.txt kept, new.txt added) and written its manifest.
        std::fs::write(dir.join("a.txt"), b"old").unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/old.bin"), b"old").unwrap();
        std::fs::write(dir.join("shared.txt"), b"same").unwrap();
        let previous = vec![entry("a.txt"), entry("sub/old.bin"), entry("shared.txt")];
        std::fs::write(dir.join("new.txt"), b"new").unwrap();
        write_manifest(dir, &[entry("shared.txt"), entry("new.txt")]);

        assert_eq!(remove_stale_payload_files(dir, &previous), 2);
        assert!(!dir.join("a.txt").exists());
        assert!(!dir.join("sub").exists(), "emptied payload dirs are pruned");
        assert!(dir.join("shared.txt").is_file());
        assert!(dir.join("new.txt").is_file());
        assert!(dir.join(MANIFEST_PATH).is_file());
    }

    #[test]
    fn partially_kept_directories_survive_the_prune() {
        let guard = scratch("partial-keep");
        let dir = guard.path();
        // Old payload: sub/a + sub/b; new payload keeps sub/b only — the
        // deletion of sub/a must not take the still-occupied dir with it.
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/a"), b"a").unwrap();
        std::fs::write(dir.join("sub/b"), b"b").unwrap();
        let previous = vec![entry("sub/a"), entry("sub/b")];
        write_manifest(dir, &[entry("sub/b")]);

        assert_eq!(remove_stale_payload_files(dir, &previous), 1);
        assert!(dir.join("sub").is_dir());
        assert!(dir.join("sub/b").is_file());
    }

    #[test]
    fn installer_artifacts_and_unsafe_paths_survive_the_cleanup() {
        let guard = scratch("artifact-guards");
        let dir = guard.path();
        // The `../evil.txt` entry is a real sibling file OUTSIDE the
        // install dir — the pass must never reach it.
        let outside = dir.parent().unwrap().join(format!(
            "wowsp-installer-tests-{}-evil.txt",
            std::process::id()
        ));
        std::fs::write(&outside, b"evil").unwrap();
        std::fs::write(dir.join(UNINSTALLER_NAME), b"u").unwrap();
        std::fs::write(dir.join(".portable"), b"").unwrap();
        std::fs::write(dir.join(MANIFEST_PATH), b"[]").unwrap();
        let previous = vec![
            entry(UNINSTALLER_NAME),
            entry(".portable"),
            entry(MANIFEST_PATH),
            entry("../evil.txt"),
        ];

        assert_eq!(remove_stale_payload_files(dir, &previous), 0);
        assert!(dir.join(UNINSTALLER_NAME).is_file());
        assert!(dir.join(".portable").is_file());
        assert!(dir.join(MANIFEST_PATH).is_file());
        assert!(
            outside.is_file(),
            "paths escaping the install dir are never touched"
        );
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn case_only_path_changes_count_as_kept() {
        let guard = scratch("case-kept");
        let dir = guard.path();
        // The payload renamed `Locales/` to `locales/` between versions:
        // on Windows the old-case join resolves to the freshly extracted
        // file, so a case-sensitive diff would delete it.
        std::fs::create_dir_all(dir.join("locales")).unwrap();
        std::fs::write(dir.join("locales/zh.json"), b"{}").unwrap();
        write_manifest(dir, &[entry("locales/zh.json")]);

        assert_eq!(
            remove_stale_payload_files(dir, &[entry("Locales/zh.json")]),
            0
        );
        assert!(dir.join("locales/zh.json").is_file());
    }

    #[test]
    fn artifact_guard_is_case_insensitive() {
        let guard = scratch("case-artifact");
        let dir = guard.path();
        std::fs::write(dir.join(MANIFEST_PATH), b"[]").unwrap();

        assert!(is_installer_artifact(Path::new("SHUN-MANIFEST.json")));
        assert!(is_installer_artifact(Path::new("Uninstall.exe")));
        assert_eq!(remove_stale_payload_files(dir, &[entry(MANIFEST_PATH)]), 0);
    }

    #[test]
    fn cleanup_is_a_noop_without_a_previous_manifest() {
        let guard = scratch("no-previous");
        let dir = guard.path();
        std::fs::write(dir.join("new.txt"), b"new").unwrap();
        write_manifest(dir, &[entry("new.txt")]);

        assert_eq!(remove_stale_payload_files(dir, &[]), 0);
        assert!(dir.join("new.txt").is_file());
    }

    #[test]
    fn unreadable_current_manifest_disables_the_pass() {
        let guard = scratch("unreadable-current");
        let dir = guard.path();
        // A previous manifest exists, but the just-written one cannot be
        // parsed back — the pass must bail out rather than delete the
        // whole previous file set against an empty "current" view.
        std::fs::write(dir.join("a.txt"), b"old").unwrap();
        std::fs::write(dir.join(MANIFEST_PATH), b"not json").unwrap();

        assert!(read_installed_manifest(dir).is_none());
        assert_eq!(
            remove_stale_payload_files(dir, &[entry("a.txt")]),
            0,
            "nothing is removed when the current manifest is unreadable"
        );
        assert!(dir.join("a.txt").is_file());
    }
}
