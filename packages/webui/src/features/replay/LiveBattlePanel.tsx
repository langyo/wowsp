/**
 * Live-battle panel (the first item in the replay rail while the game is
 * running). Shows the current battle's map + roster with per-player WR / PR,
 * queried on-demand from the WG public API. Rendered instead of the
 * holographic map when the live entry is selected.
 */
import { computed, defineComponent, reactive, watch } from "vue";

import { api, type ArenaInfo, type VehicleEntry } from "@/api";
import { useAccountStore } from "@/stores/account";
import { useLanguage } from "@/i18n/useLanguage";
import { t } from "@/i18n";
import { shipNameFromOfflineDb } from "@/features/holographic/modelLoader";
import SSpinner from "@/components/base/SSpinner";
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
  },
  setup(props) {
    const accounts = useAccountStore();
    const { dataLanguage } = useLanguage();
    const stats = reactive(new Map<number, PlayerStat>());

    const allies = computed(
      () => props.arena?.vehicles.filter((v) => v.relation <= 1) ?? [],
    );
    const enemies = computed(
      () => props.arena?.vehicles.filter((v) => v.relation > 1) ?? [],
    );

    function lookup(v: VehicleEntry) {
      if (AI_NAME.test(v.name) || stats.has(v.id)) return;
      stats.set(v.id, { winrate: null, pr: null, battles: null, loading: true });
      void api
        .lookupPlayerStats(v.name, accounts.activeRealm)
        .then((s) =>
          stats.set(v.id, {
            winrate: s.winrate ?? null,
            pr: s.pr ?? null,
            battles: s.battles ?? null,
            loading: false,
          }),
        )
        .catch(() =>
          stats.set(v.id, { winrate: null, pr: null, battles: null, loading: false }),
        );
    }

    watch(
      () => props.arena,
      (a) => {
        stats.clear();
        if (a) a.vehicles.forEach(lookup);
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
                <SSpinner size="xs" tone="current" />
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
