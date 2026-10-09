use serde::{Deserialize, Serialize};

/// One position sample for one entity at one instant — the raw output of M3's
/// packet-stream decoder. WoWS maps are planar: x = east, z = north, y ≈ 0.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionSample {
    /// Seconds since match start.
    pub time: f32,
    /// BigWorld entity id (map to a player via ReplayMeta.vehicles shipId/id).
    pub entity_id: i32,
    pub vehicle_id: i32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Heading (radians) about the vertical axis.
    pub yaw: f32,
}

/// A per-entity trajectory: the full position timeline for one ship, ready for
/// the holographic map to scrub.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityTrajectory {
    pub entity_id: i32,
    /// Metadata from the EntityCreate (0x05) packet: type, vehicleId, initial
    /// position. `None` when the replay never created the entity (rare).
    pub kind: Option<EntityKind>,
    pub samples: Vec<PositionSample>,
    /// Match time (seconds) at which the entity was destroyed (EntityDestroy
    /// 0x06), if it was. `None` = survived the whole match. The frontend freezes
    /// the marker here and tints it grey.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub death_time: Option<f32>,
    /// HP timeline from EntityProperty (0x07) packets. Pairs of (time, hp_value).
    /// Empty when the replay contains no HP data for this entity.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hp_samples: Vec<HpSample>,
    /// Capture zone property 0 samples (0=neutral, 1=captured by team A, etc.)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cap_samples: Vec<HpSample>,
    /// Capture-zone progress stream from NestedPropertyUpdate (0x23) packets:
    /// 0..1 fraction of the current capture, reset to 0 on ownership change.
    /// This is the game's own progress — much more accurate than simulating
    /// it from ship positions. Only present for capture zones.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cap_progress: Vec<HpSample>,
}

/// A single HP snapshot from the replay's property stream.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HpSample {
    pub time: f32,
    pub value: u32,
}

/// An explosion impact observed by the recorder's avatar (`receiveExplosions`,
/// method id version-dependent — see the decoder's method tables). Carries the
/// world-space impact point for shell splash FX; the flight paths themselves
/// come from [`ShellLaunchEvent`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplosionEvent {
    pub time: f32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// GameParams id of the shell that caused the impact — resolves to the
    /// shell type (HE/AP/SAP) for per-type colors and trails on the frontend.
    pub params_id: u32,
}

/// One artillery shell in flight (`receiveArtilleryShots` on the avatar): the
/// launch position, the server-computed target point, and the remaining flight
/// time — everything needed to draw a true ballistic arc per shell without
/// guessing the shooter from impact points.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellLaunchEvent {
    pub time: f32,
    /// Firing vehicle entity id (joins EntityTrajectory.entityId).
    pub owner_id: i32,
    /// GameParams id of the shell (HE/AP/SAP colour resolution).
    pub params_id: u32,
    /// Salvo id shared by shells fired in one click.
    pub salvo_id: i32,
    /// Per-barrel shot id within the salvo (unique per owner).
    pub shot_id: u16,
    /// Muzzle position (world space).
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Server-side aim point (world space) — where this shell will land.
    pub target_x: f32,
    pub target_y: f32,
    pub target_z: f32,
    /// Seconds until impact in the server's time units — divide by 2.75 for
    /// battle seconds (the minimap_renderer reference's calibrated constant:
    /// flight ticks = serverTimeLeft / 2.75).
    pub server_time_left: f32,
    /// Muzzle velocity (m/s).
    pub speed: f32,
    /// Firing barrel index (main vs secondary battery hints).
    pub gun_barrel_id: u16,
}

/// A torpedo launch (`receiveTorpedoes` on the avatar): each fish carries its
/// own spawn point, direction and shot id, so spreads fan out correctly.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TorpedoLaunch {
    pub time: f32,
    /// Firing vehicle entity id (joins EntityTrajectory.entityId).
    pub owner_id: i32,
    /// GameParams id of the torpedo.
    pub params_id: u32,
    /// Salvo id shared by torpedoes launched together.
    pub salvo_id: i32,
    /// Shot id within the salvo — (owner, shot) uniquely identifies the fish.
    pub shot_id: u16,
    /// Spawn position (world space).
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Launch direction (world space, not normalized — magnitude carries the
    /// server's speed coefficient).
    pub dir_x: f32,
    pub dir_y: f32,
    pub dir_z: f32,
    /// Whether the torpedo left the launcher armed.
    pub armed: bool,
}

