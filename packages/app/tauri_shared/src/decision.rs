//! Decision-AI feasibility surface (PR #448): the E1 dummy inference
//! state, the model-pack status report, the visibility probe (E11) and the
//! full decision-tick snapshot (G1) — the wire types shared between the
//! experiment commands and the webui suggestion layer.
use serde::{Deserialize, Serialize};

/// Feasibility-shell (experiment E1) battlefield snapshot for the decision-AI
/// inference chain. A deliberately dummy 8-float encoding of the incomplete
/// battle state — the real feature vector replaces it once the actual model
/// is trained. Field order IS the model input order (see
/// `commands::decision_ai`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionDummyState {
    /// sin(own heading), heading normalized to [0, 2π).
    pub own_heading_sin: f32,
    /// cos(own heading).
    pub own_heading_cos: f32,
    /// Own current speed (normalized by the caller).
    pub own_speed: f32,
    /// sin(bearing to nearest enemy).
    pub enemy_bearing_sin: f32,
    /// cos(bearing to nearest enemy).
    pub enemy_bearing_cos: f32,
    /// Distance to nearest enemy (normalized).
    pub enemy_distance: f32,
    /// Own hit-point fraction, [0, 1].
    pub own_hp_fraction: f32,
    /// 1.0 when the nearest enemy is currently visible, else 0.0.
    pub target_visible: f32,
}

/// Feasibility-shell (experiment E1) decision suggestion mapped out of the
/// tiny fixture model's output logits. Placeholder semantics — a proof of
/// the wire format, not tactical advice.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionDummySuggestion {
    /// Compass sector to steer toward: argmax over output logits 0..4 (0-3).
    pub heading_sector: u32,
    /// Throttle level: argmax over output logits 4..7 (0-2).
    pub speed_setting: u32,
    /// Whether the model votes to fire: last output logit > 0.
    pub fire: bool,
}

/// Runtime status of the decision-AI inference chain (E1 diagnostics).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionAiStatus {
    /// The `ort` crate version this binary was built against.
    pub ort_version: String,
    /// Native ONNX Runtime build info (version, git commit, compile flags).
    pub runtime_info: String,
    /// Whether the embedded fixture model initialized into a live session.
    pub fixture_loaded: bool,
}

/// Installed `decisions` model-pack inventory (`<cache>/decisions`): the
/// ONNX fire model plus one terrain-LOS raster per map subdirectory. The
/// pack is installed out of band; the settings' resources page reads this
/// to show what is on disk and to offer a clear.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionsPackStatus {
    /// Whether the pack directory exists at all.
    pub present: bool,
    /// Absolute pack directory (shown in the settings row).
    pub dir: String,
    /// Recursive size of the pack directory.
    pub size_bytes: u64,
    /// Whether `fire_model.onnx` is installed.
    pub model_present: bool,
    /// Size of the installed model file (0 when absent).
    pub model_bytes: u64,
    /// Whether `move_model.onnx` is installed (E16 movement model; packs
    /// built before it carry only the fire model).
    #[serde(default)]
    pub move_model_present: bool,
    /// Size of the installed movement model file (0 when absent).
    #[serde(default)]
    pub move_model_bytes: u64,
    /// Map short names that already have a `terrain_los.npz` raster,
    /// sorted ascending.
    pub los_maps: Vec<String>,
}

// ═══════════════════════════════════════════════════════════════════════
//  Replay visibility probe (experiment E3)
// ═══════════════════════════════════════════════════════════════════════

/// One uninterrupted period during which an entity produced no position
/// samples — the working proxy for "not spotted by the recorder's team"
/// (allies and spotted enemies stream positions; unspotted enemies do not).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibilityGap {
    /// Gap start (seconds since match start; the last sample before the gap).
    pub from: f32,
    /// Gap end (the first sample after the gap).
    pub to: f32,
    pub duration: f32,
}

