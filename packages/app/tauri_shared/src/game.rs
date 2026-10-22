use serde::{Deserialize, Serialize};

/// How the game was found. The detection logic in `commands::game_detect`
/// scans the Windows Uninstall registry for Wargaming / Lesta / 360 publishers
/// (mirroring ApeRadar's `ConfigWindow.AutoDetectGamePath`) and additionally
/// walks Steam library folders for `appmanifest_552990.acf` — the Steam variant
/// ApeRadar does not cover.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GameInstallKind {
    /// Official Wargaming Game Center install.
    Wargaming,
    /// Steam install (appid 552990).
    Steam,
    /// Lesta Games (post-split RU region, korabli.su).
    Lesta,
    /// 360.cn joint-venture CN region (current operator).
    Cn360,
    /// Legacy KongZhong (空中网) CN client — the pre-360 operator. Installers
    /// of that generation register their own publisher string in the Windows
    /// Uninstall registry, distinct from 360's `360.cn`.
    CnKongzhong,
    /// User-pinned manual path.
    Manual,
}

/// Display mode the running client records in its `user_preferences.xml`
/// (`<device windowMode="…">`): old-style exclusive fullscreen, borderless
/// (fullscreen windowed) or plain windowed. Only the two windowed flavors
/// let WoWSP's overlay windows draw over the game — an exclusive-fullscreen
/// client owns the whole screen, so the hold-Tab overlay stays invisible
/// until the player switches modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GameDisplayMode {
    /// Exclusive fullscreen (the legacy resolution-owning mode).
    ExclusiveFullscreen,
    /// Borderless fullscreen window (fullscreen windowed).
    Borderless,
    /// Plain windowed.
    Windowed,
}

/// A detected (or manually set) World of Warships install.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInstall {
    pub kind: GameInstallKind,
    /// Absolute path containing `WorldOfWarships.exe`.
    pub path: String,
    /// Realm parsed from `<path>/profile/clientrunner.log`, when available.
    pub realm: Option<String>,
}

/// Snapshot of the currently-running World of Warships process, with the
/// install (kind/realm) it belongs to resolved by matching the process's exe
/// path against the known installs.
///
/// `is_game_running` (the legacy boolean command) derives from `running`. This
/// richer view lets the sidebar show the PID + which client (Steam / Wargaming
/// / Lesta / 360) is running, mirroring how Starward reports the active game
/// process.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameProcessInfo {
    pub running: bool,
    /// OS process id of the matched `WorldOfWarships*.exe`, when running.
    pub pid: Option<u32>,
    /// The install kind of the matched install (Steam / Wargaming / ...).
    pub kind: Option<GameInstallKind>,
    /// Realm of the matched install, when known.
    pub realm: Option<String>,
    /// Full path to the running exe, when queryable.
    pub exe_path: Option<String>,
    /// The full install record the process was matched against, when any.
    pub matched_install: Option<GameInstall>,
    /// Display mode of the running client's install, read from its
    /// `user_preferences.xml` (`<device windowMode="…">`) — exclusive
    /// fullscreen is the mode the hold-Tab overlay cannot draw over.
    /// `None` when not running, or the file/value is missing or
    /// unrecognized.
    pub display_mode: Option<GameDisplayMode>,
}

/// Plural process report for multi-instance machines: EVERY running game
/// client (one entry per OS process, so two clients — same realm different
/// accounts, different realms, or twin installs — are all visible), plus
/// the pid of the PREFERRED one (the client the single-process surfaces —
/// capture, session hub, arena fallback resolution — follow, exactly as
/// [`GameProcessInfo`](GameProcessInfo)'s singular command reports it).
/// The webui lets the user pick a different instance to watch on the live
/// page; `preferred_pid` is what the selection defaults to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameProcessReport {
    /// All running game-client processes, pid-ascending (ToolHelp snapshot
    /// order is unspecified; the sort keeps the sidebar cards stable).
    pub processes: Vec<GameProcessInfo>,
    /// Pid of the preferred instance (active-install match, else the first
    /// running one), when any process runs.
    pub preferred_pid: Option<u32>,
}

/// One remembered account profile, mirroring the webui's `accounts.json`
/// entry (the file is webui-owned; the Rust session reads it back to resolve
/// WHICH of several bound accounts is the one actually playing).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    pub account_id: i64,
    pub nickname: String,
    pub realm: String,
}

/// The player OBSERVED playing on the running client — nickname from the
/// battle roster, exact account id when the observation carries one (the
/// retired in-game plugin bridge was the only id feed; the field stays
/// optional). Cleared when the game process exits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayingAccount {
    pub realm: String,
    pub nickname: String,
    /// Exact WG account id when the observation carries one for the local
    /// player; nickname matching covers the rest.
    pub account_id: Option<i64>,
}

/// The resolved player the surfaces should DISPLAY: the actually-playing
/// account when one was identified (registered or not), else the webui's
/// active selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPlayer {
    pub account_id: Option<i64>,
    pub nickname: String,
    pub realm: String,
    /// True when matched against a bound `accounts.json` profile — an
    /// unregistered observation still displays (nickname + realm) so the
    /// user notices the alt is not bound yet.
    pub registered: bool,
    /// True while this identity comes from a live playing observation.
    pub playing: bool,
}

/// Payload of the `wowsp://session-changed` event and the
/// `get_session_state` command: the Rust-side session hub's full snapshot.
/// Both windows (main shell + tray panel) render from this one shape, which
/// is what keeps the bottom-left status and the tray panel in sync.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub process: GameProcessInfo,
    pub playing: Option<PlayingAccount>,
    /// The webui's active account selection, mirrored back for display
    /// when nothing is playing.
    pub active: Option<AccountProfile>,
    pub display: Option<SessionPlayer>,
}