/// A guidance update for a homing torpedo (`receiveTorpedoDirection`): the
/// current position and target heading of an already-launched acoustic
/// torpedo, letting the viewer bend its track instead of drawing a straight
/// line from the launch point.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TorpedoSteer {
    pub time: f32,
    /// Firing vehicle entity id (matches TorpedoLaunch.ownerId).
    pub owner_id: i32,
    /// Shot id (matches TorpedoLaunch.shotId).
    pub shot_id: u16,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Heading the torpedo is turning towards (radians).
    pub target_yaw: f32,
}

/// An aircraft-squadron marker appearing on the minimap
/// (`receive_addMinimapSquadron` on the avatar). The composite plane id packs
/// the owning carrier in its low 32 bits.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinimapSquadronAdd {
    pub time: f32,
    /// Composite squadron id (low 32 bits: owner vehicle id).
    pub plane_id: u64,
    /// Owning carrier vehicle entity id (joins EntityTrajectory.entityId).
    pub owner_id: i32,
    /// Team id as broadcast (-1 neutral, 0/1 teams).
    pub team_id: i8,
    /// GameParams id of the aircraft type.
    pub params_id: u32,
    /// Squadron position (world space; y = minimap VECTOR2 second component).
    pub x: f32,
    pub z: f32,
}

/// A squadron marker move (`receive_updateMinimapSquadron`): the new squadron
/// position in the same world-space terms as [`MinimapSquadronAdd`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinimapSquadronMove {
    pub time: f32,
    pub plane_id: u64,
    pub x: f32,
    pub z: f32,
}

/// A squadron marker disappearing (`receive_removeMinimapSquadron`) — landed,
/// shot down, or recalled.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinimapSquadronRemove {
    pub time: f32,
    pub plane_id: u64,
}

/// A fighter-patrol ward appearing (`receive_wardAdded`): the patrol circle
/// aircraft hold while orbiting. The arg layout gained a trailing `wardType`
/// byte in 13.2.0 — the decoder fills `0` (unknown) on older replays.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WardEvent {
    pub time: f32,
    /// Patrol id (same composite plane-id space as squadron markers).
    pub squadron_id: u64,
    /// Owning carrier vehicle id (joins EntityTrajectory.entityId).
    pub owner_id: i64,
    /// Team id as broadcast (-1 neutral, 0/1 teams).
    pub team_id: i8,
    /// Patrol centre (world space).
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Patrol radius in world metres — scene units match world metres.
    pub radius: f32,
    /// Ward kind (13.2.0+); 0 = unknown on older replays.
    pub ward_type: u8,
}

/// A patrol ward disappearing (`receive_wardRemoved`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WardRemoveEvent {
    pub time: f32,
    pub plane_id: u64,
}

/// One projectile kill (`receiveShotKills`): the terminal position of a shell
/// or torpedo that destroyed something. Joins [`ShellLaunchEvent`] /
/// [`TorpedoLaunch`] by (ownerId, shotId) to snap arcs onto the victim and
/// stop in-flight torpedoes at the hit.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotKillEvent {
    pub time: f32,
    /// Firing vehicle entity id.
    pub owner_id: i32,
    /// Hit type from the pack (penetration/overpen/... — raw id).
    pub hit_type: u8,
    pub shot_id: u16,
    /// Terminal (impact) position in world space.
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

/// One cumulative damage-stat tick (`receiveDamageStat` on the recorder's
/// avatar): the server's running total for a single (weapon, category) pair
/// at a battle timestamp. Values are CUMULATIVE and REPLACE the previous
/// entry for the same pair — fold by keeping the latest sample per pair
/// (at or before a given time), never by summing across samples. Only
/// category 0 (enemy) rows count as damage dealt.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DamageStatSample {
    pub time: f32,
    /// Weapon id (DamageStatWeapon): 1/2 main-gun AP/HE, 7 ship torpedo,
    /// 11/12/28/41-43 aircraft bombs/torps/rockets, 17 burn, 20 flood, ...
    pub weapon: i64,
    /// 0 = enemy (damage dealt), 1 = ally, 2 = spotting, 3 = agro.
    pub category: i64,
    /// Cumulative hit count for the pair.
    pub count: i64,
    /// Cumulative damage total for the pair.
    pub total: f64,
}

