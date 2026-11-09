//! Beautify layer stack — a Minecraft-style ordered stack of pure-asset mod
//! packs on top of the game's single override tree.
//!
//! World of Warships reads exactly ONE override tree per build
//! (bin/<build>/res_mods, whole-file shadowing, no priority). The stack is
//! therefore a MODEL this module owns: every eligible installed pack becomes a
//! layer (newest on top, user-reorderable), the per-path winner of the enabled
//! layers is written into res_mods, and the app-data store keeps each pack's
//! payload so any order can be re-rendered at will.
//!
//! State lives in <data>/mods/layer-stack.json (schema 1), the payload in
//! <data>/mods/layers/<pack>/<version>/files/ plus a layer.json manifest.
//! Paths are compared lowercase + forward slashes and written with the record's
//! original spelling, because the Windows tree is case-insensitive but the
//! bytes the game loads are the ones on disk.
//!
//! Trust rules encoded here:
//!
//! - Only "pure asset" packs join the stack ([is_eligible]): PnF / schema /
//!   blueprint / loader payloads are code-loaded trees the game must not have
//!   shadowed file-by-file, so those records stay legacy installs.
//! - A ledger record that is NOT store-managed owns its paths; a render never
//!   overwrites them ([foreign_owners]) and counts them as blocked_foreign.
//! - A previous render's path is only removed when its bytes are provably a
//!   layer's copy (length + mtime); anything else is left in place with a
//!   warning, so a hand-edited or foreign-installed file is never destroyed.
//! - Every write is snapshotted into <data>/mods/layers/.restore/<gen>-<ms>/
//!   first and staged as <dest>.wowsp-part, and a failure anywhere rolls all
//!   previously written files back.

use anyhow::anyhow;
use std::collections::btree_map::Entry;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use wowsp_tauri_shared::{
    CommandResult, LayerClass, LayerPathWinner, LayerRenderReport, LayerSlotConflict, LayerStack,
    ModInstallRecord, ModLayer,
};

use crate::commands::game_context::same_folder;
use crate::commands::mod_catalog::ledger::{Ledger, load_ledger};

use super::latest_bin_version;

// ── constants ───────────────────────────────────────────────────────────────

/// <data>/mods/layer-stack.json — every root's saved order and render state.
const STATE_FILE: &str = "mods/layer-stack.json";
/// <data>/mods/layers/ — the store root (payload + manifests + .restore).
const LAYERS_DIR: &str = "mods/layers";
/// Snapshot area for files a render overwrites, relative to the store root.
const RESTORE_DIR: &str = ".restore";
/// On-disk schema of both the state file and a layer.json manifest.
const SCHEMA: u32 = 1;
/// Payload prefixes a pure-asset layer must not ship: the game hands those to
/// a loader / schema engine, so shadowing individual files would corrupt it.
const RESERVED_PREFIXES: &[&str] = &[
    "pnfmods/",
    "modschemas/",
    "forgeblueprints/",
    "gui/unbound2/",
];
/// The PnF loader marker itself (a root-level placeholder).
const RESERVED_FILE: &str = "pnfmodsloader.py";
/// Paths-report cap (the wire contract's defensive bound).
const PATHS_CAP: usize = 2000;

// ── state file ──────────────────────────────────────────────────────────────

/// The whole persisted layer state: one stack per game install.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayerState {
    #[serde(default = "schema_version")]
    schema: u32,
    /// Keyed by [root_key].
    #[serde(default)]
    stacks: BTreeMap<String, StackState>,
}

impl Default for LayerState {
    fn default() -> Self {
        Self {
            schema: SCHEMA,
            stacks: BTreeMap::new(),
        }
    }
}

fn schema_version() -> u32 {
    SCHEMA
}

/// One game install's saved stack.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StackState {
    /// Top (highest priority) first.
    #[serde(default)]
    layers: Vec<StackEntry>,
    /// True when the tree on disk matches this order (see [build_view]).
    #[serde(default)]
    rendered: bool,
    /// Monotonic render counter, bumped by every successful render.
    #[serde(default)]
    generation: u64,
    /// bin/<build> the last render targeted.
    #[serde(default)]
    bin_version: String,
    /// res_mods-relative paths the last render materialised (original case).
    #[serde(default)]
    rendered_paths: Vec<String>,
}

/// One saved layer: engine id + payload version + the user's toggle.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StackEntry {
    pack_id: String,
    version: String,
    #[serde(default = "enabled_default")]
    enabled: bool,
}

fn enabled_default() -> bool {
    true
}

/// <store>/<pack>/<version>/layer.json — what the store copy contains.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayerManifest {
    #[serde(default = "schema_version")]
    schema: u32,
    pack_id: String,
    #[serde(default)]
    name: String,
    version: String,
    #[serde(default)]
    category: String,
    layer_class: LayerClass,
    #[serde(default)]
    slots: Vec<String>,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    installed_at: String,
}

// ── path / store helpers ────────────────────────────────────────────────────

/// Comparison key: lowercase, forward slashes, no other rewriting.
fn normalize_key(rel: &str) -> String {
    rel.replace('\\', "/").to_lowercase()
}

/// Stable key of one game install inside the state file: lowercased and
/// separator-normalised (trailing separators dropped).
fn root_key(game_root: &str) -> String {
    let normalized = game_root.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_lowercase()
    }
}

/// Validate a res_mods-relative payload path and normalise its separators.
/// Rejects absolute paths, empty segments, traversal and drive/stream syntax —
/// record data is trusted for authentication, not for path safety.
fn safe_rel(rel: &str) -> Option<String> {
    let normalized = rel.replace('\\', "/");
    if normalized.is_empty() || normalized.starts_with('/') {
        return None;
    }
    let mut segments = Vec::new();
    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." || segment.contains(':') {
            return None;
        }
        segments.push(segment);
    }
    Some(segments.join("/"))
}

/// A filesystem-safe directory name for a pack id / version. Ids and versions
/// reach us from a remote catalog, so they can never become a path. A name
/// that had to be rewritten carries a short content hash, so two different ids
/// cannot collapse onto one store directory.
fn safe_component(raw: &str) -> String {
    let mut cleaned = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            cleaned.push(ch);
        } else {
            cleaned.push('_');
        }
    }
    let trimmed = cleaned.trim_matches('.');
    let mut safe = if trimmed.is_empty() {
        "item".to_string()
    } else {
        trimmed.to_string()
    };
    let stem = safe
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if is_windows_device_name(&stem) {
        safe.push('_');
    }
    if safe != raw {
        let digest = Sha256::digest(raw.as_bytes());
        safe.push('-');
        safe.push_str(&hex::encode(&digest[..4]));
    }
    safe
}

/// Windows reserved device names (a directory called CON is unusable).
fn is_windows_device_name(stem: &str) -> bool {
    matches!(stem, "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
        })
}

fn layers_root(data: &Path) -> PathBuf {
    data.join(LAYERS_DIR)
}

fn layer_root(data: &Path, pack_id: &str) -> PathBuf {
    layers_root(data).join(safe_component(pack_id))
}

