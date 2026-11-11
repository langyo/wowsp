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
    /// Recorder control-input timeline (CruiseState, 0x32) — engine telegraph
    /// and rudder presets. Only the recorder's own trajectory carries these
    /// (the packet is recorder-scoped, not per-entity; see [`CruiseSample`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cruise_samples: Vec<CruiseSample>,
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
    /// The player's division (组队) id — the arena state's per-player
    /// prebattle group (0 = solo; the 2-3 members of one division share
    /// one id, always within one team). Verified on the 15.9.0 layout era
    /// (the FixedDict pair that reads equal across a division's members);
    /// decoded only there, so every older replay carries 0 and the
    /// frontend renders no division tag.
    #[serde(default, skip_serializing_if = "is_zero_i64")]
    pub prebattle: i64,
}

fn is_zero_i64(v: &i64) -> bool {
    *v == 0
}

fn is_zero_u32(v: &u32) -> bool {
    *v == 0
}

/// One player's decoded ship build (replay build-decode wave): the loadout the
/// server broadcast over the vehicle entity's `shipConfig` create property plus
/// the captain's crew modifiers.
///
/// IPC surface is ALLY-ONLY by product decision: the decode layer keeps both
/// teams' builds (tests + completeness), but the command exit filters to the
/// roster's relation <= 1 (self + team) and this DTO never carries an enemy
/// build. Camouflage/signals live in `exteriors` as GameParams ExteriorSlot
/// ids (PCEP/PCEM/PCED camos, PCEF signal flags); `abilities` are the mounted
/// consumables (PCY ids) and `ecoboosts` the economic bonuses (PCEA ids).
/// Numeric GameParamId -> name/icon resolution is the webui's data layer.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerBuild {
    /// BigWorld vehicle entity id (joins `EntityTrajectory.entityId`).
    pub entity_id: i32,
    /// GameParams ship id the config was built for (joins the roster).
    #[serde(default)]
    pub ship_params_id: u32,
    /// Roster player name when the ship id maps to exactly one ally roster
    /// entry. Two teammates on the same hull keep the build (entity_id still
    /// joins the trajectory) but stay anonymous rather than mis-attributed;
    /// probe-sourced builds always carry the name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Mounted hull/artillery/torpedo/sonar/engine module ids, hull first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub units: Vec<u32>,
    /// Modernization (upgrade) slot item ids.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modernization: Vec<u32>,
    /// Exterior slots: camouflage/paintwork ids and signal-flag ids.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exteriors: Vec<u32>,
    /// Mounted consumable (AbilitySlot) ids.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub abilities: Vec<u32>,
    /// National flag / ensign slot ids.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ensigns: Vec<u32>,
    /// Economic bonus slot ids.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ecoboosts: Vec<u32>,
    /// Captain params id (GameParams crew entry: default or unique commander).
    #[serde(default)]
    pub crew_params_id: u32,
    /// Captain is in adaptation (retraining) after a ship/class switch.
    #[serde(default)]
    pub is_in_adaptation: bool,
    /// Learned captain skills, per-species arrays of GameParams skill ordinals
    /// (CrewSkillType ids; the webui maps them to names/icons/costs).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub learned_skills: Vec<Vec<u8>>,
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

/// Serde adapter that makes [`ReplayStream::leaves`] key itself by STRING on
/// every wire: JSON already stringifies integer map keys, and the webui's
/// MessagePack decoder (@msgpack/msgpack v3) silently drops entries from
/// integer-keyed msgpack maps (verified empirically: `decode(encode({42:
/// 55.5})) === {}`), so the packed IPC wire must carry the same string keys
/// the JSON wire always did.
mod leaves_string_keys {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::collections::BTreeMap;

