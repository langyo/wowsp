//! Core logic of the replay-corpus CLI — everything network-free so it stays
//! unit-testable on the host.
//!
//! The maintainer's aggregation loop over the drained replay archive (the
//! content-addressed files `replay-drain pull` stores under `<archive>/raw/`):
//! - `scan` walks the raw members, parses each header through the decoding
//!   core's meta path and writes a JSON array index (sha = the
//!   content-addressed file stem).
//! - `insights` decodes every member in a worker pool and aggregates the
//!   per-(map, mode) dataset `map-insights.json`: battle counts, the modal
//!   capture layout, and self-calibrating 96×96 spawn/track heat grids
//!   (bounds derived from the observed coordinates — no map-bounds data
//!   needed anywhere). A heat-free `-lite` companion lands next to it for
//!   the webui to ship as static res data.

use anyhow::{Context, bail};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;

use wowsp_replay_core::DecodedReplay;
use wowsp_replay_core::caps::{CapPointObs, cap_points_of};
use wowsp_replay_core::meta::{
    client_version_from_raw, extract_descriptor_json, lite_from_raw, packet_stream_after_blocks,
    parse_datetime_from_filename, roster_from_raw,
};
use wowsp_replay_core::{decode_replay, is_lesta_replay_extension};

/// Heat grids are SIDE×SIDE cells (per the dataset contract).
pub const GRID_SIDE: usize = 96;
/// Track heat subsampling: every Nth position sample per entity (a full
/// match's stream is ~an order of magnitude denser than the grid can show).
const TRACK_SUBSAMPLE: usize = 8;
/// Member extensions the drain archive ever stores (contract §8).
const MEMBER_EXTS: [&str; 2] = ["wowsreplay", "korablireplay"];

// ── argv ────────────────────────────────────────────────────────────────

/// The manual arg grammar (no clap — the repo keeps tool deps lean; see
/// main.rs's help text for the full surface).
#[derive(Debug, PartialEq)]
pub enum Command {
    Scan(CommonArgs),
    Insights(CommonArgs),
}

#[derive(Debug, PartialEq)]
pub struct CommonArgs {
    pub archive: PathBuf,
    pub out: PathBuf,
}

pub fn parse_args(argv: &[String]) -> anyhow::Result<Command> {
    let env_archive = std::env::var("WOWSP_ARCHIVE_DIR").ok();
    let mut it = argv.iter();
    let Some(cmd) = it.next() else {
        bail!("usage: replay-corpus <scan|insights> [options] (see --help)");
    };
    let mut archive: Option<PathBuf> = None;
    let mut out: Option<PathBuf> = None;
    while let Some(a) = it.next() {
        match a.as_str() {
            "--archive" => archive = Some(PathBuf::from(take(&mut it, "--archive")?)),
            "--out" => out = Some(PathBuf::from(take(&mut it, "--out")?)),
            other => bail!("unknown option {other}"),
        }
    }
    let archive = archive
        .or_else(|| env_archive.map(PathBuf::from))
        .unwrap_or_else(|| {
            // The drain CLI's default archive dir — see replay-drain --out.
            PathBuf::from("replay-archive")
        });
    match cmd.as_str() {
        "scan" => Ok(Command::Scan(CommonArgs {
            archive,
            out: out.unwrap_or_else(|| PathBuf::from("index.json")),
        })),
        "insights" => Ok(Command::Insights(CommonArgs {
            archive,
            out: out.unwrap_or_else(|| PathBuf::from("map-insights.json")),
        })),
        other => bail!("unknown command {other} (scan | insights)"),
    }
}

fn take<'a>(it: &mut impl Iterator<Item = &'a String>, flag: &str) -> anyhow::Result<String> {
    it.next()
        .map(String::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("{flag} needs a value"))
}

// ── the drained archive ─────────────────────────────────────────────────

/// One drained replay file: its content-addressed name parts.
struct ArchiveFile {
    path: PathBuf,
    /// The `<sha256>` file stem — the member's content address.
    sha: String,
    /// Container extension (also the client-family marker).
    ext: String,
}

/// Collect every drained member under `<archive>/raw/`, sorted by content
/// address for deterministic output. Errors when the raw dir is missing —
/// that archive was never pulled into (run `replay-drain pull` first).
fn walk_raw(archive: &Path) -> anyhow::Result<Vec<ArchiveFile>> {
    let raw = archive.join("raw");
    let rd = std::fs::read_dir(&raw)
        .with_context(|| format!("reading {} (run `replay-drain pull` first)", raw.display()))?;
    let mut out = Vec::new();
    for ent in rd.flatten() {
        let path = ent.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some((stem, ext)) = name.split_once('.') else {
            continue;
        };
        if !MEMBER_EXTS.contains(&ext) {
            continue;
        }
        let sha = stem.to_owned();
        let ext = ext.to_owned();
        out.push(ArchiveFile { path, sha, ext });
    }
    out.sort_by(|a, b| a.sha.cmp(&b.sha));
    Ok(out)
}

/// What one CLI run processed — the summary `main` prints.
pub struct RunReport {
    pub files: usize,
    pub unparsed: u32,
}

// ── scan: the header index ──────────────────────────────────────────────

