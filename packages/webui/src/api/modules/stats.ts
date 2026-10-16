/** Player/clan/ship statistics domain of the WoWSP API client: WG public
 *  API lookups, the ship encyclopedia, per-ship histories, trends and the
 *  ship-data hot-update pack (composed into `api` by client.ts). */
import { transport } from "@/transport";
import { RPC } from "@/rpc";
import type { PrAlgo } from "@/stores/statsPrefs";

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
  /** Battle counts behind each division winrate (the split tooltips).
   *  Absent on cache files written before these fields existed. */
  soloBattles?: number | null;
  div2Battles?: number | null;
  div3Battles?: number | null;
  // ── Ranked (排位) career stats ──────────────────────────────────────
  /** Career ranked battles; null = never played ranked / hidden. Absent
   *  on cache files written before these fields existed. Consumed by the
   *  roster stats-source mode selector (utils/statView). */
  rankedBattles?: number | null;
  rankedWinrate?: number | null;
  rankedAvgDamage?: number | null;
  rankedPr?: number | null;
  // ── Global (全局 = randoms + ranked merged) career stats ────────────
  /** Combined career battles (randoms + ranked); equals `battles` for an
   *  account that never played ranked. Absent on cache files written
   *  before these fields existed. */
  globalBattles?: number | null;
  globalWinrate?: number | null;
  globalAvgDamage?: number | null;
  globalPr?: number | null;
  /** Unix time of the account's last finished battle — the backend's
   *  same-name cross-realm arbiter (see `crossRealm` on
   *  `lookupPlayersStatsBatch`). Absent on older cache files. */
  lastBattleTime?: number | null;
}

/** Player-name autocomplete item (WG account/list). Mirrors `wowsp_tauri_shared::PlayerSuggestion`. */
export interface PlayerSuggestion {
  accountId: number;
  nickname: string;
}

/** 空中小人/水下小人 composition verdict for one player (Tab overlay seals).
 *  Mirrors `wowsp_tauri_shared::PlayerComposition`; the thresholds (career
 *  battles > 200, class share > 20%, veteran tier > 50%) are enforced
 *  backend-side. A veteran flag implies its base flag. */
