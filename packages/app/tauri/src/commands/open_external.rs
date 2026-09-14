//! Opens external http(s) URLs in the system default browser.
//!
//! `explorer.exe <url>` hands the URL to the shell's default handler —
//! no extra plugin, no console flash (explorer is a GUI process). Only
//! http(s) URLs are accepted so the command can't launch arbitrary
//! handlers.

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("unsupported url: {url}"));
    }
    std::process::Command::new("explorer.exe")
        .arg(url)
        .spawn()
        .map_err(|e| format!("open {url}: {e}"))?;
    Ok(())
}