/// One index row: the addressable summary of one drained replay.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    /// Content address — the raw member's `<sha256>` stem.
    pub sha: String,
    /// Archive-relative member name (`raw/<sha>.<ext>`).
    pub file: String,
    /// Descriptor `mapDisplayName` (the space id, e.g. `15_NE_north`).
    pub map: Option<String>,
    pub map_id: Option<i64>,
    /// Descriptor `matchGroup` (`pvp`, `ranked`, …).
    pub mode: Option<String>,
    pub scenario: Option<String>,
    /// Descriptor `realm`, when the client wrote one.
    pub realm: Option<String>,
    /// Filename-derived `YYYYMMDD_HHMMSS` when present, else the
    /// descriptor's own `dateTime` (content-addressed stems carry no date).
    pub date_time: Option<String>,
    pub player_count: usize,
    pub own_ship_id: Option<i64>,
}

/// Parse one member's header into an index row off ONE bounded block-0 read
/// (never the multi-MB packet stream behind it). Degraded files still get a
/// row (null fields) so the index keeps every member addressable; the
/// boolean reports whether the descriptor actually parsed.
fn scan_one(file: &ArchiveFile) -> (IndexEntry, bool) {
    let path_str = file.path.to_string_lossy().into_owned();
    let raw: Option<serde_json::Value> =
        meta_block0(&file.path).and_then(|payload| serde_json::from_slice(&payload).ok());
    let member = format!(
        "raw/{}",
        file.path.file_name().unwrap_or_default().to_string_lossy()
    );
    let Some(raw) = raw else {
        return (
            IndexEntry {
                sha: file.sha.clone(),
                file: member,
                map: None,
                map_id: None,
                mode: None,
                scenario: None,
                realm: None,
                date_time: None,
                player_count: 0,
                own_ship_id: None,
            },
            false,
        );
    };
    let realm = raw.get("realm").and_then(|v| v.as_str()).map(str::to_owned);
    let date_time = parse_datetime_from_filename(&path_str).or_else(|| {
        raw.get("dateTime")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
    });
    let lite = lite_from_raw(path_str, date_time, raw);
    (
        IndexEntry {
            sha: file.sha.clone(),
            file: member,
            map: lite.map_name,
            map_id: lite.map_id,
            mode: lite.match_group,
            scenario: lite.scenario,
            realm,
            date_time: lite.date_time,
            player_count: lite.player_count,
            own_ship_id: lite.own_ship_id,
        },
        true,
    )
}

/// Bounded block-0 read (the descriptor JSON payload of one replay file).
fn meta_block0(path: &Path) -> Option<Vec<u8>> {
    wowsp_replay_core::meta::read_block(path, 0).ok()
}

/// The `scan` command: index every drained member's header.
pub fn run_scan(archive: &Path, out: &Path) -> anyhow::Result<RunReport> {
    let files = walk_raw(archive)?;
    let mut entries = Vec::with_capacity(files.len());
    let mut unparsed = 0u32;
    for file in &files {
        let (entry, parsed) = scan_one(file);
        if !parsed {
            unparsed += 1;
            eprintln!("! {} header unparsable; indexed with null fields", file.sha);
        }
        entries.push(entry);
    }
    std::fs::write(out, serde_json::to_vec_pretty(&entries)?)
        .with_context(|| format!("writing {}", out.display()))?;
    Ok(RunReport {
        files: files.len(),
        unparsed,
    })
}

// ── insights: the map dataset ───────────────────────────────────────────

/// One battle's decoded contribution to the aggregation.
struct BattleInsight {
    map: String,
    mode: String,
    /// First position sample of every SHIP entity (spawn heat).
    spawns: Vec<(f32, f32)>,
    /// Every entity's position stream, subsampled (track heat).
    tracks: Vec<(f32, f32)>,
    /// The battle's capture points (modal-layout votes).
    caps: Vec<CapPointObs>,
}

/// Extract one battle's aggregation inputs from a decoded replay — the pure
/// half of the worker, unit-testable on synthetic [`DecodedReplay`] fixtures.
fn insight_of_decode(decoded: &DecodedReplay, map: String, mode: String) -> BattleInsight {
    let mut spawns = Vec::new();
    let mut tracks = Vec::new();
    for (eid, samples) in &decoded.positions {
        if samples.is_empty() {
            continue;
        }
        // Ship = entity type 2; spawn heat keys on ships only. Track heat
        // rides every entity's stream (torpedoes and squadrons are traffic
        // too), subsampled per entity.
        if decoded.kinds.get(eid).is_some_and(|k| k.entity_type == 2) {
            spawns.push((samples[0].x, samples[0].z));
        }
        tracks.extend(samples.iter().step_by(TRACK_SUBSAMPLE).map(|s| (s.x, s.z)));
    }
    BattleInsight {
        map,
        mode,
        spawns,
        tracks,
        caps: cap_points_of(decoded),
    }
}