/// Per-entity visibility statistics produced by the replay probe (E3).
///
/// Team attribution (`team_id`) joins entity → shipId (EntityCreate state
/// scan) → roster relation / battle-results teamId. The join is only unique
/// when no roster entry on the OTHER team plays the same ship: in that case
/// `team_id` is `None` and `ship_id_ambiguous` is set. This is a known
/// capability gap — a deterministic per-player join would need an
/// entity-level identity the packet stream does not currently expose.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityVisibilityStats {
    pub entity_id: i32,
    /// EntityCreate type index (2 = vehicle/ship, 4 = aircraft, 14 = zone...).
    pub entity_type: i16,
    /// Roster shipId when the EntityCreate state scan found a unique match.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ship_id: Option<i64>,
    /// 0 = recorder's team, 1 = enemy (relative to the recording player);
    /// `None` when the join was impossible or ambiguous.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<i8>,
    /// The shipId matched roster entries on BOTH teams — team attribution is
    /// impossible via the shipId join.
    #[serde(default)]
    pub ship_id_ambiguous: bool,
    /// True for the recorder's own vehicle entity (always observed).
    #[serde(default)]
    pub is_recorder: bool,
    /// Match time the entity was destroyed, if it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub death_time: Option<f32>,
    /// First position sample time; `None` when the entity has no samples
    /// (static zones, entities never observed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_sample_time: Option<f32>,
    /// Total position samples.
    pub sample_count: u32,
    /// Mean samples per second over the entity's observed span.
    pub avg_sample_rate: f32,
    /// Gaps in the sample stream longer than the probe's threshold.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gaps: Vec<VisibilityGap>,
    /// Total duration (seconds) of all listed gaps.
    pub gap_total: f32,
    /// Fraction of the entity's life window during which it was being
    /// observed (inter-sample intervals at or below the gap threshold).
    /// 1.0 = continuously observed (allies, the recorder itself).
    pub observed_fraction: f32,
}

/// Whole-report container for the replay visibility probe.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayProbeReport {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The gap threshold (seconds) the gap statistics were computed with.
    pub gap_threshold_seconds: f32,
    /// Match end proxy: the latest position sample across all entities.
    pub match_end: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recorder_vehicle_id: Option<i32>,
    /// ShipIds that matched roster entries on both teams (per-team counts),
    /// making their entities' team attribution impossible.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ambiguous_ship_ids: Vec<AmbiguousShipId>,
    /// Per-entity stats, entity id order. Ships (type 2) first-class; the
    /// consumer filters by `entity_type`.
    pub entities: Vec<EntityVisibilityStats>,
}

/// A shipId that appears on both teams of the roster — entities carrying it
/// cannot be team-attributed via the shipId join.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmbiguousShipId {
    pub ship_id: i64,
    /// Roster entries on the recorder's team playing this ship.
    pub ally_count: u32,
    /// Roster entries on the enemy team playing this ship.
    pub enemy_count: u32,
}

// ═══════════════════════════════════════════════════════════════════════
//  Decision tick state (experiments E5 + E6)
// ═══════════════════════════════════════════════════════════════════════

/// The recorder's own ship at one decision tick — the "self" observation the
/// decision model conditions on. Everything here is exact (own-ship data is
/// fully visible to the recording client); speeds are converted to knots via
/// the E5 scene-unit calibration (`commands::decision_tick::METERS_PER_UNIT`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionTickRecorder {
    pub entity_id: i32,
    pub x: f32,
    pub z: f32,
    /// Heading (radians) at the latest sample at/before the tick.
    pub yaw: f32,
    /// Planar speed in knots; `None` when fewer than ~1 s of own samples
    /// precede the tick.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_kt: Option<f32>,
    /// Raw engine-telegraph level (-1..4) of the latest CruiseState at/before
    /// the tick; `None` before the first control packet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub throttle_level: Option<i32>,
    /// Normalized throttle fraction (level / 4) when the level's meaning is
    /// confirmed (see [`CruiseSample`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub throttle_value: Option<f32>,
    /// Raw rudder level (-2..2) of the latest rudder CruiseState.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rudder_level: Option<i32>,
    /// Normalized rudder deflection (level / 2) when confirmed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rudder_value: Option<f32>,
    /// Latest HP at/before the tick, when the entity streamed any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hp: Option<u32>,
    /// False once the ship's inferred death time passes the tick.
    #[serde(default)]
    pub alive: bool,
}

