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
 * Mapping of the PostBattle counter zone (indices 24..45) to ribbon kinds,
 * modelled across 144 full replays / 1876 players cross-referenced against
 * ship classes (sub/dd/ca/bb/cv from GameParams prefixes):
 *
 *  - 27 = PLANE shot down       — CVs 54/54 nonzero (mean 5)
 *  - 28 = main-weapon hits      — subs read torpedo/sonar hits; hit rate vs
 *    index 30 is a consistent 27-36% across ALL classes (dd 1.65/5.71,
 *    bb 1.22/4.32, ca 1.15/4.31, sub 12.35/24.51, cv 4.3/13.63)
 *  - 30 = shots fired (≈3× hits)
 *  - 31 = AA/DP hits            — CVs mean 53, dd/sub 0
 *  - 32 = FRAG (verified: sum == sunk count)
 *  - 29 = torpedo hits          — CVs mean 10.5 (torpedo bombers)
 *  - 36 = burn                  — ca 15.2, bb 4.6, dd 3.3, cv/sub 0
 *  - 37 = main-battery salvos   — bb 15, ca 105, dd 91, cv/sub 0
 *  - 39 = citadel hits (bb 11.2) — inferred
 *  - 44 = spotting/detection (dd 22, sub 27) — inferred
 *  - 45 = CV aircraft stats     — inferred
 *  - 36 = secondary battery hits — Napoli 15, Nagato 43, dd 3, cv 0
 *  - 37 = main-battery shells   — Nagato 96 (16×6), ca 105, bb 15
 *  - 75 = ASW/depth-charge hits — subs/dds + a few BBs; values 1-8
 *  - 45 = CV aircraft stats     — inferred (CVs only)
 *
 * Known but unmapped (semantics too weak to display):
 *  - 46/47, 88/89, 92/93     CV aircraft pairs (≈equal duplicates)
 *  - 48                     airstrike/mine slot (ZH_1 590, Dutch CAs)
 *  - 87                     DD weapon slot (torpedo/ASW)
 *  - 35/40/101/103          shell aggregates; 85 shell-hit class;
 *    26 unclassified; 84 ≈2 players/battle (capture-like);
 *    113/119 full-team slots (per-battle 9-11 players)
 *  - paired duplicates 49/62, 50/51, 54/55, 58/59, 80/81, 96/97,
 *    115/116, 128/129 (≈100% equal)
 */
export const RIBBON_INDEX_GUESS: ReadonlyArray<readonly [number, string]> = [
  [27, "plane"],
  [28, "main_caliber"],
  [29, "torpedo"],
  [30, "main_caliber_shots"],
  [31, "aa_hits"],
  [32, "frag"],
  [36, "secondary_caliber"],
  [37, "shells"],
  [45, "plane_losses"],
  [75, "dbomb"],
];

/** Indices whose semantics are strongly confirmed by the replay corpus. */
const RIBBON_INDEX_VERIFIED = new Set<number>([27, 28, 32]);

const RIBBON_KEY_BY_INDEX = new Map<number, string>(RIBBON_INDEX_GUESS);

export function ribbonKeyOfIndex(index: number): string | undefined {
  return RIBBON_KEY_BY_INDEX.get(index);
}

export function isRibbonIndexVerified(index: number): boolean {
  return RIBBON_INDEX_VERIFIED.has(index);
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
