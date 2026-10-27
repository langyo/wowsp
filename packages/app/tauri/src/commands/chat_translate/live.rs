//! Live battle-chat source: tail the running client's in-progress
//! temp replay container, decode the chat timeline plus the descriptor roster
//! (sender identity), and feed the recent lines to the chat-translation
//! pipeline at the bottom-left overlay panel.
//!
//! Data path, once per second:
//!
//!   temp.<ext> (running install's replays dir)
//!     -> decode_replay_partial (chat_messages + descriptor roster)
//!     -> join playerId -> nickname / is-recorder (roster relation 0)
//!     -> per-line callback into flow (translation pipeline; WC)
//!     -> shared LiveState ring of ChatLine
//!     -> wowsp://chat-translate snapshot event (new lines / translations)
//!
//! Gates and silence rules (contract §2):
//! - the ARENA watcher must have seen an arena file recently
//!   (arena_seen_within, 30 minutes) — otherwise the state is cleared and
//!   nothing is emitted, decoded or requested (no source, no traffic);
//! - the decode is skipped while the container size is unchanged (the
//!   size-grew rule), so a quiescent file costs one stat per second;
//! - a changed container is decoded with the truncation-tolerant
//!   decode_replay_partial (mid-write tails are the NORMAL first reads) and
//!   an undecodable read stays silent (debug log only) until the file grows;
//! - a descriptor dateTime change (or a different temp path) starts a new
//!   battle: the ring resets, ids restart at 1, the cache resets;
//! - already-processed chat entries are deduped by the cumulative chat count
//!   (the decoder returns the battle-so-far timeline, never a delta);
//! - when the feature is disabled (config.enabled + consent) or the arena gate
//!   is cold, the tick is FULLY silent: no decode, no flow callback, no
//!   event, and the ring is dropped so a later enable starts clean.
//!
//! The tick is split into a pure-ish advance core (unit-tested against
//! synthetic replay bytes and fabricated snapshots) and the async task that
//! owns file IO. Nothing here launches or writes into the game — the replays
//! directory is only read.

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use wowsp_tauri_shared::{ChatLine, ChatTranslateConfig, ChatTranslateEvent, VehicleEntry};

use super::cache::CacheCore;
use super::config;
use crate::commands::{arena_info, game_client, game_context, overlay_config};

/// Tauri event carrying the chat panel's line snapshot (the overlay module
/// owns the window family's vocabulary; the string is repeated here because
/// that module — and its constant — is desktop-only while this source
/// compiles on every target). A unit test pins it against the overlay
/// constant on desktop.
pub(crate) const CHAT_TRANSLATE_EVENT: &str = "wowsp://chat-translate";

/// Arena freshness gate for the live source: the battle is live when the
/// arena watcher saw an arena file within this window (the overlay's own
/// stall bound; a stale arena means the battle is over or the client left).
const ARENA_LIVE_WINDOW_SECS: u64 = 30 * 60;

/// Poll cadence of the temp-container tail. One second is well inside the
/// chat's usable latency and keeps the decode (sub-millisecond on a real
/// container) off the CPU map.
const TICK: Duration = Duration::from_secs(1);

/// Defensive upper bound on the panel ring; the settings band tops out at 30
/// and the event carries the min of the two switches clamped to 1..=100.
const MAX_LINES_CEILING: i64 = 100;

/// The temp container currently being tailed.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TempContainer {
    path: PathBuf,
    size: u64,
    /// The file's modification stamp (unix ms) — the battle-key fallback when
    /// the descriptor carries no dateTime.
    modified_ms: i64,
}

/// One decode of the in-progress container: the battle identity, the
/// descriptor roster (sender join) and the cumulative chat timeline.
#[derive(Debug, Clone)]
struct ChatSnapshot {
    battle_key: String,
    roster: Vec<VehicleEntry>,
    chat: Vec<wowsp_tauri_shared::ChatEvent>,
}

/// How far the CURRENT battle's container has been consumed.
#[derive(Debug, Clone, Default)]
struct SourceProgress {
    path: Option<PathBuf>,
    last_size: u64,
    /// Chat entries already handed to the pipeline (the decoder's timeline is
    /// cumulative, so this is the dedupe cursor).
    processed_chat: usize,
}

impl SourceProgress {
    fn reset(&mut self) {
        self.path = None;
        self.last_size = 0;
        self.processed_chat = 0;
    }
}

/// The shared live state: the ring the overlay panel receives plus the
/// translation bookkeeping the flow pipeline updates. All access goes through
/// one std::sync::Mutex; no lock is held across an await.
pub(crate) struct LiveState {
    /// Stable id of the battle the ring belongs to ("" = no battle).
    pub battle_key: String,
    /// Recent lines, oldest to newest, capped at [Self::max_lines].
    pub lines: VecDeque<ChatLine>,
    /// Per-battle monotonic line id source.
    pub next_line_id: u64,
    /// Bumped on every visible change (line appended, translation landed, cap
    /// changed, battle reset) — the emitter's snapshot cursor.
    pub revision: u64,
    /// The translation request cache / rate limiter / backoff for this battle
    /// (flow owns its semantics; the source owns the battle reset).
    pub cache: CacheCore,
    /// Current ring cap (min of the two settings switches).
    pub max_lines: i64,
}

