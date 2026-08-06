/**
 * Post-battle statistics parsing (BattleResults 0x22 payload).
 *
 * The payload is a JSON object; `playersPublicInfo` maps account id → a
 * fixed-position numeric array (WoWS PostBattle layout). We extract the
 * fields that are stable across builds:
 *
 *   [1]  player name
 *   [6]  team relation (0 = self/recorder, 1 = ally, 2 = enemy) — when the
 *        recorder's own account is the match owner; otherwise best-effort
 *   [7]  ship GameParams id (resolves to a localized ship name)
 *   [20] battle damage (verified magnitude across players)
 *   [21] survived (bool)
 *   [24+] per-ribbon counters (order follows the client's ribbon list)
 *
 * Ribbon counter semantics per-index come from the client's
 * `PostBattlePlayerInfo` handling; the bundled ribbon art (res/images/ribbons)
 * is the fallback skin set for a later damage/ribbon HUD.
 */

export interface PostBattlePlayer {
  accountId: number;
  name: string;
  shipId: number | null;
  team: 0 | 1 | 2 | null;
  alive: boolean;
  damage: number;
  /** Frags (ships sunk). Index 32 — verified: the sum across players equals
   *  the match's sunk count. */
  frags: number;
/** Per-ribbon counters (index 24..n). Semantics per index follow the
 *  client's PostBattle list; only indices with data are kept. */
ribbons: PostBattleRibbon[];
}

/**
 * Best-effort mapping of the PostBattle counter zone (indices 24..132) to
 * ribbon kinds. Verified anchors:
 *  - 28 = MAIN_CALIBER (PT cruiser 10, U-69 sub 0, York 161 — matches each
 *    ship's main-battery activity)
 *  - 32 = FRAG (sum over players == sunk count)
 * Everything else follows the client's usual ribbon ordering and is labelled
 * "推测" in the UI until confirmed.
 */
export const RIBBON_INDEX_GUESS: ReadonlyArray<readonly [number, string]> = [
  [24, "main_caliber"],
  [25, "secondary_caliber"],
  [26, "torpedo"],
  [27, "dbomb"],
  [28, "main_caliber"],
  [29, "rocket"],
  [30, "missile"],
  [31, "plane"],
  [32, "frag"],
  [33, "assist"],
  [34, "crit"],
  [35, "citadel"],
  [36, "burn"],
  [37, "flood"],
  [38, "base_capture"],
  [39, "base_capture_assist"],
  [40, "base_defense"],
  [41, "suppressed"],
  [42, "splane"],
  [43, "detected"],
  [44, "wave"],
];

const RIBBON_KEY_BY_INDEX = new Map<number, string>(RIBBON_INDEX_GUESS);

export function ribbonKeyOfIndex(index: number): string | undefined {
  return RIBBON_KEY_BY_INDEX.get(index);
}

export function isRibbonIndexVerified(index: number): boolean {
  return index === 28 || index === 32;
}

export interface PostBattleRibbon {
  index: number;
  value: number;
}

export interface PostBattleData {
  players: PostBattlePlayer[];
  mode: string | null;
  raw: string;
}

/** Parse a BattleResults 0x22 JSON string into a readable summary. */
export function parsePostBattle(raw: string | null): PostBattleData | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const br = obj as Record<string, unknown>;
  const ppi = br.playersPublicInfo as Record<string, unknown> | undefined;
  const players: PostBattlePlayer[] = [];
  if (ppi && typeof ppi === "object") {
    for (const [pidStr, entry] of Object.entries(ppi)) {
      if (!Array.isArray(entry)) continue;
      const arr = entry as unknown[];
      const num = (i: number): number | null =>
        typeof arr[i] === "number" && Number.isFinite(arr[i] as number)
          ? (arr[i] as number)
          : null;
      const team = num(6);
      const shipId = num(7);
      players.push({
        accountId: Number(pidStr) || 0,
        name: typeof arr[1] === "string" ? (arr[1] as string) : `#${pidStr}`,
        shipId: shipId != null && shipId > 0 ? shipId : null,
        team: team === 0 || team === 1 || team === 2 ? team : null,
        alive: arr[21] === true,
        damage: num(20) ?? 0,
        frags: num(32) ?? 0,
        // Ribbon/counter zone: indices 24..132 hold small per-ribbon counts;
        // beyond that the array becomes big economy/damage totals. Kept as
        // {index, value} pairs so the UI can show the raw layout positions.
        ribbons: arr
          .slice(24, 133)
          .map((v, i): PostBattleRibbon => ({ index: 24 + i, value: v as number }))
          .filter((x) => x.value > 0),
      });
    }
  }
  if (players.length === 0) return null;
  players.sort((a, b) => b.damage - a.damage);
  const common = br.commonList;
  let mode: string | null = null;
  if (Array.isArray(common)) {
    const m = common.find((v) => typeof v === "string" && v.includes("_"));
    if (typeof m === "string") mode = m;
  }
  return { players, mode, raw };
}
