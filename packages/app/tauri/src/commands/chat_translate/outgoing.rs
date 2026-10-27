//! Outgoing translated-chat autofill (M3 send, WA): when the player's OWN
//! battle-chat line is decoded by the live source, translate it into the
//! languages present in that battle, compose the sent-back messages, put the
//! FIRST message on the clipboard and show a paste hint in the chat overlay.
//!
//! Flow:
//!
//! 1. begin is called by the flow pipeline for a selfLine row while
//!    send.mode == "clipboard" and the feature is enabled + consented. It
//!    resolves the target set (outgoing_targets) from the battle's observed
//!    languages plus the settings' always-list, minus the player's own
//!    language and the exclude-list, then enters Translating.
//! 2. An async task runs the engine (translate into every target at once),
//!    composes the messages (compose::compose_outgoing, per-segment suffix,
//!    the configured split width) and hands them to the hint state machine.
//! 3. Ready writes the current message to the clipboard (standard text write
//!    ONLY — no clipboard-history exclusion formats, so Win+V keeps the
//!    entry), verifies it by reading back once, records the Win32 clipboard
//!    sequence our write produced (clipboard_seq) and emits
//!    wowsp://chat-hint so the overlay card shows the preview + paste hint.
//! 4. The overlay watcher owns paste detection (see overlay/paste.rs): a
//!    recognized Ctrl+V calls notify_pasted (next message gets prepared, or
//!    the hint dismisses), a third-party clipboard overwrite calls
//!    notify_third_party. A timeout (HintEvent::Timeout) and a battle change
//!    (notify_battle_changed) also dismiss.
//!
//! The state machine (advance) is PURE and unit-tested over its full
//! transition matrix; the runtime around it keeps one global state behind a
//! std::sync::Mutex (the overlay watcher polls hint_active every ~30 ms).
//! Chat text is never logged and never crosses the wire except as the hint
//! preview; clipboard failures surface as a short user-facing hint message.
//!
//! Only the system clipboard is touched (read/write), never the game and
//! never an exclusion format. The pipeline is inert unless the flow triggers
//! it for a self line.

use anyhow::{Result, anyhow, bail};

use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};

use wowsp_tauri_shared::{ChatHintEvent, ChatLine, ChatTranslateConfig};

use super::compose::{self, ComposeOptions, SuffixFormat};
use super::context::{self, RecentLine};
use super::lang;
use super::live::SharedLiveState;

/// Tauri event carrying the outgoing hint card's state (the chat overlay page
/// renders it below the reading panel).
pub(crate) const CHAT_HINT_EVENT: &str = "wowsp://chat-hint";

/// Language family order the composed segments follow (kept in sync with
/// compose.rs's PRIORITY_LANGS; compose owns the actual rendering order — this
/// copy only decides which targets survive the maxTargets truncation).
const PRIORITY_LANGS: [&str; 5] = ["zh-TW", "ja", "ko", "ru", "en"];

// ── clipboard seam ──────────────────────────────────────────────────────────

/// The clipboard operations the outgoing path needs. Production uses the
/// system clipboard through arboard (ArboardWriter); tests inject a mock so
/// the write/verify/failure matrix runs with zero window-station access.
pub(crate) trait ClipboardWriter: Send + Sync {
    fn write_text(&self, text: &str) -> Result<()>;
    fn read_text(&self) -> Result<String>;
}

/// The system clipboard: one short-lived arboard handle per operation (a
/// cached handle would pin the clipboard while the game runs).
pub(crate) struct ArboardWriter;

impl ClipboardWriter for ArboardWriter {
    fn write_text(&self, text: &str) -> Result<()> {
        #[cfg(desktop)]
        {
            let mut clipboard =
                arboard::Clipboard::new().map_err(|error| anyhow!("open failed — {error}"))?;
            // Standard text write only: NO clipboard-history exclusion format
            // is set, so the entry lands in Win+V history like a normal copy.
            clipboard
                .set_text(text)
                .map_err(|error| anyhow!("write failed — {error}"))
        }
        #[cfg(not(desktop))]
        {
            let _ = text;
            bail!("clipboard is not supported on mobile")
        }
    }

    fn read_text(&self) -> Result<String> {
        #[cfg(desktop)]
        {
            let mut clipboard =
                arboard::Clipboard::new().map_err(|error| anyhow!("open failed — {error}"))?;
            clipboard
                .get_text()
                .map_err(|error| anyhow!("readback failed — {error}"))
        }
        #[cfg(not(desktop))]
        {
            bail!("clipboard is not supported on mobile")
        }
    }
}

/// Write one prepared message and verify it by reading the clipboard back
/// once (the paste hint must never tell the player to paste a stale or
/// missing entry). A mismatch means another app owns the clipboard.
pub(crate) fn write_verified(writer: &dyn ClipboardWriter, text: &str) -> Result<()> {
    writer.write_text(text)?;
    match writer.read_text() {
        Ok(readback) if readback == text => Ok(()),
        Ok(_) => bail!("was taken by another app — copy again"),
        Err(error) => Err(error),
    }
}

/// The clipboard sequence number our last successful write produced (Win32
/// GetClipboardSequenceNumber, consumed by the overlay paste monitor to tell
/// our own write apart from a third-party overwrite). None while the hint has
/// not written anything yet (and on non-Windows targets).
static CLIPBOARD_SEQ: Mutex<Option<u32>> = Mutex::new(None);

