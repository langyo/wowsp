/**
 * Live-battle panel (the first item in the replay rail while the game is
 * running). Shows the current battle's mode, map, roster with per-player
 * WR / PR (fetched as ONE batched WG-API call per roster update — the
 * backend resolves N names with bounded parallelism and two combined
 * lookups) and the elapsed battle clock.
 *
 * Every human card is clickable and jumps to the lookup (水表) view for that
 * player; hidden profiles show a red notice instead of a fake "no data".
 */
import {
  computed,
  defineComponent,
  onBeforeUnmount,
  reactive,
  watch,
  type CSSProperties,
} from "vue";
import { useRouter } from "vue-router";

import { api, type ArenaInfo, type VehicleEntry } from "@/api";
import { useAccountStore } from "@/stores/account";
import { useLanguage } from "@/i18n/useLanguage";
import { t } from "@/i18n";
import { shipNameFromOfflineDb } from "@/features/holographic/modelLoader";
import { modeColor, modeKey } from "@/utils/modeColors";
import { useBattleClock } from "./useBattleClock";
import { HSpinner } from "@celestia-island/hikari";
import mapNamesRaw from "@/data/map_names.json";
import "./LiveBattlePanel.scss";

const AI_NAME = /^:.*:$/;
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

/** Localize a battle mode from its layered identity. */
function modeLabelOf(group?: string | null): string {
  const key = modeKey(group, null, null);
  if (!key) return t("replay.mode._fallback");
  const i18nKey = "replay.mode." + key;
  const lbl = t(i18nKey);
  return lbl === i18nKey ? t("replay.mode._fallback") : lbl;
}

interface PlayerStat {
  winrate: number | null;
  pr: number | null;
  battles: number | null;
  hidden: boolean;
  loading: boolean;
}

/** Resolved stat lines cached by `${realm}:${name}` at module scope. Players
 *  queue together for many games, so re-encountered names render instantly
 *  without another WG hit. Cloned into the per-battle reactive map. */
const statCache = new Map<string, PlayerStat>();
const STAT_CACHE_MAX = 2000;

const emptyStat = (loading: boolean): PlayerStat => ({
  winrate: null,
  pr: null,
  battles: null,
  hidden: false,
  loading,
});