export interface PlayerComposition {
  air: boolean;
  sub: boolean;
  airVeteran: boolean;
  subVeteran: boolean;
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

/** One ship's row of the wows-numbers expected-values table — the server
 *  averages the PR trend derivation weighs the cached per-ship history's
 *  interval deltas against. Mirrors `wowsp_tauri_shared::ExpectedPrEntry`. */
export interface ExpectedPrEntry {
  shipId: number;
  /** Mean damage per battle across the server sample. */
  avgDamage: number;
  /** Mean frags per battle. */
  avgFrags: number;
  /** Mean win rate, in percent. */
  winrate: number;
}

/** Streaming progress for one per-ship fetch source — mirrors
 *  `commands::ship_stats::ShipStatsProgress` (event
 *  `wowsp://ship-stats-progress`). `source` names the transport
 *  (`"vortex:pvp"`, `"official"`, …); `rows` rides `phase: "partial"`
 *  only. */
export interface ShipStatsProgress {
  realm: string;
  accountId: number;
  phase: "partial" | "slow" | "done" | "aborted";
  source: string;
  rows?: PlayerShipStats[] | null;
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

/** One catalogue row of the disclosed upstream host table — mirrors
 *  `commands::upstream_health::CatalogueEntry`. `purpose` is an i18n key
 *  suffix under `upstream.purpose.*`; `kind: "stats"` rows are the ones
 *  whose transport outcomes get recorded. */
export interface UpstreamHostEntry {
  id: string;
  host: string;
  purpose: string;
  realms: string[];
  kind: string;
}

/** Per-host rolling transport outcome — mirrors
 *  `commands::upstream_health::HostHealth`. */
export interface UpstreamHostHealth {
  consecutiveFailures: number;
  lastSuccessTs?: number | null;
  lastFailureTs?: number | null;
  lastError?: string | null;
}

/** Mirrors `commands::upstream_health::UpstreamHostReport` (catalogue +
 *  health joined). */
export interface UpstreamHostReport extends UpstreamHostEntry, UpstreamHostHealth {
  recorded: boolean;
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

export const statsApi = {
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
   *  `prAlgo` as in lookupPlayerStats. `crossRealm` enables the backend's
   *  cross-server Clan-Battles pass (names the home realm cannot explain
   *  are probed on the other WG clusters; adopted entries carry their true
   *  realm in `PlayerStats.realm`). */
  lookupPlayersStatsBatch: (
    names: string[],
    realm: string,
    prAlgo?: PrAlgo,
    crossRealm?: boolean,
  ) =>
    transport.invoke<(PlayerStats | null)[]>(RPC.lookup_players_stats_batch, {
      names,
      realm,
      prAlgo: prAlgo ?? null,
      crossRealm: crossRealm ?? null,
    }),
  /** Wipe the process-lifetime roster stats cache (the live panel's
   *  manual "refresh stats" button): the next batch is a true
   *  from-scratch request. */
  clearRosterStatsCache: () => transport.invoke<null>(RPC.clear_roster_stats_cache),
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
  /** Per-ship stats list. `prAlgo` as in lookupPlayerStats. `sessionCache`
   *  opts into the backend's shared per-ship source (process-lifetime
   *  read-through cache; the single-flight applies to every caller) — the
   *  roster surfaces in BOTH windows pass it so they share one WG request
   *  per player; the per-ship detail panel keeps the default always-fresh
   *  contract. */
  lookupPlayerShipStats: (
    accountId: number,
    realm: string,
    prAlgo?: PrAlgo,
    sessionCache?: boolean,
  ) =>
    transport.invoke<PlayerShipStats[]>(RPC.lookup_player_ship_stats, {
      accountId,
      realm,
      prAlgo: prAlgo ?? null,
      sessionCache: sessionCache ?? null,
    }),
  /** Per-ship history points — baselines for "recent N days" deltas. */
  readShipStatsHistory: (accountId: number, realm: string) =>
    transport.invoke<ShipStatsHistoryPoint[]>(RPC.read_ship_stats_history, { accountId, realm }),
  /** Streaming progress for per-ship fetches (commands/ship_stats.rs's
   *  `wowsp://ship-stats-progress`): "slow" marks a source streaming past
   *  15s still flowing — the degraded-loading chip; "partial" carries
   *  enriched rows for the table to fill with mid-flight; "done"/"aborted"
   *  stand a source down. */
  listenShipStatsProgress: (handler: (progress: ShipStatsProgress) => void) =>
    transport.listen?.<ShipStatsProgress>("wowsp://ship-stats-progress", handler),
  /** Catalogue + rolling health of the upstream hosts — the data behind
   *  the title bar's fault chip. Stateless; the frontend renders the
   *  verdict (streak threshold, staleness). */
  upstreamHealth: () => transport.invoke<UpstreamHostReport[]>(RPC.upstream_health),
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
  /** The whole expected-values table as a flat list — the PR trend chart's
   *  baseline. Empty when no data is available at all (offline and never
   *  fetched); the chart then shows its unavailable note. */
  getExpectedPrTable: () => transport.invoke<ExpectedPrEntry[]>(RPC.get_expected_pr_table),
  getRankedStats: (accountId: number, realm: string, seasonCount?: number) =>
    transport.invoke<RankedSeasonStats[]>(RPC.get_ranked_stats, { accountId, realm, seasonCount }),
  /** The data pack's installed version (Settings → updates data
   *  sources row), or null while only the bundled asset serves. */
  dataPackInfo: () => transport.invoke<string | null>(RPC.data_pack_info),
  /** The runtime-downloaded consumable-kit JSON (the `data-latest`
   *  cache, hash-verified shell-side), or null when no download ever
   *  landed — the baked asset serves in that case. */
  getShipKit: () => transport.invoke<string | null>(RPC.get_ship_kit),
  /** One pass of the ship-data hot-update channel: fetch the manifest,
   *  re-download only what changed. True when anything was updated. */
  refreshDataPack: () => transport.invoke<boolean>(RPC.refresh_data_pack),
};