/// True while OUR clipboard write is between its physical landing and the
/// sequence bookkeeping (the paste monitor suppresses third-party detection
/// for those ticks — the sequence change it would see is our own write).
static CLIPBOARD_WRITING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) fn clipboard_seq() -> Option<u32> {
    *CLIPBOARD_SEQ
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Whether our own clipboard write is currently in flight/settling (polled
/// by the overlay watcher's paste monitor).
pub(crate) fn clipboard_writing() -> bool {
    CLIPBOARD_WRITING.load(std::sync::atomic::Ordering::Relaxed)
}

fn set_clipboard_seq(value: Option<u32>) {
    let mut slot = CLIPBOARD_SEQ
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *slot = value;
}

/// The OS clipboard sequence right now (Windows only; other platforms answer
/// None — the paste monitor is inert there anyway).
#[cfg(target_os = "windows")]
fn current_clipboard_seq() -> Option<u32> {
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;

    let seq = unsafe { GetClipboardSequenceNumber() };
    (seq != 0).then_some(seq)
}

#[cfg(not(target_os = "windows"))]
fn current_clipboard_seq() -> Option<u32> {
    None
}

// ── armed-hint watch (polled by the overlay watcher) ────────────────────────

/// The two facts the overlay watcher needs about the current hint: whether a
/// prepared translation is waiting to be pasted, and when the hint expires.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct HintWatch {
    /// A ready message is armed (the chat overlay must show the hint card).
    pub active: bool,
    /// Unix milliseconds the hint expires at (0 while inactive).
    pub deadline_ms: u64,
}

static HINT: Mutex<HintWatch> = Mutex::new(HintWatch {
    active: false,
    deadline_ms: 0,
});

fn lock_hint() -> std::sync::MutexGuard<'static, HintWatch> {
    HINT.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn set_hint_watch(active: bool, deadline_ms: u64) {
    let mut watch = lock_hint();
    watch.active = active;
    watch.deadline_ms = deadline_ms;
}

/// Whether the outgoing hint is armed right now — the overlay watcher's poll
/// (see overlay/watch.rs): the chat window stays up while this is true.
pub(crate) fn hint_active(now_ms: u64) -> bool {
    let watch = lock_hint();
    watch.active && now_ms < watch.deadline_ms
}

// ── hint state machine (pure) ───────────────────────────────────────────────

/// The outgoing hint's state. Ready carries the composed messages and the
/// index of the one currently ON the clipboard (the invariant is
/// index < messages.len() while Ready).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) enum HintState {
    /// Nothing to show (also the reset state).
    #[default]
    Idle,
    /// A translation request for the player's own line is in flight.
    Translating { battle: String },
    /// Messages composed; messages[index] is on the clipboard.
    Ready {
        battle: String,
        messages: Vec<String>,
        index: usize,
    },
    /// The hint was dismissed (pasted, overwritten, failed or timed out).
    Dismissed,
}

/// One input to the hint state machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HintEvent {
    /// The player posted an own line; a translation request started.
    OwnLine { battle: String },
    /// The request produced the composed messages (empty = untranslatable).
    TranslationDone(Vec<String>),
    /// The request failed (user-facing reason kept for the error card).
    TranslationFailed(String),
    /// Ctrl+V was recognized while the hint was armed.
    Pasted,
    /// Another app overwrote the clipboard while the hint was armed.
    ThirdPartyClipboard,
    /// The hint's deadline passed.
    Timeout,
    /// The live source moved to another battle (or the battle ended).
    BattleChanged,
}

/// One side effect the runtime must perform after a transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HintAction {
    /// Write messages[index] to the clipboard and show it as the preview.
    CopyNext(usize),
}

/// The pure transition function: next state + the side effects to run.
///
/// now_ms / hint_timeout_ms are part of the contract's shape; the deadline
/// itself lives in the runtime/watch (it is refreshed on every CopyNext
/// success), so the transition table does not need the clock.
pub(crate) fn advance(
    state: &HintState,
    event: HintEvent,
    _now_ms: u64,
    _hint_timeout_ms: u64,
) -> (HintState, Vec<HintAction>) {
    match event {
        // A new own line always restarts the hint, whatever it was showing.
        HintEvent::OwnLine { battle } => (HintState::Translating { battle }, Vec::new()),
        // The battle moved on: nothing of the old one may survive.
        HintEvent::BattleChanged => (HintState::Idle, Vec::new()),
        HintEvent::TranslationDone(messages) => match state {
            HintState::Translating { battle } => {
                if messages.is_empty() {
                    (HintState::Dismissed, Vec::new())
                } else {
                    (
                        HintState::Ready {
                            battle: battle.clone(),
                            messages,
                            index: 0,
                        },
                        vec![HintAction::CopyNext(0)],
                    )
                }
            },
            other => (other.clone(), Vec::new()),
        },
        HintEvent::TranslationFailed(_) => match state {
            HintState::Translating { .. } => (HintState::Dismissed, Vec::new()),
            other => (other.clone(), Vec::new()),
        },
        HintEvent::Pasted => match state {
            // Defensive: an out-of-range index must never leave a stuck hint.
            HintState::Ready {
                messages, index, ..
            } if *index >= messages.len() => (HintState::Dismissed, Vec::new()),
            HintState::Ready {
                battle,
                messages,
                index,
            } if *index < messages.len() => {
                let next_index = index + 1;
                if next_index < messages.len() {
                    (
                        HintState::Ready {
                            battle: battle.clone(),
                            messages: messages.clone(),
                            index: next_index,
                        },
                        vec![HintAction::CopyNext(next_index)],
                    )
                } else {
                    (HintState::Dismissed, Vec::new())
                }
            },
            _ => (state.clone(), Vec::new()),
        },
        HintEvent::ThirdPartyClipboard | HintEvent::Timeout => match state {
            HintState::Idle | HintState::Dismissed => (state.clone(), Vec::new()),
            _ => (HintState::Dismissed, Vec::new()),
        },
    }
}