fn layer_version_dir(data: &Path, pack_id: &str, version: &str) -> PathBuf {
    layer_root(data, pack_id).join(safe_component(version))
}

fn layer_files_dir(data: &Path, pack_id: &str, version: &str) -> PathBuf {
    layer_version_dir(data, pack_id, version).join("files")
}

fn manifest_path(data: &Path, pack_id: &str, version: &str) -> PathBuf {
    layer_version_dir(data, pack_id, version).join("layer.json")
}

fn state_path(data: &Path) -> PathBuf {
    data.join(STATE_FILE)
}

/// Does a store manifest exist for this pack version? "managed" in the public
/// model means exactly this: the payload can be re-rendered from our store.
fn has_manifest(data: &Path, pack_id: &str, version: &str) -> bool {
    manifest_path(data, pack_id, version).is_file()
}

/// Read a store manifest, rejecting one that names a different pack (a
/// collision fallback; [safe_component] already prevents it).
fn read_manifest(data: &Path, pack_id: &str, version: &str) -> Option<LayerManifest> {
    let path = manifest_path(data, pack_id, version);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == ErrorKind::NotFound => return None,
        Err(e) => {
            tracing::warn!(error = %e, path = %path.display(), "layer store manifest is unreadable");
            return None;
        },
    };
    match serde_json::from_str::<LayerManifest>(&raw) {
        Ok(manifest) if manifest.pack_id == pack_id => Some(manifest),
        Ok(manifest) => {
            tracing::warn!(
                expected = pack_id,
                found = %manifest.pack_id,
                path = %path.display(),
                "layer store manifest names another pack"
            );
            None
        },
        Err(e) => {
            tracing::warn!(error = %e, path = %path.display(), "layer store manifest is malformed");
            None
        },
    }
}

fn load_state(data: &Path) -> LayerState {
    let path = state_path(data);
    match fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<LayerState>(&raw) {
            Ok(state) => state,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    path = %path.display(),
                    "layer stack state is malformed — starting from an empty stack"
                );
                LayerState::default()
            },
        },
        Err(e) if e.kind() == ErrorKind::NotFound => LayerState::default(),
        Err(e) => {
            tracing::warn!(error = %e, path = %path.display(), "layer stack state is unreadable");
            LayerState::default()
        },
    }
}

fn save_state(data: &Path, state: &LayerState) -> anyhow::Result<()> {
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| anyhow!("serialize layer stack state: {e}"))?;
    crate::atomic_file::write(&state_path(data), &json)
}

// ── migration ───────────────────────────────────────────────────────────────

/// Install-order migration for a root the state file does not know yet: every
/// eligible ledger record becomes a layer, REVERSED (the ledger appends, so the
/// newest install ends up on top). Shared-component records are not packs.
fn migrate_stack(ledger: &Ledger, game_root: &str) -> StackState {
    let mut layers = Vec::new();
    for record in ledger.installs.iter().rev() {
        if record.id.starts_with("shared.") {
            continue;
        }
        if !record.game_root.is_empty() && !same_folder(&record.game_root, game_root) {
            continue;
        }
        let files = payload_files(record);
        if !is_eligible(&files) {
            continue;
        }
        layers.push(StackEntry {
            pack_id: record.id.clone(),
            version: record.version.clone(),
            enabled: true,
        });
    }
    StackState {
        layers,
        rendered: true,
        generation: 0,
        bin_version: latest_bin_version(game_root)
            .map(|(version, _)| version)
            .unwrap_or_default(),
        rendered_paths: Vec::new(),
    }
}

/// Ensure the state file carries a stack for game_root, migrating from the
/// ledger on first sight. Returns the state key.
fn ensure_stack_key(
    data: &Path,
    state: &mut LayerState,
    ledger: &Ledger,
    game_root: &str,
) -> anyhow::Result<String> {
    let key = root_key(game_root);
    let mut migrated = false;
    if let Entry::Vacant(slot) = state.stacks.entry(key.clone()) {
        migrated = true;
        slot.insert(migrate_stack(ledger, game_root));
    }
    if migrated {
        save_state(data, state)?;
    }
    Ok(key)
}

fn stack_mut<'a>(state: &'a mut LayerState, key: &str) -> anyhow::Result<&'a mut StackState> {
    state
        .stacks
        .get_mut(key)
        .ok_or_else(|| anyhow!("layer stack state lost its entry while reading"))
}

// ── payload / classification rules ──────────────────────────────────────────

/// The record's res_mods-relative payload, deduped and validated. Game-root
/// drops (@game/...) never enter the layer store — they are not res_mods
/// assets, and the stack only materialises the res_mods tree.
fn payload_files(record: &ModInstallRecord) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for raw in &record.files {
        let lower = raw.replace('\\', "/").to_ascii_lowercase();
        if lower.starts_with("@game/") {
            continue;
        }
        let Some(rel) = safe_rel(raw) else {
            continue;
        };
        if seen.insert(normalize_key(&rel)) {
            files.push(rel);
        }
    }
    files
}

/// Does this payload qualify as a pure-asset layer?
fn is_eligible(files: &[String]) -> bool {
    if files.is_empty() {
        return false;
    }
    !files.iter().any(|rel| {
        let key = normalize_key(rel);
        key == RESERVED_FILE
            || RESERVED_PREFIXES
                .iter()
                .any(|prefix| key.starts_with(prefix))
    })
}

/// Layer class + exclusive slots, derived from the payload (see the module
/// docs). Voice banks are banks/mods/<bank>/...; each bank is one in-game
/// voice slot, so two packs shipping the same bank are mutually exclusive.
fn classify(files: &[String]) -> (LayerClass, Vec<String>) {
    let mut additive = false;
    let mut banks = BTreeSet::new();
    for rel in files {
        let key = normalize_key(rel);
        if !key.starts_with("banks/") {
            continue;
        }
        additive = true;
        let Some(rest) = key.strip_prefix("banks/mods/") else {
            continue;
        };
        if let Some(bank) = rest.split('/').next() {
            if !bank.is_empty() {
                banks.insert(format!("voice:{bank}"));
            }
        }
    }
    if additive {
        (LayerClass::Additive, banks.into_iter().collect())
    } else {
        (LayerClass::Override, Vec::new())
    }
}

// ── resolution ──────────────────────────────────────────────────────────────

/// One stack layer with everything the view / render passes need.
#[derive(Debug, Clone)]
struct LayerData {
    pack_id: String,
    name: String,
    version: String,
    category: String,
    class: LayerClass,
    enabled: bool,
    managed: bool,
    slots: Vec<String>,
    /// res_mods-relative payload, original case, deduped by key.
    files: Vec<String>,
    /// Comparison keys of [Self::files].
    keys: HashSet<String>,
}

