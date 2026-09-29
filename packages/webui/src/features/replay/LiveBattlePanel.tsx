/**
 * Live-battle panel (the /live page body). Shows the current battle's mode,
 * map, roster with per-player WR / PR (fetched via the shared roster batch
 * pipeline — see `composables/useRosterStats.ts`) and the elapsed battle
 * clock. Every row's middle ground carries the ship's combat card
 * (`LiveShipMeta` — tier, class, nation, parameter ranges, and on ally rows
 * the consumable/module/flag summary); hovering it floats the condensed ship
 * card. The panel's head title is the /live page title (the view itself has
 * no header — it used to duplicate this one).
 *
 * Every human card is clickable and jumps to the lookup (水表) view for that
 * player; hidden profiles show a red notice instead of a fake "no data".
 * While the PR rating is on, each column title additionally carries the
 * team's aggregate — a tier-weighted (or plain, per the stats prefs) mean
 * winrate plus a mean PR over the players whose stats landed.
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
} from "vue";
import { useRouter } from "vue-router";
import { Camera, Eye, EyeOff, Plug, ScanEye, Unplug } from "@lucide/vue";
import { useToast } from "@celestia-island/hikari";

import type { ArenaInfo, OverlayStatus, VehicleEntry } from "@/api";
import { api } from "@/api";
import { useAccountStore } from "@/stores/account";
import { useIngamePluginStore } from "@/stores/ingamePlugin";
import { useOverlayConfigStore } from "@/stores/overlayConfig";
import { useLanguage } from "@/i18n/useLanguage";
import { t } from "@/i18n";
import { shipNameFromOfflineDb, shipOfflineEntry } from "@/features/holographic/modelLoader";
import { orderForTab, type TabOrderedVehicle } from "./liveTabOrder";
import LiveShipMeta from "./LiveShipMeta";
import { WaitingRadarArt } from "./liveGuideArt";
import { useNickMasking, useShareShot } from "./postBattleShare";
import type { ShotColumn, ShotModel, ShotRow, ShotStat } from "./postBattleShot";
import { isOperationBattle, modeColor, modeKey } from "@/utils/modeColors";
import { careerStamp, prTier, winrateColor } from "@/utils/winrate";
import { shipTierOf } from "@/utils/shipClass";
import { aggregateTeamStats } from "@/utils/teamAggregate";
import { useStatsPrefsStore } from "@/stores/statsPrefs";
import { useManualLocateStore } from "@/stores/manualLocate";
import { useRosterStats, isAiName, type RosterStat } from "@/composables/useRosterStats";
import { SunkTracker, type SunkSide } from "@/utils/sunkTracker";
import { useBattleClock } from "./useBattleClock";
import RatingStamp from "@/components/base/RatingStamp";
import { HkSpinner } from "@celestia-island/hikari";
import mapNamesRaw from "@/data/map_names.json";
import "./LiveBattlePanel.scss";

const MAP_NAMES = mapNamesRaw as Record<string, Record<string, string>>;

/** Stable refusal codes from `start_manual_locate` → the replay.live.*
 *  copy toasted next to the button shake. Module-level: the mapping is
 *  pure data, no per-instance state. */
const MANUAL_REFUSAL_KEYS: Record<string, string> = {
  "no-battle": "replay.live.manualNoBattle",
  "no-game": "replay.live.manualNoGame",
  "no-frame": "replay.live.manualNoFrame",
};

