//! `wowsp-update-sentinel` — the visible face of WoWSP's auto-update
//! handoff.
//!
//! The updater (`packages/app/tauri/src/commands/update.rs`) downloads the
//! lite installer, spawns it with `--silent --dir=<install dir>` and exits
//! itself right after (the graceful exit that unpins the install directory
//! for the installer's atomic swap). The silent lane renders nothing, so
//! between the app's exit and the installer's relaunch the update is
//! invisible: on slow machines (a Defender first-run scan of the installer
//! alone can outlast a minute) the player sees "nothing happened", launches
//! the old build from a shortcut, and pins the very directory the
//! installer is swapping — the overwrite-failure loop this watcher exists
//! to break.
//!
//! The sentinel is the app's tiny companion exe shipped beside `wowsp.exe`
//! (staged by `scripts/build_installers.py` into both installer payloads).
//! At the handoff the updater copies it to the temp dir — a running exe
//! locks its file, and a file locked inside the install directory would
//! break the swap — and spawns it with the installer's pid. It parks a
//! small topmost window ("installing WoWSP v<version>…", with the one rule
//! that matters spelled out: don't launch the old version while it
//! installs), watches the installer process, and folds when it exits: exit
//! code 0 flashes "installed — launching" (the installer relaunches the new
//! build itself; `launch-after-install = "always"`), anything else leaves
//! the failure guidance on screen. Closing the window early only stops the
//! watching — the install always continues, and when the sentinel cannot
//! be staged or spawned at all (stripped by an AV, an older install
//! layout) the updater falls back to the fully silent handoff. The
//! watcher is an overlay on the update flow, never a dependency of it.
//!
//! Locale: the wizard languages cover the app's whole audience, selected
//! from the Windows UI language (the same source the shun wizard uses), so
//! the window needs no plumbing from the app.

#![windows_subsystem = "windows"]

use std::thread;

use windows::Win32::Foundation::{
    COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WAIT_OBJECT_0, WPARAM,
};
use windows::Win32::Globalization::GetUserDefaultUILanguage;
use windows::Win32::Graphics::Gdi::{
    CLIP_DEFAULT_PRECIS, CreateFontW, CreateSolidBrush, DEFAULT_CHARSET, DEFAULT_QUALITY, FW_BOLD,
    FW_NORMAL, HBRUSH, HDC, HFONT, OUT_DEFAULT_PRECIS, SetBkMode, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::SystemServices::SS_EDITCONTROL;
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    WaitForSingleObject,
};
use windows::Win32::UI::Controls::{
    ICC_PROGRESS_CLASS, INITCOMMONCONTROLSEX, InitCommonControlsEx, PBM_SETMARQUEE, PBS_MARQUEE,
};
use windows::Win32::UI::HiDpi::GetDpiForSystem;
use windows::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRect, CREATESTRUCTW, CreateWindowExW, DefWindowProcW, DestroyWindow,
    DispatchMessageW, GWLP_USERDATA, GetMessageW, GetSystemMetrics, GetWindowLongPtrW, HCURSOR,
    HICON, HMENU, IDC_ARROW, LoadCursorW, LoadIconW, MSG, PostMessageW, PostQuitMessage,
    RegisterClassW, SM_CXSCREEN, SM_CYSCREEN, SW_SHOW, SendMessageW, SetTimer, SetWindowLongPtrW,
    SetWindowTextW, ShowWindow, TranslateMessage, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP, WM_CREATE,
    WM_CTLCOLORSTATIC, WM_DESTROY, WM_NCCREATE, WM_SETFONT, WM_TIMER, WNDCLASSW, WS_CAPTION,
    WS_CHILD, WS_EX_TOPMOST, WS_SYSMENU, WS_VISIBLE,
};
use windows::core::{PCWSTR, w};

/// How long the watcher waits for the installer before giving up and
/// showing the failure guidance. A silent install (payload extract + swap +
/// ARP registration) is a few seconds on a warm disk; a Defender first-run
/// scan can add a minute or three. Half an hour covers every honest case
/// while guaranteeing the window cannot linger forever on a wedged
/// installer.
const WATCH_TIMEOUT_MS: u32 = 30 * 60 * 1000;

