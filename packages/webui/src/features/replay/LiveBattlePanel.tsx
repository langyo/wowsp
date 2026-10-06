/**
 * Live-battle panel (the /live page body). Shows the current battle's mode,
 * map, roster with per-player WR / PR (fetched via the shared roster batch
 * pipeline — see `composables/useRosterStats.ts`) and the elapsed battle
 * clock. Every row's middle ground carries the ship's combat card
 * (`LiveShipMeta` — tier, class, nation, parameter ranges, and on ally rows
 * the consumable/module/flag summary); hovering it floats the condensed ship
 * card. The ship name leads with the game's class battle icon, and — per a
 * stats pref, default on — every row washes with its player's PR-tier color
 * (red band red, purple band purple; see prTintVars). The full card's stat
 * strip (`LiveStatLine`) spans the whole card bottom so the WR/PR/battles
 * line reads in full instead of ellipsizing inside the name track. The
 * panel's head title is the /live page title (the view itself has
 * no header — it used to duplicate this one).
 *
 * The head's density toggle compresses the roster to the post-battle
 * matrix's one-line rows (battle icon + the shared WR/PR/battles/
 * avg-damage columns, ship-meta strip dropped) — a persisted stats pref, the mirror of
 * the post-battle panel's own full-card expansion.
 *
 * Every human card is clickable and jumps to the lookup (水表) view for that
 * player; hidden profiles show a red notice instead of a fake "no data".
 * Each column title additionally carries the team's aggregate per the
 * chip toggles — all over the players whose stats landed, in the roster's
 * resolved stats-source view. Compact mode aligns it onto the stat columns:
 * the title becomes a two-line mini table header (a per-column label over a
 * per-column mean — winrate / PR / battles / avg damage, exactly the shared
 * rosterColumns() grid) so every average sits on its own column; the full
 * cards have no aligned columns, so their aggregate rides the title's right
 * end as inline text.
 *
 * The head also carries the share actions: a copy-share-shot button (the
 * roster painted onto a watermarked PNG, same pipeline as the post-battle
 * panels) and a hide-all-nicknames toggle. Masking is ephemeral share-time
 * state, not a pref — masked nicks never reach the copied image either.
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
import {
  Camera,
  Eye,
  EyeOff,
  LocateFixed,
  Plug,
  RefreshCw,
  Rows2,
  Rows3,
  ScanEye,
  Unplug,
  X,
} from "@lucide/vue";
import { useToast } from "@celestia-island/hikari";

import type { ArenaInfo, OverlayStatus, VehicleEntry } from "@/api";
import { api } from "@/api";
import BattleIcon from "@/components/base/BattleIcon";
import { useAccountStore } from "@/stores/account";
import { useIngamePluginStore } from "@/stores/ingamePlugin";
import { useOverlayConfigStore } from "@/stores/overlayConfig";
import { useLanguage } from "@/i18n/useLanguage";
import { t } from "@/i18n";
import { shipNameFromOfflineDb, shipOfflineEntry } from "@/features/holographic/modelLoader";
import { displayMapName } from "@/utils/mapNames";
import { orderForTab, type TabOrderedVehicle } from "./liveTabOrder";
import LiveShipMeta from "./LiveShipMeta";
import LiveStatLine from "./LiveStatLine";
import LiveStatsModeChip from "./LiveStatsModeChip";
import MapNameTag from "./MapNameTag";
import PluginStatusCard from "./PluginStatusCard";
import { WaitingRadarArt } from "./liveGuideArt";
import {
  rosterColumns,
  rosterShotCells,
  rosterShotColIndex,
  rosterShotDashes,
  rosterStatCols,
  useNickMasking,
  useShareShot,
  type RosterColumnSpec,
} from "./postBattleShare";
import type { ShotColumn, ShotModel, ShotRow, ShotStat } from "./postBattleShot";
import { isOperationBattle, modeColor, modeKey } from "@/utils/modeColors";
import { splitLiveRosterSides } from "@/utils/rosterSides";
import {
  battlesColor,
  careerStamp,
  damageColor,
  prTier,
  winrateColor,
} from "@/utils/winrate";
import { shipTierOf } from "@/utils/shipClass";
import {
  dimsNeedShipStats,
  resolveRosterBattleScope,
  rosterDimsOf,
  type ResolvedStatsMode,
} from "@/utils/statView";
import { scopedRosterView } from "@/utils/shipStatsScope";
import { aggregateTeamStats } from "@/utils/teamAggregate";
import { prAlgoForRequest, useStatsPrefsStore } from "@/stores/statsPrefs";
import { useManualLocateStore } from "@/stores/manualLocate";
import { useRosterStats, isAiName, type RosterStat } from "@/composables/useRosterStats";
import { SunkTracker, type SunkSide } from "@/utils/sunkTracker";
import { useBattleClock } from "./useBattleClock";
import RatingStamp from "@/components/base/RatingStamp";
import { HkSpinner } from "@celestia-island/hikari";
import "./LiveBattlePanel.scss";

/** Stable refusal codes from `start_manual_locate` → the replay.live.*
 *  copy toasted next to the button shake. Module-level: the mapping is
 *  pure data, no per-instance state. */
const MANUAL_REFUSAL_KEYS: Record<string, string> = {
  "no-battle": "replay.live.manualNoBattle",
  "no-game": "replay.live.manualNoGame",
  "no-frame": "replay.live.manualNoFrame",
};

/** Localize a battle mode from its layered identity (matchGroup / scenario /
 *  battle script / roster bots). */
function modeLabelOf(
  group?: string | null,
  scenario?: string | null,
  eventType?: string | null,
  botCount = 0,
  scriptedUnitCount = 0,
): string {
  const key = modeKey(group, scenario, eventType, botCount, scriptedUnitCount);
  if (!key) return t("replay.mode._fallback");
  const i18nKey = "replay.mode." + key;
  const lbl = t(i18nKey);
  return lbl === i18nKey ? t("replay.mode._fallback") : lbl;
}