function displayMapName(spaceId?: string | null, lang?: string): string {
  if (!spaceId) return t("replay.map.unknown");
  const clean = spaceId.replace(/^spaces\//, "");
  const names = MAP_NAMES[clean];
  const official = names ? (names[lang ?? ""] ?? names["en"] ?? null) : null;
  if (official) return official;
  const key = "replay.map.names." + clean;
  const lbl = t(key);
  return lbl === key ? clean : lbl;
}

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
    const manualLocate = useManualLocateStore();
    const toast = useToast();
    const { dataLanguage } = useLanguage();
    const { label: clockLabel } = useBattleClock(
      () => props.arena?.dateTime ?? null,
    );

    const realm = computed(
      () => props.realm || accounts.activeRealm || "asia",
    );

    const { stats } = useRosterStats({
      realm: () => realm.value,
      arena: () => props.arena,
    });

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
    let unlistenSinkAttrib: (() => void) | null = null;
    /** The side's believed alive order for resolving sink-attrib rows:
     *  the predicted key order minus the trusted sunk set. */
    const sideAliveOrder = (side: SunkSide): string[] => {
      // Operations (行动) map the whole roster as the ally block — the
      // Rust sink solver indexes their rows the same way (team_sizes
      // carries the whole roster as allies).
      const list =
        operation.value && side === "ally"
          ? props.arena?.vehicles ?? []
          : (props.arena?.vehicles ?? []).filter((v) =>
              side === "enemy" ? v.relation > 1 : v.relation <= 1,
            );
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
        sunk.applyAttribution(
          { ally: a.allyRows ?? [], enemy: a.enemyRows ?? [] },
          sideAliveOrder,
        );
        sinkEpoch.value += 1;
      })) as (() => void) | null;
    });
    onBeforeUnmount(() => {
      unlistenStatus?.();
      unlistenStatus = null;
      unlistenSinkAttrib?.();
      unlistenSinkAttrib = null;
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
    const plugin = useIngamePluginStore();
    const overlayCfg = useOverlayConfigStore();
    const telemetryGrade = computed<"plugin" | "incomplete" | "infer">(() => {
      if (overlayCfg.roster !== "plugin") return "infer";
      return plugin.installed ? "plugin" : "incomplete";
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
    // Operation scenarios (行动) whose relation values follow scenario team
    // slots (escort waves, target ships) rather than enemy semantics keep
    // the whole roster on the ally side here — the Rust sink solver indexes
    // its rows the same way (team_sizes carries the whole roster as
    // allies), so sink attributions stay name-matched.
    const operation = computed(() =>
      isOperationBattle(
        props.arena?.matchGroup,
        props.arena?.scenario,
        props.arena?.eventType,
        props.arena?.vehicles.map((v) => v.name),
      ),
    );
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
    // The ally side: real operations field the whole roster as one block
    // (their relation values are scenario slots, and the Rust sink solver
    // indexes them the same way); every other battle keeps the relation
    // split, which for the new-account escort op IS our team — its scripted
    // spawns sit at relation>1 and drop out of the panel below.
    // Inputs for the predicted order's full Tab key come from
    // `predictedOptionsFor` above (locale + clan tag + that side's trusted
    // sunk set) — the orders re-derive reactively when the WG batch lands a
    // tag or a sink event bumps `sinkEpoch`.
    const allies = computed(() =>
      orderForTab(
        operation.value
          ? props.arena?.vehicles ?? []
          : props.arena?.vehicles.filter((v) => v.relation <= 1) ?? [],
        predictedOptionsFor("ally"),
      ),
    );
    // The enemy list: every operation-LABELED battle hides it (wider than
    // `operation` — the pill says 行动 there too, and the enemy block is
    // all scripted spawns nobody reads), while real two-team modes keep
    // the relation>1 split.
    const enemies = computed(() =>
      orderForTab(
        operationLabeled.value
          ? []
          : props.arena?.vehicles.filter((v) => v.relation > 1) ?? [],
        predictedOptionsFor("enemy"),
      ),
    );

    function openLookup(name: string) {
      void router.push({ path: "/lookup", query: { name, realm: realm.value } });
    }

    /** One team's header aggregate — tier-weighted (per the stats prefs)
     *  mean winrate plus a plain mean PR over the players whose stats
     *  landed. AI names, hidden profiles and still-loading rows sit out. */
    const teamAgg = (entries: TabOrderedVehicle[]) =>
      aggregateTeamStats(
        entries.map((entry) => {
          const v = entry.vehicle;
          const st = stats.get(v.id);
          if (!st || st.loading || st.hidden || isAiName(v.name)) {
            return { winrate: null, pr: null, tier: shipTierOf(v.shipId) };
          }
          return { winrate: st.winrate, pr: st.pr, tier: shipTierOf(v.shipId) };
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
      const statCell = (
        v: VehicleEntry,
        pick: (s: RosterStat) => number | null,
        fmt: (v: number) => string,
        colorOf: (v: number) => string,
      ): ShotStat => {
        if (isAiName(v.name)) return { text: "—" };
        const st = stats.get(v.id);
        if (!st || st.loading || st.hidden) return { text: "—" };
        const val = pick(st);
        if (val == null) return { text: "—" };
        return { text: fmt(val), color: colorOf(val) };
      };
      const mkCol = (entries: TabOrderedVehicle[], enemy: boolean): ShotColumn => {
        // Aggregate values carry their stat-column index so the shot's
        // header numbers right-align onto the cells below them.
        let agg: ShotColumn["agg"];
        if (prefs.prefs.prEnabled) {
          const a = teamAgg(entries);
          agg = [
            {
              col: 0,
              label: t(
                prefs.prefs.weightedTeamWr
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
                  : operation.value || v.relation <= 1
                    ? "ally"
                    : "enemy",
              stats: [
                statCell(v, (s) => s.winrate, (val) => `${val.toFixed(1)}%`, winrateColor),
                ...(prefs.prefs.prEnabled
                  ? [
                      statCell(
                        v,
                        (s) => s.pr,
                        (val) => `${Math.round(val)}`,
                        (val) => prTier(val).color,
                      ),
                    ]
                  : []),
              ],
            };
          }),
        };
      };
      return {
        title: t("replay.live.title"),
        mode,
        mapLabel: arena?.mapName ? displayMapName(arena.mapName, dataLanguage.value) : null,
        botLabel: t("replay.bot"),
        // Mirror the DOM's single-column rule (operations and any
        // single-sided roster edge).
        columns:
          operation.value || enemies.value.length === 0
            ? [mkCol(allies.value, false)]
            : [mkCol(allies.value, false), mkCol(enemies.value, true)],
      };
    }

    /** A column title (我方/敌方) with the team aggregate riding its right
     *  end — only while the PR rating is on; the caption stays bare
     *  otherwise. Values carry their tier colors (winrateColor / prTier). */
    const colTitle = (label: string, entries: TabOrderedVehicle[]) => {
      const title = <span class="live-battle__col-name">{label}</span>;
      if (!prefs.prefs.prEnabled) {
        return <div class="live-battle__col-title">{title}</div>;
      }
      const agg = teamAgg(entries);
      const prBand = prTier(agg.avgPr);
      return (
        <div class="live-battle__col-title">
          {title}
          <span class="live-battle__col-agg">
            {t(
              prefs.prefs.weightedTeamWr
                ? "replay.roster.teamWrWeighted"
                : "replay.roster.teamWrPlain",
            )}{" "}
            <b style={agg.winrate != null ? { color: winrateColor(agg.winrate) } : undefined}>
              {agg.winrate != null ? `${agg.winrate.toFixed(1)}%` : "—"}
            </b>
            {" · "}
            {t("replay.roster.teamAvgPr")}{" "}
            <b
              class={prBand.rainbow ? "rainbow-text" : undefined}
              style={prBand.rainbow ? undefined : { color: prBand.color }}
            >
              {agg.avgPr != null ? Math.round(agg.avgPr) : "—"}
            </b>
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

      const statLine = (v: VehicleEntry) => {
        if (isAiName(v.name)) return "—";
        const st = stats.get(v.id);
        if (!st || st.loading) return <HkSpinner size="xs" tone="current" />;
        if (st.hidden) {
          return (
            <span class="live-battle__player-hidden">
              {t("replay.live.hiddenProfile")}
            </span>
          );
        }
        if (st.winrate != null) {
          const tier = prTier(st.pr);
          return (
            <span class="live-battle__player-statline">
              <b style={{ color: winrateColor(st.winrate) }}>
                {st.winrate.toFixed(1)}%
              </b>{" "}
              WR
              {/* Inline PR rides along only while the rating is on — the
                  line keeps the bare winrate otherwise. */}
              {prefs.prefs.prEnabled ? (
                <>
                  {" · "}
                  <b
                    class={tier.rainbow ? "rainbow-text" : undefined}
                    style={tier.rainbow ? undefined : { color: tier.color }}
                  >
                    {st.pr ?? "—"}
                  </b>{" "}
                  PR
                </>
              ) : null}
            </span>
          );
        }
        return "—";
      };

      const cell = (entry: TabOrderedVehicle) => {
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
        // the numbers (unknown winrate → 海猴 fallback).
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
        const main = (
          <span class="live-battle__player-main">
            <span class="live-battle__player-name">
              <span class="live-battle__player-nick">{masking.maskOf(v.name)}</span>
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
            <span class="live-battle__player-ship">{shipName}</span>
            <span class="live-battle__player-stat">{statLine(v)}</span>
          </span>
        );
        const content = (
          <>
            {main}
            {/* Ship identity + parameters ride the card's middle ground;
                ally rows additionally carry the consumable/module/flag
                summary. Enemies get parameters only — and operations have
                no enemies at all. */}
            <LiveShipMeta shipId={v.shipId} ally={operation.value || v.relation <= 1} />
            {seal}
          </>
        );
        return clickable ? (
          <button
            class={classes}
            key={v.id}
            type="button"
            data-hint={t("replay.live.viewProfile")}
            onClick={() => openLookup(v.name)}
          >
            {content}
          </button>
        ) : (
          <div class={classes} key={v.id}>
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
            <span class="live-battle__map">
              {displayMapName(props.arena.mapName, dataLanguage.value)}
            </span>
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
