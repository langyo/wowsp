//! Shared TOML-first settings persistence — the app's config fallback layer.
//!
//! Every Rust-owned user setting (network, overlay, game-config, …) is stored
//! as a small FLAT TOML file under the appdata root. TOML is the one canonical
//! format going forward; older builds persisted the same settings as JSON, so
//! installs that upgraded carry a stale `.json` twin next to the `.toml` file.
//!
//! This module centralizes the two safety nets every settings file shares
//! (this is deliberately the ONLY place that knows about the legacy files):
//!
//! 1. **One-shot JSON → TOML migration.** [`load_raw`] prefers the TOML file
//!    and falls back to the legacy JSON twin only when the TOML file does not
//!    exist yet. The caller parses whatever it got, sanitizes it, writes the
//!    canonical TOML back, and then [`retire_legacy_json`] deletes the JSON
//!    twin — deletion happens strictly AFTER a successful TOML write, so a
//!    crash mid-migration loses nothing (worst case the migration re-runs on
//!    the next boot). A user downgrading to an older build simply re-creates
//!    the JSON file from its own defaults — no data the old build could not
//!    reconstruct is destroyed.
//!
//! 2. **Heal-on-read.** Invalid values (a typo, a value removed from a newer
//!    schema, a hand-edited file, outright garbage) NEVER error out or brick
//!    a feature: every caller parses tolerantly, substitutes the field's
//!    current-version default, and rewrites the sanitized TOML so the fix
//!    sticks instead of re-triggering on every boot. The canonical-text
//!    comparison documented on [`needs_rewrite`] keeps the steady state
//!    write-free — the file is only touched when it actually differs from
//!    what the app would write.
//!
//! Data caches (stats, encyclopedia, accounts, …) are NOT settings and stay
//! JSON on purpose: they are big, opaque to the user, and owned by the webui
//! stores; only human-editable configuration moved to TOML.

use std::path::Path;

/// Where a settings payload was found — decides how the caller parses it and
/// whether a migration write is due.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SettingsSource {
    /// The canonical TOML file.
    Toml,
    /// The legacy JSON twin (pre-TOML build) — parse as JSON, then migrate.
    LegacyJson,
    /// Neither file exists (fresh install) — defaults, no write needed.
    Missing,
}

/// Raw settings payload + where it came from.
#[derive(Debug)]
pub(crate) struct LoadedSettings {
    pub raw: Option<String>,
    pub source: SettingsSource,
}

/// Read the canonical TOML file, falling back to the legacy JSON twin only
/// when the TOML file is absent (fresh upgrade). Read errors other than
/// "not found" are treated as absent too — a locked/unreadable file must not
/// take the feature down with it; the caller's defaults apply and the next
/// successful heal-write replaces the file.
pub(crate) fn load_raw(dir: &Path, toml_file: &str, legacy_json_file: &str) -> LoadedSettings {
    match std::fs::read_to_string(dir.join(toml_file)) {
        Ok(raw) => LoadedSettings {
            raw: Some(raw),
            source: SettingsSource::Toml,
        },
        Err(_) => match std::fs::read_to_string(dir.join(legacy_json_file)) {
            Ok(raw) => LoadedSettings {
                raw: Some(raw),
                source: SettingsSource::LegacyJson,
            },
            Err(_) => LoadedSettings {
                raw: None,
                source: SettingsSource::Missing,
            },
        },
    }
}

/// Atomic write (unique `.tmp` + rename) — a settings file is never observed
/// half-written, even if the process dies mid-save. The tmp name carries a
/// nanosecond stamp so a concurrent heal-write and user save on the same
/// file cannot collide on the tmp path (one rename would then fail with a
/// spurious error while the other's content lands — always a valid
/// canonical file, but the error would be misleading).
pub(crate) fn store(dir: &Path, file: &str, content: &str) -> Result<(), String> {
    let path = dir.join(file);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {parent:?}: {e}"))?;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!("{file}.{stamp}.tmp"));
    std::fs::write(&tmp, content).map_err(|e| format!("write {tmp:?}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename {tmp:?} → {path:?}: {e}"))?;
    Ok(())
}

/// Delete the legacy JSON twin. Call only AFTER the canonical TOML has been
/// written successfully, so an interrupted migration simply re-runs. Missing
/// file is success (idempotent); other removal errors are logged and ignored
/// — a leftover JSON file is harmless, the TOML file always wins on read.
pub(crate) fn retire_legacy_json(dir: &Path, legacy_json_file: &str) {
    if let Err(e) = std::fs::remove_file(dir.join(legacy_json_file)) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!("cannot retire legacy settings file {legacy_json_file:?}: {e}");
        }
    }
}