    pub fn serialize<S: Serializer>(map: &BTreeMap<i32, f32>, s: S) -> Result<S::Ok, S::Error> {
        let keyed: BTreeMap<String, f32> = map.iter().map(|(k, v)| (k.to_string(), *v)).collect();
        keyed.serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<BTreeMap<i32, f32>, D::Error> {
        let keyed: BTreeMap<String, f32> = BTreeMap::deserialize(d)?;
        keyed
            .into_iter()
            .map(|(k, v)| {
                k.parse::<i32>()
                    .map(|id| (id, v))
                    .map_err(|e| serde::de::Error::custom(format!("leaves key {k}: {e}")))
            })
            .collect()
    }
}

/// Everything the holographic replay viewer needs from the packet stream:
/// entity trajectories plus battle-effect events (explosions, torpedo
/// launches) that are broadcast as entity methods rather than entities.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStream {
    pub trajectories: Vec<EntityTrajectory>,
    /// Entity id of the recorder's own vehicle (the type-2 entity the avatar
    /// links to in its PlayerPosition 0x2c stream) — the trajectory that
    /// carries `cruiseSamples`. `None` when the replay carries no trusted
    /// PlayerPosition link: pre-modern-layout replays or a truncated capture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recorder_vehicle_id: Option<i32>,
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
    /// Keys ride the wire AS STRINGS on every codec: serde_json already
    /// emits `{"42": 55.5}` for an integer-keyed map, and @msgpack/msgpack
    /// (the packed IPC wire) silently DROPS entries from integer-keyed
    /// msgpack maps — see leaves_string_keys below.
    #[serde(
        default,
        with = "leaves_string_keys",
        skip_serializing_if = "std::collections::BTreeMap::is_empty"
    )]
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
    /// Per-player ship builds for the recorder's SIDE only — self + teammates
    /// (roster relation <= 1). The decoder decodes both teams; this field is
    /// filtered at the command exit per the product decision that enemy
    /// loadouts are never displayed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ally_builds: Vec<PlayerBuild>,
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
    /// Shield-damage broadcasts (Avatar `receiveShieldDamageInfo`, 15.10+).
    /// Empty on older versions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shield_damage_events: Vec<ShieldDamageEvent>,
    /// Shield HP state timeline (Vehicle `state.shield` nested property,
    /// 15.10+). Empty on older versions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shield_state_events: Vec<ShieldStateEvent>,
    /// Zero-arg shield lifecycle markers (Vehicle `shieldRegen`/`shieldHit`,
    /// 15.10+). Empty on older versions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shield_markers: Vec<ShieldMarkerEvent>,
    /// Gun overheat transitions (Vehicle `setGunOverheated`, 15.10+). Empty
    /// on older versions (and on battles where no gun overheated).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gun_overheats: Vec<GunOverheatEvent>,
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
    /// Entity id of the recorder's own vehicle — the authoritative self
    /// anchor for the personal report's identity join, carried over from
    /// the full stream's `recorder_vehicle_id` (see `ReplayStream`): it
    /// survives a version-drifted arena state and disambiguates mirror
    /// shipId picks where the roster fallback cannot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recorder_vehicle_id: Option<i32>,
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
    /// Ally-only per-player ship builds (self + teammates; enemy builds are
    /// dropped at the command exit, see `ReplayStream::ally_builds`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ally_builds: Vec<PlayerBuild>,
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
            recorder_vehicle_id: full.recorder_vehicle_id,
            shot_kills: full.shot_kills,
            damage_stats: full.damage_stats,
            achievements: full.achievements,
            arena_players: full.arena_players,
            ally_builds: full.ally_builds,
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
    /// Vehicle EntityCreate states whose build payload decoded fully.
    pub builds_decoded: u32,
    /// Vehicle EntityCreate states skipped by the build decoder (unsupported
    /// client version, shape mismatch, or a length byte the decoder cannot
    /// trust — see `wowsp_replay_core::packets::build`).
    pub builds_skipped: u32,
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
    /// The VEHICLE's own team slot (0/1), walked off the EntityCreate state's
    /// `teamId` property through the per-version property table (see
    /// `packets::build::scan_state_for_team_id`). Only versions whose pinned
    /// table exposes the property carry it — earlier replays stay `None` and
    /// the consumers fall back to the arena/roster joins. This is the one
    /// side signal that covers ships the arena broadcast never lists
    /// (scripted operation waves spawn mid-battle, after the broadcast), so
    /// the map can tint them without roster or spawn-order guesses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<i8>,
}

fn default_creation_time() -> f32 {
    -1.0
}

/// One recorder control-input sample (CruiseState, 0x32) — experiment E2.
///
/// Reverse-engineered payload (8 bytes, little-endian; 31 packets on the
/// 15.8.0 reference replay, every one exactly 8 bytes):
///   `u32 controller, i32 level`
///
/// The packet is NOT per-entity (the first u32 is 0/1, not a BigWorld entity
/// id) — it echoes the recorder's own discrete control presets:
///   - controller 0 = engine telegraph. Levels observed -1..4. Dynamics
///     confirmed on the reference replay: a 0→1→2→3→4 burst at battle start
///     is followed by the ship accelerating to its speed plateau (~55 s,
///     carrier-like); sustained level 0 events decelerate the ship to a full
///     stop within ~50 s; a level -1 (astern) tap left the (already stopped)
///     ship stationary. Mapping: 0 = stop, 1..4 = 1/4..full ahead, -1 =
///     astern (sign confirmed; whether deeper astern levels exist is NOT —
///     only -1 was ever observed).
///   - controller 1 = rudder. Levels observed -2..2. Dynamics confirmed:
///     a 1→0→-1→-2 burst flips the ship's yaw rate from +0.05 to -0.05 rad/s
///     within ~10 s (negative = port), and a level 0 (center) event decays
///     the turn to 0 rad/s over ~30 s. Mapping: sign = side (negative =
///     port, positive = starboard); whether |1|/|2| are exactly half/full
///     rudder is inferred from the 5-mark telegraph, not separately
///     confirmed.
///
/// `value` carries the normalized semantic value when the level is
/// confirmed: controller 0 → throttle fraction in [-1, 1] (level / 4 for
/// ahead presets; -1 → -1.0 astern), controller 1 → rudder in [-1, 1]
/// (level / 2). `None` marks levels with no confirmed meaning (e.g. throttle
/// below -1 — deeper astern — or unknown controller ids such as possible
/// submarine dive-plane domains).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CruiseSample {
    /// Seconds since match start.
    pub time: f32,
    /// 0 = engine telegraph (throttle), 1 = rudder. Other ids would be future
    /// domains (submarine dive planes?) — kept raw rather than guessed.
    pub controller: u32,
    /// Raw discrete level as sent on the wire.
    pub level: i32,
    /// Normalized value (see the type docs) when the level's meaning is
    /// confirmed, else `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f32>,
}

