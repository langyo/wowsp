//! OS preference detection (locale + color scheme), seeded into the webview
//! before first paint. Adapted from shittim-chest's `os_prefs.rs`.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct OsPreferences {
    pub locale: String,
    pub color_scheme: String,
}

pub fn detect() -> OsPreferences {
    OsPreferences {
        locale: detect_locale().unwrap_or_else(|| "en".to_string()),
        color_scheme: detect_color_scheme().unwrap_or_else(|| "system".to_string()),
    }
}

/// Emit a JS snippet that freezes the detected prefs on `window.__WOWSP_OS_PREFS__`
/// before page scripts run, so theme/locale bootstrap can read them synchronously.
pub fn initialization_script(prefs: &OsPreferences) -> String {
    let locale = &prefs.locale;
    let scheme = &prefs.color_scheme;
    format!(
        "window.__WOWSP_OS_PREFS__ = Object.freeze({{ locale: {locale:?}, colorScheme: {scheme:?} }});"
    )
}

fn detect_locale() -> Option<String> {
    // POSIX env (also honored by Git for Windows bash).
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(val) = std::env::var(key) {
            if let Some(parsed) = parse_posix_locale(&val) {
                return Some(parsed);
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(win) = windows_locale() {
            return Some(win);
        }
    }
    None
}

fn parse_posix_locale(raw: &str) -> Option<String> {
    let head = raw.split('.').next()?;
    // zh_CN → zh-CN, en_US → en-US
    let (lang, region) = head.split_once('_')?;
    Some(format!("{lang}-{region}"))
}

#[cfg(target_os = "windows")]
fn windows_locale() -> Option<String> {
    use std::process::Command;
    let out = Command::new("reg")
        .args([
            "query",
            r"HKCU\Control Panel\International",
            "/v",
            "LocaleName",
        ])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout.lines().rfind(|l| l.contains("LocaleName"))?;
    let val = line.split_whitespace().last()?;
    Some(val.to_string())
}

fn detect_color_scheme() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(scheme) = windows_color_scheme() {
            return Some(scheme);
        }
    }
    Some("system".to_string())
}

#[cfg(target_os = "windows")]
fn windows_color_scheme() -> Option<String> {
    use std::process::Command;
    let out = Command::new("reg")
        .args([
            "query",
            r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "/v",
            "AppsUseLightTheme",
        ])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout.lines().rfind(|l| l.contains("AppsUseLightTheme"))?;
    let val = line.split_whitespace().last()?;
    // DWORD 0x1 = light, 0x0 = dark
    match val {
        "0x1" => Some("light".to_string()),
        "0x0" => Some("dark".to_string()),
        _ => None,
    }
}
