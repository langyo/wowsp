/** Replay-derived date-range summary for the dashboard's water-table tabs.
 *
 *  The WG API serves career totals only, and the snapshot-delta path needs
 *  an old-enough local history point — frequently absent, so the range tabs
 *  read "0 ships / no battles". The local replay battle log fills that gap:
 *  one row per replay file the account recorded, already restricted to the
 *  requested window by the backend.
 *
 *  Only RANDOM (pvp) and RANKED battles are kept — the modes the user asked
 *  the range views to cover. Classification reuses the replay surfaces'
 *  canonical `modeKey`, so a ranked battle arriving as matchGroup
 *  "ranked" or as a ranked scenario lands in the same bucket.
 *
 *  The aggregation shape matches the WG-API rows the dashboard already
 *  renders (`PlayerShipStats[]`): per-ship battles/wins/damage/frags/
 *  survival plus the derived winrate and avgDamage, and account totals on
 *  top. Ship names stay empty — the views resolve display names from the
 *  encyclopedia/offline DB exactly as they do for API rows. */
import type { LocalBattle, PlayerShipStats } from "@/api";
import { modeKey } from "./modeColors";

/** Canonical mode keys the range views keep: random + ranked. */
const KEPT_MODES: ReadonlySet<string> = new Set(["pvp", "ranked"]);

/** Account totals + per-ship rows derived from one window's local battles. */
export interface LocalBattleSummary {
  /** Per-ship rows, most-played first (ties by ship id for a stable order). */
  ships: PlayerShipStats[];
  /** Random + ranked battles in the window. */
  battles: number;
  /** Battles won (`won === true`; null verdicts count as non-wins). */
  wins: number;
  /** wins / battles * 100 (0 when the window is empty). */
  winrate: number;
  /** Mean damage over every kept battle (0 when the window is empty). */
  avgDamage: number;
  /** Window start (Unix seconds) the backend filtered on. */
  sinceTs: number;
  /** Window end (Unix seconds) the backend filtered on. */
  endTs: number;
  /** Battles classified as ranked. */
  rankedBattles: number;
}

/** Accumulator for one ship's window rows. */
interface ShipAccumulator {
  battles: number;
  wins: number;
  damage: number;
  frags: number;
  survived: number;
  lastBattleTime: number;
  xpSum: number;
  xpCount: number;
}

/** Build the dashboard's replay-derived range summary.
 *
 *  `sinceTs`/`endTs` are the window the rows were requested for — they are
 *  echoed back so the view labels the covered range, never a clock reading
 *  that may have moved since the load. Rows are expected to be pre-filtered
 *  by the backend; only the MODE filter runs here. */
export function summarizeLocalBattles(
  battles: readonly LocalBattle[],
  sinceTs: number,
  endTs: number,
): LocalBattleSummary {
  const byShip = new Map<number, ShipAccumulator>();
  let totalBattles = 0;
  let wins = 0;
  let totalDamage = 0;
  let rankedBattles = 0;

  for (const battle of battles) {
    const mode = modeKey(battle.matchGroup, battle.scenario, battle.eventType);
    if (!KEPT_MODES.has(mode)) continue;
    const won = battle.won === true;
    totalBattles += 1;
    if (won) wins += 1;
    totalDamage += battle.damage;
    if (mode === "ranked") rankedBattles += 1;
    // A row without a ship id still counts toward the account totals; it
    // just cannot feed the per-ship table.
    if (battle.shipId == null) continue;
    let acc = byShip.get(battle.shipId);
    if (!acc) {
      acc = {
        battles: 0,
        wins: 0,
        damage: 0,
        frags: 0,
        survived: 0,
        lastBattleTime: 0,
        xpSum: 0,
        xpCount: 0,
      };
      byShip.set(battle.shipId, acc);
    }
    acc.battles += 1;
    if (won) acc.wins += 1;
    acc.damage += battle.damage;
    acc.frags += battle.frags;
    if (battle.survived) acc.survived += 1;
    if (battle.timestamp > acc.lastBattleTime) acc.lastBattleTime = battle.timestamp;
    if (battle.exp != null) {
      acc.xpSum += battle.exp;
      acc.xpCount += 1;
    }
  }

  const ships: PlayerShipStats[] = [...byShip.entries()]
    .map(([shipId, acc]) => ({
      shipId,
      // Display names are resolved by the views (encyclopedia / offline DB).
      name: "",
      battles: acc.battles,
      wins: acc.wins,
      damageCaused: acc.damage,
      frags: acc.frags,
      survivedBattles: acc.survived,
      winrate: (acc.wins / acc.battles) * 100,
      avgDamage: acc.damage / acc.battles,
      lastBattleTime: acc.lastBattleTime,
      // Replays carry no server-expected PR baseline — the same "unknown"
      // shape the API rows use when the realm doesn't serve it.
      pr: null,
      avgXp: acc.xpCount > 0 ? acc.xpSum / acc.xpCount : null,
    }))
    .sort((a, b) => b.battles - a.battles || a.shipId - b.shipId);

  return {
    ships,
    battles: totalBattles,
    wins,
    winrate: totalBattles > 0 ? (wins / totalBattles) * 100 : 0,
    avgDamage: totalBattles > 0 ? totalDamage / totalBattles : 0,
    sinceTs,
    endTs,
    rankedBattles,
  };
}