impl CruiseSample {
    /// Map a raw (controller, level) onto its normalized semantic value.
    /// Unknown territory yields `None` — see the type docs for the evidence
    /// backing each confirmed branch.
    pub fn map_value(controller: u32, level: i32) -> Option<f32> {
        match controller {
            0 => match level {
                -1 => Some(-1.0), // astern (sign confirmed, depth unconfirmed)
                0..=4 => Some(level as f32 / 4.0),
                _ => None, // deeper astern levels — never observed
            },
            1 => match level {
                -2..=2 => Some(level as f32 / 2.0),
                _ => None,
            },
            _ => None,
        }
    }
}

/// An aircraft-squadron creation (`receive_addSquadron` on the avatar): the
/// squadron's game-params id, its spawn position and the two plane counts
/// the health streams join against. Method id resolves via the decoder's
/// per-version tables.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadronCreate {
    pub time: f32,
    /// Composite plane id (high bits: spawn index, low bits: owner entity).
    pub plane_id: u64,
    /// GameParams id of the aircraft type.
    pub params_id: u32,
    /// Hangar TOTAL for this squadron type (addSquadron arg byte 4). A
    /// depleted hangar launches fewer planes than this — 23 of 224
    /// squadrons on the 14.5.0.0 Shokaku reference capture (2025-07-08)
    /// launched partial (e.g. 6 of 10).
    #[serde(default)]
    pub total_num_planes: u8,
    /// Planes ACTUALLY launched (addSquadron arg byte 18) — the denominator
    /// of every [`SquadronHealthEvent`] fraction and the digit count of the
    /// launch-time packed per-plane health: a 6-of-10 launch reading
    /// hp 0.6667 is 4/6 exact, not 4/10. Pre-field payloads (and fixtures
    /// built before it) deserialize with 0.
    #[serde(default)]
    pub num_planes: u8,
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
    /// Per-plane attitude pitch (i8, degrees; negative = nose down). The
    /// updateSquadron wire has carried the byte all along (each plane entry
    /// is 20 B: f32×3 position, f32 yaw, u16 time, u8 type, i8 pitch) — the
    /// decoder kept only the head 16 B until the plane-view labels needed an
    /// attack-run signal (a diving wedge is dropping ordnance).
    #[serde(default)]
    pub pitch: i8,
}

/// Which half of the squadron-consumable stream an event belongs to: the
/// activation (`squadronConsumableUsed`) or the effect-window END
/// (`squadronConsumableStopWorking`). A Used with no matching StopWorking is
/// a consumable still active at stream end (or a squadron that died with it
/// on) — the active window is the Used→StopWorking bracket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SquadronConsumableKind {
    Used,
    StopWorking,
}

/// One squadron total-HP tick (`receive_squadronHealth` on the avatar, E27):
/// def signature `receive_squadronHealth(PLANE_ID, FLOAT)`. The float is the
/// squadron's TOTAL HP as a 0..1 fraction (1.0 at launch, decaying as planes
/// take damage), NOT an absolute value — join [`SquadronCreate`] for the
/// plane count and scale on the frontend. Empirically validated on the
/// 14.5.0.0 Shokaku reference capture (2025-07-08): 4,978 calls, every hp in
/// 0..=1 and step-downs aligned with damage ticks and plane deaths.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadronHealthEvent {
    pub time: f32,
    pub plane_id: u64,
    /// Squadron HP fraction, 0..=1.
    pub hp: f32,
}

/// One per-plane HP packing (`receive_squadronPlanesHealth` on the avatar,
/// E27): def signature `receive_squadronPlanesHealth(PLANE_ID, UINT64)`. The
/// u64 is a per-plane health-band bitfield — 3 bits per flying plane, plane
/// 0 = least significant digit (see the unpack helpers right below and
/// `scripts/experiments/sq_planes_health.md` for the evidence: 815
/// synchronized samples / 167 squadrons / 0 violations on the 14.5.0.0
/// Shokaku reference capture, 2025-07-08). The event carries the RAW u64 so
/// the wire stays lossless; consumers unpack through
/// [`unpack_squadron_planes_health`] / [`plane_health_band`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadronPlanesHealthEvent {
    pub time: f32,
    pub plane_id: u64,
    /// Raw packed per-plane HP bands (unpack via the helpers below).
    pub packed: u64,
}

// ── E27: the receive_squadronPlanesHealth u64, unpacked ──────────────────────
//
// Packing solved empirically by the packed-crack analysis (validated on the
// 14.5.0.0 Shokaku reference capture 2025-07-08: 815 synchronized
// packed/float samples across 167 squadrons with 0 violations; 155 fresh
// death transitions all consistent; 3,825 digit instances use only {1, 2, 4}
// — full evidence in scripts/experiments/sq_planes_health.md, reproducers in
// scripts/experiments/sq_planes_health_unpack.rs / _analyze.mjs):
//
// * 3 bits (one octal digit) per **flying** plane, plane 0 = least
//   significant digit; digit count = number of planes currently flying.
// * digit 1 (2^0) = plane HP above 3/4 of its maximum (full),
//   digit 2 (2^1) = HP in (1/4, 3/4] (damaged),
//   digit 4 (2^2) = HP at or below 1/4 (critical).
//   No other digit value occurs on the capture; dead slots are simply
//   absent (the integer truncates trailing zero slots), and every observed
//   receive_planeDeath dead index equals digit_count − 1 at that moment —
//   a death removes the TOP digit (180/180 on the capture).
// * The companion receive_squadronHealth float equals Σ(plane HP) /
//   numPlanes at spawn ([`SquadronCreate::num_planes`], NOT the hangar
//   total — partial-hangar launches exist), which is what pinned the band
//   edges.
// * receive_addSquadron's trailing u64 planeHealth uses the same encoding.