/// How long the "installed" state stays on screen before the window folds
/// (the installer relaunches the new build independently of this window).
const DONE_LINGER_MS: u32 = 1600;

/// Marquee animation step, in milliseconds between advances.
const MARQUEE_STEP_MS: isize = 30;

/// Longest version string accepted on the command line — the updater only
/// ever passes its strictly-validated release version; the cap is the usual
/// defensive bound for text spliced into the window.
const MAX_VERSION_LEN: usize = 64;

// ── Locale strings (the shun wizard's language set) ───────────────────────

/// Every line the window shows, in one locale.
struct Strings {
    /// Title-bar text.
    title: &'static str,
    /// Status line while the installer runs; `{version}` splices in the
    /// handed-off version.
    running_status: &'static str,
    /// Guidance line while the installer runs.
    running_hint: &'static str,
    /// Status line once the installer exited cleanly.
    done_status: &'static str,
    /// Status line when the installer failed, died or timed out.
    failed_status: &'static str,
    /// Guidance line for the failure state.
    failed_hint: &'static str,
}

static EN: Strings = Strings {
    title: "WoWSP Update",
    running_status: "Installing WoWSP v{version}…",
    running_hint: "Please don't launch the old version while it installs — the new version starts automatically when it's done.",
    done_status: "Installed — launching the new version…",
    failed_status: "The update didn't finish.",
    failed_hint: "Reopen WoWSP and update again, or download the installer from the website.",
};

static ZH_HANS: Strings = Strings {
    title: "WoWSP 更新",
    running_status: "正在安装 WoWSP v{version} 更新…",
    running_hint: "安装完成前请勿启动旧版本；完成后将自动启动新版本。",
    done_status: "安装完成，正在启动新版本…",
    failed_status: "更新未能完成。",
    failed_hint: "请重新打开 WoWSP 再次更新，或前往官网下载安装包。",
};

static ZH_HANT: Strings = Strings {
    title: "WoWSP 更新",
    running_status: "正在安裝 WoWSP v{version} 更新…",
    running_hint: "安裝完成前請勿啟動舊版本；完成後將自動啟動新版本。",
    done_status: "安裝完成，正在啟動新版本…",
    failed_status: "更新未能完成。",
    failed_hint: "請重新開啟 WoWSP 再次更新，或前往官網下載安裝包。",
};

static JA: Strings = Strings {
    title: "WoWSP アップデート",
    running_status: "WoWSP v{version} をインストールしています…",
    running_hint: "完了まで旧バージョンを起動しないでください。完了後、新バージョンが自動的に起動します。",
    done_status: "インストール完了 — 新バージョンを起動しています…",
    failed_status: "アップデートを完了できませんでした。",
    failed_hint: "WoWSP を開き直して再度更新するか、公式サイトからインストーラーをダウンロードしてください。",
};

static KO: Strings = Strings {
    title: "WoWSP 업데이트",
    running_status: "WoWSP v{version} 설치 중…",
    running_hint: "완료 전까지 이전 버전을 실행하지 마세요. 완료 후 새 버전이 자동으로 시작됩니다.",
    done_status: "설치 완료 — 새 버전을 시작하는 중…",
    failed_status: "업데이트가 완료되지 않았습니다.",
    failed_hint: "WoWSP를 다시 열어 업데이트를 재시도하거나 공식 사이트에서 설치 파일을 내려받으세요.",
};

static RU: Strings = Strings {
    title: "Обновление WoWSP",
    running_status: "Установка WoWSP v{version}…",
    running_hint: "Не запускайте старую версию до окончания установки — новая версия запустится автоматически.",
    done_status: "Установка завершена — запускаем новую версию…",
    failed_status: "Обновление не завершилось.",
    failed_hint: "Откройте WoWSP снова и повторите обновление или скачайте установщик с сайта.",
};