/// Decode one drained member end-to-end: header (map/mode/version/roster)
/// through the lib's meta path, then the full packet-stream decode. The
/// Lesta arena synthesis the app's viewer layers on top is irrelevant to
/// the aggregate, so the plain decode is the whole story here.
fn decode_battle(file: &ArchiveFile) -> anyhow::Result<BattleInsight> {
    let bytes =
        std::fs::read(&file.path).with_context(|| format!("reading {}", file.path.display()))?;
    let path_str = file.path.to_string_lossy().into_owned();
    let json = extract_descriptor_json(&bytes)
        .with_context(|| format!("{}: not a valid replay container", file.sha))?;
    let raw: serde_json::Value =
        serde_json::from_str(&json).context("parsing the descriptor JSON")?;
    let lite = lite_from_raw(
        path_str.clone(),
        parse_datetime_from_filename(&path_str),
        raw.clone(),
    );
    let map = lite
        .map_name
        .clone()
        .context("descriptor carries no mapDisplayName")?;
    let mode = lite
        .match_group
        .clone()
        .context("descriptor carries no matchGroup")?;
    let client_version = client_version_from_raw(raw.get("clientVersionFromExe"));
    let stream = packet_stream_after_blocks(&bytes).context("locating the packet stream")?;
    // Roster shipIds join EntityCreate states to players; the candidate set
    // only sharpens the entity table, so a roster-less header is fine.
    let mut candidates = HashSet::new();
    for v in roster_from_raw(Path::new(&path_str), &raw) {
        if v.ship_id > 0 {
            candidates.insert(v.ship_id as u32);
        }
    }
    let decoded = decode_replay(
        stream,
        &candidates,
        client_version.as_deref(),
        is_lesta_replay_extension(&file.ext),
    )
    .context("decoding the packet stream")?;
    Ok(insight_of_decode(&decoded, map, mode))
}

/// One serialized heat grid: self-calibrating bounds plus the cell counts.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeatJson {
    /// `[minX, minZ, maxX, maxZ]` — the observed coordinate extent the grid
    /// was binned over (no external map-bounds data involved).
    pub bounds: [f64; 4],
    /// `GRID_SIDE` rows (z) of `GRID_SIDE` counts (x).
    pub grid: Vec<Vec<u64>>,
}

/// Streaming `GRID_SIDE`×`GRID_SIDE` heat accumulator with self-calibrating
/// bounds: points land in the grid as they arrive, and a point outside the
/// current extent grows the bounds and remaps the accumulated counts (each
/// old cell's count drops whole into the new cell containing its centre).
/// The final bounds therefore always equal the true observed min/max; the
/// remap keeps totals exact while bounding memory to one grid per
/// (map, mode) regardless of corpus size.
#[derive(Default)]
struct HeatAcc {
    bounds: Option<[f64; 4]>,
    grid: Vec<u64>,
}

impl HeatAcc {
    fn add(&mut self, x: f32, z: f32) {
        let (x, z) = (f64::from(x), f64::from(z));
        if self.bounds.is_none() {
            self.bounds = Some([x, z, x, z]);
            self.grid = vec![0; GRID_SIDE * GRID_SIDE];
            self.bump(x, z);
            return;
        }
        let inside = self
            .bounds
            .is_some_and(|b| x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]);
        if !inside {
            self.expand(x, z);
        }
        self.bump(x, z);
    }

    /// Grid cell of a point under the current bounds (clamped onto the
    /// edge cells; degenerate axes collapse to column/row 0).
    fn cell(&self, x: f64, z: f64) -> (usize, usize) {
        let b = self.bounds.unwrap_or([0.0; 4]);
        let ix = if b[2] > b[0] {
            (((x - b[0]) / (b[2] - b[0]) * GRID_SIDE as f64) as usize).min(GRID_SIDE - 1)
        } else {
            0
        };
        let iz = if b[3] > b[1] {
            (((z - b[1]) / (b[3] - b[1]) * GRID_SIDE as f64) as usize).min(GRID_SIDE - 1)
        } else {
            0
        };
        (ix, iz)
    }

    fn bump(&mut self, x: f64, z: f64) {
        if self.grid.is_empty() {
            return;
        }
        let (ix, iz) = self.cell(x, z);
        self.grid[iz * GRID_SIDE + ix] += 1;
    }

    /// Grow the bounds to include `(x, z)` and remap the old counts.
    fn expand(&mut self, x: f64, z: f64) {
        let Some(mut new_bounds) = self.bounds else {
            return;
        };
        let old_bounds = new_bounds;
        new_bounds[0] = new_bounds[0].min(x);
        new_bounds[1] = new_bounds[1].min(z);
        new_bounds[2] = new_bounds[2].max(x);
        new_bounds[3] = new_bounds[3].max(z);
        let old_grid = std::mem::replace(&mut self.grid, vec![0; GRID_SIDE * GRID_SIDE]);
        self.bounds = Some(new_bounds);
        for (n, count) in old_grid.iter().enumerate() {
            if *count == 0 {
                continue;
            }
            let (iz, ix) = (n / GRID_SIDE, n % GRID_SIDE);
            let cx = old_bounds[0]
                + (old_bounds[2] - old_bounds[0]) * (ix as f64 + 0.5) / GRID_SIDE as f64;
            let cz = old_bounds[1]
                + (old_bounds[3] - old_bounds[1]) * (iz as f64 + 0.5) / GRID_SIDE as f64;
            let (nx, nz) = self.cell(cx, cz);
            self.grid[nz * GRID_SIDE + nx] += count;
        }
    }

    fn finish(self) -> HeatJson {
        let bounds = self.bounds.unwrap_or([0.0; 4]);
        let grid = if self.grid.is_empty() {
            vec![vec![0; GRID_SIDE]; GRID_SIDE]
        } else {
            self.grid.chunks(GRID_SIDE).map(<[u64]>::to_vec).collect()
        };
        HeatJson { bounds, grid }
    }
}

