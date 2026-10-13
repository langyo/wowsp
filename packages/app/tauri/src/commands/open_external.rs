//! Opens external http(s) URLs in the system default browser.
//!
//! Hand-off used to be a bare `ShellExecuteW` ("open" verb) — the canonical
//! Windows way — but that API does not exist off the desktop, so the call now
//! rides tauri-plugin-opener (mobile-supported, same default-handler
//! semantics on Windows). `explorer.exe <url>` — an even older shortcut —
//! only worked by accident: explorer parses its argument as a path, so URLs
//! with query strings open a file-manager window instead of the browser.
//! Only http(s) URLs are accepted so the command can't launch arbitrary
//! handlers.

use anyhow::anyhow;

use wowsp_tauri_shared::CommandResult;

#[tauri::command]
pub fn open_external(app: tauri::AppHandle, url: String) -> CommandResult<()> {
    use tauri_plugin_opener::OpenerExt;

    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(anyhow!("unsupported url: {url}").into());
    }
    Ok(app
        .opener()
        .open_url(url.to_string(), None::<&str>)
        .map_err(|e| anyhow!("open {url}: {e}"))?)
}