static FR: Strings = Strings {
    title: "Mise à jour de WoWSP",
    running_status: "Installation de WoWSP v{version}…",
    running_hint: "Ne lancez pas l'ancienne version pendant l'installation — la nouvelle démarrera automatiquement à la fin.",
    done_status: "Installation terminée — lancement de la nouvelle version…",
    failed_status: "La mise à jour n'a pas abouti.",
    failed_hint: "Rouvrez WoWSP pour réessayer, ou téléchargez l'installateur depuis le site web.",
};

static ES: Strings = Strings {
    title: "Actualización de WoWSP",
    running_status: "Instalando WoWSP v{version}…",
    running_hint: "No abras la versión antigua mientras se instala: la nueva se iniciará automáticamente al terminar.",
    done_status: "Instalación terminada: iniciando la nueva versión…",
    failed_status: "La actualización no terminó.",
    failed_hint: "Vuelve a abrir WoWSP para reintentarlo o descarga el instalador desde el sitio web.",
};

static DE: Strings = Strings {
    title: "WoWSP-Update",
    running_status: "WoWSP v{version} wird installiert…",
    running_hint: "Starten Sie die alte Version während der Installation nicht — die neue Version startet danach automatisch.",
    done_status: "Installation abgeschlossen — die neue Version wird gestartet…",
    failed_status: "Das Update wurde nicht abgeschlossen.",
    failed_hint: "Öffnen Sie WoWSP erneut und versuchen Sie es noch einmal, oder laden Sie den Installer von der Website herunter.",
};

static PT: Strings = Strings {
    title: "Atualização do WoWSP",
    running_status: "A instalar o WoWSP v{version}…",
    running_hint: "Não abra a versão antiga durante a instalação — a nova versão arranca automaticamente no fim.",
    done_status: "Instalação concluída — a iniciar a nova versão…",
    failed_status: "A atualização não terminou.",
    failed_hint: "Reabra o WoWSP para tentar novamente ou baixe o instalador do site.",
};

/// The whole table, for the completeness test.
#[cfg(test)]
fn table() -> [&'static Strings; 10] {
    [&EN, &ZH_HANS, &ZH_HANT, &JA, &KO, &RU, &FR, &ES, &DE, &PT]
}

/// Primary-language ids (every sublanguage matches, except Chinese where
/// Hans/Hant split on the sublanguage).
const LANG_ZH: u16 = 0x04;
const LANG_JA: u16 = 0x11;
const LANG_KO: u16 = 0x12;
const LANG_RU: u16 = 0x19;
const LANG_FR: u16 = 0x0C;
const LANG_ES: u16 = 0x0A;
const LANG_DE: u16 = 0x07;
const LANG_PT: u16 = 0x16;

/// Traditional-Chinese sublanguages (Taiwan, Hong Kong, Macau); every
/// other Chinese locale (PRC, Singapore, …) is Simplified.
const SUBLANG_ZH_TRADITIONAL: [u16; 3] = [0x01, 0x03, 0x05];

/// Pick the string table for a Windows language id; English for anything
/// the table doesn't cover.
fn strings_for(langid: u16) -> &'static Strings {
    let primary = langid & 0x3FF;
    match primary {
        LANG_ZH => {
            let sublang = langid >> 10;
            if SUBLANG_ZH_TRADITIONAL.contains(&sublang) {
                &ZH_HANT
            } else {
                &ZH_HANS
            }
        },
        LANG_JA => &JA,
        LANG_KO => &KO,
        LANG_RU => &RU,
        LANG_FR => &FR,
        LANG_ES => &ES,
        LANG_DE => &DE,
        LANG_PT => &PT,
        _ => &EN,
    }
}

// ── Command line ──────────────────────────────────────────────────────────

/// The parsed command line: which installer process to watch, and which
/// version to name in the window.
struct Args {
    pid: u32,
    version: String,
}

/// Parse `--pid <u32> --version <str>`; anything else is a usage error (the
/// only caller is the updater — strictness catches contract drift).
fn parse_args(args: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut pid = None;
    let mut version = None;
    let mut rest = args.peekable();
    while let Some(flag) = rest.next() {
        let value = rest
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--pid" => {
                pid = Some(
                    value
                        .parse::<u32>()
                        .map_err(|_| format!("bad pid {value:?}"))?,
                );
            },
            "--version" if value.len() <= MAX_VERSION_LEN => version = Some(value),
            "--version" => return Err(format!("version string too long: {value:?}")),
            _ => return Err(format!("unknown flag {flag:?}")),
        }
    }
    Ok(Args {
        pid: pid.ok_or("missing --pid (the installer process to watch)")?,
        version: version.unwrap_or_default(),
    })
}