impl LiveState {
    pub(crate) fn new() -> Self {
        Self {
            battle_key: String::new(),
            lines: VecDeque::new(),
            next_line_id: 1,
            revision: 0,
            cache: CacheCore::new(""),
            max_lines: 8,
        }
    }

    /// Start a new battle (or clear the ring): lines dropped, ids restart at
    /// 1, the per-battle cache/rate/backoff state resets.
    pub(crate) fn reset(&mut self, battle_key: &str, max_lines: i64) {
        self.battle_key = battle_key.to_string();
        self.lines.clear();
        self.next_line_id = 1;
        self.max_lines = sanitize_max_lines(max_lines);
        self.cache.reset(battle_key);
        self.revision = self.revision.saturating_add(1);
    }

    /// Append one source line, assign its per-battle id, trim the ring and
    /// bump the revision. Returns the line as inserted (the flow callback
    /// receives this exact copy, id included).
    fn append_line(
        &mut self,
        now_ms: i64,
        from: String,
        ns: String,
        text: String,
        self_line: bool,
    ) -> ChatLine {
        let line = ChatLine {
            id: i64::try_from(self.next_line_id).unwrap_or(i64::MAX),
            t: now_ms,
            from,
            ns,
            lang: None,
            text,
            translated: None,
            self_line,
        };
        self.next_line_id = self.next_line_id.saturating_add(1);
        self.lines.push_back(line.clone());
        let cap = usize::try_from(sanitize_max_lines(self.max_lines)).unwrap_or(1);
        while self.lines.len() > cap {
            self.lines.pop_front();
        }
        self.revision = self.revision.saturating_add(1);
        line
    }

    /// Record the translation (or the skip hint) for one line. A line that
    /// already left the ring (battle moved on) is ignored. Returns whether
    /// anything changed (a no-op update does not bump the revision).
    pub(crate) fn apply_translation(
        &mut self,
        id: i64,
        lang: Option<String>,
        translated: Option<String>,
    ) -> bool {
        let Some(line) = self.lines.iter_mut().find(|line| line.id == id) else {
            return false;
        };
        let lang = lang
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let translated = translated
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if line.lang == lang && line.translated == translated {
            return false;
        }
        line.lang = lang;
        line.translated = translated;
        self.revision = self.revision.saturating_add(1);
        true
    }

    /// Record the local detector's language hint on a line that was not sent
    /// to the provider (a skipped line still carries its script hint to the
    /// panel). Same change/revision semantics as [Self::apply_translation].
    pub(crate) fn set_lang(&mut self, id: i64, lang: Option<String>) -> bool {
        let Some(line) = self.lines.iter_mut().find(|line| line.id == id) else {
            return false;
        };
        let lang = lang
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if line.lang == lang {
            return false;
        }
        line.lang = lang;
        self.revision = self.revision.saturating_add(1);
        true
    }

    /// Update the ring cap (the smaller of the two settings switches). Trims
    /// immediately and bumps the revision when the cap actually changed.
    pub(crate) fn set_max_lines(&mut self, max_lines: i64) {
        let max_lines = sanitize_max_lines(max_lines);
        if max_lines == self.max_lines {
            return;
        }
        self.max_lines = max_lines;
        let cap = usize::try_from(max_lines).unwrap_or(1);
        while self.lines.len() > cap {
            self.lines.pop_front();
        }
        self.revision = self.revision.saturating_add(1);
    }

    /// The event snapshot the overlay page renders.
    pub(crate) fn snapshot(&self) -> ChatTranslateEvent {
        ChatTranslateEvent {
            battle: self.battle_key.clone(),
            lines: self.lines.iter().cloned().collect(),
            max_lines: self.max_lines,
        }
    }
}

/// The state handle shared with the flow pipeline (WC).
pub(crate) type SharedLiveState = Arc<Mutex<LiveState>>;

/// Defensive clamp on the ring cap (a hostile hand-edited config value must
/// never allocate an unbounded ring).
fn sanitize_max_lines(value: i64) -> i64 {
    value.clamp(1, MAX_LINES_CEILING)
}

/// The effective panel cap: the smaller of the translation display cap and
/// the overlay panel cap (both settings own one half; the contract's event
/// carries the min).
fn min_panel_lines(display_max_lines: i64, panel_max_lines: i64) -> i64 {
    sanitize_max_lines(display_max_lines).min(sanitize_max_lines(panel_max_lines))
}

