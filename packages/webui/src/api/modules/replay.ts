/** Replay domain of the WoWSP API client: replay metadata and packet
 *  streams, the overlay/arena watcher surface and their event payloads
 *  (composed into `api` by client.ts). */
import { transport } from "@/transport";
import { RPC } from "@/rpc";
import type { GameInstallKind, TelemetryPayload } from "./game";

/** Mirrors `wowsp_tauri_shared::VehicleEntry`. */
export interface VehicleEntry {
  id: number;
  name: string;
  /** 0/1 = ally (self + division), 2+ = enemy — including operation
   *  scenarios (行动): their rosters carry real side semantics too
   *  (allied escort waves sit at relation ≤ 1, enemy warships at > 1 —
   *  verified against the operation replay fixtures). `isOperationBattle`
   *  only gates VISUAL rules (hidden enemy column, map marker colors).
   *  Numeric in the client JSON. */
  relation: number;
  /** Client ship id (numeric, JSON number). */
  shipId: number;
  /** Pre-resolved ship display name, if known. */
  shipName?: string | null;
}

/** Mirrors `wowsp_tauri_shared::ReplayMeta`. */
export interface ReplayMeta {
  path: string;
  matchGroup?: string | null;
  /** Parsed from the replay filename (`YYYYMMDD` or `YYYYMMDD_HHMMSS`). */
  dateTime?: string | null;
  /** Internal numeric map id. */
  mapId?: number | null;
  /** Client display name, e.g. "15_NE_north". */
  mapName?: string | null;
  /** Scenario name, e.g. "domination_3point", "asymm_3point_coop". */
  scenario?: string | null;
  /** Battle-script id, e.g. "PCVE027" (EV27AsymCoop = asymmetric). */
  eventType?: string | null;
  /** Roster entries with the client's bot nicknames (`:Name:` bots, `IDS_*` / `#Name` scripted units). */
  botCount?: number | null;
  /** Scripted-unit roster entries (`IDS_*` text keys / `#Name` scenario
   *  style) — the operation (行动) half of `botCount`. Co-op and random
   *  fills carry `:Name:` bots only, so a non-zero count in a pve-family
   *  match group marks an operation (see `modeKey`). */
  scriptedUnitCount?: number | null;
  vehicles: VehicleEntry[];
  raw: unknown;
}

/** Mirrors `wowsp_tauri_shared::ReplayMetaLite`. Lightweight replay summary
 *  returned by `list_replays_meta` — only the descriptor-JSON block is parsed
 *  (no packet stream), and the scan is uncapped (the game's versioned replay
 *  archives can hold well past a few hundred files). The full `ReplayMeta`
 *  (with roster + raw JSON) comes later from `readReplayHeader`. */
export interface ReplayMetaLite {
  path: string;
  /** `YYYYMMDD_HHMMSS` when recoverable, else `YYYYMMDD`, else null. */
  dateTime?: string | null;
  /** e.g. "pvp", "ranked", "clan", "event". */
  matchGroup?: string | null;
  /** Client map display name, e.g. "15_NE_north". */
  mapName?: string | null;
  mapId?: number | null;
  /** Scenario name, e.g. "domination_3point", "asymm_3point_coop". */
  scenario?: string | null;
  /** Battle-script id, e.g. "PCVE027" (EV27AsymCoop = asymmetric). */
  eventType?: string | null;
  /** Roster entries with the client's bot nicknames (`:Name:` bots, `IDS_*` / `#Name` scripted units). */
  botCount?: number | null;
  /** Scripted-unit roster entries (`IDS_*` / `#Name`) — the operation half
   *  of `botCount` (see `ReplayMeta.scriptedUnitCount`). The list view has
   *  no roster to scan, so the classifier reads this count instead. */
  scriptedUnitCount?: number | null;
  /** The recorder's ship id (roster relation == 0). Drives the ship preview. */
  ownShipId?: number | null;
  /** The recorder's NICKNAME — the descriptor's `playerName`, or the
   *  relation-0 roster entry's name when only the roster carries one. The
   *  rail titles each card with it (the renamed `ownShipName`, which used
   *  to hold this same nickname but never said so). */
  playerName?: string | null;
  /** Number of players in the roster. */
  playerCount: number;
  /** Root path (GameInstall.path) of the install whose `replays/` folder
   *  holds this file — the replay's server identity, since a file is
   *  recorded by the client that wrote it. Null (with the two tags below)
   *  for files under an unowned replay folder, e.g. the phone's managed
   *  dir, which belongs to no detected client. */
  installPath?: string | null;
  /** Client kind of the owning install (null under an unowned root). */
  installKind?: GameInstallKind | null;
  /** Realm of the owning install (null under an unowned root / unknown). */
  installRealm?: string | null;
}

