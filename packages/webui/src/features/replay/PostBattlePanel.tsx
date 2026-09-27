/**
 * Post-battle panel: the two-column result matrix shown by the replay
 * "结果" modal AND by the live view's post-battle window (opened once the
 * settling .wowsreplay carries its BattleResults payload). Rows sort by
 * settlement base exp (裸经验 — bots report 0, legacy short arrays fall back
 * to an estimate) and carry the same roster dressing as the live-battle
 * panel: clan tags, PR column, career seals, team aggregates in the column
 * titles and the battle mode/map head — except ship parameters, which stay a
 * live-battle-only feature (the settled battle no longer needs them).
 *
 * Share-time privacy: nicknames can be masked wholesale or per player (the
 * row-end eye), and "复制截图" paints the matrix into a watermarked PNG on
 * the clipboard — see postBattleShare.tsx / postBattleShot.ts. The share
 * model is built from the masked display strings, so a hidden nick cannot
 * leak into the image.
 *
 * Clicking a player opens a second-level modal with the match result +
 * on-demand global stats (title bar chip while loading) and a jump link
 * into the lookup screen.
 */
import {
  computed,
  defineComponent,
  onBeforeUnmount,
  onMounted,
  ref,
  type CSSProperties,
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
import { prAlgoForRequest, statsPrefsState } from "@/stores/statsPrefs";
import { careerStamp, damageColor, prTier, winrateColor } from "@/utils/winrate";
import { aggregateTeamStats } from "@/utils/teamAggregate";
import { shipTierOf } from "@/utils/shipClass";
import { modeColor, modeKey } from "@/utils/modeColors";
import { displayMapName } from "@/utils/mapNames";
import {
  AI_NAME,
  fetchRosterStatsByNames,
  isAiName,
  type RosterStat,
} from "@/composables/useRosterStats";
import { parsePostBattle, type PostBattleRibbon } from "./postBattle";
import { PostBattleShareBar, useNickMasking, useShareShot } from "./postBattleShare";
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
  mapName?: string | null;
}

/** Localize a battle mode from its layered identity (same helper shape the
 *  live panel and ReplayView carry). */
function modeLabelOf(
  group?: string | null,
  scenario?: string | null,
  eventType?: string | null,
  botCount = 0,
): string {
  const key = modeKey(group, scenario, eventType, botCount);
  if (!key) return t("replay.mode._fallback");
  const i18nKey = `replay.mode.${key}`;
  const lbl = t(i18nKey);
  return lbl === i18nKey ? t("replay.mode._fallback") : lbl;
}

/** The aligned roster-stat columns for one player name — overall winrate, PR
 *  (while the rating pref is on) and avg damage, tier-colored (the XVM-style
 *  level coloring from utils/winrate). A tiny spinner rides while the batch
 *  lookup runs; bots / hidden profiles / lookup misses render a muted "—".
 *  Shared by both post-battle panels (the results panel and the fallback). */