/// Cluster key of a cap observation: geometry rounded to whole metres
/// (`radius: None` stays its own cluster — zones whose radius scan failed).
type CapKey = (i64, i64, Option<i64>);

/// Per-key vote over the (index, team, appearT) the battles observed.
type CapVote = (i32, Option<i8>, Option<i64>);

/// Per-(map, mode) aggregation state.
#[derive(Default)]
struct ModeAcc {
    battles: u32,
    spawn: HeatAcc,
    track: HeatAcc,
    /// Battles that contributed cap observations at all.
    caps_sample: u32,
    /// Exact cap SET (sorted cluster keys) → battles carrying it.
    cap_sets: HashMap<Vec<CapKey>, u32>,
    /// Cluster key → (index, team, appearT) votes.
    cap_votes: HashMap<CapKey, HashMap<CapVote, u32>>,
}

fn cap_key(c: &CapPointObs) -> CapKey {
    (
        c.x.round() as i64,
        c.z.round() as i64,
        c.radius.map(|r| r.round() as i64),
    )
}

fn cap_vote(c: &CapPointObs) -> CapVote {
    (c.index, c.team, c.appear_t.map(|t| t.round() as i64))
}

/// Fold one battle into its (map, mode) accumulator.
fn add_battle(acc: &mut ModeAcc, battle: &BattleInsight) {
    acc.battles += 1;
    for &(x, z) in &battle.spawns {
        acc.spawn.add(x, z);
    }
    for &(x, z) in &battle.tracks {
        acc.track.add(x, z);
    }
    if battle.caps.is_empty() {
        return;
    }
    acc.caps_sample += 1;
    let mut keys: Vec<CapKey> = battle.caps.iter().map(cap_key).collect();
    keys.sort();
    keys.dedup();
    *acc.cap_sets.entry(keys).or_default() += 1;
    for c in &battle.caps {
        *acc.cap_votes
            .entry(cap_key(c))
            .or_default()
            .entry(cap_vote(c))
            .or_default() += 1;
    }
}

/// Deterministic modal vote (count desc, then the vote value asc so ties
/// settle stably regardless of HashMap order).
fn modal_vote(votes: &HashMap<CapVote, u32>) -> Option<CapVote> {
    let mut rows: Vec<(&CapVote, &u32)> = votes.iter().collect();
    rows.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    rows.first().map(|(v, _)| **v)
}

/// One (map, mode)'s aggregated dataset row.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeInsights {
    pub battle_count: u32,
    /// The modal cap layout (the clustered set most battles carried).
    pub caps: Vec<CapPointObs>,
    /// Battles that contributed cap observations.
    pub caps_sample: u32,
    pub spawn_heat: HeatJson,
    pub track_heat: HeatJson,
}

/// Freeze one accumulator into its serializable row.
fn finish_mode(acc: ModeAcc) -> ModeInsights {
    let mut sets: Vec<(&Vec<CapKey>, &u32)> = acc.cap_sets.iter().collect();
    sets.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    let caps = sets
        .first()
        .map(|(set, _)| {
            set.iter()
                .map(|k| {
                    let (index, team, appear) = acc
                        .cap_votes
                        .get(k)
                        .and_then(modal_vote)
                        .unwrap_or((0, None, None));
                    CapPointObs {
                        index,
                        x: k.0 as f32,
                        z: k.1 as f32,
                        radius: k.2.map(|r| r as f32),
                        team,
                        appear_t: appear.map(|t| t as f32),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    ModeInsights {
        battle_count: acc.battles,
        caps,
        caps_sample: acc.caps_sample,
        spawn_heat: acc.spawn.finish(),
        track_heat: acc.track.finish(),
    }
}

/// The `map-insights.json` envelope.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightsEnvelope {
    pub version: u32,
    /// RFC3339, UTC.
    pub generated_at: String,
    /// Members whose header or decode failed and were skipped.
    pub unparsed: u32,
    pub maps: BTreeMap<String, MapInsights>,
}

#[derive(Debug, Serialize)]
pub struct MapInsights {
    pub modes: BTreeMap<String, ModeInsights>,
}

/// One (map, mode) row of the lite companion: the aggregated facts without
/// the heat grids (the webui ships the lite doc as static res data — the
/// 96×96 grids dwarf everything else and serve no app-side purpose).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeInsightsLite {
    pub battle_count: u32,
    pub caps_sample: u32,
    pub caps: Vec<CapPointObs>,
}

/// The `map-insights-lite.json` envelope: the same versioned shape as the
/// full dataset with every mode row reduced to
/// `{battleCount, capsSample, caps}`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightsEnvelopeLite {
    pub version: u32,
    /// RFC3339, UTC — identical to the full doc's stamp.
    pub generated_at: String,
    pub unparsed: u32,
    pub maps: BTreeMap<String, MapInsightsLite>,
}

#[derive(Debug, Serialize)]
pub struct MapInsightsLite {
    pub modes: BTreeMap<String, ModeInsightsLite>,
}

impl From<InsightsEnvelope> for InsightsEnvelopeLite {
    fn from(full: InsightsEnvelope) -> Self {
        Self {
            version: full.version,
            generated_at: full.generated_at,
            unparsed: full.unparsed,
            maps: full
                .maps
                .into_iter()
                .map(|(map, m)| {
                    (
                        map,
                        MapInsightsLite {
                            modes: m
                                .modes
                                .into_iter()
                                .map(|(mode, row)| {
                                    (
                                        mode,
                                        ModeInsightsLite {
                                            battle_count: row.battle_count,
                                            caps_sample: row.caps_sample,
                                            caps: row.caps,
                                        },
                                    )
                                })
                                .collect(),
                        },
                    )
                })
                .collect(),
        }
    }
}

/// The lite companion's path: the full output's file name with `-lite`
/// before the extension (`map-insights.json` → `map-insights-lite.json`;
/// a custom `--out` stem carries over, an extension-less name just gains
/// the suffix).
pub fn lite_out_path(out: &Path) -> PathBuf {
    let Some(name) = out.file_name().and_then(|n| n.to_str()) else {
        return out.to_path_buf();
    };
    let lite = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem}-lite.{ext}"),
        _ => format!("{name}-lite"),
    };
    out.with_file_name(lite)
}