/// Per-plane health band decoded from one 3-bit field of the packed u64.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaneHealthBand {
    /// HP above 3/4 of the plane's maximum.
    Full,
    /// HP in (1/4, 3/4].
    Damaged,
    /// HP at or below 1/4.
    Critical,
}

/// Bits per plane field in the packed u64.
pub const PLANE_HEALTH_BITS: u32 = 3;
/// Largest squadron that still fits the u64 (21 × 3 = 63 bits).
pub const MAX_SQUADRON_PLANES: usize = 21;

/// Split the packed u64 into raw 3-bit fields, plane 0 first (least
/// significant). Trailing zero fields (non-flying slots) are dropped by the
/// wire format itself, so the returned length IS the flying-plane count and
/// no `0` entries occur on well-formed captures.
pub fn squadron_planes_health_digits(packed: u64) -> Vec<u8> {
    let mut digits = Vec::new();
    let mut v = packed;
    while v != 0 {
        digits.push((v & 7) as u8);
        v >>= PLANE_HEALTH_BITS;
    }
    digits
}

/// One plane's health band inside the packed u64. `None` is HONEST missing
/// data, never a guess: the index is at or beyond the flying-plane count
/// (dead / never-launched slot), or the 3-bit field is one of the digit
/// values {3, 5, 6, 7} that never occur on real captures — a future format
/// change must surface as absent data instead of a plausible-but-wrong
/// label.
pub fn plane_health_band(packed: u64, index: usize) -> Option<PlaneHealthBand> {
    let digit = *squadron_planes_health_digits(packed).get(index)?;
    plane_health_digit_band(digit)
}

/// Full unpack: per-plane health bands, plane 0 first. Index in the returned
/// Vec is the plane index — the same index space receive_planeDeath's dead
/// array uses at the moment of death (a death drops the top digit).
pub fn unpack_squadron_planes_health(packed: u64) -> Vec<Option<PlaneHealthBand>> {
    squadron_planes_health_digits(packed)
        .iter()
        .map(|&d| plane_health_digit_band(d))
        .collect()
}

/// Map one raw 3-bit field to its band; only {1, 2, 4} were ever observed.
fn plane_health_digit_band(digit: u8) -> Option<PlaneHealthBand> {
    match digit {
        1 => Some(PlaneHealthBand::Full),
        2 => Some(PlaneHealthBand::Damaged),
        4 => Some(PlaneHealthBand::Critical),
        _ => None,
    }
}

/// Inverse of [`unpack_squadron_planes_health`] for round-tripping fixtures.
pub fn pack_squadron_planes_health(bands: &[PlaneHealthBand]) -> u64 {
    let mut packed: u64 = 0;
    for (slot, band) in bands.iter().enumerate() {
        let digit = match band {
            PlaneHealthBand::Full => 1u64,
            PlaneHealthBand::Damaged => 2,
            PlaneHealthBand::Critical => 4,
        };
        packed |= digit << (PLANE_HEALTH_BITS * slot as u32);
    }
    packed
}

/// One squadron damage tick (`receive_squadronDamage` on the avatar, E27):
/// def signature `receive_squadronDamage(PLANE_ID, FLOAT, UINT8)`. The float
/// is the damage amount and the u8 the hit type (0 on the reference capture;
/// kept raw until more values are observed). Empirically validated on the
/// 14.5.0.0 Shokaku reference capture (2025-07-08).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadronDamageEvent {
    pub time: f32,
    pub plane_id: u64,
    pub damage: f32,
    /// Raw hit-type id (0 observed so far).
    pub hit_type: u8,
}

/// One engine-mode toggle (`receive_changeThrottleMode` on the avatar, E27):
/// def signature `receive_changeThrottleMode(PLANE_ID, INT8)`. Modes: 0 =
/// cruise, 1 = engine boost, −1 = slow-down (E27f corpus study: 2387 calls
/// across 12 CV replays = 0×1215 / 1×1011 / −1×161) — the boost signal of
/// the plane-follow card. The raw i8 is kept for future modes.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadronThrottleEvent {
    pub time: f32,
    pub plane_id: u64,
    /// 0 = cruise, 1 = engine boost; raw i8 otherwise.
    pub mode: i8,
}