/// Resolve a saved entry against the store and the ledger. The store manifest
/// is authoritative for a managed layer; a legacy (unmanaged) layer falls back
/// to its ledger record's payload.
fn resolve_layer(data: &Path, ledger: &Ledger, game_root: &str, entry: &StackEntry) -> LayerData {
    let manifest = read_manifest(data, &entry.pack_id, &entry.version);
    let record = ledger.installs.iter().find(|record| {
        record.id == entry.pack_id
            && (record.game_root.is_empty() || same_folder(&record.game_root, game_root))
    });
    let files = match manifest.as_ref() {
        Some(manifest) => dedupe_files(&manifest.files),
        None => record.map(payload_files).unwrap_or_default(),
    };
    let derived = classify(&files);
    let (class, slots) = match manifest.as_ref() {
        Some(manifest) => (
            manifest.layer_class,
            if manifest.slots.is_empty() {
                derived.1
            } else {
                manifest.slots.clone()
            },
        ),
        None => derived,
    };
    let name = manifest
        .as_ref()
        .map(|manifest| manifest.name.clone())
        .filter(|name| !name.is_empty())
        .or_else(|| record.map(|record| record.name.clone()))
        .unwrap_or_else(|| entry.pack_id.clone());
    let category = manifest
        .as_ref()
        .map(|manifest| manifest.category.clone())
        .filter(|category| !category.is_empty())
        .or_else(|| record.map(|record| record.category.clone()))
        .unwrap_or_else(|| "local".to_string());
    let keys = files.iter().map(|rel| normalize_key(rel)).collect();
    LayerData {
        pack_id: entry.pack_id.clone(),
        name,
        version: entry.version.clone(),
        category,
        class,
        enabled: entry.enabled,
        managed: manifest.is_some(),
        slots,
        files,
        keys,
    }
}

fn dedupe_files(files: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in files {
        let Some(rel) = safe_rel(raw) else {
            continue;
        };
        if seen.insert(normalize_key(&rel)) {
            out.push(rel);
        }
    }
    out
}

fn resolve_layers(
    data: &Path,
    ledger: &Ledger,
    game_root: &str,
    stack: &StackState,
) -> Vec<LayerData> {
    stack
        .layers
        .iter()
        .map(|entry| resolve_layer(data, ledger, game_root, entry))
        .collect()
}

/// Winner index per comparison key among ENABLED managed layers, top-down.
fn winner_index(layers: &[LayerData]) -> HashMap<String, usize> {
    let mut winners = HashMap::new();
    for (index, layer) in layers.iter().enumerate() {
        if !layer.enabled || !layer.managed {
            continue;
        }
        for rel in &layer.files {
            winners.entry(normalize_key(rel)).or_insert(index);
        }
    }
    winners
}

/// Render winners in stack order: the top enabled managed layer providing each
/// key, with the store file that supplies it.
fn winner_entries(data: &Path, layers: &[LayerData]) -> Vec<Winner> {
    let mut seen = HashSet::new();
    let mut winners = Vec::new();
    for layer in layers {
        if !layer.enabled || !layer.managed {
            continue;
        }
        let files_dir = layer_files_dir(data, &layer.pack_id, &layer.version);
        for rel in &layer.files {
            let key = normalize_key(rel);
            if !seen.insert(key.clone()) {
                continue;
            }
            winners.push(Winner {
                key,
                rel: rel.clone(),
                pack_id: layer.pack_id.clone(),
                store: files_dir.join(rel),
            });
        }
    }
    winners
}

#[derive(Debug, Clone)]
struct Winner {
    key: String,
    rel: String,
    pack_id: String,
    store: PathBuf,
}

/// Paths owned by ledger records that are NOT store-managed. A render must
/// never overwrite them; they are counted as blocked_foreign. Only records of
/// the live build matter: a stale record keyed at another bin/<build> describes
/// physically different files.
fn foreign_owners(
    data: &Path,
    ledger: &Ledger,
    game_root: &str,
    bin_version: &str,
) -> HashMap<String, String> {
    let mut owners = HashMap::new();
    for record in &ledger.installs {
        if record.bin_version != bin_version {
            continue;
        }
        if !record.game_root.is_empty() && !same_folder(&record.game_root, game_root) {
            continue;
        }
        if has_manifest(data, &record.id, &record.version) {
            continue;
        }
        for rel in payload_files(record) {
            owners
                .entry(normalize_key(&rel))
                .or_insert_with(|| record.id.clone());
        }
    }
    owners
}

// ── public view ─────────────────────────────────────────────────────────────

fn build_view(data: &Path, ledger: &Ledger, game_root: &str, stack: &StackState) -> LayerStack {
    let layers = resolve_layers(data, ledger, game_root, stack);
    let winners = winner_index(&layers);
    let current_bin = latest_bin_version(game_root).map(|(version, _)| version);

    let mut slot_claims: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut rendered_layers = Vec::with_capacity(layers.len());
    for (index, layer) in layers.iter().enumerate() {
        let mut winning = 0u32;
        let mut shadowed = 0u32;
        for rel in &layer.files {
            match winners.get(&normalize_key(rel)) {
                Some(&winner) if winner == index => winning += 1,
                Some(&winner) if winner < index => shadowed += 1,
                _ => {},
            }
        }
        // The nearest layer ABOVE that shares any file with this one.
        let covered_by = (0..index)
            .rev()
            .find(|above| {
                layers[*above]
                    .keys
                    .iter()
                    .any(|key| layer.keys.contains(key))
            })
            .map(|above| layers[above].pack_id.clone());
        if layer.enabled {
            for slot in &layer.slots {
                slot_claims
                    .entry(slot.clone())
                    .or_default()
                    .push(layer.pack_id.clone());
            }
        }
        rendered_layers.push(ModLayer {
            pack_id: layer.pack_id.clone(),
            name: layer.name.clone(),
            version: layer.version.clone(),
            category: layer.category.clone(),
            layer_class: layer.class,
            enabled: layer.enabled,
            priority: u32::try_from(index).unwrap_or(u32::MAX),
            slots: layer.slots.clone(),
            file_count: u32::try_from(layer.files.len()).unwrap_or(u32::MAX),
            winning_count: winning,
            shadowed_count: shadowed,
            covered_by,
            managed: layer.managed,
        });
    }

    let slot_conflicts = slot_claims
        .into_iter()
        .filter(|(_, pack_ids)| pack_ids.len() >= 2)
        .map(|(slot, pack_ids)| LayerSlotConflict { slot, pack_ids })
        .collect();

    LayerStack {
        layers: rendered_layers,
        rendered: stack.rendered && current_bin.as_deref() == Some(stack.bin_version.as_str()),
        generation: stack.generation,
        slot_conflicts,
        game_version: current_bin,
    }
}

fn view_stack(data: &Path, ledger: &Ledger, game_root: &str) -> anyhow::Result<LayerStack> {
    let mut state = load_state(data);
    let key = ensure_stack_key(data, &mut state, ledger, game_root)?;
    let stack = state
        .stacks
        .get(&key)
        .ok_or_else(|| anyhow!("layer stack state lost its entry while reading"))?;
    Ok(build_view(data, ledger, game_root, stack))
}