/// The `{version}` splice used for the running status line.
fn splice(template: &str, version: &str) -> String {
    template.replace("{version}", version)
}

// ── Window plumbing ───────────────────────────────────────────────────────

const CLASS_NAME: PCWSTR = w!("WoWSPUpdateSentinel");
const PROGRESS_CLASS: PCWSTR = w!("PROGRESS_CLASS");
const STATIC_CLASS: PCWSTR = w!("STATIC");
const FACE: PCWSTR = w!("Segoe UI");

/// Watcher→UI messages (`lparam` carries the installer exit code where it
/// was observed; `-1` marks an unobservable process).
const WM_INSTALL_DONE: u32 = WM_APP;
const WM_INSTALL_FAILED: u32 = WM_APP + 1;

/// The fold-after-done timer id.
const TIMER_CLOSE: usize = 1;

/// Logical client size at 96 DPI; every child rect scales from it.
const CLIENT_W: i32 = 460;
const CLIENT_H: i32 = 152;

/// Dialog-gray face the window erases with (`0x00BBGGRR`).
const FACE_COLOR: u32 = 0x00F6_F6F6;

/// Everything the window needs between creation and destruction. One
/// instance per process; owned by the window via `GWLP_USERDATA`.
struct State {
    strings: &'static Strings,
    version: String,
    pid: u32,
    dpi: u32,
    instance: HINSTANCE,
    brush: HBRUSH,
    bold: HFONT,
    regular: HFONT,
    status: HWND,
    hint: HWND,
    progress: HWND,
}

/// The creation handoff slot for the boxed [`State`]: `run` stores the
/// box before `CreateWindowExW`, `WM_DESTROY` takes it back out and
/// frees it. Win32 delivers `WM_DESTROY` on creation failures that land
/// after `WM_NCCREATE`, so the error path in `run` must free only what
/// the destroy path left behind — taking (swap to null) instead of
/// touching the raw pointer makes the double-free structurally
/// impossible.
static STATE_SLOT: std::sync::atomic::AtomicPtr<State> =
    std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn set_text(hwnd: HWND, text: &str) {
    unsafe {
        let _ = SetWindowTextW(hwnd, PCWSTR::from_raw(wide(text).as_ptr()));
    }
}

unsafe fn state_of(hwnd: HWND) -> Option<&'static mut State> {
    unsafe {
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
        (ptr != 0).then(|| &mut *(ptr as *mut State))
    }
}

unsafe fn send_message(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) {
    unsafe {
        SendMessageW(hwnd, msg, Some(wparam), Some(lparam));
    }
}

extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        match msg {
            // The boxed State rides in through the create params; install
            // it before anything else can refer to it.
            WM_NCCREATE => {
                let create = &*(lparam.0 as *const CREATESTRUCTW);
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
                DefWindowProcW(hwnd, msg, wparam, lparam)
            },
            WM_CREATE => {
                let state = state_of(hwnd).expect("state installed at WM_NCCREATE");
                create_children(state, hwnd);
                let pid = state.pid;
                watch_installer(pid, hwnd);
                LRESULT(0)
            },
            WM_CTLCOLORSTATIC => {
                // Transparent static text over the window's own face.
                let _ = SetBkMode(HDC(wparam.0 as *mut _), TRANSPARENT);
                state_of(hwnd)
                    .map(|state| LRESULT(state.brush.0 as isize))
                    .unwrap_or(LRESULT(0))
            },
            WM_INSTALL_DONE => {
                if let Some(state) = state_of(hwnd) {
                    set_text(state.status, state.strings.done_status);
                    set_text(state.hint, "");
                    send_message(state.progress, PBM_SETMARQUEE, WPARAM(0), LPARAM(0));
                    SetTimer(Some(hwnd), TIMER_CLOSE, DONE_LINGER_MS, None);
                }
                LRESULT(0)
            },
            WM_INSTALL_FAILED => {
                if let Some(state) = state_of(hwnd) {
                    set_text(state.status, state.strings.failed_status);
                    set_text(state.hint, state.strings.failed_hint);
                    send_message(state.progress, PBM_SETMARQUEE, WPARAM(0), LPARAM(0));
                }
                LRESULT(0)
            },
            WM_TIMER if wparam.0 == TIMER_CLOSE => {
                let _ = DestroyWindow(hwnd);
                LRESULT(0)
            },
            WM_DESTROY => {
                if let Some(state) = state_of(hwnd) {
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                    drop(Box::from_raw(state));
                    STATE_SLOT.store(std::ptr::null_mut(), std::sync::atomic::Ordering::SeqCst);
                }
                PostQuitMessage(0);
                LRESULT(0)
            },
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

unsafe fn create_children(state: &mut State, hwnd: HWND) {
    let dpi = state.dpi;
    let instance = state.instance;
    let scale = move |units: i32| -> i32 { units * dpi as i32 / 96 };
    let make = move |class: PCWSTR,
                     extra: WINDOW_STYLE,
                     x: i32,
                     y: i32,
                     w: i32,
                     h: i32,
                     id: isize|
          -> HWND {
        unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class,
                None,
                WS_CHILD | WS_VISIBLE | extra,
                scale(x),
                scale(y),
                scale(w),
                scale(h),
                Some(hwnd),
                Some(HMENU(id as *mut _)),
                Some(instance),
                None,
            )
            .unwrap_or_default()
        }
    };

    let strings = state.strings;
    let status_text = splice(strings.running_status, &state.version);
    state.status = make(STATIC_CLASS, WINDOW_STYLE(0), 72, 26, CLIENT_W - 96, 24, 1);
    state.hint = make(
        STATIC_CLASS,
        WINDOW_STYLE(SS_EDITCONTROL.0),
        72,
        54,
        CLIENT_W - 96,
        58,
        2,
    );
    state.progress = make(
        PROGRESS_CLASS,
        WINDOW_STYLE(PBS_MARQUEE),
        72,
        120,
        CLIENT_W - 96,
        12,
        3,
    );
    unsafe {
        send_message(
            state.progress,
            PBM_SETMARQUEE,
            WPARAM(1),
            LPARAM(MARQUEE_STEP_MS),
        );
        set_text(state.status, &status_text);
        set_text(state.hint, strings.running_hint);
        // WM_SETFONT(wparam = font, lparam = redraw).
        for (control, font) in [(state.status, state.bold), (state.hint, state.regular)] {
            send_message(control, WM_SETFONT, WPARAM(font.0 as usize), LPARAM(1));
        }
    }
}

/// HWND is a raw handle, so the compiler cannot see it is merely a
/// cross-thread message-box address; this carries it into the watcher
/// thread (stored as the pointer's integer value — closure captures are
/// path-precise, so a newtype over HWND itself would leak the field).
/// The window outlives the thread: it only exits its message loop after
/// the watcher posted its verdict or the user closed it.
struct SendHwnd(usize);
unsafe impl Send for SendHwnd {}

/// Blocking watch on its own thread; reports through the window's message
/// queue so every UI mutation stays on the UI thread.
fn watch_installer(pid: u32, hwnd: HWND) {
    let hwnd = SendHwnd(hwnd.0 as usize);
    thread::spawn(move || unsafe {
        let hwnd = HWND(hwnd.0 as *mut _);
        let observed = (|| {
            let handle = OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                pid,
            )
            .ok()?;
            if WaitForSingleObject(handle, WATCH_TIMEOUT_MS).0 != WAIT_OBJECT_0.0 {
                return None;
            }
            let mut code = u32::MAX;
            GetExitCodeProcess(handle, &mut code).ok()?;
            Some(code)
        })();
        let (msg, code) = match observed {
            Some(0) => (WM_INSTALL_DONE, 0isize),
            Some(code) => (WM_INSTALL_FAILED, code as isize),
            None => (WM_INSTALL_FAILED, -1isize),
        };
        let _ = PostMessageW(Some(hwnd), msg, WPARAM(0), LPARAM(code));
    });
}

