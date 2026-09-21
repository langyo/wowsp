//! Opens external http(s) URLs in the system default browser.
//!
//! `ShellExecuteW` with the "open" verb is the canonical hand-off to URL
//! protocol handlers. `explorer.exe <url>` — the previous shortcut — only
//! worked by accident: explorer parses its argument as a path, so URLs
//! with query strings (the QQ group join link) open a file-manager window
//! instead of the browser. Only http(s) URLs are accepted so the command
//! can't launch arbitrary handlers.

use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::PCWSTR;

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("unsupported url: {url}"));
    }
    // Null-terminated UTF-16 buffers, kept alive across the call.
    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    let file: Vec<u16> = format!("{url}\0").encode_utf16().collect();
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW reports SE_ERR_* failure codes as values <= 32.
    let code = result.0 as isize;
    if code > 32 {
        Ok(())
    } else {
        Err(format!("open {url}: ShellExecuteW failed ({code})"))
    }
}