// ── mutations ───────────────────────────────────────────────────────────────

/// set_order: persist a new top-to-bottom order. Only store-managed layers
/// move: unmanaged legacy layers are pinned at the end, and ids the store does
/// not know are ignored.
fn set_order_in(
    data: &Path,
    ledger: &Ledger,
    game_root: &str,
    pack_ids: &[String],
) -> anyhow::Result<LayerStack> {
    let mut state = load_state(data);
    let key = ensure_stack_key(data, &mut state, ledger, game_root)?;
    {
        let stack = stack_mut(&mut state, &key)?;
        let managed: Vec<bool> = stack
            .layers
            .iter()
            .map(|entry| has_manifest(data, &entry.pack_id, &entry.version))
            .collect();
        let mut placed = vec![false; stack.layers.len()];
        let mut order: Vec<usize> = Vec::with_capacity(stack.layers.len());
        for id in pack_ids {
            let Some(index) = stack.layers.iter().position(|entry| &entry.pack_id == id) else {
                continue;
            };
            if managed[index] && !placed[index] {
                placed[index] = true;
                order.push(index);
            }
        }
        for (index, is_managed) in managed.iter().copied().enumerate() {
            if is_managed && !placed[index] {
                placed[index] = true;
                order.push(index);
            }
        }
        for (index, is_managed) in managed.iter().copied().enumerate() {
            if !is_managed {
                order.push(index);
            }
        }
        let reordered: Vec<StackEntry> = order
            .into_iter()
            .map(|index| stack.layers[index].clone())
            .collect();
        stack.layers = reordered;
        stack.rendered = false;
    }
    save_state(data, &state)?;
    view_stack(data, ledger, game_root)
}

/// set_enabled: toggle one layer. An unknown id is a no-op returning the
/// current view, per the wire contract.
fn set_enabled_in(
    data: &Path,
    ledger: &Ledger,
    game_root: &str,
    pack_id: &str,
    enabled: bool,
) -> anyhow::Result<LayerStack> {
    let mut state = load_state(data);
    let key = ensure_stack_key(data, &mut state, ledger, game_root)?;
    let found = {
        let stack = stack_mut(&mut state, &key)?;
        match stack
            .layers
            .iter_mut()
            .find(|entry| entry.pack_id == pack_id)
        {
            Some(entry) => {
                entry.enabled = enabled;
                stack.rendered = false;
                true
            },
            None => false,
        }
    };
    if found {
        save_state(data, &state)?;
    }
    view_stack(data, ledger, game_root)
}

/// Drop a pack's whole store directory. Returns whether anything was removed.
fn drop_pack_store(data: &Path, pack_id: &str) -> bool {
    let dir = layer_root(data, pack_id);
    match fs::remove_dir_all(&dir) {
        Ok(()) => true,
        Err(e) if e.kind() == ErrorKind::NotFound => false,
        Err(e) => {
            tracing::warn!(error = %e, path = %dir.display(), "layer store: could not remove pack directory");
            false
        },
    }
}

fn drop_stack_entry(stack: &mut StackState, pack_id: &str) -> bool {
    let before = stack.layers.len();
    stack.layers.retain(|entry| entry.pack_id != pack_id);
    stack.layers.len() != before
}

// ── adoption / uninstall hooks ──────────────────────────────────────────────

/// Copy one install's res_mods payload into the store and put the layer on top
/// of the stack. Best effort by contract: any failure warns and leaves the
/// pre-existing state alone.
fn adopt_install_in(
    data: &Path,
    ledger: &Ledger,
    game_root: &str,
    record: &ModInstallRecord,
) -> anyhow::Result<()> {
    if record.id.starts_with("shared.") {
        return Ok(());
    }
    let files = payload_files(record);
    let mut state = load_state(data);
    let key = ensure_stack_key(data, &mut state, ledger, game_root)?;

    if !is_eligible(&files) {
        // A pack that is not (or no longer) pure assets must not keep a stale
        // store copy: its record still drives the legacy install path.
        let removed_store = drop_pack_store(data, &record.id);
        let removed_entry = {
            let stack = stack_mut(&mut state, &key)?;
            let removed = drop_stack_entry(stack, &record.id);
            if removed {
                stack.rendered = false;
            }
            removed
        };
        if removed_store || removed_entry {
            save_state(data, &state)?;
        }
        return Ok(());
    }

    let res_mods = Path::new(game_root)
        .join("bin")
        .join(&record.bin_version)
        .join("res_mods");
    let files_dir = layer_files_dir(data, &record.id, &record.version);
    if files_dir.exists() {
        fs::remove_dir_all(&files_dir)
            .map_err(|e| anyhow!("replace layer store copy {}: {e}", files_dir.display()))?;
    }
    fs::create_dir_all(&files_dir)
        .map_err(|e| anyhow!("create layer store copy {}: {e}", files_dir.display()))?;

    let mut stored = Vec::new();
    for rel in &files {
        let src = res_mods.join(rel);
        if !src.is_file() {
            tracing::warn!(
                pack = %record.id,
                file = %rel,
                "layer store: installed file is missing — skipped"
            );
            continue;
        }
        let dst = files_dir.join(rel);
        let Some(parent) = dst.parent() else {
            continue;
        };
        if let Err(e) = fs::create_dir_all(parent) {
            tracing::warn!(error = %e, path = %parent.display(), "layer store: could not create directory");
            continue;
        }
        if dst.exists() {
            let _ = fs::remove_file(&dst);
        }
        // Hard-link when possible: zero copy, and the store file shares the
        // installed file's bytes until the next render replaces the live one.
        match fs::hard_link(&src, &dst) {
            Ok(()) => stored.push(rel.clone()),
            Err(_) => match fs::copy(&src, &dst) {
                Ok(_) => stored.push(rel.clone()),
                Err(e) => tracing::warn!(
                    error = %e,
                    file = %rel,
                    "layer store: could not copy installed file"
                ),
            },
        }
    }

    if stored.is_empty() {
        tracing::warn!(
            pack = %record.id,
            "layer store: no payload could be copied — the pack stays a legacy install"
        );
        let _ = fs::remove_dir_all(layer_version_dir(data, &record.id, &record.version));
        return Ok(());
    }

    let (layer_class, slots) = classify(&stored);
    let manifest = LayerManifest {
        schema: SCHEMA,
        pack_id: record.id.clone(),
        name: record.name.clone(),
        version: record.version.clone(),
        category: record.category.clone(),
        layer_class,
        slots,
        files: stored.clone(),
        installed_at: record.installed_at.clone(),
    };
    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| anyhow!("serialize layer manifest: {e}"))?;
    crate::atomic_file::write(&manifest_path(data, &record.id, &record.version), &json)?;
    prune_other_versions(data, &record.id, &record.version);

    {
        let stack = stack_mut(&mut state, &key)?;
        // An update keeps the user's toggle; a first adoption defaults to on.
        let enabled = stack
            .layers
            .iter()
            .find(|entry| entry.pack_id == record.id)
            .map(|entry| entry.enabled)
            .unwrap_or(true);
        stack.layers.retain(|entry| entry.pack_id != record.id);
        stack.layers.insert(
            0,
            StackEntry {
                pack_id: record.id.clone(),
                version: record.version.clone(),
                enabled,
            },
        );
        stack.rendered = true;
        stack.bin_version = record.bin_version.clone();
        let mut known: HashSet<String> = stack
            .rendered_paths
            .iter()
            .map(|rel| normalize_key(rel))
            .collect();
        for rel in &stored {
            if known.insert(normalize_key(rel)) {
                stack.rendered_paths.push(rel.clone());
            }
        }
    }
    save_state(data, &state)?;
    tracing::info!(pack = %record.id, files = stored.len(), "layer store adopted install");
    Ok(())
}