/// Branch-NORMALIZED semantic identity of the squadron-consumable wire
/// byte (E27d normalization layer). The raw byte is BRANCH-SPECIFIC — WG
/// (`.wowsreplay`) and Lesta (`.korablireplay`) recordings forked the id
/// space, which is exactly why the fork is resolved at the decode boundary
/// (see the two lookup tables below) instead of at any consumer: everything
/// downstream — the IPC wire, the plane-follow card, feature exports —
/// speaks this one vocabulary regardless of which client recorded the file.
///
/// Provenance of the named variants:
/// - WG wire ids were fingerprinted empirically on five 14.5 CV captures
///   (window lengths vs the GameParams workTime of every squadron-group PCY,
///   probe `dump_squadron_consumable_windows` — experiment E27b):
///   20 = healForsage, 21 = planeTacticalFighters, 22 = tactical
///   fire-extinguishing, 42 = planeSmokeGenerator.
/// - Lesta ids come from the `CONSUMABLE_TYPES` enum in the local Korabli
///   install's `battle.xml` (experiment E27c; authoritative for the Lesta
///   branch but replay-unvalidated — no carrier `.korablireplay` has landed
///   locally yet): 21 = HEAL_FORSAGE, 22 = CALL_FIGHTERS,
///   23 = REGENERATE_HEALTH, 42 = PLANE_SMOKE_GENERATOR.
/// - Only 42 coincides across the branches; every other byte means
///   DIFFERENT things per branch (e.g. 23 is RegenerateHealth on Lesta but
///   nothing observed on WG), so consumers must never key off the raw byte.
///
/// `Unknown(u8)` keeps the raw wire byte so nothing is ever lost: a future
/// id (or a validation surprise) surfaces as an honest unknown with its
/// payload rather than a plausible-but-wrong label. Serde camelCase: named
/// variants ride as strings (`"healForsage"` …), `Unknown(57)` as
/// `{"unknown": 57}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SquadronConsumableType {
    /// healForsage — engine boost + plane heal (WG 20 / Lesta 21).
    HealForsage,
    /// planeTacticalFighters — the summoned patrol-fighter consumable
    /// (WG 21; Lesta names it CALL_FIGHTERS on wire id 22 — PROVISIONAL
    /// pairing, see [`squadron_consumable_type_lesta`]).
    PlaneTacticalFighters,
    /// Tactical fire-extinguishing — the air-dropped extinguisher family
    /// (PCY085; WG 22). No Lesta counterpart observed in battle.xml yet.
    FireExtinguishing,
    /// planeSmokeGenerator (PCY049; WG 42 = Lesta 42, the one coinciding id).
    PlaneSmokeGenerator,
    /// CONSUMABLE_REGENERATE_HEALTH — the 飞行重整 (air regeneration)
    /// consumable (Lesta 23 only; the WG wire has not been observed
    /// carrying it).
    RegenerateHealth,
    /// Anything else, carrying the raw wire byte verbatim.
    Unknown(u8),
}

impl Default for SquadronConsumableType {
    /// `Unknown(0)` — "not normalized", the honest default for pre-E27d
    /// payloads that deserialize without a `semantic` field (serde default).
    fn default() -> Self {
        SquadronConsumableType::Unknown(0)
    }
}

/// WG (`.wowsreplay`) squadron-consumable wire byte → semantic type.
///
/// Provenance: E27b workTime fingerprints on five 14.5 CV captures (17/17
/// exact 5.0 s windows for 20 = healForsage; clean 60.0 s windows plus
/// interruptions for 21 = planeTacticalFighters; exact 5.0 s windows on both
/// carriers for 22 = tactical fire-extinguishing; 10.01 s exact for
/// 42 = planeSmokeGenerator) — see scripts/experiments/README.md E27b and
/// the `dump_squadron_consumable_windows` probe that reproduces the pairing.
/// Every other byte passes through as `Unknown(raw)` — never guessed.
pub fn squadron_consumable_type_wg(raw: u8) -> SquadronConsumableType {
    match raw {
        20 => SquadronConsumableType::HealForsage,
        21 => SquadronConsumableType::PlaneTacticalFighters,
        22 => SquadronConsumableType::FireExtinguishing,
        42 => SquadronConsumableType::PlaneSmokeGenerator,
        other => SquadronConsumableType::Unknown(other),
    }
}

/// Lesta (`.korablireplay`) squadron-consumable wire byte → semantic type.
///
/// Provenance: the `CONSUMABLE_TYPES` enum in the local Korabli install's
/// `battle.xml` (E27c) — authoritative for the Lesta branch, but
/// replay-unvalidated until a carrier `.korablireplay` lands locally.
/// FORK WARNING: the Lesta numbering diverges from the WG wire ids (only 42
/// coincides), so this table — not the WG one — is what a Lesta recording
/// must be normalized through. 22 →
/// [`SquadronConsumableType::PlaneTacticalFighters`] is PROVISIONAL: Lesta
/// names it CONSUMABLE_CALL_FIGHTERS, presumed the same slot-1 60 s
/// tactical-fighters family as WG's 21 from the enum name and slot pairing,
/// with no capture evidence yet; a validation capture may need to re-pin it.
/// 23 = CONSUMABLE_REGENERATE_HEALTH (WG never observed carrying that
/// byte). Every other byte passes through as `Unknown(raw)`.
pub fn squadron_consumable_type_lesta(raw: u8) -> SquadronConsumableType {
    match raw {
        21 => SquadronConsumableType::HealForsage,
        22 => SquadronConsumableType::PlaneTacticalFighters, // PROVISIONAL (CALL_FIGHTERS)
        23 => SquadronConsumableType::RegenerateHealth,
        42 => SquadronConsumableType::PlaneSmokeGenerator,
        other => SquadronConsumableType::Unknown(other),
    }
}

