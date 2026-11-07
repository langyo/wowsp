/**
 * Post-battle panel: the two-column result matrix shown by the replay
 * "结果" modal (mounted by ReplayView once the replay carries its
 * BattleResults payload; the live view reads its own roster straight from
 * the arena store instead). The toolbar's segmented 全员/我的 switcher
 * flips the panel between this roster matrix and the self report
 * (我的战绩) — the shared SelfReportBody over the live panel's own model
 * builder, fed from the replay's decoded stream; the camera button copies
 * the ONE combined sheet from either view. The matrix rows sort by
 * settlement base exp (裸经验 — bots report 0, legacy short arrays fall back
 * to an estimate) or, with the AI confidence switch on (the stats chip
 * popup's second block), by the coverage-weighted AI key — see the AI
 * paragraph below — and carry the same roster dressing as the live-battle
 * panel: clan tags, PR column, identity-line seal tags and team aggregates
 * in the column titles. (The mode/map head row above the toolbar was
 * retired 2026-11-07 — the user read it as an extra element; the `head`
 * prop still feeds the copied sheet's mode pill and the stats-source
 * scope.) Rows default to the compact one-line look; the share bar's mode
 * toggle expands them to full cards, a persisted stats pref. BOTH
 * densities share the same two-line aggregate header (labels over team
 * means, right-aligned on the row columns — 2026-11-07 review: the full
 * header used to squeeze its aggregates into one inline run). The full
 * card reads as the compact row's hover hint laid out for real: its left
 * stack carries the three identity lines (clan-tagged nick / every tag /
 * ship tier + name) and its right block stacks the compact row's aligned
 * data line (configured columns, XP, then the AI score) over the
 * LiveShipMeta ship strip's two lines, so the strip gets the whole column
 * band instead of a squeezed middle track. The share bar also leads with
 * the stats-source chip — the identical selector the live panel's head
 * mounts (one shared statsPrefs store; a flip re-resolves these rows
 * immediately).
 *
 * Identity-line seals: the career verdict (神了 / 猴 / 蛆 / 过街老鼠) and the
 * composition tags (空中小人 / 水下小人 plus the 奶龙 / 奶蛙 veteran tiers)
 * press as the SMALL-TAG StampTag face BEFORE the nickname — career first,
 * composition after (user feedback: the roster should carry the small-tag
 * version of the 猴 seal, on the identity line where it reads as part of who
 * the player is). BOTH densities press EVERY seal the row owns (2026-11-07
 * review: a tag must always show whole — the one-tag cap that clipped or hid
 * the rest is gone): a crowded compact line wraps the stamp cluster instead
 * of clipping it and lets the clan tag ellipsize, while the nickname keeps a
 * readable floor. The old right-edge career-seal column and its reserved
 * track are retired: at the row end the square face read as one more score
 * column and stole width from the stat cells. The second identity line
 * leads with the ship tier's Roman numeral on a fixed-width track (see the
 * SCSS), so every row's ship name starts at the same x whether the tier
 * is "I" / "VIII" / "★" or absent.
 *
 * Row hover hint: every row (both densities) carries ONE data-hint on its
 * drill-down button — line 1 the clan-tagged nickname, line 2 every tag one
 * by one (division / local marker / seals, the four-char composition tags
 * included), line 3 the ship tier and name. The compact identity is a single
 * line and the full card's tracks are fixed, so this hint is where the
 * complete identity survives (the global popup keeps the newlines). A full
 * card anchors the hint on its identity stack rather than the whole button,
 * so the ship strip's own hover card keeps the right block to itself. The
 * mask eye sits OUTSIDE the row button and keeps its own mask-toggle hint: a
 * direct hover on the eye must not trade that hint for the row card.
 *
 * AI confidence scores: one `decision_static_report` call (shared with the
 * 3D board / E25 战报 through the backend's scoring cache) joins every
 * scoreable ship onto its row by the PLAYER nickname and drives BOTH the
 * rightmost AI score column (the fire+move whole-game agreement as a
 * percentage; tooltip carries the fire/move split and the data-coverage
 * ratio) and, while the switch is on, the roster order — the coverage-
 * weighted key `coverage × AI + (1 − coverage) × xp-share-of-own-team`
 * (postBattleAiScore.ts): the longer the replay could actually observe a
 * ship, the more its placing trusts the model's verdict over the game's
 * own settlement score. The switch rides the stats chip popup's second
 * block (default ON); without the AI capability, a failed report, or an
 * empty join the column hides and the settlement-XP scoreboard stays.
 *
 * Share-time privacy: nicknames can be masked wholesale or per player (the
 * row-end eye), and "复制截图" paints the combined sheet into a watermarked
 * PNG on the clipboard — both teams' roster matrix on top, the personal
 * 我的战绩 banner below it (see postBattleShare.tsx / postBattleShot.ts),
 * one image from either view. The share model is built from the masked
 * display strings, so a hidden nick cannot leak into the image.
 *
 * Clicking a player opens a second-level modal with the match result +
 * on-demand global stats (title bar chip while loading) and a jump link
 * into the lookup screen. The whole row — identity-line seals included — is
 * the click target; only the per-row mask eye sits outside it.
 */
import {
  computed,
  defineComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type VNode,
} from "vue";
import { useRouter } from "vue-router";
import { Eye, EyeOff } from "@lucide/vue";
import { HkModal, HkSpinner } from "@celestia-island/hikari";

import {
  api,
  type MarkerColor,
  type PlayerBuild,
  type PlayerStats,
  type VehicleEntry,
} from "@/api";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import ErrorCard from "@/components/base/ErrorCard";
import BattleIcon from "@/components/base/BattleIcon";
import { AssetImage } from "@/components/base/AssetImage";
import KarmaSup from "@/components/base/KarmaSup";
import StampTag from "@/components/base/StampTag";
import DivisionTag from "@/components/base/DivisionTag";
import StatsCard from "@/components/stats/StatsCard";
import { shipNameFromOfflineDb, shipOfflineEntry } from "@/features/holographic/modelLoader";
import {
  joinPlayerBuild,
  playerBuildView,
  type PlayerBuildView,
} from "./playerBuild";
import { bundledRibbonUrl } from "@/features/holographic/ribbonIcons";
import ribbonNamesRaw from "@/data/ribbon_names.json";
import { useLoadingTasksStore } from "@/stores/loadingTasks";
import { useStatsStore } from "@/stores/stats";
import { prAlgoForRequest, statsPrefsState, useStatsPrefsStore } from "@/stores/statsPrefs";
import {
  battlesColor,
  careerStamp,
  damageColor,
  prTier,
  winrateColor,
  stampWording,
  type CareerStamp,
  type StampKind,
} from "@/utils/winrate";
import { formatEta } from "@/utils/format";
import { aggregateTeamStats } from "@/utils/teamAggregate";
import { shipTierOf } from "@/utils/shipClass";
import { isScriptedUnitName } from "@/utils/aiNames";
import { isListedPlayer } from "@/utils/rosterSides";
import { hasSingleTeamRoster, modeColorOfKey } from "@/utils/modeColors";
import { divisionLetters } from "@/utils/divisions";
import { displayMapName } from "@/utils/mapNames";
import { useLiveCompositions } from "@/composables/useLiveCompositions";
import {
  AI_NAME,
  fetchRosterStatsByNames,
  isAiName,
  type RosterStat,
} from "@/composables/useRosterStats";
import { postBattleModeKey } from "./postBattleMode";
import { parsePostBattle, type PostBattleRibbon } from "./postBattle";
import { buildSelfStats, type SelfStatsModel, type SelfStatsStream } from "./liveSelfStats";
import type { SelfShotModel } from "./liveSelfShot";
import { selfShotBannerOf } from "./selfReportView";
import { tierRoman } from "./shipLiveStats";
import LiveShipMeta from "./LiveShipMeta";
import SelfReportBody from "./SelfReportBody";
import {
  PostBattleShareBar,
  rosterColumns,
  rosterShotCells,
  rosterShotDashes,
  rosterRowHint,
  rosterStatCols,
  useNickMasking,
  useShareShot,
  type RosterColumnSpec,
} from "./postBattleShare";
import {
  columnsNeedShipStats,
  overlayColumnDims,
  resolveRosterBattleScope,
  type ResolvedStatsMode,
} from "@/utils/statView";
import { scopedRosterView } from "@/utils/shipStatsScope";
import type { OverlayColumnScope } from "@/stores/statsPrefs";
import { markerTintClass } from "@/features/markers/markerTint";
import { markerColorLabel } from "@/features/markers/playerContextMenu";
import { useMarkersStore } from "@/stores/markers";
import type { ShotColumn, ShotModel, ShotRow, ShotStat } from "./postBattleShot";
import {
  aiRecorderEntryOf,
  aiScoreMapOf,
  aiWeightedKey,
  formatAiPct,
  type AiScoreEntry,
} from "./postBattleAiScore";
import { useCapabilitiesStore } from "@/stores/capabilities";
import "./PostBattlePanel.scss";