/// A weapon-lock state change (`SetWeaponLock`, 0x30): the recorder's own
/// vehicle locking/unlocking a target entity. The lock timeline lets the
/// frontend draw an aim line to the locked ship and prefer it when
/// reconstructing shell flights.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeaponLockEvent {
    pub time: f32,
    pub weapon_type: u32,
    pub lock_type: u32,
    /// Target entity id (0 when lock_type is not Target).
    pub target_id: i32,
}

/// One camera-state sample (Camera, 0x25): the recorder's own camera pose
/// every tick, usable to replay the original spectating view.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraSample {
    pub time: f32,
    pub rot_x: f32,
    pub rot_y: f32,
    pub rot_z: f32,
    pub rot_w: f32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Field of view in radians.
    pub fov: f32,
}

/// One player network-stat sample (PlayerNetStats, 0x1d).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetStatsSample {
    pub time: f32,
    pub fps: u8,
    pub ping: u16,
    pub is_lagging: bool,
}

/// An aircraft-squadron creation (`receive_addSquadron` on the avatar): the
/// squadron's game-params id and its spawn position. Method id resolves via
/// the decoder's per-version tables.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadronCreate {
    pub time: f32,
    /// Composite plane id (high bits: spawn index, low bits: owner entity).
    pub plane_id: u64,
    /// GameParams id of the aircraft type.
    pub params_id: u32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

/// One aircraft position sample (`receive_updateSquadron` on the avatar): a
/// per-plane waypoint of the squadron's 3D aerial path. Method id resolves via
/// the decoder's per-version tables.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadronPlane {
    pub time: f32,
    pub plane_id: u64,
    /// Position within the squadron formation (0..squadron size) — one
    /// sample per aircraft per update, so `(plane_id, index)` uniquely
    /// identifies a single plane. The frontend renders one model per index.
    pub index: u8,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
}

/// One battle-chat message (`onChatMessage` on the avatar): the server
/// broadcasts every player's chat through the recorder's avatar entity, so the
/// stream carries the whole match's chat timeline. `player_id` joins the
/// descriptor's `vehicles` roster (`vehicle.id` — account DB ids), NOT the
/// vehicle entity ids.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEvent {
    pub time: f32,
    /// Sender's roster player id (descriptor `vehicles[].id`).
    pub player_id: i32,
    /// Channel namespace. The audiences the client's BattleController knows:
    /// `battle_common` (all chat), `battle_team` (team chat), `battle_prebattle`
    /// (division chat); anything else is server-specific.
    pub namespace: String,
    /// Plaintext message body (UTF-8).
    pub message: String,
}

/// One in-battle achievement award (`onAchievementEarned` on the avatar): a
/// player earned a medal/achievement during the match. `achievement_id` is
/// the GameParams Achievement entry id (matches the `playersPublicInfo`
/// achievement list in the battle results; joins the bundled
/// `achievement_names.json` for display names).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementEvent {
    pub time: f32,
    /// Earner's roster player id (descriptor `vehicles[].id`).
    pub player_id: i32,
    /// GameParams Achievement entry id.
    pub achievement_id: u32,
}

