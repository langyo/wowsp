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

/** Water-table display preferences. Persisted as one JSON blob so the four
 *  knobs always travel together (the onboarding wizard and the settings
 *  section write the same object). */
export interface StatsPrefs {
  /** Master switch for every PR rating surface (account card hero, per-ship
   *  panel, live roster lines, clan card). Winrate coloring never depends
   *  on this. Defaults OFF — the rating is opt-in. */
  prEnabled: boolean;
  /** Rating algorithm forwarded to the stats RPCs when `prEnabled`. */
  prAlgo: PrAlgo;
  /** 神了/海猴/蛆 verdict seals (AND-composed with RatingStamp's own
   *  zh-locale gate — the bitmaps stay Chinese-only). */
  sealsEnabled: boolean;
  /** Fun localized tier wording (夯/人上人/战舰仙人…) vs the standard
   *  English band words (Bad…Unicum). */
  localizedTiers: boolean;
  /** Per-seal visibility toggles (settings' seal customizer). */
  sealDisabled: SealDisableMap;
}

export const STATS_PREFS_STORAGE_KEY = "wowsp-stats-prefs";

/** The canonical seal kinds — mirrored here (type-only import above) so
 *  parsePrefs can drop junk keys from a hand-edited blob. */
const STAMP_KINDS = ["miracle", "ape", "maggot", "rat", "air", "sub"] as const;

export const DEFAULT_STATS_PREFS: StatsPrefs = {
  prEnabled: false,
  prAlgo: "winrate",
  sealsEnabled: true,
  localizedTiers: true,
  sealDisabled: {},
};

function isPrAlgo(v: unknown): v is PrAlgo {
  return v === "winrate" || v === "expected";
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
    const j = JSON.parse(raw) as Partial<StatsPrefs>;
    if (j == null || typeof j !== "object") return null;
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
      sealDisabled: parseSealDisabled(j.sealDisabled),
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
  // reset to defaults) is rewritten so what's on disk is what's in effect.
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

  function setSealDisabled(kind: StampKind, disabled: boolean) {
    const next: SealDisableMap = { ...prefs.value.sealDisabled };
    if (disabled) next[kind] = true;
    else delete next[kind];
    prefs.value.sealDisabled = next;
    persist({ ...prefs.value });
  }

  return {
    prefs,
    setPrEnabled,
    setPrAlgo,
    setSealsEnabled,
    setLocalizedTiers,
    setSealDisabled,
  };
});
