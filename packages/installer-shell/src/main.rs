//! WoWSP installer shell.
//!
//! A small Tauri front-end that renders the three WoWSP install modes and
//! drives the shun install flow directly: the payload (staged application
//! directory, packed at build time — see build.rs) is embedded in this
//! single binary, and `shun::targets::install` performs the delivery.
//! Local mode registers the ARP entry, the self-copying uninstaller, and
//! Start-menu/desktop shortcuts; USB and green modes drop the app's
//! `.portable` marker with no registration at all (config
//! `portable-marker`).
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
use shun::targets::install::{InstallContext, InstallFlow, WindowsRegistration, WizardAnswers};
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

#[derive(Serialize)]
struct Identity {
    version: String,
    flavor: String,
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

#[tauri::command]
fn start_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mode: String,
    dir: String,
    // The desktop-shortcut checkbox; absent (older front-ends) = checked.
    desktop: Option<bool>,
) -> Result<(), String> {
    let dir = dir.trim().trim_end_matches('\\').to_string();
    if dir.is_empty() {
        return Err("安装目录不能为空".into());
    }
    let answers = WizardAnswers {
        desktop_shortcut: desktop.unwrap_or(true),
        machine: false,
    };
    let ctx = state.install_context(&mode, &dir, answers)?;

    let payload = state.payload.clone();
    let install_dir = ctx.install_dir.clone();
    let portable = ctx.portable;
    let flow = InstallFlow {
        payload: &payload,
        registration: &WindowsRegistration,
        ctx,
    };
    flow.run(&mut |event| emit_progress(&app, &event))
        .map_err(|e| e.to_string())?;
    cleanup_bootstrap_payload(&install_dir);
    relocate_model_pack(&install_dir, portable);
    Ok(())
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
/// back to a recursive copy across volumes.
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
    if to == from {
        return;
    }
    if std::fs::rename(&from, &to).is_ok() {
        return;
    }
    if copy_dir_recursive(&from, &to) {
        let _ = std::fs::remove_dir_all(&from);
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
/// `/uninstall` during removal.
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
        .invoke_handler(tauri::generate_handler![default_dir, get_identity, start_install])
        .run(tauri::generate_context!())
        .expect("error while running WoWSP installer shell");
}