/** Mirrors `wowsp_tauri_shared::ArenaInfo`. */
export interface ArenaInfo {
  matchGroup?: string | null;
  dateTime?: string | null;
  mapName?: string | null;
  /** Scenario name — the "tournament" variants are custom-room fingerprints. */
  scenario?: string | null;
  /** Battle-script id, e.g. "PCVE027"; operations carry PCVO* — mirrors
   *  `ReplayMeta.eventType`. */
  eventType?: string | null;
  /** Roster entries with the client's bot nicknames (`:Name:` bots, `IDS_*` / `#Name` scripted units). */
  botCount?: number | null;
  /** Scripted-unit roster entries (`IDS_*` / `#Name`) — the operation half
   *  of `botCount` (see `ReplayMeta.scriptedUnitCount`). Labels the live
   *  battle's mode before any replay of it exists. */
  scriptedUnitCount?: number | null;
  vehicles: VehicleEntry[];
  raw: unknown;
}

/** One playable map in a local game install, as returned by
 *  `list_game_maps` (desktop only — phones get an error). Mirrors
 *  `wowsp_tauri::commands::game_maps::GameMapEntry`. A space is a playable
 *  map iff the install's VFS carries `spaces/<spaceId>/minimap.png`. */
/** One capture point as the replay recorded it (world units) — mirrors
 *  `wowsp_tauri_shared` / commands/replay/cap_layouts.rs. */
export interface LearnedCapPoint {
  index: number;
  x: number;
  z: number;
  radius: number | null;
  team: number | null;
  appearT: number | null;
}

/** One learned (matchGroup, scenario) layout of a map. */
export interface LearnedCapLayout {
  modeGroup: string | null;
  scenario: string | null;
  sourceReplay: string;
  sourceTime: string | null;
  caps: LearnedCapPoint[];
}

export interface GameMapEntry {
  /** Space id, e.g. "20_NE_two_brothers". */
  spaceId: string;
  /** Virtual VFS path of the minimap marker. */
  path: string;
  /** Absolute on-disk path of the backing .pkg volume file. */
  pkgPath: string;
  /** Backing volume's mtime in ms since the epoch; null when stat failed. */
  mtimeMs: number | null;
}

/** Mirrors `wowsp_tauri_shared::Rect` — an axis-aligned rect in physical px. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Mirrors `wowsp_tauri_shared::OverlayAnchor`. All coordinates are PHYSICAL
 *  pixels relative to the overlay window's top-left corner (which Rust places
 *  exactly over the game window); divide by `devicePixelRatio` for CSS px. */
export interface OverlayAnchor {
  /** Game-window rect in physical screen px (diagnostics; mirrored by the
   *  overlay window placement). */
  gameRect: Rect;
  /** Detected team-list rect, physical px relative to the game window. */
  rosterRect: Rect;
  /** Vertical center of each mapped player row (top to bottom, header rows
   *  trimmed), physical px relative to the game window. */
  rowCenters: number[];
  /** Allies/enemies column split as a fraction (0–1) of the roster width. */
  teamSplit: number;
  /** Per-row alive classification read off the name strips (sunk rows
   *  render dim gray in-game). Same length/order as `rowCenters`; `true` =
   *  alive; null/absent = the luma pass did not run (treat every row as
   *  alive). */
  rowAlive?: boolean[] | null;
}

/** Mirrors `wowsp_tauri_shared::CaptureResult`. */
export interface CaptureResult {
  imageBase64: string;
  rosterRect?: Rect | null;
  anchor?: OverlayAnchor | null;
}

/** Lifecycle of the in-game Tab-table detection (mirrors
 *  `wowsp_tauri_shared::OverlayState`, serde-lowercase on the wire). */
export type OverlayState = "idle" | "searching" | "detected" | "fallback" | "manual";

/** Payload of the `wowsp://overlay-status` event (mirrors
 *  `wowsp_tauri_shared::OverlayStatus`), pushed on every detection-state
 *  TRANSITION by the Tab watcher. `rows` is set only while `state` is
 *  detected/manual; `manual` is always `false` until the manual-locate
 *  flow ships. */
export interface OverlayStatus {
  state: OverlayState;
  rows?: number | null;
  manual: boolean;
}

