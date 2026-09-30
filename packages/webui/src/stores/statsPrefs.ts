import { defineStore } from "pinia";
import { ref } from "vue";

import type { StampKind } from "@/utils/winrate";

/** Which backend formula produces the `pr` field: ApeRadar's weighted
 *  winrate (the shipped behavior) or wows-numbers expected values. */
export type PrAlgo = "winrate" | "expected";

/** Per-seal kill switches, keyed by StampKind. Absent/false = the seal
 *  shows; true = that one seal never renders, on any surface. A Partial
 *  on purpose: seals the user never touched carry no entry at all, so the
 *  blob stays small and new kinds default to visible. */
export type SealDisableMap = Partial<Record<StampKind, boolean>>;

/** Which battle-mode career feeds the roster numbers — on EVERY surface
 *  now (the Tab overlay's chips and team averages, the live panel's rows,
 *  both post-battle panels): follow the current battle (ranked battles
 *  show the ranked career, everything else randoms), a fixed mode, or the
 *  global merge of randoms + ranked. The stored FIELD keeps its historical
 *  `overlayStatsMode` name for blob compatibility. */
export type RosterStatsMode = "auto" | "random" | "ranked" | "global";

/** Per-row stat content switches — the Tab overlay's chips and the roster
 *  panels' columns alike (winrate / PR / battles / avg damage). At least
 *  one on → numbers render; all off → only the seal stamps remain (the
 *  panels additionally keep their battle-local XP column). */
export interface OverlayChipToggles {
  winrate: boolean;
  pr: boolean;
  battles: boolean;
  damage: boolean;
}

/** Team-intel card item switches (radar / hydro / smoke estimates). The
 *  card's master switch is `teamIntelEnabled`. */
export interface OverlayIntelToggles {
  radar: boolean;
  hydro: boolean;
  smoke: boolean;
}

/** Team-average line items under each team (mean winrate / mean PR / mean
 *  avg damage over the players whose stats landed). */
export interface OverlayTeamAvgToggles {
  winrate: boolean;
  pr: boolean;
  damage: boolean;
}

/** Water-table display preferences. Persisted as one JSON blob so the
 *  knobs always travel together (the onboarding wizard and the settings
 *  section write the same object). */
export interface StatsPrefs {
  /** Master switch for every PR rating surface (account card hero, per-ship
   *  panel, live roster lines, clan card). Winrate coloring never depends on
   *  this. Defaults ON — the roster columns ship with winrate/PR/battles
   *  together; turning it off hides every PR number and the seals. */
  prEnabled: boolean;
  /** Rating algorithm forwarded to the stats RPCs when `prEnabled`. */
  prAlgo: PrAlgo;
  /** 神了/海猴/蛆 verdict seals (AND-composed with RatingStamp's own
   *  zh-locale gate — the seal wording stays Chinese-only). */
  sealsEnabled: boolean;
  /** Fun localized tier wording (夯/人上人/战舰仙人…) vs the standard
   *  English band words (Bad…Unicum). */
  localizedTiers: boolean;
  /** Live-battle team winrate aggregation: tier-weighted (higher tiers
   *  count more) or the plain arithmetic mean. */
  weightedTeamWr: boolean;
  /** Live-battle roster rows compressed to the post-battle matrix's
   *  one-line look (battle icon + WR/PR/avg-damage columns + the career
   *  seal, no ship-meta strip). Full cards stay the default. */
  liveRosterCompact: boolean;
  /** Post-battle roster rows expanded to the live panel's full-card look
   *  (name/ship/stat stack + ship-meta strip + career seal + XP column).
   * Compact rows stay the default. */
  postbattleRosterFull: boolean;
  /** Tab overlay team-intel cards flanking the roster (radar/hydro/smoke
   *  estimate counts + the side's longest radar range). */
  teamIntelEnabled: boolean;
  /** Per-seal visibility toggles (settings' seal customizer). */
  sealDisabled: SealDisableMap;
  /** Tab overlay per-row chip / roster panel column content (winrate / PR /
   *  battles / avg damage). */
  overlayChips: OverlayChipToggles;
  /** Which battle-mode career the roster surfaces display (see
   *  `RosterStatsMode`; the field name is historical). */
  overlayStatsMode: RosterStatsMode;
  /** Team-intel card items (master switch `teamIntelEnabled`). */
  overlayIntel: OverlayIntelToggles;
  /** Team-average line items under each team. */
  overlayTeamAvg: OverlayTeamAvgToggles;
}

export const STATS_PREFS_STORAGE_KEY = "wowsp-stats-prefs";

/** The canonical seal kinds — mirrored here (type-only import above) so
 *  parsePrefs can drop junk keys from a hand-edited blob. */
const STAMP_KINDS = ["miracle", "ape", "maggot", "rat", "air", "sub"] as const;