/// Aggregate a stream of decoded battles into the envelope — the pure core
/// behind `run_insights`, unit-testable on synthetic fixtures.
fn build_envelope(
    battles: impl IntoIterator<Item = BattleInsight>,
    unparsed: u32,
    now: chrono::DateTime<chrono::Utc>,
) -> InsightsEnvelope {
    let mut maps: BTreeMap<String, BTreeMap<String, ModeAcc>> = BTreeMap::new();
    for battle in battles {
        let mode_map = maps.entry(battle.map.clone()).or_default();
        let acc = mode_map.entry(battle.mode.clone()).or_default();
        add_battle(acc, &battle);
    }
    InsightsEnvelope {
        version: 1,
        generated_at: now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        unparsed,
        maps: maps
            .into_iter()
            .map(|(map, modes)| {
                (
                    map,
                    MapInsights {
                        modes: modes
                            .into_iter()
                            .map(|(mode, acc)| (mode, finish_mode(acc)))
                            .collect(),
                    },
                )
            })
            .collect(),
    }
}

/// The `insights` command: decode every drained member in a worker pool
/// (the decode fns are sync CPU work; archive dirs hold thousands of
/// files) and write the aggregated `map-insights.json` envelope plus its
/// heat-free `-lite` companion.
pub fn run_insights(
    archive: &Path,
    out: &Path,
    now: chrono::DateTime<chrono::Utc>,
) -> anyhow::Result<RunReport> {
    let files = Arc::new(walk_raw(archive)?);
    let raw_dir = archive.join("raw");
    eprintln!(
        "{} drained replay(s) under {}",
        files.len(),
        raw_dir.display()
    );
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .max(1)
        .min(files.len().max(1));
    let next = Arc::new(AtomicUsize::new(0));
    let (tx, rx) = mpsc::channel::<(usize, anyhow::Result<BattleInsight>)>();
    let mut handles = Vec::with_capacity(workers);
    for _ in 0..workers {
        let files = Arc::clone(&files);
        let next = Arc::clone(&next);
        let tx = tx.clone();
        handles.push(std::thread::spawn(move || {
            loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= files.len() {
                    break;
                }
                let result = decode_battle(&files[i]);
                if tx.send((i, result)).is_err() {
                    break;
                }
            }
        }));
    }
    drop(tx);
    let mut battles = Vec::with_capacity(files.len());
    let mut unparsed = 0u32;
    let mut done = 0usize;
    for (i, result) in rx {
        done += 1;
        match result {
            Ok(battle) => battles.push(battle),
            Err(e) => {
                unparsed += 1;
                eprintln!("! {} skipped: {e:#}", files[i].sha);
            },
        }
        if done % 100 == 0 {
            eprintln!("  decoded {done}/{}", files.len());
        }
    }
    for handle in handles {
        let _ = handle.join();
    }
    let envelope = build_envelope(battles, unparsed, now);
    std::fs::write(out, serde_json::to_vec_pretty(&envelope)?)
        .with_context(|| format!("writing {}", out.display()))?;
    // The heat-free companion the webui ships as static res data (same
    // envelope, mode rows reduced to battleCount/capsSample/caps).
    let lite_out = lite_out_path(out);
    let lite = InsightsEnvelopeLite::from(envelope);
    std::fs::write(&lite_out, serde_json::to_vec_pretty(&lite)?)
        .with_context(|| format!("writing {}", lite_out.display()))?;
    Ok(RunReport {
        files: files.len(),
        unparsed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── grid accumulation ────────────────────────────────────────────────

    /// Points bin into the right cells under known bounds: the unit square
    /// maps onto the grid with (0,0) in the NW corner cell and (1,1) clamped
    /// onto the SE edge cell.
    #[test]
    fn heat_grid_accumulates_points_into_cells() {
        let mut heat = HeatAcc::default();
        heat.add(0.0, 0.0);
        heat.add(1.0, 1.0);
        heat.add(1.0, 1.0);
        heat.add(0.5, 0.5);
        let done = heat.finish();
        assert_eq!(done.bounds, [0.0, 0.0, 1.0, 1.0]);
        assert_eq!(done.grid.len(), GRID_SIDE);
        assert!(done.grid.iter().all(|row| row.len() == GRID_SIDE));
        assert_eq!(done.grid[0][0], 1, "min corner lands in the NW cell");
        assert_eq!(
            done.grid[GRID_SIDE - 1][GRID_SIDE - 1],
            2,
            "max corner clamps onto the SE edge cell"
        );
        let mid = GRID_SIDE / 2;
        assert_eq!(done.grid[mid][mid], 1);
        let total: u64 = done.grid.iter().flatten().sum();
        assert_eq!(total, 4, "every added point is counted exactly once");
    }

    /// A point landing outside the current extent grows the bounds and keeps
    /// the accumulated total — the streaming self-calibration the corpus
    /// aggregation relies on (points arrive before bounds finalize).
    #[test]
    fn heat_grid_remaps_counts_when_bounds_expand() {
        let mut heat = HeatAcc::default();
        for i in 0..10 {
            heat.add(i as f32, 0.0);
        }
        assert_eq!(heat.bounds, Some([0.0, 0.0, 9.0, 0.0]));
        // A far point expands the extent in x (and breaks the degenerate z).
        heat.add(100.0, 5.0);
        let done = heat.finish();
        assert_eq!(done.bounds, [0.0, 0.0, 100.0, 5.0]);
        let total: u64 = done.grid.iter().flatten().sum();
        assert_eq!(total, 11, "remap preserves the accumulated counts");
        assert!(
            done.grid.iter().flatten().all(|c| *c <= 10),
            "no cell absorbs more than one battle's worth of pre-remap mass"
        );
    }

    // ── modal-cap clustering ─────────────────────────────────────────────

    fn cap(x: f32, z: f32, radius: Option<f32>, index: i32, team: Option<i8>) -> CapPointObs {
        CapPointObs {
            index,
            x,
            z,
            radius,
            team,
            appear_t: None,
        }
    }

    fn battle(map: &str, mode: &str, caps: Vec<CapPointObs>) -> BattleInsight {
        BattleInsight {
            map: map.into(),
            mode: mode.into(),
            spawns: Vec::new(),
            tracks: Vec::new(),
            caps,
        }
    }

    /// Two battles share layout A, one carries layout B (a drifted radius):
    /// the modal set is A, with the cluster geometry and the majority
    /// (index, team) votes, and capsSample counts every contributing battle.
    #[test]
    fn modal_cap_layout_picks_the_most_frequent_set() {
        let layout_a = || {
            vec![
                cap(10.2, -30.7, Some(100.0), 0, Some(-1)),
                cap(200.4, 55.1, Some(120.0), 1, Some(-1)),
            ]
        };
        // Same layout with sub-metre jitter (rounds into the same clusters)
        // but a dissenting team vote on one point.
        let jittered = || {
            vec![
                cap(10.4, -30.9, Some(100.2), 0, Some(-1)),
                cap(200.6, 55.3, Some(119.8), 1, Some(0)),
            ]
        };
        let drifted = || vec![cap(10.0, -30.5, Some(140.0), 0, Some(-1))];
        let envelope = build_envelope(
            [
                battle("map", "pvp", layout_a()),
                battle("map", "pvp", jittered()),
                battle("map", "pvp", drifted()),
            ],
            0,
            chrono::Utc::now(),
        );
        let mode = &envelope.maps["map"].modes["pvp"];
        assert_eq!(mode.battle_count, 3);
        assert_eq!(mode.caps_sample, 3);
        assert_eq!(mode.caps.len(), 2, "the two-point layout A wins");
        assert_eq!(mode.caps[0].index, 0);
        assert_eq!(mode.caps[0].x, 10.0, "cluster geometry is the rounded key");
        assert_eq!(mode.caps[0].radius, Some(100.0));
        assert_eq!(mode.caps[0].team, Some(-1), "unanimous vote");
        assert_eq!(
            mode.caps[1].team,
            Some(-1),
            "majority vote beats the lone dissent"
        );
    }

    // ── envelope roundtrip ───────────────────────────────────────────────

    /// The envelope serializes to the contract shape: version, generatedAt,
    /// unparsed, maps.<map>.modes.<mode> with battleCount/caps/capsSample
    /// and 96×96 heat grids.
    #[test]
    fn envelope_roundtrips_through_json() {
        let mut b = battle(
            "20_NE_two_brothers",
            "pvp",
            vec![cap(1.0, 2.0, Some(80.0), 0, None)],
        );
        b.spawns = vec![(10.0, 20.0), (30.0, 40.0)];
        b.tracks = vec![(10.0, 20.0), (11.0, 21.0)];
        let now = chrono::Utc::now();
        let envelope = build_envelope([b], 2, now);
        let json = serde_json::to_value(&envelope).expect("serializes");
        assert_eq!(json["version"], serde_json::json!(1));
        assert_eq!(json["unparsed"], serde_json::json!(2));
        let generated = json["generatedAt"].as_str().expect("generatedAt string");
        let reparsed = chrono::DateTime::parse_from_rfc3339(generated)
            .expect("generatedAt is RFC3339")
            .with_timezone(&chrono::Utc);
        assert_eq!(reparsed.timestamp(), now.timestamp());
        let mode = &json["maps"]["20_NE_two_brothers"]["modes"]["pvp"];
        assert_eq!(mode["battleCount"], serde_json::json!(1));
        assert_eq!(mode["capsSample"], serde_json::json!(1));
        assert_eq!(mode["caps"][0]["radius"], serde_json::json!(80.0));
        assert_eq!(mode["caps"][0]["index"], serde_json::json!(0));
        for heat in ["spawnHeat", "trackHeat"] {
            let bounds = mode[heat]["bounds"].as_array().expect("bounds array");
            assert_eq!(bounds.len(), 4);
            let grid = mode[heat]["grid"].as_array().expect("grid array");
            assert_eq!(grid.len(), GRID_SIDE);
            assert!(
                grid.iter()
                    .all(|r| r.as_array().unwrap().len() == GRID_SIDE)
            );
        }
        let spawn_total: u64 = mode["spawnHeat"]["grid"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|r| r.as_array().unwrap())
            .map(|c| c.as_u64().unwrap())
            .sum();
        assert_eq!(spawn_total, 2);
        let track_total: u64 = mode["trackHeat"]["grid"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|r| r.as_array().unwrap())
            .map(|c| c.as_u64().unwrap())
            .sum();
        assert_eq!(track_total, 2);
    }

    // ── the lite companion ──────────────────────────────────────────────

    /// The `-lite` companion path honors a custom out stem: `-lite` lands
    /// before the extension, and extension-less paths just gain the suffix.
    #[test]
    fn lite_out_path_inserts_suffix_before_extension() {
        assert_eq!(
            lite_out_path(Path::new("map-insights.json")),
            PathBuf::from("map-insights-lite.json")
        );
        assert_eq!(
            lite_out_path(Path::new("data/custom-set.json")),
            PathBuf::from("data/custom-set-lite.json")
        );
        assert_eq!(lite_out_path(Path::new("out")), PathBuf::from("out-lite"));
    }

    /// The lite doc keeps the envelope facts and the modal caps verbatim
    /// but carries NO heat keys: each mode row is exactly
    /// `{battleCount, capsSample, caps}` — the shape the webui's res
    /// placeholder promises.
    #[test]
    fn lite_envelope_drops_heat_and_keeps_caps() {
        let with_caps = battle(
            "20_NE_two_brothers",
            "pvp",
            vec![
                cap(1.0, 2.0, Some(80.0), 0, None),
                cap(-3.5, 7.25, Some(115.0), 1, Some(-1)),
            ],
        );
        // A mode that observed nothing (no caps → no capsSample) still gets
        // its row, with an empty layout.
        let bare = battle("20_NE_two_brothers", "ranked", Vec::new());
        let now = chrono::Utc::now();
        let envelope = build_envelope([with_caps, bare], 4, now);
        let full = serde_json::to_value(&envelope).expect("full serializes");
        let lite =
            serde_json::to_value(InsightsEnvelopeLite::from(envelope)).expect("lite serializes");
        assert_eq!(lite["version"], serde_json::json!(1));
        assert_eq!(lite["unparsed"], serde_json::json!(4));
        assert_eq!(lite["generatedAt"], full["generatedAt"]);
        assert_eq!(
            lite["maps"]["20_NE_two_brothers"]["modes"]["ranked"]["caps"],
            serde_json::json!([])
        );
        let mode = &lite["maps"]["20_NE_two_brothers"]["modes"]["pvp"];
        assert_eq!(mode["battleCount"], serde_json::json!(1));
        assert_eq!(mode["capsSample"], serde_json::json!(1));
        for key in ["spawnHeat", "trackHeat"] {
            assert!(
                mode.get(key).is_none(),
                "the lite doc carries no {key} grid"
            );
        }
        let mut keys: Vec<&str> = mode
            .as_object()
            .expect("mode row is an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["battleCount", "caps", "capsSample"]);
        assert_eq!(
            mode["caps"], full["maps"]["20_NE_two_brothers"]["modes"]["pvp"]["caps"],
            "the modal layout survives the reduction verbatim"
        );
    }

    // ── synthetic DecodedReplay fixtures ─────────────────────────────────

    /// An empty decoded replay — every collection/Option at its zero value.
    fn empty_decode() -> DecodedReplay {
        DecodedReplay {
            recorder_ship: None,
            positions: BTreeMap::new(),
            kinds: BTreeMap::new(),
            destroys: BTreeMap::new(),
            properties: BTreeMap::new(),
            shell_launches: Vec::new(),
            explosions: Vec::new(),
            torpedoes: Vec::new(),
            torpedo_steers: Vec::new(),
            cap_progress: BTreeMap::new(),
            weapon_locks: Vec::new(),
            battle_results: None,
            method_histogram: Vec::new(),
            method_arg_samples: BTreeMap::new(),
            version: None,
            map_name: None,
            camera: Vec::new(),
            net_stats: Vec::new(),
            leaves: BTreeMap::new(),
            camera_modes: Vec::new(),
            diagnostics: Default::default(),
            squadron_creates: Vec::new(),
            squadron_planes: Vec::new(),
            minimap_squadron_adds: Vec::new(),
            minimap_squadron_moves: Vec::new(),
            minimap_squadron_removes: Vec::new(),
            wards: Vec::new(),
            ward_removes: Vec::new(),
            shot_kills: Vec::new(),
            damage_stats: Vec::new(),
            chat_messages: Vec::new(),
            achievements: Vec::new(),
            arena_players: Vec::new(),
            weather_transitions: Vec::new(),
            weather_notifications: Vec::new(),
        }
    }

    fn sample(t: f32, x: f32, z: f32) -> wowsp_tauri_shared::PositionSample {
        wowsp_tauri_shared::PositionSample {
            time: t,
            entity_id: 0,
            vehicle_id: 0,
            x,
            y: 0.0,
            z,
            yaw: 0.0,
        }
    }

    fn kind(entity_type: i16, x: f32, z: f32) -> wowsp_tauri_shared::EntityKind {
        wowsp_tauri_shared::EntityKind {
            entity_type,
            vehicle_id: 0,
            initial_x: x,
            initial_y: 0.0,
            initial_z: z,
            creation_time: 0.0,
            ship_id: None,
            max_health: None,
            control_point_index: None,
            initial_team: None,
            radius: None,
        }
    }

    /// The decode-to-insight extraction: spawn heat takes only SHIPS' first
    /// samples, track heat subsamples every entity's stream every 8th, and
    /// the cap lift keeps qualified type-14 zones only.
    #[test]
    fn insight_extraction_filters_ships_and_subsamples_tracks() {
        let mut decoded = empty_decode();
        // Two ships (type 2), 16 samples each along x.
        for eid in [1, 2] {
            decoded.positions.insert(
                eid,
                (0..16)
                    .map(|i| sample(i as f32, 100.0 + i as f32, 0.0))
                    .collect(),
            );
            decoded.kinds.insert(eid, kind(2, 100.0, 0.0));
        }
        // A squadron (type 4) — traffic, not a spawn.
        decoded
            .positions
            .insert(7, (0..8).map(|i| sample(i as f32, 500.0, 500.0)).collect());
        decoded.kinds.insert(7, kind(4, 500.0, 500.0));
        // A capture zone (type 14, radius present) — no position samples.
        let mut zone = kind(14, 250.0, -250.0);
        zone.radius = Some(120.0);
        zone.control_point_index = Some(1);
        zone.initial_team = Some(-1);
        decoded.kinds.insert(9, zone);
        // An unrelated zone WITHOUT geometry (strike zone) — skipped.
        decoded.kinds.insert(10, kind(14, 999.0, 999.0));

        let insight = insight_of_decode(&decoded, "map".into(), "pvp".into());
        assert_eq!(insight.map, "map");
        // Spawns: exactly the two ships' first samples.
        assert_eq!(insight.spawns, vec![(100.0, 0.0), (100.0, 0.0)]);
        // Tracks: every entity's stream every 8th sample (16→2, 16→2, 8→1).
        assert_eq!(insight.tracks.len(), 5);
        assert_eq!(insight.tracks[0], (100.0, 0.0));
        assert!(
            insight
                .tracks
                .iter()
                .any(|&(x, z)| (x - 108.0).abs() < 0.001 && z == 0.0)
        );
        // Caps: only the qualified zone, with its geometry and owner.
        assert_eq!(insight.caps.len(), 1);
        assert_eq!(insight.caps[0].index, 1);
        assert_eq!(insight.caps[0].radius, Some(120.0));
        assert_eq!(insight.caps[0].team, Some(-1));
    }

    // ── argv ─────────────────────────────────────────────────────────────

    #[test]
    fn args_parse_flags_and_command_defaults() {
        let scan: Vec<String> = ["scan", "--archive", "arch", "--out", "idx.json"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        match parse_args(&scan).unwrap() {
            Command::Scan(a) => {
                assert_eq!(a.archive, PathBuf::from("arch"));
                assert_eq!(a.out, PathBuf::from("idx.json"));
            },
            other => panic!("wrong command {other:?}"),
        }
        let insights: Vec<String> = ["insights", "--archive", "arch"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        match parse_args(&insights).unwrap() {
            Command::Insights(a) => {
                assert_eq!(a.archive, PathBuf::from("arch"));
                assert_eq!(a.out, PathBuf::from("map-insights.json"));
            },
            other => panic!("wrong command {other:?}"),
        }
    }

    #[test]
    fn args_reject_unknowns_and_missing_commands() {
        let empty: Vec<String> = Vec::new();
        assert!(parse_args(&empty).is_err());
        let bad_cmd: Vec<String> = vec!["frobnicate".into()];
        assert!(parse_args(&bad_cmd).is_err());
        let unknown_flag: Vec<String> = vec!["scan".into(), "--wat".into()];
        assert!(parse_args(&unknown_flag).is_err());
        let missing_value: Vec<String> = vec!["scan".into(), "--archive".into()];
        assert!(parse_args(&missing_value).is_err());
    }
}