// ── target-language selection ───────────────────────────────────────────────

/// Order key for the resolved targets: the fixed family first (compose's
/// order), then every other tag alphabetically.
fn language_rank(lang: &str) -> (usize, &str) {
    match PRIORITY_LANGS.iter().position(|known| *known == lang) {
        Some(rank) => (rank, ""),
        None => (PRIORITY_LANGS.len(), lang),
    }
}

/// Resolve the outgoing target list: (observed ∪ always) − {own} − exclude,
/// canonical tags only, ordered by compose's segment priority and truncated
/// to the settings' maxTargets. An empty result means "nothing to send".
pub(crate) fn outgoing_targets(
    config: &ChatTranslateConfig,
    observed: &[&str],
    own: &str,
) -> Vec<String> {
    let own = lang::normalize_lang(own).unwrap_or(own);
    let excluded: Vec<&'static str> = config
        .languages
        .exclude
        .iter()
        .filter_map(|tag| lang::normalize_lang(tag))
        .collect();
    let mut targets: Vec<&'static str> = Vec::new();
    let mut consider = |raw: &str| {
        let Some(tag) = lang::normalize_lang(raw) else {
            return;
        };
        if tag == own || excluded.contains(&tag) || targets.contains(&tag) {
            return;
        }
        targets.push(tag);
    };
    for tag in observed {
        consider(tag);
    }
    for tag in &config.languages.always {
        consider(tag);
    }
    targets.sort_by(|a, b| language_rank(a).cmp(&language_rank(b)));
    let cap = usize::try_from(config.languages.max_targets.clamp(1, 6)).unwrap_or(4);
    targets.truncate(cap);
    targets.into_iter().map(str::to_string).collect()
}

// ── runtime: state + clock + app handle + hint watch ────────────────────────

struct OutgoingRuntime {
    state: HintState,
    battle: String,
    config: ChatTranslateConfig,
    app: Option<AppHandle>,
    /// Unix milliseconds the current ready hint expires at.
    deadline_ms: u64,
    /// Bumped on every state transition; async side effects (clipboard write
    /// results, timeout timers) compare it and drop stale completions.
    generation: u64,
}

static RUNTIME: LazyLock<Mutex<OutgoingRuntime>> = LazyLock::new(|| {
    Mutex::new(OutgoingRuntime {
        state: HintState::Idle,
        battle: String::new(),
        config: ChatTranslateConfig::default(),
        app: None,
        deadline_ms: 0,
        generation: 0,
    })
});

fn lock_runtime() -> std::sync::MutexGuard<'static, OutgoingRuntime> {
    RUNTIME
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn hint_timeout_ms(config: &ChatTranslateConfig) -> u64 {
    let seconds = config.send.hint_timeout_s.clamp(5, 600);
    u64::try_from(seconds).unwrap_or(60).saturating_mul(1000)
}

/// Compose knobs from the stored send settings (the engine's compose kernel
/// owns the rendering rules; this only maps the stored enum strings).
fn compose_options(config: &ChatTranslateConfig) -> ComposeOptions {
    ComposeOptions {
        suffix_enabled: config.send.suffix_enabled,
        suffix_format: if config.send.suffix_format == "unified" {
            SuffixFormat::Unified
        } else {
            SuffixFormat::PerSegment
        },
        split_chars: usize::try_from(config.send.split_chars)
            .unwrap_or(120)
            .clamp(1, 400),
    }
}

/// Pure trigger gate for begin: the own line must be worth a round trip.
fn should_start(config: &ChatTranslateConfig, line: &ChatLine) -> bool {
    config.enabled
        && config.consent_version >= 1
        && config.send.mode == "clipboard"
        && line.self_line
        && !line.text.trim().is_empty()
        && !lang::looks_like_own_echo(line.text.trim())
}

// ── hint payloads ──────────────────────────────────────────────────────────

fn dismissed_payload(battle: &str) -> ChatHintEvent {
    ChatHintEvent {
        battle: battle.to_string(),
        state: "dismissed".to_string(),
        ..ChatHintEvent::default()
    }
}

fn error_payload(battle: &str, message: &str) -> ChatHintEvent {
    ChatHintEvent {
        battle: battle.to_string(),
        state: "error".to_string(),
        message: Some(message.to_string()),
        ..ChatHintEvent::default()
    }
}

