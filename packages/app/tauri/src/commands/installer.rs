//! Installer-handoff bridge: surfaces what the WoWSP installer shell
//! recorded about this install so the app can adopt it on first launch.
//!
//! The app executable sits INSIDE the install dir, and since shun 0.4.1
//! the install flow writes an on-disk manifest (`shun-manifest.json`)
//! next to the payload carrying the wizard language the install ran
//! under (`zh-Hans` / `zh-Hant` / `en` / `ru`). The webui consults this
//! once on first startup — before the user has picked a UI locale of
//! their own — to start in the language the user chose in the wizard.
//! Every failure mode (missing manifest, legacy bare-array manifest from
//! a pre-0.4.1 install, unparsable JSON) degrades to `None`; the app then
//! falls back to its system-locale detection.

use std::path::Path;

use crate::paths;

/// The wizard language the installer ran under, read from the install
/// manifest beside this executable. `None` when unavailable.
#[tauri::command]
pub fn installer_language() -> Option<String> {
    let dir = paths::exe_dir()?;
    manifest_language(&dir)
}

/// Reads the install manifest in `install_dir` and returns the wizard
/// language it recorded. Legacy manifests (a bare payload-entry array)
/// parse into a manifest without metadata, so they yield `None` here.
fn manifest_language(install_dir: &Path) -> Option<String> {
    shun::targets::install::read_manifest(install_dir)
        .ok()
        .and_then(|m| m.language)
        .filter(|l| !l.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    /// A scratch dir under the temp root, removed on drop.
    struct Scratch(PathBuf);

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn scratch(name: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-app-installer-tests-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    #[test]
    fn missing_manifest_yields_none() {
        let guard = scratch("no-manifest");
        assert!(manifest_language(guard.0.as_path()).is_none());
    }

    #[test]
    fn corrupt_manifest_yields_none() {
        let guard = scratch("corrupt-manifest");
        std::fs::write(guard.0.join("shun-manifest.json"), "{ not json").unwrap();
        assert!(manifest_language(guard.0.as_path()).is_none());
    }

    #[test]
    fn legacy_bare_array_manifest_has_no_language() {
        let guard = scratch("legacy-manifest");
        // Pre-0.4.1 installs delivered a bare payload-entry list.
        std::fs::write(guard.0.join("shun-manifest.json"), "[]").unwrap();
        assert!(manifest_language(guard.0.as_path()).is_none());
    }

    #[test]
    fn wrapper_manifest_language_is_read_back() {
        let guard = scratch("wrapper-manifest");
        std::fs::write(
            guard.0.join("shun-manifest.json"),
            r#"{"language":"zh-Hant","entries":[]}"#,
        )
        .unwrap();
        assert_eq!(
            manifest_language(guard.0.as_path()),
            Some("zh-Hant".to_string())
        );
    }

    #[test]
    fn wrapper_manifest_without_language_yields_none() {
        let guard = scratch("wrapper-no-language");
        // `language` is serde-defaulted: a manifest written without one
        // (headless run of a pre-language shell) must not invent a value.
        std::fs::write(guard.0.join("shun-manifest.json"), r#"{"entries":[]}"#).unwrap();
        assert!(manifest_language(guard.0.as_path()).is_none());
    }
}