export default defineComponent({
  name: "LiveBattlePanel",
  props: {
    arena: { type: Object as () => ArenaInfo | null, default: null },
    /** Battle-end signal: a fresh .wowsreplay appeared in the replays dir
     *  (the game writes the file when the battle ends) — the battle is on
     *  the results screen, stats final but replay still settling. */
    settling: { type: Boolean, default: false },
    /** Realm the battle is played on (from the active client install);
     *  used for both the stats lookup and the lookup-view jump. */
    realm: { type: String, default: "" },
  },
  setup(props) {
    const accounts = useAccountStore();
    const router = useRouter();
    const { dataLanguage } = useLanguage();
    const stats = reactive(new Map<number, PlayerStat>());
    const { label: clockLabel } = useBattleClock(
      () => props.arena?.dateTime ?? null,
    );

    const realm = computed(
      () => props.realm || accounts.activeRealm || "asia",
    );

    const allies = computed(
      () => props.arena?.vehicles.filter((v) => v.relation <= 1) ?? [],
    );
    const enemies = computed(
      () => props.arena?.vehicles.filter((v) => v.relation > 1) ?? [],
    );

    // Batch pipeline: names missing from the cache are collected and sent as
    // one debounced RPC (the backend fans them out with bounded parallelism).
    // Battle generation guards in-flight results: when the battle changes,
    // stale responses drop instead of writing into the new battle's stats
    // (vehicle ids repeat across battles).
    let battleGen = 0;
    const pendingNames = new Set<string>();
    /** Names waiting for the backoff retry (kept apart from `pendingNames`
     *  so the post-batch reschedule only ever picks up fresh names). */
    const retryNames = new Set<string>();
    let batchTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    /** Batch retries left for the current battle (reset on battle change) —
     *  keeps a hard-down WG API from being probed all battle long. */
    let retriesLeft = 2;

    function cacheKey(name: string): string {
      return `${realm.value}:${name}`;
    }

    /** Seed per-vehicle stats from cache; queue the rest for a batch call. */
    function ensureStats(vehicles: VehicleEntry[]) {
      for (const v of vehicles) {
        if (AI_NAME.test(v.name)) continue;
        const cached = statCache.get(cacheKey(v.name));
        if (cached) {
          stats.set(v.id, { ...cached });
          continue;
        }
        if (stats.has(v.id)) continue;
        stats.set(v.id, emptyStat(true));
        pendingNames.add(v.name);
      }
      if (pendingNames.size > 0 && !batchTimer && !inFlight) {
        batchTimer = setTimeout(runBatch, 250);
      }
    }

    function applyStat(name: string, st: PlayerStat) {
      if (statCache.size >= STAT_CACHE_MAX) statCache.clear();
      statCache.set(cacheKey(name), st);
      // Write into every roster slot carrying this name (one per battle).
      for (const v of props.arena?.vehicles ?? []) {
        if (v.name === name && !AI_NAME.test(name)) stats.set(v.id, { ...st });
      }
    }

    async function runBatch() {
      batchTimer = null;
      if (pendingNames.size === 0) return;
      if (inFlight) {
        // A call is still out; retry shortly with the (possibly grown) set.
        batchTimer = setTimeout(runBatch, 400);
        return;
      }
      const names = [...pendingNames];
      pendingNames.clear();
      const gen = battleGen;
      inFlight = true;
      try {
        const results = await api.lookupPlayersStatsBatch(names, realm.value);
        if (gen !== battleGen) return;
        names.forEach((name, i) => {
          const r = results[i];
          applyStat(
            name,
            r
              ? {
                  winrate: r.winrate ?? null,
                  pr: r.pr ?? null,
                  battles: r.battles ?? null,
                  hidden: r.hidden,
                  loading: false,
                }
              : // Not found on this realm — resolve to "no data" so the card
                // doesn't spin forever.
                emptyStat(false),
          );
        });
      } catch {
        if (gen !== battleGen) return;
        // Transient (WG limits / network): settle the spinners, then retry
        // the failed batch after a backoff pause — at most `retriesLeft`
        // times per battle (a hard-down API must not be probed all battle
        // long). Cards show "—" until a retry lands.
        for (const name of names) {
          for (const v of props.arena?.vehicles ?? []) {
            if (v.name === name && stats.get(v.id)?.loading) {
              stats.set(v.id, emptyStat(false));
            }
          }
        }
        if (retriesLeft > 0) {
          retriesLeft -= 1;
          for (const name of names) retryNames.add(name);
          if (!retryTimer) {
            retryTimer = setTimeout(() => {
              retryTimer = null;
              if (gen !== battleGen) return;
              for (const name of retryNames) pendingNames.add(name);
              retryNames.clear();
              if (!batchTimer && !inFlight && pendingNames.size > 0) {
                batchTimer = setTimeout(runBatch, 100);
              }
            }, 3000);
          }
        }
      } finally {
        inFlight = false;
        // Players often load into the roster mid-battle — pick up the delta
        // here. Fresh names only: a scheduled backoff retry owns its own
        // timing and drains `retryNames` on fire.
        if (pendingNames.size > 0 && !batchTimer && !retryTimer) {
          batchTimer = setTimeout(runBatch, 250);
        }
      }
    }

    // The parent re-reads tempArenaInfo.json every few seconds while the
    // live pane is open, and every read arrives as a fresh object — so the
    // snapshot must never be compared by reference. Reset the queue only
    // when the battle itself changed (dateTime is the battle-start stamp);
    // within one battle, just pick up roster additions and keep every
    // finished lookup (cache hits are instant anyway).
    let battleStamp: string | null | undefined;
    watch(
      () => props.arena,
      (a) => {
        const stamp = a?.dateTime ?? null;
        if (a && stamp === battleStamp) {
          ensureStats(a.vehicles);
          return;
        }
        battleStamp = stamp;
        battleGen += 1;
        stats.clear();
        pendingNames.clear();
        retryNames.clear();
        retriesLeft = 2;
        if (a) ensureStats(a.vehicles);
      },
      { immediate: true },
    );

    onBeforeUnmount(() => {
      battleGen += 1;
      if (batchTimer) clearTimeout(batchTimer);
      if (retryTimer) clearTimeout(retryTimer);
      // Empty the queues so an in-flight batch's reschedule path finds
      // nothing to re-run after unmount.
      pendingNames.clear();
      retryNames.clear();
    });

    function openLookup(name: string) {
      void router.push({ path: "/lookup", query: { name, realm: realm.value } });
    }

    return () => {
      if (!props.arena || props.arena.vehicles.length === 0) {
        return (
          <div class="live-battle live-battle--empty">
            <p class="live-battle__empty-text">{t("replay.live.notStarted")}</p>
          </div>
        );
      }

      const modePill = props.arena.matchGroup ? (
        <span
          class="live-battle__pill"
          style={modeColor(props.arena.matchGroup, null, null) as CSSProperties}
        >
          {modeLabelOf(props.arena.matchGroup)}
        </span>
      ) : null;

      const statLine = (v: VehicleEntry) => {
        if (AI_NAME.test(v.name)) return "—";
        const st = stats.get(v.id);
        if (!st || st.loading) return <HSpinner size="xs" tone="current" />;
        if (st.hidden) {
          return (
            <span class="live-battle__player-hidden">
              {t("replay.live.hiddenProfile")}
            </span>
          );
        }
        if (st.winrate != null) {
          return (
            <span>
              <b>{st.winrate.toFixed(1)}%</b> WR · <b>{st.pr ?? "—"}</b> PR
            </span>
          );
        }
        return "—";
      };

      const cell = (v: VehicleEntry) => {
        const shipName =
          shipNameFromOfflineDb(v.shipId, dataLanguage.value) ?? v.shipName ?? "";
        const clickable = !AI_NAME.test(v.name);
        const content = (
          <>
            <span class="live-battle__player-name">
              {v.name}
              {AI_NAME.test(v.name) ? (
                <em class="live-battle__player-bot">{t("replay.bot")}</em>
              ) : null}
            </span>
            <span class="live-battle__player-ship">{shipName}</span>
            <span class="live-battle__player-stat">{statLine(v)}</span>
          </>
        );
        return clickable ? (
          <button
            class="live-battle__player live-battle__player--link"
            key={v.id}
            type="button"
            title={t("replay.live.viewProfile")}
            onClick={() => openLookup(v.name)}
          >
            {content}
          </button>
        ) : (
          <div class="live-battle__player" key={v.id}>
            {content}
          </div>
        );
      };

      return (
        <div class="live-battle">
          <div class="live-battle__head">
            <span class="live-battle__title">{t("replay.live.title")}</span>
            {props.settling ? (
              <span class="live-battle__pill live-battle__pill--settling">
                {t("replay.live.settling")}
              </span>
            ) : (
              <span class="live-battle__pill live-battle__pill--live">LIVE</span>
            )}
            {modePill}
            {clockLabel.value ? (
              <span class="live-battle__clock">{clockLabel.value}</span>
            ) : null}
            <span class="live-battle__map">
              {displayMapName(props.arena.mapName, dataLanguage.value)}
            </span>
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