/// One player/bot entry from the arena's initial state
/// (`onArenaStateReceived` on the avatar, decoded at match start). This is
/// the server's authoritative ship-entity → team/player mapping: the
/// entity-id → team join no longer has to be guessed from spawn order or
/// shipId collisions (mirror picks share one roster `shipId`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaPlayer {
    /// The player's SHIP vehicle entity id (the arena FixedDict's `shipId`;
    /// joins `EntityTrajectory.entityId`). NOT the GameParams id.
    pub entity_id: i32,
    /// 0/1 team slot. Which side is "ours" is `self_team` on the stream.
    pub team_id: i8,
    /// Roster player id — joins the descriptor roster `vehicles[].id` (the
    /// arena FixedDict's `id`; the accountDBID field is a different number
    /// and joins nothing the frontend uses).
    #[serde(default, skip_serializing_if = "is_zero_i64")]
    pub player_id: i64,
    /// GameParams ship id — joins the descriptor `vehicles[].shipId` and the
    /// ship encyclopedia (mirror picks share it, so it is not a player key).
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub ship_params_id: u32,
    /// Starting health of this exact ship build (upgrades included).
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub max_health: u32,
    /// Player name as the arena knows it (bots included).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// True for bot entries (decoded from the arena's bots blob).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_bot: bool,
    /// The player's Avatar entity id (human players only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_id: Option<i32>,
    /// True for the recorder's own entry (avatar id matches the
    /// CellPlayerCreate entity).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_self: bool,
}

fn is_zero_i64(v: &i64) -> bool {
    *v == 0
}

fn is_zero_u32(v: &u32) -> bool {
    *v == 0
}

/// One global-weather transition (`state.weather.globalWeather`'s "item"
/// SetKey on the BattleLogic entity, NestedPropertyUpdate 0x23): the match's
/// ambient weather blends from one weather logic to another over a linear
/// interpolation window — the cyclone/storm timeline. `from_param` /
/// `to_param` are GlobalWeather GameParams ids (e.g. 4288989104
/// PCOW005_Evening → 4283746224 PCOW010_Rain_Logic); the gameplay effect
/// (cyclone spotting-range collapse) ramps across `start_time`..`end_time`
/// in battle seconds.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherTransition {
    /// Packet clock when the update was broadcast.
    pub time: f32,
    /// Battle second the interpolation window opens at.
    pub start_time: f32,
    /// Battle second the window closes at (weather fully switched).
    pub end_time: f32,
    /// GlobalWeather GameParams id the weather blends from.
    pub from_param: u32,
    /// GlobalWeather GameParams id the weather blends to.
    pub to_param: u32,
}

/// One global-weather notification (the same property's "notification"
/// SetKey): the server's warning that a weather state arrives at a battle
/// second — the cyclone/storm approach warning the client announces.
/// `param` is the incoming weather's GlobalWeather GameParams id.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherNotification {
    /// Packet clock when the update was broadcast.
    pub time: f32,
    /// Battle second the warned-about weather takes effect.
    pub at_time: f32,
    /// GlobalWeather GameParams id of the incoming weather.
    pub param: u32,
}