fn hint_payload(state: &HintState, battle: &str) -> ChatHintEvent {
    match state {
        HintState::Translating { .. } => ChatHintEvent {
            battle: battle.to_string(),
            state: "translating".to_string(),
            ..ChatHintEvent::default()
        },
        HintState::Ready {
            messages, index, ..
        } => {
            let total = i32::try_from(messages.len()).unwrap_or(i32::MAX);
            let remaining =
                i32::try_from(messages.len().saturating_sub(index + 1)).unwrap_or(i32::MAX);
            ChatHintEvent {
                battle: battle.to_string(),
                state: "ready".to_string(),
                preview: messages.get(*index).cloned(),
                remaining: Some(remaining),
                total: Some(total),
                message: None,
            }
        },
        HintState::Idle | HintState::Dismissed => dismissed_payload(battle),
    }
}

fn emit_hint(app: &AppHandle, event: ChatHintEvent) {
    if let Err(error) = app.emit(CHAT_HINT_EVENT, &event) {
        tracing::warn!(error = %error, "emit chat-hint failed");
    }
}

// ── runtime side effects ───────────────────────────────────────────────────

/// Run one state-machine event: transition, update the watch/sequence, emit
/// the matching hint event and kick off the clipboard writes.
fn apply_event(app: &AppHandle, event: HintEvent) {
    let failure_message = match &event {
        HintEvent::TranslationFailed(message) => Some(message.clone()),
        _ => None,
    };
    let (next, actions, battle, generation, entering_ready) = {
        let mut runtime = lock_runtime();
        let (next, actions) = advance(
            &runtime.state,
            event,
            now_ms(),
            hint_timeout_ms(&runtime.config),
        );
        runtime.state = next.clone();
        runtime.generation = runtime.generation.saturating_add(1);
        runtime.deadline_ms = 0;
        let entering_ready = matches!(next, HintState::Ready { .. });
        let generation = runtime.generation;
        let battle = runtime.battle.clone();
        (next, actions, battle, generation, entering_ready)
    };

    if !entering_ready {
        set_hint_watch(false, 0);
        // A hint reset clears our clipboard-sequence marker (the paste monitor
        // must not treat the next clipboard change as our own write).
        set_clipboard_seq(None);
    }

    match &next {
        HintState::Translating { .. } => emit_hint(app, hint_payload(&next, &battle)),
        HintState::Ready { .. } => {
            if actions.is_empty() {
                emit_hint(app, hint_payload(&next, &battle));
            }
        },
        HintState::Dismissed => match &failure_message {
            Some(message) => emit_hint(app, error_payload(&battle, message)),
            None => emit_hint(app, hint_payload(&next, &battle)),
        },
        HintState::Idle => emit_hint(app, hint_payload(&next, &battle)),
    }

    for HintAction::CopyNext(index) in actions {
        spawn_copy(app.clone(), generation, index);
    }
}

/// Apply an engine answer only if it still belongs to the CURRENT hint
/// generation (own-line restarts and dismissals bump it, so a slow request can
/// never clobber a newer hint).
fn apply_event_if_current(app: &AppHandle, generation: u64, event: HintEvent) {
    let current = { lock_runtime().generation };
    if current == generation {
        apply_event(app, event);
    }
}

/// Write messages[index] to the clipboard off the async executor (arboard can
/// block briefly while another app owns the clipboard) and settle the result.
fn spawn_copy(app: AppHandle, generation: u64, index: usize) {
    let (payload, write_message, timeout_ms) = {
        let runtime = lock_runtime();
        if runtime.generation != generation {
            return;
        }
        let HintState::Ready {
            messages,
            index: current,
            ..
        } = &runtime.state
        else {
            return;
        };
        if *current != index {
            return;
        }
        let Some(message) = messages.get(index).cloned() else {
            return;
        };
        let remaining = i32::try_from(messages.len().saturating_sub(index + 1)).unwrap_or(i32::MAX);
        let total = i32::try_from(messages.len()).unwrap_or(i32::MAX);
        let payload = ChatHintEvent {
            battle: runtime.battle.clone(),
            state: "ready".to_string(),
            preview: Some(message.clone()),
            remaining: Some(remaining),
            total: Some(total),
            message: None,
        };
        let timeout_ms = hint_timeout_ms(&runtime.config);
        (payload, message, timeout_ms)
    };
    tauri::async_runtime::spawn(async move {
        // The write AND its sequence capture share one blocking closure: the
        // readback below does not touch the sequence number, so sampling it
        // here (immediately after the write lands) closes the race where the
        // watcher's 30 ms tick could observe the new sequence with the OLD
        // stored one and misread our own copy as a third-party overwrite.
        // CLIPBOARD_WRITING covers the residual window (write landed, seq
        // bookkeeping not yet stored): the paste monitor suppresses the
        // third-party check for those ticks instead of racing them.
        CLIPBOARD_WRITING.store(true, std::sync::atomic::Ordering::Relaxed);
        let result = tokio::task::spawn_blocking(move || {
            write_verified(&ArboardWriter, &write_message).map(|()| current_clipboard_seq())
        })
        .await;
        // Bookkeeping BEFORE opening the window: the sequence marker must
        // already carry the new value when the writing flag drops, or a tick
        // landing between the two would read writing=false + the OLD marker
        // + the NEW OS sequence and misread our own write as a third-party
        // overwrite (exactly the race the flag exists to close).
        if let Ok(Ok(seq)) = result {
            set_clipboard_seq(seq);
        }
        CLIPBOARD_WRITING.store(false, std::sync::atomic::Ordering::Relaxed);
        match result {
            Ok(Ok(_)) => {
                on_copy_ok(&app, generation, index, payload, timeout_ms);
            },
            Ok(Err(error)) => {
                on_copy_failed(&app, generation, format!("clipboard {error}"));
            },
            Err(_) => on_copy_failed(&app, generation, "clipboard task failed".to_string()),
        }
    });
}