/// One OTHER entity as the recorder knows it at a decision tick — a
/// deliberately incomplete-information view (experiment E6's core constraint):
/// enemy data is whatever the recording client had received by `t`, so fields
/// carry last-known values plus how stale they are (`lastObservedDelta`), and
/// `observedNow: false` must be read as "this row is stale intel", not as a
/// current observation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionTickEntity {
    pub entity_id: i32,
    /// EntityCreate type index (2 = ship in v1 — only ships are listed).
    pub entity_type: i16,
    /// Roster shipId when the EntityCreate state scan matched one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ship_id: Option<i64>,
    /// 0 = recorder's team, 1 = enemy (recorder-relative, E3 semantics);
    /// `None` when the shipId join was impossible (mirror lineups leave
    /// `teamAmbiguous` set).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<i8>,
    /// The shipId matched roster entries on both sides — team unknown.
    #[serde(default)]
    pub team_ambiguous: bool,
    /// Last position sample at/before the tick (never extrapolated, never
    /// future-leaking).
    pub last_known_x: f32,
    pub last_known_z: f32,
    /// Heading of that last sample (radians).
    pub last_known_yaw: f32,
    /// `t - lastSampleTime`: how stale this row is, in seconds.
    pub last_observed_delta: f32,
    /// True when `lastObservedDelta` is within the E3 gap threshold (~4 s) —
    /// the entity was being observed at the tick ("spotted"). False marks
    /// last-known-only intel.
    #[serde(default)]
    pub observed_now: bool,
    /// Last-known planar speed in knots, estimated by differencing the
    /// trailing observation streak (diffs never span a >4 s sample gap).
    /// `None` when the streak is too short to differentiate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_kt: Option<f32>,
    /// Planar distance from the recorder's position at the tick, in metres
    /// (E5 scale), at the entity's last-known position.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distance_m: Option<f32>,
    /// Last-known HP at/before the tick.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hp: Option<u32>,
    /// False once the entity's death time passes the tick.
    #[serde(default)]
    pub alive: bool,
    /// Terrain occlusion between the recorder and this entity, computed only
    /// for currently-observed ENEMY ships when a LOS raster was supplied:
    /// `Some(true)` = an island blocks the sight line, `Some(false)` = clear,
    /// `None` = not computed (no raster, not an observed enemy).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terrain_blocked: Option<bool>,
}

/// One capture zone's state at a decision tick.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionTickZone {
    pub entity_id: i32,
    /// 0-based domination point index (A=0, B=1, ...) for real capture
    /// points; `None` for base/strike zones without a controlPoint component.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_point_index: Option<i32>,
    /// Ring radius (scene units) recovered from the create state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius: Option<f32>,
    /// Ownership at the tick: the latest cap-property sample at/before the
    /// tick, falling back to the create-state initial team when the zone never
    /// streamed an update. RAW wire value, NOT unified across its two sources
    /// (the cap property is documented elsewhere as 0 = neutral / 1,2 = teams,
    /// but on the E6 reference replay the two opposing base zones read 0 and
    /// 1 — closer to absolute team ids; the initial team is -1 neutral, 0/1
    /// teams). Consumers must treat this as opaque until the namespaces are
    /// calibrated against battle results.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<i32>,
    /// Live capture progress at the tick (0..1 fraction of the current
    /// capture), when the zone streamed any progress updates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<f32>,
}

/// Combat-event counts in the trailing window ending at the tick (default
/// 30 s) — a coarse "how hot is the fight" feature block.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionTickEvents {
    /// Artillery shells launched in the window (all owners).
    pub shell_launches: u32,
    pub torpedo_launches: u32,
    pub explosions: u32,
    /// Subset launched by the recorder's own vehicle.
    pub shell_launches_by_recorder: u32,
    pub torpedo_launches_by_recorder: u32,
    /// Explosions within ~500 m of the recorder's position — an incoming-fire
    /// proxy (explosion events carry no owner to attribute).
    pub explosions_near_recorder: u32,
}

/// The decision-model input snapshot for one replay at one instant
/// (`commands::decision_tick::build_tick_state`) — experiment E6.
///
/// This is a RECORDER-VIEW incomplete-information state, not a god view: an
/// enemy exists here only once the recording client first saw it, carries
/// last-known values with explicit staleness, and `observedNow=false` rows
/// must be treated as stale intel by any consumer. Only ships (entity type 2)
/// are listed in `entities` in this first version — aircraft/projectile
/// transients are excluded to keep the surface bounded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionTickState {
    /// The tick's match time (seconds since match start).
    pub match_time: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_name: Option<String>,
    pub recorder: DecisionTickRecorder,
    pub entities: Vec<DecisionTickEntity>,
    pub zones: Vec<DecisionTickZone>,
    pub recent_events: DecisionTickEvents,
}
