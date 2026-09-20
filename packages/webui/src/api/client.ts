/**
 * WoWSP API client. Thin wrappers over the transport singleton that map each
 * Tauri command to a typed call, so feature code imports `api.detectGameInstall()`
 * instead of touching `transport.invoke(RPC...)` directly.
 */
import { transport } from "@/transport";
import { RPC } from "@/rpc";
import type { PrAlgo } from "@/stores/statsPrefs";

/** Mirrors `wowsp_tauri_shared::GameInstall`. */
export interface GameInstall {
  kind: "wargaming" | "steam" | "lesta" | "cn360" | "cnKongzhong" | "manual";
  path: string;
  realm?: string | null;
}

/** Installer kind discriminator (see GameInstall). */
export type GameInstallKind = GameInstall["kind"];

/** Mirrors `wowsp_tauri_shared::GameProcessInfo`. Richer than the legacy
 *  `is_game_running` boolean — carries the PID and the install (kind/realm)
 *  the running process belongs to, resolved by exe-path prefix match. */
export interface GameProcessInfo {
  running: boolean;
  pid?: number | null;
  kind?: GameInstall["kind"] | null;
  realm?: string | null;
  exePath?: string | null;
  matchedInstall?: GameInstall | null;
}

/** Mirrors `wowsp_tauri_shared::VehicleEntry`. */
export interface VehicleEntry {
  id: number;
  name: string;
  /** 0/1 = ally (self + division); 2+ = enemy. Numeric in the client JSON. */
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
  /** Roster entries with the client's `:Name:` bot nickname. */
  botCount?: number | null;
  vehicles: VehicleEntry[];
  raw: unknown;
}

/** Mirrors `wowsp_tauri_shared::ReplayMetaLite`. Lightweight replay summary
 *  returned by `list_replays_meta` — only the descriptor-JSON block is parsed
 *  (no packet stream), so a few hundred replays list fast. The full
 *  `ReplayMeta` (with roster + raw JSON) comes later from `readReplayHeader`. */
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
  /** Roster entries with the client's `:Name:` bot nickname. */
  botCount?: number | null;
  /** The recorder's ship id (roster relation == 0). Drives the ship preview. */
  ownShipId?: number | null;
  /** Recorder's ship display name when resolvable, else null. */
  ownShipName?: string | null;
  /** Number of players in the roster. */
  playerCount: number;
}

/** Mirrors `wowsp_tauri_shared::ArenaInfo`. */
export interface ArenaInfo {
  matchGroup?: string | null;
  dateTime?: string | null;
  mapName?: string | null;
  /** Scenario name — the "tournament" variants are custom-room fingerprints. */
  scenario?: string | null;
  /** Roster entries with the client's `:Name:` bot nickname. */
  botCount?: number | null;
  vehicles: VehicleEntry[];
  raw: unknown;
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
  /** Per-row player names matched from the on-screen table text, same
   *  length/order as `rowCenters` (allies block first). `null`/absent = no
   *  recognition ran (map rows by index); an element `null` = that row's
   *  player was not recognized (render a silent placeholder, never guess
   *  by index). Names are the roster's own nicknames (stats-cache keys). */
  rowPlayers?: (string | null)[] | null;
  /** Per-row alive classification read off the same name strips the
   *  recognizer crops (sunk rows render dim gray in-game). Same length/order
   *  as `rowCenters`; `true` = alive; null/absent = recognition did not run
   *  (treat every row as alive). */
  rowAlive?: boolean[] | null;
  /** True when recognition is enabled but this anchor has no trusted
   *  row→name mapping yet (arena roster not ready, OCR read nothing, or
   *  no row's text matched the roster): the overlay shows its "recognizing
   *  roster" badge while this is up and the watcher transplants the
   *  mapping onto the pin once it lands. Always false for manual anchors
   *  and when recognition is off. */
  rowPlayersPending?: boolean;
  /** True when a detected sink JUST changed the rows (alive flags flipped,
   *  the in-game table re-sorted) and the row→name re-mapping is still
   *  catching up at the accelerated OCR cadence: the current chips' row
   *  attribution may change again within seconds. Purely informational;
   *  always false for manual anchors and when recognition is off. */
  stale?: boolean;
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
  /** Mirrors `OverlayAnchor.stale`: true while the anchored rows' data just
   *  changed (a ship sank) and the row→name re-mapping is catching up —
   *  the panel can badge "updating". Only meaningful while `state` is
   *  "detected": the flag rides the watcher's pin state, so a stale pin
   *  that gets hidden (Tab released, focus lost) may leave `stale` true on
   *  a later idle/searching payload until the next battle resets it. */
  stale?: boolean;
}

