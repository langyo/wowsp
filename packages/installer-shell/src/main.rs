//! WoWSP custom installer shell — demo prototype (feat/installer-shell-demo).
//!
//! A small Tauri front-end that renders the three WoWSP install modes and
//! drives the real NSIS engine headlessly: `setup.exe /S /MODE=<mode> /D=<dir>`
//! (the `/MODE=` contract is implemented by this branch's installer.nsi).
//! When no NSIS artifact sits next to this exe, the flow runs in simulation
//! mode so the UX can be reviewed without a payload; portable modes still
//! write the `.portable` marker the app expects.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use serde::Serialize;
use tauri::Emitter;

/// NSIS setup artifact the shell looks for next to itself.
const SETUP_EXE: &str = "WoWSP_0.1.0_x64-setup.exe";
/// Marker file the NSIS template writes for portable (USB / green) installs.
const PORTABLE_MARKER: &str = ".portable";

#[derive(Serialize, Clone)]
struct Progress {
    percent: u8,
    step: String,
    /// Engine command line the step maps to (shown by the demo UI).
    command: Option<String>,
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

fn exe_neighbor(name: &str) -> Option<PathBuf> {
    let path = std::env::current_exe().ok()?.parent()?.join(name);
    path.is_file().then_some(path)
}

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
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
            let dir = exe_dir().join("WoWSP");
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

fn emit_progress(
    app: &tauri::AppHandle,
    percent: u8,
    step: &str,
    command: Option<String>,
) -> Result<(), String> {
    app.emit(
        "install-progress",
        Progress {
            percent,
            step: step.into(),
            command,
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_install(app: tauri::AppHandle, mode: String, dir: String) -> Result<String, String> {
    let dir = dir.trim().trim_end_matches('\\').to_string();
    if dir.is_empty() {
        return Err("安装目录不能为空".into());
    }
    let mode_flag = match mode.as_str() {
        "usb" => "usb",
        "green" => "green",
        _ => "local",
    };

    if let Some(setup) = exe_neighbor(SETUP_EXE) {
        // Real engine path. NSIS quirk: `/D=` must be the LAST argument and
        // must stay unquoted even when the path contains spaces, hence raw_arg.
        use std::os::windows::process::CommandExt;
        emit_progress(&app, 5, "启动静默安装引擎…", None)?;
        let status = std::process::Command::new(&setup)
            .arg("/S")
            .arg(format!("/MODE={mode_flag}"))
            .raw_arg(format!("/D={dir}"))
            .status()
            .map_err(|e| format!("无法启动 NSIS 引擎：{e}"))?;
        if !status.success() {
            return Err(format!("NSIS 引擎异常退出（{:?}）", status.code()));
        }
        let cmdline = format!("{} /S /MODE={mode_flag} /D={dir}", setup.display());
        emit_progress(&app, 100, "安装完成", Some(cmdline.clone()))?;
        return Ok(cmdline);
    }

    // Simulation path: no payload next to the shell. Walk the same steps the
    // engine would take so the UI flow can be reviewed end to end.
    let cmdline = format!("{SETUP_EXE} /S /MODE={mode_flag} /D={dir}");
    let steps: [(&str, u8); 4] = [
        ("校验安装清单与磁盘空间…", 20),
        ("释放应用文件…（演示模式：跳过实际文件）", 55),
        ("写入模式标记与数据目录…", 80),
        ("完成", 100),
    ];
    for (step, percent) in steps {
        std::thread::sleep(std::time::Duration::from_millis(450));
        emit_progress(&app, percent, step, None)?;
    }

    // Portable modes still produce the marker the app detects, so the demo
    // leaves behind exactly what a real run would.
    if mode_flag != "local" {
        let target = PathBuf::from(&dir);
        std::fs::create_dir_all(&target).map_err(|e| format!("无法创建目录 {dir}：{e}"))?;
        std::fs::write(target.join(PORTABLE_MARKER), b"").map_err(|e| e.to_string())?;
        std::fs::write(
            target.join("WoWSP-演示说明.txt"),
            "本目录由 WoWSP 安装器外壳示范创建（feat/installer-shell-demo）。\n真实安装会由 NSIS 引擎在 /MODE 模式下释放完整应用文件。\n",
        )
        .map_err(|e| e.to_string())?;
    }

    emit_progress(&app, 100, "完成", Some(cmdline.clone()))?;
    Ok(cmdline)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![default_dir, start_install])
        .run(tauri::generate_context!())
        .expect("error while running WoWSP installer shell");
}
