/**
 * Post-battle panel: the two-column result matrix shown by the replay
 * "结果" modal (mounted by ReplayView once the replay carries its
 * BattleResults payload; the live view reads its own roster straight from
 * the arena store instead). Rows sort by
 * settlement base exp (裸经验 — bots report 0, legacy short arrays fall back
 * to an estimate) and carry the same roster dressing as the live-battle
 * panel: clan tags, PR column, career seals, team aggregates in the column
 * titles and the battle mode/map head. Rows default to the compact one-line
 * look; the share bar's mode toggle expands them to full cards in the live
 * panel's spirit (name/ship/stat stack + the LiveShipMeta ship strip — the
 * live panel's own cards carry their stat line as a full-width bottom strip
 * instead), a persisted stats pref. The share bar also leads with the
 * stats-source chip — the
 * identical selector the live panel's head mounts (one shared statsPrefs
 * store; a flip re-resolves these rows immediately).
 *
 * Share-time privacy: nicknames can be masked wholesale or per player (the
 * row-end eye), and "复制截图" paints the matrix into a watermarked PNG on
 * the clipboard — see postBattleShare.tsx / postBattleShot.ts. The share
 * model is built from the masked display strings, so a hidden nick cannot
 * leak into the image.
 *
 * Clicking a player opens a second-level modal with the match result +
 * on-demand global stats (title bar chip while loading) and a jump link
 * into the lookup screen. The whole row — career seal included — is the
 * click target; only the per-row mask eye sits outside it.
 */
import {
  computed,
  defineComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type CSSProperties,
  type VNode,
} from "vue";
import { useRouter } from "vue-router";
import { Eye, EyeOff, X } from "@lucide/vue";
import { HkSpinner } from "@celestia-island/hikari";

import { api, type PlayerStats } from "@/api";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import BattleIcon from "@/components/base/BattleIcon";
import { AssetImage } from "@/components/base/AssetImage";
import RatingStamp from "@/components/base/RatingStamp";
import StatsCard from "@/components/stats/StatsCard";
import ShipDistCharts, { type DistDatum } from "@/components/stats/ShipDistCharts";
import { shipNameFromOfflineDb, shipOfflineEntry } from "@/features/holographic/modelLoader";
import { bundledRibbonUrl } from "@/features/holographic/ribbonIcons";
import ribbonNamesRaw from "@/data/ribbon_names.json";
import { useLoadingTasksStore } from "@/stores/loadingTasks";
import { prAlgoForRequest, statsPrefsState, useStatsPrefsStore } from "@/stores/statsPrefs";
import { careerStamp, damageColor, prTier, winrateColor, type CareerStamp } from "@/utils/winrate";
import { formatEta } from "@/utils/format";
import { aggregateTeamStats } from "@/utils/teamAggregate";
import { shipTierOf } from "@/utils/shipClass";
import { isScriptedUnitName } from "@/utils/aiNames";
import { isListedPlayer } from "@/utils/rosterSides";
import { modeColor, modeKey } from "@/utils/modeColors";
import { displayMapName } from "@/utils/mapNames";
import {
  AI_NAME,
  fetchRosterStatsByNames,
  isAiName,
  type RosterStat,
} from "@/composables/useRosterStats";
import { parsePostBattle, type PostBattleRibbon } from "./postBattle";
import LiveShipMeta from "./LiveShipMeta";
import {
  PostBattleShareBar,
  rosterColumns,
  rosterShotCells,
  rosterShotColIndex,
  rosterShotDashes,
  rosterStatCols,
  rosterStatLine,
  useNickMasking,
  useShareShot,
} from "./postBattleShare";
import {
  dimsNeedShipStats,
  resolveRosterBattleScope,
  rosterDimsOf,
  type ResolvedStatsMode,
} from "@/utils/statView";
import { scopedRosterView } from "@/utils/shipStatsScope";
import type { ShotColumn, ShotModel, ShotRow, ShotStat } from "./postBattleShot";
import "./PostBattlePanel.scss";

const ribbonNames = ribbonNamesRaw as Record<string, Partial<Record<string, string>>>;

/** Battle identity pills for the panel head — the same layered mode identity
 *  the live panel reads off tempArenaInfo (replay context: the replay's
 *  arena header; live context: the retained arena store). */
export interface PostBattleHead {
  matchGroup?: string | null;
  scenario?: string | null;
  eventType?: string | null;
  botCount?: number | null;
  scriptedUnitCount?: number | null;
  mapName?: string | null;
  /** Share-shot provenance (the header's meta line, see shotMetaLine):
   *  server realm code, client version (dotted), the formatted battle
   *  start stamp and the match duration in seconds. All optional —
   *  absent parts drop out of the line. */
  realm?: string | null;
  gameVersion?: string | null;
  battleTime?: string | null;
  durationSec?: number | null;
}

/** Localize a battle mode from its layered identity (same helper shape the
 *  live panel and ReplayView carry). */
function modeLabelOf(
  group?: string | null,
  scenario?: string | null,
  eventType?: string | null,
  botCount = 0,
  scriptedUnitCount = 0,
): string {
  const key = modeKey(group, scenario, eventType, botCount, scriptedUnitCount);
  if (!key) return t("replay.mode._fallback");
  const i18nKey = `replay.mode.${key}`;
  const lbl = t(i18nKey);
  return lbl === i18nKey ? t("replay.mode._fallback") : lbl;
}

