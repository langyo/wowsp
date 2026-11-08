/**
 * Post-battle statistics parsing (BattleResults 0x22 payload).
 *
 * The payload is a JSON object; `playersPublicInfo` maps account id → the
 * client's fixed-position `CLIENT_PUBLIC_RESULTS` array. Index semantics
 * follow the game-assets constants layout (client 15.2; the vendored
 * constants.json copy went away when the vendor tree slimmed to its
 * library crates — the pinning tests in postBattle.test.ts are now the
 * in-repo authority), re-verified against 126 replays / 417 players on
 * client 15.8: `damage` (426) equals the summed damage_* family, `remained_hp`
 * (20) is 0 exactly for sunk ships, planes killed (280+281) stays ≤ ~40.
 * Arrays shorter than 427 entries (older clients) simply lack the late
 * fields — they surface as null/0 instead of wrong numbers. Two later
 * client generations shifted the LATE block again (everything from `exp`
 * on); the early fields never move, so each layout needs its own offset:
 *
 *  - 15.10+ arrays are 550 entries (client 15.10.0.13533378; verified on
 *    20261108_224310_PASB820-BA-Montana_58_RidgeNew, 24 players: exp 416
 *    equals the recorder's privateDataList[7][3], killer 420 is positive
 *    exactly on the 17 sunk rows, damage 438 is the plausible 50k–200k
 *    figure). A 12-field block now precedes the `exp` pair: exp 404→416,
 *    killer 408→420, damage 426→438, scouting 412→424; the inserted slots
 *    403..414 read as zeros and 415 carries the baseline's 403 field (the
 *    base exp/payout pair's first half).
 *  - 14.x-era replays carry a 485-entry array where the SAME fields sit 15
 *    positions earlier (exp 389, killer 393, damage 411) — the 15.2 client
 *    inserted its field block before `exp`. See LEGACY_LAYOUT_MAX_LEN below.
 *  - 15.2–15.9 arrays (500..549, 538 on 15.8/15.9) are the baseline and
 *    read unshifted.
 *
 *   [1]  player name          [6]  team number
 *   [7]  ship GameParams id   [9]  realm code
 *   [15] max hull health      [20] remained hull health
 *   [21] survived             [32] ships killed
 *   [35..37] main-gun shots (AP/CS/HE)   [66..68] main-gun hits
 *   [69..74] secondary hits   [75] torpedo hits
 *   [87, 96] depth-charge hits
 *   [280, 281] planes killed (by ship / by carrier aircraft)
 *   [404/416] base exp        [408/420] killer account id (0 = no killer)
 *   [412/424] scouting damage [426/438] battle damage
 *   (slashed pairs: 15.2–15.9 baseline first, 15.10+ second; the 14.x
 *   layout sits another 15 fields earlier than either.)
 *
 * History: the first implementation guessed the ribbon counters from a
 * replay corpus without the layout table and read first-spotting counts
 * (27), bomb drops (45) and distance (23) as plane kills / plane losses /
 * remaining-HP — producing impossible values like "290 planes shot down".
 */

import { isAiName } from "@/utils/aiNames";

export interface PostBattlePlayer {
  accountId: number;
  name: string;
  /** Realm code (playersPublicInfo[9], e.g. "asia") — for global stats. */
  realm: string | null;
  shipId: number | null;
  team: 0 | 1 | 2 | null;
  alive: boolean;
  /** Battle damage dealt — index 426 (438 on 15.10+, 411 on 14.x). */
  damage: number;
  /** Damage taken — max hull HP (15) − remained HP (20). */
  damageTaken: number;
  /** Frags (ships sunk). Index 32 — verified: the sum across players equals
   *  the match's sunk count. */
  frags: number;
  /** Remaining-HP percent (0..100) — remained HP (20) / max HP (15). */
  hpRatio: number | null;
  /** Killer player accountId (index 408; 420 on 15.10+, 393 on the
   *  pre-15.2 layout) — null when the ship survived. The wire carries the
   *  game's 0 "no killer" sentinel (never null); only a POSITIVE account id
   *  counts as a kill, so the sentinel is normalized away here (see the
   *  parse comment). */
  killerId: number | null;
  /** Settlement base exp (index 404; 416 on 15.10+, 389 on 14.x) — bots
   *  report 0; null when the array is too short (older client layouts). */
  exp: number | null;
  /** Named stat counters (see RIBBON_SOURCES). Only stats with an
   * authoritative counter are emitted; zero values are dropped. */
  ribbons: PostBattleRibbon[];
}

/** 14.x-era arrays (485 entries on client 14.5) vs the 15.2+ ones (538 on
 *  15.8/15.9): anything shorter than this cap is a legacy layout whose late
 *  fields sit LATE_INDEX_SHIFT positions earlier. The 500 cap sits in the
 *  485..538 gap — no intermediate layout is known, and one landing in
 *  486..499 would misread as legacy (shifted-late, values likely null/0). */
