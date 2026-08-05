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
  /** Per-ribbon counters (index 24..n). */
  ribbons: number[];
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
        ribbons: arr.slice(24).filter((v): v is number => typeof v === "number"),
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
