import { defineStore } from "pinia";
import { ref } from "vue";

/** Which backend formula produces the `pr` field: ApeRadar's weighted
 *  winrate (the shipped behavior) or wows-numbers expected values. */
export type PrAlgo = "winrate" | "expected";

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
}

export const STATS_PREFS_STORAGE_KEY = "wowsp-stats-prefs";

export const DEFAULT_STATS_PREFS: StatsPrefs = {
  prEnabled: false,
  prAlgo: "winrate",
  sealsEnabled: true,
  localizedTiers: true,
};

function isPrAlgo(v: unknown): v is PrAlgo {
  return v === "winrate" || v === "expected";
}

/** Validate a raw JSON blob into prefs. Corrupt/wrong-shaped input returns
 *  null so the caller falls back to defaults wholesale — a half-merged
 *  object would silently mix stored and default knobs. */
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
  return parsePrefs(readStored()) ?? { ...DEFAULT_STATS_PREFS };
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

  return { prefs, setPrEnabled, setPrAlgo, setSealsEnabled, setLocalizedTiers };
});