/// One squadron-consumable lifecycle event (`squadronConsumableUsed` /
/// `squadronConsumableStopWorking` on the avatar, E27): def signature names
/// CONSUMABLE_USAGE_PARAMS, but the 14.5 wire carries ONE byte — the
/// consumable type id (observed 20/21/22). The two methods share this shape;
/// [`SquadronConsumableKind`] says which half of the lifecycle fired.
/// Empirically validated on the 14.5.0.0 Shokaku reference capture
/// (2025-07-08).
///
/// The byte is branch-forked (WG vs Lesta id spaces diverge — see
/// [`SquadronConsumableType`]), so the event carries BOTH: `consumable_type`
/// keeps the RAW wire byte (frontend compatibility; lossless) and `semantic`
/// is the branch-normalized identity the decoder picked via
/// [`squadron_consumable_type_wg`] / [`squadron_consumable_type_lesta`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadronConsumableEvent {
    pub time: f32,
    pub plane_id: u64,
    /// RAW wire byte, branch-specific (WG: 20/21/22/42; Lesta: 21/22/23/42 —
    /// see [`SquadronConsumableType`] for the fork). Kept unchanged for
    /// frontend compatibility and losslessness; consumers should key off
    /// `semantic` instead.
    pub consumable_type: u8,
    /// Branch-normalized identity of `consumable_type` (E27d). Always
    /// serialized; deserializes to `Unknown(0)` on pre-E27d payloads that
    /// predate the field.
    #[serde(default)]
    pub semantic: SquadronConsumableType,
    /// Which lifecycle half this event is.
    pub kind: SquadronConsumableKind,
}

/// One plane-loss report (`receive_planeDeath` on the avatar, E27): def
/// signature `receive_planeDeath(PLANE_ID, ARRAY<UINT8>, UINT8, INT64)`. The
/// ARRAY prefix is a single u8 count (empirically confirmed — NOT u16/u32),
/// then that many dead-plane indexes (formation slots, 0-based), the death
/// reason (1 observed) and the attacker's vehicle entity id. One call can
/// report several planes lost at once (flak bursts). Empirically validated
/// on the 14.5.0.0 Shokaku reference capture (2025-07-08): 150+ calls.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaneDeathEvent {
    pub time: f32,
    pub plane_id: u64,
    /// Formation-slot indexes of the planes lost in this call.
    pub dead_indexes: Vec<u8>,
    /// Raw death reason (1 observed).
    pub reason: u8,
    /// Attacking vehicle entity id (joins EntityTrajectory.entityId).
    pub attacker_id: i64,
}

/// One squadron notify (`receive_squadronNotify` on the avatar, E27): def
/// signature `receive_squadronNotify(PLANE_ID, INT8)`. The i8 is a notify
/// enum (observed 1/2/4/5 on the reference capture); semantics unanalysed,
/// kept raw. Empirically validated on the 14.5.0.0 Shokaku reference capture
/// (2025-07-08).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadronNotifyEvent {
    pub time: f32,
    pub plane_id: u64,
    /// Raw notify enum (1/2/4/5 observed).
    pub notify: i8,
}

/// One squadron deactivation (`receive_deactivateSquadron` on the avatar,
/// E27): def signature `receive_deactivateSquadron(PLANE_ID, UINT8)`. The u8
/// is the reason the squadron stopped being (observed 0..5 — the
/// recall/death/out-of-fuel family); kept raw until every value is named.
/// Empirically validated on the 14.5.0.0 Shokaku reference capture
/// (2025-07-08).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadronDeactivateEvent {
    pub time: f32,
    pub plane_id: u64,
    /// Raw deactivation reason (0..5 observed).
    pub reason: u8,
}

/// The E27 squadron-state aggregate the plane-follow card consumes: the nine
/// avatar-method streams (`read_replay_squadron_states`) in one IPC
/// payload. Streams are independent timelines keyed by `plane_id`; a version
/// whose method ids are not pinned decodes to empty vectors.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadronStateEvents {
    /// Total-HP fractions (receive_squadronHealth).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub health: Vec<SquadronHealthEvent>,
    /// Raw per-plane HP packings (receive_squadronPlanesHealth).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub planes_health: Vec<SquadronPlanesHealthEvent>,
    /// Damage ticks (receive_squadronDamage).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub damage: Vec<SquadronDamageEvent>,
    /// Engine-mode toggles (receive_changeThrottleMode) — the boost signal.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub throttle: Vec<SquadronThrottleEvent>,
    /// Consumable lifecycle (squadronConsumableUsed / …StopWorking).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub consumables: Vec<SquadronConsumableEvent>,
    /// Plane-loss reports (receive_planeDeath).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plane_deaths: Vec<PlaneDeathEvent>,
    /// Notify enums (receive_squadronNotify).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notifies: Vec<SquadronNotifyEvent>,
    /// Deactivation reasons (receive_deactivateSquadron).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deactivations: Vec<SquadronDeactivateEvent>,
}

