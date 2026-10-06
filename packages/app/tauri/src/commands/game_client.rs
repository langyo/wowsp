//! Per-distribution-channel client compatibility, in one place.
//!
//! Every World of Warships distribution channel ships the same game under a
//! family-specific skin. The WG family — Wargaming Game Center, Steam
//! (appid 552990), both CN operators (360 / legacy KongZhong) and manual
//! pins — shares one on-disk layout: a `WorldOfWarships.exe` root stub,
//! `bin/<build>/bin64/WorldOfWarships(64).exe` game binaries, a single
//! `content/GameParams.data` VFS entry and the `.wowsreplay` container.
//! Lesta (Мир кораблей, the post-split RU client) kept that layout but
//! renamed everything it could: the stub became `Korabli.exe` (the game
//! binaries `bin/<build>/bin64/Korabli(64).exe`), the replay container
//! `.korablireplay`, and GameParams split into py2/py3 pickle variants.
//!
//! Of all those renames only the process-image names are decisive — every
//! other Lesta marker is shared with or shadowed by the WG family (the
//! RU/CIS Steam region serves Korabli binaries under the Steam appid), so
//! kind inference treats Lesta's names as a hint and leaves the WG family's
//! exe names to the caller's path-marker logic.
//!
//! This module is the single source of truth for those per-family facts.
//! Feature code asks the registry ([`CLIENTS`]) or the convenience free
//! functions instead of hardcoding names, so the next channel divergence
//! lands in one impl block instead of a fifth call site.

use wowsp_tauri_shared::GameInstallKind;

/// Overlay roster-detection profile (`overlay_detect`'s `DetectProfile`).
/// Desktop only — the whole capture stack it tunes does not exist on a
/// phone, where the alias collapses to `()` so the trait still compiles.
#[cfg(desktop)]
use crate::commands::overlay_detect::DetectProfile;
#[cfg(mobile)]
type DetectProfile = ();

/// Everything a distribution-channel family differs on, behind one trait.
/// One impl per family: [`WargamingCompat`] serves the WG family (the
/// historical default), [`LestaCompat`] the post-split Lesta client.
pub(crate) trait ClientCompat: Sync + Send {
    /// Whether this family serves install `kind`.
    fn serves(&self, kind: &GameInstallKind) -> bool;

    /// File name (exact spelling) of the root stub exe that identifies an
    /// install folder of this family.
    fn root_stub(&self) -> &'static str;

    /// Running client process-image names — lowercase, matched exactly
    /// (the ToolHelp snapshot carries no directory part).
    fn process_names(&self) -> &'static [&'static str];

    /// Replay container extension — lowercase, without the dot.
    fn replay_extension(&self) -> &'static str;

    /// GameParams VFS candidates inside `bin/<build>`, highest priority
    /// first. WG ships one file; Lesta splits it into py2/py3 pickles (both
    /// decode through the same reverse+zlib+py2 pipeline, py2 preferred,
    /// py3 the last resort).
    fn game_params_candidates(&self) -> &'static [&'static str];

    /// Install kind implied by a process-image name alone, when the name is
    /// decisive. Only Lesta's rename is (`korabli(.64).exe` → Lesta); the
    /// WG family's exe names are ambiguous (Steam and the CN clients ship
    /// the same binaries), so [`WargamingCompat`] always answers `None` and
    /// the caller falls through to its path-marker logic.
    fn process_kind_hint(&self, lower_image_name: &str) -> Option<GameInstallKind>;

    /// Overlay roster-detection profile for this family ([`DetectProfile`]).
    fn overlay_profile(&self) -> DetectProfile;
}

/// The WG-family compatibility: Wargaming Game Center, Steam and the CN
/// clients (360 / legacy KongZhong) plus manual pins — everything that kept
/// the original on-disk names after the Lesta split.
pub(crate) struct WargamingCompat;

impl ClientCompat for WargamingCompat {
    fn serves(&self, kind: &GameInstallKind) -> bool {
        matches!(
            kind,
            GameInstallKind::Wargaming
                | GameInstallKind::Steam
                | GameInstallKind::Cn360
                | GameInstallKind::CnKongzhong
                | GameInstallKind::Manual
        )
    }