export function rosterStatCols(
  name: string,
  stats: Map<string, RosterStat>,
  loading: boolean,
) {
  const ai = isAiName(name);
  const stat = ai ? undefined : stats.get(name);
  const col = (
    mod: string,
    title: string,
    pick: (s: RosterStat) => number | null,
    colorOf: (v: number) => string,
    fmt: (v: number) => string,
  ) => {
    let tip = title;
    let body;
    if (ai) {
      tip = t("replay.botNote");
      body = <em>—</em>;
    } else if (!stat || loading) {
      body = <HkSpinner size="xs" tone="current" />;
    } else {
      const v = pick(stat);
      if (v == null) {
        if (stat.hidden) tip = t("replay.live.hiddenProfile");
        body = <em>—</em>;
      } else {
        body = <b style={{ color: colorOf(v) }}>{fmt(v)}</b>;
      }
    }
    return (
      <span
        class={`replay-view__postbattle-cell-stat ${mod}`}
        data-hint={tip}
      >
        {body}
      </span>
    );
  };
  return (
    <>
      {col(
        "replay-view__postbattle-cell-stat--wr",
        t("replay.postbattle.winrate"),
        (s) => s.winrate,
        winrateColor,
        (v) => `${v.toFixed(1)}%`,
      )}
      {statsPrefsState.value.prEnabled ? (
        col(
          "replay-view__postbattle-cell-stat--pr",
          "PR",
          (s) => s.pr,
          (v) => prTier(v).color,
          (v) => `${Math.round(v)}`,
        )
      ) : null}
      {col(
        "replay-view__postbattle-cell-stat--dmg",
        t("replay.postbattle.avgDamage"),
        (s) => s.avgDamage,
        damageColor,
        (v) => Math.round(v).toLocaleString(),
      )}
    </>
  );
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
    const { dataLanguage } = useLanguage();
    const loadingTasks = useLoadingTasksStore();
    const router = useRouter();
    const root = ref<HTMLElement | null>(null);
    const rows = computed(() => {
      const pb = parsed.value;
      if (!pb) return [];
      const names = new Map(pb.players.map((p) => [p.accountId, p.name]));
      return pb.players.map((p) => ({
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
    const detailOpen = ref(false);
    const selected = ref<(typeof rows.value)[number] | null>(null);
    const globalStats = ref<PlayerStats | null>(null);
    const globalLoading = ref(false);
    const globalError = ref(false);
    /** Battles per tier (index 1..10) and per ship type — for spotting
     *  low-tier farmers / CV-SS specialists. */
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

    const prefs = computed(() => statsPrefsState.value);

    /** One team's header aggregate — tier-weighted (per the stats prefs)
     *  mean winrate plus a plain mean PR over the players whose stats
     *  landed. AI names, hidden profiles and stat misses sit out. */
    const teamAgg = (list: typeof rows.value) =>
      aggregateTeamStats(
        list.map((p) => {
          const st = !isAiName(p.name) ? nameStats.value.get(p.name) : undefined;
          if (!st || st.hidden) {
            return { winrate: null, pr: null, tier: p.shipId != null ? shipTierOf(p.shipId) : null };
          }
          return {
            winrate: st.winrate,
            pr: st.pr,
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
            );
            return {
              label: modeLabelOf(
                head.matchGroup,
                head.scenario,
                head.eventType,
                head.botCount ?? 0,
              ),
              color: c.color,
              background: c.background,
            };
          })()
        : null;
      const statTexts = (p: (typeof rows.value)[number]): ShotStat[] => {
        const ai = isAiName(p.name);
        const st = ai ? undefined : nameStats.value.get(p.name);
        const cell = (
          pick: (s: RosterStat) => number | null,
          fmt: (v: number) => string,
          colorOf: (v: number) => string,
        ): ShotStat => {
          if (!st) return { text: "—" };
          const v = pick(st);
          if (v == null) return { text: "—" };
          return { text: fmt(v), color: colorOf(v) };
        };
        const out: ShotStat[] = [
          cell((s) => s.winrate, (v) => `${v.toFixed(1)}%`, winrateColor),
        ];
        if (prefs.value.prEnabled) {
          out.push(cell((s) => s.pr, (v) => `${Math.round(v)}`, (v) => prTier(v).color));
        }
        out.push(
          cell((s) => s.avgDamage, (v) => Math.round(v).toLocaleString(), damageColor),
        );
        out.push({ text: p.xp.toLocaleString() });
        return out;
      };
      const mkCol = (
        list: typeof rows.value,
        enemy: boolean,
      ): ShotColumn => {
        // Aggregate values carry their stat-column index so the shot's
        // header numbers right-align onto the cells below them.
        let agg: ShotColumn["agg"];
        if (prefs.value.prEnabled) {
          const a = teamAgg(list);
          agg = [
            {
              col: 0,
              label: t(
                prefs.value.weightedTeamWr
                  ? "replay.roster.teamWrWeighted"
                  : "replay.roster.teamWrPlain",
              ),
              value: a.winrate != null ? `${a.winrate.toFixed(1)}%` : "—",
              valueColor: a.winrate != null ? winrateColor(a.winrate) : undefined,
            },
            {
              col: 1,
              label: t("replay.roster.teamAvgPr"),
              value: a.avgPr != null ? `${Math.round(a.avgPr)}` : "—",
              valueColor: a.avgPr != null ? prTier(a.avgPr).color : undefined,
            },
          ];
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
        if (!prefs.value.prEnabled) {
          return <div class="replay-view__postbattle-col-title">{title}</div>;
        }
        const agg = teamAgg(list);
        const prBand = prTier(agg.avgPr);
        return (
          <div
            class={[
              "replay-view__postbattle-col-title",
              "replay-view__postbattle-col-title--agg",
              // Right-edge compensation so the header grid sits over the
              // columns below: rows spend width on the mask eye (+ the
              // career seal slot when seals are enabled).
              prefs.value.sealsEnabled
                ? "replay-view__postbattle-col-title--pad-seal"
                : "replay-view__postbattle-col-title--pad-eye",
            ]}
          >
            {title}
            <span class="replay-view__postbattle-col-hlbl">
              {t(
                prefs.value.weightedTeamWr
                  ? "replay.roster.teamWrWeighted"
                  : "replay.roster.teamWrPlain",
              )}
            </span>
            <span class="replay-view__postbattle-col-hlbl">
              {t("replay.roster.teamAvgPr")}
            </span>
            <span class="replay-view__postbattle-col-hfill" />
            <span class="replay-view__postbattle-col-hfill" />
            <b
              class="replay-view__postbattle-col-hval"
              style={agg.winrate != null ? { color: winrateColor(agg.winrate) } : undefined}
            >
              {agg.winrate != null ? `${agg.winrate.toFixed(1)}%` : "—"}
            </b>
            <b
              class="replay-view__postbattle-col-hval"
              style={{ color: prBand.color }}
            >
              {agg.avgPr != null ? Math.round(agg.avgPr) : "—"}
            </b>
            <span class="replay-view__postbattle-col-hfill" />
            <span class="replay-view__postbattle-col-hfill" />
          </div>
        );
      };
      const cell = (p: (typeof allies.value)[number]) => {
        const enemy = !props.operation && isEnemy(p);
        const ai = isAiName(p.name);
        const stat = ai ? undefined : nameStats.value.get(p.name);
        // Career seal — same guard chain as the live panel (verdict-pending
        // hidden profiles hold their stamp).
        const stamp =
          stat &&
          !stat.loading &&
          !(stat.hidden && stat.clanId != null && stat.clanWinrate === undefined)
            ? careerStamp(stat.pr, stat.battles, stat.winrate, stat.hidden, stat.clanWinrate)
            : null;
        const seal =
          stamp && prefs.value.prEnabled && prefs.value.sealsEnabled ? (
            <RatingStamp
              kind={stamp}
              size={26}
              variant="mini"
              class="replay-view__postbattle-cell-stamp"
            />
          ) : null;
        return (
          <div
            class={[
              "replay-view__postbattle-cell",
              p.alive ? "" : "replay-view__postbattle-cell--dead",
              p.accountId === pb.selfId ? "replay-view__postbattle-cell--self" : "",
            ]}
            key={p.accountId}
          >
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
              {rosterStatCols(p.name, nameStats.value, nameStatsLoading.value)}
              <span
                class="replay-view__postbattle-cell-xp"
                data-hint={t("replay.postbattle.xp")}
              >
                {p.xp.toLocaleString()}
              </span>
            </button>
            {seal}
            {ai ? null : (
              <button
                class={[
                  "replay-view__postbattle-cell-eye",
                  { "replay-view__postbattle-cell-eye--on": masking.isHidden(p.name) },
                ]}
                type="button"
                data-hint={
                  masking.isHidden(p.name)
                    ? t("replay.postbattle.showName")
                    : t("replay.postbattle.hideName")
                }
                aria-label={
                  masking.isHidden(p.name)
                    ? t("replay.postbattle.showName")
                    : t("replay.postbattle.hideName")
                }
                onClick={() => masking.toggleOne(p.name)}
              >
                {masking.isHidden(p.name) ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            )}
          </div>
        );
      };
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
                    ) as CSSProperties
                  }
                >
                  {modeLabelOf(head.matchGroup, head.scenario, head.eventType, head.botCount ?? 0)}
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
            onToggleAll={() => masking.toggleAll()}
            onShot={() => void shot.copyShot()}
          />
          <div
            class={[
              "replay-view__postbattle-matrix",
              { "replay-view__postbattle-matrix--single": enemyRows.length === 0 },
            ]}
          >
            <div class="replay-view__postbattle-col">
              {colTitle(t("replay.roster.allies"), allies.value)}
              {allies.value.map(cell)}
            </div>
            {enemyRows.length > 0 ? (
              <div class="replay-view__postbattle-col">
                {colTitle(t("replay.roster.enemies"), enemyRows)}
                {enemyRows.map(cell)}
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
                  {/* Ship distribution: tier histogram + class pie — spot
                      low-tier farmers / CV-SS specialists. */}
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
