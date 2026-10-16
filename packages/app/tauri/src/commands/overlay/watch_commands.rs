use super::*;
// ─────────────────────────────────────────────────────────────────────────
// Cross-thread watcher commands (FIFO pipeline)
// ─────────────────────────────────────────────────────────────────────────

/// Cross-thread inputs to the Tab watcher, drained FIFO by the loop at the
/// top of every tick. Producers (the manual-locate commands on the Tauri
/// async runtime, the arena watcher thread) never touch watcher state
/// directly and never emit `overlay-status` themselves: the loop applies
/// the commands in push order and is the single state owner + status
/// emitter. That kills two live races of the old direct-emit design —
/// out-of-order state application (a manual set landing between a tick's
/// read and write) and a direct emit resurrecting a badge the loop had just
/// corrected (the loop's dedup mirror never saw those emissions).
pub(crate) enum WatchCommand {
    /// The manual-locate picker confirmed a box: arm the manual anchor for
    /// THIS battle on THIS game-window geometry.
    ManualAnchorSet {
        rect: Rect,
        game_rect: Rect,
        battle: i64,
        team_sizes: (usize, usize),
    },
    /// The user cleared the manual anchor.
    ManualAnchorCleared,
    /// A NEW battle's `tempArenaInfo.json` landed (arena mtime moved) — the
    /// current pin, if any, is void.
    BattleChanged,
}

/// FIFO command queue between the command threads and the watcher loop
/// (same static pattern as the old manual-anchor store).
pub(super) static WATCH_COMMANDS: Mutex<VecDeque<WatchCommand>> = Mutex::new(VecDeque::new());

/// Hard queue bound. Protects the targets where the (Windows-only) watcher
/// loop never runs and nothing drains the queue, and a wedged loop, from
/// unbounded growth — every command is latest-state-wins in spirit, so
/// dropping the oldest under flood loses nothing that matters.
const WATCH_COMMANDS_MAX: usize = 64;

/// Enqueue a watcher command, FIFO.
pub(crate) fn push_watch_command(cmd: WatchCommand) {
    if let Ok(mut q) = WATCH_COMMANDS.lock() {
        if q.len() >= WATCH_COMMANDS_MAX {
            q.pop_front();
        }
        q.push_back(cmd);
    }
}