/// A clipboard write succeeded: arm the watch deadline, show the preview and
/// schedule the timeout.
fn on_copy_ok(
    app: &AppHandle,
    generation: u64,
    index: usize,
    payload: ChatHintEvent,
    timeout_ms: u64,
) {
    let deadline = {
        let mut runtime = lock_runtime();
        if runtime.generation != generation {
            return;
        }
        match &runtime.state {
            HintState::Ready {
                index: current_index,
                ..
            } if *current_index == index => {},
            _ => return,
        }
        let deadline = now_ms().saturating_add(timeout_ms);
        runtime.deadline_ms = deadline;
        deadline
    };
    set_hint_watch(true, deadline);
    emit_hint(app, payload);
    spawn_timeout(app.clone(), generation, deadline);
}

/// A clipboard write failed: show the error card and dismiss the hint.
fn on_copy_failed(app: &AppHandle, generation: u64, message: String) {
    let battle = {
        let mut runtime = lock_runtime();
        if runtime.generation != generation {
            return;
        }
        runtime.state = HintState::Dismissed;
        runtime.generation = runtime.generation.saturating_add(1);
        runtime.deadline_ms = 0;
        runtime.battle.clone()
    };
    set_hint_watch(false, 0);
    set_clipboard_seq(None);
    emit_hint(app, error_payload(&battle, &message));
}

/// Dismiss the hint when its deadline passes (only if the state/deadline are
/// still the ones this timer was armed for).
fn spawn_timeout(app: AppHandle, generation: u64, deadline: u64) {
    tauri::async_runtime::spawn(async move {
        let now = now_ms();
        if deadline > now {
            tokio::time::sleep(Duration::from_millis(deadline - now)).await;
        }
        let fire = {
            let runtime = lock_runtime();
            runtime.generation == generation
                && runtime.deadline_ms == deadline
                && matches!(runtime.state, HintState::Ready { .. })
        };
        if fire {
            apply_event(&app, HintEvent::Timeout);
        }
    });
}

// ── public entry points ────────────────────────────────────────────────────

/// Start the outgoing autofill for one decoded own line. Called by the flow
/// pipeline's per-line entry point; returns false when the trigger gate or the
/// target set is empty (nothing was shown, no request ran).
pub(crate) fn begin(
    app: AppHandle,
    state: SharedLiveState,
    config: ChatTranslateConfig,
    line: ChatLine,
) -> bool {
    if !should_start(&config, &line) {
        return false;
    }
    let own = context::resolve_self_lang(&config);
    let (battle, recent, observed) = {
        let Ok(guard) = state.lock() else {
            return false;
        };
        if guard.battle_key.is_empty() {
            return false;
        }
        let battle = guard.battle_key.clone();
        let recent_limit = usize::try_from(config.context.recent_lines.clamp(0, 30)).unwrap_or(8);
        let recent: Vec<RecentLine> = guard
            .lines
            .iter()
            .rev()
            .take(recent_limit)
            .rev()
            .filter(|previous| !previous.self_line)
            .map(|previous| RecentLine {
                from: previous.from.clone(),
                text: previous.text.clone(),
            })
            .collect();
        let observed = context::observed_languages(&battle);
        (battle, recent, observed)
    };
    let targets = outgoing_targets(&config, &observed, own);
    if targets.is_empty() {
        return false;
    }
    let generation = {
        let mut runtime = lock_runtime();
        let (next, _actions) = advance(
            &runtime.state,
            HintEvent::OwnLine {
                battle: battle.clone(),
            },
            now_ms(),
            hint_timeout_ms(&config),
        );
        runtime.state = next;
        runtime.battle = battle.clone();
        runtime.config = config.clone();
        runtime.app = Some(app.clone());
        runtime.deadline_ms = 0;
        runtime.generation = runtime.generation.saturating_add(1);
        runtime.generation
    };
    set_hint_watch(false, 0);
    set_clipboard_seq(None);
    emit_hint(
        &app,
        hint_payload(
            &HintState::Translating {
                battle: battle.clone(),
            },
            &battle,
        ),
    );
    tauri::async_runtime::spawn(async move {
        let match_context = context::build(&recent, &targets);
        let result = super::translate::translate_line_configured(
            &config,
            &line.text,
            &targets,
            own,
            &match_context,
        )
        .await;
        let event = match result {
            Ok(line_translation) => {
                let translations: Vec<(String, String)> = line_translation
                    .translations
                    .into_iter()
                    .map(|(lang, text, _source)| (lang, text))
                    .collect();
                let messages =
                    compose::compose_outgoing(&line.text, &translations, &compose_options(&config));
                // No sendable message (every target came back empty or
                // untranslatable): dismiss silently — there is nothing to
                // paste and no error worth a card.
                HintEvent::TranslationDone(messages)
            },
            Err(_) => {
                HintEvent::TranslationFailed("translation failed — try again later".to_string())
            },
        };
        apply_event_if_current(&app, generation, event);
    });
    true
}