/// Remove store versions other than keep (an update's old payload).
fn prune_other_versions(data: &Path, pack_id: &str, keep: &str) {
    let root = layer_root(data, pack_id);
    let keep = safe_component(keep);
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy() == keep {
            continue;
        }
        if entry.path().is_dir() {
            if let Err(e) = fs::remove_dir_all(entry.path()) {
                tracing::warn!(
                    error = %e,
                    path = %entry.path().display(),
                    "layer store: could not prune an old payload version"
                );
            }
        }
    }
}

fn on_uninstall_in(
    data: &Path,
    ledger: &Ledger,
    game_root: &str,
    record: &ModInstallRecord,
) -> anyhow::Result<()> {
    if record.id.starts_with("shared.") {
        return Ok(());
    }
    drop_pack_store(data, &record.id);
    let mut state = load_state(data);
    let key = ensure_stack_key(data, &mut state, ledger, game_root)?;
    {
        let stack = stack_mut(&mut state, &key)?;
        drop_stack_entry(stack, &record.id);
        stack.rendered = false;
    }
    save_state(data, &state)
}

// ── render ──────────────────────────────────────────────────────────────────

enum WriteAction {
    /// The destination existed; the snapshot holds its pre-render bytes.
    Replaced { dest: PathBuf, snapshot: PathBuf },
    /// The destination is new for this stack.
    Created { dest: PathBuf },
}

fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.as_os_str().to_os_string();
    name.push(super::PART_SUFFIX);
    PathBuf::from(name)
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0)
}

/// Cheap identity check: same length and same last-write time. This is the
/// "provably our rendered file" test the deletion pass requires.
fn same_len_mtime(a: &Path, b: &Path) -> bool {
    let (Ok(left), Ok(right)) = (fs::metadata(a), fs::metadata(b)) else {
        return false;
    };
    if !left.is_file() || !right.is_file() || left.len() != right.len() {
        return false;
    }
    left.modified().ok() == right.modified().ok()
}

/// "Already in place" check for the write pass: length first, then mtime as a
/// shortcut, and a byte comparison when the timestamps disagree (a copied file
/// need not preserve them).
fn same_bytes(a: &Path, b: &Path) -> bool {
    let (Ok(left), Ok(right)) = (fs::metadata(a), fs::metadata(b)) else {
        return false;
    };
    if !left.is_file() || !right.is_file() || left.len() != right.len() {
        return false;
    }
    if left.modified().ok() == right.modified().ok() {
        return true;
    }
    match (fs::read(a), fs::read(b)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// Snapshot the destination (when it exists), then stage the store copy as
/// <dest>.wowsp-part and rename it into place. The journal records how to undo
/// this write.
fn write_one(
    src: &Path,
    dest: &Path,
    restore_root: &Path,
    rel: &str,
    journal: &mut Vec<WriteAction>,
) -> anyhow::Result<()> {
    if dest.exists() {
        let snapshot = restore_root.join(rel);
        if let Some(parent) = snapshot.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| anyhow!("create snapshot directory {}: {e}", parent.display()))?;
        }
        fs::copy(dest, &snapshot).map_err(|e| anyhow!("snapshot {}: {e}", dest.display()))?;
        journal.push(WriteAction::Replaced {
            dest: dest.to_path_buf(),
            snapshot,
        });
    } else {
        journal.push(WriteAction::Created {
            dest: dest.to_path_buf(),
        });
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| anyhow!("create destination directory {}: {e}", parent.display()))?;
    }
    let part = part_path(dest);
    fs::copy(src, &part).map_err(|e| anyhow!("stage {}: {e}", part.display()))?;
    if let Err(e) = fs::rename(&part, dest) {
        let _ = fs::remove_file(&part);
        return Err(anyhow!("replace {}: {e}", dest.display()));
    }
    Ok(())
}

/// Undo every write this render performed, newest first.
fn rollback(journal: &[WriteAction]) {
    for action in journal.iter().rev() {
        match action {
            WriteAction::Replaced { dest, snapshot } => {
                if let Err(e) = fs::copy(snapshot, dest) {
                    tracing::warn!(
                        error = %e,
                        path = %dest.display(),
                        "layer render rollback: could not restore snapshot"
                    );
                }
            },
            WriteAction::Created { dest } => {
                let _ = fs::remove_file(dest);
            },
        }
    }
}

/// Is dest provably one of the stack's own store copies at key? Only those
/// files may be removed when a render drops their winner.
fn store_copy_matches(data: &Path, layers: &[LayerData], key: &str, dest: &Path) -> bool {
    for layer in layers {
        if !layer.managed {
            continue;
        }
        let files_dir = layer_files_dir(data, &layer.pack_id, &layer.version);
        for rel in &layer.files {
            if normalize_key(rel) != key {
                continue;
            }
            if same_len_mtime(&files_dir.join(rel), dest) {
                return true;
            }
        }
    }
    false
}