unsafe fn create_font(dpi: u32, weight: i32) -> HFONT {
    // 9 pt = 12 px at 96 DPI; the negative height selects character
    // height (the convention for UI text) and maps the point size
    // through the system DPI.
    let height = -((12 * dpi as i32) / 96);
    unsafe {
        CreateFontW(
            height,
            0,
            0,
            0,
            weight,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            DEFAULT_QUALITY,
            0,
            FACE,
        )
    }
}

/// The class/window icon — resource id 32512, the id tauri-winres stamps
/// its `set_icon` emission with (MAKEINTRESOURCEW of the id is the classic
/// cast to the wide-string parameter).
#[allow(clippy::manual_dangling_ptr)]
unsafe fn app_icon(instance: HINSTANCE) -> HICON {
    unsafe {
        LoadIconW(Some(instance), PCWSTR(32512usize as *const u16))
            .unwrap_or(HICON(std::ptr::null_mut()))
    }
}

fn run(args: Args) -> Result<(), String> {
    unsafe {
        let common = INITCOMMONCONTROLSEX {
            dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
            dwICC: ICC_PROGRESS_CLASS,
        };
        let _ = InitCommonControlsEx(&common);

        let strings = strings_for(GetUserDefaultUILanguage() as u16);
        let module = GetModuleHandleW(None).map_err(|e| format!("GetModuleHandleW: {e}"))?;
        let instance = HINSTANCE(module.0);
        let brush = CreateSolidBrush(COLORREF(FACE_COLOR));

        let class = WNDCLASSW {
            style: Default::default(),
            lpfnWndProc: Some(wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: app_icon(instance),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or(HCURSOR(std::ptr::null_mut())),
            hbrBackground: brush,
            lpszMenuName: PCWSTR::null(),
            lpszClassName: CLASS_NAME,
        };
        if RegisterClassW(&class) == 0 {
            return Err("RegisterClassW failed".to_string());
        }

        let dpi = GetDpiForSystem();
        let scale = |units: i32| -> i32 { units * dpi as i32 / 96 };
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: scale(CLIENT_W),
            bottom: scale(CLIENT_H),
        };
        AdjustWindowRect(&mut rect, WS_CAPTION | WS_SYSMENU, false)
            .map_err(|e| format!("AdjustWindowRect: {e}"))?;
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        let x = (GetSystemMetrics(SM_CXSCREEN) - width) / 2;
        let y = (GetSystemMetrics(SM_CYSCREEN) - height) / 3;

        let state = Box::into_raw(Box::new(State {
            strings,
            version: args.version,
            pid: args.pid,
            dpi,
            instance,
            brush,
            bold: create_font(dpi, FW_BOLD.0 as i32),
            regular: create_font(dpi, FW_NORMAL.0 as i32),
            status: HWND::default(),
            hint: HWND::default(),
            progress: HWND::default(),
        }));
        STATE_SLOT.store(state, std::sync::atomic::Ordering::SeqCst);
        let title = wide(strings.title);
        let created = CreateWindowExW(
            WS_EX_TOPMOST,
            CLASS_NAME,
            PCWSTR::from_raw(title.as_ptr()),
            WS_CAPTION | WS_SYSMENU,
            x,
            y,
            width,
            height,
            None,
            None,
            Some(instance),
            Some(state as *const _),
        );
        let hwnd = match created {
            Ok(hwnd) => hwnd,
            Err(e) => {
                // WM_DESTROY may already have consumed the box on a
                // failure past WM_NCCREATE (see STATE_SLOT).
                let leftover =
                    STATE_SLOT.swap(std::ptr::null_mut(), std::sync::atomic::Ordering::SeqCst);
                if !leftover.is_null() {
                    drop(Box::from_raw(leftover));
                }
                return Err(format!("CreateWindowExW: {e}"));
            },
        };
        let _ = ShowWindow(hwnd, SW_SHOW);

        // The class, brush and fonts are deliberately never released:
        // this process owns exactly one window and exits with the loop
        // below — the OS reclaims the lot.
        let mut msg = MSG::default();
        loop {
            let pulled = GetMessageW(&mut msg, None, 0, 0);
            if pulled.0 == 0 {
                return Ok(());
            }
            if pulled.0 == -1 {
                return Err("GetMessageW failed".to_string());
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn main() {
    let args = match parse_args(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(usage) => {
            eprintln!("wowsp-update-sentinel: {usage}");
            std::process::exit(2);
        },
    };
    if let Err(err) = run(args) {
        eprintln!("wowsp-update-sentinel: {err}");
        std::process::exit(1);
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_language_carries_every_string() {
        for strings in table() {
            for field in [
                strings.title,
                strings.running_status,
                strings.running_hint,
                strings.done_status,
                strings.failed_status,
                strings.failed_hint,
            ] {
                assert!(!field.trim().is_empty());
            }
            // The one status that names a version carries the splice
            // marker; the hints and titles never do.
            assert!(strings.running_status.contains("{version}"));
            assert!(!strings.title.contains("{version}"));
        }
    }

    #[test]
    fn language_ids_map_to_their_tables() {
        // Exact locale ids as Windows reports them.
        assert_eq!(strings_for(0x0804).title, ZH_HANS.title); // zh-CN
        assert_eq!(strings_for(0x1004).title, ZH_HANS.title); // zh-SG
        assert_eq!(strings_for(0x0404).title, ZH_HANT.title); // zh-TW
        assert_eq!(strings_for(0x0C04).title, ZH_HANT.title); // zh-HK
        assert_eq!(strings_for(0x1404).title, ZH_HANT.title); // zh-MO
        assert_eq!(strings_for(0x0411).title, JA.title);
        assert_eq!(strings_for(0x0412).title, KO.title);
        assert_eq!(strings_for(0x0419).title, RU.title);
        assert_eq!(strings_for(0x040C).title, FR.title);
        assert_eq!(strings_for(0x0C0A).title, ES.title); // es-ES (modern sort)
        assert_eq!(strings_for(0x0407).title, DE.title);
        assert_eq!(strings_for(0x0816).title, PT.title); // pt-PT
        assert_eq!(strings_for(0x0416).title, PT.title); // pt-BR
        assert_eq!(strings_for(0x0409).title, EN.title); // en-US
    }

    #[test]
    fn uncovered_languages_fall_back_to_english() {
        assert_eq!(strings_for(0x0439).title, EN.title); // hi-IN
        assert_eq!(strings_for(0x041E).title, EN.title); // th-TH
        assert_eq!(strings_for(0).title, EN.title); // neutral locale
    }

    fn arg_words(args: &[&str]) -> Result<Args, String> {
        parse_args(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn args_parse_pid_and_version() {
        let args = arg_words(&["--pid", "4242", "--version", "0.6.4"]).unwrap();
        assert_eq!(args.pid, 4242);
        assert_eq!(args.version, "0.6.4");
        // The version is optional (the window still names the product).
        let args = arg_words(&["--pid", "7"]).unwrap();
        assert_eq!(args.pid, 7);
        assert_eq!(args.version, "");
    }

    #[test]
    fn args_reject_the_broken_shapes() {
        assert!(arg_words(&[]).is_err(), "missing pid");
        assert!(arg_words(&["--version", "0.6.4"]).is_err(), "missing pid");
        assert!(arg_words(&["--pid", "not-a-pid"]).is_err());
        assert!(arg_words(&["--pid", "-1"]).is_err(), "pids are u32");
        assert!(arg_words(&["--pid"]).is_err(), "missing value");
        assert!(
            arg_words(&["--pid", "1", "--wat", "x"]).is_err(),
            "unknown flag"
        );
        assert!(
            arg_words(&["--pid", "1", "--version", &"0".repeat(MAX_VERSION_LEN + 1)]).is_err(),
            "over-long version"
        );
    }

    #[test]
    fn version_splices_into_the_running_status() {
        assert_eq!(
            splice(ZH_HANS.running_status, "0.6.4"),
            "正在安装 WoWSP v0.6.4 更新…"
        );
        assert_eq!(splice(EN.done_status, "0.6.4"), EN.done_status);
    }
}