/// Whether the on-disk state must be rewritten. True when the payload came
/// from the legacy JSON file (migration write due), when it failed to parse
/// at all (garbage — heal with defaults), or when the sanitized canonical
/// text differs from what the TOML file holds (an invalid value was corrected
/// or the file was reformatted by hand). Comparing the full canonical text —
/// not field equality — is what makes the steady state write-free: once the
/// file holds exactly what the app would serialize, this returns false and
/// the file is left untouched no matter how often settings are read.
pub(crate) fn needs_rewrite(
    source: SettingsSource,
    on_disk: Option<&str>,
    canonical: &str,
) -> bool {
    match source {
        SettingsSource::LegacyJson | SettingsSource::Missing => true,
        SettingsSource::Toml => !on_disk.is_some_and(|raw| raw == canonical),
    }
}

/// The load paths' shared write-back: rewrite the canonical TOML when the
/// disk does not hold it yet, and keep the legacy JSON twin retired.
///
/// The retire arm runs even when no rewrite was needed: once the TOML file
/// exists it RULES every later read, so a JSON twin that survived an
/// interrupted migration — or that an older build re-created and edited
/// during a downgrade — is dead weight to sweep (idempotent, never fails
/// the read). The values the old build wrote there are deliberately
/// discarded: this is the "TOML is canonical" half of the policy, the same
/// decision every one-shot migration makes.
pub(crate) fn heal(
    dir: &Path,
    toml_file: &str,
    legacy_json_file: &str,
    source: SettingsSource,
    on_disk: Option<&str>,
    canonical: &str,
) {
    if needs_rewrite(source, on_disk, canonical) && store(dir, toml_file, canonical).is_ok() {
        retire_legacy_json(dir, legacy_json_file);
        return;
    }
    if source == SettingsSource::Toml {
        retire_legacy_json(dir, legacy_json_file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// load_raw prefers TOML, falls back to the legacy JSON twin, and reports
    /// Missing when neither exists.
    #[test]
    fn load_raw_prefers_toml_over_legacy_json() {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-test-settings-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let loaded = load_raw(&dir, "x.toml", "x.json");
        assert_eq!(loaded.source, SettingsSource::Missing);
        assert!(loaded.raw.is_none());

        std::fs::write(dir.join("x.json"), "{\"a\":1}").unwrap();
        let loaded = load_raw(&dir, "x.toml", "x.json");
        assert_eq!(loaded.source, SettingsSource::LegacyJson);
        assert_eq!(loaded.raw.as_deref(), Some("{\"a\":1}"));

        std::fs::write(dir.join("x.toml"), "a = 1\n").unwrap();
        let loaded = load_raw(&dir, "x.toml", "x.json");
        assert_eq!(loaded.source, SettingsSource::Toml);
        assert_eq!(loaded.raw.as_deref(), Some("a = 1\n"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The rewrite predicate: canonical TOML on disk → no rewrite; anything
    /// else (legacy source, missing file, differing text) → rewrite.
    #[test]
    fn needs_rewrite_only_when_not_canonical() {
        let canonical = "mode = \"system\"\n";
        assert!(!needs_rewrite(
            SettingsSource::Toml,
            Some(canonical),
            canonical
        ));
        assert!(needs_rewrite(
            SettingsSource::Toml,
            Some("mode = \"maunal\"\n"),
            canonical
        ));
        assert!(needs_rewrite(SettingsSource::Toml, None, canonical));
        assert!(needs_rewrite(
            SettingsSource::LegacyJson,
            Some(canonical),
            canonical
        ));
        assert!(needs_rewrite(SettingsSource::Missing, None, canonical));
    }

    /// store() writes atomically and creates the parent directory; no tmp
    /// litter is left behind (unique-stamped tmp name).
    #[test]
    fn store_creates_parents_and_round_trips() {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-test-settings-store-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        store(&dir.join("nested"), "x.toml", "a = 1\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("nested").join("x.toml")).unwrap(),
            "a = 1\n"
        );
        let litter = std::fs::read_dir(dir.join("nested"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(litter, 0, "no tmp files remain");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// heal() sweeps a legacy JSON twin even when the TOML file is already
    /// canonical (downgrade → old build re-edited the JSON → re-upgrade:
    /// the TOML's values win, the twin goes) and retires it after a
    /// migration write.
    #[test]
    fn heal_retires_the_legacy_twin_in_both_arms() {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-test-settings-heal-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let canonical = "a = 1\n";

        // Canonical TOML + leftover JSON twin: no rewrite, twin swept.
        std::fs::write(dir.join("x.toml"), canonical).unwrap();
        std::fs::write(dir.join("x.json"), "{\"a\":1}").unwrap();
        heal(
            &dir,
            "x.toml",
            "x.json",
            SettingsSource::Toml,
            Some(canonical),
            canonical,
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("x.toml")).unwrap(),
            canonical
        );
        assert!(!dir.join("x.json").exists());

        // Legacy source: migration write, then retire.
        std::fs::remove_file(dir.join("x.toml")).unwrap();
        heal(
            &dir,
            "x.toml",
            "x.json",
            SettingsSource::LegacyJson,
            None,
            canonical,
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("x.toml")).unwrap(),
            canonical
        );
        assert!(!dir.join("x.json").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