/// One smoke-screen entity lifecycle (entityType 4 = SmokeScreen, experiment
/// E8). The smoke itself is a real entity: created when emission starts,
/// streamed a position sample trail while it drifts, and despawned
/// (EntityLeave 0x04) when the last puff dissipates.
///
/// Radius and height come from the EntityCreate state stream (the SmokeScreen
/// entity's `radius` / `height` ALL_CLIENTS properties — see the decoder for
/// the sorted-index layout evidence). The wire values are in the GameParams
/// distance unit, empirically 30 m per unit (calibrated against radar
/// consumable `distShip`: 333.33 ⇒ 10 km, 400 ⇒ 12 km, 250 ⇒ 7.5 km; the
/// standard smoke radius 15.0 ⇒ the well-known ~450 m cloud). This is NOT the
/// replay's scene-position axis (~5.86 m/unit) — convert explicitly when
/// feeding geometry that uses world coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeScreenEvent {
    /// Match time (seconds) when the smoke entity was created — the start of
    /// emission.
    pub time: f32,
    /// The SmokeScreen entity id (its position samples live on the matching
    /// EntityTrajectory).
    pub entity_id: i32,
    /// Spawn position of the first puff (scene units, same axis as the
    /// position streams).
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// Smoke-cloud radius (GameParams distance units, ≈30 m each — see the
    /// struct docs). Observed families: 17.0/30.0 (Italian exhaust smoke),
    /// 17.5 (support-CV plane smoke), 15.0/20.0/40.0 also exist in GameParams.
    /// `None` when the create state could not be walked (version drift).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius: Option<f32>,
    /// Smoke column height in the same GameParams units — 5.0 = ship-laid,
    /// 10.0 = plane-laid smoke (the two families observed on 15.8.0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f32>,
    /// Observed dissipation end (EntityLeave, or EntityDestroy when the
    /// server despawns the entity). The smoke's total lifetime is NOT carried
    /// on the create-state wire — the entity's observed lifetime is the best
    /// available duration signal (it matched GameParams workTime + lifeTime
    /// within 0–10 s on every reference-replay smoke). `None` when the entity
    /// never left the capture. Caveat: for a surface-ship recorder a smoke can
    /// also leave the observed area without dissipating; the reference replay
    /// (CV recorder, whole-map view) showed one leave per smoke, aligned with
    /// dissipation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_time: Option<f32>,
}

/// One minimap vision-info update (avatar `updateMinimapVisionInfo`, method id
/// version-dependent — experiment E11). The server pushes one entry per
/// vehicle whose minimap marker state changed: the entry identifies the
/// vehicle and carries a packed 32-bit marker payload.
///
/// Evidence chain (15.8.0 reference replay, 1,821 calls / 12,096 entries over
/// a 24-vehicle match): every >4 s gap in a vehicle's position-sample stream
/// has an entry at its start (89/89, median within ~1 s) and at its end
/// (89/89) — this stream IS the explicit spot/unspot signal E3 inferred from
/// gaps. The opening packet carries all 12 allied vehicles (the always-visible
/// set). 107 entries carry the sentinel `packedData == 0x80000000` (bit 31):
/// the hidden-marker state the server sends when a vehicle becomes unspotted
/// (84/89 gap-start sequences end on it). The low 31 bits of non-sentinel
/// values encode the marker's minimap payload — position changes fire
/// repeatedly while visible, but the exact packing resisted linear, halved
/// and Morton (bit-interleave) fits and stays undocumented; the raw value is
/// preserved for future analysis. `visible` is `false` exactly for the
/// sentinel.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisionEvent {
    /// Seconds since match start.
    pub time: f32,
    /// The vehicle entity the minimap marker belongs to (joins
    /// `EntityTrajectory.entityId`).
    pub entity_id: i32,
    /// False when the entry is the hidden-marker sentinel (unspotted), true
    /// for a live marker update.
    pub visible: bool,
    /// Raw 32-bit packed marker payload (`MINIMAP_USER_INFO.packedData`),
    /// sentinel included — see the type docs.
    pub packed_data: u32,
}

/// One consumable activation (Vehicle `onConsumableUsed`, method id
/// version-dependent — experiment E11). Fires on the vehicle that used the
/// consumable, for BOTH teams' vehicles visible to the recording client
/// (reference capture: 104 uses across 22 of 24 vehicles).
///
/// Wire (15.2+): a length-prefixed blob `CONSUMABLE_USAGE_PARAMS` followed by
/// the f32 `workTimeLeft`. The blob's first byte selects the usage variant
/// (`ConsumableUsageType`): 0 = none (no id), 1 = default `<BB>`, 2 = position
/// `<BBff>`, 3 = entity target `<BBbQ>`; its second byte is the raw
/// consumable type id (GameParams enum — reference capture used ids
/// {0,1,3,4,6,8,9,10,65}; several durations cluster near well-known
/// consumables — 5 s (id 0, damage control immunity), 28 s (id 8, repair
/// party) — but the id→name map is a GameParams concern and stays raw here).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumableUseEvent {
    pub time: f32,
    /// Vehicle entity that used the consumable.
    pub entity_id: i32,
    /// ConsumableUsageType of the params blob: 0 none, 1 default, 2 position,
    /// 3 entity target.
    pub usage_type: u8,
    /// Raw consumable type id (0 for the `none` variant).
    pub consumable_id: u8,
    /// Remaining work time in seconds (the consumable's active duration).
    pub duration: f32,
    /// Map position for the `position` usage variant (tactical map pings).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_x: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_z: Option<f32>,
    /// Target entity id for the `entity` usage variant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<u64>,
}