/// Everything the holographic replay viewer needs from the packet stream:
/// entity trajectories plus battle-effect events (explosions, torpedo
/// launches) that are broadcast as entity methods rather than entities.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStream {
    pub trajectories: Vec<EntityTrajectory>,
    /// Artillery launches (`receiveArtilleryShots`) — the primary shell data:
    /// muzzle point, aim point and flight time per projectile.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shell_launches: Vec<ShellLaunchEvent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub explosions: Vec<ExplosionEvent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub torpedoes: Vec<TorpedoLaunch>,
    /// Homing-torpedo guidance updates (`receiveTorpedoDirection`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub torpedo_steers: Vec<TorpedoSteer>,
    /// Recorder weapon-lock timeline (SetWeaponLock, 0x30).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub weapon_locks: Vec<WeaponLockEvent>,
    /// Raw battle-results payload (BattleResults, 0x22) — the server's post-
    /// battle statistics JSON when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub battle_results: Option<String>,
    /// Replay protocol version string (Version, 0x16).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Map name from the Map packet (0x28) when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_name: Option<String>,
    /// Recorder camera timeline (Camera, 0x25) — one pose per tick.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub camera: Vec<CameraSample>,
    /// Player network stats (PlayerNetStats, 0x1d) — fps/ping per tick.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub net_stats: Vec<NetStatsSample>,
    /// Entity id → last time it left the observed area (EntityLeave, 0x04).
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub leaves: std::collections::BTreeMap<i32, f32>,
    /// Camera-mode changes (0x27) — spectating view modes over time.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub camera_modes: Vec<HpSample>,
    /// Counts of the remaining decoded system packets (diagnostics).
    #[serde(default, skip_serializing_if = "DiagnosticCounts::is_default")]
    pub diagnostics: DiagnosticCounts,
    /// Aircraft squadrons: spawn events + per-plane position streams from
    /// the avatar's receive_addSquadron / receive_updateSquadron methods.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub squadron_creates: Vec<SquadronCreate>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub squadron_planes: Vec<SquadronPlane>,
    /// Minimap squadron markers (receive_add/update/removeMinimapSquadron) —
    /// the 2D trail source the in-game minimap itself uses.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub minimap_squadron_adds: Vec<MinimapSquadronAdd>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub minimap_squadron_moves: Vec<MinimapSquadronMove>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub minimap_squadron_removes: Vec<MinimapSquadronRemove>,
    /// Fighter-patrol wards (receive_wardAdded / receive_wardRemoved).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub wards: Vec<WardEvent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ward_removes: Vec<WardRemoveEvent>,
    /// Projectile kills (receiveShotKills) — terminal impact points.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shot_kills: Vec<ShotKillEvent>,
    /// Server-authoritative cumulative damage stats (receiveDamageStat) for
    /// the recorder — exact per-weapon damage (incl. aircraft weapons),
    /// emitted every few seconds during engagements.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub damage_stats: Vec<DamageStatSample>,
    /// Battle chat timeline (avatar onChatMessage) — every player's messages
    /// with match timestamps.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chat_messages: Vec<ChatEvent>,
    /// In-battle achievement awards (avatar onAchievementEarned).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub achievements: Vec<AchievementEvent>,
    /// The arena's initial player/bot state (`onArenaStateReceived`) — the
    /// authoritative ship-entity → team/player join. Empty on versions whose
    /// exposed method id isn't pinned or whose payload fails the shape
    /// checks; consumers then fall back to the EntityCreate shipId join.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub arena_players: Vec<ArenaPlayer>,
    /// Global-weather transitions (cyclone/storm timeline) from the
    /// BattleLogic entity's nested-property stream — interpolation windows
    /// between weather logics, in battle seconds.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub weather_transitions: Vec<WeatherTransition>,
    /// Global-weather approach warnings (the same stream): one incoming
    /// weather id + the battle second it fires at.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub weather_notifications: Vec<WeatherNotification>,
    /// Team slot (0/1) of the recorder, from the `is_self` arena entry.
    /// `None` when the arena state is missing or the recorder's avatar
    /// didn't match any entry (very old replays).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub self_team: Option<i8>,
}

/// Slim battle snapshot for the live self-stats view (我的战绩): the
/// [`ReplayStream`] families the personal report reads — ship trajectories,
/// hit events, the recorder's damage stream, achievements, the arena join
/// and the post-battle payload — with every other family (camera, net
/// stats, squadrons, chat, weather, diagnostics…) and every non-ship
/// trajectory dropped before serialization. The view polls this against the
/// in-progress temp replay every few seconds, so the IPC payload stays
/// proportional to what it renders instead of the full decode's output.
///
/// `Default` is the "nothing decodable yet" snapshot: the live temp
/// container exists but its header blocks are not fully flushed (battle
/// start / loading), so there is legitimately nothing to report — an empty
/// stream keeps the view's syncing state instead of surfacing an error for
/// a file that is simply mid-write.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSelfStream {
    /// Ship trajectories only (entity type 2), positions + HP timelines +
    /// death times — the hit-attribution substrate.
    pub trajectories: Vec<EntityTrajectory>,
    /// Projectile kills (receiveShotKills) — the hit-level attribution key.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shot_kills: Vec<ShotKillEvent>,
    /// Cumulative damage stats for the recorder (server totals).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub damage_stats: Vec<DamageStatSample>,
    /// In-battle achievement awards.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub achievements: Vec<AchievementEvent>,
    /// The authoritative ship-entity → player join.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub arena_players: Vec<ArenaPlayer>,
    /// Artillery launches (receiveArtilleryShots) — the (ownerId, shotId)
    /// join that classifies a hit event's damage as gun fire for the
    /// per-target damage composition.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shell_launches: Vec<ShellLaunchEvent>,
    /// Torpedo launches (receiveTorpedoes) — the same join's torpedo side.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub torpedoes: Vec<TorpedoLaunch>,
    /// Raw post-battle payload (BattleResults 0x22) once it lands.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub battle_results: Option<String>,
}