fn effective_max_lines(config: &ChatTranslateConfig) -> i64 {
    min_panel_lines(
        config.display.max_lines,
        overlay_config::chat_panel_max_lines(),
    )
}

/// Pure time helper: unix milliseconds (0 on a pre-epoch clock — the stamp is
/// display/debug only, never ordering).
fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Locate the running install's in-progress temp container in one replays
/// directory: every replay extension's temp.<ext>, most recently modified
/// wins. None when no temp container exists (no battle in progress).
fn pick_container(dir: &Path) -> Option<TempContainer> {
    let mut best: Option<(SystemTime, TempContainer)> = None;
    for extension in game_client::replay_extensions() {
        let path = dir.join(format!("temp.{extension}"));
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(UNIX_EPOCH);
        if best.as_ref().is_none_or(|(stamp, _)| modified >= *stamp) {
            let modified_ms = modified
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(0))
                .unwrap_or(0);
            best = Some((
                modified,
                TempContainer {
                    path,
                    size: meta.len(),
                    modified_ms,
                },
            ));
        }
    }
    best.map(|(_, container)| container)
}

/// Resolve the running client's replays directory and pick its temp container.
fn find_container() -> Option<TempContainer> {
    let resolved = game_context::resolve_root(game_context::RootPreference::PreferRunning)?;
    let dir = game_context::replays_dir(&resolved.root);
    pick_container(&dir)
}

/// Whether the polled container needs a fresh decode: a new path (new
/// client/battle) or a grown size. A same-path, same-size read is quiescent
/// and costs nothing.
fn container_changed(progress: &SourceProgress, current: &TempContainer) -> bool {
    progress.path.as_deref() != Some(current.path.as_path()) || progress.last_size != current.size
}

/// Decode one temp-container read into the battle key + roster + cumulative
/// chat timeline. None when the read is undone/mid-write/unreadable — the
/// caller stays silent and retries on the next size growth.
fn decode_snapshot(bytes: &[u8], path: &Path, fallback_key: &str) -> Option<ChatSnapshot> {
    let descriptor = wowsp_replay_core::meta::extract_descriptor_json(bytes)?;
    let raw: Value = serde_json::from_str(&descriptor).ok()?;
    let client_version =
        wowsp_replay_core::meta::client_version_from_raw(raw.get("clientVersionFromExe"));
    let roster = wowsp_replay_core::meta::roster_from_raw(path, &raw);
    let battle_key = raw
        .get("dateTime")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| fallback_key.to_string());
    let stream = wowsp_replay_core::meta::packet_stream_after_blocks(bytes)?;
    let mut candidates: HashSet<u32> = HashSet::new();
    for vehicle in &roster {
        if vehicle.ship_id > 0 {
            candidates.insert(vehicle.ship_id as u32);
        }
    }
    let lesta = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(game_client::is_lesta_replay_extension);
    let decoded = wowsp_replay_core::decode_replay_partial(
        stream,
        &candidates,
        client_version.as_deref(),
        lesta,
    )
    .ok()?;
    Some(ChatSnapshot {
        battle_key,
        roster,
        chat: decoded.chat_messages,
    })
}

/// Join one chat player id to the descriptor roster: the nickname and the
/// recorder flag (relation 0 is the recording player's own team slot).
fn join_sender(roster: &[VehicleEntry], player_id: i32) -> (String, bool) {
    let player_id = i64::from(player_id);
    match roster.iter().find(|vehicle| vehicle.id == player_id) {
        Some(vehicle) => (vehicle.name.clone(), vehicle.relation == 0),
        None => (String::new(), false),
    }
}

/// The pure core of one tick: fold a decoded snapshot (or silence) into the
/// shared state and return the new source lines that must be handed to the
/// flow pipeline, in arrival order. No IO, no event emission.
fn advance(
    state: &mut LiveState,
    progress: &mut SourceProgress,
    snapshot: Option<&ChatSnapshot>,
    enabled: bool,
    arena_live: bool,
    max_lines: i64,
    now_ms: i64,
) -> Vec<ChatLine> {
    if !enabled || !arena_live {
        // Silence: drop the battle ring and forget the source cursor so a
        // later enable starts from the current file position, not a replay.
        if !state.battle_key.is_empty() || !state.lines.is_empty() {
            state.reset("", max_lines);
        }
        progress.reset();
        return Vec::new();
    }
    let Some(snapshot) = snapshot else {
        return Vec::new();
    };
    if snapshot.battle_key != state.battle_key {
        state.reset(&snapshot.battle_key, max_lines);
        progress.processed_chat = 0;
    }
    let total = snapshot.chat.len();
    if total < progress.processed_chat {
        // A mid-write decode can lose its torn tail: never re-emit lines that
        // were already processed; wait for the next growth to catch up.
        return Vec::new();
    }
    let mut lines = Vec::with_capacity(total - progress.processed_chat);
    for event in &snapshot.chat[progress.processed_chat..] {
        let (from, self_line) = join_sender(&snapshot.roster, event.player_id);
        lines.push(state.append_line(
            now_ms,
            from,
            event.namespace.clone(),
            event.message.clone(),
            self_line,
        ));
    }
    progress.processed_chat = total;
    lines
}