export const DEFAULT_STATS_PREFS: StatsPrefs = {
  prEnabled: true,
  prAlgo: "winrate",
  sealsEnabled: true,
  localizedTiers: true,
  weightedTeamWr: true,
  liveRosterCompact: false,
  postbattleRosterFull: false,
  teamIntelEnabled: true,
  sealDisabled: {},
  // All four stat columns ship on: the roster reads winrate / PR / battles
  // together (each still individually switchable in the settings).
  overlayChips: { winrate: true, pr: true, battles: true, damage: true },
  overlayStatsMode: "auto",
  overlayIntel: { radar: true, hydro: true, smoke: true },
  overlayTeamAvg: { winrate: false, pr: false, damage: false },
};

function isPrAlgo(v: unknown): v is PrAlgo {
  return v === "winrate" || v === "expected";
}

function isRosterStatsMode(v: unknown): v is RosterStatsMode {
  return v === "auto" || v === "random" || v === "ranked" || v === "global";
}

/** Read a toggles object of shape T off a raw blob: known boolean keys are
 *  kept, everything else falls back to the default entry — a hand-edited
 *  blob can never smuggle in junk keys or lose a newly added toggle. */
function parseToggles<T extends object>(raw: unknown, defaults: T): T {
  const out = { ...defaults };
  if (raw == null || typeof raw !== "object") return out;
  const src = raw as Record<string, unknown>;
  const dst = out as Record<string, unknown>;
  for (const key of Object.keys(defaults) as Array<keyof T & string>) {
    if (typeof src[key] === "boolean") dst[key] = src[key];
  }
  return out;
}

/** Validate a raw JSON blob into prefs. Corrupt/wrong-shaped input returns
 *  null so the caller falls back to defaults wholesale — a half-merged
 *  object would silently mix stored and default knobs. */
function parseSealDisabled(v: unknown): SealDisableMap {
  if (v == null || typeof v !== "object") return {};
  const out: SealDisableMap = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if ((STAMP_KINDS as readonly string[]).includes(k) && typeof val === "boolean") {
      out[k as StampKind] = val;
    }
  }
  return out;
}

function parsePrefs(raw: string | null): StatsPrefs | null {
  if (raw == null) return null;
  try {
    const j = JSON.parse(raw) as Partial<StatsPrefs> & { avgStatsEnabled?: unknown };
    if (j == null || typeof j !== "object") return null;
    // Migration: the old single "per-row avg stats" switch seeds the chip
    // toggles the first time a pre-overlayChips blob is read — its spirit
    // was "show the stat numbers", so it seeds the whole shipped set.
    const legacyAvg =
      typeof j.avgStatsEnabled === "boolean" ? j.avgStatsEnabled : null;
    const seededChips: OverlayChipToggles =
      legacyAvg == null
        ? DEFAULT_STATS_PREFS.overlayChips
        : // The legacy switch's spirit was "show the stat numbers" — it
          // seeds the whole shipped set now (all four on), not the old
          // winrate+damage-only pair.
          { winrate: legacyAvg, pr: legacyAvg, battles: legacyAvg, damage: legacyAvg };
    return {
      prEnabled:
        typeof j.prEnabled === "boolean" ? j.prEnabled : DEFAULT_STATS_PREFS.prEnabled,
      prAlgo: isPrAlgo(j.prAlgo) ? j.prAlgo : DEFAULT_STATS_PREFS.prAlgo,
      sealsEnabled:
        typeof j.sealsEnabled === "boolean"
          ? j.sealsEnabled
          : DEFAULT_STATS_PREFS.sealsEnabled,
      localizedTiers:
        typeof j.localizedTiers === "boolean"
          ? j.localizedTiers
          : DEFAULT_STATS_PREFS.localizedTiers,
      weightedTeamWr:
        typeof j.weightedTeamWr === "boolean"
          ? j.weightedTeamWr
          : DEFAULT_STATS_PREFS.weightedTeamWr,
      liveRosterCompact:
        typeof j.liveRosterCompact === "boolean"
          ? j.liveRosterCompact
          : DEFAULT_STATS_PREFS.liveRosterCompact,
      postbattleRosterFull:
        typeof j.postbattleRosterFull === "boolean"
          ? j.postbattleRosterFull
          : DEFAULT_STATS_PREFS.postbattleRosterFull,
      teamIntelEnabled:
        typeof j.teamIntelEnabled === "boolean"
          ? j.teamIntelEnabled
          : DEFAULT_STATS_PREFS.teamIntelEnabled,
      sealDisabled: parseSealDisabled(j.sealDisabled),
      overlayChips: parseToggles(j.overlayChips, seededChips),
      overlayStatsMode: isRosterStatsMode(j.overlayStatsMode)
        ? j.overlayStatsMode
        : DEFAULT_STATS_PREFS.overlayStatsMode,
      overlayIntel: parseToggles(j.overlayIntel, DEFAULT_STATS_PREFS.overlayIntel),
      overlayTeamAvg: parseToggles(j.overlayTeamAvg, DEFAULT_STATS_PREFS.overlayTeamAvg),
    };
  } catch {
    return null;
  }
}