/// Ctrl+V was recognized while the hint was armed: prepare the next message or
/// dismiss (the overlay paste monitor's callback).
pub(crate) fn notify_pasted() {
    let app = {
        let runtime = lock_runtime();
        if !matches!(runtime.state, HintState::Ready { .. }) {
            return;
        }
        runtime.app.clone()
    };
    if let Some(app) = app {
        apply_event(&app, HintEvent::Pasted);
    }
}

/// Another app overwrote the clipboard while the hint was armed: the prepared
/// message is gone, dismiss (the overlay paste monitor's callback).
pub(crate) fn notify_third_party() {
    let app = {
        let runtime = lock_runtime();
        if matches!(runtime.state, HintState::Idle | HintState::Dismissed) {
            return;
        }
        runtime.app.clone()
    };
    if let Some(app) = app {
        apply_event(&app, HintEvent::ThirdPartyClipboard);
    }
}

/// The live source moved to another battle (or the battle ended): dismiss the
/// current hint and forget it. Idempotent; emits a dismissed card for the
/// previous battle when one was showing.
pub(crate) fn notify_battle_changed(battle: &str) {
    let (app, previous_battle) = {
        let mut runtime = lock_runtime();
        if runtime.battle == battle && matches!(runtime.state, HintState::Idle) {
            return;
        }
        let previous = std::mem::take(&mut runtime.battle);
        let (next, _actions) = advance(
            &runtime.state,
            HintEvent::BattleChanged,
            now_ms(),
            hint_timeout_ms(&runtime.config),
        );
        runtime.state = next;
        runtime.battle = battle.to_string();
        runtime.generation = runtime.generation.saturating_add(1);
        runtime.deadline_ms = 0;
        (runtime.app.clone(), previous)
    };
    set_hint_watch(false, 0);
    set_clipboard_seq(None);
    if let Some(app) = app
        && !previous_battle.is_empty()
    {
        emit_hint(&app, dismissed_payload(&previous_battle));
    }
}

// ── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use wowsp_tauri_shared::RecentChatLine;

    /// The target-selection priority list must stay IDENTICAL to compose's
    /// rendering order: outgoing picks which languages survive the
    /// maxTargets cut using this order, while compose lays the kept ones out
    /// in its own — a silent drift would make the cut disagree with the
    /// rendered segment order.
    #[test]
    fn priority_langs_match_the_compose_render_order() {
        assert_eq!(
            &PRIORITY_LANGS,
            &crate::commands::chat_translate::compose::PRIORITY_LANGS_FOR_TEST
        );
    }

    /// Static-state tests run serially: the hint watch and clipboard sequence
    /// are process-wide by design (the watcher polls them).
    static TEST_GATE: Mutex<()> = Mutex::new(());

    fn gate() -> std::sync::MutexGuard<'static, ()> {
        TEST_GATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn config() -> ChatTranslateConfig {
        use wowsp_tauri_shared::{ChatTranslateLanguagesConfig, ChatTranslateSendConfig};

        ChatTranslateConfig {
            enabled: true,
            consent_version: 1,
            send: ChatTranslateSendConfig {
                mode: "clipboard".to_string(),
                ..ChatTranslateSendConfig::default()
            },
            languages: ChatTranslateLanguagesConfig {
                max_targets: 4,
                ..ChatTranslateLanguagesConfig::default()
            },
            ..ChatTranslateConfig::default()
        }
    }

    fn own_line(text: &str) -> ChatLine {
        ChatLine {
            id: 1,
            t: 0,
            from: "Me".to_string(),
            ns: "battle_common".to_string(),
            lang: None,
            text: text.to_string(),
            translated: None,
            self_line: true,
        }
    }

    fn ready(index: usize) -> HintState {
        HintState::Ready {
            battle: "battle-1".to_string(),
            messages: vec!["first".to_string(), "second".to_string()],
            index,
        }
    }

    // ── state machine matrix ───────────────────────────────────────────────

    #[test]
    fn own_line_restarts_from_every_state() {
        let states = [
            HintState::Idle,
            HintState::Translating {
                battle: "old".to_string(),
            },
            ready(0),
            ready(1),
            HintState::Dismissed,
        ];
        for state in states {
            let (next, actions) = advance(
                &state,
                HintEvent::OwnLine {
                    battle: "battle-2".to_string(),
                },
                0,
                5_000,
            );
            assert_eq!(
                next,
                HintState::Translating {
                    battle: "battle-2".to_string()
                }
            );
            assert!(actions.is_empty());
        }
    }

    #[test]
    fn translation_finish_enters_ready_with_the_first_copy() {
        let (next, actions) = advance(
            &HintState::Translating {
                battle: "battle-1".to_string(),
            },
            HintEvent::TranslationDone(vec!["one".to_string(), "two".to_string()]),
            0,
            5_000,
        );
        assert_eq!(
            next,
            HintState::Ready {
                battle: "battle-1".to_string(),
                messages: vec!["one".to_string(), "two".to_string()],
                index: 0,
            }
        );
        assert_eq!(actions, vec![HintAction::CopyNext(0)]);
        // Only a Translating state consumes the answer.
        let (next, actions) = advance(
            &ready(0),
            HintEvent::TranslationDone(vec!["x".to_string()]),
            0,
            0,
        );
        assert_eq!(next, ready(0));
        assert!(actions.is_empty());
    }

    #[test]
    fn empty_translation_and_failure_dismiss() {
        let (next, actions) = advance(
            &HintState::Translating {
                battle: "battle-1".to_string(),
            },
            HintEvent::TranslationDone(Vec::new()),
            0,
            5_000,
        );
        assert_eq!(next, HintState::Dismissed);
        assert!(actions.is_empty());
        let (next, actions) = advance(
            &HintState::Translating {
                battle: "battle-1".to_string(),
            },
            HintEvent::TranslationFailed("boom".to_string()),
            0,
            5_000,
        );
        assert_eq!(next, HintState::Dismissed);
        assert!(actions.is_empty());
        // A failed answer from a stale request does not disturb a ready hint.
        let (next, actions) = advance(
            &ready(0),
            HintEvent::TranslationFailed("boom".to_string()),
            0,
            0,
        );
        assert_eq!(next, ready(0));
        assert!(actions.is_empty());
    }

    #[test]
    fn paste_walks_the_messages_then_dismisses() {
        let (next, actions) = advance(&ready(0), HintEvent::Pasted, 0, 5_000);
        assert_eq!(next, ready(1));
        assert_eq!(actions, vec![HintAction::CopyNext(1)]);
        let (next, actions) = advance(&ready(1), HintEvent::Pasted, 0, 5_000);
        assert_eq!(next, HintState::Dismissed);
        assert!(actions.is_empty());
        // Idle/Translating/Dismissed ignore a paste (the monitor is only armed
        // while ready, this is the defensive path).
        for state in [
            HintState::Idle,
            HintState::Translating {
                battle: "b".to_string(),
            },
            HintState::Dismissed,
        ] {
            let (next, actions) = advance(&state, HintEvent::Pasted, 0, 0);
            assert_eq!(next, state);
            assert!(actions.is_empty());
        }
    }

    #[test]
    fn third_party_timeout_and_battle_change_act() {
        for state in [
            HintState::Translating {
                battle: "b".to_string(),
            },
            ready(0),
        ] {
            for event in [
                HintEvent::ThirdPartyClipboard,
                HintEvent::Timeout,
                HintEvent::BattleChanged,
            ] {
                let expected = if matches!(event, HintEvent::BattleChanged) {
                    HintState::Idle
                } else {
                    HintState::Dismissed
                };
                let (next, actions) = advance(&state, event.clone(), 0, 5_000);
                assert_eq!(next, expected);
                assert!(actions.is_empty());
            }
        }
        // Idle/Dismissed are already quiet: no transition, no action.
        for state in [HintState::Idle, HintState::Dismissed] {
            for event in [HintEvent::ThirdPartyClipboard, HintEvent::Timeout] {
                let (next, actions) = advance(&state, event, 0, 0);
                assert_eq!(next, state);
                assert!(actions.is_empty());
            }
        }
    }

    #[test]
    fn ready_invariant_holds_for_an_out_of_range_index() {
        let broken = HintState::Ready {
            battle: "b".to_string(),
            messages: vec!["only".to_string()],
            index: 5,
        };
        let (next, actions) = advance(&broken, HintEvent::Pasted, 0, 5_000);
        assert_eq!(next, HintState::Dismissed);
        assert!(actions.is_empty());
    }

    // ── trigger gate / echo suppression ────────────────────────────────────

    #[test]
    fn trigger_gate_requires_own_line_clipboard_mode_and_consent() {
        let base = config();
        assert!(should_start(&base, &own_line("hello")));

        let mut off = base.clone();
        off.send.mode = "off".to_string();
        assert!(!should_start(&off, &own_line("hello")));

        let mut disabled = base.clone();
        disabled.enabled = false;
        assert!(!should_start(&disabled, &own_line("hello")));

        let mut no_consent = base.clone();
        no_consent.consent_version = 0;
        assert!(!should_start(&no_consent, &own_line("hello")));

        let mut foreign_line = own_line("hello");
        foreign_line.self_line = false;
        assert!(!should_start(&base, &foreign_line));
        assert!(!should_start(&base, &own_line("   ")));

        // Our own composed output echoed back must never start another round.
        let echo = format!("hi {}", lang::suffix_for("en"));
        assert!(lang::looks_like_own_echo(&echo));
        assert!(!should_start(&base, &own_line(&echo)));
        let composed = "hi [WOWSP live translation] | konnichiwa [WOWSP live translation]";
        assert!(lang::looks_like_own_echo(composed));
        assert!(!should_start(&base, &own_line(composed)));
    }

    // ── target selection ──────────────────────────────────────────────────

    #[test]
    fn targets_union_priority_and_truncation() {
        let mut config = config();
        config.languages.always = vec!["en".to_string()];
        let targets = outgoing_targets(&config, &["ko", "ja"], "zh-CN");
        assert_eq!(targets, vec!["ja", "ko", "en"]);

        // Own language and the exclude list are removed.
        let mut excluded = config.clone();
        excluded.languages.exclude = vec!["ko".to_string(), "en".to_string()];
        let targets = outgoing_targets(&excluded, &["ko", "ja"], "zh-CN");
        assert_eq!(targets, vec!["ja"]);

        // Own language never survives, and duplicates collapse.
        let mut always = config.clone();
        always.languages.always = vec!["ja".to_string(), "fr".to_string()];
        let targets = outgoing_targets(&always, &["ja", "ja"], "ja");
        assert_eq!(targets, vec!["fr"]);

        // maxTargets truncates AFTER the priority ordering.
        let mut capped = config.clone();
        capped.languages.max_targets = 2;
        let targets = outgoing_targets(&capped, &["fr", "ko", "ja", "ru"], "en");
        assert_eq!(targets, vec!["ja", "ko"]);

        // Unknown tags are noise; an empty union sends nothing.
        assert!(outgoing_targets(&config, &["xx", ""], "en").is_empty());
    }

    // ── clipboard ─────────────────────────────────────────────────────────

    struct MockWriter {
        readback: Option<String>,
        write_error: bool,
    }

    impl ClipboardWriter for MockWriter {
        fn write_text(&self, _text: &str) -> Result<()> {
            if self.write_error {
                bail!("clipboard is busy for the test")
            }
            Ok(())
        }

        fn read_text(&self) -> Result<String> {
            Ok(self.readback.clone().unwrap_or_default())
        }
    }

    #[test]
    fn clipboard_write_verifies_the_readback() {
        let ok = MockWriter {
            readback: Some("hello".to_string()),
            write_error: false,
        };
        assert!(write_verified(&ok, "hello").is_ok());

        let busy = MockWriter {
            readback: None,
            write_error: true,
        };
        let error = write_verified(&busy, "hello").unwrap_err();
        assert!(error.to_string().contains("clipboard"), "{error}");

        let taken = MockWriter {
            readback: Some("something else".to_string()),
            write_error: false,
        };
        let error = write_verified(&taken, "hello").unwrap_err();
        assert!(
            error.to_string().contains("another app"),
            "a clipboard race must be reported: {error}"
        );
    }

    #[test]
    fn clipboard_sequence_round_trips_and_clears() {
        let _guard = gate();
        set_clipboard_seq(Some(42));
        assert_eq!(clipboard_seq(), Some(42));
        set_clipboard_seq(None);
        assert_eq!(clipboard_seq(), None);
    }

    // ── watch ─────────────────────────────────────────────────────────────

    #[test]
    fn hint_watch_honours_the_deadline() {
        let _guard = gate();
        set_hint_watch(true, 1_000);
        assert!(hint_active(999));
        assert!(!hint_active(1_000));
        assert!(!hint_active(2_000));
        set_hint_watch(false, 5_000);
        assert!(!hint_active(0));
        set_hint_watch(false, 0);
    }

    // ── payload / compose options ─────────────────────────────────────────

    #[test]
    fn payload_faces_serialize_the_camel_case_shape() {
        let translating = hint_payload(
            &HintState::Translating {
                battle: "b".to_string(),
            },
            "b",
        );
        let value = serde_json::to_value(&translating).unwrap();
        assert_eq!(value["battle"], "b");
        assert_eq!(value["state"], "translating");
        assert!(value.get("preview").is_none());
        assert!(value.get("remaining").is_none());
        assert!(value.get("total").is_none());
        assert!(value.get("message").is_none());

        let first_ready = hint_payload(&ready(0), "b");
        let value = serde_json::to_value(&first_ready).unwrap();
        assert_eq!(value["state"], "ready");
        assert_eq!(value["preview"], "first");
        assert_eq!(value["remaining"], 1);
        assert_eq!(value["total"], 2);

        let last = hint_payload(&ready(1), "b");
        let value = serde_json::to_value(&last).unwrap();
        assert_eq!(value["preview"], "second");
        assert_eq!(value["remaining"], 0);

        let dismissed = hint_payload(&HintState::Dismissed, "b");
        assert_eq!(
            serde_json::to_value(&dismissed).unwrap()["state"],
            "dismissed"
        );

        let error = error_payload("b", "clipboard is busy");
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["state"], "error");
        assert_eq!(value["message"], "clipboard is busy");
    }

    #[test]
    fn compose_options_map_the_send_settings() {
        let mut config = config();
        let options = compose_options(&config);
        assert!(options.suffix_enabled);
        assert_eq!(options.suffix_format, SuffixFormat::PerSegment);
        assert_eq!(options.split_chars, 120);

        config.send.suffix_enabled = false;
        config.send.suffix_format = "unified".to_string();
        config.send.split_chars = 90;
        let options = compose_options(&config);
        assert!(!options.suffix_enabled);
        assert_eq!(options.suffix_format, SuffixFormat::Unified);
        assert_eq!(options.split_chars, 90);
    }

    #[test]
    fn recent_line_alias_matches_the_shared_dto() {
        // context::RecentLine is a re-export of the shared DTO the prompt
        // builder consumes; the outgoing pipeline feeds it from the ring.
        let shared: RecentChatLine = RecentLine {
            from: "Me".to_string(),
            text: "hi".to_string(),
        };
        assert_eq!(shared.text, "hi");
    }
}