    fn root_stub(&self) -> &'static str {
        "WorldOfWarships.exe"
    }

    fn process_names(&self) -> &'static [&'static str] {
        &["worldofwarships.exe", "worldofwarships64.exe"]
    }

    fn replay_extension(&self) -> &'static str {
        "wowsreplay"
    }

    fn game_params_candidates(&self) -> &'static [&'static str] {
        &["content/GameParams.data"]
    }

    fn process_kind_hint(&self, _lower_image_name: &str) -> Option<GameInstallKind> {
        // The WG family's image names are shared by Steam and the CN
        // clients — a name alone never decides the kind (see the trait
        // docs); callers continue with their path-marker logic.
        None
    }

    fn overlay_profile(&self) -> DetectProfile {
        #[cfg(desktop)]
        {
            DetectProfile::WG
        }
        #[cfg(mobile)]
        {
            ()
        }
    }
}

/// The Lesta (Мир кораблей) compatibility: the post-split RU client that
/// renamed the stub, the game binaries and the replay container, and split
/// GameParams into py2/py3 pickles.
pub(crate) struct LestaCompat;

impl ClientCompat for LestaCompat {
    fn serves(&self, kind: &GameInstallKind) -> bool {
        matches!(kind, GameInstallKind::Lesta)
    }

    fn root_stub(&self) -> &'static str {
        "Korabli.exe"
    }

    fn process_names(&self) -> &'static [&'static str] {
        &["korabli.exe", "korabli64.exe"]
    }

    fn replay_extension(&self) -> &'static str {
        "korablireplay"
    }

    fn game_params_candidates(&self) -> &'static [&'static str] {
        &["content/GameParams_py2.data", "content/GameParams_py3.data"]
    }

    fn process_kind_hint(&self, lower_image_name: &str) -> Option<GameInstallKind> {
        self.process_names()
            .contains(&lower_image_name)
            .then_some(GameInstallKind::Lesta)
    }

    fn overlay_profile(&self) -> DetectProfile {
        #[cfg(desktop)]
        {
            DetectProfile::LESTA
        }
        #[cfg(mobile)]
        {
            ()
        }
    }
}

/// The family registry — every consumer walks it in this order (WG family
/// first, so flattened candidate lists keep their historical priority).
pub(crate) static CLIENTS: &[&dyn ClientCompat] = &[&WargamingCompat, &LestaCompat];

/// The compat set serving `kind`; unknown kinds fall back to the WG family
/// (every channel other than Lesta shares its layout).
pub(crate) fn client_for_kind(kind: &GameInstallKind) -> &'static dyn ClientCompat {
    CLIENTS
        .iter()
        .copied()
        .find(|client| client.serves(kind))
        .unwrap_or(&WargamingCompat)
}

/// Every family's root stub exe, deduplicated — the install-root
/// identification set (formerly `game_detect::GAME_ROOT_STUBS`).
pub(crate) fn game_root_stubs() -> Vec<&'static str> {
    let mut stubs = Vec::with_capacity(CLIENTS.len());
    for client in CLIENTS {
        let stub = client.root_stub();
        if !stubs.contains(&stub) {
            stubs.push(stub);
        }
    }
    stubs
}

/// Whether `lower_name` (an already-lowercased process-image name) is a
/// running game client of ANY family — exact match, no substring games.
pub(crate) fn is_game_process_name(lower_name: &str) -> bool {
    CLIENTS
        .iter()
        .any(|client| client.process_names().contains(&lower_name))
}

/// Whether `ext` is a replay container extension of any family.
/// Case-insensitive: the input is lowercased before the comparison.
pub(crate) fn is_replay_extension(ext: &str) -> bool {
    let lower = ext.to_ascii_lowercase();
    CLIENTS
        .iter()
        .any(|client| client.replay_extension() == lower.as_str())
}

/// Every family's replay container extension, in registry order.
pub(crate) fn replay_extensions() -> Vec<&'static str> {
    CLIENTS
        .iter()
        .map(|client| client.replay_extension())
        .collect()
}