/** localStorage can throw (quota / disabled storage) — prefs then live in
 *  memory for the session, which is the graceful degradation we want. */
function readStored(): string | null {
  try {
    return localStorage.getItem(STATS_PREFS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persist(p: StatsPrefs): void {
  try {
    localStorage.setItem(STATS_PREFS_STORAGE_KEY, JSON.stringify(p));
  } catch {
    // see readStored
  }
}

export function loadStatsPrefs(): StatsPrefs {
  const raw = readStored();
  const parsed = parsePrefs(raw);
  if (parsed == null) {
    const defaults = { ...DEFAULT_STATS_PREFS };
    // Heal-write: outright garbage resets the WHOLE blob to the defaults on
    // disk, so the stale value is corrected once instead of re-defaulting
    // on every boot (missing key = first run, nothing to heal).
    if (raw != null) persist(defaults);
    return defaults;
  }
  // Normalize: a partially-invalid blob (dropped junk seal keys, fields
  // reset to defaults, the migrated-away legacy keys) is rewritten so
  // what's on disk is what's in effect.
  if (JSON.stringify(parsed) !== raw) persist(parsed);
  return parsed;
}

/** App-wide source of truth as a MODULE-level ref (not store-owned state):
 *  non-Pinia consumers — the prTierLabel() render helper in utils/winrate
 *  and the prAlgoForRequest() param injector used by stores/composables —
 *  read the exact reactive state the Pinia store writes, so toggling a
 *  pref re-renders every consumer without prop-drilling. */
export const statsPrefsState = ref<StatsPrefs>(loadStatsPrefs());

/** The `prAlgo` RPC argument: forwarded only while the PR rating is on —
 *  omitted otherwise so the backend keeps its zero-cost default. */
export function prAlgoForRequest(): PrAlgo | undefined {
  return statsPrefsState.value.prEnabled ? statsPrefsState.value.prAlgo : undefined;
}

export const useStatsPrefsStore = defineStore("statsPrefs", () => {
  /** Shared with the module-level ref — the store is the (only) write API,
   *  persisting on every mutation. */
  const prefs = statsPrefsState;

  function setPrEnabled(v: boolean) {
    prefs.value.prEnabled = v;
    persist({ ...prefs.value });
  }

  function setPrAlgo(v: PrAlgo) {
    prefs.value.prAlgo = v;
    persist({ ...prefs.value });
  }

  function setSealsEnabled(v: boolean) {
    prefs.value.sealsEnabled = v;
    persist({ ...prefs.value });
  }

  function setLocalizedTiers(v: boolean) {
    prefs.value.localizedTiers = v;
    persist({ ...prefs.value });
  }

  function setWeightedTeamWr(v: boolean) {
    prefs.value.weightedTeamWr = v;
    persist({ ...prefs.value });
  }

  function setLiveRosterCompact(v: boolean) {
    prefs.value.liveRosterCompact = v;
    persist({ ...prefs.value });
  }

  function setPostbattleRosterFull(v: boolean) {
    prefs.value.postbattleRosterFull = v;
    persist({ ...prefs.value });
  }

  function setTeamIntelEnabled(v: boolean) {
    prefs.value.teamIntelEnabled = v;
    persist({ ...prefs.value });
  }

  function setSealDisabled(kind: StampKind, disabled: boolean) {
    const next: SealDisableMap = { ...prefs.value.sealDisabled };
    if (disabled) next[kind] = true;
    else delete next[kind];
    prefs.value.sealDisabled = next;
    persist({ ...prefs.value });
  }

  function setOverlayChip<K extends keyof OverlayChipToggles>(
    key: K,
    v: boolean,
  ) {
    prefs.value.overlayChips = { ...prefs.value.overlayChips, [key]: v };
    persist({ ...prefs.value });
  }

  function setOverlayStatsMode(v: RosterStatsMode) {
    prefs.value.overlayStatsMode = v;
    persist({ ...prefs.value });
  }

  function setOverlayIntel<K extends keyof OverlayIntelToggles>(key: K, v: boolean) {
    prefs.value.overlayIntel = { ...prefs.value.overlayIntel, [key]: v };
    persist({ ...prefs.value });
  }

  function setOverlayTeamAvg<K extends keyof OverlayTeamAvgToggles>(
    key: K,
    v: boolean,
  ) {
    prefs.value.overlayTeamAvg = { ...prefs.value.overlayTeamAvg, [key]: v };
    persist({ ...prefs.value });
  }

  return {
    prefs,
    setPrEnabled,
    setPrAlgo,
    setSealsEnabled,
    setLocalizedTiers,
    setWeightedTeamWr,
    setLiveRosterCompact,
    setPostbattleRosterFull,
    setTeamIntelEnabled,
    setSealDisabled,
    setOverlayChip,
    setOverlayStatsMode,
    setOverlayIntel,
    setOverlayTeamAvg,
  };
});