/// One tick: observe the source, decode when it grew, advance the state, hand
/// new lines to the flow pipeline and emit the overlay snapshot when it
/// changed. Every failure is silent (debug level at most) — an absent or
/// unreadable source is the normal no-battle path, not an error.
fn tick_once(
    app: &AppHandle,
    state: &SharedLiveState,
    progress: &mut SourceProgress,
    last_emitted: &mut u64,
    last_battle: &mut String,
) {
    let config = config::load();
    let enabled = config.enabled && config.consent_version >= 1;
    let arena_live = arena_info::arena_seen_within(ARENA_LIVE_WINDOW_SECS);
    let max_lines = effective_max_lines(&config);

    // Decode OUTSIDE the state lock: the packet decode is the only expensive
    // step and the flow pipeline must never wait on it.
    let mut snapshot: Option<ChatSnapshot> = None;
    if enabled
        && arena_live
        && let Some(container) = find_container()
        && container_changed(progress, &container)
    {
        let fallback_key = format!("{}#{}", container.path.display(), container.modified_ms);
        let decoded = std::fs::read(&container.path)
            .ok()
            .and_then(|bytes| decode_snapshot(&bytes, &container.path, &fallback_key));
        progress.path = Some(container.path.clone());
        progress.last_size = container.size;
        if decoded.is_none() {
            tracing::debug!(
                path = %container.path.display(),
                size = container.size,
                "live chat source not decodable yet (mid-write read)"
            );
        }
        snapshot = decoded;
    }

    let now_ms = unix_ms();
    let (new_lines, emit, battle_changed, battle_after) = {
        let mut state = match state.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.set_max_lines(max_lines);
        let battle_before = state.battle_key.clone();
        let new_lines = advance(
            &mut state,
            progress,
            snapshot.as_ref(),
            enabled,
            arena_live,
            max_lines,
            now_ms,
        );
        let battle_after = state.battle_key.clone();
        let battle_changed = battle_after != battle_before;
        let changed = state.revision != *last_emitted || state.battle_key != *last_battle;
        let emit = if enabled && arena_live && changed {
            Some((state.snapshot(), state.revision, state.battle_key.clone()))
        } else {
            if !enabled || !arena_live {
                // The silence path: keep the cursors in step so re-enabling
                // does not dump a stale ring as a change.
                *last_emitted = state.revision;
                *last_battle = state.battle_key.clone();
            }
            None
        };
        (new_lines, emit, battle_changed, battle_after)
    };

    // A battle switch (or the gate clearing the state) invalidates the
    // outgoing paste hint: dismiss it before the new battle's lines flow.
    if battle_changed {
        super::outgoing::notify_battle_changed(&battle_after);
    }

    for line in new_lines {
        super::flow::submit(app.clone(), Arc::clone(state), config.clone(), line);
    }
    if let Some((event, revision, battle)) = emit {
        if let Err(error) = app.emit(CHAT_TRANSLATE_EVENT, &event) {
            tracing::warn!(error = %error, "emit chat-translate failed");
        }
        *last_emitted = revision;
        *last_battle = battle;
    }
}