/// Every family's GameParams VFS candidates, WG family first — the
/// flattened order matches the historical `gameparams::CANDIDATES` priority
/// (WG's single file, then Lesta's py2, then py3).
pub(crate) fn game_params_candidates() -> Vec<&'static str> {
    CLIENTS
        .iter()
        .flat_map(|client| client.game_params_candidates().iter().copied())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Family membership: the WG compat serves every non-Lesta kind, the
    /// Lesta compat only Lesta.
    #[test]
    fn serves_partitions_the_kinds() {
        let wg = &WargamingCompat as &dyn ClientCompat;
        let lesta = &LestaCompat as &dyn ClientCompat;

        for kind in [
            GameInstallKind::Wargaming,
            GameInstallKind::Steam,
            GameInstallKind::Cn360,
            GameInstallKind::CnKongzhong,
            GameInstallKind::Manual,
        ] {
            assert!(wg.serves(&kind), "WG family must serve {kind:?}");
            assert!(!lesta.serves(&kind), "Lesta must not serve {kind:?}");
        }
        assert!(lesta.serves(&GameInstallKind::Lesta));
        assert!(!wg.serves(&GameInstallKind::Lesta));
    }

    /// `client_for_kind` maps the six kinds onto the two families.
    #[test]
    fn client_for_kind_follows_serves() {
        for kind in [
            GameInstallKind::Wargaming,
            GameInstallKind::Steam,
            GameInstallKind::Cn360,
            GameInstallKind::CnKongzhong,
            GameInstallKind::Manual,
        ] {
            let client = client_for_kind(&kind);
            assert!(client.serves(&kind));
            // Only two families exist: the one that does not serve Lesta is
            // the WG family.
            assert!(!client.serves(&GameInstallKind::Lesta));
        }
        let lesta = client_for_kind(&GameInstallKind::Lesta);
        assert!(lesta.serves(&GameInstallKind::Lesta));
        assert!(!lesta.serves(&GameInstallKind::Wargaming));
    }

    /// The stub / process-name / replay-extension facts of each family.
    #[test]
    fn per_family_names_match_the_real_clients() {
        assert_eq!(WargamingCompat.root_stub(), "WorldOfWarships.exe");
        assert_eq!(
            WargamingCompat.process_names(),
            &["worldofwarships.exe", "worldofwarships64.exe"]
        );
        assert_eq!(WargamingCompat.replay_extension(), "wowsreplay");

        assert_eq!(LestaCompat.root_stub(), "Korabli.exe");
        assert_eq!(
            LestaCompat.process_names(),
            &["korabli.exe", "korabli64.exe"]
        );
        assert_eq!(LestaCompat.replay_extension(), "korablireplay");
    }

    /// Only the Lesta rename is decisive; the WG family's exe names never
    /// decide a kind on their own.
    #[test]
    fn process_kind_hint_is_lesta_only() {
        assert_eq!(
            LestaCompat.process_kind_hint("korabli.exe"),
            Some(GameInstallKind::Lesta)
        );
        assert_eq!(
            LestaCompat.process_kind_hint("korabli64.exe"),
            Some(GameInstallKind::Lesta)
        );
        assert_eq!(LestaCompat.process_kind_hint("worldofwarships.exe"), None);
        assert_eq!(LestaCompat.process_kind_hint("korabli_launcher.exe"), None);
        assert_eq!(LestaCompat.process_kind_hint(""), None);

        for name in [
            "worldofwarships.exe",
            "worldofwarships64.exe",
            "korabli.exe",
            "korabli64.exe",
        ] {
            assert_eq!(
                WargamingCompat.process_kind_hint(name),
                None,
                "WG family exe names are ambiguous: {name}"
            );
        }
    }

    /// GameParams candidates per family, and the flattened registry order —
    /// which must stay identical to the historical `gameparams::CANDIDATES`
    /// (WG file first, then Lesta's py2, then py3).
    #[test]
    fn game_params_candidates_keep_the_historical_priority() {
        assert_eq!(
            WargamingCompat.game_params_candidates(),
            &["content/GameParams.data"]
        );
        assert_eq!(
            LestaCompat.game_params_candidates(),
            &["content/GameParams_py2.data", "content/GameParams_py3.data",]
        );
        assert_eq!(
            game_params_candidates(),
            vec![
                "content/GameParams.data",
                "content/GameParams_py2.data",
                "content/GameParams_py3.data",
            ]
        );
    }

    /// The union helpers produce the same sets the former per-module
    /// constants carried (order included).
    #[test]
    fn union_helpers_match_the_former_hardcoded_sets() {
        assert_eq!(
            game_root_stubs(),
            vec!["WorldOfWarships.exe", "Korabli.exe"]
        );
        assert_eq!(replay_extensions(), vec!["wowsreplay", "korablireplay"]);

        for name in [
            "worldofwarships.exe",
            "worldofwarships64.exe",
            "korabli.exe",
            "korabli64.exe",
        ] {
            assert!(is_game_process_name(name), "{name} should match");
        }
        for lookalike in [
            "wgc.exe",
            "lgc.exe",
            "korabli_launcher.exe",
            "worldofwarships_monitor.exe",
            "",
        ] {
            assert!(
                !is_game_process_name(lookalike),
                "{lookalike} must not match"
            );
        }

        assert!(is_replay_extension("wowsreplay"));
        assert!(is_replay_extension("korablireplay"));
        assert!(is_replay_extension("WoWsRePlay"));
        assert!(!is_replay_extension("json"));
        assert!(!is_replay_extension(""));
    }
}
