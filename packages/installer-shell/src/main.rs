//! WoWSP installer shell.
//!
//! A small Tauri front-end that renders the three WoWSP install modes and
//! drives the real NSIS engine headlessly: `WoWSP_*_setup*.exe /S
//! /MODE=<mode> /D=<dir>` (the `/MODE=` contract lives in
//! `installer/installer.nsi`).
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
use tauri::Emitter;
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};

/// WebView2 Evergreen runtime product GUID (same constant as installer.nsi).
const WEBVIEW2_APP_GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
/// Offline WebView2 Evergreen installer expected next to the shell.
const WEBVIEW2_PAYLOAD: &str = "MicrosoftEdgeWebView2RuntimeInstallerX64.exe";
/// Page opened when WebView2 is missing and no offline payload is available
/// (same target as the NSIS template's WEBVIEW2_BUNDLED_URL).
const RELEASES_URL: &str = "https://github.com/langyo/wowsp/releases/latest";

#[derive(Serialize, Clone)]
struct Progress {
    step: String,
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

/// First removable drive letter (A..Z), mirroring the NSIS template's
/// `${GetDrives} "FDD"` lookup.
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
/// Returns normally once installed; otherwise shows a native error, opens
/// the releases page and exits — a WebView-less shell cannot render UI.
fn ensure_webview2(exe_dir: &Path) {
    if webview2_installed() {
        return;
    }

    let payload = exe_dir.join(WEBVIEW2_PAYLOAD);
    if payload.is_file() {
        // Same invocation as the NSIS template's bundled-WebView2 variant.
        if let Ok(status) = run_waiting(&payload, &["/silent", "/install"]) {
            if status.success() && webview2_installed() {
                return;
            }
        }
    }

    show_fatal_error(
        "WoWSP 安装器",
        "本系统缺少 WoWSP 运行所必需的 Microsoft WebView2 运行时。\n\n\
         请从即将打开的发布页下载自带 WebView2 的完整安装包\n\
         （WoWSP_*_setup-webview2.exe），或先安装 WebView2 运行时后重试。",
    );
    open_url(RELEASES_URL);
    std::process::exit(1);
}

#[tauri::command]
fn default_dir(mode: String) -> DirDefaults {
    let fallback = local_appdata().join("WoWSP");
    match mode.as_str() {
        "usb" => match first_removable_drive() {
            Some(drive) => DirDefaults {
                dir: format!("{drive}:\\WoWSP"),
                removable: true,
            },
            None => DirDefaults {
                dir: fallback.to_string_lossy().into_owned(),
                removable: false,
            },
        },
        "green" => {
            let dir = exe_dir()
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
                .join("WoWSP");
            DirDefaults {
                dir: dir.to_string_lossy().into_owned(),
                removable: false,
            }
        },
        _ => DirDefaults {
            dir: fallback.to_string_lossy().into_owned(),
            removable: false,
        },
    }
}

/// Finds the NSIS setup payload next to the shell; prefers the
/// bundled-WebView2 variant so offline machines get the runtime too.
fn find_setup_exe(exe_dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(u8, PathBuf)> = None;
    for entry in std::fs::read_dir(exe_dir).ok()?.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        let score = if name.starts_with("WoWSP_") && name.ends_with("-setup-webview2.exe") {
            2
        } else if name.starts_with("WoWSP_") && name.ends_with("-setup.exe") {
            1
        } else {
            continue;
        };
        if best.as_ref().is_none_or(|(s, _)| score > *s) {
            best = Some((score, entry.path()));
        }
    }
    best.map(|(_, path)| path)
}

#[tauri::command]
fn start_install(app: tauri::AppHandle, mode: String, dir: String) -> Result<(), String> {
    let dir = dir.trim().trim_end_matches('\\').to_string();
    if dir.is_empty() {
        return Err("安装目录不能为空".into());
    }
    let mode_flag = match mode.as_str() {
        "usb" => "usb",
        "green" => "green",
        _ => "local",
    };
    let Some(exe_dir) = exe_dir() else {
        return Err("无法定位安装器目录".into());
    };
    let Some(setup) = find_setup_exe(&exe_dir) else {
        return Err(
            "未找到 WoWSP 安装引擎（WoWSP_*_setup.exe）。请将安装器与安装包放在同一目录后重试。"
                .into(),
        );
    };

    let _ = app.emit(
        "install-progress",
        Progress {
            step: "正在安装 WoWSP，这可能需要一点时间…".into(),
        },
    );

    // NSIS quirk: `/D=` must be the LAST argument and must stay unquoted
    // even when the path contains spaces, hence raw_arg.
    use std::os::windows::process::CommandExt;
    let status = std::process::Command::new(&setup)
        .arg("/S")
        .arg(format!("/MODE={mode_flag}"))
        .raw_arg(format!("/D={dir}"))
        .status()
        .map_err(|e| format!("无法启动安装引擎：{e}"))?;
    if !status.success() {
        return Err(format!("安装引擎异常退出（{:?}）", status.code()));
    }

    let _ = app.emit(
        "install-progress",
        Progress {
            step: "安装完成。".into(),
        },
    );
    Ok(())
}

fn main() {
    if let Some(dir) = exe_dir() {
        ensure_webview2(&dir);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![default_dir, start_install])
        .run(tauri::generate_context!())
        .expect("error while running WoWSP installer shell");
}