/** Payload of the `wowsp://sink-attrib` event (mirrors
 *  `wowsp_tauri_shared::SinkAttribution`): for one confirmed sink
 *  transition, the rows whose players just left the alive block — indices
 *  into the side's PRE-sink alive order (the Tab sort key keeps that order
 *  exact), solved by fingerprint-matching the table's name strips across
 *  the sink. An EMPTY side means "no attribution" — degrade that side
 *  (keep its full order un-flagged), never guess. */
export interface SinkAttribution {
  allyRows: number[];
  enemyRows: number[];
}

/** Mirrors `wowsp_tauri_shared::ManualLocateGuides`: alignment guides the
 *  detector found on the manual-locate picker's cached frame, PHYSICAL px
 *  relative to the capture origin (the game window's top-left at capture
 *  time). Snap targets for the drag box; all fields default-empty. */
export interface ManualLocateGuides {
  tableRect?: Rect | null;
  rowLines?: number[];
  seamX?: number | null;
}

/** Mirrors `wowsp_tauri_shared::ManualLocateContext`: the cached frame the
 *  picker layer draws on (integer-factor downscaled to ≤1280 px wide, PNG,
 *  base64 WITHOUT the data-URL prefix) plus the detector's guides on it.
 *  `imageBase64 == null` = no usable cached frame right now (the layer
 *  shows its retry state). Coordinates are PHYSICAL px relative to the
 *  capture origin — the submitted selection maps back into the same space. */
export interface ManualLocateContext {
  imageBase64?: string | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  physWidth: number;
  physHeight: number;
  capturedAtMs?: number | null;
  capturedGameRect?: Rect | null;
  guides: ManualLocateGuides;
}

/** One position sample (mirrors `wowsp_tauri_shared::PositionSample`). WoWS
 *  maps are planar: x = east, z = north, y ≈ 0 (sea level). */