fn render_in(data: &Path, ledger: &Ledger, game_root: &str) -> anyhow::Result<LayerRenderReport> {
    let mut state = load_state(data);
    let key = ensure_stack_key(data, &mut state, ledger, game_root)?;
    let (bin_version, bin_dir) = latest_bin_version(game_root)
        .ok_or_else(|| anyhow!("no numeric bin/<version> under {game_root}\\bin"))?;
    let res_mods = bin_dir.join("res_mods");
    fs::create_dir_all(&res_mods).map_err(|e| anyhow!("create {}: {e}", res_mods.display()))?;

    let stack = state
        .stacks
        .get(&key)
        .ok_or_else(|| anyhow!("layer stack state lost its entry while reading"))?
        .clone();
    let layers = resolve_layers(data, ledger, game_root, &stack);
    let winners = winner_entries(data, &layers);
    let owners = foreign_owners(data, ledger, game_root, &bin_version);

    let generation = stack.generation.saturating_add(1);
    let restore_root = layers_root(data)
        .join(RESTORE_DIR)
        .join(format!("{generation}-{}", now_millis()));

    let mut report = LayerRenderReport {
        written: 0,
        removed: 0,
        unchanged: 0,
        blocked_foreign: 0,
        warnings: Vec::new(),
        generation,
    };
    let mut journal: Vec<WriteAction> = Vec::new();
    let mut written_rels: Vec<String> = Vec::new();
    let mut removed_rels: Vec<String> = Vec::new();
    let mut rendered_paths: Vec<String> = Vec::new();

    for winner in &winners {
        if owners.contains_key(&winner.key) {
            // A legacy install owns this path: never overwrite it.
            report.blocked_foreign += 1;
            continue;
        }
        if !winner.store.is_file() {
            report.warnings.push(format!(
                "layer \"{}\" has no stored copy of {} — the path was skipped",
                winner.pack_id, winner.rel
            ));
            continue;
        }
        let dest = res_mods.join(&winner.rel);
        if dest.is_dir() {
            report.warnings.push(format!(
                "{} is a directory in the game tree — left in place",
                winner.rel
            ));
            continue;
        }
        if same_bytes(&winner.store, &dest) {
            report.unchanged += 1;
            rendered_paths.push(winner.rel.clone());
            continue;
        }
        match write_one(
            &winner.store,
            &dest,
            &restore_root,
            &winner.rel,
            &mut journal,
        ) {
            Ok(()) => {
                report.written += 1;
                rendered_paths.push(winner.rel.clone());
                written_rels.push(winner.rel.clone());
            },
            Err(e) => {
                rollback(&journal);
                return Err(e);
            },
        }
    }

    // Drop paths the previous render produced whose winner is gone — but only
    // when the bytes on disk are provably a store copy (length + mtime).
    let winner_keys: HashSet<&str> = winners.iter().map(|winner| winner.key.as_str()).collect();
    for rel in &stack.rendered_paths {
        let path_key = normalize_key(rel);
        if winner_keys.contains(path_key.as_str()) {
            continue;
        }
        let dest = res_mods.join(rel);
        if !dest.is_file() {
            continue;
        }
        if !store_copy_matches(data, &layers, &path_key, &dest) {
            report.warnings.push(format!(
                "{rel} is no longer provided by the stack but its bytes match no layer copy — left in place"
            ));
            // Keep tracking it so a later pass can retry the proof.
            rendered_paths.push(rel.clone());
            continue;
        }
        match fs::remove_file(&dest) {
            Ok(()) => {
                report.removed += 1;
                removed_rels.push(rel.clone());
            },
            Err(e) => {
                report
                    .warnings
                    .push(format!("remove {}: {e}", dest.display()));
                rendered_paths.push(rel.clone());
            },
        }
    }
    if !removed_rels.is_empty() {
        super::unit_ops::prune_empty_parents(&res_mods, &removed_rels);
    }

    rendered_paths.sort_by_cached_key(|rel| normalize_key(rel));
    rendered_paths.dedup_by(|left, right| normalize_key(left) == normalize_key(right));

    {
        let stack = stack_mut(&mut state, &key)?;
        stack.rendered = true;
        stack.generation = generation;
        stack.bin_version = bin_version;
        stack.rendered_paths = rendered_paths;
    }
    save_state(data, &state)?;

    let mirror = super::preload_mirror::mirror_written(game_root, &res_mods, &written_rels);
    report.warnings.extend(mirror.warnings);
    if !removed_rels.is_empty() {
        super::preload_mirror::mirror_removed(game_root, &removed_rels);
    }
    tracing::info!(
        written = report.written,
        removed = report.removed,
        unchanged = report.unchanged,
        blocked = report.blocked_foreign,
        generation = report.generation,
        "layer render pass finished"
    );
    Ok(report)
}

/// Render pass entry point (shared by the command and the engine tests).
pub(crate) fn render_engine(game_root: &str) -> anyhow::Result<LayerRenderReport> {
    let data = crate::paths::ensure_data_dir()?;
    let ledger = load_ledger();
    render_in(&data, &ledger, game_root)
}

// ── per-path report ─────────────────────────────────────────────────────────

fn path_report(
    data: &Path,
    ledger: &Ledger,
    game_root: &str,
) -> anyhow::Result<Vec<LayerPathWinner>> {
    let mut state = load_state(data);
    let key = ensure_stack_key(data, &mut state, ledger, game_root)?;
    let stack = state
        .stacks
        .get(&key)
        .ok_or_else(|| anyhow!("layer stack state lost its entry while reading"))?
        .clone();
    let layers = resolve_layers(data, ledger, game_root, &stack);
    let bin = latest_bin_version(game_root);
    let res_mods = bin.as_ref().map(|(_, dir)| dir.join("res_mods"));
    let owners = match bin.as_ref() {
        Some((bin_version, _)) => foreign_owners(data, ledger, game_root, bin_version),
        None => HashMap::new(),
    };
    let rendered: HashSet<String> = stack
        .rendered_paths
        .iter()
        .map(|rel| normalize_key(rel))
        .collect();

    // key -> (providing layer indexes top-down, first original spelling)
    let mut providers: BTreeMap<String, (Vec<usize>, String)> = BTreeMap::new();
    for (index, layer) in layers.iter().enumerate() {
        for rel in &layer.files {
            let path_key = normalize_key(rel);
            providers
                .entry(path_key)
                .or_insert_with(|| (Vec::new(), rel.clone()))
                .0
                .push(index);
        }
    }

    let mut out = Vec::new();
    for (path, (indices, spelling)) in providers {
        let winner = indices
            .iter()
            .copied()
            .find(|index| layers[*index].enabled && layers[*index].managed);
        let mut shadowed = Vec::new();
        for &index in &indices {
            if Some(index) == winner {
                continue;
            }
            shadowed.push(layers[index].pack_id.clone());
        }
        let foreign = res_mods
            .as_ref()
            .is_some_and(|root| root.join(&spelling).is_file())
            && !owners.contains_key(&path)
            && !rendered.contains(&path);
        if indices.len() < 2 && !foreign {
            continue;
        }
        out.push(LayerPathWinner {
            path,
            pack_id: winner.map(|index| layers[index].pack_id.clone()),
            shadowed,
            foreign,
        });
        if out.len() >= PATHS_CAP {
            break;
        }
    }
    Ok(out)
}

// ── commands ────────────────────────────────────────────────────────────────

/// The saved stack of one install (read-only; migration runs on first sight).
#[tauri::command]
pub async fn mod_hub_layer_stack(game_root: String) -> CommandResult<LayerStack> {
    let data = crate::paths::ensure_data_dir()?;
    let ledger = load_ledger();
    Ok(view_stack(&data, &ledger, &game_root)?)
}

/// Persist a new top-to-bottom order (managed layers only; legacy layers stay
/// pinned at the end). Marks the stack as needing a render.
#[tauri::command]
pub async fn mod_hub_layer_set_order(
    game_root: String,
    pack_ids: Vec<String>,
) -> CommandResult<LayerStack> {
    let _gate = crate::commands::mod_catalog::mod_hub_gate().await;
    let data = crate::paths::ensure_data_dir()?;
    let ledger = load_ledger();
    Ok(set_order_in(&data, &ledger, &game_root, &pack_ids)?)
}

