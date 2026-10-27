/** Local replay battle-log domain of the WoWSP API client: the per-battle
 *  rows the dashboard's date-range views derive from the LOCAL replay files
 *  (commands/local_battles.rs) — the WG API only serves career totals, so
 *  a real "recent N days" view needs the local battle ledger.
 *
 *  The backend walks each detected install's `replays/` folder (plus the
 *  user-pinned extra folders), decodes the BattleResults (0x22) packet of
 *  every replay recorded by the requested account and returns one row per
 *  file whose payload decoded. A cold scan may leave files pending (the
 *  decode pool is bounded); callers re-invoke until `pending` reaches 0 —
 *  see stores/localBattles. */
import { transport } from "@/transport";
import { RPC } from "@/rpc";

/** One local replay file's decoded battle results, recorded by the account
 *  that was queried. Mirrors `wowsp_tauri_shared::LocalBattle`. */
export interface LocalBattle {
  /** Unix seconds — the battle's recording time from the replay header. */
  timestamp: number;
  /** Header date-time as the replay filename carries it (`YYYYMMDD_HHMMSS`,
   *  or `YYYYMMDD` when the time part is missing). */
  dateTime: string;
  /** Coarse mode bucket from the header lite (`pvp` / `ranked` / `pve` …). */
  matchGroup?: string | null;
  /** Scenario name (`domination_3point`, `asymm_3point_coop` …). */
  scenario?: string | null;
  /** Battle-script id (`PCVE027` …). */
  eventType?: string | null;
  /** The recorder's ship id (battle results index 7). */
  shipId?: number | null;
  /** The recorder's team slot from the battle results (index 6). */
  team?: number | null;
  /** Win verdict: the winning side (commonList[3]) equals the recorder's
   *  team when both are 0/1, else null (draw / undecodable layout). */
  won?: boolean | null;
  /** Damage caused (index 426; legacy layouts < 500 entries use 411). */
  damage: number;
  /** Frags (index 32). */
  frags: number;
  /** Whether the recorder survived (index 21). */
  survived: boolean;
  /** Base XP earned (index 404; legacy layouts use 389). Null when the
   *  layout did not carry it. */
  exp?: number | null;
}

/** Mirrors `wowsp_tauri_shared::LocalBattleLog`: the battle rows in the
 *  requested window plus the scan's diagnostics. */
export interface LocalBattleLog {
  battles: LocalBattle[];
  /** Replay files inspected by this call. */
  scanned: number;
  /** Files whose BattleResults payload decoded. */
  decoded: number;
  /** Files served from the decode cache without a re-decode. */
  cacheHits: number;
  /** Files still waiting for the bounded decode pool — re-invoke until 0. */
  pending: number;
}

/** Local replay battle log (desktop only; the phone has no replay folder).
 *  `fromSec`/`toSec` are inclusive Unix-second bounds on `timestamp`. */
export const localBattlesApi = {
  readLocalBattleLog: (accountId: number, realm: string, fromSec: number, toSec: number) =>
    transport.invoke<LocalBattleLog>(RPC.read_local_battle_log, {
      accountId,
      realm,
      fromSec,
      toSec,
    }),
};