export interface PositionSample {
  time: number;
  entityId: number;
  vehicleId: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** One player/bot entry from the arena's initial state
 *  (`onArenaStateReceived`, mirrors `wowsp_tauri_shared::ArenaPlayer`) — the
 *  server's authoritative ship-entity → team/player mapping. Empty on
 *  versions whose decode isn't pinned; consumers then fall back to the
 *  EntityCreate shipId join + spawn-side heuristics. */
export interface ArenaPlayer {
  /** The player's SHIP vehicle entity id (joins EntityTrajectory.entityId). */
  entityId: number;
  /** 0/1 team slot; `selfTeam` on the stream marks the recorder's side. */
  teamId: number;
  /** Roster player id (joins ReplayMeta.vehicles[].id). */
  playerId?: number;
  /** GameParams ship id (joins the ship encyclopedia; mirror picks share it). */
  shipParamsId?: number;
  /** Starting health of this exact ship build (upgrades included). */
  maxHealth?: number;
  name?: string;
  isBot?: boolean;
  /** The player's Avatar entity id (human players only). */
  avatarId?: number | null;
  /** True for the recorder's own entry. */
  isSelf?: boolean;
}

/** Entity creation metadata (mirrors `wowsp_tauri_shared::EntityKind`). The
 *  fixed header of an EntityCreate (0x05) packet plus the roster shipId
 *  recovered from its state blob. `entityType` 2 = vehicle (ships). */
export interface EntityKind {
  entityType: number;
  /** Per-version constant — NOT a player id. Use `shipId` for roster joins. */
  vehicleId: number;
  initialX: number;
  initialY: number;
  initialZ: number;
  creationTime: number;
  /** Roster shipId scanned from the EntityCreate state stream — the reliable
   *  join key into `ReplayMeta.vehicles[].shipId`. Undefined when not found. */
  shipId?: number | null;
  /** Starting (max) health scanned from the create state (ships only). The
   *  arena broadcast stays the authoritative source; this backs the Lesta
   *  arena synthesis. Undefined when not found. */
  maxHealth?: number | null;
  /** Capture-zone radius (m) from the create state (entityType 14 only). */
  radius?: number | null;
  /** 0-based capture-point index (A=0, B=1, ...) from the create state's
   *  `controlPoint` component. Only real domination points carry it;
   *  strike/event InteractiveZones leave it undefined. */
  controlPointIndex?: number | null;
  /** Initial owning team (0/1, -1 = neutral) from the InteractiveZone
   *  `teamId` property — zones owned from match start emit no capSamples
   *  updates, so the opening colour comes from here. */
  initialTeam?: number | null;
}

/** A per-entity trajectory (mirrors `wowsp_tauri_shared::EntityTrajectory`). */
export interface EntityTrajectory {
  entityId: number;
  kind?: EntityKind | null;
  samples: PositionSample[];
  /** Match time (s) the entity was destroyed (EntityDestroy 0x06), if sunk.
   *  Undefined/null = survived. The map freezes + greys the marker from here. */
  deathTime?: number | null;
  /** HP timeline samples from EntityProperty (0x07) packets. */
  hpSamples?: HpSample[];
  /** Capture zone property 0 samples (neutral/captured status). */
  capSamples?: HpSample[];
  /** Live capture progress (0..1000) from NestedPropertyUpdate packets —
   *  the game's own progress, present for capture zones on modern clients. */
  capProgress?: HpSample[];
}

/** An HP value at a point in time. */
export interface HpSample {
  time: number;
  value: number;
}

/** A shell in flight (receiveArtilleryShots on the avatar): muzzle point,
 *  server-computed aim point and remaining flight time — the primary source
 *  for shell trajectory arcs. */
export interface ShellLaunchEvent {
  time: number;
  /** Firing vehicle entity id (joins EntityTrajectory.entityId). */
  ownerId: number;
  /** GameParams id of the shell — resolves to HE/AP/SAP for colors. */
  paramsId: number;
  salvoId: number;
  shotId: number;
  x: number;
  y: number;
  z: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  /** Server time units until impact — battle seconds = value / 2.75. */
  serverTimeLeft: number;
  speed: number;
  gunBarrelId: number;
}

/** A shell impact / explosion observed by the recorder's avatar
 *  (receiveExplosions). World-space point in map coordinates. */
export interface ExplosionEvent {
  time: number;
  x: number;
  y: number;
  z: number;
  /** GameParams id of the shell — resolves to HE/AP/SAP for colors. */
  paramsId?: number;
}

/** A torpedo launch (receiveTorpedoes on the avatar): each fish carries its
 *  own spawn point, direction and shot id. */
export interface TorpedoLaunch {
  time: number;
  /** Firing vehicle entity id (joins EntityTrajectory.entityId). */
  ownerId: number;
  paramsId: number;
  salvoId: number;
  shotId: number;
  x: number;
  y: number;
  z: number;
  /** Launch direction (world space, not normalized). */
  dirX: number;
  dirY: number;
  dirZ: number;
  armed: boolean;
}

/** A guidance update for a homing torpedo (receiveTorpedoDirection). */
export interface TorpedoSteer {
  time: number;
  ownerId: number;
  shotId: number;
  x: number;
  y: number;
  z: number;
  targetYaw: number;
}

/** A weapon-lock state change (SetWeaponLock 0x30) by the recorder's ship. */
export interface WeaponLockEvent {
  time: number;
  weaponType: number;
  /** 0 = none, 3 = target lock. */
  lockType: number;
  targetId: number;
}

/** One camera pose sample (Camera 0x25) — the recorder's spectating view. */
export interface CameraSample {
  time: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  rotW: number;
  x: number;
  y: number;
  z: number;
  fov: number;
}

/** One player network-stat sample (PlayerNetStats 0x1d). */
export interface NetStatsSample {
  time: number;
  fps: number;
  ping: number;
  isLagging: boolean;
}

/** Counts of decoded system packets (diagnostics). */
export interface DiagnosticCounts {
  serverTicks?: number;
  serverTimestamps?: number;
  initFlags?: number;
  initMarkers?: number;
  basePlayerCreates?: number;
  createStubs?: number;
  entityControls?: number;
  entityEnters?: number;
  cameraModes?: number;
  cameraFreelooks?: number;
  subControllers?: number;
  cruiseStates?: number;
  shotTrackings?: number;
  gunMarkers?: number;
}

/** An aircraft-squadron creation (receive_addSquadron on the avatar). */
export interface SquadronCreate {
  time: number;
  planeId: number;
  paramsId: number;
  x: number;
  y: number;
  z: number;
}

/** One aircraft position sample (receive_updateSquadron on the avatar).
 *  Each update packet carries `count` planes of one squadron; `index` is the
 *  position within that formation, so (planeId, index) is one aircraft. */
export interface SquadronPlane {
  time: number;
  planeId: number;
  index: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** A squadron marker appearing on the minimap (receive_addMinimapSquadron).
 *  The composite plane id packs the owning carrier's vehicle id in its low
 *  32 bits (`ownerId` here, already unpacked). */
export interface MinimapSquadronAdd {
  time: number;
  planeId: number;
  ownerId: number;
  teamId: number;
  paramsId: number;
  x: number;
  z: number;
}

/** A squadron marker move (receive_updateMinimapSquadron). */
export interface MinimapSquadronMove {
  time: number;
  planeId: number;
  x: number;
  z: number;
}

/** A squadron marker disappearing (receive_removeMinimapSquadron). */
export interface MinimapSquadronRemove {
  time: number;
  planeId: number;
}

/** A fighter-patrol ward (receive_wardAdded): the circle aircraft hold while
 *  orbiting. World-space centre + radius; scene units match world metres. */
export interface WardEvent {
  time: number;
  squadronId: number;
  ownerId: number;
  teamId: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  /** Ward kind (13.2.0+); 0 = unknown on older replays. */
  wardType: number;
}

/** A patrol ward disappearing (receive_wardRemoved). */
export interface WardRemoveEvent {
  time: number;
  planeId: number;
}

/** One projectile kill (receiveShotKills): the terminal position of a shell
 *  or torpedo that hit something. Joins ShellLaunchEvent /
 *  TorpedoLaunch by (ownerId, shotId). */
export interface ShotKillEvent {
  time: number;
  ownerId: number;
  /** Raw hit-type bitfield. Observed on a 15.7 replay: shell hits cluster in
   *  96–100 (0x60 | flags) with 64; torpedo hits include 0 and 104 alongside
   *  shared values — semantics unconfirmed, do not filter on it. */
  hitType: number;
  shotId: number;
  x: number;
  y: number;
  z: number;
}

/** One cumulative damage-stat tick (receiveDamageStat): the server's running
 *  total for a (weapon, category) pair at a battle time. CUMULATIVE and
 *  replace-per-pair — fold by keeping the latest sample per pair (at or
 *  before time T), never by summing samples. category 0 = damage dealt;
 *  weapons 11/12/28/41-43/51-58/63-70/74-81 are aircraft weapons. */
export interface DamageStatSample {
  time: number;
  weapon: number;
  category: number;
  count: number;
  total: number;
}

/** One battle-chat message (avatar onChatMessage). `playerId` joins the
 *  descriptor roster (`vehicles[].id` — account ids), not entity ids. */
export interface ChatEvent {
  time: number;
  playerId: number;
  /** Channel namespace. The audiences the client's BattleController knows:
   *  `battle_common` (all), `battle_team` (team), `battle_prebattle`
   *  (division); anything else is server-specific and shown as private. */
  namespace: string;
  message: string;
}

/** One in-battle achievement award (avatar onAchievementEarned).
 *  `achievementId` joins `data/achievement_names.json`. */
export interface AchievementEvent {
  time: number;
  playerId: number;
  achievementId: number;
}

/** Aircraft weapon ids (DamageStatWeapon), straight off the vendored enum
 *  table (wows-core game_constants.rs): carrier rockets / bombs / torpedo
 *  bombers / skip bombers / fighters plus the Asup-, Alter- and Tc-built
 *  variants. Burn (17) and flood (20) are DoT categories shared with ship
 *  weapons, so they stay out; 70 (Recon) only spots and 79-81 are the
 *  laser/event weapons — no aircraft, no damage. The 飞机伤害 tile and the
 *  航空 composition chip sum exactly this set. */
const PLANE_WEAPON_IDS: ReadonlySet<number> = new Set<number>([
  10, 11, 12, 13, 14, 28, 41, 42, 43,
  ...range(51, 58), ...range(61, 69), ...range(71, 78),
]);

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Whether a damage-stat weapon id is an aircraft weapon (carrier planes).
 *  Exported for the damage-composition split (features/replay/damageComp.ts)
 *  so the 航空 family matches the 飞机伤害 tile exactly. */
export function isPlaneWeapon(weapon: number): boolean {
  return PLANE_WEAPON_IDS.has(weapon);
}

/** Fold cumulative damage-stat samples into the totals at (or before) `t`.
 *  Keeps the latest sample per (weapon, category) pair — the values are
 *  running totals, so summing across samples would multi-count. The game
 *  stream carries fractional totals (f64 damage), but damage displays as an
 *  integer everywhere, so round at the shared fold instead of per view. */
export function foldDamageStats(
  samples: DamageStatSample[] | null | undefined,
  t: number,
): { damage: number; planeDamage: number; hits: number } {
  const latest = new Map<string, DamageStatSample>();
  for (const s of samples ?? []) {
    if (s.time > t) continue;
    latest.set(`${s.weapon}_${s.category}`, s);
  }
  let damage = 0;
  let planeDamage = 0;
  let hits = 0;
  for (const s of latest.values()) {
    if (s.category !== 0) continue; // 1=ally, 2=spot, 3=agro — not damage dealt
    damage += s.total;
    hits += s.count;
    if (isPlaneWeapon(s.weapon)) planeDamage += s.total;
  }
  return { damage: Math.round(damage), planeDamage: Math.round(planeDamage), hits };
}

/** Decoded packet stream: entity trajectories plus battle-effect events.
 *  Mirrors `wowsp_tauri_shared::ReplayStream`. */
export interface ReplayStream {
  trajectories: EntityTrajectory[];
  /** Artillery launches (receiveArtilleryShots) — true shell trajectories. */
  shellLaunches?: ShellLaunchEvent[];
  explosions?: ExplosionEvent[];
  torpedoes?: TorpedoLaunch[];
  torpedoSteers?: TorpedoSteer[];
  weaponLocks?: WeaponLockEvent[];
  /** Raw post-battle statistics JSON (BattleResults 0x22). */
  battleResults?: string | null;
  /** Replay protocol version (Version 0x16). */
  version?: string | null;
  /** Map name from the Map packet (0x28). */
  mapName?: string | null;
  /** Recorder camera timeline (0x25). */
  camera?: CameraSample[];
  /** Player net stats (0x1d). */
  netStats?: NetStatsSample[];
  /** Entity id → last leave time (0x04). */
  leaves?: Record<string, number>;
  /** Camera-mode changes (0x27). */
  cameraModes?: HpSample[];
  diagnostics?: DiagnosticCounts;
  /** Aircraft squadrons (avatar receive_add/updateSquadron — 3D stream). */
  squadronCreates?: SquadronCreate[];
  squadronPlanes?: SquadronPlane[];
  /** Minimap squadron markers (receive_add/update/removeMinimapSquadron) —
   *  the 2D trail source the in-game minimap itself uses. */
  minimapSquadronAdds?: MinimapSquadronAdd[];
  minimapSquadronMoves?: MinimapSquadronMove[];
  minimapSquadronRemoves?: MinimapSquadronRemove[];
  /** Fighter-patrol wards (receive_wardAdded / receive_wardRemoved). */
  wards?: WardEvent[];
  wardRemoves?: WardRemoveEvent[];
  /** Projectile kills (receiveShotKills) — terminal impact points. */
  shotKills?: ShotKillEvent[];
  /** Server-authoritative cumulative damage stats (receiveDamageStat) for
   *  the recorder — exact per-weapon damage incl. aircraft weapons. Absent
   *  on versions whose exposed method id isn't pinned yet. */
  damageStats?: DamageStatSample[];
  /** Battle chat timeline (avatar onChatMessage). */
  chatMessages?: ChatEvent[];
  /** In-battle achievement awards (avatar onAchievementEarned). */
  achievements?: AchievementEvent[];
  /** The arena's initial player/bot state — the authoritative ship-entity →
   *  team/player join (see ArenaPlayer). */
  arenaPlayers?: ArenaPlayer[];
  /** Team slot (0/1) of the recorder, from the arena's isSelf entry. */
  selfTeam?: number | null;
  /** Global-weather timeline (BattleLogic state.weather.globalWeather
   *  "item" updates) — cyclone/storm interpolation windows. */
  weatherTransitions?: WeatherTransition[];
  /** Announced upcoming weather changes (the in-game warning banners). */
  weatherNotifications?: WeatherNotification[];
}

/** The running client's in-progress replay container
 *  (`temp.wowsreplay` / `temp.korablireplay`) — the live self-stats feed's
 *  anchor. Mirrors `commands::replay::LiveTempReplay`. */
export interface LiveTempReplay {
  path: string;
  /** Current byte length — the caller re-decodes only when it grew. */
  size: number;
}

/** Slim battle snapshot for the live self-stats view — the ReplayStream
 *  families the personal report reads (ship trajectories only). Mirrors
 *  `wowsp_tauri_shared::LiveSelfStream`. */
export interface LiveSelfStream {
  trajectories: EntityTrajectory[];
  shotKills?: ShotKillEvent[];
  damageStats?: DamageStatSample[];
  achievements?: AchievementEvent[];
  arenaPlayers?: ArenaPlayer[];
  /** Launch events — the (ownerId, shotId) join that classifies a hit's
   *  weapon family for the per-target damage composition. */
  shellLaunches?: ShellLaunchEvent[];
  torpedoes?: TorpedoLaunch[];
  battleResults?: string | null;
}

/** One global-weather change window — mirrors
 *  `wowsp_tauri_shared::WeatherTransition`. The server lerps every
 *  weather-logic field (spotting caps, badness) linearly from `fromParam`
 *  to `toParam` across [startTime, endTime]. */
export interface WeatherTransition {
  /** Packet clock when the update arrived. */
  time: number;
  startTime: number;
  endTime: number;
  /** GlobalWeather GameParams ids (see features/holographic/weather.ts). */
  fromParam: number;
  toParam: number;
}

/** Announced upcoming weather change — mirrors
 *  `wowsp_tauri_shared::WeatherNotification`. */
export interface WeatherNotification {
  /** Packet clock when the update arrived. */
  time: number;
  /** Battle second the announced weather lands. */
  atTime: number;
  param: number;
}

export const replayApi = {
  readReplayHeader: (path: string) => transport.invoke<ReplayMeta>(RPC.read_replay_header, { path }),
  readReplayPositions: (path: string) =>
    transport.invoke<ReplayStream>(RPC.read_replay_positions, { path }),
  /** Live self-stats feed (我的战绩): locate the running client's in-progress
   *  `temp.*replay` container. Null when no battle is being recorded. */
  liveTempReplay: () => transport.invoke<LiveTempReplay | null>(RPC.live_temp_replay),
  /** Decode the in-progress temp replay tolerating its torn tail — a
   *  complete "battle so far" snapshot in the same shape as
   *  readReplayPositions. Seconds-scale CPU work; re-call only when the
   *  file's size grew (see liveTempReplay). */
  readLiveReplaySnapshot: (path: string) =>
    transport.invoke<LiveSelfStream>(RPC.read_live_replay_snapshot, { path }),
  listReplays: (dir?: string, limit?: number) =>
    transport.invoke<string[]>(RPC.list_replays, { dir, limit }),
  /** List replays with parsed descriptor metadata (date/mode/map/recorder).
   *  Only reads the JSON header block per file — fast even for hundreds.
   *  `all: true` scans EVERY detected install's `replays/` folder in one
   *  call and tags each entry with its owning install (installPath /
   *  installKind / installRealm), ignoring `dir` — the rail's default
   *  multi-client mode. Without it the call keeps its historical
   *  single-root behavior (`dir` or the active install's folder). */
  listReplaysMeta: (dir?: string, limit?: number, all?: boolean) =>
    transport.invoke<ReplayMetaLite[]>(RPC.list_replays_meta, { dir, limit, all }),
  /** Inventory every playable map in a local game install (space id, VFS
   *  minimap path, backing .pkg volume + its mtime). Desktop only — the
   *  shell answers with an error on phones. */
  listGameMaps: (gameRoot: string) =>
    transport.invoke<GameMapEntry[]>(RPC.list_game_maps, { gameRoot }),
  /** Capture layouts of one map learned from the local replay history
   *  (newest replay per (matchGroup, scenario)); `dir` follows the replay-dir
   *  resolution (undefined = the active install's replays). Empty when the
   *  map was never played here. */
  getMapCapLayouts: (spaceId: string, dir?: string) =>
    transport.invoke<LearnedCapLayout[]>(RPC.get_map_cap_layouts, { spaceId, dir }),
  readTempArenaInfo: (dir?: string) =>
    transport.invoke<ArenaInfo | null>(RPC.read_temp_arena_info, { dir }),
  startArenaWatcher: (dir?: string) => transport.invoke<null>(RPC.start_arena_watcher, { dir }),
  stopArenaWatcher: () => transport.invoke<null>(RPC.stop_arena_watcher),
  listenArenaInfo: (handler: (info: ArenaInfo) => void) =>
    transport.listen?.<ArenaInfo>("wowsp://arena-info", handler),
  captureGameWindow: () => transport.invoke<CaptureResult>(RPC.capture_game_window),
  setOverlayVisible: (visible: boolean) =>
    transport.invoke<null>(RPC.set_overlay_visible, { visible }),
  /** Create (once) the hidden transparent overlay window + start the Rust
   *  Tab watcher. `realm` is forwarded to the overlay webview via the URL so
   *  its batch lookups don't need a separate install detection. */
  createOverlayWindow: (realm?: string, locale?: string) =>
    transport.invoke<null>(RPC.create_overlay_window, {
      realm: realm ?? null,
      locale: locale ?? null,
    }),
  destroyOverlayWindow: () => transport.invoke<null>(RPC.destroy_overlay_window),
  startOverlayTabWatch: () => transport.invoke<null>(RPC.start_overlay_tab_watch),
  stopOverlayTabWatch: () => transport.invoke<null>(RPC.stop_overlay_tab_watch),
  /** Open the manual-locate picker INSIDE the main window: the backend runs
   *  its gates (fresh battle roster, resolvable game window, usable cached
   *  frame) and arms the open flag; the full-cover picker layer itself is
   *  rendered by ManualLocateOverlay. Refusals reject with a STABLE code —
   *  "no-battle" / "no-game" / "no-frame" — the panel localizes into a
   *  toast next to the button shake. */
  startManualLocate: () => transport.invoke<null>(RPC.start_manual_locate),
  /** Close the picker layer without storing anything (its Esc / Cancel
   *  path) — clears the backend's open flag. */
  cancelManualLocate: () => transport.invoke<null>(RPC.cancel_manual_locate),
  /** Fetch the picker's cached frame + guides (ManualLocateOverlay's boot
   *  payload; the layer re-invokes it on retry). */
  fetchManualLocateContext: () =>
    transport.invoke<ManualLocateContext>(RPC.manual_locate_context),
  /** Submit the picker's drag-box selection (PHYSICAL px relative to the
   *  game window origin). Validates + freezes the manual roster anchor;
   *  the layer closes on this Ok and the overlay chips re-anchor on the
   *  next Tab hold. */
  setManualRosterRect: (x: number, y: number, width: number, height: number, frameGameRect?: Rect | null) =>
    transport.invoke<null>(RPC.set_manual_roster_rect, { x, y, width, height, frameGameRect }),
  /** Drop the manual anchor; detection returns to the automatic flow. */
  clearManualRosterRect: () => transport.invoke<null>(RPC.clear_manual_roster_rect),
  /** Backend force-close push for the picker layer: the game window vanished
   *  underneath it (or overlay mode ended) — unmount the layer. */
  listenManualLocateClose: (handler: () => void) =>
    transport.listen?.<void>("wowsp://manual-locate-close", handler),
  /** Anchor push from the Rust Tab watcher (capture + detector result). */
  listenOverlayAnchor: (handler: (anchor: OverlayAnchor) => void) =>
    transport.listen?.<OverlayAnchor>("wowsp://overlay-anchor", handler),
  /** Detection-state push from the Tab watcher (transition-only). */
  listenOverlayStatus: (handler: (status: OverlayStatus) => void) =>
    transport.listen?.<OverlayStatus>("wowsp://overlay-status", handler),
  /** Sink-attribution push from the Tab watcher: for one confirmed sink
   *  transition, the pre-sink alive-row indices whose players just sank
   *  (solved by strip-fingerprint matching). Consumers resolve the rows
   *  against their sort-key layouts and render the exact [alive] ++
   *  [sunk] order. */
  listenSinkAttribution: (handler: (attrib: SinkAttribution) => void) =>
    transport.listen?.<SinkAttribution>("wowsp://sink-attrib", handler),
  /** In-game plugin telemetry broadcast (commands/ingame_plugin.rs poller):
   *  { t, battle, players: { [name]: alive } } — the authoritative alive
   *  set when the roster mode is "plugin". Probe builds with realm
   *  reporting add ground-truth identity: `self` (the local player's name
   *  + realm) and `identity` (name → account/realm) straight off the
   *  game's own roster records; older builds omit both. Probes reading the
   *  avatars' ship components add `sortKeys` (name → the client's OWN Tab
   *  sort key — ShipSystem's str(class)+str(100-tier)+str(nation)+shortName
   *  string): sorting the roster by it reproduces the game's row order
   *  exactly; a build/prefix that cannot read the component omits the
   *  field. */
  listenIngameTelemetry: (handler: (payload: TelemetryPayload) => void) =>
    transport.listen?.("wowsp://ingame-telemetry", handler),
  /** The per-instance stream: EVERY running install's telemetry frames,
   *  each tagged with the `root` it came from (the plain event above
   *  carries the PREFERRED install's frames only). Consumers that serve a
   *  user-selected install — the live panel — filter by root; `root` is
   *  absent on older shells, where the frames describe the preferred
   *  install and adopting them unfiltered matches the old behavior. */
  listenIngameTelemetryWatched: (handler: (payload: TelemetryPayload) => void) =>
    transport.listen?.("wowsp://ingame-telemetry-watched", handler),
};
