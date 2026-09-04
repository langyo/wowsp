/**
 * Live-battle panel (the first item in the replay rail while the game is
 * running). Shows the current battle's mode, map, roster with per-player
 * WR / PR (queried on-demand from the WG public API through a throttled
 * queue — WG rate-limits bursts hard) and the elapsed battle clock.
 */
import { computed, defineComponent, reactive, watch, type CSSProperties } from "vue";

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
  loading: boolean;
}

export default defineComponent({
  name: "LiveBattlePanel",
  props: {
    arena: { type: Object as () => ArenaInfo | null, default: null },
    /** Battle-end signal: a fresh .wowsreplay appeared in the replays dir
     *  (the game writes the file when the battle ends) — the battle is on
     *  the results screen, stats final but replay still settling. */
    settling: { type: Boolean, default: false },
  },
  setup(props) {
    const accounts = useAccountStore();
    const { dataLanguage } = useLanguage();
    const stats = reactive(new Map<number, PlayerStat>());
    const { label: clockLabel } = useBattleClock(
      () => props.arena?.dateTime ?? null,
    );

    const allies = computed(
      () => props.arena?.vehicles.filter((v) => v.relation <= 1) ?? [],
    );
    const enemies = computed(
      () => props.arena?.vehicles.filter((v) => v.relation > 1) ?? [],
    );

    // WG's public API rate-limits hard bursts (each lookup = 4 requests;
    // 12 players at once = 48 parallel calls → everything gets 429/407'd).
    // Run the queue at low concurrency with a stagger and one retry.
    let running = 0;
    const queue: VehicleEntry[] = [];
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    // Battle generation: bumped only when the battle itself changes, so
    // lookups still in flight at that moment drop their results instead of
    // writing them into the new battle's stats (vehicle ids repeat across
    // battles).
    let battleGen = 0;

    function lookupOnce(v: VehicleEntry, gen: number): Promise<boolean> {
      return api
        .lookupPlayerStats(v.name, accounts.activeRealm)
        .then((s) => {
          if (gen !== battleGen) return true;
          stats.set(v.id, {
            winrate: s.winrate ?? null,
            pr: s.pr ?? null,
            battles: s.battles ?? null,
            loading: false,
          });
          return true;
        })
        .catch(() => {
          if (gen !== battleGen) return true;
          stats.set(v.id, { winrate: null, pr: null, battles: null, loading: false });
          return false;
        });
    }

    function pump() {
      while (running < 2 && queue.length > 0) {
        const v = queue.shift()!;
        running += 1;
        // Capture the generation once per attempt chain: re-capturing it in
        // the retry would let a result from the previous battle (queued just
        // before a battle change) land in the new battle's stats.
        const gen = battleGen;
        void lookupOnce(v, gen)
          .then((ok) =>
            // One retry after a pause — WG transient limits recover quickly.
            // Skipped when the battle changed while paused (stale request).
            ok || gen !== battleGen
              ? false
              : new Promise((r) => setTimeout(r, 600)).then(() => lookupOnce(v, gen)),
          )
          .finally(() => {
            running -= 1;
            pump();
          });
      }
      if (queue.length === 0 && running === 0 && drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
    }

    function enqueue(vehicles: VehicleEntry[]) {
      for (const v of vehicles) {
        if (AI_NAME.test(v.name) || stats.has(v.id)) continue;
        stats.set(v.id, { winrate: null, pr: null, battles: null, loading: true });
        queue.push(v);
      }
      // Stagger the very start too — the panel often mounts while the WG
      // client is also fetching its own roster.
      if (!drainTimer) drainTimer = setTimeout(pump, 250);
    }

    // The parent re-reads tempArenaInfo.json every few seconds while the
    // live pane is open, and every read arrives as a fresh object — so the
    // snapshot must never be compared by reference. Reset the queue only
    // when the battle itself changed (dateTime is the battle-start stamp);
    // within one battle, just pick up roster additions and keep every
    // finished lookup.
    let battleStamp: string | null | undefined;
    watch(
      () => props.arena,
      (a) => {
        const stamp = a?.dateTime ?? null;
        if (a && stamp === battleStamp) {
          enqueue(a.vehicles);
          return;
        }
        battleStamp = stamp;
        battleGen += 1;
        stats.clear();
        queue.length = 0;
        if (a) enqueue(a.vehicles);
      },
      { immediate: true },
    );

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

      const cell = (v: VehicleEntry) => {
        const st = stats.get(v.id);
        const shipName =
          shipNameFromOfflineDb(v.shipId, dataLanguage.value) ?? v.shipName ?? "";
        return (
          <div class="live-battle__player" key={v.id}>
            <span class="live-battle__player-name">
              {v.name}
              {AI_NAME.test(v.name) ? (
                <em class="live-battle__player-bot">{t("replay.bot")}</em>
              ) : null}
            </span>
            <span class="live-battle__player-ship">{shipName}</span>
            <span class="live-battle__player-stat">
              {AI_NAME.test(v.name) ? (
                "—"
              ) : st?.loading ? (
                <HSpinner size="xs" tone="current" />
              ) : st?.winrate != null ? (
                <span>
                  <b>{st.winrate.toFixed(1)}%</b> WR · <b>{st.pr ?? "—"}</b> PR
                </span>
              ) : (
                "—"
              )}
            </span>
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
