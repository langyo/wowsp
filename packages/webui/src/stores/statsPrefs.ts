import { defineStore } from "pinia";
import { ref } from "vue";

import { notifySettingsSaved } from "@/stores/settingsSavedFlash";
import { emitTauriEvent } from "@/utils/appEvents";
import type { StampKind } from "@/utils/winrate";

/** Which backend formula produces the `pr` field: ApeRadar's weighted
 *  winrate (the shipped behavior) or wows-numbers expected values. */
export type PrAlgo = "winrate" | "expected";

/** Per-seal kill switches, keyed by StampKind. Absent/false = the seal
 *  shows; true = that one seal never renders, on any surface. A Partial
 *  on purpose: seals the user never touched carry no entry at all, so the
 *  blob stays small and new kinds default to visible. */
export type SealDisableMap = Partial<Record<StampKind, boolean>>;

/** Which SHIPS a roster column's numbers cover — the per-column half of
 *  the retired three-dimension stats source (the battle dimension stays
 *  panel-wide, see `RosterBattleScope`): the whole account career
 *  ("global"), the solo-queue split ("solo"), exactly the row's current
 *  ship ("ship" — each row reads the player's stats on the ship they are
 *  sailing in this battle), or every ship of that ship's type ("class" —
 *  仅当前舰种). */
export type OverlayColumnScope = "global" | "solo" | "ship" | "class";

/** Which number a roster column shows. */
export type OverlayColumnMetric = "winrate" | "pr" | "battles" | "damage";

/** One configured roster column: a scope × metric pair. The column LIST
 *  (order included) is the persisted state — every roster surface (live
 *  panel, post-battle panels, Tab overlay chips, share shots) renders
 *  exactly these columns, left to right, up to OVERLAY_COLUMN_LIMIT of
 *  them. */
export interface OverlayColumn {
  scope: OverlayColumnScope;
  metric: OverlayColumnMetric;
}

export const OVERLAY_COLUMN_LIMIT = 5;

/** True when the column list IS the shipped default (the four global
 *  career columns) — the surfaces' "customized" faces (the live head's
 *  stats-source chip) key off this. */
export function overlayColumnsAreDefault(
  cols: readonly OverlayColumn[],
): boolean {
  const d = DEFAULT_STATS_PREFS.overlayColumns;
  if (cols.length !== d.length) return false;
  return d.every(
    (c, i) => cols[i]?.scope === c.scope && cols[i]?.metric === c.metric,
  );
}

/** Which battle-type career the columns read — the one remaining
 *  panel-wide stats-source dimension: "follow" tracks the current battle
 *  (ranked battles read the ranked career, everything else randoms), the
 *  fixed scopes pin randoms / ranked, and "all" is the global merge of
 *  the two. */
export type RosterBattleScope = "follow" | "random" | "ranked" | "all";

/** The ship dimension of the VIEW layer's dims (see utils/statView):
 *  "all" reads the account careers; "class" / "tier" / "ship" aggregate
 *  the player's per-ship list. The settings UI no longer exposes this
 *  directly — the per-column scopes map onto it. */
export type RosterShipScope = "all" | "class" | "tier" | "ship";

/** The solo dimension of the VIEW layer's dims: "all" keeps every queue,
 *  "solo" restricts the randoms side to the solo split. */
export type RosterSoloScope = "all" | "solo";

/** The retired pre-split single enum ("跟随对局/随机/排位/全局") — still
 *  read as a MIGRATION SEED so a blob last written by an older build maps
 *  onto the three-dimension model instead of resetting to defaults. */
export type LegacyRosterStatsMode = "auto" | "random" | "ranked" | "global";

/** Old blob value → battle dimension ("auto" WAS "follow the battle"). */
export function legacyBattleScopeOf(v: unknown): RosterBattleScope | null {
  if (v === "auto") return "follow";
  if (v === "random" || v === "ranked") return v;
  if (v === "global") return "all";
  return null;
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
  /** 神了/猴/蛆 verdict seals (AND-composed with RatingStamp's own
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
  /** Live-roster rows washed with the player's PR-tier color (a translucent
   *  background tint — red band red, purple band purple). Applies to both
   *  the full cards and the compact rows, over the row's resolved
   *  stats-source PR; AND-composed with `prEnabled`. */
  liveRosterPrTint: boolean;
  /** Post-battle roster rows expanded to a full-card look in the live
   *  panel's spirit (name/ship/stat stack + ship-meta strip + career seal +
   *  XP column; the live panel's own cards carry their stat line as a
   *  full-width bottom strip instead). Compact rows stay the default. */
  postbattleRosterFull: boolean;
  /** The Tab overlay's team-averages line under each side (mean winrate /
   *  mean PR / mean damage, one line, all-or-nothing). Ships off — the
   *  roster is dense already. The consumable-intel line above it (radar /
   *  hydro / smoke + the longest radar range) renders unconditionally and
   *  has no switch. */
  teamAvgEnabled: boolean;
  /** Per-seal visibility toggles (settings' seal customizer). */
  sealDisabled: SealDisableMap;
  /** The ordered roster columns every water-table surface renders (scope
   *  × metric pairs, left to right, at most OVERLAY_COLUMN_LIMIT). An
   *  empty list means no stat numbers at all — only the seal stamps (and
   *  the panels' battle-local XP column) remain. */
  overlayColumns: OverlayColumn[];
  /** Stats-source battle-type scope — the panel-wide dimension every
   *  column reads (see `RosterBattleScope`). */
  overlayBattleScope: RosterBattleScope;
}