/** The share shot's provenance line — server · game version · battle time ·
 *  duration — composed from the head's optional fields; absent parts drop
 *  out and an all-absent head yields null (no line at all). */
export function shotMetaLine(head: PostBattleHead | null): string | null {
  if (!head) return null;
  const parts: string[] = [];
  if (head.realm) {
    const key = `replay.realm.${head.realm}`;
    const lbl = t(key);
    if (lbl !== key) parts.push(lbl);
  }
  if (head.gameVersion) parts.push(head.gameVersion);
  if (head.battleTime) parts.push(head.battleTime);
  if (head.durationSec != null && head.durationSec > 0) {
    parts.push(`${t("replay.duration")} ${formatEta(head.durationSec)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export default defineComponent({
  name: "PostBattlePanel",
  props: {
    raw: { type: String, required: true },
    /** Battle identity for the head pills (mode + map); null renders no
     *  head row (the replay modal's own title carries the context). */
    head: {
      type: Object as () => PostBattleHead | null,
      default: null,
    },
    /** Operation battle (行动): the roster renders as ONE full-width allies
     *  column, matching the live panel / fallback panel. */
    operation: { type: Boolean, default: false },
  },
  emits: ["close"],
  setup(props, { emit }) {
    const parsed = computed(() => parsePostBattle(props.raw));
    const { dataLanguage, uiLocale } = useLanguage();
    const loadingTasks = useLoadingTasksStore();
    const router = useRouter();
    const root = ref<HTMLElement | null>(null);
    const rows = computed(() => {
      const pb = parsed.value;
      if (!pb) return [];
      // Killer attribution reads the FULL player map (the scripted NPCs sit
      // out the rows, but they still sink ships): a scripted killer shows
      // its ship name — the raw `IDS_*` text key is not a readable name.
      const names = new Map(
        pb.players.map((p) => [
          p.accountId,
          isScriptedUnitName(p.name)
            ? (p.shipId != null
                ? shipNameFromOfflineDb(p.shipId, dataLanguage.value)
                : null) ?? p.name
            : p.name,
        ]),
      );
      // The results packet carries the story/operation scripted NPCs as
      // team members — they are not players and get no matrix row.
      return pb.players.filter(isListedPlayer).map((p) => ({
        ...p,
        shipName:
          (p.shipId != null ? shipNameFromOfflineDb(p.shipId, dataLanguage.value) : null) ??
          "",
        killerName: p.killerId != null ? names.get(p.killerId) ?? null : null,
        // Settlement XP: the real base exp streamed per player (bots carry
        // 0); falls back to a rough estimate for legacy short arrays only.
        xp: p.exp ?? Math.round(p.damage * 0.1 + p.frags * 250 + (p.alive ? 100 : 0)),
      }));
    });
    /** The recorder's own team. `playersPublicInfo[6]` is a 0/1 TEAM number
     *  (12 vs 12), NOT a 0=self/1=ally/2=enemy relation — the recorder's
     *  team is always the "allies" column. Falls back to team 0 when the
     *  recorder isn't in the player list (watching someone else's replay). */
    const selfTeam = computed(() => {
      const pb = parsed.value;
      if (!pb) return null;
      return pb.players.find((p) => p.accountId === pb.selfId)?.team ?? null;
    });
    const detailOpen = ref(false);
    const selected = ref<(typeof rows.value)[number] | null>(null);
    const globalStats = ref<PlayerStats | null>(null);
    const globalLoading = ref(false);
    const globalError = ref(false);
    /** Battles per tier (index 1..11, superships in the 11th bin) and per
     *  ship type — for spotting low-tier farmers / CV-SS specialists. */
    const shipDistList = ref<DistDatum[]>([]);

    /** Load the player's per-ship stats and aggregate tier/type distribution. */
    async function loadShipDist(p: (typeof rows.value)[number]) {
      shipDistList.value = [];
      if (!p.realm) return;
      try {
        const list = await api.lookupPlayerShipStats(p.accountId, p.realm, prAlgoForRequest());
        shipDistList.value = list.map((s) => ({ shipId: s.shipId, battles: s.battles }));
      } catch {
        /* distribution unavailable — hide */
      }
    }

    /** Roster WR / PR / avg-damage per player name for the matrix columns
     *  (one batched lookup on mount, warm-served from the shared roster-stats
     *  cache). Entries without a realm ride the roster's dominant one — a
     *  battle is single-realm in practice. */
    const nameStats = ref<Map<string, RosterStat>>(new Map());
    const nameStatsLoading = ref(false);
    async function loadNameStats() {
      const pb = parsed.value;
      if (!pb) return;
      const dominant = pb.players.find((p) => p.realm)?.realm ?? null;
      const byRealm = new Map<string, Set<string>>();
      for (const p of pb.players) {
        if (AI_NAME.test(p.name)) continue;
        const realm = p.realm ?? dominant;
        if (!realm) continue;
        const set = byRealm.get(realm) ?? new Set<string>();
        set.add(p.name);
        byRealm.set(realm, set);
      }
      if (byRealm.size === 0) return;
      nameStatsLoading.value = true;
      try {
        const maps = await Promise.all(
          [...byRealm].map(([realm, names]) =>
            fetchRosterStatsByNames([...names], realm),
          ),
        );
        const merged = new Map<string, RosterStat>();
        for (const m of maps) for (const [k, v] of m) merged.set(k, v);
        nameStats.value = merged;
      } finally {
        nameStatsLoading.value = false;
      }
    }
    // A hidden profile's 过街老鼠 seal is held while its clan verdict is out,
    // but the one-shot stats map is not reactive to the roster cache's async
    // verdict writeback — nudge one re-render shortly after the load when any
    // verdict is still pending.
    let verdictTimer: ReturnType<typeof setTimeout> | null = null;
    onMounted(() => {
      void loadNameStats().then(() => {
        const pending = [...nameStats.value.values()].some(
          (st) => st.hidden && st.clanId != null && st.clanWinrate === undefined,
        );
        if (pending) {
          verdictTimer = setTimeout(() => {
            verdictTimer = null;
            nameStats.value = new Map(nameStats.value);
          }, 2000);
        }
      });
    });
    onBeforeUnmount(() => {
      if (verdictTimer) clearTimeout(verdictTimer);
    });

    /** Roster order: final settlement XP descending — the order the game's
     *  own results screen shows (top earner first), so the matrix reads as
     *  a scoreboard. Legacy short arrays ride the damage/frags estimate. */
    const allies = computed(() => {
      const st = selfTeam.value;
      return rows.value
        .filter((p) => (st != null ? p.team === st : p.team !== 1))
        .sort((a, b) => b.xp - a.xp);
    });
    const enemies = computed(() => {
      const st = selfTeam.value;
      return rows.value
        .filter((p) => p.team !== null && (st != null ? p.team !== st : p.team === 1))
        .sort((a, b) => b.xp - a.xp);
    });

    const prefs = computed(() => statsPrefsState.value);
    /** Seals ride the PR cluster in the settings (the master toggle nests
     *  under it) and need PR data to grade — one gate for the DOM slot,
     *  the header pad and the share shot alike. */
    const sealsShown = computed(() => prefs.value.prEnabled && prefs.value.sealsEnabled);

    /** Roster density: compact rows (the default) or the live panel's full
     *  cards — a persisted stats pref, flipped from the share bar's mode
     *  toggle (PostBattleShareBar). */
    const statsPrefs = useStatsPrefsStore();
    const fullMode = computed(() => prefs.value.postbattleRosterFull);
    const toggleFullMode = () =>
      statsPrefs.setPostbattleRosterFull(!fullMode.value);

    /** The stats-source dimensions (ship scope / battle scope / solo
     *  filter — the persisted pref the settings and the live head's mode
     *  tag both write) resolved against the replayed battle's identity
     *  ("follow": ranked → ranked careers). Rows read them through
     *  `rowViewOf`, which aggregates the per-ship lists the one-shot
     *  pipeline attaches while a ship-scoped dimension is on. */
    const statsDims = computed(() => rosterDimsOf(prefs.value));
    const battleScope = computed<ResolvedStatsMode>(() =>
      resolveRosterBattleScope(statsDims.value.battle, props.head ?? {}),
    );
    const shipScopeOn = computed(() => dimsNeedShipStats(statsDims.value));
    const rowViewOf = (st: RosterStat | null | undefined, shipId: number | null) =>
      scopedRosterView(
        st,
        shipId,
        statsDims.value,
        battleScope.value,
        prAlgoForRequest() ?? "winrate",
      );
    // Flipping the stats-source dimensions (or the PR algorithm) after the
    // one-shot load re-runs it: fetchRosterStatsByNames only attaches the
    // per-ship lists the dims in force AT LOAD TIME requested, and without
    // this the rows would sit on silent dashes instead of re-resolving
    // (the live panel gets the same flip for free from its composable
    // watch).
    watch(
      () => [dimsNeedShipStats(statsDims.value), prAlgoForRequest()] as const,
      ([need]) => {
        if (need) void loadNameStats();
      },
    );

    /** One team's header aggregate — tier-weighted (per the stats prefs)
     *  mean winrate plus a plain mean PR over the players whose stats
     *  landed, all in the roster's resolved stats-source view. AI names,
     *  hidden profiles and stat misses sit out. */
    const teamAgg = (list: typeof rows.value) =>
      aggregateTeamStats(
        list.map((p) => {
          const st = !isAiName(p.name) ? nameStats.value.get(p.name) : undefined;
          if (!st || st.hidden || (shipScopeOn.value && st.shipsLoading)) {
            return { winrate: null, pr: null, damage: null, tier: p.shipId != null ? shipTierOf(p.shipId) : null };
          }
          const view = rowViewOf(st, p.shipId ?? null);
          return {
            winrate: view.winrate,
            pr: view.pr,
            damage: view.avgDamage,
            tier: p.shipId != null ? shipTierOf(p.shipId) : null,
          };
        }),
        prefs.value.weightedTeamWr,
      );

    /** Load the selected player's global stats on-demand (title bar chip
     *  while loading; the lookup API resolves by nickname + realm). Failures
     *  are silent — AI names and rate-limited lookups are common, and an
     *  error toast for every bot would be noise. */
    async function loadGlobal(p: (typeof rows.value)[number]) {
      globalStats.value = null;
      globalLoading.value = false;
      globalError.value = false;
      if (!p.realm || AI_NAME.test(p.name)) return;
      globalLoading.value = true;
      const tid = loadingTasks.begin(t("replay.postbattle.loadingGlobal", { name: p.name }));
      try {
        globalStats.value = await api.lookupPlayerStats(p.name, p.realm, prAlgoForRequest());
        loadingTasks.end(tid);
      } catch {
        loadingTasks.end(tid);
        globalError.value = true;
      } finally {
        globalLoading.value = false;
      }
    }

    function openDetail(p: (typeof rows.value)[number]) {
      selected.value = p;
      detailOpen.value = true;
      void loadGlobal(p);
      void loadShipDist(p);
    }

    /** Jump into the lookup screen for this player, closing the modal. */
    function jumpToLookup() {
      const p = selected.value;
      detailOpen.value = false;
      emit("close");
      if (p) {
        void router.push({ path: "/lookup", query: { name: p.name, realm: p.realm ?? "asia" } });
      }
    }

    // ── Share-time privacy + share shot ─────────────────────────────────
    const masking = useNickMasking();
    const shot = useShareShot(buildShotModel, () => root.value);
    /** The career seal a row carries into the share shot — the exact gate
     *  chain the DOM cells render (settings master switch, zh-only bitmaps,
     *  verdict-pending holds, per-kind kill switch), so a seal switched off
     *  in the settings never leaks into the copied image. */
    const shotStampOf = (name: string): CareerStamp | null => {
      if (!sealsShown.value || !uiLocale.value.startsWith("zh")) return null;
      const st = isAiName(name) ? undefined : nameStats.value.get(name);
      if (!st || st.loading) return null;
      if (st.hidden && st.clanId != null && st.clanWinrate === undefined) return null;
      const kind = careerStamp(st.pr, st.battles, st.winrate, st.hidden, st.clanWinrate);
      return kind && !prefs.value.sealDisabled[kind] ? kind : null;
    };
    function buildShotModel(): ShotModel {
      const pb = parsed.value;
      const head = props.head;
      const mode = head?.matchGroup
        ? (() => {
            const c = modeColor(
              head.matchGroup!,
              head.scenario,
              head.eventType,
              head.botCount ?? 0,
              head.scriptedUnitCount ?? 0,
            );
            return {
              label: modeLabelOf(
                head.matchGroup,
                head.scenario,
                head.eventType,
                head.botCount ?? 0,
                head.scriptedUnitCount ?? 0,
              ),
              color: c.color,
              background: c.background,
            };
          })()
        : null;
      /** One row's shot cells: the chip-gated columns of the roster's
       *  stats-source view (the exact columns the panel shows) plus the
       *  settlement XP — dashes for bots / misses. */
      const statTexts = (p: (typeof rows.value)[number]): ShotStat[] => {
        const ai = isAiName(p.name);
        const st = ai ? undefined : nameStats.value.get(p.name);
        const out: ShotStat[] = !st
          ? rosterShotDashes()
          : rosterShotCells(rowViewOf(st, p.shipId ?? null));
        out.push({ text: p.xp.toLocaleString() });
        return out;
      };
      const mkCol = (
        list: typeof rows.value,
        enemy: boolean,
      ): ShotColumn => {
        // Aggregate values carry their stat-column index so the shot's
        // header numbers right-align onto the cells below them.
        // The aggregate mirrors the panel's column title: each labeled
        // value follows its own chip toggle (PR additionally the rating
        // master) and right-aligns onto its column's origin.
        let agg: ShotColumn["agg"];
        {
          const parts: NonNullable<ShotColumn["agg"]> = [];
          const a = teamAgg(list);
          const chips = prefs.value.overlayChips;
          if (chips.winrate) {
            parts.push({
              col: rosterShotColIndex("winrate"),
              label: t(
                prefs.value.weightedTeamWr
                  ? "replay.roster.teamWrWeighted"
                  : "replay.roster.teamWrPlain",
              ),
              value: a.winrate != null ? `${a.winrate.toFixed(1)}%` : "—",
              valueColor: a.winrate != null ? winrateColor(a.winrate) : undefined,
            });
          }
          if (prefs.value.prEnabled && chips.pr) {
            parts.push({
              col: rosterShotColIndex("pr"),
              label: t("replay.roster.teamAvgPr"),
              value: a.avgPr != null ? `${Math.round(a.avgPr)}` : "—",
              valueColor: a.avgPr != null ? prTier(a.avgPr).color : undefined,
            });
          }
          if (chips.damage) {
            parts.push({
              col: rosterShotColIndex("damage"),
              label: t("replay.postbattle.avgDamage"),
              value: a.avgDamage != null ? Math.round(a.avgDamage).toLocaleString() : "—",
              valueColor: a.avgDamage != null ? damageColor(a.avgDamage) : undefined,
            });
          }
          agg = parts.length > 0 ? parts : undefined;
        }
        return {
          title: enemy ? t("replay.roster.enemies") : t("replay.roster.allies"),
          agg,
          rows: list.map((p): ShotRow => {
            return {
              nick: masking.maskOf(p.name),
              clanTag: nameStats.value.get(p.name)?.clanTag ?? null,
              shipName: p.shipName,
              bot: isAiName(p.name),
              dim: !p.alive,
              shipType: p.shipId != null ? shipOfflineEntry(p.shipId)?.type ?? null : null,
              iconVariant: !p.alive
                ? "sunk"
                : enemy
                  ? "enemy"
                  : p.accountId === pb?.selfId
                    ? "white"
                    : "ally",
              stamp: shotStampOf(p.name),
              stats: statTexts(p),
            };
          }),
        };
      };
      return {
        title: t("replay.results"),
        mode,
        mapLabel: head?.mapName
          ? displayMapName(head.mapName, dataLanguage.value)
          : null,
        metaLine: shotMetaLine(head),
        botLabel: t("replay.bot"),
        // Mirror the DOM's single-column rule: one column whenever there is
        // no enemy roster (operations AND any single-team payload edge).
        columns:
          props.operation || enemies.value.length === 0
            ? [mkCol(allies.value, false)]
            : [mkCol(allies.value, false), mkCol(enemies.value, true)],
      };
    }

    return () => {
      const pb = parsed.value;
      if (!pb) return <pre>{props.raw}</pre>;
      const st = selfTeam.value;
      const isEnemy = (p: (typeof rows.value)[number]) =>
        p.team !== null && (st != null ? p.team !== st : p.team === 1);
      const head = props.head;
      const colTitle = (label: string, list: typeof rows.value) => {
        const title = <span class="replay-view__postbattle-col-name">{label}</span>;
        const chips = prefs.value.overlayChips;
        // Each labeled aggregate value follows its own chip toggle (PR
        // additionally needs the rating master); bare title when nothing
        // is labeled.
        const showWr = chips.winrate;
        const showPr = prefs.value.prEnabled && chips.pr;
        const showDmg = chips.damage;
        if (!showWr && !showPr && !showDmg) {
          return <div class="replay-view__postbattle-col-title">{title}</div>;
        }
        const agg = teamAgg(list);
        const prBand = prTier(agg.avgPr);
        // Full cards carry no aligned stat columns under the title, so the
        // aggregate rides the title's right end as inline text — the live
        // panel's own column-title treatment.
        if (fullMode.value) {
          return (
            <div class="replay-view__postbattle-col-title">
              {title}
              <span class="replay-view__postbattle-col-aggtext">
                {showWr ? (
                  <>
                    {t(
                      prefs.value.weightedTeamWr
                        ? "replay.roster.teamWrWeighted"
                        : "replay.roster.teamWrPlain",
                    )}{" "}
                    <b
                      style={
                        agg.winrate != null
                          ? { color: winrateColor(agg.winrate) }
                          : undefined
                      }
                    >
                      {agg.winrate != null ? `${agg.winrate.toFixed(1)}%` : "—"}
                    </b>
                  </>
                ) : null}
                {showWr && (showPr || showDmg) ? " · " : null}
                {showPr ? (
                  <>
                    {t("replay.roster.teamAvgPr")}{" "}
                    <b
                      class={prBand.rainbow ? "rainbow-text" : undefined}
                      style={prBand.rainbow ? undefined : { color: prBand.color }}
                    >
                      {agg.avgPr != null ? Math.round(agg.avgPr) : "—"}
                    </b>
                  </>
                ) : null}
                {showPr && showDmg ? " · " : null}
                {showDmg ? (
                  <>
                    {t("replay.postbattle.avgDamage")}{" "}
                    <b
                      style={
                        agg.avgDamage != null
                          ? { color: damageColor(agg.avgDamage) }
                          : undefined
                      }
                    >
                      {agg.avgDamage != null
                        ? Math.round(agg.avgDamage).toLocaleString()
                        : "—"}
                    </b>
                  </>
                ) : null}
              </span>
            </div>
          );
        }
        // Compact rows: a two-line mini table header on a grid mirroring
        // the row columns (rosterColumns + the XP cell), so each aggregate
        // number lands exactly on its column. Battles and XP carry no
        // team aggregate — their header cells stay empty fills.
        const cols = rosterColumns();
        const template = `minmax(0, 1fr) ${cols.map((c) => c.width).join(" ")} 6ch`;
        const fill = <span class="replay-view__postbattle-col-hfill" />;
        const labelOf: Record<string, VNode | null> = {
          winrate: showWr ? (
            <span class="replay-view__postbattle-col-hlbl">
              {t(
                prefs.value.weightedTeamWr
                  ? "replay.roster.teamWrWeighted"
                  : "replay.roster.teamWrPlain",
              )}
            </span>
          ) : null,
          pr: showPr ? (
            <span class="replay-view__postbattle-col-hlbl">
              {t("replay.roster.teamAvgPr")}
            </span>
          ) : null,
          battles: null,
          damage: showDmg ? (
            <span class="replay-view__postbattle-col-hlbl">
              {t("replay.postbattle.avgDamage")}
            </span>
          ) : null,
        };
        const valueOf: Record<string, VNode | null> = {
          winrate: showWr ? (
            <b
              class="replay-view__postbattle-col-hval"
              style={agg.winrate != null ? { color: winrateColor(agg.winrate) } : undefined}
            >
              {agg.winrate != null ? `${agg.winrate.toFixed(1)}%` : "—"}
            </b>
          ) : null,
          pr: showPr ? (
            <b
              class="replay-view__postbattle-col-hval"
              style={{ color: prBand.color }}
            >
              {agg.avgPr != null ? Math.round(agg.avgPr) : "—"}
            </b>
          ) : null,
          battles: null,
          damage: showDmg ? (
            <b
              class="replay-view__postbattle-col-hval"
              style={agg.avgDamage != null ? { color: damageColor(agg.avgDamage) } : undefined}
            >
              {agg.avgDamage != null ? Math.round(agg.avgDamage).toLocaleString() : "—"}
            </b>
          ) : null,
        };
        return (
          <div
            class={[
              "replay-view__postbattle-col-title",
              "replay-view__postbattle-col-title--agg",
              // Right-edge compensation so the header grid sits over the
              // columns below: rows spend width on the mask eye (+ the
              // career seal slot when seals are enabled).
              sealsShown.value
                ? "replay-view__postbattle-col-title--pad-seal"
                : "replay-view__postbattle-col-title--pad-eye",
            ]}
            style={{ gridTemplateColumns: template }}
          >
            {title}
            {cols.map((c) => labelOf[c.key] ?? fill)}
            {fill}
            {cols.map((c) => valueOf[c.key] ?? fill)}
            {fill}
          </div>
        );
      };
      /** One row's display numbers per the roster's resolved stats source
       *  (the shared columns render them) — scoped per the row's own ship
       *  while a ship-scoped dimension is on. */
      const viewOf = (st: RosterStat, shipId: number | null) => rowViewOf(st, shipId);
      /** Career seal for one row — the same guard chain the live panel uses
       *  (verdict-pending hidden profiles hold their stamp). */
      const sealOf = (p: (typeof rows.value)[number]) => {
        const ai = isAiName(p.name);
        const stat = ai ? undefined : nameStats.value.get(p.name);
        const stamp =
          stat &&
          !stat.loading &&
          !(stat.hidden && stat.clanId != null && stat.clanWinrate === undefined)
            ? careerStamp(stat.pr, stat.battles, stat.winrate, stat.hidden, stat.clanWinrate)
            : null;
        return stamp && sealsShown.value ? (
          <RatingStamp
            kind={stamp}
            size={26}
            variant="mini"
            class="replay-view__postbattle-cell-stamp"
          />
        ) : null;
      };
      /** Per-row nickname-mask eye — a sibling AFTER the row button so it
       *  stays a real button (no nested buttons). */
      const eyeBtn = (name: string) => (
        <button
          class={[
            "replay-view__postbattle-cell-eye",
            { "replay-view__postbattle-cell-eye--on": masking.isHidden(name) },
          ]}
          type="button"
          data-hint={
            masking.isHidden(name)
              ? t("replay.postbattle.showName")
              : t("replay.postbattle.hideName")
          }
          aria-label={
            masking.isHidden(name)
              ? t("replay.postbattle.showName")
              : t("replay.postbattle.hideName")
          }
          onClick={() => masking.toggleOne(name)}
        >
          {masking.isHidden(name) ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
      );
      const cell = (p: (typeof allies.value)[number]) => {
        const enemy = !props.operation && isEnemy(p);
        const ai = isAiName(p.name);
        const stat = ai ? undefined : nameStats.value.get(p.name);
        return (
          <div
            class={[
              "replay-view__postbattle-cell",
              p.alive ? "" : "replay-view__postbattle-cell--dead",
              p.accountId === pb.selfId ? "replay-view__postbattle-cell--self" : "",
            ]}
            key={p.accountId}
          >
            {/* The whole row minus the eye is the drill-down button: hover
                and clicks cover the career seal too. */}
            <button
              class="replay-view__postbattle-cell-btn"
              type="button"
              onClick={() => openDetail(p)}
            >
              <span class="replay-view__postbattle-cell-ico">
                {p.shipId != null ? (
                  <BattleIcon
                    type={shipOfflineEntry(p.shipId)?.type ?? ""}
                    variant={
                      p.alive
                        ? enemy
                          ? "enemy"
                          : p.accountId === pb.selfId
                            ? "white"
                            : "ally"
                        : "sunk"
                    }
                    size={20}
                  />
                ) : null}
              </span>
              <span class="replay-view__postbattle-cell-main">
                <span class="replay-view__postbattle-cell-name">
                  <span class="replay-view__postbattle-cell-nick">
                    {masking.maskOf(p.name)}
                  </span>
                  {stat?.clanTag ? (
                    <span class="replay-view__postbattle-cell-clan">[{stat.clanTag}]</span>
                  ) : null}
                  {ai ? <em class="replay-view__postbattle-bot">{t("replay.bot")}</em> : null}
                </span>
                <span class="replay-view__postbattle-cell-sub">{p.shipName}</span>
              </span>
              {rosterStatCols(
                p.name,
                nameStats.value,
                nameStatsLoading.value ||
                  Boolean(shipScopeOn.value && nameStats.value.get(p.name)?.shipsLoading),
                (st) => viewOf(st, p.shipId ?? null),
              )}
              <span
                class="replay-view__postbattle-cell-xp"
                data-hint={t("replay.postbattle.xp")}
              >
                {p.xp.toLocaleString()}
              </span>
              {/* Career-seal slot: reserved whenever seals show at all (PR +
                  settings master), so the mask eyes align across rows whether
                  or not a given player earned a stamp. Living INSIDE the
                  button keeps the hover highlight and the click target on
                  the row's full width — the seal is part of the row, not an
                  ornament bolted past its hit area. */}
              {sealsShown.value ? (
                <span class="replay-view__postbattle-cell-stampslot">
                  {sealOf(p)}
                </span>
              ) : null}
            </button>
            {ai ? null : eyeBtn(p.name)}
          </div>
        );
      };
      /** Full-card row (the live panel's card look): name/ship/WR·PR text
       *  stack, the LiveShipMeta strip, then this panel's own avg-damage
       *  and XP numbers as aligned columns ahead of the career seal. Like
       *  the compact row, the whole card minus the eye is one button. */
      const fullCell = (p: (typeof allies.value)[number]) => {
        const enemy = !props.operation && isEnemy(p);
        const ai = isAiName(p.name);
        const stat = ai ? undefined : nameStats.value.get(p.name);
        const statLine = () => {
          if (ai) return "—";
          if (
            !stat ||
            nameStatsLoading.value ||
            (shipScopeOn.value && stat.shipsLoading)
          ) {
            return <HkSpinner size="xs" tone="current" />;
          }
          if (stat.hidden) {
            return (
              <span class="replay-view__postbattle-fcell-hidden">
                {t("replay.live.hiddenProfile")}
              </span>
            );
          }
          // The chips-enabled numbers of the resolved stats-source view —
          // the same shared text line the live panel's full cards render.
          const line = rosterStatLine(rowViewOf(stat, p.shipId ?? null));
          return line != null ? (
            <span class="replay-view__postbattle-fcell-statline">{line}</span>
          ) : (
            "—"
          );
        };
        const dmgView = stat ? rowViewOf(stat, p.shipId ?? null) : null;
        const dmgBody = ai ? (
          <em>—</em>
        ) : !stat ||
            nameStatsLoading.value ||
            (shipScopeOn.value && stat.shipsLoading) ? (
          <HkSpinner size="xs" tone="current" />
        ) : dmgView?.avgDamage == null ? (
          <em>—</em>
        ) : (
          <b style={{ color: damageColor(dmgView.avgDamage) }}>
            {Math.round(dmgView.avgDamage).toLocaleString()}
          </b>
        );
        return (
          <div
            class={[
              "replay-view__postbattle-fcell",
              p.alive ? "" : "replay-view__postbattle-fcell--dead",
              p.accountId === pb.selfId ? "replay-view__postbattle-fcell--self" : "",
            ]}
            key={p.accountId}
          >
            <button
              class="replay-view__postbattle-fcell-btn"
              type="button"
              onClick={() => openDetail(p)}
            >
              <span class="replay-view__postbattle-fcell-main">
                <span class="replay-view__postbattle-fcell-name">
                  <span class="replay-view__postbattle-fcell-nick">
                    {masking.maskOf(p.name)}
                  </span>
                  {stat?.clanTag ? (
                    <span class="replay-view__postbattle-fcell-clan">[{stat.clanTag}]</span>
                  ) : null}
                  {ai ? <em class="replay-view__postbattle-bot">{t("replay.bot")}</em> : null}
                </span>
                <span class="replay-view__postbattle-fcell-ship">{p.shipName}</span>
                <span class="replay-view__postbattle-fcell-stat">{statLine()}</span>
              </span>
              {/* Ship identity + parameters ride the card's middle ground
                  (ally rows get the consumable badges too); the host span
                  pins grid track 2, and a ship missing from the offline DBs
                  leaves the track reserved so nothing slides. */}
              <span class="replay-view__postbattle-fcell-meta">
                {p.shipId != null ? (
                  <LiveShipMeta shipId={p.shipId} ally={!enemy} />
                ) : null}
              </span>
              {/* Avg-damage column, gated by its chip toggle; the TRACK
                  stays reserved when off so the XP/seal geometry never
                  slides. */}
              <span
                class="replay-view__postbattle-cell-stat replay-view__postbattle-cell-stat--dmg"
                data-hint={t("replay.postbattle.avgDamage")}
              >
                {prefs.value.overlayChips.damage ? dmgBody : null}
              </span>
              <span
                class="replay-view__postbattle-fcell-xp"
                data-hint={t("replay.postbattle.xp")}
              >
                {p.xp.toLocaleString()}
              </span>
              {sealsShown.value ? (
                <span class="replay-view__postbattle-cell-stampslot">
                  {sealOf(p)}
                </span>
              ) : null}
            </button>
            {ai ? null : eyeBtn(p.name)}
          </div>
        );
      };
      const rowOf = fullMode.value ? fullCell : cell;
      const sel = selected.value;
      const enemyRows = props.operation ? [] : enemies.value;
      return (
        <div class="replay-view__postbattle" ref={root}>
          {head && (head.matchGroup || head.mapName) ? (
            <div class="replay-view__postbattle-head">
              {head.matchGroup ? (
                <span
                  class="replay-view__postbattle-head-pill"
                  style={
                    modeColor(
                      head.matchGroup,
                      head.scenario,
                      head.eventType,
                      head.botCount ?? 0,
                      head.scriptedUnitCount ?? 0,
                    ) as CSSProperties
                  }
                >
                  {modeLabelOf(
                    head.matchGroup,
                    head.scenario,
                    head.eventType,
                    head.botCount ?? 0,
                    head.scriptedUnitCount ?? 0,
                  )}
                </span>
              ) : null}
              {head.mapName ? (
                <span class="replay-view__postbattle-head-map">
                  {displayMapName(head.mapName, dataLanguage.value)}
                </span>
              ) : null}
            </div>
          ) : null}
          <PostBattleShareBar
            hideAll={masking.hideAll.value}
            shotBusy={shot.busy.value}
            showModeToggle
            fullMode={fullMode.value}
            onToggleAll={() => masking.toggleAll()}
            onShot={() => void shot.copyShot()}
            onToggleMode={toggleFullMode}
          />
          <div
            class={[
              "replay-view__postbattle-matrix",
              { "replay-view__postbattle-matrix--single": enemyRows.length === 0 },
            ]}
          >
            <div class="replay-view__postbattle-col">
              {colTitle(t("replay.roster.allies"), allies.value)}
              {allies.value.map(rowOf)}
            </div>
            {enemyRows.length > 0 ? (
              <div class="replay-view__postbattle-col">
                {colTitle(t("replay.roster.enemies"), enemyRows)}
                {enemyRows.map(rowOf)}
              </div>
            ) : null}
          </div>

          {/* Level-2 modal: player detail */}
          {detailOpen.value && sel ? (
            <div
              class="replay-view__postbattle-modal"
              onClick={() => (detailOpen.value = false)}
            >
              <div
                class="replay-view__postbattle-modal-panel"
                onClick={(e) => e.stopPropagation()}
              >
                <div class="replay-view__postbattle-modal-head">
                  <span class="replay-view__postbattle-detail-head">
                    <span class="replay-view__postbattle-detail-ico">
                      {sel.shipId != null ? (
                        <BattleIcon
                          type={shipOfflineEntry(sel.shipId)?.type ?? ""}
                          variant={sel.alive ? (isEnemy(sel) ? "enemy" : "ally") : "sunk"}
                          size={24}
                        />
                      ) : null}
                    </span>
                    <span class="replay-view__postbattle-detail-name">
                      {masking.maskOf(sel.name)}
                      <em class="replay-view__postbattle-detail-ship">{sel.shipName}</em>
                    </span>
                  </span>
                  <button onClick={() => (detailOpen.value = false)}><X size={12} /></button>
                </div>
                <div class="replay-view__postbattle-modal-scroll">
                  {!sel.alive && sel.killerName ? (
                    <div class="replay-view__postbattle-killed">
                      {t("replay.postbattle.destroyedBy", {
                        name: masking.maskOf(sel.killerName),
                      })}
                    </div>
                  ) : null}
                  <div class="replay-view__postbattle-detail-body">
                    <div class="replay-view__postbattle-detail-damage">
                      <span class="replay-view__postbattle-detail-damage-num">
                        {sel.damage.toLocaleString()}
                        {sel.accountId !== pb.selfId ? (
                          <em
                            class="replay-view__postbattle-damage-unknown"
                            data-hint={t("replay.postbattle.damageUnknownNote")}
                          >
                            *
                          </em>
                        ) : null}
                      </span>
                      <span class="replay-view__postbattle-detail-damage-label">
                        {t("replay.damageTaken")} {sel.damageTaken.toLocaleString()}
                        {sel.hpRatio != null
                          ? ` · ${t("replay.hpRemaining")} ${Math.round(sel.hpRatio)}%`
                          : ""}
                      </span>
                    </div>
                    <div class="replay-view__postbattle-detail-ribbons">
                      {sel.ribbons.map((x: PostBattleRibbon) => {
                        const name = ribbonNames[x.key]?.[dataLanguage.value] ?? x.key;
                        return (
                          <span
                            key={x.key}
                            class="replay-view__postbattle-detail-ribbon"
                            data-hint={`${name} ×${x.value}`}
                          >
                            <AssetImage src={bundledRibbonUrl(x.key)} width={40} height={15} alt="" />
                            <em>{x.value}</em>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  {/* Own full settlement data — the replay only streams the
                      recorder's private results. */}
                  {sel.accountId === pb.selfId && (pb.selfExp != null || pb.selfCredits != null) ? (
                    <div class="replay-view__postbattle-settlement">
                      <span>{t("replay.postbattle.xp")} <b>{pb.selfExp?.toLocaleString() ?? "—"}</b></span>
                      <span>{t("replay.postbattle.credits")} <b>{pb.selfCredits?.toLocaleString() ?? "—"}</b></span>
                    </div>
                  ) : null}
                  {/* On-demand global stats (title bar chip while loading) */}
                  <div class="replay-view__postbattle-global">
                    {globalLoading.value ? (
                      <span class="replay-view__postbattle-global-note replay-view__postbattle-global-note--loading">
                        <HkSpinner size="md" tone="current" />
                      </span>
                    ) : globalStats.value ? (
                      <StatsCard stats={globalStats.value} />
                    ) : globalError.value ? (
                      <span class="replay-view__postbattle-global-note">
                        {t("replay.postbattle.globalFailedAi")}
                      </span>
                    ) : (
                      <span class="replay-view__postbattle-global-note">
                        {t("replay.postbattle.globalUnavailable")}
                        {sel.realm ? "" : t("replay.postbattle.noRealm")}
                      </span>
                    )}
                  </div>
                  {/* Ship distribution: tier histogram + class and nation
                      pies — spot low-tier farmers / CV-SS specialists and
                      one-nation grinders. */}
                  {shipDistList.value.length > 0 ? (
                    <div class="replay-view__postbattle-dist">
                      <div class="replay-view__postbattle-dist-title">
                        {t("replay.postbattle.tierDist")}
                      </div>
                      <ShipDistCharts ships={shipDistList.value} />
                    </div>
                  ) : null}
                </div>
                <button class="replay-view__postbattle-jump" onClick={jumpToLookup}>
                  {t("replay.postbattle.fullStats")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      );
    };
  },
});