impl LiveSelfStream {
    /// Project a full decoded stream down to the slim shape (see the struct
    /// doc): ships-only trajectories, personal-combat families only.
    pub fn from_full(mut full: ReplayStream) -> Self {
        full.trajectories
            .retain(|t| t.kind.as_ref().map(|k| k.entity_type) == Some(2));
        Self {
            trajectories: full.trajectories,
            shot_kills: full.shot_kills,
            damage_stats: full.damage_stats,
            achievements: full.achievements,
            arena_players: full.arena_players,
            shell_launches: full.shell_launches,
            torpedoes: full.torpedoes,
            battle_results: full.battle_results,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticCounts {
    pub server_ticks: u32,
    pub server_timestamps: u32,
    pub init_flags: u32,
    pub init_markers: u32,
    pub base_player_creates: u32,
    pub create_stubs: u32,
    pub entity_controls: u32,
    pub entity_enters: u32,
    pub camera_modes: u32,
    pub camera_freelooks: u32,
    pub sub_controllers: u32,
    pub cruise_states: u32,
    pub shot_trackings: u32,
    pub gun_markers: u32,
}

impl DiagnosticCounts {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

/// Entity metadata from an EntityCreate (0x05) packet. The fixed header is
/// readable without the per-version entity DB; the trailing `state` BinaryStream
/// (entity properties) is scanned for the roster shipId (see `ship_id`).
///
/// `entity_type` semantics (empirically observed on WoWS 14.5):
///   2 = vehicle (ships, planes, projectiles — ships have the most position
///       updates, so the frontend filters by sample count to keep only ships)
///   4 = aircraft / squadron
///  11 = player avatar (the camera follower; position 0,0,0)
///  14 = capture zone (static)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityKind {
    pub entity_type: i16,
    /// Per-version constant in current clients (7770 / 10513) — NOT a player
    /// id. Kept for diagnostics only; use `ship_id` for the roster join.
    pub vehicle_id: i32,
    pub initial_x: f32,
    pub initial_y: f32,
    pub initial_z: f32,
    /// Match time (seconds) when this entity was created via EntityCreate.
    /// Entities that existed before the replay started have time -1.0.
    #[serde(default = "default_creation_time")]
    pub creation_time: f32,
    /// Roster shipId recovered from the EntityCreate state stream (the ship's
    /// GameParams id, matching `ReplayMeta.vehicles[].shipId`). This is the
    /// only reliable entity → player join key: `vehicle_id` is a per-version
    /// constant and the entity-id spawn order is not team-grouped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ship_id: Option<i64>,
    /// Starting (max) health recovered from the EntityCreate state stream
    /// (the largest integral f32 in the full-HP band — the property's offset
    /// drifts between game versions, see `scan_state_for_max_health`). The
    /// arena broadcast remains the authoritative source wherever it decodes
    /// (WG); this field backs the Lesta arena synthesis, whose recordings
    /// carry no arena state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_health: Option<u32>,
    /// Capture-zone radius in metres, recovered from the EntityCreate state
    /// stream (only present for entityType 14 zones; the first integral f32
    /// in the state — 80..140 m across current maps). The frontend floors
    /// the drawn ring size when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius: Option<f32>,
    /// 0-based capture-point index (A=0, B=1, ...) recovered from the
    /// EntityCreate `componentsState.controlPoint` component. Only real
    /// domination points carry it; strike/event InteractiveZones have an
    /// empty componentsState and yield `None`. This is the authoritative
    /// "is a capture point" flag — it ships with the create packet itself,
    /// so it works even when the replay records no ownership/progress
    /// updates afterwards.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_point_index: Option<i32>,
    /// Initial owning team of a capture zone (0/1 = team, -1 = neutral),
    /// recovered from the InteractiveZone `teamId` property (INT8, the first
    /// property byte of the state stream). Zones owned from match start emit
    /// no capSamples/capProgress updates, so the opening colour must come
    /// from the create state itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_team: Option<i8>,
}

fn default_creation_time() -> f32 {
    -1.0
}