export default defineComponent({
  name: "LiveBattlePanel",
  props: {
    arena: { type: Object as () => ArenaInfo | null, default: null },
    /** Battle-end signal: a fresh .wowsreplay appeared in the replays dir
     *  (the game writes the file when the battle ends) — the battle is on
     *  the results screen, stats final but replay still settling. */
    settling: { type: Boolean, default: false },
    /** The battle is over for good (the game deleted tempArenaInfo.json —
     *  returned to port or quit): the roster on screen is the LAST battle's,
     *  kept until the next one starts. Renders the "battle ended" badge in
     *  place of LIVE/settling and retires the elapsed clock. */
    ended: { type: Boolean, default: false },
    /** Realm the battle is played on (from the active client install);
     *  used for both the stats lookup and the lookup-view jump. */
    realm: { type: String, default: "" },
  },
  setup(props) {
    const accounts = useAccountStore();
    const router = useRouter();
    const prefs = useStatsPrefsStore();
    /** Roster density: full cards (the default) or the post-battle matrix's
     *  compact one-line rows — a persisted stats pref flipped from the
     *  head's density toggle. */
    const compact = computed(() => prefs.prefs.liveRosterCompact);
    const manualLocate = useManualLocateStore();
    const toast = useToast();
    const { dataLanguage } = useLanguage();
    // Declared BEFORE useRosterStats below: the composable's watches run
    // their getters synchronously at registration, and the `realms` option
    // closes over this store — a later declaration would be a TDZ throw
    // that unmounts the whole panel.
    const plugin = useIngamePluginStore();
    const { label: clockLabel } = useBattleClock(
      () => props.arena?.dateTime ?? null,
    );

    const realm = computed(
      () => props.realm || accounts.activeRealm || "asia",
    );

    /** Clan Battles can be cross-server (军团战跨服): the live arena file
     *  carries no realm per player, so the batch probes the other WG
     *  clusters for names the home one cannot explain. Same semantics as
     *  modeKey's clan bucket (utils/modeColors: matchGroup containing
     *  "clan"). */
    const crossRealm = () =>
      (props.arena?.matchGroup ?? "").toLowerCase().includes("clan");

    const { stats, forceRefresh } = useRosterStats({
      realm: () => realm.value,
      arena: () => props.arena,
      crossRealm,
      // The probe's ground-truth per-name realms (straight off the game's
      // roster records): names found here resolve on THEIR cluster — the
      // cross-realm pass only remains for rows the probe could not report
      // (older build / roster mode without the plugin).
      realms: () => (plugin.installed ? plugin.playerRealms : null),
    });

    /** Realm chip for a row whose stats resolved on ANOTHER cluster
     *  (cross-server CW) — same vocabulary as the post-battle panels
     *  (replay.realm.*). Null on same-realm / unresolved rows. */
    const crossRealmTagOf = (
      st: { realm: string | null } | null | undefined,
    ): string | null => {
      const r = st?.realm;
      if (!r || r.toLowerCase() === realm.value.toLowerCase()) return null;
      return t(`replay.realm.${r.toLowerCase()}`) === `replay.realm.${r.toLowerCase()}`
        ? r.toUpperCase()
        : t(`replay.realm.${r.toLowerCase()}`);
    };

    // ── Share-time privacy + copy-shot (head actions) ───────────────────
    // The hide-nicknames toggle masks every roster nick on screen AND in
    // the copied share shot (the shot model reads already-masked names,
    // so a hidden nick cannot leak into the image). Like the post-battle
    // panels, the state is ephemeral — a share-time privacy choice.
    const masking = useNickMasking();
    const root = ref<HTMLElement | null>(null);
    const shot = useShareShot(buildShotModel, () => root.value);

    // Overlay detection state, streamed by the Rust Tab watcher as
    // transition-only `wowsp://overlay-status` events. Rendered as a badge
    // in the panel's head (right corner) next to the manual-locate button.
    // `null` = nothing received yet → show no badge (the button itself is
    // permanent — idle stretches between battles must not strand the
    // manual-locate entry point).
    const overlayStatus = ref<OverlayStatus | null>(null);
    let unlistenStatus: (() => void) | null = null;
    // Per-battle trusted sunk sets (sink-attrib events name WHO sank by
    // strip-fingerprint matching) — feed the predicted order below so the
    // columns mirror the game's [alive] ++ [sunk] layout live.
    const sunk = new SunkTracker();
    watch(
      () => props.arena?.dateTime ?? null,
      (stamp) => sunk.reset(stamp),
      { immediate: true },
    );
    // The tracker is plain state, so `sinkEpoch` is its reactive trigger:
    // every sink event bumps it and the computed orders below re-derive.
    const sinkEpoch = ref(0);
    /** Predicted-order key inputs for one side: locale + per-vehicle clan
     *  tag + that side's trusted sunk set. */
    const predictedOptionsFor = (side: "ally" | "enemy") => {
      void sinkEpoch.value;
      return {
        locale: dataLanguage.value,
        clanTagOf: (v: VehicleEntry) => stats.get(v.id)?.clanTag ?? null,
        sunk: sunk.sunkNames(side),
      };
    };
    // True once plugin telemetry has replaced the inferred sets this
    // battle: later luma attributions must not re-add names the plugin
    // reports alive (the plugin outranks the solver).
    let telemetryAuthoritative = false;
    let unlistenSinkAttrib: (() => void) | null = null;
    let unlistenTelemetry: (() => void) | null = null;
    /** Manual stats-refresh button state (approximate: the composable
     *  settles row spinners itself, the button just needs a cooldown). */
    const rosterRefreshing = ref(false);
    // Whether THIS battle is a real operation (行动) — PCVO*/_op_/_hl_
    // fingerprints, minus the tutorial family (low_lvl_operation /
    // first_battle / IDS_OP_15_*) that fields its scripted units as real
    // team rows. Decides the live side split below.
    const operation = computed(() =>
      isOperationBattle(
        props.arena?.matchGroup,
        props.arena?.scenario,
        props.arena?.eventType,
        props.arena?.vehicles.map((v) => v.name),
      ),
    );
    /** The battle's LIVE side split — scripted scenario NPCs (`IDS_*` /
     *  `#Name`) drop out of the ally block iff this is a real operation:
     *  the game's own Tab table renders the human team only there (the
     *  PCVO011_OP_10 story capture shows 7 human rows while the roster
     *  carries the 2 scripted allies `IDS_OP_10_09_GAMBLE` /
     *  `IDS_OP_10_10_BREEZE` — they used to leak as untranslated-key rows
     *  at the end of this panel's teammates column and mis-sliced the
     *  overlay's Tab row blocks). Every other battle keeps the raw
     *  relation split — the tutorial-family scripted fills really do render
     *  as team rows in-game. The Rust sink solver keys its ally-row count
     *  on the same rule (arena_info's note_arena_seen), so sink
     *  attributions stay index-aligned with the orders below.
     *  operations (行动) also empty the enemy side — all scripted spawns,
     *  a list nobody reads. */
    const liveSides = computed(() =>
      splitLiveRosterSides(props.arena?.vehicles ?? [], operation.value),
    );
    /** The side's believed alive order for resolving sink-attrib rows:
     *  the predicted key order minus the trusted sunk set. */
    const sideAliveOrder = (side: SunkSide): string[] => {
      const list = side === "enemy" ? liveSides.value.enemies : liveSides.value.allies;
      const order = orderForTab(list, predictedOptionsFor(side)).map(
        (e) => e.vehicle.name,
      );
      const names = sunk.sunkNames(side);
      return names ? order.filter((n) => !names.has(n)) : order;
    };
    onMounted(async () => {
      // The telemetry pill reads the persisted roster mode; the store is
      // lazy elsewhere on this surface.
      void overlayCfg.load();
      unlistenStatus = (await api.listenOverlayStatus((s) => {
        overlayStatus.value = s;
      })) as (() => void) | null;
      unlistenSinkAttrib = (await api.listenSinkAttribution((a) => {
        if (telemetryAuthoritative) return;
        sunk.applyAttribution(
          { ally: a.allyRows ?? [], enemy: a.enemyRows ?? [] },
          sideAliveOrder,
        );
        sinkEpoch.value += 1;
      })) as (() => void) | null;
      // In-game plugin telemetry — the priority-chain top when the roster
      // mode is "plugin": isAlive observed inside the client beats the
      // luma solver, and its sets REPLACE the inferred ones. Events while
      // the mode is off are ignored so the inference chain stays the sole
      // owner there.
      unlistenTelemetry = (await api.listenIngameTelemetry((payload) => {
        // Ground truth first, in every roster mode: the probe's identity
        // block (per-name realms + the local player's cluster) steers
        // stats routing even when alive-sets come from another source.
        plugin.applyTelemetryIdentity(payload);
        if (overlayCfg.roster !== "plugin" || !plugin.installed) return;
        if (!props.arena) return;
        // Stale file from a previous battle (game closed without a quit
        // event): the plugin clears players on quit, so an empty map IS a
        // reset; a fresh timestamp is required either way.
        if (Date.now() - payload.t > 30_000) {
          // Stale stream (plugin died mid-battle): release the lock so the
          // luma solver resumes instead of staying frozen forever.
          telemetryAuthoritative = false;
          return;
        }
        const ally = new Set<string>();
        const enemy = new Set<string>();
        const rosterNames = new Set<string>();
        // The live split's membership — the same convention as
        // sideAliveOrder and the Rust sink solver: a scripted unit a real
        // operation dropped never enters a side set here.
        const sides = liveSides.value;
        for (const [list, set] of [
          [sides.allies, ally],
          [sides.enemies, enemy],
        ] as const) {
          for (const v of list) {
            rosterNames.add(v.name);
            if (payload.players[v.name] === false) set.add(v.name);
          }
        }
        telemetryAuthoritative = true;
        sunk.applyNamedSunk({ ally, enemy }, rosterNames);
        sinkEpoch.value += 1;
      })) as (() => void) | null;
    });
    onBeforeUnmount(() => {
      unlistenStatus?.();
      unlistenStatus = null;
      unlistenSinkAttrib?.();
      unlistenSinkAttrib = null;
      unlistenTelemetry?.();
      unlistenTelemetry = null;
      if (shakeTimer) {
        clearTimeout(shakeTimer);
        shakeTimer = null;
      }
    });

    const statusBadge = computed(() => {
      const s = overlayStatus.value;
      if (!s) return null;
      // A manual anchor stays ARMED across Idle/Searching (Rust marks every
      // automatic report manual:true while it is stored): the badge must
      // survive those transitions too, since the anchor re-anchors on the
      // same battle's next Tab hold. (The clear button itself is permanent
      // regardless — see the head markup below.)
      if (s.manual) {
        return { cls: "manual", spin: false, text: t("replay.live.manualRows", { n: s.rows ?? 0 }) };
      }
      if (s.state === "idle") return null;
      if (s.state === "detected") {
        return {
          cls: "detected",
          spin: false,
          text: t("replay.live.detectedRows", { n: s.rows ?? 0 }),
        };
      }
      // Searching/fallback are settling states — carry the same inline
      // spinner the loading roster rows use (HkSpinner, currentcolor tone).
      return { cls: "searching", spin: true, text: t("replay.live.searching") };
    });

    /** A manual anchor is in force: the badge turns green and the button
     *  flips from "manual locate" to "clear locate". */
    const manualActive = computed(() => overlayStatus.value?.manual === true);

    // ── Telemetry-source grade (the head's state pill) ───────────────────
    // "plugin" roster mode + the PnFMods bridge installed = full precision
    // (the exact TAB order arrives from inside the client); the mode picked
    // but the plugin absent degrades to the screen-capture inference and
    // the pill says so — staged per the owner's spec. Until the M2 bridge
    // consumer lands, a connected plugin renders the same order as
    // inference; the pill already reflects the source, not the pipeline.
    const overlayCfg = useOverlayConfigStore();
    const telemetryGrade = computed<"plugin" | "incomplete" | "infer">(() => {
      if (overlayCfg.roster !== "plugin") return "infer";
      // An outdated build predates telemetry.json — it is "installed" but
      // will never emit, so it grades as not-connected until updated.
      return plugin.installed && !plugin.outdated ? "plugin" : "incomplete";
    });

    /** Manual-locate entry point: opens the cached-frame picker layer inside
     *  the main window (ManualLocateOverlay, after the backend gates pass),
     *  or (when a manual anchor is already in force) clears it back to the
     *  automatic detection flow. */
    const manualBusy = ref(false);
    /** Short shake when the backend refuses to open the picker — visible
     *  feedback, never silent. The refusal ALSO toasts the localized reason:
     *  stable gate codes (see MANUAL_REFUSAL_KEYS) map onto replay.live.*,
     *  anything else surfaces raw so nothing is ever swallowed. NOTE: the
     *  transport wraps invoke rejections into an `RpcError` (message = the
     *  backend string), so the code must be read off `.message`. */
    const manualShake = ref(false);
    let shakeTimer: ReturnType<typeof setTimeout> | null = null;
    async function onManualButton() {
      if (manualBusy.value) return;
      manualBusy.value = true;
      try {
        if (manualActive.value) {
          await api.clearManualRosterRect();
        } else {
          await api.startManualLocate();
          manualLocate.openPicker();
        }
      } catch (err) {
        const code =
          typeof err === "string" ? err : ((err as Error | null)?.message ?? String(err));
        toast.warning(MANUAL_REFUSAL_KEYS[code] ? t(MANUAL_REFUSAL_KEYS[code]) : code);
        console.warn("[live-battle] manual locate refused:", err);
        manualShake.value = true;
        if (shakeTimer) clearTimeout(shakeTimer);
        shakeTimer = setTimeout(() => {
          manualShake.value = false;
          shakeTimer = null;
        }, 500);
      } finally {
        manualBusy.value = false;
      }
    }

    // Column ordering mirrors the in-game Tab table: the recognized row
    // order (when a Tab recognition pass exists for THIS battle) wins
    // verbatim — sunk-ship regrouping included, with sunk players dimmed —
    // and without one a predicted class-grouped order approximates the
    // game's layout far better than tempArenaInfo.json's join order.
    // The panel RENDERS one allies column for every operation-labeled
    // battle (the mode pill says 行动) — wider than `operation` above: the
    // new-account escort op keeps two-team relation semantics for the sink
    // solver and the overlay's Tab anchor, but its enemy block is all
    // scripted spawns (IDS_* dummies, escort waves) — an enemy list nobody
    // reads. Those battles hide the enemy column and center the allies one
    // (see the matrix SCSS); the share shot mirrors the same rule.
    const operationLabeled = computed(
      () =>
        operation.value ||
        modeKey(
          props.arena?.matchGroup,
          props.arena?.scenario,
          props.arena?.eventType,
          props.arena?.botCount ?? 0,
          props.arena?.scriptedUnitCount ?? 0,
        ) === "operation",
    );
    // The ally side: the live split's allies (scripted NPCs filtered iff
    // a real operation — see liveSides), ordered by the game's own Tab
    // key. Inputs for the predicted order's full Tab key come from
    // `predictedOptionsFor` above (locale + clan tag + that side's trusted
    // sunk set) — the orders re-derive reactively when the WG batch lands a
    // tag or a sink event bumps `sinkEpoch`.
    const allies = computed(() =>
      orderForTab(liveSides.value.allies, predictedOptionsFor("ally")),
    );
    // The enemy list: every operation-LABELED battle hides it (wider than
    // `operation` — the pill says 行动 there too, and the enemy block is
    // all scripted spawns nobody reads), while real two-team modes keep
    // the live split's enemy side.
    const enemies = computed(() =>
      orderForTab(
        operationLabeled.value ? [] : liveSides.value.enemies,
        predictedOptionsFor("enemy"),
      ),
    );

    function openLookup(name: string) {
      void router.push({ path: "/lookup", query: { name, realm: realm.value } });
    }

    /** The stats-source dimensions (ship scope / battle scope / solo
     *  filter — the persisted pref the head's mode tag and the settings
     *  both write) resolved for THIS battle: "follow" reads the battle's
     *  own mode (ranked battles read the ranked careers, everything else
     *  randoms). Every row number, the stat text lines, the team
     *  aggregates and the share shot resolve through the row view below. */
    const statsDims = computed(() => rosterDimsOf(prefs.prefs));
    const battleScope = computed<ResolvedStatsMode>(() =>
      resolveRosterBattleScope(statsDims.value.battle, props.arena ?? {}),
    );
    /** A ship-scoped dimension is on: rows then read the per-ship lists
     *  (attached by the roster pipeline) and their spinners additionally
     *  ride `shipsLoading`. */
    const shipScopeOn = computed(() => dimsNeedShipStats(statsDims.value));
    /** One row's display numbers under the full three-dimension model —
     *  the account-career path while the dims allow it, the aggregated
     *  per-ship view otherwise (see utils/shipStatsScope). */
    const rowViewOf = (
      st: RosterStat | null | undefined,
      shipId: number | null,
    ) =>
      scopedRosterView(
        st,
        shipId,
        statsDims.value,
        battleScope.value,
        prAlgoForRequest() ?? "winrate",
      );

    /** One team's header aggregate — tier-weighted (per the stats prefs)
     *  mean winrate plus plain mean PR / battles / avg damage over the
     *  players whose stats landed, all in the roster's resolved
     *  stats-source view. AI names, hidden profiles and still-loading rows
     *  sit out. */
    const teamAgg = (entries: TabOrderedVehicle[]) =>
      aggregateTeamStats(
        entries.map((entry) => {
          const v = entry.vehicle;
          const st = stats.get(v.id);
          if (
            !st ||
            st.loading ||
            (shipScopeOn.value && st.shipsLoading) ||
            st.hidden ||
            isAiName(v.name)
          ) {
            return {
              winrate: null,
              pr: null,
              battles: null,
              damage: null,
              tier: shipTierOf(v.shipId),
            };
          }
          const view = rowViewOf(st, v.shipId);
          return {
            winrate: view.winrate,
            pr: view.pr,
            battles: view.battles,
            damage: view.avgDamage,
            tier: shipTierOf(v.shipId),
          };
        }),
        prefs.prefs.weightedTeamWr,
      );

    /** The copy-shot model: the two-column roster as the share renderer
     *  sees it — same stats voice as the panel (WR, plus PR while the
     *  rating is on), nicks arriving already masked, ship parameters
     *  never included. */
    function buildShotModel(): ShotModel {
      const arena = props.arena;
      let mode: ShotModel["mode"] = null;
      if (arena?.matchGroup) {
        const c = modeColor(
          arena.matchGroup,
          arena.scenario,
          arena.eventType,
          arena.botCount ?? 0,
          arena.scriptedUnitCount ?? 0,
        );
        mode = {
          label: modeLabelOf(
            arena.matchGroup,
            arena.scenario,
            arena.eventType,
            arena.botCount ?? 0,
            arena.scriptedUnitCount ?? 0,
          ),
          color: c.color,
          background: c.background,
        };
      }
      /** One row's shot cells: the chip-gated columns of the roster's
       *  stats-source view — the exact columns the panel shows, dashes for
       *  bots / misses / still-loading rows. */
      const shotCellsOf = (v: VehicleEntry): ShotStat[] => {
        if (isAiName(v.name)) return rosterShotDashes();
        const st = stats.get(v.id);
        if (
          !st ||
          st.loading ||
          (shipScopeOn.value && st.shipsLoading) ||
          st.hidden
        ) {
          return rosterShotDashes();
        }
        return rosterShotCells(rowViewOf(st, v.shipId));
      };
      const mkCol = (entries: TabOrderedVehicle[], enemy: boolean): ShotColumn => {
        // Aggregate values carry their stat-column index so the shot's
        // header numbers right-align onto the cells below them.
        // The aggregate mirrors the panel's column title: each labeled
        // value follows its own chip toggle (PR additionally the rating
        // master) and right-aligns onto its column's origin.
        let agg: ShotColumn["agg"];
        {
          const parts: NonNullable<ShotColumn["agg"]> = [];
          const a = teamAgg(entries);
          const chips = prefs.prefs.overlayChips;
          if (chips.winrate) {
            parts.push({
              col: rosterShotColIndex("winrate"),
              label: t(
                prefs.prefs.weightedTeamWr
                  ? "replay.roster.teamWrWeighted"
                  : "replay.roster.teamWrPlain",
              ),
              value: a.winrate != null ? `${a.winrate.toFixed(1)}%` : "—",
              valueColor: a.winrate != null ? winrateColor(a.winrate) : undefined,
            });
          }
          if (prefs.prefs.prEnabled && chips.pr) {
            parts.push({
              col: rosterShotColIndex("pr"),
              label: t("replay.roster.teamAvgPr"),
              value: a.avgPr != null ? `${Math.round(a.avgPr)}` : "—",
              valueColor: a.avgPr != null ? prTier(a.avgPr).color : undefined,
            });
          }
          agg = parts.length > 0 ? parts : undefined;
        }
        return {
          title: enemy ? t("replay.roster.enemies") : t("replay.roster.allies"),
          agg,
          rows: entries.map((entry): ShotRow => {
            const v = entry.vehicle;
            return {
              nick: masking.maskOf(v.name),
              clanTag: stats.get(v.id)?.clanTag ?? null,
              shipName:
                shipNameFromOfflineDb(v.shipId, dataLanguage.value) ?? v.shipName ?? "",
              bot: isAiName(v.name),
              dim: entry.sunk,
              shipType:
                v.shipId != null ? (shipOfflineEntry(v.shipId)?.type ?? null) : null,
              iconVariant: entry.sunk
                ? "sunk"
                : v.relation === 0
                  ? "white"
                  : v.relation <= 1
                    ? "ally"
                    : "enemy",
              stats: shotCellsOf(v),
            };
          }),
        };
      };
      return {
        title: t("replay.live.title"),
        mode,
        mapLabel: arena?.mapName ? displayMapName(arena.mapName, dataLanguage.value) : null,
        botLabel: t("replay.bot"),
        // Mirror the DOM's single-column rule (operations hide the enemy
        // column, as does any single-sided roster edge).
        columns:
          enemies.value.length === 0
            ? [mkCol(allies.value, false)]
            : [mkCol(allies.value, false), mkCol(enemies.value, true)],
      };
    }

    /** A column title (我方/敌方) with the team aggregate. Full cards have
     *  no aligned stat columns, so the aggregate rides the title's right
     *  end as inline text — winrate while its chip is on, PR while the
     *  rating AND its chip are on, avg damage while its chip is on; the
     *  caption stays bare when none shows. Compact rows ARE aligned
     *  columns, so the title becomes the two-line mini table header: a
     *  per-column label over a per-column team mean on a grid mirroring
     *  the row's stat columns (rosterColumns()), every average landing
     *  exactly on its own column. Values carry their tier colors
     *  (winrateColor / prTier / battlesColor / damageColor). */
    const colTitle = (label: string, entries: TabOrderedVehicle[]) => {
      const title = <span class="live-battle__col-name">{label}</span>;
      const chips = prefs.prefs.overlayChips;
      const showWr = chips.winrate;
      const showPr = prefs.prefs.prEnabled && chips.pr;
      const showDmg = chips.damage;
      if (compact.value) {
        // The aligned header needs stat columns to sit on — with every
        // chip off the caption falls back to the bare title below.
        const cols = rosterColumns();
        if (cols.length > 0) {
          const agg = teamAgg(entries);
          const prBand = prTier(agg.avgPr);
          const labelOf: Record<RosterColumnSpec["key"], string> = {
            winrate: t(
              prefs.prefs.weightedTeamWr
                ? "replay.roster.teamWrWeighted"
                : "replay.roster.teamWrPlain",
            ),
            pr: t("replay.roster.teamAvgPr"),
            battles: t("replay.roster.battles"),
            damage: t("replay.postbattle.avgDamage"),
          };
          const valueOf: Record<RosterColumnSpec["key"], VNode> = {
            winrate: (
              <b
                class="live-battle__col-hval"
                style={
                  agg.winrate != null ? { color: winrateColor(agg.winrate) } : undefined
                }
              >
                {agg.winrate != null ? `${agg.winrate.toFixed(1)}%` : "—"}
              </b>
            ),
            pr: (
              <b class="live-battle__col-hval" style={{ color: prBand.color }}>
                {agg.avgPr != null ? Math.round(agg.avgPr) : "—"}
              </b>
            ),
            battles: (
              <b
                class="live-battle__col-hval"
                style={
                  agg.avgBattles != null
                    ? { color: battlesColor(agg.avgBattles) }
                    : undefined
                }
              >
                {agg.avgBattles != null
                  ? Math.round(agg.avgBattles).toLocaleString()
                  : "—"}
              </b>
            ),
            damage: (
              <b
                class="live-battle__col-hval"
                style={
                  agg.avgDamage != null ? { color: damageColor(agg.avgDamage) } : undefined
                }
              >
                {agg.avgDamage != null
                  ? Math.round(agg.avgDamage).toLocaleString()
                  : "—"}
              </b>
            ),
          };
          return (
            <div
              class={[
                "live-battle__col-title",
                "live-battle__col-title--agg",
                // Right-edge compensation: compact rows spend width on the
                // career-seal slot (36px + one flex gap) beyond the stat
                // columns whenever seals show — the header reserves the
                // same run so its columns land on the cells below.
                {
                  "live-battle__col-title--pad-seal":
                    prefs.prefs.prEnabled && prefs.prefs.sealsEnabled,
                },
              ]}
              style={{
                gridTemplateColumns: `minmax(0, 1fr) ${cols
                  .map((c) => c.width)
                  .join(" ")}`,
              }}
            >
              {title}
              {cols.map((c) => (
                <span class="live-battle__col-hlbl">{labelOf[c.key]}</span>
              ))}
              {cols.map((c) => valueOf[c.key])}
            </div>
          );
        }
      }
      if (!showWr && !showPr && !showDmg) {
        return <div class="live-battle__col-title">{title}</div>;
      }
      const agg = teamAgg(entries);
      const prBand = prTier(agg.avgPr);
      return (
        <div class="live-battle__col-title">
          {title}
          <span class="live-battle__col-agg">
            {showWr ? (
              <>
                {t(
                  prefs.prefs.weightedTeamWr
                    ? "replay.roster.teamWrWeighted"
                    : "replay.roster.teamWrPlain",
                )}{" "}
                <b
                  style={
                    agg.winrate != null ? { color: winrateColor(agg.winrate) } : undefined
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
                    agg.avgDamage != null ? { color: damageColor(agg.avgDamage) } : undefined
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
    };

    return () => {
      // Game running but no roster yet (or the roster just cleared): a
      // radar-scope waiting state — the roster loads itself the moment the
      // player enters a battle.
      if (!props.arena || props.arena.vehicles.length === 0) {
        return (
          <div class="live-battle live-battle--empty">
            <WaitingRadarArt class="live-battle__empty-art" />
            <p class="live-battle__empty-title">{t("replay.live.waitingTitle")}</p>
            <p class="live-battle__empty-hint">{t("replay.live.waitingHint")}</p>
            {/* Status-only plugin card: res_mods mutations are refused
                while the game runs, so no lifecycle buttons here — but the
                state (incl. the outdated warning) stays visible. */}
            <PluginStatusCard actions={false} />
          </div>
        );
      }

      const modePill = props.arena.matchGroup ? (
        <span
          class="live-battle__pill"
          style={
            modeColor(
              props.arena.matchGroup,
              props.arena.scenario,
              props.arena.eventType,
              props.arena.botCount ?? 0,
              props.arena.scriptedUnitCount ?? 0,
            ) as CSSProperties
          }
        >
          {modeLabelOf(
            props.arena.matchGroup,
            props.arena.scenario,
            props.arena.eventType,
            props.arena.botCount ?? 0,
            props.arena.scriptedUnitCount ?? 0,
          )}
        </span>
      ) : null;

      /** PR-tier row wash (a persisted stats pref, default on): rows whose
       *  resolved stats-source PR landed paint the whole entry with a
       *  translucent wash of the tier's color — red band red, purple band
       *  purple — in the SAME view the row's numbers read. The color rides
       *  CSS custom properties (not an inline background) so the row's own
       *  hover rule still brightens it; bots / loading / hidden / no-PR
       *  rows stay neutral. */
      const prTintVars = (
        st: RosterStat | null | undefined,
        shipId: number | null,
      ): CSSProperties | undefined => {
        if (!prefs.prefs.prEnabled || !prefs.prefs.liveRosterPrTint) return undefined;
        if (!st || st.loading || st.hidden || (shipScopeOn.value && st.shipsLoading)) {
          return undefined;
        }
        const pr = rowViewOf(st, shipId).pr;
        if (pr == null) return undefined;
        // prTier colors are "rgb(R G B)" strings — hand the row SCSS the raw
        // triplet plus the wash alpha it composes into rgb(… / a).
        return {
          "--row-tint": prTier(pr).color.slice(4, -1),
          "--row-tint-a": "0.14",
        } as CSSProperties;
      };

      // Compact mode reuses the post-battle matrix's row look verbatim —
      // including the shared rosterStatCols — so it needs a name-keyed view
      // of this panel's id-keyed stats. Rows still loading drop out of the
      // view (their columns then carry the spinner like every surface).
      const nameStats = new Map<string, RosterStat>();
      if (compact.value) {
        for (const v of props.arena.vehicles) {
          const st = stats.get(v.id);
          if (st && !st.loading) nameStats.set(v.name, st);
        }
      }
      /** One row's display numbers per the roster's resolved stats source
       *  (the shared columns render them) — scoped per the row's own ship
       *  while a ship-scoped dimension is on. */
      const viewOf = (st: RosterStat, shipId: number | null) => rowViewOf(st, shipId);

      /** One compact row: battle icon, nick/clan + ship stack, the shared
       *  WR/PR/battles/avg-damage columns and the career seal — one line, no
       *  ship-meta strip. The whole row is the lookup jump (hover and
       *  clicks cover the seal), sunk rows dim like the full cards. */
      const compactCell = (entry: TabOrderedVehicle) => {
        const v = entry.vehicle;
        const ai = isAiName(v.name);
        const st = ai ? null : stats.get(v.id);
        const shipName =
          shipNameFromOfflineDb(v.shipId, dataLanguage.value) ?? v.shipName ?? "";
        // Career seal — the full card's guard chain (verdict-pending hidden
        // profiles hold their stamp).
        const stamp =
          st &&
          !st.loading &&
          !(st.hidden && st.clanId != null && st.clanWinrate === undefined)
            ? careerStamp(st.pr, st.battles, st.winrate, st.hidden, st.clanWinrate)
            : null;
        const seal =
          stamp && prefs.prefs.prEnabled && prefs.prefs.sealsEnabled ? (
            <RatingStamp
              kind={stamp}
              size={26}
              variant="mini"
              class="live-battle__crow-stamp"
            />
          ) : null;
        const content = (
          <>
            <span class="live-battle__crow-ico">
              {v.shipId != null ? (
                <BattleIcon
                  type={shipOfflineEntry(v.shipId)?.type ?? ""}
                  variant={
                    entry.sunk
                      ? "sunk"
                      : v.relation === 0
                        ? "white"
                        : v.relation <= 1
                          ? "ally"
                          : "enemy"
                  }
                  size={20}
                />
              ) : null}
            </span>
            <span class="live-battle__crow-main">
              <span class="live-battle__crow-name">
                <span class="live-battle__crow-nick">{masking.maskOf(v.name)}</span>
                {crossRealmTagOf(st) ? (
                  <span class="live-battle__cross-realm">{crossRealmTagOf(st)}</span>
                ) : null}
                {st?.clanTag ? (
                  <span class="live-battle__crow-clan">[{st.clanTag}]</span>
                ) : null}
                {ai ? <em class="live-battle__crow-bot">{t("replay.bot")}</em> : null}
              </span>
              <span class="live-battle__crow-ship">{shipName}</span>
            </span>
            {rosterStatCols(
              v.name,
              nameStats,
              Boolean(
                stats.get(v.id)?.loading ||
                  (shipScopeOn.value && stats.get(v.id)?.shipsLoading),
              ),
              (st) => viewOf(st, v.shipId),
            )}
            {/* Seal slot reserved whenever seals show at all (PR + settings
                master) — the matrix's own alignment rule: rows without a
                stamp (bots, misses, verdict holds) keep the stat columns
                at the same x as sealed rows instead of zigzagging. */}
            {prefs.prefs.prEnabled && prefs.prefs.sealsEnabled ? (
              <span class="live-battle__crow-stampslot">{seal}</span>
            ) : null}
          </>
        );
        const classes = [
          "live-battle__crow",
          { "live-battle__crow--link": !ai },
          { "live-battle__crow--sunk": entry.sunk },
        ];
        const tint = prTintVars(st, v.shipId);
        return !ai ? (
          <button
            class={classes}
            style={tint}
            key={v.id}
            type="button"
            data-hint={t("replay.live.viewProfile")}
            onClick={() => openLookup(v.name)}
          >
            {content}
          </button>
        ) : (
          <div class={classes} style={tint} key={v.id}>
            {content}
          </div>
        );
      };

      const cell = (entry: TabOrderedVehicle) => {
        if (compact.value) return compactCell(entry);
        const v = entry.vehicle;
        const shipName =
          shipNameFromOfflineDb(v.shipId, dataLanguage.value) ?? v.shipName ?? "";
        const clickable = !isAiName(v.name);
        // The career seal is a card-level element pinned to the card's right
        // edge (same "pressed onto the card" look as the account card), so it
        // needs its own copy of the career guard statLine uses above. Both
        // roster columns read left-to-right, so the seal rides the right edge
        // for allies and enemies alike — only the in-game Tab overlay flakes
        // its seals by team.
        const st = clickable ? stats.get(v.id) : null;
        // Hidden profiles earn the 过街老鼠 seal instead of a stat verdict —
        // careerStamp's hidden branch handles that — but only once the clan
        // gate has spoken: a hidden profile WITH a clan holds the seal while
        // its clan verdict is still out (clanWinrate undefined), and
        // careerStamp excuses a clan beating the 53% gate (a failed verdict
        // arrives as null and stamps fail-open). Everything else grades from
        // the numbers (unknown winrate → 猴 fallback).
        const stamp =
          st &&
          !st.loading &&
          !(st.hidden && st.clanId != null && st.clanWinrate === undefined)
            ? careerStamp(st.pr, st.battles, st.winrate, st.hidden, st.clanWinrate)
            : null;
        const classes = [
          "live-battle__player",
          { "live-battle__player--link": clickable },
          // Sunk mid-battle (recognized off the dim-gray Tab row): the card
          // dims the same way the game grays the row.
          { "live-battle__player--sunk": entry.sunk },
        ];
        const seal =
          stamp && prefs.prefs.prEnabled && prefs.prefs.sealsEnabled ? (
            <RatingStamp
              kind={stamp}
              size={26}
              variant="mini"
              class="live-battle__player-stamp"
            />
          ) : null;
        // The row's resolved numbers for the bottom stat strip — null while
        // any gate holds (loading / hidden); LiveStatLine owns those faces.
        const statView =
          st && !st.loading && !st.hidden && !(shipScopeOn.value && st.shipsLoading)
            ? rowViewOf(st, v.shipId)
            : null;
        const main = (
          <span class="live-battle__player-main">
            <span class="live-battle__player-name">
              <span class="live-battle__player-nick">{masking.maskOf(v.name)}</span>
              {/* Cross-server Clan-Battles badge (欧服 etc.) — only on rows
                  whose stats resolved on another cluster. */}
              {crossRealmTagOf(st) ? (
                <span class="live-battle__cross-realm">{crossRealmTagOf(st)}</span>
              ) : null}
              {/* Clan tag from the batch answer ([HOOD] etc.) — the same tag
                  the in-game Tab panel prefixes nicknames with. It sits
                  AFTER the nick so every card's nick starts at the same
                  column. */}
              {st?.clanTag ? (
                <span class="live-battle__player-clan">[{st.clanTag}]</span>
              ) : null}
              {isAiName(v.name) ? (
                <em class="live-battle__player-bot">{t("replay.bot")}</em>
              ) : null}
            </span>
            <span class="live-battle__player-ship">
              {/* Ship-type marker riding the ship name — the compact rows'
                  lead icon in the same team/sunk variant vocabulary, so the
                  class reads at a glance without the meta strip. */}
              <span class="live-battle__player-ship-ico">
                {v.shipId != null ? (
                  <BattleIcon
                    type={shipOfflineEntry(v.shipId)?.type ?? ""}
                    variant={
                      entry.sunk
                        ? "sunk"
                        : v.relation === 0
                          ? "white"
                          : v.relation <= 1
                            ? "ally"
                            : "enemy"
                    }
                    size={14}
                  />
                ) : null}
              </span>
              <span class="live-battle__player-ship-name">{shipName}</span>
            </span>
          </span>
        );
        const content = (
          <>
            {main}
            {/* Ship identity + parameters ride the card's middle ground;
                ally rows additionally carry the consumable/module/flag
                summary. Enemies get parameters only — and operations have
                no enemies at all. */}
            <LiveShipMeta shipId={v.shipId} ally={v.relation <= 1} />
            {seal}
            {/* The stat strip is the card's SECOND row, spanning all three
                tracks (see LiveStatLine): the one line long enough to matter
                at full width, it borrows the middle ground's and the seal's
                air instead of ellipsizing inside the fixed name track. */}
            <LiveStatLine
              ai={!clickable}
              loading={Boolean(
                !st || st.loading || (shipScopeOn.value && st.shipsLoading),
              )}
              hidden={Boolean(st?.hidden)}
              view={statView}
            />
          </>
        );
        const tint = prTintVars(st, v.shipId);
        return clickable ? (
          <button
            class={classes}
            style={tint}
            key={v.id}
            type="button"
            data-hint={t("replay.live.viewProfile")}
            onClick={() => openLookup(v.name)}
          >
            {content}
          </button>
        ) : (
          <div class={classes} style={tint} key={v.id}>
            {content}
          </div>
        );
      };

      return (
        <div class="live-battle" ref={root}>
          <div class="live-battle__head live-battle__head--status">
            {/* The page title — the only "实时对局" on screen (the view-level
                duplicate was dropped; see LiveView). */}
            <h1 class="live-battle__title">{t("replay.live.title")}</h1>
            {props.ended ? (
              <span class="live-battle__pill live-battle__pill--ended">
                {t("replay.live.ended")}
              </span>
            ) : props.settling ? (
              <span class="live-battle__pill live-battle__pill--settling">
                {t("replay.live.settling")}
              </span>
            ) : (
              <span class="live-battle__pill live-battle__pill--live">LIVE</span>
            )}
            {modePill}
            {!props.ended && clockLabel.value ? (
              <span class="live-battle__clock">{clockLabel.value}</span>
            ) : null}
            {/* The map as a jump tag (shared with the replay-review head):
                hover previews the map's bundled minimap, click opens the
                map's tactical board — see MapNameTag. */}
            <MapNameTag class="live-battle__map" spaceId={props.arena.mapName} lang={dataLanguage.value} />
            {/* Stats-source mode tag: shows the current ship/battle/solo
                dimensions and opens the same selector the settings page
                hosts (one shared store — both stay in sync live). */}
            <LiveStatsModeChip />
            {/* Copy-share-shot: the roster as a watermarked PNG straight
                onto the clipboard — the share path itself, no separate
                post-battle window in between. Copy feedback rides the
                app's toast surface. */}
            <button
              class="live-battle__shot-btn"
              type="button"
              disabled={shot.busy.value}
              onClick={() => void shot.copyShot()}
            >
              {shot.busy.value ? <HkSpinner size="xs" tone="current" /> : <Camera size={13} />}
              {t("share.copyShot")}
            </button>
            {/* Manual full stats refresh: wipes the backend session cache
                and re-requests the WHOLE roster. Already-loaded rows keep
                their values (a failed re-request must not blank the
                panel); the spinner rides the button while in flight. */}
            <button
              class={[
                "live-battle__mask-btn",
                { "live-battle__mask-btn--on": rosterRefreshing.value },
              ]}
              type="button"
              disabled={rosterRefreshing.value}
              data-hint={t("replay.live.refreshStatsHint")}
              onClick={() => {
                rosterRefreshing.value = true;
                void forceRefresh();
                // The batch settles spinners itself; release the button on
                // the next render tick after the request pipeline drains
                // (the composable flips loading flags per row).
                setTimeout(() => (rosterRefreshing.value = false), 4000);
              }}
            >
              {rosterRefreshing.value ? <HkSpinner size="xs" tone="current" /> : <RefreshCw size={13} />}
              {t("replay.live.refreshStats")}
            </button>
            {/* Roster density: the post-battle matrix's one-line rows ⇄ the
                full cards (persisted stats pref). Icon and label both show
                the mode a click switches TO — Rows2 = the compact two-line
                row, Rows3 = the full three-line card. */}
            <button
              class={[
                "live-battle__density-btn",
                { "live-battle__density-btn--on": compact.value },
              ]}
              type="button"
              onClick={() => prefs.setLiveRosterCompact(!compact.value)}
            >
              {compact.value ? <Rows3 size={13} /> : <Rows2 size={13} />}
              {compact.value
                ? t("replay.roster.fullMode")
                : t("replay.roster.compactMode")}
            </button>
            {/* Hide-all-nicknames toggle — the post-battle share bar's
                masking button, dressed in the head's pill voice. */}
            <button
              class={[
                "live-battle__mask-btn",
                { "live-battle__mask-btn--on": masking.hideAll.value },
              ]}
              type="button"
              onClick={() => masking.toggleAll()}
            >
              {/* Icon = the action a click performs, matching the
                  post-battle share bar's toggle exactly. */}
              {masking.hideAll.value ? <Eye size={13} /> : <EyeOff size={13} />}
              {masking.hideAll.value
                ? t("replay.live.showNicks")
                : t("replay.live.hideNicks")}
            </button>
            {/* Telemetry-source grade: staged per the roster mode and the
                plugin's presence — plugin connected (full precision) >
                incomplete (mode picked, plugin missing: the capture
                inference still runs) > inference (default pipeline). */}
            <span
              class={[
                "live-battle__pill",
                `live-battle__pill--telemetry-${telemetryGrade.value}`,
              ]}
              data-hint={
                t(`replay.live.telemetry${telemetryGrade.value[0].toUpperCase()}${telemetryGrade.value.slice(1)}Hint`)
              }
            >
              {telemetryGrade.value === "plugin" ? (
                <Plug size={12} />
              ) : telemetryGrade.value === "incomplete" ? (
                <Unplug size={12} />
              ) : (
                <ScanEye size={12} />
              )}
              {t(`replay.live.telemetry${telemetryGrade.value[0].toUpperCase()}${telemetryGrade.value.slice(1)}`)}
            </span>
            {statusBadge.value ? (
              <span
                class={[
                  "live-battle__pill",
                  `live-battle__pill--status-${statusBadge.value.cls}`,
                ]}
              >
                {statusBadge.value.spin && <HkSpinner size="xs" tone="current" />}
                {statusBadge.value.text}
              </span>
            ) : null}
            {/* The manual-locate entry point is PERMANENT: idle stretches
                between battles (and battles where Tab was never held) leave
                no overlay status to badge, and stranding the region-picker
                entry on those states is exactly what made it look flaky. */}
            <button
              class={[
                "live-battle__manual-btn",
                {
                  "live-battle__manual-btn--active": manualActive.value,
                  "live-battle__manual-btn--shake": manualShake.value,
                },
              ]}
              type="button"
              disabled={manualBusy.value}
              onClick={() => void onManualButton()}
            >
              {/* Icon = the action a click performs, matching the
                  nickname/density toggles: crosshair while idle, X to
                  clear an anchor that is live. */}
              {manualActive.value ? <X size={13} /> : <LocateFixed size={13} />}
              {manualActive.value
                ? t("replay.live.manualClear")
                : t("replay.live.manualLocate")}
            </button>
          </div>
          {/* Operations (行动) have no enemy list — the enemy side is all
              scripted spawns — so the roster renders as one centered
              allies column (single-sided roster edges included). */}
          <div
            class={[
              "live-battle__matrix",
              { "live-battle__matrix--single": enemies.value.length === 0 },
            ]}
          >
            <div class="live-battle__col">
              {colTitle(t("replay.roster.allies"), allies.value)}
              {allies.value.map(cell)}
            </div>
            {enemies.value.length > 0 ? (
              <div class="live-battle__col">
                {colTitle(t("replay.roster.enemies"), enemies.value)}
                {enemies.value.map(cell)}
              </div>
            ) : null}
          </div>
        </div>
      );
    };
  },
});