export const STATS_PREFS_STORAGE_KEY = "wowsp-stats-prefs";

/** The canonical seal kinds — mirrored here (type-only import above) so
 *  parsePrefs can drop junk keys from a hand-edited blob. The veteran
 *  tiers (空中奶龙 / 水下奶蛙) and the merged kinds (空中神人 / 水下神人 /
 *  空中小猴 / 水下小猴) are first-class switches like the rest. */
const STAMP_KINDS = [
  "miracle",
  "ape",
  "maggot",
  "rat",
  "air",
  "sub",
  "airVeteran",
  "subVeteran",
  "airMiracle",
  "subMiracle",
  "airApe",
  "subApe",
] as const;

export const DEFAULT_STATS_PREFS: StatsPrefs = {
  prEnabled: true,
  prAlgo: "winrate",
  sealsEnabled: true,
  localizedTiers: true,
  weightedTeamWr: true,
  liveRosterCompact: false,
  liveRosterPrTint: true,
  postbattleRosterFull: false,
  teamAvgEnabled: false,
  sealDisabled: {},
  // The four shipped columns — global career winrate / PR / battles /
  // avg damage, left to right — exactly what the retired chip toggles
  // defaulted to (each still individually removable / reorderable /
  // re-scopable in the settings' column editor).
  overlayColumns: [
    { scope: "global", metric: "winrate" },
    { scope: "global", metric: "pr" },
    { scope: "global", metric: "battles" },
    { scope: "global", metric: "damage" },
  ],
  overlayBattleScope: "follow",
};

function isPrAlgo(v: unknown): v is PrAlgo {
  return v === "winrate" || v === "expected";
}

function isRosterBattleScope(v: unknown): v is RosterBattleScope {
  return v === "follow" || v === "random" || v === "ranked" || v === "all";
}

function isOverlayColumnScope(v: unknown): v is OverlayColumnScope {
  return v === "global" || v === "solo" || v === "ship" || v === "class";
}

function isOverlayColumnMetric(v: unknown): v is OverlayColumnMetric {
  return v === "winrate" || v === "pr" || v === "battles" || v === "damage";
}

/** The retired chip toggles, as last written by a pre-columns build —
 *  read off the raw blob only, as a migration seed. */
export interface LegacyOverlayChips {
  winrate: boolean;
  pr: boolean;
  battles: boolean;
  damage: boolean;
}

/** Validate a raw overlayColumns value: entries of a wrong shape drop
 *  out, duplicates keep their first occurrence, the list caps at
 *  OVERLAY_COLUMN_LIMIT — a hand-edited blob can never smuggle in junk
 *  or an oversized roster. */