const ribbonNames = ribbonNamesRaw as Record<string, Partial<Record<string, string>>>;

/** Battle identity the panel resolves its canonical mode key from — the
 *  copied sheet's mode pill / map label / meta line and the stats-source
 *  battle scope. The same layered identity the live panel reads off
 *  tempArenaInfo (replay context: the replay's arena header; live context:
 *  the retained arena store). Not a DOM head row: the panel's mode/map head
 *  was retired 2026-11-07. */
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

/** Localize an ALREADY-RESOLVED canonical mode key (the same fallback rule
 *  the live panel and ReplayView carry). The head resolves its key through
 *  postBattleMode.ts — the descriptor classifier plus the roster shape and
 *  the parent's operation verdict — so the label and the share shot can
 *  never disagree. */
function modeLabelOfKey(key: string): string {
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
    /** Battle identity behind the copied sheet's mode pill / map label and
     *  the "follow the battle" stats-source scope; null copies no mode pill
     *  (the replay modal's own title carries the on-screen context). */
    head: {
      type: Object as () => PostBattleHead | null,
      default: null,
    },
    /** Operation battle (行动): the roster renders as ONE full-width allies
     *  column, matching the live panel / fallback panel. The share shot's
     *  mode pill also takes it as a one-way label promotion (see
     *  postBattleMode.ts): the parent resolves this from the descriptor
     *  verdict OR the decode-time spawn probe, so a probe-promoted battle
     *  carries true here while its descriptor still reads plain co-op. */
    operation: { type: Boolean, default: false },
    /** The replay's decoded packet stream — the families the 我的战绩 view
     *  runs through the live panel's own model builder (buildSelfStats);
     *  battleResults rides the `raw` prop. Null (no decode yet) keeps the
     *  view switcher off. */
    stream: {
      type: Object as () => SelfStatsStream | null,
      default: null,
    },
    /** The replay's roster (descriptor vehicles) — names, relations and the
     *  self fallback for the self report's identity join. */
    roster: { type: Array as () => VehicleEntry[], default: () => [] },
    /** Ally ship builds decoded off the same replay (ally-only IPC surface).
     *  Joined to the roster rows by name / unique ship id; empty = no grid. */
    builds: { type: Array as () => PlayerBuild[], default: () => [] },
    /** The opened replay's filesystem path — the AI confidence fetch's key
     *  (`decision_static_report`; null on hosts without one keeps the AI
     *  column off and the settlement-XP order stays). */
    replayPath: { type: String, default: null },
  },
  emits: ["close"],
  setup(props, { emit }) {
    const parsed = computed(() => parsePostBattle(props.raw));
    const { dataLanguage, uiLocale } = useLanguage();
    /** The replay build of one roster row (ally rows only — the caller never
     *  asks for an enemy row: the IPC surface filters enemy loadouts out and
     *  the ship-id fallback must not leak a teammate's build sideways). */
    const buildOf = (
      name: string | null | undefined,
      shipId: number | null | undefined,
    ): PlayerBuildView | null => {
      if (props.builds.length === 0) return null;
      const build = joinPlayerBuild(props.builds, name, shipId);
      if (!build) return null;
      const shipType = shipId != null ? shipOfflineEntry(shipId)?.type ?? null : null;
      return playerBuildView(build, {
        dataLanguage: dataLanguage.value,
        shipType,
        source: "replay",
      });
    };
    const loadingTasks = useLoadingTasksStore();
    const stats = useStatsStore();
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
      const shipIds = new Map(
        pb.players
          .filter((p) => p.shipId != null)
          .map((p) => [p.accountId, p.shipId as number]),
      );
      // The results packet carries the story/operation scripted NPCs as
      // team members — they are not players and get no matrix row.
      return pb.players.filter(isListedPlayer).map((p) => ({
        ...p,
        shipName:
          (p.shipId != null ? shipNameFromOfflineDb(p.shipId, dataLanguage.value) : null) ??
          "",
        killerName: p.killerId != null ? names.get(p.killerId) ?? null : null,
        killerShipId: p.killerId != null ? shipIds.get(p.killerId) ?? null : null,
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

    // ── AI confidence scores (the rightmost column + the weighted sort) ──
    // One E25 static report per open: every scoreable ship's whole-game
    // agreement + coverage profile, joined onto the rows by the PLAYER
    // nickname. The fetch shares the backend's scoring cache with the 3D
    // board and the 战报 modal, so a replay the board already analyzed
    // answers instantly; a cold open pays the export+scoring pass once,
    // asynchronously — the panel renders the settlement scoreboard first
    // and re-orders/reactively re-renders the moment the report lands.
    const capabilities = useCapabilitiesStore();
    /** Player name → AI verdict; empty until the report lands. */
    const aiScores = ref<Map<string, AiScoreEntry>>(new Map());
    /** The recorder's own verdict — the combined shot's banner AI pair. */
    const aiRecorder = ref<AiScoreEntry | null>(null);
    const aiState = ref<"idle" | "loading" | "ready" | "failed">("idle");
    let aiSeq = 0;
    async function loadAiScores() {
      const path = props.replayPath;
      if (!path || !capabilities.aiInference) return;
      if (aiState.value === "loading" || aiState.value === "ready") return;
      const seq = ++aiSeq;
      aiState.value = "loading";
      try {
        const report = await api.decisionStaticReport(path, null);
        // A stale reply (a replay switch re-keyed the fetch, or the modal
        // closed) must not patch the new battle's panel.
        if (seq !== aiSeq) return;
        const map = aiScoreMapOf(report);
        if (map.size === 0) {
          // Nothing joined (no models / nothing scoreable): hide the column
          // rather than captioning a wall of dashes.
          aiScores.value = new Map();
          aiRecorder.value = null;
          aiState.value = "failed";
          return;
        }
        aiScores.value = map;
        aiRecorder.value = aiRecorderEntryOf(report);
        aiState.value = "ready";
      } catch {
        if (seq !== aiSeq) return;
        aiState.value = "failed";
      }
    }
    // The switch defaults ON, so the report usually loads with the panel;
    // a late capability probe or a switch flipped on afterwards still
    // triggers the one fetch. A replay swap resets the state (the parent
    // remounts the panel per open, but the prop watch keeps an in-place
    // swap honest too).
    let aiLoadedPath: string | null = props.replayPath;
    watch(
      () => [
        props.replayPath,
        capabilities.aiInference,
        statsPrefsState.value.postbattleAiScore,
      ] as const,
      () => {
        if (props.replayPath !== aiLoadedPath) {
          aiLoadedPath = props.replayPath;
          aiSeq += 1;
          aiState.value = "idle";
          aiScores.value = new Map();
          aiRecorder.value = null;
        }
        if (statsPrefsState.value.postbattleAiScore) void loadAiScores();
      },
      { immediate: true },
    );
    /** The AI score column renders with the switch on from the moment the
     *  report starts loading (spinners while in flight) — one switch owns
     *  the column AND the order it implies, so they can never disagree. */
    const aiColOn = computed(
      () =>
        statsPrefsState.value.postbattleAiScore &&
        (aiState.value === "loading" || aiState.value === "ready"),
    );
    /** The weighted ORDER waits for the landed report: until then the rows
     *  keep the settlement scoreboard (an empty join would sort every row
     *  by star share alone — identical, but explicit is cheaper to read). */
    const aiSortOn = computed(
      () => statsPrefsState.value.postbattleAiScore && aiState.value === "ready",
    );
    /** One row's AI verdict (join miss = undefined: pure star-share sort,
     *  a dash in the column). */
    const aiEntryOf = (name: string): AiScoreEntry | undefined =>
      aiScores.value.get(name);
    /** The AI cell's tooltip: the fire/move split plus the coverage ratio
     *  that drives the sort weight. */
    const aiTipOf = (p: (typeof rows.value)[number]): string => {
      const e = aiEntryOf(p.name);
      if (!e) return t("replay.postbattle.aiScore");
      const cov = Math.round(e.coverage * 100);
      return e.wholeFire != null
        ? t("replay.postbattle.aiScoreTip", {
            fire: Math.round(e.wholeFire * 100),
            move: Math.round(e.wholeMove * 100),
            cov,
          })
        : t("replay.postbattle.aiScoreTipMoveOnly", {
            move: Math.round(e.wholeMove * 100),
            cov,
          });
    };
    /** The AI cell's body: the combined fire+move percentage, a spinner
     *  while the report is in flight, a muted dash for a join miss. */
    const aiCellBody = (p: (typeof rows.value)[number]): VNode => {
      if (aiState.value === "loading") return <HkSpinner size="xs" tone="current" />;
      const e = aiEntryOf(p.name);
      return e ? <b>{formatAiPct(e.wholeGame)}</b> : <em>—</em>;
    };
    /** One team's mean whole-game agreement over its joined rows (the
     *  column title's aggregate; null when nothing joined). */
    const aiTeamMean = (list: (typeof rows.value)[number][]): number | null => {
      const vals = list
        .map((p) => aiEntryOf(p.name)?.wholeGame)
        .filter((v): v is number => v != null);
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };

    const detailOpen = ref(false);
    const selected = ref<(typeof rows.value)[number] | null>(null);
    const globalStats = ref<PlayerStats | null>(null);
    const globalLoading = ref(false);
    const globalError = ref(false);

    /** Roster WR / PR / avg-damage per player name for the matrix columns
     *  (one batched lookup on mount, warm-served from the shared roster-stats
     *  cache). Entries without a realm ride the roster's dominant one — a
     *  battle is single-realm in practice. */
    const nameStats = ref<Map<string, RosterStat>>(new Map());
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
      // Progressive arrival: every landed row settles over the map the
      // moment its sub-batch (and later its per-ship list) resolves, so
      // the matrix fills in first-arrived-first-shown instead of one
      // block at the end — rows still absent spin on their own. Already
      // -landed rows keep their numbers across the dims-watch re-run
      // until their fresh settle replaces them.
      const arrive = (name: string, st: RosterStat) => {
        const next = new Map(nameStats.value);
        next.set(name, st);
        nameStats.value = next;
      };
      await Promise.all(
        [...byRealm].map(([realm, names]) =>
          fetchRosterStatsByNames([...names], realm, arrive),
        ),
      );
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
     *  a scoreboard. Legacy short arrays ride the damage/frags estimate.
     *  With the AI confidence switch on (and the report landed) each side
     *  re-ranks by the coverage-weighted AI key instead: the better the
     *  replay could observe a ship, the more its placing trusts the
     *  model's verdict; a join miss rides its star share alone. Each team
     *  normalises over its OWN roster, so both columns rank independently
     *  (ties fall back to the settlement order). */
    const sortRows = (list: (typeof rows.value)[number][]) => {
      if (!aiSortOn.value) return [...list].sort((a, b) => b.xp - a.xp);
      const total = list.reduce((sum, p) => sum + p.xp, 0);
      const keyOf = (p: (typeof rows.value)[number]) =>
        aiWeightedKey(aiEntryOf(p.name), p.xp, total);
      return [...list].sort((a, b) => keyOf(b) - keyOf(a) || b.xp - a.xp);
    };
    const allies = computed(() => {
      const st = selfTeam.value;
      return sortRows(rows.value.filter((p) => (st != null ? p.team === st : p.team !== 1)));
    });
    const enemies = computed(() => {
      const st = selfTeam.value;
      return sortRows(
        rows.value.filter(
          (p) => p.team !== null && (st != null ? p.team !== st : p.team === 1),
        ),
      );
    });

    // ── Division (组队) lettering: the prebattle ids come off the decoded
    // stream's arena players (0/absent = solo — the results packet itself
    // carries no division field), and each side letters INDEPENDENTLY over
    // its own display order (both start at A), so the tags read top-down
    // like the rows they ride.
    const prebattleDivs = computed<Map<string, number>>(() => {
      const map = new Map<string, number>();
      for (const ap of props.stream?.arenaPlayers ?? []) {
        if (ap.name && ap.prebattle) map.set(ap.name, ap.prebattle);
      }
      return map;
    });
    const allyDivisionLetters = computed(() =>
      divisionLetters(
        allies.value.map((p) => ({
          name: p.name,
          div: prebattleDivs.value.get(p.name) ?? null,
        })),
      ),
    );
    const enemyDivisionLetters = computed(() =>
      divisionLetters(
        enemies.value.map((p) => ({
          name: p.name,
          div: prebattleDivs.value.get(p.name) ?? null,
        })),
      ),
    );

    const prefs = computed(() => statsPrefsState.value);
    /** Seals ride the PR cluster in the settings (the master toggle nests
     *  under it) and need PR data to grade — one gate for the identity-line
     *  tags, the header pad and the share shot alike. */
    const sealsShown = computed(() => prefs.value.prEnabled && prefs.value.sealsEnabled);

    // ── Secondary seals (成分章 → the horizontal StampTag face) ──────────
    // The composition verdicts' secondary face, fetched through the same
    // backend command the Tab overlay and the live panel ride (its
    // process-lifetime cache makes the third consumer free), gated exactly
    // like every seal surface — zh UI on top of the seals master gates —
    // so the pipeline idles when no seal could ever render.
    const compSealsOn = computed(
      () => sealsShown.value && uiLocale.value.startsWith("zh"),
    );
    /** Each row's own realm for the sweep, riders without one taking the
     *  roster's dominant (the rule loadNameStats applies — a battle is
     *  single-realm in practice, but strays exist). Names without any
     *  realm never get asked; null (gate off / no battle) idles it. */
    const compRealms = computed<Record<string, string> | null>(() => {
      if (!compSealsOn.value) return null;
      const pb = parsed.value;
      if (!pb) return null;
      const dominant = pb.players.find((p) => p.realm)?.realm ?? "";
      const map: Record<string, string> = {};
      for (const p of pb.players) {
        if (AI_NAME.test(p.name)) continue;
        const realm = p.realm ?? dominant;
        if (realm) map[p.name] = realm;
      }
      return map;
    });
    const compositions = useLiveCompositions(
      computed(() => Object.keys(compRealms.value ?? {})),
      // No base realm — the per-name map above covers every name asked.
      "",
      compRealms,
    );

    /** Roster density: compact rows (the default) or the expanded full
     *  cards (the live roster's richer density carried as a card here) — a
     *  persisted stats pref, flipped from the share bar's mode toggle
     *  (PostBattleShareBar). */
    const statsPrefs = useStatsPrefsStore();
    const fullMode = computed(() => prefs.value.postbattleRosterFull);
    const toggleFullMode = () =>
      statsPrefs.setPostbattleRosterFull(!fullMode.value);

    /** The stats-source battle scope — the one panel-wide dimension left
     *  (each configured column carries its own scope) — resolved against
     *  the replayed battle's identity ("follow": ranked → ranked
     *  careers). Rows read each column through `colViewOf`, which
     *  resolves the account careers for the global/solo scopes and the
     *  attached per-ship lists for the ship/class ones. */
    const battleScope = computed<ResolvedStatsMode>(() =>
      resolveRosterBattleScope(prefs.value.overlayBattleScope, props.head ?? {}),
    );
    const shipScopeOn = computed(() =>
      columnsNeedShipStats(prefs.value.overlayColumns, prefs.value.prEnabled),
    );
    const colViewOf = (
      scope: OverlayColumnScope,
      st: RosterStat | null | undefined,
      shipId: number | null,
    ) =>
      scopedRosterView(
        st,
        shipId,
        overlayColumnDims(scope, prefs.value.overlayBattleScope),
        battleScope.value,
        prAlgoForRequest() ?? "winrate",
      );
    // Flipping any column past the account careers (or the PR algorithm)
    // after the one-shot load re-runs it: fetchRosterStatsByNames only
    // attaches the per-ship lists the columns in force AT LOAD TIME
    // requested, and without this the rows would sit on silent dashes
    // instead of re-resolving (the live panel gets the same flip for free
    // from its composable watch).
    watch(
      () =>
        [
          columnsNeedShipStats(prefs.value.overlayColumns, prefs.value.prEnabled),
          prAlgoForRequest(),
        ] as const,
      ([need]) => {
        if (need) void loadNameStats();
      },
    );

    /** One team's header aggregate FOR ONE COLUMN SCOPE — tier-weighted
     *  (per the stats prefs) mean winrate plus plain mean PR / battles /
     *  avg damage over the players whose stats landed, each in that
     *  scope's resolved view. AI names, hidden profiles and stat misses
     *  sit out. */
    const teamAggFor = (scope: OverlayColumnScope, list: typeof rows.value) =>
      aggregateTeamStats(
        list.map((p) => {
          const st = !isAiName(p.name) ? nameStats.value.get(p.name) : undefined;
          if (
            !st ||
            st.hidden ||
            // Only the per-ship scopes (ship / ship-solo / class) wait on
            // the lists — the plain solo scope reads the career split
            // (utils/shipStatsScope).
            (scope !== "global" && scope !== "solo" && st.shipsLoading)
          ) {
            return {
              winrate: null,
              pr: null,
              battles: null,
              damage: null,
              kd: null,
              tier: p.shipId != null ? shipTierOf(p.shipId) : null,
            };
          }
          const view = colViewOf(scope, st, p.shipId ?? null);
          return {
            winrate: view.winrate,
            pr: view.pr,
            battles: view.battles,
            damage: view.avgDamage,
            kd: view.kd,
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
        globalStats.value = await stats.lookup(p.name, p.realm);
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
      // A fresh drill-down (killer jumps included) lands scrolled to the
      // head, not wherever the previous player's body had been left —
      // HkModal's built-in body scroller owns the scrollport, so reset it.
      // The window teleports to the overlay root (outside this component's
      // DOM), so the reset queries the document through the shared
      // content-class hook.
      void nextTick(() => {
        const vp = document.querySelector<HTMLElement>(
          ".replay-view__postbattle-detail .hk-modal-body-scroll",
        );
        if (vp) vp.scrollTop = 0;
      });
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
    // Local player markers (玩家标记): the dot beside the nick and the
    // right-click menu both read this store (the menu itself is the
    // app-global binding — rows only carry the identity attrs).
    const markers = useMarkersStore();
    void markers.ensureLoaded();
    /** The active view: the roster matrix (default) or the self report —
     *  the toolbar's segmented 全员/我的 switch. Ephemeral per open (a
     *  share-time choice, not a preference). */
    const view = ref<"roster" | "self">("roster");
    /** The personal report (我的战绩) — the exact pure model the live
     *  panel runs, fed from the replay's decoded stream; the battle
     *  results ride the `raw` prop. */
    const selfModel = computed<SelfStatsModel | null>(() => {
      if (!props.stream) return null;
      return buildSelfStats({
        stream: { ...props.stream, battleResults: props.raw },
        roster: props.roster,
        dataLang: dataLanguage.value,
      });
    });
    /** The roster's single-team shape (listed players, NO enemy-side entry)
     *  — the operation clue inside the pve family (real co-op always fields
     *  its enemy bot team). Same argument every other mode surface forwards
     *  into the classifier (hasSingleTeamRoster in utils/modeColors). */
    const singleTeamRoster = computed(() => hasSingleTeamRoster(props.roster));
    /** The share shot's resolved canonical mode key — empty when there is no
     *  battle identity to render. `props.operation` may promote a plain-co-op
     *  descriptor key to 行动 (the decode-time spawn probe's verdict), see
     *  postBattleMode.ts. */
    const headModeKey = computed(() =>
      props.head?.matchGroup
        ? postBattleModeKey(props.head, singleTeamRoster.value, props.operation)
        : "",
    );
    /** The copied sheet's battle-mode pill data, shared by both shot models. */
    const headMode = (): SelfShotModel["mode"] => {
      if (!headModeKey.value) return null;
      const c = modeColorOfKey(headModeKey.value);
      return {
        label: modeLabelOfKey(headModeKey.value),
        color: c.color,
        background: c.background,
      };
    };
    const shot = useShareShot(buildShotModel, () => root.value);
    /** The ship tier's Roman marker ("I" / "VIII", "★" for superships) or an
     *  empty string — the identity line's second row leads with it on a
     *  fixed-width track (PostBattlePanel.scss), so every row's ship name
     *  starts at the same x. Shared by the DOM rows and the share model. */
    const tierLabelOf = (p: (typeof rows.value)[number]): string =>
      tierRoman(p.shipId != null ? shipTierOf(p.shipId) : null) ?? "";
    /** The career seal kind a row carries into the share shot — the exact
     *  career gate chain the DOM's identity line applies (settings master
     *  switch, zh-only bitmaps, verdict-pending holds, per-kind kill
     *  switch), so a seal switched off in the settings never leaks into the
     *  copied image. */
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
      const mode = headMode();
      /** One row's shot cells: the configured columns of the row's
       *  per-scope views (the exact columns the panel shows) plus the
       *  settlement XP — dashes for bots / misses — and the AI confidence
       *  cell once the report has LANDED (a copy taken mid-load omits the
       *  column rather than captioning a wall of dashes that would read as
       *  join misses), so the copied sheet never contradicts the roster
       *  beside the button. */
      const statTexts = (p: (typeof rows.value)[number]): ShotStat[] => {
        const ai = isAiName(p.name);
        const st = ai ? undefined : nameStats.value.get(p.name);
        const out: ShotStat[] = !st
          ? rosterShotDashes()
          : rosterShotCells((scope) => colViewOf(scope, st, p.shipId ?? null));
        out.push({ text: p.xp.toLocaleString() });
        if (aiSortOn.value) {
          const e = aiEntryOf(p.name);
          out.push(e ? { text: formatAiPct(e.wholeGame) } : { text: "—" });
        }
        return out;
      };
      const mkCol = (
        list: typeof rows.value,
        enemy: boolean,
      ): ShotColumn => {
        // Aggregate values carry their stat-column index so the shot's
        // header numbers right-align onto the cells below them. The
        // aggregate mirrors the panel's column title: one labeled team
        // mean PER CONFIGURED COLUMN (each in its own scope's view) —
        // winrate keeps the weighted/plain wording, PR the rating
        // label, damage the avg-damage label.
        let agg: ShotColumn["agg"];
        {
          const cols = rosterColumns();
          const parts: NonNullable<ShotColumn["agg"]> = [];
          cols.forEach((col, idx) => {
            const a = teamAggFor(col.scope, list);
            if (col.metric === "winrate") {
              parts.push({
                col: idx,
                label:
                  col.scope === "global"
                    ? t(
                        prefs.value.weightedTeamWr
                          ? "replay.roster.teamWrWeighted"
                          : "replay.roster.teamWrPlain",
                      )
                    : col.head,
                value: a.winrate != null ? `${a.winrate.toFixed(1)}%` : "—",
                valueColor: a.winrate != null ? winrateColor(a.winrate) : undefined,
              });
            } else if (col.metric === "pr") {
              parts.push({
                col: idx,
                label: col.scope === "global" ? t("replay.roster.teamAvgPr") : col.head,
                value: a.avgPr != null ? `${Math.round(a.avgPr)}` : "—",
                valueColor: a.avgPr != null ? prTier(a.avgPr).color : undefined,
              });
            } else if (col.metric === "battles") {
              parts.push({
                col: idx,
                label: col.scope === "global" ? t("replay.roster.battles") : col.head,
                value:
                  a.avgBattles != null ? Math.round(a.avgBattles).toLocaleString() : "—",
                valueColor:
                  col.scope === "global" && a.avgBattles != null
                    ? battlesColor(a.avgBattles)
                    : undefined,
              });
            } else if (col.metric === "damage") {
              parts.push({
                col: idx,
                label:
                  col.scope === "global"
                    ? t("replay.postbattle.avgDamage")
                    : col.head,
                value: a.avgDamage != null ? Math.round(a.avgDamage).toLocaleString() : "—",
                valueColor: a.avgDamage != null ? damageColor(a.avgDamage) : undefined,
              });
            } else if (col.metric === "kd") {
              parts.push({
                col: idx,
                label: col.scope === "global" ? t("replay.roster.metricKd") : col.head,
                value: a.avgKd != null ? a.avgKd.toFixed(2) : "—",
              });
            }
          });
          // The XP column closes the row (the last stat cell every row
          // carries), so the header must caption it too — label-only: a
          // single-battle figure has no team aggregate. The on-screen
          // compact header renders the identical cell. The AI column (when
          // on) follows it and DOES carry a team mean.
          parts.push({ col: cols.length, label: t("replay.postbattle.xp") });
          if (aiSortOn.value) {
            const aiMean = aiTeamMean(list);
            parts.push({
              col: cols.length + 1,
              label: t("replay.postbattle.aiScore"),
              value: aiMean != null ? formatAiPct(aiMean) : "—",
            });
          }
          agg = parts;
        }
        return {
          title: enemy ? t("replay.roster.enemies") : t("replay.roster.allies"),
          agg,
          rows: list.map((p): ShotRow => {
            // The share shot's identity faces and tier marker mirror the DOM
            // row exactly: the career verdict arrives through shotStampOf's
            // own gate chain, the tier through the same tierLabelOf the
            // second line prints. The renderer presses the sealTags as
            // small-tag faces BEFORE the nick (career first, the DOM order)
            // and draws the tier ahead of the ship name, so the copied sheet
            // and the panel agree.
            const seal = shotStampOf(p.name);
            // The division tag rides the SAME per-side lettering the DOM
            // rows press; the shot carries the ALREADY-LOCALIZED label so
            // the canvas renderer paints strings only.
            const divLetter = (
              enemy ? enemyDivisionLetters : allyDivisionLetters
            ).value.get(p.name);
            return {
              nick: masking.maskOf(p.name),
              divisionTag: divLetter
                ? t("replay.postbattle.divisionTag", { letter: divLetter })
                : undefined,
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
              sealTags: seal ? [seal] : [],
              tier: tierLabelOf(p),
              stats: statTexts(p),
            };
          }),
        };
      };
      // The personal banner: the live self model (settlement payload merged
      // in by the panel's computed) reduced to the ShotSelf vocabulary. Null
      // when the decoded stream yields no self model — the matrix still
      // copies, exactly as before the banner existed. The recorder's own AI
      // percentage leads the banner's aux line when the column is on.
      const selfName = selfModel.value?.selfName ?? null;
      const selfBanner = selfShotBannerOf(selfModel.value, {
        title: t("replay.live.selfTitle"),
        lang: dataLanguage.value,
        maskOf: masking.maskOf,
        clanTag: selfName ? (nameStats.value.get(selfName)?.clanTag ?? null) : null,
        aiPct:
          aiSortOn.value && aiRecorder.value
            ? formatAiPct(aiRecorder.value.wholeGame)
            : null,
      });
      return {
        title: t("replay.results"),
        mode,
        mapLabel: head?.mapName
          ? displayMapName(head.mapName, dataLanguage.value)
          : null,
        metaLine: shotMetaLine(head),
        botLabel: t("replay.bot"),
        ...(selfBanner ? { self: selfBanner } : {}),
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
      // Parse-failure fallback: the standard error card — props.raw is the
      // whole BattleResults payload, which is JSON in practice, so the
      // card's tree pane structures the exact bytes that refused to parse.
      if (!pb) return <ErrorCard error={props.raw} />;
      const st = selfTeam.value;
      const isEnemy = (p: (typeof rows.value)[number]) =>
        p.team !== null && (st != null ? p.team !== st : p.team === 1);
      /** The row's division tag (组队标签) — the yellow StampTag sibling,
       *  FIRST in the nickname line ahead of the identity-line seals.
       *  Divisions are battle facts, so unlike the seals this renders under
       *  every locale with no prefs gate; solo rows render nothing. */
      const divisionTagOf = (p: (typeof rows.value)[number]): VNode | null => {
        const letter = divisionLetterOf(p);
        return letter != null ? <DivisionTag letter={letter} /> : null;
      };
      /** The aligned stat-columns grid template — ONE string shared by the
       *  two-line aggregate header and the full card's data line, so the
       *  numbers land on the header tracks in both densities (compact rows
       *  take their widths from the same rosterColumns specs in a flex line,
       *  which is why the two layouts end on the same right edge). */
      const rosterTemplate = (): string =>
        `minmax(0, 1fr) ${rosterColumns()
          .map((c) => c.width)
          .join(" ")} 6ch${aiColOn.value ? " 6ch" : ""}`;
      const colTitle = (label: string, list: typeof rows.value) => {
        const title = <span class="replay-view__postbattle-col-name">{label}</span>;
        const cols = rosterColumns();
        /** One column's aggregate label — the aggregate flavor wording on
         *  global columns (weighted/plain team WR etc.), the column's own
         *  head (scope tag + metric) on scoped ones. */
        const labelOf = (col: RosterColumnSpec): string => {
          if (col.scope !== "global") return col.head;
          if (col.metric === "winrate") {
            return t(
              prefs.value.weightedTeamWr
                ? "replay.roster.teamWrWeighted"
                : "replay.roster.teamWrPlain",
            );
          }
          if (col.metric === "pr") return t("replay.roster.teamAvgPr");
          if (col.metric === "battles") return t("replay.roster.battles");
          if (col.metric === "kd") return t("replay.roster.metricKd");
          return t("replay.postbattle.avgDamage");
        };
        const valueOf = (col: RosterColumnSpec, cls = "replay-view__postbattle-col-hval"): VNode => {
          const agg = teamAggFor(col.scope, list);
          if (col.metric === "winrate") {
            return (
              <b
                class={cls}
                style={agg.winrate != null ? { color: winrateColor(agg.winrate) } : undefined}
              >
                {agg.winrate != null ? `${agg.winrate.toFixed(1)}%` : "—"}
              </b>
            );
          }
          if (col.metric === "pr") {
            // The unicum band keeps its rainbow (彩表) face like every
            // other PR rendering.
            const band = prTier(agg.avgPr);
            return (
              <b
                class={[cls, band.rainbow ? "rainbow-text" : undefined]}
                style={band.rainbow ? undefined : { color: band.color }}
              >
                {agg.avgPr != null ? Math.round(agg.avgPr) : "—"}
              </b>
            );
          }
          if (col.metric === "battles") {
            return (
              <b
                class={cls}
                style={
                  col.scope === "global" && agg.avgBattles != null
                    ? { color: battlesColor(agg.avgBattles) }
                    : undefined
                }
              >
                {agg.avgBattles != null ? Math.round(agg.avgBattles).toLocaleString() : "—"}
              </b>
            );
          }
          if (col.metric === "kd") {
            return (
              <b class={cls}>{agg.avgKd != null ? agg.avgKd.toFixed(2) : "—"}</b>
            );
          }
          return (
            <b
              class={cls}
              style={agg.avgDamage != null ? { color: damageColor(agg.avgDamage) } : undefined}
            >
              {agg.avgDamage != null ? Math.round(agg.avgDamage).toLocaleString() : "—"}
            </b>
          );
        };
        // BOTH densities share ONE two-line mini table header on a grid
        // mirroring the row columns (rosterColumns + the XP cell), so each
        // aggregate number lands exactly on its column — the full card's
        // right-block data line renders the same columns (2026-11-07
        // review: the full header used to squeeze its aggregates into one
        // inline run and none of them sat over the row numbers). Every stat
        // column carries a label and a team mean (battles included); the XP
        // cell carries the 经验 caption WITHOUT a value — a per-battle
        // result has no team aggregate, but the last number needs a name.
        const template = rosterTemplate();
        const fill = <span class="replay-view__postbattle-col-hfill" />;
        // The AI column's header: the caption over the team mean of the
        // joined rows (a dash when nothing joined — the column itself only
        // renders with the switch on and a landed report).
        const aiMean = aiTeamMean(list);
        return (
          <div
            class={[
              "replay-view__postbattle-col-title",
              "replay-view__postbattle-col-title--agg",
              // Right-edge compensation so the header grid sits over the
              // columns below: rows spend width on the mask eye alone (22px
              // + gaps + the button's right padding). The career-seal column
              // is retired — the faces ride the identity line now — so one
              // pad covers both densities.
              "replay-view__postbattle-col-title--pad-eye",
            ]}
            style={{ gridTemplateColumns: template }}
          >
            {title}
            {cols.map((c) => (
              <span class="replay-view__postbattle-col-hlbl">{labelOf(c)}</span>
            ))}
            <span class="replay-view__postbattle-col-hlbl">
              {t("replay.postbattle.xp")}
            </span>
            {aiColOn.value ? (
              <span class="replay-view__postbattle-col-hlbl">
                {t("replay.postbattle.aiScore")}
              </span>
            ) : null}
            {cols.map((c) => valueOf(c))}
            {fill}
            {aiColOn.value ? (
              <b class="replay-view__postbattle-col-hval">
                {aiMean != null ? formatAiPct(aiMean) : "—"}
              </b>
            ) : null}
          </div>
        );
      };
      /** Career verdict for one row — null while its stats load or a
       *  hidden profile's clan verdict is pending (the same hold the live
       *  panel keeps). */
      const stampOf = (p: (typeof rows.value)[number]): CareerStamp | null => {
        const stat = isAiName(p.name) ? undefined : nameStats.value.get(p.name);
        return stat &&
          !stat.loading &&
          !(stat.hidden && stat.clanId != null && stat.clanWinrate === undefined)
          ? careerStamp(stat.pr, stat.battles, stat.winrate, stat.hidden, stat.clanWinrate)
          : null;
      };
      /** The row's division letter (组队标签), or null for a solo row — the
       *  tag face and the row hint read this one lookup. */
      const divisionLetterOf = (p: (typeof rows.value)[number]): string | null =>
        (isEnemy(p) ? enemyDivisionLetters : allyDivisionLetters).value.get(p.name) ?? null;
      /** The identity-line seal kinds for one row — the career verdict FIRST,
       *  the composition tags after, all pressed as the SMALL-TAG StampTag
       *  face BEFORE the nickname (user feedback: the roster wants the
       *  small-tag version of the 猴 seal, and the identity line is where it
       *  belongs — the retired row-end column read as one more score column
       *  and stole a track from the stat cells). The gates are the ones the
       *  faces always carried: zh UI only, the seals master switch (career),
       *  the verdict holds in stampOf, the 蛆 / 过街老鼠 floors suppressing the
       *  composition, and the per-kind kill switch.
       *
       *  BOTH densities press EVERY seal the row owns (2026-11-07 review: a
       *  tag must always show whole — the old one-tag cap either clipped the
       *  trailing tag mid-glyph or hid it behind a marker; the row gives the
       *  identity line its width and lets the nick ellipsize instead, and the
       *  hover hint repeats the whole list). Air precedes sub, matching the
       *  order the composition tags always read in. */
      const sealTagKindsOf = (p: (typeof rows.value)[number]): StampKind[] => {
        if (!uiLocale.value.startsWith("zh")) return [];
        const kinds: StampKind[] = [];
        const career = sealsShown.value ? stampOf(p) : null;
        if (career) kinds.push(career);
        if (compSealsOn.value && career !== "maggot" && career !== "rat") {
          const comp = compositions.value.get(p.name);
          if (comp) {
            if (comp.air) kinds.push(comp.airVeteran ? "airVeteran" : "air");
            if (comp.sub) kinds.push(comp.subVeteran ? "subVeteran" : "sub");
          }
        }
        // Per-kind kill switch: StampTag would skip a disabled face itself,
        // but the row hint reads this helper too — filter here so the hint can
        // never advertise a face the row does not paint.
        return kinds.filter((kind) => !prefs.value.sealDisabled[kind]);
      };
      /** The row's seal tags as the small-tag faces — the ONE cluster both
       *  densities paint (the full card stacks it on its own line; a compact
       *  row keeps it on the name line). */
      const identitySealsOf = (
        p: (typeof rows.value)[number],
        full: boolean,
      ): VNode | null => {
        const kinds = sealTagKindsOf(p);
        if (kinds.length === 0) return null;
        return (
          <span
            class={
              full
                ? "replay-view__postbattle-fcell-seals"
                : "replay-view__postbattle-cell-seals"
            }
          >
            {kinds.map((kind) => (
              <StampTag kind={kind} />
            ))}
          </span>
        );
      };
      /** One row's hover hint — the complete identity in the lines the row
       *  itself can only ellipsize: (1) the clan-tagged nickname, (2) every
       *  tag one by one (the division tag, the local marker, each seal — the
       *  four-char composition tags included), (3) the ship tier and name.
       *  The global hint popup keeps the supplied newlines (pre-line), and
       *  the nickname rides maskOf so a hidden nick never leaks by hover. */
      const rowHintOf = (
        p: (typeof rows.value)[number],
        color: MarkerColor | null,
      ): string => {
        const ai = isAiName(p.name);
        const tags: string[] = [];
        const letter = divisionLetterOf(p);
        if (letter != null) {
          tags.push(t("replay.postbattle.divisionTag", { letter }));
        }
        if (color != null) tags.push(markerColorLabel(color));
        for (const kind of sealTagKindsOf(p)) {
          tags.push(stampWording(kind, prefs.value.sealLabels));
        }
        if (ai) tags.push(t("replay.bot"));
        return rosterRowHint({
          name: masking.maskOf(p.name),
          clanTag: ai ? null : (nameStats.value.get(p.name)?.clanTag ?? null),
          tags,
          tier: tierLabelOf(p),
          shipName: p.shipName,
        });
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
        const color = ai ? null : markers.colorOf(p.name, p.accountId);
        return (
          <div
            class={[
              "replay-view__postbattle-cell",
              p.alive ? "" : "replay-view__postbattle-cell--dead",
              p.accountId === pb.selfId ? "replay-view__postbattle-cell--self" : "",
            ]}
            key={p.accountId}
          >
            {/* The whole row minus the eye is the drill-down button: hover,
                clicks and the complete identity hint all ride it, while the
                eye stays a sibling (a direct hover there keeps its own
                mask-toggle hint instead of the row card). */}
            <button
              class="replay-view__postbattle-cell-btn"
              type="button"
              data-hint={rowHintOf(p, color)}
              data-player-name={ai ? undefined : p.name}
              data-player-account={p.accountId != null ? String(p.accountId) : undefined}
              data-player-realm={p.realm ?? undefined}
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
                  {/* The division tag (组队标签) leads the line — battle fact
                      first — then EVERY seal the row owns as small-tag faces
                      (2026-11-07 review: a tag never clips or hides; the nick
                      below ellipsizes instead, and the row hint carries the
                      complete text). */}
                  {divisionTagOf(p)}
                  {identitySealsOf(p, false)}
                  {/* Local player marker (玩家标记): the name itself carries
                      the animated tint — nickname-first, account id sharpens.
                      The marker's wording rides the row hint. */}
                  <span
                    class={["replay-view__postbattle-cell-nick", markerTintClass(color)]}
                  >
                    {masking.maskOf(p.name)}
                  </span>
                  {/* Karma (业力) superscript at the nickname's top-right —
                      same register as the live panel's rows (the stats
                      prefs' own switch; missing figures render nothing). */}
                  {prefs.value.rosterKarmaEnabled ? (
                    <KarmaSup value={stat?.karma ?? null} class="replay-view__postbattle-cell-karma" />
                  ) : null}
                  {stat?.clanTag ? (
                    <span class="replay-view__postbattle-cell-clan">[{stat.clanTag}]</span>
                  ) : null}
                  {ai ? <em class="replay-view__postbattle-bot">{t("replay.bot")}</em> : null}
                </span>
                <span class="replay-view__postbattle-cell-sub">
                  <span class="replay-view__postbattle-cell-tier">{tierLabelOf(p)}</span>
                  <span class="replay-view__postbattle-cell-ship">{p.shipName}</span>
                </span>
              </span>
              {rosterStatCols(
                p.name,
                nameStats.value,
                // Per-row loading only (the global load no longer gates
                // arrived rows): an absent entry is itself the spinner —
                // every queried name settles into the map when it lands.
                Boolean(shipScopeOn.value && nameStats.value.get(p.name)?.shipsLoading),
                (st, scope) => colViewOf(scope, st, p.shipId ?? null),
              )}
              <span class="replay-view__postbattle-cell-xp">
                {p.xp.toLocaleString()}
              </span>
              {aiColOn.value ? (
                <span class="replay-view__postbattle-cell-ai" data-hint={aiTipOf(p)}>
                  {aiCellBody(p)}
                </span>
              ) : null}
            </button>
            {ai ? null : eyeBtn(p.name)}
          </div>
        );
      };
      /** Full-card row — the richer density reads as the compact hover hint's
       *  three lines on the left (clan-tagged nick / every tag one by one /
       *  ship tier + name) and a right block that stacks the compact row's
       *  aligned data line (the configured columns, XP, then the AI score)
       *  over the LiveShipMeta strip's two ship lines. The header above is
       *  the compact two-line grid in both densities, so this data line lands
       *  on the aggregate columns' tracks. Like the compact row, the whole
       *  card minus the eye is one button (hover/click/hint alike). */
      const fullCell = (p: (typeof allies.value)[number]) => {
        const enemy = !props.operation && isEnemy(p);
        const ai = isAiName(p.name);
        const stat = ai ? undefined : nameStats.value.get(p.name);
        const color = ai ? null : markers.colorOf(p.name, p.accountId);
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
              style={{ gridTemplateColumns: rosterTemplate() }}
              data-player-name={ai ? undefined : p.name}
              data-player-account={p.accountId != null ? String(p.accountId) : undefined}
              data-player-realm={p.realm ?? undefined}
              onClick={() => openDetail(p)}
            >
              {/* Left: the three identity lines the compact row can only put
                  in its hover hint — nick + clan, every tag, then the ship.
                  The hint anchors HERE, not on the whole button: the ship
                  strip's own hover card owns the card's right block, and two
                  popups must never stack. */}
              <span
                class="replay-view__postbattle-fcell-main"
                data-hint={rowHintOf(p, color)}
              >
                <span class="replay-view__postbattle-fcell-name">
                  {divisionTagOf(p)}
                  <span
                    class={["replay-view__postbattle-fcell-nick", markerTintClass(color)]}
                  >
                    {masking.maskOf(p.name)}
                  </span>
                  {prefs.value.rosterKarmaEnabled ? (
                    <KarmaSup value={stat?.karma ?? null} class="replay-view__postbattle-fcell-karma" />
                  ) : null}
                  {stat?.clanTag ? (
                    <span class="replay-view__postbattle-fcell-clan">[{stat.clanTag}]</span>
                  ) : null}
                  {ai ? <em class="replay-view__postbattle-bot">{t("replay.bot")}</em> : null}
                </span>
                {/* Line 2: EVERY seal the row owns, one by one. */}
                {identitySealsOf(p, true)}
                <span class="replay-view__postbattle-fcell-ship">
                  <span class="replay-view__postbattle-fcell-tier">{tierLabelOf(p)}</span>
                  <span class="replay-view__postbattle-fcell-shipname">{p.shipName}</span>
                </span>
              </span>
              {/* Right: the data line (the compact row's aligned columns, so
                  the header's aggregates sit right above them) over the ship
                  strip's two lines. The strip owns the whole right block now,
                  so its parameters/badges render as fully as the column
                  allows instead of being squeezed into a narrow middle. */}
              <span class="replay-view__postbattle-fcell-side">
                <span class="replay-view__postbattle-fcell-data">
                  {rosterStatCols(
                    p.name,
                    nameStats.value,
                    Boolean(shipScopeOn.value && nameStats.value.get(p.name)?.shipsLoading),
                    (st, scope) => colViewOf(scope, st, p.shipId ?? null),
                  )}
                  <span class="replay-view__postbattle-cell-xp">
                    {p.xp.toLocaleString()}
                  </span>
                  {aiColOn.value ? (
                    <span class="replay-view__postbattle-cell-ai" data-hint={aiTipOf(p)}>
                      {aiCellBody(p)}
                    </span>
                  ) : null}
                </span>
                <span class="replay-view__postbattle-fcell-meta">
                  {p.shipId != null ? (
                    <LiveShipMeta
                      shipId={p.shipId}
                      ally={!enemy}
                      build={enemy ? null : buildOf(p.name, p.shipId)}
                    />
                  ) : null}
                </span>
              </span>
            </button>
            {ai ? null : eyeBtn(p.name)}
          </div>
        );
      };
      const rowOf = fullMode.value ? fullCell : cell;
      const sel = selected.value;
      const enemyRows = props.operation ? [] : enemies.value;
      /** The killer attribution line — pre-text + killer chip + post-text
       *  (word order varies per locale). The chip carries the killer's
       *  white class icon and ship name; when the killer sits in this
       *  roster it renders as one button that swaps this modal to the
       *  killer's own stats (scripted NPCs have no stats window — their
       *  chip stays plain text, the ship name IS the display name). */
      const killedLine = (() => {
        if (!sel || sel.alive || !sel.killerName) return null;
        // A self-kill (beached, detonation) has its id as the killerId —
        // this modal already IS that player's stats window, so the chip
        // stays plain text instead of a re-opening button.
        const killerRow =
          sel.killerId != null && sel.killerId !== sel.accountId
            ? rows.value.find((r) => r.accountId === sel.killerId) ?? null
            : null;
        const ship =
          sel.killerShipId != null
            ? shipNameFromOfflineDb(sel.killerShipId, dataLanguage.value)
            : null;
        const chip = (
          <>
            {masking.maskOf(sel.killerName)}
            {sel.killerShipId != null ? (
              <BattleIcon
                type={shipOfflineEntry(sel.killerShipId)?.type ?? ""}
                variant="white"
                size={16}
              />
            ) : null}
            {killerRow && ship ? (
              <em class="replay-view__postbattle-killed-ship">{ship}</em>
            ) : null}
          </>
        );
        return (
          <div class="replay-view__postbattle-killed">
            {t("replay.postbattle.destroyedByPre")}
            {killerRow ? (
              <button
                class="replay-view__postbattle-killed-btn"
                type="button"
                data-hint={t("replay.postbattle.killerJump")}
                aria-label={t("replay.postbattle.killerJump")}
                onClick={() => openDetail(killerRow)}
              >
                {chip}
              </button>
            ) : (
              <span class="replay-view__postbattle-killed-plain">{chip}</span>
            )}
            {t("replay.postbattle.destroyedByPost")}
          </div>
        );
      })();
      return (
        <div class="replay-view__postbattle" ref={root}>
          <PostBattleShareBar
            hideAll={masking.hideAll.value}
            shotBusy={shot.busy.value}
            showModeToggle
            showAiSort
            fullMode={fullMode.value}
            view={props.stream ? view.value : undefined}
            onToggleAll={() => masking.toggleAll()}
            onShot={() => {
              // Either view copies the ONE combined sheet — both teams'
              // matrix (the AI column included when its switch is on)
              // above the personal banner; without a self model the matrix
              // alone still copies, exactly as before.
              void shot.copyShot();
            }}
            onToggleMode={toggleFullMode}
            onSetView={(v) => (view.value = v)}
          />
          {view.value === "self" ? (
            <div class="replay-view__postbattle-self">
              {selfModel.value ? (
                <SelfReportBody model={selfModel.value} maskOf={masking.maskOf} />
              ) : (
                <p class="replay-view__postbattle-self-empty">
                  {t("replay.postbattle.selfUnavailable")}
                </p>
              )}
            </div>
          ) : (
            <div
              class={[
                "replay-view__postbattle-matrix",
                { "replay-view__postbattle-matrix--single": enemyRows.length === 0 },
              ]}
            >
              {/* Rows stack inside the inner wrapper (the same
                  .replay-view__postbattle-col__inner the replay view's own
                  fallback matrix renders): a 4px pitch separates the row
                  plates, so each row reads as its own item and the hover
                  highlight's rounding has the dark ground it needs to show
                  (user feedback: 项目之间应有一点距离、圆角一致 — the flush
                  strip read as one slab and the highlight bled into the
                  neighbours). */}
              <div class="replay-view__postbattle-col__inner">
                {colTitle(t("replay.roster.allies"), allies.value)}
                {allies.value.map(rowOf)}
              </div>
              {enemyRows.length > 0 ? (
                <div class="replay-view__postbattle-col__inner">
                  {colTitle(t("replay.roster.enemies"), enemyRows)}
                  {enemyRows.map(rowOf)}
                </div>
              ) : null}
            </div>
          )}

          {/* Level-2 modal: player detail — a first-class hikari window
              (issue #1736 P2 wave item 4): HkModal owns the chrome (unified
              window-close, Esc, focus trap, back guard, overlay-root
              teleport, phone sheet docking) — previously a hand-rolled fixed
              overlay with a hardcoded z-index nested inside this level-1
              modal's own subtree. The window stays mounted through the leave
              transition (the slots gate on `sel`; HkModal's contentHold
              serves the last frame mid-fold) and the head/body markup keeps
              the shared detail classes the two ReplayView siblings ride. */}
          <HkModal
            modelValue={detailOpen.value}
            onUpdate:modelValue={(v: boolean) => (detailOpen.value = v)}
            surfaceTitle={sel ? masking.maskOf(sel.name) : undefined}
            width="min(560px, 90vw)"
            contentClass="replay-view__postbattle-detail"
            footerActions={
              sel
                ? [
                    {
                      label: t("replay.postbattle.fullStats"),
                      variant: "outline" as const,
                      onClick: jumpToLookup,
                    },
                  ]
                : undefined
            }
          >
            {{
              headerLead: sel
                ? () => (
                    <span class="replay-view__postbattle-detail-head">
                      <span
                        class={[
                          "replay-view__postbattle-detail-ico",
                          !sel.alive && "replay-view__postbattle-detail-ico--dead",
                        ]}
                      >
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
                  )
                : undefined,
              // HkModal's built-in .hk-modal-body-scroll owns scrolling —
              // the inner HkScrollContainer retired with the bespoke chrome.
              default: () =>
                sel ? (
                  <>
                    {killedLine}
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
                  </>
                ) : null,
            }}
          </HkModal>
        </div>
      );
    };
  },
});
