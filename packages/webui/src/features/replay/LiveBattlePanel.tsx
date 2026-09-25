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
 */
import { computed, defineComponent, onBeforeUnmount, onMounted, ref, type CSSProperties } from "vue";
import { useRouter } from "vue-router";

import type { ArenaInfo, OverlayStatus, VehicleEntry } from "@/api";
import { api } from "@/api";
import { useAccountStore } from "@/stores/account";
import { useOverlayStore } from "@/stores/overlay";
import { useLanguage } from "@/i18n/useLanguage";
import { t } from "@/i18n";
import { shipNameFromOfflineDb } from "@/features/holographic/modelLoader";
import { orderForTab, type TabOrderedVehicle } from "./liveTabOrder";
import LiveShipMeta from "./LiveShipMeta";
import { WaitingRadarArt } from "./liveGuideArt";
import { modeColor, modeKey } from "@/utils/modeColors";
import { careerStamp, prTier, winrateColor } from "@/utils/winrate";
import { useStatsPrefsStore } from "@/stores/statsPrefs";
import { useRosterStats, isAiName } from "@/composables/useRosterStats";
import { useBattleClock } from "./useBattleClock";
import RatingStamp from "@/components/base/RatingStamp";
import { HkSpinner } from "@celestia-island/hikari";
import mapNamesRaw from "@/data/map_names.json";
import "./LiveBattlePanel.scss";

const MAP_NAMES = mapNamesRaw as Record<string, Record<string, string>>;

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
 *  roster bots). */
function modeLabelOf(
  group?: string | null,
  scenario?: string | null,
  botCount = 0,
): string {
  const key = modeKey(group, scenario, null, botCount);
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
    const { dataLanguage, uiLocale } = useLanguage();
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

    // Overlay detection state, streamed by the Rust Tab watcher as
    // transition-only `wowsp://overlay-status` events. Rendered as a badge
    // in the panel's head (right corner) and the base for the upcoming
    // manual-locate flow. `null` = nothing received yet → show nothing
    // (a panel that never used overlay mode stays badge-free).
    const overlayStatus = ref<OverlayStatus | null>(null);
    let unlistenStatus: (() => void) | null = null;
    // In-game Tab row order, streamed by the same watcher whenever a
    // recognition pass over a held Tab frame matched the roster. Held in
    // the overlay store (survives this panel unmounting mid-battle); the
    // columns below reorder to mirror the on-screen table exactly,
    // sunk-ship grouping included.
    const overlay = useOverlayStore();
    let unlistenTabOrder: (() => void) | null = null;
    onMounted(async () => {
      unlistenStatus = (await api.listenOverlayStatus((s) => {
        overlayStatus.value = s;
      })) as (() => void) | null;
      unlistenTabOrder = (await api.listenTabOrder((o) => {
        overlay.applyTabOrder(o);
      })) as (() => void) | null;
    });
    onBeforeUnmount(() => {
      unlistenStatus?.();
      unlistenStatus = null;
      unlistenTabOrder?.();
      unlistenTabOrder = null;
      if (shakeTimer) {
        clearTimeout(shakeTimer);
        shakeTimer = null;
      }
    });

    const statusBadge = computed(() => {
      const s = overlayStatus.value;
      if (!s) return null;
      // A manual anchor stays ARMED across Idle/Searching (Rust marks every
      // automatic report manual:true while it is stored): the badge — and
      // with it the clear button — must survive those transitions too, since
      // the anchor re-anchors on the same battle's next Tab hold.
      if (s.manual) {
        return { cls: "manual", spin: false, text: t("replay.live.manualRows", { n: s.rows ?? 0 }) };
      }
      if (s.state === "idle") return null;
      if (s.state === "detected") {
        // A sink just reshuffled the anchored rows and the watcher is
        // re-mapping them at the accelerated cadence — badge "updating"
        // instead of the row count until the mapping lands (stale clears).
        if (s.stale)
          return { cls: "detected", spin: true, text: t("replay.live.updating") };
        return {
          cls: "detected",
          spin: false,
          text: t("replay.live.detectedRows", { n: s.rows ?? 0 }),
        };
      }
      // Searching/updating are settling states — carry the same inline
      // spinner the loading roster rows use (HkSpinner, currentcolor tone).
      return { cls: "searching", spin: true, text: t("replay.live.searching") };
    });

    /** A manual anchor is in force: the badge turns green and the button
     *  flips from "manual locate" to "clear locate". */
    const manualActive = computed(() => overlayStatus.value?.manual === true);

    /** Manual-locate entry point: opens the drag-box picker window over the
     *  game rect, or (when a manual anchor is already in force) clears it
     *  back to the automatic detection flow. */
    const manualBusy = ref(false);
    /** Short shake when the backend refuses to open the picker (no fresh
     *  battle roster / no game window) — visible feedback, never silent. */
    const manualShake = ref(false);
    let shakeTimer: ReturnType<typeof setTimeout> | null = null;
    async function onManualButton() {
      if (manualBusy.value) return;
      manualBusy.value = true;
      try {
        if (manualActive.value) {
          await api.clearManualRosterRect();
        } else {
          await api.startManualLocate(uiLocale.value);
        }
      } catch (err) {
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
    const tabRowsFor = (side: "allies" | "enemies") => {
      const order = overlay.tabOrder;
      if (!order || !props.arena?.dateTime || order.dateTime !== props.arena.dateTime) {
        return null;
      }
      return side === "allies" ? order.allies : order.enemies;
    };
    const allies = computed(() =>
      orderForTab(
        props.arena?.vehicles.filter((v) => v.relation <= 1) ?? [],
        tabRowsFor("allies"),
      ),
    );
    const enemies = computed(() =>
      orderForTab(
        props.arena?.vehicles.filter((v) => v.relation > 1) ?? [],
        tabRowsFor("enemies"),
      ),
    );

    function openLookup(name: string) {
      void router.push({ path: "/lookup", query: { name, realm: realm.value } });
    }

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
              null,
              props.arena.botCount ?? 0,
            ) as CSSProperties
          }
        >
          {modeLabelOf(props.arena.matchGroup, props.arena.scenario, props.arena.botCount ?? 0)}
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
              <span class="live-battle__player-nick">{v.name}</span>
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
                summary. Enemies get parameters only. */}
            <LiveShipMeta shipId={v.shipId} ally={v.relation <= 1} />
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
        <div class="live-battle">
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
            {statusBadge.value ? (
              <>
                <span
                  class={[
                    "live-battle__pill",
                    `live-battle__pill--status-${statusBadge.value.cls}`,
                  ]}
                >
                  {statusBadge.value.spin && <HkSpinner size="xs" tone="current" />}
                  {statusBadge.value.text}
                </span>
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
              </>
            ) : null}
          </div>
          <div class="live-battle__matrix">
            <div class="live-battle__col">
              <div class="live-battle__col-title">{t("replay.roster.allies")}</div>
              {allies.value.map(cell)}
            </div>
            <div class="live-battle__col">
              <div class="live-battle__col-title">{t("replay.roster.enemies")}</div>
              {enemies.value.map(cell)}
            </div>
          </div>
        </div>
      );
    };
  },
});