export function parseOverlayColumns(raw: unknown): OverlayColumn[] {
  if (!Array.isArray(raw)) return [];
  const out: OverlayColumn[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (entry == null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (!isOverlayColumnScope(e.scope) || !isOverlayColumnMetric(e.metric)) continue;
    const key = `${e.scope}:${e.metric}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ scope: e.scope, metric: e.metric });
    if (out.length >= OVERLAY_COLUMN_LIMIT) break;
  }
  return out;
}

/** Column-scope seed off the retired ship/solo dimensions: a blob last
 *  written by a pre-columns build mapped its whole roster onto one scope,
 *  so every chip it had on becomes a column of that scope. "tier" has no
 *  column scope and falls back to the account career ("global"). */
function legacyColumnScopeOf(
  ship: unknown,
  solo: unknown,
): OverlayColumnScope {
  if (solo === "solo") return "solo";
  if (ship === "ship") return "ship";
  if (ship === "class") return "class";
  return "global";
}

/** The chips (+ ship/solo dims) a pre-columns blob carried → the column
 *  list preserving its intent: enabled chips become columns of the mapped
 *  scope, in the render order that build used (winrate → PR → battles →
 *  avg damage). Shared by the store's parsePrefs AND the overlay
 *  window's readOverlayDisplayPrefs so the two migrations agree even
 *  before the main window's heal-write lands. */
export function legacyColumnsSeed(
  chips: LegacyOverlayChips,
  ship: unknown,
  solo: unknown,
): OverlayColumn[] {
  const scope = legacyColumnScopeOf(ship, solo);
  const out: OverlayColumn[] = [];
  if (chips.winrate) out.push({ scope, metric: "winrate" });
  if (chips.pr) out.push({ scope, metric: "pr" });
  if (chips.battles) out.push({ scope, metric: "battles" });
  if (chips.damage) out.push({ scope, metric: "damage" });
  return out;
}

/** Read the retired chip toggles off a raw blob (migration seed only). */
export function legacyChipsOf(raw: unknown): LegacyOverlayChips {
  const out: LegacyOverlayChips = { winrate: false, pr: false, battles: false, damage: false };
  if (raw == null || typeof raw !== "object") return out;
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(out) as Array<keyof LegacyOverlayChips>) {
    if (typeof src[key] === "boolean") out[key] = src[key] as boolean;
  }
  return out;
}

/** The retired per-item team-average toggles (winrate / pr / damage), as
 *  last written by a pre-`teamAvgEnabled` build — read off the raw blob
 *  only, as a migration seed: ANY of the three booleans on means the user
 *  had averages showing, and keeps them on under the single switch. */
export function legacyTeamAvgEnabledOf(raw: unknown): boolean {
  if (raw == null || typeof raw !== "object") return false;
  const src = raw as Record<string, unknown>;
  return src.winrate === true || src.pr === true || src.damage === true;
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
    // `overlayStatsMode` (the pre-split battle enum), the chips/ship/solo
    // trio (pre-columns) and `overlayTeamAvg` (the retired per-item
    // team-average toggles) are RETIRED keys — kept on the raw shape only,
    // as migration seeds (see the columns / teamAvgEnabled parses below).
    const j = JSON.parse(raw) as Partial<StatsPrefs> & {
      avgStatsEnabled?: unknown;
      overlayStatsMode?: unknown;
      overlayChips?: unknown;
      overlayShipScope?: unknown;
      overlaySoloScope?: unknown;
      overlayTeamAvg?: unknown;
    };
    if (j == null || typeof j !== "object") return null;
    // Migration: the old single "per-row avg stats" switch seeds the
    // columns the first time a pre-overlayChips blob is read — its
    // spirit was "show the stat numbers", so it seeds the whole shipped
    // set (all four on).
    const legacyAvg =
      typeof j.avgStatsEnabled === "boolean" ? j.avgStatsEnabled : null;
    const seededChips: LegacyOverlayChips =
      legacyAvg == null
        ? { winrate: true, pr: true, battles: true, damage: true }
        : {
            winrate: legacyAvg,
            pr: legacyAvg,
            battles: legacyAvg,
            damage: legacyAvg,
          };
    // Columns: the stored list when this build (or a newer one) wrote
    // it; otherwise the retired chips + ship/solo dims seed it — every
    // enabled chip becomes a column of the scope those dims mapped onto.
    const hasColumns = Array.isArray(j.overlayColumns);
    const overlayColumns = hasColumns
      ? parseOverlayColumns(j.overlayColumns)
      : legacyColumnsSeed(
          j.overlayChips == null ? seededChips : legacyChipsOf(j.overlayChips),
          j.overlayShipScope,
          j.overlaySoloScope,
        );
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
      liveRosterPrTint:
        typeof j.liveRosterPrTint === "boolean"
          ? j.liveRosterPrTint
          : DEFAULT_STATS_PREFS.liveRosterPrTint,
      postbattleRosterFull:
        typeof j.postbattleRosterFull === "boolean"
          ? j.postbattleRosterFull
          : DEFAULT_STATS_PREFS.postbattleRosterFull,
      // Migration: a blob written before the single-switch simplification
      // carries only the retired `overlayTeamAvg` per-item toggles — any
      // of them on seeds the whole line on; the healed rewrite then drops
      // the legacy key for good.
      teamAvgEnabled:
        typeof j.teamAvgEnabled === "boolean"
          ? j.teamAvgEnabled
          : legacyTeamAvgEnabledOf(j.overlayTeamAvg),
      sealDisabled: parseSealDisabled(j.sealDisabled),
      overlayColumns,
      // Migration: a blob written before the battle-dimension split only
      // carries the retired `overlayStatsMode` enum — it seeds the battle
      // dimension; the healed rewrite then drops the legacy key for good.
      overlayBattleScope:
        isRosterBattleScope(j.overlayBattleScope)
          ? j.overlayBattleScope
          : legacyBattleScopeOf(j.overlayStatsMode) ??
            DEFAULT_STATS_PREFS.overlayBattleScope,
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

/** The Tab overlay re-reads the prefs blob when the main window's store
 *  writes it: the windows share this localStorage but not the Pinia state,
 *  so the broadcast is the only live channel between them (overlay/main.ts
 *  listens for exactly this event and re-reads via readOverlayDisplayPrefs). */
const STATS_PREFS_CHANGED_EVENT = "wowsp://stats-prefs-changed";

/** Returns whether the write landed — the store's save() flashes the
 *  title-bar Saved chip only on a real persist (a throwing storage keeps
 *  the choice session-only and stays silent, see readStored). */
function persist(p: StatsPrefs): boolean {
  try {
    localStorage.setItem(STATS_PREFS_STORAGE_KEY, JSON.stringify(p));
    // Broadcast only after a successful write: the overlay re-reads the
    // blob off localStorage, so announcing a write that threw would show
    // it a stale blob as if it were current.
    emitTauriEvent(STATS_PREFS_CHANGED_EVENT);
    return true;
  } catch {
    // see readStored
    return false;
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

/** First-run seed path (the onboarding wizard's PR default): apply a
 *  partial patch and persist WITHOUT the Saved flash — a seeded default is
 *  not a user edit, and the wizard fires it before the user has touched
 *  anything. */
export function seedStatsPrefs(patch: Partial<StatsPrefs>): void {
  Object.assign(statsPrefsState.value, patch);
  persist({ ...statsPrefsState.value });
}

export const useStatsPrefsStore = defineStore("statsPrefs", () => {
  /** Shared with the module-level ref — the store is the (only) write API,
   *  persisting on every mutation. */
  const prefs = statsPrefsState;

  /** The user-action write path: persist + flash the title-bar Saved chip
   *  on success. Boot-time heal-writes (loadStatsPrefs) call persist()
   *  directly and stay silent — the chip belongs to real edits only. */
  function save() {
    if (persist({ ...prefs.value })) notifySettingsSaved();
  }

  function setPrEnabled(v: boolean) {
    prefs.value.prEnabled = v;
    save();
  }

  function setPrAlgo(v: PrAlgo) {
    prefs.value.prAlgo = v;
    save();
  }

  function setSealsEnabled(v: boolean) {
    prefs.value.sealsEnabled = v;
    save();
  }

  function setLocalizedTiers(v: boolean) {
    prefs.value.localizedTiers = v;
    save();
  }

  function setWeightedTeamWr(v: boolean) {
    prefs.value.weightedTeamWr = v;
    save();
  }

  function setLiveRosterCompact(v: boolean) {
    prefs.value.liveRosterCompact = v;
    save();
  }

  function setLiveRosterPrTint(v: boolean) {
    prefs.value.liveRosterPrTint = v;
    save();
  }

  function setPostbattleRosterFull(v: boolean) {
    prefs.value.postbattleRosterFull = v;
    save();
  }

  function setTeamAvgEnabled(v: boolean) {
    prefs.value.teamAvgEnabled = v;
    save();
  }

  function setSealDisabled(kind: StampKind, disabled: boolean) {
    const next: SealDisableMap = { ...prefs.value.sealDisabled };
    if (disabled) next[kind] = true;
    else delete next[kind];
    prefs.value.sealDisabled = next;
    save();
  }

  /** The one write path for the column list — add / remove / reorder all
   *  land here, revalidated so a buggy caller can never exceed the limit
   *  or duplicate a scope×metric pair. */
  function setOverlayColumns(cols: OverlayColumn[]) {
    const next = parseOverlayColumns(cols);
    if (next.length === cols.length) {
      prefs.value.overlayColumns = next;
      save();
    }
    // A rejected write (dup / over-limit) silently no-ops: the editor UI
    // prevents those states, so this is only the hand-edited-blob guard.
  }

  function setOverlayBattleScope(v: RosterBattleScope) {
    prefs.value.overlayBattleScope = v;
    save();
  }

  return {
    prefs,
    setPrEnabled,
    setPrAlgo,
    setSealsEnabled,
    setLocalizedTiers,
    setWeightedTeamWr,
    setLiveRosterCompact,
    setLiveRosterPrTint,
    setPostbattleRosterFull,
    setTeamAvgEnabled,
    setSealDisabled,
    setOverlayColumns,
    setOverlayBattleScope,
  };
});