/// Start the live chat source: one async task, one tick per second. The task
/// ends with the app runtime (no shutdown plumbing needed); nothing is spawned
/// twice because the shell calls this once from setup.
pub(crate) fn spawn(app: AppHandle) {
    let state: SharedLiveState = Arc::new(Mutex::new(LiveState::new()));
    // The task lives with the app runtime; dropping the handle detaches it.
    drop(tauri::async_runtime::spawn(async move {
        let mut progress = SourceProgress::default();
        let mut last_emitted = 0u64;
        let mut last_battle = String::new();
        let mut ticker = tokio::time::interval(TICK);
        loop {
            ticker.tick().await;
            tick_once(
                &app,
                &state,
                &mut progress,
                &mut last_emitted,
                &mut last_battle,
            );
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    use serde_json::json;
    use wowsp_tauri_shared::ChatEvent;

    const SYNTH_VERSION: &str = "15,8,0,13187581";
    const SYNTH_BATTLE: &str = "2026-10-26 12:00:00";
    const AVATAR: i32 = 900;
    const OWNER: i32 = 11;
    const ENEMY: i32 = 22;

    // Wire packet types (the stable replay-format contract, see
    // wowsp_replay_core::packets; the app-side test re-declares the three it
    // writes so the fixture does not depend on private decoder constants).
    const PACKET_CELL_PLAYER_CREATE: u32 = 0x01;
    const PACKET_ENTITY_METHOD: u32 = 0x08;

    /// The real WoWS Blowfish key (hardcoded in the client, public format
    /// constant — not a credential). The fixture encrypts exactly like the
    /// game so the app's decode path is exercised byte for byte.
    const WOWS_BLOWFISH_KEY: [u8; 16] = [
        0x29, 0xB7, 0xC9, 0x09, 0x38, 0x3F, 0x84, 0x88, 0xFA, 0x98, 0xEC, 0x4E, 0x13, 0x19, 0x79,
        0xFB,
    ];

    fn descriptor() -> Value {
        json!({
            "clientVersionFromExe": SYNTH_VERSION,
            "dateTime": SYNTH_BATTLE,
            "mapDisplayName": "Synthetic Basin",
            "vehicles": [
                { "id": OWNER, "relation": 0, "name": "AllyOne", "shipId": 3_542_005_040i64 },
                { "id": ENEMY, "relation": 2, "name": "EnemyTwo", "shipId": 3_542_005_041i64 },
            ],
        })
    }

    fn wire_frame(packet_type: u32, time: f32, payload: &[u8]) -> Vec<u8> {
        let mut frame = Vec::with_capacity(12 + payload.len());
        frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        frame.extend_from_slice(&packet_type.to_le_bytes());
        frame.extend_from_slice(&time.to_le_bytes());
        frame.extend_from_slice(payload);
        frame
    }

    /// One BigWorld wire blob: u8 length + bytes (fixture strings are short).
    fn wire_blob(value: &str) -> Vec<u8> {
        let bytes = value.as_bytes();
        assert!(bytes.len() < 0xff, "fixture blob too long");
        let mut out = vec![bytes.len() as u8];
        out.extend_from_slice(bytes);
        out
    }

    /// CellPlayerCreate (0x01) for the recorder's avatar: the 38-byte fixed
    /// header the decoder reads; only the entity id matters here.
    fn avatar_create() -> Vec<u8> {
        let mut payload = vec![0u8; 38];
        payload[0..4].copy_from_slice(&AVATAR.to_le_bytes());
        payload[8..12].copy_from_slice(&1001i32.to_le_bytes());
        payload
    }

    /// One onChatMessage EntityMethod frame: avatar receiver, the version's
    /// exposed chat id, args (playerId + namespace + message + trailing blob).
    fn chat_frame(time: f32, player_id: i32, namespace: &str, message: &str) -> Vec<u8> {
        let method = method_ids().avatar_on_chat_message;
        let mut args = Vec::new();
        args.extend_from_slice(&player_id.to_le_bytes());
        args.extend(wire_blob(namespace));
        args.extend(wire_blob(message));
        args.extend(wire_blob(""));
        let mut payload = Vec::new();
        payload.extend_from_slice(&AVATAR.to_le_bytes());
        payload.extend_from_slice(&method.to_le_bytes());
        payload.extend_from_slice(&(args.len() as u32).to_le_bytes());
        payload.extend_from_slice(&args);
        wire_frame(PACKET_ENTITY_METHOD, time, &payload)
    }

    fn method_ids() -> &'static wowsp_replay_core::method_tables::MethodIds {
        wowsp_replay_core::method_tables::method_ids_for_version(Some(SYNTH_VERSION))
    }

    /// Encrypt+compress a frame stream exactly like the game writes it
    /// (zlib, then the inverse Blowfish/XOR chain behind the 8-byte marker).
    fn encrypt_stream(plain: &[u8]) -> Vec<u8> {
        use blowfish::cipher::{Block, BlockCipherEncrypt, KeyInit};

        type WowsBlowfish = blowfish::Blowfish<byteorder::BigEndian>;
        let cipher = WowsBlowfish::new_from_slice(&WOWS_BLOWFISH_KEY).unwrap();
        let mut out = vec![0u8; 8];
        let mut previous_plain = 0i64;
        for chunk in plain.chunks(8) {
            let mut block = [0u8; 8];
            block[..chunk.len()].copy_from_slice(chunk);
            let plain_value = i64::from_le_bytes(block);
            let mixed = (plain_value ^ previous_plain).to_le_bytes();
            let mut cipher_block: Block<WowsBlowfish> = mixed.into();
            cipher.encrypt_block(&mut cipher_block);
            let bytes: [u8; 8] = cipher_block.into();
            out.extend_from_slice(&bytes);
            previous_plain = plain_value;
        }
        out
    }

    /// A complete synthetic temp replay: descriptor block + encrypted frame
    /// stream carrying the avatar create and the given chat lines.
    fn synthetic_replay(chat: &[(i32, &str, &str)]) -> Vec<u8> {
        let mut frames = Vec::new();
        frames.extend(wire_frame(PACKET_CELL_PLAYER_CREATE, 0.5, &avatar_create()));
        for (index, (player_id, namespace, message)) in chat.iter().enumerate() {
            frames.extend(chat_frame(
                1.0 + index as f32,
                *player_id,
                namespace,
                message,
            ));
        }
        let mut plain = Vec::new();
        let mut encoder =
            flate2::write::ZlibEncoder::new(&mut plain, flate2::Compression::default());
        encoder.write_all(&frames).unwrap();
        encoder.finish().unwrap();

        let descriptor = descriptor().to_string().into_bytes();
        let mut out = Vec::new();
        out.extend_from_slice(&wowsp_replay_core::meta::REPLAY_MAGIC);
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&(descriptor.len() as u32).to_le_bytes());
        out.extend_from_slice(&descriptor);
        out.extend_from_slice(&encrypt_stream(&plain));
        out
    }

    fn roster() -> Vec<VehicleEntry> {
        vec![
            VehicleEntry {
                id: i64::from(OWNER),
                name: "AllyOne".into(),
                relation: 0,
                ship_id: 3_542_005_040,
                ship_name: None,
            },
            VehicleEntry {
                id: i64::from(ENEMY),
                name: "EnemyTwo".into(),
                relation: 2,
                ship_id: 3_542_005_041,
                ship_name: None,
            },
        ]
    }

    fn fake_snapshot(battle: &str, chat: &[(i32, &str, &str)]) -> ChatSnapshot {
        ChatSnapshot {
            battle_key: battle.to_string(),
            roster: roster(),
            chat: chat
                .iter()
                .enumerate()
                .map(|(index, (player_id, namespace, message))| ChatEvent {
                    time: index as f32,
                    player_id: *player_id,
                    namespace: (*namespace).to_string(),
                    message: (*message).to_string(),
                })
                .collect(),
        }
    }

    fn new_state() -> LiveState {
        LiveState::new()
    }

    #[test]
    fn decode_snapshot_reads_chat_and_joins_roster() {
        let bytes = synthetic_replay(&[
            (OWNER, "battle_common", "hello"),
            (ENEMY, "battle_team", "rush B"),
        ]);
        let snapshot = decode_snapshot(&bytes, Path::new("temp.wowsreplay"), "fallback")
            .expect("synthetic temp replay must decode");
        assert_eq!(snapshot.battle_key, SYNTH_BATTLE);
        assert_eq!(snapshot.roster.len(), 2);
        assert_eq!(snapshot.chat.len(), 2);
        assert_eq!(snapshot.chat[0].player_id, OWNER);
        assert_eq!(snapshot.chat[0].namespace, "battle_common");
        assert_eq!(snapshot.chat[0].message, "hello");
        assert_eq!(snapshot.chat[1].player_id, ENEMY);
        assert_eq!(snapshot.chat[1].message, "rush B");
        assert_eq!(
            join_sender(&snapshot.roster, OWNER),
            ("AllyOne".into(), true)
        );
        assert_eq!(
            join_sender(&snapshot.roster, ENEMY),
            ("EnemyTwo".into(), false)
        );
        assert_eq!(join_sender(&snapshot.roster, 999), (String::new(), false));
    }

    #[test]
    fn non_container_bytes_decode_to_none() {
        assert!(decode_snapshot(b"not a replay", Path::new("temp.wowsreplay"), "x").is_none());
    }

    #[test]
    fn advance_joins_dedupes_and_assigns_ids() {
        let mut state = new_state();
        let mut progress = SourceProgress::default();
        let first = fake_snapshot(
            "battle-a",
            &[(OWNER, "battle_common", "gg"), (ENEMY, "battle_team", "hi")],
        );
        let lines = advance(
            &mut state,
            &mut progress,
            Some(&first),
            true,
            true,
            8,
            1_000,
        );
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].id, 1);
        assert_eq!(lines[0].from, "AllyOne");
        assert!(lines[0].self_line);
        assert_eq!(lines[1].id, 2);
        assert!(!lines[1].self_line);
        assert_eq!(state.battle_key, "battle-a");
        assert_eq!(state.lines.len(), 2);
        assert_eq!(progress.processed_chat, 2);

        // Same cumulative snapshot again: nothing re-emitted.
        let again = advance(
            &mut state,
            &mut progress,
            Some(&first),
            true,
            true,
            8,
            2_000,
        );
        assert!(again.is_empty());
        assert_eq!(state.lines.len(), 2);

        // A grown timeline emits only the NEW entry, with the next id.
        let grown = fake_snapshot(
            "battle-a",
            &[
                (OWNER, "battle_common", "gg"),
                (ENEMY, "battle_team", "hi"),
                (OWNER, "battle_common", "wp"),
            ],
        );
        let lines = advance(
            &mut state,
            &mut progress,
            Some(&grown),
            true,
            true,
            8,
            3_000,
        );
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].id, 3);
        assert_eq!(lines[0].text, "wp");
    }

    #[test]
    fn battle_switch_resets_the_ring_ids_and_cache() {
        let mut state = new_state();
        let mut progress = SourceProgress::default();
        let first = fake_snapshot("battle-a", &[(OWNER, "battle_common", "one")]);
        advance(
            &mut state,
            &mut progress,
            Some(&first),
            true,
            true,
            8,
            1_000,
        );
        assert_eq!(state.battle_key, "battle-a");
        let revision = state.revision;

        let second = fake_snapshot("battle-b", &[(ENEMY, "battle_team", "two")]);
        let lines = advance(
            &mut state,
            &mut progress,
            Some(&second),
            true,
            true,
            8,
            2_000,
        );
        assert_eq!(state.battle_key, "battle-b");
        assert_eq!(state.lines.len(), 1);
        assert_eq!(lines[0].id, 1, "ids restart in a new battle");
        assert_eq!(lines[0].text, "two");
        assert!(state.revision > revision);
    }

    #[test]
    fn regressed_decodes_never_re_emit() {
        let mut state = new_state();
        let mut progress = SourceProgress::default();
        let grown = fake_snapshot(
            "battle-a",
            &[(OWNER, "battle_common", "a"), (ENEMY, "battle_team", "b")],
        );
        advance(
            &mut state,
            &mut progress,
            Some(&grown),
            true,
            true,
            8,
            1_000,
        );
        assert_eq!(state.lines.len(), 2);
        // A torn-tail decode loses the last chat entry: no re-emit, cursor
        // stays put (the next growth catches up).
        let torn = fake_snapshot("battle-a", &[(OWNER, "battle_common", "a")]);
        let lines = advance(&mut state, &mut progress, Some(&torn), true, true, 8, 2_000);
        assert!(lines.is_empty());
        assert_eq!(state.lines.len(), 2);
        assert_eq!(progress.processed_chat, 2);
    }

    #[test]
    fn ring_is_bounded_by_the_cap() {
        let mut state = new_state();
        let mut progress = SourceProgress::default();
        let snapshot = fake_snapshot(
            "battle-a",
            &[
                (OWNER, "a", "1"),
                (OWNER, "a", "2"),
                (OWNER, "a", "3"),
                (OWNER, "a", "4"),
            ],
        );
        advance(
            &mut state,
            &mut progress,
            Some(&snapshot),
            true,
            true,
            2,
            1_000,
        );
        assert_eq!(state.lines.len(), 2);
        let ids: Vec<i64> = state.lines.iter().map(|line| line.id).collect();
        assert_eq!(ids, vec![3, 4]);
    }

    #[test]
    fn disabled_or_cold_arena_is_silent_and_clears() {
        for (enabled, arena_live) in [(false, true), (true, false), (false, false)] {
            let mut state = new_state();
            let mut progress = SourceProgress::default();
            let snapshot = fake_snapshot("battle-a", &[(OWNER, "a", "hi")]);
            advance(
                &mut state,
                &mut progress,
                Some(&snapshot),
                true,
                true,
                8,
                1_000,
            );
            assert_eq!(state.lines.len(), 1);
            let lines = advance(
                &mut state,
                &mut progress,
                Some(&snapshot),
                enabled,
                arena_live,
                8,
                2_000,
            );
            assert!(lines.is_empty(), "no lines while gated");
            assert!(state.lines.is_empty(), "the ring is dropped while gated");
            assert_eq!(state.battle_key, "");
            assert_eq!(progress.processed_chat, 0);
        }
    }

    #[test]
    fn apply_translation_updates_only_the_matching_line() {
        let mut state = new_state();
        let mut progress = SourceProgress::default();
        let snapshot = fake_snapshot("battle-a", &[(OWNER, "a", "hi")]);
        let lines = advance(
            &mut state,
            &mut progress,
            Some(&snapshot),
            true,
            true,
            8,
            1_000,
        );
        let id = lines[0].id;
        let revision = state.revision;
        assert!(state.apply_translation(id, Some("ja".into()), Some("こんにちは".into())));
        assert_eq!(state.lines[0].lang.as_deref(), Some("ja"));
        assert_eq!(state.lines[0].translated.as_deref(), Some("こんにちは"));
        assert!(state.revision > revision);
        // A no-op update does not bump the revision.
        let revision = state.revision;
        assert!(!state.apply_translation(id, Some("ja".into()), Some("こんにちは".into())));
        assert_eq!(state.revision, revision);
        // An unknown id (battle moved on) is ignored.
        assert!(!state.apply_translation(999, Some("ko".into()), Some("안녕".into())));
        // An empty translation keeps the original-text fallback (None).
        assert!(state.apply_translation(id, Some("ja".into()), Some("   ".into())));
        assert!(state.lines[0].translated.is_none());
    }

    #[test]
    fn set_max_lines_trims_and_bumps_the_revision() {
        let mut state = new_state();
        let mut progress = SourceProgress::default();
        let snapshot = fake_snapshot(
            "battle-a",
            &[(OWNER, "a", "1"), (OWNER, "a", "2"), (OWNER, "a", "3")],
        );
        advance(
            &mut state,
            &mut progress,
            Some(&snapshot),
            true,
            true,
            8,
            1_000,
        );
        let revision = state.revision;
        state.set_max_lines(2);
        assert_eq!(state.max_lines, 2);
        assert_eq!(state.lines.len(), 2);
        assert!(state.revision > revision);
        // A same-value set is a no-op.
        let revision = state.revision;
        state.set_max_lines(2);
        assert_eq!(state.revision, revision);
        // Hostile values clamp.
        state.set_max_lines(0);
        assert_eq!(state.max_lines, 1);
        state.set_max_lines(10_000);
        assert_eq!(state.max_lines, MAX_LINES_CEILING);
    }

    #[test]
    fn container_growth_and_path_switch_are_the_only_decode_triggers() {
        let dir = std::env::temp_dir().join("wowsp-chat-container-progress");
        let path = dir.join("temp.wowsreplay");
        let container = TempContainer {
            path: path.clone(),
            size: 10,
            modified_ms: 1,
        };
        let mut progress = SourceProgress::default();
        assert!(
            container_changed(&progress, &container),
            "first sight decodes"
        );
        progress.path = Some(path);
        progress.last_size = 10;
        assert!(
            !container_changed(&progress, &container),
            "quiescent file skips"
        );
        let grown = TempContainer {
            size: 11,
            ..container.clone()
        };
        assert!(container_changed(&progress, &grown));
        let other = TempContainer {
            path: dir.join("temp.korablireplay"),
            ..container.clone()
        };
        assert!(container_changed(&progress, &other), "path switch decodes");
    }

    #[test]
    fn pick_container_prefers_the_newest_temp_family() {
        let dir = std::env::temp_dir().join(format!(
            "wowsp-chat-pick-{}",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(pick_container(&dir).is_none());

        let wows = dir.join("temp.wowsreplay");
        std::fs::write(&wows, b"old").unwrap();
        let korabli = dir.join("temp.korablireplay");
        std::fs::write(&korabli, b"newer bytes").unwrap();
        // Make the Lesta container strictly newer.
        let stamp = SystemTime::now() + Duration::from_secs(5);
        std::fs::File::options()
            .write(true)
            .open(&korabli)
            .unwrap()
            .set_modified(stamp)
            .unwrap();
        let picked = pick_container(&dir).expect("a temp container is present");
        assert_eq!(picked.path, korabli);
        assert_eq!(picked.size, b"newer bytes".len() as u64);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn effective_cap_is_the_smaller_setting() {
        assert_eq!(min_panel_lines(30, 3), 3);
        assert_eq!(min_panel_lines(3, 30), 3);
        assert_eq!(min_panel_lines(8, 8), 8);
        assert_eq!(min_panel_lines(0, 30), 1, "zero clamps to one line");
        assert_eq!(min_panel_lines(10_000, 10_000), MAX_LINES_CEILING);
    }

    #[test]
    fn snapshot_serializes_the_page_wire_shape() {
        let mut state = new_state();
        let mut progress = SourceProgress::default();
        let snapshot = fake_snapshot("battle-a", &[(OWNER, "battle_common", "hi")]);
        let lines = advance(
            &mut state,
            &mut progress,
            Some(&snapshot),
            true,
            true,
            8,
            1_000,
        );
        state.apply_translation(lines[0].id, Some("ja".into()), Some("こんにちは".into()));
        let event = state.snapshot();
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["battle"], "battle-a");
        assert_eq!(value["maxLines"], 8);
        assert_eq!(value["lines"][0]["id"], 1);
        assert_eq!(value["lines"][0]["from"], "AllyOne");
        assert_eq!(value["lines"][0]["ns"], "battle_common");
        assert_eq!(value["lines"][0]["lang"], "ja");
        assert_eq!(value["lines"][0]["text"], "hi");
        assert_eq!(value["lines"][0]["translated"], "こんにちは");
        assert_eq!(value["lines"][0]["selfLine"], true);
        assert!(value["lines"][0].get("absent").is_none());
    }

    #[test]
    fn blank_translation_serializes_without_the_key() {
        let line = ChatLine {
            id: 1,
            t: 0,
            from: String::new(),
            ns: String::new(),
            lang: None,
            text: "hi".into(),
            translated: None,
            self_line: false,
        };
        let value = serde_json::to_value(&line).unwrap();
        assert!(value.get("translated").is_none());
        assert!(value.get("lang").is_none());
    }

    #[cfg(desktop)]
    #[test]
    fn event_name_matches_the_overlay_constant() {
        assert_eq!(
            CHAT_TRANSLATE_EVENT,
            crate::commands::overlay::CHAT_TRANSLATE_EVENT
        );
    }
}