/// One shield-damage broadcast (Avatar `receiveShieldDamageInfo`, 15.10.0+
/// shield mechanic): a shell hit a vehicle's shield and was absorbed. The
/// args are `i32 victimId, i32 hitOwnerId, u32 shieldDamage, u8 hitYaw` —
/// 13 bytes, verified against the 2026-11-05 Bermuda Triangle event capture
/// (200 events; the 770-damage SAP shield cap among observed values).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShieldDamageEvent {
    /// Seconds since match start.
    pub time: f32,
    /// The vehicle whose shield absorbed the hit (joins
    /// `EntityTrajectory.entityId`).
    pub victim_id: i32,
    /// The attacker's owner entity: an AVATAR id when the broadcast names
    /// the attacker (the reference capture names only the recorder's own
    /// hits), a vehicle id, or `0` when no owner is broadcast (observed on
    /// bot-owned damage). Join against both entity maps, never assume one.
    pub attacker_id: i32,
    /// Damage the shield absorbed (the shell's shield-damage cap, e.g. 770
    /// for the event SAP ammo — matches the in-game ammo panel).
    pub shield_damage: u32,
    /// The engine's 0..=255 quantized impact bearing (relative to the
    /// victim's heading) — raw, join-free.
    pub hit_yaw: u8,
}

/// One `state.shield` nested-property update (Vehicle, 15.10.0+): either the
/// shield's remaining HP (it falls with every absorbed hit and regenerates
/// between engagements) or its maximum HP (a buff-driven ceiling change).
/// Fold by entity for the shield HP timeline; a remainingHP of 0 is the
/// broken-shield state.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShieldStateEvent {
    /// Seconds since match start.
    pub time: f32,
    /// Vehicle entity the shield belongs to.
    pub entity_id: i32,
    /// The streamed HP value (max HP when `isMaxHp`, else the remaining
    /// HP).
    pub value: u32,
    /// True = `maxHp` update, false = `remainingHP` update.
    pub is_max_hp: bool,
}

/// One zero-arg shield lifecycle marker on a Vehicle entity (15.10.0+):
/// `shieldRegen` (the shield re-armed after its offline window) or
/// `shieldHit` (a hit was absorbed — the audio/visual cue the client plays).
/// These fire alongside the damage/state streams; the markers carry no
/// payload, they timestamp the transitions per vehicle.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShieldMarkerEvent {
    /// Seconds since match start.
    pub time: f32,
    /// Vehicle entity whose shield changed state.
    pub entity_id: i32,
    /// True = `shieldRegen` (re-armed), false = `shieldHit` (absorbed).
    pub is_regen: bool,
}

/// One gun overheat transition (Vehicle `setGunOverheated`, 15.10.0+ gun-heat
/// mechanic): `u8 weaponType, u8 gunID, BOOL isOverheated`. The heat LEVEL
/// itself never replicates (each client simulates its own guns; remote
/// clients only see this boolean), so the timeline here is per-gun
/// overheated/not transitions.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GunOverheatEvent {
    /// Seconds since match start.
    pub time: f32,
    /// Vehicle entity whose gun changed overheat state.
    pub entity_id: i32,
    /// Raw weapon-type byte (the engine's WEAPON_TYPE enum).
    pub weapon_type: u8,
    /// Raw gun id within the weapon type.
    pub gun_id: u8,
    /// True = the gun entered the overheated (cooling-locked) state.
    pub is_overheated: bool,
}

/// One per-vehicle engine-state change (Vehicle entity properties
/// `enginePower` idx 9 / `engineDir` idx 10, ALL_CLIENTS — experiment E11).
/// Exactly one of `power` / `dir` is set per sample (whichever property
/// changed); fold by entity for a step timeline.
///
/// Semantics (reverse-engineered on the 15.8.0 reference replay, 23 of 24
/// vehicles carry samples): `enginePower` is the engine's current output
/// level in tenths of maximum — NOT the raw telegraph intent. It ramps 2→10
/// over ~20 s after the recorder commands full ahead (the engine spin-up,
/// ahead of the ~55 s hull acceleration), settles around 5 under sustained
/// half throttle, and holds 10 through turn-induced speed dips. `engineDir`
/// is the sign of the applied force (+1 driving, -1 braking/astern) — on the
/// recorder's own ship all 7 CruiseState throttle reductions flip it to -1
/// within ~1 s, and 6 of its 7 flips back to +1 follow a throttle raise (the
/// seventh returns at settled half power). Settled low power (≤2) windows
/// coincide with near-standstill (median windowed speed ≤ 9% of the ship's
/// p95 across qualifying vehicles).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStateSample {
    pub time: f32,
    /// Vehicle entity the sample belongs to.
    pub entity_id: i32,
    /// enginePower level 0-10 when that property changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub power: Option<u8>,
    /// engineDir force sign (+1 ahead / -1 astern-braking) when that property
    /// changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<i8>,
}