const LEGACY_LAYOUT_MAX_LEN = 500;
/** 15.10+ arrays (550 entries on client 15.10.0.13533378) widened the table
 *  again: a second LATE_INDEX_SHIFT_1510-field block precedes `exp`, so the
 *  late fields sit that many positions LATER. Arrays in the 500..549 gap
 *  keep the 15.2–15.9 baseline. */
const LATE_LAYOUT_1510_MIN_LEN = 550;
/** First NEW-table index a client LATE-field insertion affects (exp at 404). */
const LATE_SHIFT_MIN_INDEX = 404;
/** Width of the block the 15.2 client inserted before `exp`. */
const LATE_INDEX_SHIFT = 15;
/** Width of the block the 15.10 client inserted before `exp`. */
const LATE_INDEX_SHIFT_1510 = 12;

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
      // Each client generation moved the LATE block (everything from `exp`
      // on) by inserting a field run before it; the early fields keep their
      // index in every layout. Shift the late reads back onto the 15.2–15.9
      // baseline: 14.x (< 500) inserted 15 fields (exp 389→404, killer
      // 393→408, damage 411→426; arrays grew 485→538), while 15.10+ (>= 550)
      // inserted 12 more (exp 404→416, killer 408→420, damage 426→438;
      // arrays grew 538→550). Reading the baseline indices on those layouts
      // lands on the inserted zero block or the neighbouring field, which
      // surfaced as an all-zero XP column, "?" killer ids and broken damage
      // on 15.10 replays. Detect by length and shift the late fields;
      // everything below the block (name, team, ship, HP, frags, ribbons)
      // keeps its index either way.
      const lateShift =
        arr.length >= LATE_LAYOUT_1510_MIN_LEN
          ? LATE_INDEX_SHIFT_1510
          : arr.length < LEGACY_LAYOUT_MAX_LEN
            ? -LATE_INDEX_SHIFT
            : 0;
      const late = (i: number): number =>
        i >= LATE_SHIFT_MIN_INDEX ? i + lateShift : i;
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
      // Killer attribution (index 408 on the 15.2–15.9 baseline; 393 on
      // 14.x, 420 on 15.10+). The wire carries the game's 0 sentinel for
      // SURVIVORS — never null: verified on client 15.9 replay
      // 20261026_183956_PBSD107-Jervis_41_Conquest (24/24 playersPublicInfo
      // rows non-null, 7 of them exactly 0; every sunk row carries a
      // positive account id). Account ids start at 1, so only a positive
      // value is a killer; 0 (or any other non-positive value) must become
      // null BEFORE any consumer sees it. Left as 0,
      // shipHp.ts::inferDarkDeaths reads the row as a definitive sink and
      // puts every survivor's death at its last observed moment — the
      // replay's final frame — which is the whole-roster-sunk bug. (Negative
      // values DO reach the wire on real captures — two's-complement ids
      // above 2^31 appear as e.g. -3554201467 — so those sunk rows normalize
      // to null as well: a known attribution gap, separate from the layout.)
      const rawKiller = num(late(408));
      const killerId = rawKiller != null && rawKiller > 0 ? rawKiller : null;
      players.push({
        accountId: Number(pidStr) || 0,
        name: typeof arr[1] === "string" ? (arr[1] as string) : `#${pidStr}`,
        realm: typeof arr[9] === "string" ? (arr[9] as string).toLowerCase() : null,
        shipId: shipId != null && shipId > 0 ? shipId : null,
        team: team === 0 || team === 1 || team === 2 ? team : null,
        alive: arr[21] === true,
        damage: num(late(426)) ?? 0,
        damageTaken,
        frags: num(32) ?? 0,
        hpRatio,
        killerId,
        exp: num(late(404)),
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

/** First post-battle row matching an AI-controlled victim hull, for the
 *  replay kill feed's killer resolution: operations (行动) field hostile
 *  waves the arena roster never lists (an op roster covers the player team
 *  only — the waves spawn mid-battle), so the replay side cannot join by
 *  nickname. The ship's GameParams id plus an AI-shaped name (`:bot:` fill /
 *  `IDS_*` / `#` text keys — a human nickname is never shaped like either)
 *  is the whole signature. `victimIsEnemy` + the recorder's team slot keep a
 *  same-hull human row on the other side from absorbing the join. Undefined
 *  when no row qualifies — the caller keeps its "?" killer. */
export function findNpcVictimRow(
  players: readonly PostBattlePlayer[],
  shipId: number,
  victimIsEnemy: boolean,
  selfTeam: 0 | 1 | 2 | null,
): PostBattlePlayer | undefined {
  return players.find(
    (p) =>
      p.shipId === shipId &&
      isAiName(p.name) &&
      (selfTeam == null ||
        p.team == null ||
        (p.team === selfTeam) !== victimIsEnemy),
  );
}