/** One row of the in-game Tab panel as recognized off the live frame
 *  (mirrors `wowsp_tauri_shared::TabRowPlayer`): the player sitting in that
 *  row (null when the row's text was not matched) and whether their ship
 *  was still afloat at capture time. */
export interface TabRowPlayer {
  name?: string | null;
  alive: boolean;
}

/** Payload of the `wowsp://tab-order` event (mirrors
 *  `wowsp_tauri_shared::TabRowOrder`): the in-game Tab panel's CURRENT row
 *  order per side — [alive by ship class] ++ [sunk by ship class], re-sorted
 *  live as ships sink — an order tempArenaInfo.json never carries. Match it
 *  to the live roster via `dateTime`. */
export interface TabRowOrder {
  dateTime?: string | null;
  /** Arena-file mtime stamp (battle identity on the Rust side). */
  battle: number;
  allies: TabRowPlayer[];
  enemies: TabRowPlayer[];
}

/** One position sample (mirrors `wowsp_tauri_shared::PositionSample`). WoWS
 * maps are planar: x = east, z = north, y ≈ 0 (sea level). */
export interface PositionSample {
  time: number;
  entityId: number;
  vehicleId: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Entity creation metadata (mirrors `wowsp_tauri_shared::EntityKind`). The
 * fixed header of an EntityCreate (0x05) packet plus the roster shipId
 * recovered from its state blob. `entityType` 2 = vehicle (ships). */
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

/** Aircraft weapon ids (DamageStatWeapon): carrier rockets / bombers /
 *  torpedo bombers / skip bombers plus the Alt-/Tb- variants. Burn (17) and
 *  flood (20) are DoT categories shared with ship weapons, so they stay out. */
const PLANE_WEAPON_IDS: ReadonlySet<number> = new Set<number>([
  11, 12, 28, 41, 42, 43, ...range(51, 58), ...range(63, 70), ...range(74, 81),
]);

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Whether a damage-stat weapon id is an aircraft weapon (carrier planes). */
function isPlaneWeapon(weapon: number): boolean {
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
}

/** Player stats from the WG public API (mirrors `wowsp_tauri_shared::PlayerStats`). */
export interface PlayerStats {
  accountId: number;
  name: string;
  realm: string;
  battles?: number | null;
  winrate?: number | null;
  hidden: boolean;
  clanTag?: string | null;
  /** Clan id (jump key from a player card to the clan view). */
  clanId?: number | null;
  // ── Deep stats (PvP) ────────────────────────────────────────────────
  avgDamage?: number | null;
  avgXp?: number | null;
  kdRatio?: number | null;
  survivalRate?: number | null;
  hitRate?: number | null;
  pr?: number | null;
  shipsPlayed?: number | null;
  // ── Service record (player level/badge) ─────────────────────────────
  levelingTier?: number | null;
  levelingPoints?: number | null;
  // ── Dog tag (player emblem from Vortex API) ─────────────────────────
  dogTag?: DogTag | null;
  // ── Per-division winrates ───────────────────────────────────────────
  soloWr?: number | null;
  div2Wr?: number | null;
  div3Wr?: number | null;
}

/** Player-name autocomplete item (WG account/list). Mirrors `wowsp_tauri_shared::PlayerSuggestion`. */
export interface PlayerSuggestion {
  accountId: number;
  nickname: string;
}

/** 空中小人/水下小人 composition verdict for one player (Tab overlay seals).
 *  Mirrors `wowsp_tauri_shared::PlayerComposition`; the thresholds (career
 *  battles > 200, class share > 20%) are enforced backend-side. */
export interface PlayerComposition {
  air: boolean;
  sub: boolean;
}

/** Clan autocomplete item (WG clans/list). Mirrors `wowsp_tauri_shared::ClanSuggestion`. */
export interface ClanSuggestion {
  clanId: number;
  tag: string;
  name: string;
  membersCount?: number | null;
}

/** Per-member PvP summary inside a clan roster. Mirrors `wowsp_tauri_shared::ClanMemberStats`. */
export interface ClanMemberStats {
  battles?: number | null;
  wins?: number | null;
  winrate?: number | null;
  avgDamage?: number | null;
  /** Community PR proxy (same formula as the player card). */
  pr?: number | null;
  avgXp?: number | null;
  kdRatio?: number | null;
  survivalRate?: number | null;
  hidden: boolean;
}

/** One clan member (roster row). Mirrors `wowsp_tauri_shared::ClanMember`. */
export interface ClanMember {
  accountId: number;
  name: string;
  /** WG role key (commander / executive_officer / private / …). */
  role: string;
  joinedAt?: number | null;
  stats: ClanMemberStats;
}

/** Clan overview + roster with per-member stats. Mirrors `wowsp_tauri_shared::ClanInfo`. */
export interface ClanInfo {
  clanId: number;
  tag: string;
  name: string;
  realm: string;
  description?: string | null;
  membersCount: number;
  createdAt?: number | null;
  members: ClanMember[];
  totalBattles: number;
  totalWins: number;
  winrate: number;
  avgDamage: number;
  /** Mean PR proxy across visible members that have one. */
  avgPr?: number | null;
  hiddenCount: number;
}

/** Mirrors `wowsp_tauri_shared::GameVersionInfo`. */
export interface GameVersionInfo {
  gameVersion: string;
  shipsTotal: number;
  timestamp: number;
}

/** Mirrors `wowsp_tauri_shared::ShipInfo`. */
export interface ShipImages {
  small: string;
  medium: string;
  large: string;
  contour: string;
}

export interface ShipInfo {
  shipId: number;
  name: string;
  tier: number;
  type: string;
  nation: string;
  isPremium: boolean;
  isSpecial: boolean;
  description: string;
  gameVersion: string;
  defaultProfile: unknown;
  images: ShipImages;
}

/** One Modernization entity's price record (from GameParams via
 *  get_upgrade_prices). `cost` is credits. */
export interface UpgradePrice {
  name: string;
  cost?: number;
  group?: string;
  index?: string;
}

/** Mirrors `wowsp_tauri_shared::PlayerShipStats`. */
export interface PlayerShipStats {
  shipId: number;
  name: string;
  battles: number;
  wins: number;
  damageCaused: number;
  frags: number;
  survivedBattles: number;
  winrate: number;
  avgDamage: number;
  lastBattleTime: number;
  /** Winrate-only PR proxy for this ship (same anchors as the account PR).
   *  Absent on caches written before the field existed. */
  pr?: number | null;
  /** Average XP per battle (null when the realm API doesn't serve xp). */
  avgXp?: number | null;
  /** Per-mode breakdown (random solo/div2/div3, co-op, ranked). Null when
   *  the realm API doesn't serve battle-type splits. */
  modes?: ShipModeBreakdown | null;
}

/** One battle-type bucket of a per-ship mode breakdown. Mirrors
 *  `wowsp_tauri_shared::ShipModeStats`. */
export interface ShipModeStats {
  battles: number;
  wins: number;
  damageCaused: number;
  frags: number;
  survivedBattles: number;
  winrate: number;
  avgDamage: number;
}

/** Per-mode breakdown of a ship's stats. Mirrors
 *  `wowsp_tauri_shared::ShipModeBreakdown`. */
export interface ShipModeBreakdown {
  solo: ShipModeStats | null;
  div2: ShipModeStats | null;
  div3: ShipModeStats | null;
  coop: ShipModeStats | null;
  ranked: ShipModeStats | null;
}

/** Server-wide per-ship averages from the wows-numbers expected-values
 *  dataset. Mirrors `wowsp_tauri_shared::ShipServerStats`. */
export interface ShipServerStats {
  shipId: number;
  /** Mean damage per battle across the server sample. */
  avgDamage: number;
  /** Mean frags per battle. */
  avgFrags: number;
  /** Mean win rate, in percent. */
  winrate: number;
  /** Unix seconds the source dataset was generated. */
  generatedAt: number;
  /** True when served from the on-disk cache without a network fetch. */
  fromCache: boolean;
}

/** Mirrors `wowsp_tauri_shared::ShipCareerTotals` — the monotonic subset of
 *  PlayerShipStats stored in the per-ship history. */
export interface ShipCareerTotals {
  shipId: number;
  battles: number;
  wins: number;
  damageCaused: number;
  frags: number;
  survivedBattles: number;
  lastBattleTime: number;
}

/** Mirrors `wowsp_tauri_shared::ShipStatsHistoryPoint`. */
export interface ShipStatsHistoryPoint {
  timestamp: number;
  ships: ShipCareerTotals[];
}

/** Mirrors `wowsp_tauri_shared::StatsSnapshot`. */
export interface StatsSnapshot {
  timestamp: number;
  gameVersion: string;
  battles: number;
  wins: number;
  winrate: number;
  avgDamage: number;
  pr?: number | null;
}

/** Mirrors `wowsp_tauri_shared::TrendBucket`. */
export interface TrendBucket {
  version: string;
  startTime: number;
  endTime: number;
  snapshotCount: number;
  battleDelta: number;
  winrateAvg: number;
  winrateMin: number;
  winrateMax: number;
  avgDamage: number;
  prAvg?: number | null;
}

/** Mirrors `wowsp_tauri_shared::PatchNote`. */
export interface PatchNote {
  version: string;
  date: string;
  shipIds: number[];
  summary: string;
  changes: string[];
}

/** Mirrors `wowsp_tauri_shared::TrendResult`. */
export interface TrendResult {
  accountId: number;
  realm: string;
  buckets: TrendBucket[];
  patches: PatchNote[];
}

/** Mirrors `wowsp_tauri_shared::CommunityTrend`. */
export interface CommunityTrend {
  available: boolean;
  shipId: number;
  buckets: TrendBucket[];
}

/** Mirrors `wowsp_tauri_shared::RankedSeasonStats` — a player's ranked stats
 *  for a single season. */
export interface RankedSeasonStats {
  seasonId: number;
  seasonName: string;
  battles: number;
  wins: number;
  losses: number;
  damageDealt: number;
  frags: number;
  maxDamage: number;
  maxXp: number;
  survivedBattles: number;
  planesKilled: number;
  currentRank: number | null;
  bestRank: number | null;
  bestRankDisplay: string | null;
}

/** Proxy mode + optional manual URL (mirrors the Rust NetworkConfig). */
export interface NetworkConfig {
  /** "system" (OS settings) | "none" (direct) | "manual" (fixed proxy URL). */
  mode: "system" | "none" | "manual";
  /** Manual proxy URL, e.g. "http://127.0.0.1:7890" (only for "manual"). */
  proxy?: string | null;
  /** Mirror base for remote resources (ship portraits etc.); empty → the
   *  official Wargaming CDN. See commands/media.rs. */
  resourceCdn?: string | null;
  /** ghproxy-style mirror prefix for GitHub downloads (resource packs, mod
   *  catalog); empty → direct GitHub with the built-in mirrors as fallback.
   *  See commands/model_pack.rs. */
  githubMirror?: string | null;
  /** OS proxy pre-resolved by the shell (read-only, for proxy-URL consumers). */
  effectiveProxy?: string | null;
}

// ── Resource packs (mirrors `wowsp_tauri_shared`, see commands/model_pack.rs)

/** One resource pack's LOCAL state (Settings → cache management). */
export interface PackStatus {
  /** "models" | "dogtags". */
  id: string;
  present: boolean;
  /** Cached sync version — the release asset's `updated_at` stamp. */
  version?: string | null;
  /** Recursive on-disk size in bytes. */
  sizeBytes: number;
  downloading: boolean;
}

/** Remote pack state after a `res-latest` lookup. */
export interface PackUpdate {
  /** "models" | "dogtags". */
  id: string;
  remoteVersion?: string | null;
  /** Remote version known AND different from the cached stamp. */
  updateAvailable: boolean;
}

/** Progress push for a pack download (`wowsp://pack-progress`). */
export interface PackProgress {
  /** "models" | "dogtags". */
  id: string;
  /** "download" | "extract" | "done" | "error". */
  phase: string;
  received: number;
  /** Total bytes when the server reported Content-Length, else 0. */
  total: number;
  error?: string | null;
}

/** A clearable auxiliary cache directory. */
export interface AuxCacheStatus {
  /** "image-cache" | "gameparams" | "encyclopedia" | "community". */
  scope: string;
  sizeBytes: number;
}

// ── Mod Hub (mirrors `wowsp_tauri_shared`, see commands/mod_hub.rs) ────────

/** Plugin category from on-disk structure signatures (mod-formats.md). */
export type ModKind = "voice" | "skin" | "script" | "textures" | "gui" | "patch";

/** One classified plugin found installed under `res_mods/<version>/`. */
export interface InstalledMod {
  kind: ModKind;
  name: string;
  /** PnF ship id / voice-over selector label, when the format carries one. */
  detail?: string | null;
  /** Primary res_mods-relative path — the key the unit commands take.
   *  Manifest-only rows (no files matched on disk) key on the mod name. */
  relPath: string;
  /** Every root the unit spans (res_mods-relative, disjoint). */
  paths: string[];
  /** True when every file of the unit is renamed with a `.bak` suffix. */
  disabled: boolean;
  /** Version from Aslain's installed_mods.xml, when manifest-backed. */
  version?: string | null;
}

/** Result of toggling one installed plugin's `.bak` state. */
export interface UnitToggleReport {
  relPath: string;
  /** State after the toggle: true = files renamed to `.bak`. */
  disabled: boolean;
  renamedFiles: number;
}

/** One subtree copy in an install plan (package rel → res_mods rel). */
export interface PackagePlanEntry {
  fromRel: string;
  toRel: string;
}

/** Install plan for an unpacked plugin directory. */
export interface PackagePlan {
  kind: ModKind;
  name: string;
  detail?: string | null;
  entries: PackagePlanEntry[];
  warnings: string[];
}

/** Result of applying a plan to a game install. */
export interface InstallReport {
  name: string;
  binVersion: string;
  wroteFiles: number;
  warnings: string[];
}

// ── Mod Hub online catalog (mirrors wowsp_tauri_shared, commands/mod_catalog.rs) ──

/** One downloadable package of a catalog entry (mod-hub release asset). */
export interface CatalogPackage {
  url: string;
  sha256: string;
  size: number;
  name: string;
}

/** Localized name + one-line description (from the wowsp:i18n thread block). */
export interface CatalogEntryI18n {
  name: string;
  description: string;
}

/** The latest version payload of one mod in `mod-index.json`. */
export interface CatalogEntry {
  id: string;
  /** `battle | minimap | port | texts`. */
  category: string;
  /** Discussions thread carrying the full post (source, hashes, feedback). */
  discussion?: number | null;
  version: string;
  /** Game-version range as published, e.g. `>=15.7 <15.8`. */
  game: string;
  title: string;
  nameZh: string;
  nameEn: string;
  description: string;
  authorUrl: string;
  packages: CatalogPackage[];
  /** Localized variants keyed by BCP-47 locale; empty for older posts. */
  i18n: Record<string, CatalogEntryI18n>;
}

/** Parsed `mod-index.json` — the online plugin list the hub page renders. */
export interface CatalogIndex {
  /** Upstream catalog stamp, e.g. `v.15.7.0 #10 (2026.08.30)`. */
  sourceVersion: string;
  gameVersion: string;
  fetchedAt: string;
  mods: CatalogEntry[];
}

/** Install book-keeping for one mod (`mods/installed.json`). */
export interface ModInstallRecord {
  id: string;
  name: string;
  version: string;
  category: string;
  /** `mod-hub` for catalog installs, `local` for folder installs. */
  source: string;
  discussion?: number | null;
  binVersion: string;
  installedAt: string;
  files: string[];
  restoreDir?: string | null;
}

/** Result of uninstalling a catalog mod. */
export interface UninstallReport {
  id: string;
  name: string;
  removedFiles: number;
  restoredFiles: number;
}

/** Progress push for a catalog install (`wowsp://mod-catalog-progress`). */
export interface CatalogProgress {
  id: string;
  /** `downloading | installing | done`. */
  phase: string;
  package: number;
  packages: number;
  received: number;
  total: number;
}

/** Mirrors `wowsp_tauri_shared::DogTag` — player's personalized emblem. */
export interface DogTag {
  textureId: number;
  symbolId: number;
  /** ARGB-packed border color (u32). */
  borderColor: number;
  /** ARGB-packed background color (u32). */
  backgroundColor: number;
  backgroundId: number;
}

/** Mirrors `commands::wallpaper::WallpaperFile` — one user-imported wallpaper
 *  image under `<data_dir>/wallpapers/`. `id` doubles as the file name and
 *  the persisted selection key. */
export interface WallpaperFile {
  id: string;
  name: string;
  /** Absolute path — the frontend rewrites it into an asset-protocol URL. */
  path: string;
}

export const api = {
  getOsPreferences: () => transport.invoke<{ locale: string; colorScheme: string }>(RPC.get_os_preferences),
  appdataRead: (file: string) => transport.invoke<string | null>(RPC.appdata_read, { file }),
  appdataWrite: (file: string, content: string) => transport.invoke<null>(RPC.appdata_write, { file, content }),
  appdataDelete: (file: string) => transport.invoke<null>(RPC.appdata_delete, { file }),
  isGameRunning: () => transport.invoke<boolean>(RPC.is_game_running),
  getGameProcess: (installs: GameInstall[]) =>
    transport.invoke<GameProcessInfo>(RPC.get_game_process, { installs }),
  detectGameInstall: () => transport.invoke<GameInstall[]>(RPC.detect_game_install),
  setGamePath: (path: string) => transport.invoke<GameInstall>(RPC.set_game_path, { path }),
  /** Native folder picker for the manual game-location entry. Null = the
   *  user cancelled the dialog. */
  pickGameFolder: () => transport.invoke<GameInstall | null>(RPC.pick_game_folder),
  /** Native multi-select dialog for .wowsreplay files anywhere on disk.
   *  Empty array = cancelled. */
  pickReplayFiles: () => transport.invoke<string[]>(RPC.pick_replay_files),
  /** List imported wallpapers in the fixed AppData `wallpapers/` folder. */
  wallpaperList: () => transport.invoke<WallpaperFile[]>(RPC.wallpaper_list),
  /** Native image picker → copy into the wallpapers folder. Null = the
   *  user cancelled the dialog. */
  wallpaperImport: () => transport.invoke<WallpaperFile | null>(RPC.wallpaper_import),
  wallpaperRemove: (id: string) => transport.invoke<null>(RPC.wallpaper_remove, { id }),
  /** res_mods ribbon-skin directory for a game install (None if unmodded). */
  ribbonSkinDir: (gamePath: string) =>
    transport.invoke<string | null>(RPC.ribbon_skin_dir, { gamePath }),
  readReplayHeader: (path: string) => transport.invoke<ReplayMeta>(RPC.read_replay_header, { path }),
  readReplayPositions: (path: string) =>
    transport.invoke<ReplayStream>(RPC.read_replay_positions, { path }),
  listReplays: (dir?: string, limit?: number) =>
    transport.invoke<string[]>(RPC.list_replays, { dir, limit }),
  /** List replays with parsed descriptor metadata (date/mode/map/own ship).
   *  Only reads the JSON header block per file — fast even for hundreds. */
  listReplaysMeta: (dir?: string, limit?: number) =>
    transport.invoke<ReplayMetaLite[]>(RPC.list_replays_meta, { dir, limit }),
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
  /** Screenshot-style manual locate: open the drag-box picker window over
   *  the game rect (single-instance; errors when no fresh battle roster or
   *  game window). `locale` picks the picker page's copy. */
  startManualLocate: (locale?: string) =>
    transport.invoke<null>(RPC.start_manual_locate, { locale: locale ?? null }),
  /** Close the picker without storing anything (its Esc / Cancel path). */
  cancelManualLocate: () => transport.invoke<null>(RPC.cancel_manual_locate),
  /** Submit the picker's drag-box selection (PHYSICAL px relative to the
   *  game window origin). Validates + freezes the manual roster anchor and
   *  closes the picker; the overlay chips re-anchor on the next Tab hold. */
  setManualRosterRect: (x: number, y: number, width: number, height: number) =>
    transport.invoke<null>(RPC.set_manual_roster_rect, { x, y, width, height }),
  /** Drop the manual anchor; detection returns to the automatic flow. */
  clearManualRosterRect: () => transport.invoke<null>(RPC.clear_manual_roster_rect),
  /** Anchor push from the Rust Tab watcher (capture + detector result). */
  listenOverlayAnchor: (handler: (anchor: OverlayAnchor) => void) =>
    transport.listen?.<OverlayAnchor>("wowsp://overlay-anchor", handler),
  /** Detection-state push from the Tab watcher (transition-only). */
  listenOverlayStatus: (handler: (status: OverlayStatus) => void) =>
    transport.listen?.<OverlayStatus>("wowsp://overlay-status", handler),
  /** In-game Tab row-order push from the Tab watcher: fired whenever a
   *  recognition pass over a held Tab frame produced a trusted row→name
   *  mapping (initial pin, layout shift, or a re-sort after sinks). The
   *  main window's live panel reorders its columns to mirror it. */
  listenTabOrder: (handler: (order: TabRowOrder) => void) =>
    transport.listen?.<TabRowOrder>("wowsp://tab-order", handler),
  /** Player stats lookup. `prAlgo` picks the PR formula ("winrate" =
   *  ApeRadar weighted winrate, "expected" = wows-numbers expected values);
   *  omitted → the backend's zero-cost default. Forward it only while the
   *  PR rating is enabled (see stores/statsPrefs prAlgoForRequest). */
  lookupPlayerStats: (name: string, realm: string, prAlgo?: PrAlgo) =>
    transport.invoke<PlayerStats>(RPC.lookup_player_stats, {
      name,
      realm,
      prAlgo: prAlgo ?? null,
    }),
  /** Batch roster lookup: one entry per input name, in order; null = not
   *  found / lookup failed (the panel renders that as "no data"). Skips the
   *  per-player Vortex dog-tag call — roster cards show WR/PR only.
   *  `prAlgo` as in lookupPlayerStats. */
  lookupPlayersStatsBatch: (names: string[], realm: string, prAlgo?: PrAlgo) =>
    transport.invoke<(PlayerStats | null)[]>(RPC.lookup_players_stats_batch, {
      names,
      realm,
      prAlgo: prAlgo ?? null,
    }),
  /** Composition-seal verdicts (Tab overlay seals): one entry per input
   *  name, in order; null = not found / hidden profile / insufficient data
   *  / that player's lookup failed (the backend degrades per-name failures
   *  instead of failing the whole batch). */
  lookupPlayersComposition: (names: string[], realm: string) =>
    transport.invoke<(PlayerComposition | null)[]>(RPC.lookup_players_composition, {
      names,
      realm,
    }),
  /** Live player autocomplete (nickname substring or numeric UID). */
  suggestPlayers: (search: string, realm: string) =>
    transport.invoke<PlayerSuggestion[]>(RPC.suggest_players, { search, realm }),
  /** Live clan autocomplete (tag/name substring or numeric clan id). */
  suggestClans: (search: string, realm: string) =>
    transport.invoke<ClanSuggestion[]>(RPC.suggest_clans, { search, realm }),
  /** Clan overview + roster (members' names/stats resolved server-side).
   *  `prAlgo` as in lookupPlayerStats — under "expected" the roster answers
   *  member PR=null (per-member aggregation is too costly server-side; the
   *  roster renders "—" for it). */
  lookupClanInfo: (clanId: number, realm: string, prAlgo?: PrAlgo) =>
    transport.invoke<ClanInfo>(RPC.lookup_clan_info, { clanId, realm, prAlgo: prAlgo ?? null }),
  getGameVersion: () => transport.invoke<GameVersionInfo>(RPC.get_game_version),
  getShipEncyclopedia: (realm: string, forceRefresh: boolean, language?: string) =>
    transport.invoke<ShipInfo[]>(RPC.get_ship_encyclopedia, { realm, forceRefresh, language }),
  /** Per-ship stats list. `prAlgo` as in lookupPlayerStats. */
  lookupPlayerShipStats: (accountId: number, realm: string, prAlgo?: PrAlgo) =>
    transport.invoke<PlayerShipStats[]>(RPC.lookup_player_ship_stats, {
      accountId,
      realm,
      prAlgo: prAlgo ?? null,
    }),
  /** Per-ship history points — baselines for "recent N days" deltas. */
  readShipStatsHistory: (accountId: number, realm: string) =>
    transport.invoke<ShipStatsHistoryPoint[]>(RPC.read_ship_stats_history, { accountId, realm }),
  snapshotPlayerStats: (
    accountId: number,
    realm: string,
    battles: number | null,
    wins: number | null,
    winrate: number | null,
    avgDamage: number | null,
    pr: number | null,
  ) =>
    transport.invoke<StatsSnapshot>(RPC.snapshot_player_stats, {
      accountId,
      realm,
      battles,
      wins,
      winrate,
      avgDamage,
      pr,
    }),
  getShipGameparams: (shipId: number, gameRoot: string) =>
    transport.invoke<unknown>(RPC.get_ship_gameparams, { shipId, gameRoot }),
  /** Modernization price data walked from the install's GameParams.data:
   *  keyed by index (PCM027) AND full entity name; `cost` is credits. */
  getUpgradePrices: (gameRoot: string) =>
    transport.invoke<Record<string, UpgradePrice>>(RPC.get_upgrade_prices, { gameRoot }),
  getPlayerTrend: (accountId: number, realm: string) =>
    transport.invoke<TrendResult>(RPC.get_player_trend, { accountId, realm }),
  getPatches: () => transport.invoke<PatchNote[]>(RPC.get_patches),
  getCommunityShipTrend: (shipId: number) =>
    transport.invoke<CommunityTrend>(RPC.get_community_ship_trend, { shipId }),
  /** Server-wide per-ship averages (wows-numbers expected values). Null =
   *  the ship has no server sample; throws when no data can be fetched. */
  getShipServerStats: (shipId: number) =>
    transport.invoke<ShipServerStats | null>(RPC.get_ship_server_stats, { shipId }),
  captureMainWindow: (path: string) =>
    transport.invoke<string>(RPC.capture_main_window, { path }),
  /** Native save dialog for tactical-board exports (screenshots/video).
   *  Null = the user cancelled the dialog. */
  pickExportPath: (defaultName: string, filterName: string, filterExts: string[]) =>
    transport.invoke<string | null>(RPC.pick_export_path, {
      defaultName,
      filterName,
      filterExts,
    }),
  /** Write export bytes (PNG/WebP image, MP4/WebM video) to an absolute path
   *  from `pickExportPath` via a raw IPC body. Rejects outside the Tauri
   *  shell — callers fall back to a browser download. */
  saveExportBytes: (path: string, bytes: Uint8Array) =>
    transport.invokeRaw?.<null>(RPC.write_export_bytes, bytes, {
      "x-export-path": encodeURIComponent(path),
    }) ?? Promise.reject(new Error("raw IPC unavailable in this host")),
  installOverlayMod: (gameRoot: string) =>
    transport.invoke<string>(RPC.install_overlay_mod, { gameRoot }),
  uninstallOverlayMod: (gameRoot: string) =>
    transport.invoke<null>(RPC.uninstall_overlay_mod, { gameRoot }),
  isOverlayModInstalled: (gameRoot: string) =>
    transport.invoke<boolean>(RPC.is_overlay_mod_installed, { gameRoot }),
  getRankedStats: (accountId: number, realm: string, seasonCount?: number) =>
    transport.invoke<RankedSeasonStats[]>(RPC.get_ranked_stats, { accountId, realm, seasonCount }),
  /** Download model pack from GitHub Releases to local cache. Returns the
   *  cache directory path so the frontend can construct file URLs. */
  ensureModelPack: () => transport.invoke<string>(RPC.ensure_model_pack),
  /** Dog-tag pack (map + part PNGs) overlaying the bundled snapshot. */
  ensureDogtagPack: () => transport.invoke<string>(RPC.ensure_dogtag_pack),
  // ── Resource packs: cache management (Settings panel) ──
  /** Local state of every pack (presence, version, size, in-flight). */
  getPackStatus: () => transport.invoke<PackStatus[]>(RPC.get_pack_status),
  /** Remote `res-latest` stamps + whether an update is available. */
  checkPackUpdates: () => transport.invoke<PackUpdate[]>(RPC.check_pack_updates),
  /** Explicit (initial/update) pack download with progress events. */
  packDownload: (id: string) => transport.invoke<null>(RPC.pack_download, { id }),
  /** Cancel the in-flight pack download. */
  packCancel: () => transport.invoke<null>(RPC.pack_cancel),
  /** Delete one pack's cache directory + version stamp. */
  clearPack: (id: string) => transport.invoke<null>(RPC.clear_pack, { id }),
  /** Sizes of the clearable auxiliary cache directories. */
  auxCacheOverview: () => transport.invoke<AuxCacheStatus[]>(RPC.aux_cache_overview),
  /** Wipe one auxiliary cache directory's contents. */
  clearAuxCache: (scope: string) => transport.invoke<null>(RPC.clear_aux_cache, { scope }),
  /** Pack-download progress stream (`wowsp://pack-progress`). */
  listenPackProgress: (handler: (p: PackProgress) => void) =>
    transport.listen?.<PackProgress>("wowsp://pack-progress", handler),
  /** Network proxy settings (system / none / manual), applied globally. */
  getNetworkConfig: () => transport.invoke<NetworkConfig>(RPC.get_network_config),
  setNetworkConfig: (config: NetworkConfig) =>
    transport.invoke<null>(RPC.set_network_config, { config }),
  // ── Mod Hub ──
  modHubScanInstalled: (gameRoot: string) =>
    transport.invoke<InstalledMod[]>(RPC.mod_hub_scan_installed, { gameRoot }),
  modHubClassifyPath: (sourcePath: string) =>
    transport.invoke<PackagePlan>(RPC.mod_hub_classify_path, { sourcePath }),
  modHubInstall: (sourceRoot: string, gameRoot: string, plan: PackagePlan) =>
    transport.invoke<InstallReport>(RPC.mod_hub_install, { sourceRoot, gameRoot, plan }),
  /** Toggle one installed plugin's temporary disable state: disabling
   *  renames every file with a `.bak` suffix, enabling strips it again. */
  modHubSetUnitEnabled: (relPath: string, gameRoot: string, enabled: boolean) =>
    transport.invoke<UnitToggleReport>(RPC.mod_hub_set_unit_enabled, {
      relPath,
      gameRoot,
      enabled,
    }),
  /** Uninstall one installed plugin unit (deletes its files, restores
   *  snapshotted originals, syncs the Aslain manifest when relevant). */
  modHubUninstallUnit: (relPath: string, gameRoot: string) =>
    transport.invoke<UninstallReport>(RPC.mod_hub_uninstall_unit, { relPath, gameRoot }),
  // ── Mod Hub online catalog ──
  /** Fetch (or serve cached) `mod-index.json` from the mod-hub release. */
  modCatalogRefresh: (force: boolean) =>
    transport.invoke<CatalogIndex>(RPC.mod_catalog_refresh, { force }),
  modCatalogInstall: (modId: string, gameRoot: string) =>
    transport.invoke<InstallReport>(RPC.mod_catalog_install, { modId, gameRoot }),
  modCatalogUninstall: (modId: string, gameRoot: string) =>
    transport.invoke<UninstallReport>(RPC.mod_catalog_uninstall, { modId, gameRoot }),
  modHubRecords: () => transport.invoke<ModInstallRecord[]>(RPC.mod_hub_records),
  listenCatalogProgress: (handler: (p: CatalogProgress) => void) =>
    transport.listen?.<CatalogProgress>("wowsp://mod-catalog-progress", handler),
};
