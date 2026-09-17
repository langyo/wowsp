/**
 * Post-battle statistics parsing (BattleResults 0x22 payload).
 *
 * The payload is a JSON object; `playersPublicInfo` maps account id → the
 * client's fixed-position `CLIENT_PUBLIC_RESULTS` array. Index semantics
 * follow the authoritative layout vendored in
 * packages/tools/wowsunpack-vendor/embedded_resources/constants.json
 * (client 15.2), re-verified against 126 replays / 417 players on client
 * 15.8: `damage` (426) equals the summed damage_* family, `remained_hp`
 * (20) is 0 exactly for sunk ships, planes killed (280+281) stays ≤ ~40.
 * Arrays shorter than 427 entries (older clients) simply lack the late
 * fields — they surface as null/0 instead of wrong numbers.
 *
 *   [1]  player name          [6]  team number
 *   [7]  ship GameParams id   [9]  realm code
 *   [15] max hull health      [20] remained hull health
 *   [21] survived             [32] ships killed
 *   [35..37] main-gun shots (AP/CS/HE)   [66..68] main-gun hits
 *   [69..74] secondary hits   [75] torpedo hits
 *   [87, 96] depth-charge hits
 *   [280, 281] planes killed (by ship / by carrier aircraft)
 *   [404] base exp            [408] killer account id
 *   [412] scouting damage     [426] battle damage
 *
 * History: the first implementation guessed the ribbon counters from a
 * replay corpus without the layout table and read first-spotting counts
 * (27), bomb drops (45) and distance (23) as plane kills / plane losses /
 * remaining-HP — producing impossible values like "290 planes shot down".
 */

export interface PostBattlePlayer {
  accountId: number;
  name: string;
  /** Realm code (playersPublicInfo[9], e.g. "asia") — for global stats. */
  realm: string | null;
  shipId: number | null;
  team: 0 | 1 | 2 | null;
  alive: boolean;
  /** Battle damage dealt — index 426. */
  damage: number;
  /** Damage taken — max hull HP (15) − remained HP (20). */
  damageTaken: number;
  /** Frags (ships sunk). Index 32 — verified: the sum across players equals
   *  the match's sunk count. */
  frags: number;
  /** Remaining-HP percent (0..100) — remained HP (20) / max HP (15). */
  hpRatio: number | null;
  /** Killer player accountId (index 408). */
  killerId: number | null;
  /** Settlement base exp (index 404) — bots report 0; null when the array
   *  is too short (older client layouts). */
  exp: number | null;
  /** Named stat counters (see RIBBON_SOURCES). Only stats with an
   * authoritative counter are emitted; zero values are dropped. */
  ribbons: PostBattleRibbon[];
}

/**
 * Ribbon kind → the CLIENT_PUBLIC_RESULTS indices summed for that counter.
 * Each entry maps 1:1 onto a bundled ribbon icon (res/images/ribbons via
 * ribbonIcons.ts). Counters without an authoritative source are not shown
 * at all: there is no AA-hit counter in the public array, and the old
 * "plane_losses" position (45) is actually bombs dropped.
 */
export const RIBBON_SOURCES: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["frag", [32]],
  ["main_caliber", [66, 67, 68]],
  ["main_caliber_shots", [35, 36, 37]],
  // Ship torpedoes (75) + torpedo-bomber hits (80, the total; the *_avia /
  // *_alt splits at 81-83 are subsets of it).
  ["torpedo", [75, 80]],
  ["secondary_caliber", [69, 70, 71, 72, 73, 74]],
  // Regular (87) and air-dropped (96) depth charges — mutually exclusive
  // per weapon fit, so summing is safe.
  ["dbomb", [87, 96]],
  ["plane", [280, 281]],
];

export interface PostBattleRibbon {
  /** Ribbon kind key (see RIBBON_SOURCES / ribbon_names.json). */
  key: string;
  value: number;
}

export interface PostBattleData {
  players: PostBattlePlayer[];
  mode: string | null;
  /** The recorder's account id (battleResults.accountDBID), when present. */
  selfId: number | null;
  /** The recorder's own private settlement (battleResults.privateDataList):
   *  [credits, _, _, exp] at index 7. Only the recorder's data is streamed. */
  selfExp: number | null;
  selfCredits: number | null;
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
      const sum = (idx: readonly number[]): number => {
        let acc = 0;
        for (const i of idx) {
          const v = num(i);
          if (v != null) acc += v;
        }
        return acc;
      };
      const team = num(6);
      const shipId = num(7);
      const maxHp = num(15);
      const remained = num(20);
      // Damage taken = hull HP lost = max − remained. Damage dealt to planes
      // is not part of hull HP, so this stays a hull-only figure.
      const damageTaken =
        maxHp != null && remained != null ? Math.max(0, Math.round(maxHp - remained)) : 0;
      const hpRatio =
        maxHp != null && remained != null && maxHp > 0 ? (remained / maxHp) * 100 : null;
      players.push({
        accountId: Number(pidStr) || 0,
        name: typeof arr[1] === "string" ? (arr[1] as string) : `#${pidStr}`,
        realm: typeof arr[9] === "string" ? (arr[9] as string).toLowerCase() : null,
        shipId: shipId != null && shipId > 0 ? shipId : null,
        team: team === 0 || team === 1 || team === 2 ? team : null,
        alive: arr[21] === true,
        damage: num(426) ?? 0,
        damageTaken,
        frags: num(32) ?? 0,
        hpRatio,
        killerId: num(408) ?? null,
        exp: num(404),
        ribbons: RIBBON_SOURCES.map(
          ([key, idx]): PostBattleRibbon => ({ key, value: sum(idx) }),
        ).filter((x) => x.value > 0),
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
  // Own private settlement: privateDataList[7] = [credits, _, _, exp, _].
  let selfExp: number | null = null;
  let selfCredits: number | null = null;
  const pdl = (br.privateDataList as unknown[] | undefined) ?? null;
  if (Array.isArray(pdl) && Array.isArray(pdl[7])) {
    const p7 = pdl[7] as unknown[];
    if (typeof p7[3] === "number") selfExp = p7[3] as number;
    if (typeof p7[0] === "number") selfCredits = p7[0] as number;
  }
  return {
    players,
    mode,
    selfId: typeof br.accountDBID === "number" ? (br.accountDBID as number) : null,
    selfExp,
    selfCredits,
    raw,
  };
}