/// Toggle one layer. Unknown ids are a no-op returning the current view.
#[tauri::command]
pub async fn mod_hub_layer_set_enabled(
    game_root: String,
    pack_id: String,
    enabled: bool,
) -> CommandResult<LayerStack> {
    let _gate = crate::commands::mod_catalog::mod_hub_gate().await;
    let data = crate::paths::ensure_data_dir()?;
    let ledger = load_ledger();
    Ok(set_enabled_in(
        &data, &ledger, &game_root, &pack_id, enabled,
    )?)
}

/// Materialise the saved order into res_mods. Refused while the game runs or
/// while safe mode quarantined the tree.
#[tauri::command]
pub async fn mod_hub_layer_render(game_root: String) -> CommandResult<LayerRenderReport> {
    let _gate = crate::commands::mod_catalog::mod_hub_gate().await;
    super::ensure_game_closed(&game_root)?;
    super::ensure_res_mods_active(&game_root)?;
    let root = game_root;
    let report = tauri::async_runtime::spawn_blocking(move || render_engine(&root))
        .await
        .map_err(|e| anyhow!("layer render task failed: {e}"))??;
    Ok(report)
}

/// Per-path conflict report of the saved stack (read-only).
#[tauri::command]
pub async fn mod_hub_layer_paths(game_root: String) -> CommandResult<Vec<LayerPathWinner>> {
    let data = crate::paths::ensure_data_dir()?;
    let ledger = load_ledger();
    Ok(path_report(&data, &ledger, &game_root)?)
}

/// Hook: an install just committed its record. Adopt the payload into the
/// layer store and put the new layer on top. Best effort only.
pub(crate) fn adopt_install(game_root: &str, record: &ModInstallRecord) {
    let data = match crate::paths::ensure_data_dir() {
        Ok(data) => data,
        Err(e) => {
            tracing::warn!(error = %e, pack = %record.id, "layer store: data dir unavailable — install not adopted");
            return;
        },
    };
    let ledger = load_ledger();
    if let Err(e) = adopt_install_in(&data, &ledger, game_root, record) {
        tracing::warn!(
            error = %e,
            pack = %record.id,
            "layer store: adoption failed — the pack stays a legacy install"
        );
    }
}

/// Hook: an uninstall removed its record. Drop the store copy and the layer,
/// leaving the stack pending a render so a lower layer can take over.
pub(crate) fn on_uninstall(game_root: &str, record: &ModInstallRecord) {
    let data = match crate::paths::ensure_data_dir() {
        Ok(data) => data,
        Err(e) => {
            tracing::warn!(error = %e, pack = %record.id, "layer store: data dir unavailable — uninstall not mirrored");
            return;
        },
    };
    let ledger = load_ledger();
    if let Err(e) = on_uninstall_in(&data, &ledger, game_root, record) {
        tracing::warn!(
            error = %e,
            pack = %record.id,
            "layer store: uninstall cleanup failed"
        );
    }
}

// ── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wowsp_layer_{name}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create fixture root");
        dir
    }

    fn make_game(root: &Path) {
        fs::create_dir_all(root.join("bin/1/idx")).expect("create idx");
        fs::create_dir_all(root.join("bin/1/res_mods")).expect("create res_mods");
    }

    fn res_mods(root: &Path) -> PathBuf {
        root.join("bin/1/res_mods")
    }

    /// Write a live file, breaking any store hard link first (an adopt/render
    /// may share the inode with the store copy).
    fn write_live(root: &Path, rel: &str, bytes: &str) {
        let path = res_mods(root).join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create live parent");
        }
        let _ = fs::remove_file(&path);
        fs::write(&path, bytes).expect("write live file");
    }

    fn read_live(root: &Path, rel: &str) -> String {
        fs::read_to_string(res_mods(root).join(rel)).expect("read live file")
    }

    fn record(id: &str, name: &str, version: &str, root: &str, files: &[&str]) -> ModInstallRecord {
        ModInstallRecord {
            id: id.to_string(),
            name: name.to_string(),
            version: version.to_string(),
            category: "skin".to_string(),
            source: "mod-hub".to_string(),
            discussion: None,
            preset: None,
            bin_version: "1".to_string(),
            installed_at: "2026-01-01T00:00:00Z".to_string(),
            files: files.iter().map(|file| (*file).to_string()).collect(),
            restore_dir: None,
            game_root: root.to_string(),
            hashes: None,
            snapshot_hashes: None,
            shared_roots: Vec::new(),
        }
    }

    fn stack_ids(stack: &LayerStack) -> Vec<&str> {
        stack
            .layers
            .iter()
            .map(|layer| layer.pack_id.as_str())
            .collect()
    }

    #[test]
    fn migration_puts_the_newest_install_on_top() {
        let tmp = fixture("migration");
        let game = tmp.join("game");
        make_game(&game);
        let data = tmp.join("data");
        fs::create_dir_all(&data).unwrap();
        let root = game.to_string_lossy().into_owned();

        let first = record("pack-first", "First", "1.0.0", &root, &["gui/first.txt"]);
        let second = record("pack-second", "Second", "1.0.0", &root, &["gui/second.txt"]);
        let shared = record(
            "shared.ttaro",
            "Shared",
            "1.0.0",
            &root,
            &["gui/shared.txt"],
        );
        let pnf = record("pack-pnf", "PnF", "1.0.0", &root, &["PnFMods/Main.py"]);
        let ledger = Ledger {
            installs: vec![first, second, shared, pnf],
        };

        let stack = view_stack(&data, &ledger, &root).expect("view");
        assert_eq!(stack_ids(&stack), ["pack-second", "pack-first"]);
        assert!(stack.rendered, "migration starts with a clean render state");
        assert_eq!(stack.game_version.as_deref(), Some("1"));
        assert!(stack.layers.iter().all(|layer| !layer.managed));
        assert!(
            data.join(STATE_FILE).is_file(),
            "migration persists the state"
        );
    }

    #[test]
    fn reorder_changes_the_rendered_bytes() {
        let tmp = fixture("reorder");
        let game = tmp.join("game");
        make_game(&game);
        let data = tmp.join("data");
        fs::create_dir_all(&data).unwrap();
        let root = game.to_string_lossy().into_owned();
        let ledger = Ledger {
            installs: Vec::new(),
        };

        write_live(&game, "gui/tex.txt", "bytes-from-a");
        let a = record("pack-a", "A", "1.0.0", &root, &["gui/tex.txt"]);
        adopt_install_in(&data, &ledger, &root, &a).expect("adopt a");

        write_live(&game, "gui/tex.txt", "bytes-from-b");
        let b = record("pack-b", "B", "1.0.0", &root, &["gui/tex.txt"]);
        adopt_install_in(&data, &ledger, &root, &b).expect("adopt b");

        let stack = view_stack(&data, &ledger, &root).expect("view");
        assert_eq!(stack_ids(&stack), ["pack-b", "pack-a"]);

        let reordered = set_order_in(
            &data,
            &ledger,
            &root,
            &["pack-a".to_string(), "pack-b".to_string()],
        )
        .expect("set order");
        assert_eq!(stack_ids(&reordered), ["pack-a", "pack-b"]);
        assert!(!reordered.rendered, "reordering leaves a render pending");

        let report = render_in(&data, &ledger, &root).expect("render");
        assert_eq!(report.written, 1, "{report:?}");
        assert_eq!(read_live(&game, "gui/tex.txt"), "bytes-from-a");

        // And back: the bottom layer's bytes reappear.
        set_order_in(
            &data,
            &ledger,
            &root,
            &["pack-b".to_string(), "pack-a".to_string()],
        )
        .expect("set order back");
        render_in(&data, &ledger, &root).expect("render back");
        assert_eq!(read_live(&game, "gui/tex.txt"), "bytes-from-b");
    }

    #[test]
    fn disabling_the_top_layer_falls_through_to_the_layer_below() {
        let tmp = fixture("disable");
        let game = tmp.join("game");
        make_game(&game);
        let data = tmp.join("data");
        fs::create_dir_all(&data).unwrap();
        let root = game.to_string_lossy().into_owned();
        let ledger = Ledger {
            installs: Vec::new(),
        };

        write_live(&game, "gui/tex.txt", "bytes-from-a");
        adopt_install_in(
            &data,
            &ledger,
            &root,
            &record("pack-a", "A", "1.0.0", &root, &["gui/tex.txt"]),
        )
        .expect("adopt a");
        write_live(&game, "gui/tex.txt", "bytes-from-b");
        adopt_install_in(
            &data,
            &ledger,
            &root,
            &record("pack-b", "B", "1.0.0", &root, &["gui/tex.txt"]),
        )
        .expect("adopt b");

        render_in(&data, &ledger, &root).expect("render b");
        assert_eq!(read_live(&game, "gui/tex.txt"), "bytes-from-b");

        let stack = set_enabled_in(&data, &ledger, &root, "pack-b", false).expect("disable b");
        assert!(!stack.rendered);
        let report = render_in(&data, &ledger, &root).expect("render a");
        assert_eq!(report.written, 1, "{report:?}");
        assert_eq!(read_live(&game, "gui/tex.txt"), "bytes-from-a");
    }

    #[test]
    fn a_non_layer_ledger_owner_blocks_a_write() {
        let tmp = fixture("blocked");
        let game = tmp.join("game");
        make_game(&game);
        let data = tmp.join("data");
        fs::create_dir_all(&data).unwrap();
        let root = game.to_string_lossy().into_owned();
        let ledger = Ledger {
            installs: Vec::new(),
        };

        write_live(&game, "gui/tex.txt", "bytes-from-layer");
        let layer = record("pack-a", "A", "1.0.0", &root, &["gui/tex.txt"]);
        adopt_install_in(&data, &ledger, &root, &layer).expect("adopt");

        // A managed record must never block its own layer's write.
        write_live(&game, "gui/tex.txt", "bytes-from-legacy");
        let only_layer = Ledger {
            installs: vec![layer.clone()],
        };
        let report = render_in(&data, &only_layer, &root).expect("render layer");
        assert_eq!(report.written, 1, "{report:?}");
        assert_eq!(read_live(&game, "gui/tex.txt"), "bytes-from-layer");

        // A legacy install (no store manifest) now owns the same path.
        write_live(&game, "gui/tex.txt", "bytes-from-legacy");
        let legacy = record("legacy-pack", "Legacy", "0.9.0", &root, &["gui/tex.txt"]);
        let ledger = Ledger {
            installs: vec![layer, legacy],
        };

        let report = render_in(&data, &ledger, &root).expect("render");
        assert_eq!(report.blocked_foreign, 1, "{report:?}");
        assert_eq!(report.written, 0, "{report:?}");
        assert_eq!(read_live(&game, "gui/tex.txt"), "bytes-from-legacy");
    }

    #[test]
    fn provable_deletion_leaves_a_foreign_file_intact() {
        let tmp = fixture("deletion");
        let game = tmp.join("game");
        make_game(&game);
        let data = tmp.join("data");
        fs::create_dir_all(&data).unwrap();
        let root = game.to_string_lossy().into_owned();
        let ledger = Ledger {
            installs: Vec::new(),
        };

        write_live(&game, "gui/keep.txt", "keep-me");
        write_live(&game, "gui/edited.txt", "pristine");
        let layer = record(
            "pack-a",
            "A",
            "1.0.0",
            &root,
            &["gui/keep.txt", "gui/edited.txt"],
        );
        adopt_install_in(&data, &ledger, &root, &layer).expect("adopt");
        render_in(&data, &ledger, &root).expect("first render");

        // The user edits one rendered file: it is no longer provably ours.
        write_live(&game, "gui/edited.txt", "user-edited");
        set_enabled_in(&data, &ledger, &root, "pack-a", false).expect("disable");

        let report = render_in(&data, &ledger, &root).expect("render");
        assert_eq!(report.removed, 1, "{report:?}");
        assert!(!report.warnings.is_empty(), "the unproven file warns");
        assert!(
            !res_mods(&game).join("gui/keep.txt").exists(),
            "the provably rendered file is removed"
        );
        assert_eq!(
            read_live(&game, "gui/edited.txt"),
            "user-edited",
            "the hand-edited file survives"
        );
    }

    #[test]
    fn two_voice_packs_sharing_a_bank_conflict() {
        let tmp = fixture("voices");
        let game = tmp.join("game");
        make_game(&game);
        let data = tmp.join("data");
        fs::create_dir_all(&data).unwrap();
        let root = game.to_string_lossy().into_owned();
        let ledger = Ledger {
            installs: Vec::new(),
        };

        write_live(&game, "banks/mods/VoiceOne/mod.xml", "<voice>one</voice>");
        adopt_install_in(
            &data,
            &ledger,
            &root,
            &record(
                "voice-a",
                "Voice A",
                "1.0.0",
                &root,
                &["banks/mods/VoiceOne/mod.xml"],
            ),
        )
        .expect("adopt voice a");
        write_live(
            &game,
            "banks/mods/VoiceOne/mod_alt.xml",
            "<voice>alt</voice>",
        );
        adopt_install_in(
            &data,
            &ledger,
            &root,
            &record(
                "voice-b",
                "Voice B",
                "1.0.0",
                &root,
                &["banks/mods/VoiceOne/mod_alt.xml"],
            ),
        )
        .expect("adopt voice b");

        let stack = view_stack(&data, &ledger, &root).expect("view");
        assert_eq!(stack_ids(&stack), ["voice-b", "voice-a"]);
        assert!(
            stack
                .layers
                .iter()
                .all(|layer| layer.layer_class == LayerClass::Additive)
        );
        assert_eq!(stack.slot_conflicts.len(), 1, "{:?}", stack.slot_conflicts);
        assert_eq!(stack.slot_conflicts[0].slot, "voice:voiceone");
        assert_eq!(
            stack.slot_conflicts[0].pack_ids,
            vec!["voice-b".to_string(), "voice-a".to_string()]
        );
    }
}
