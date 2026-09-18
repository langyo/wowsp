/**
 * Live-battle panel (the first item in the replay rail while the game is
 * running). Shows the current battle's mode, map, roster with per-player
 * WR / PR (fetched via the shared roster batch pipeline — see
 * `composables/useRosterStats.ts`) and the elapsed battle clock.
 *
 * Every human card is clickable and jumps to the lookup (水表) view for that
 * player; hidden profiles show a red notice instead of a fake "no data".
 */
import { computed, defineComponent, type CSSProperties } from "vue";
import { useRouter } from "vue-router";

import type { ArenaInfo, VehicleEntry } from "@/api";
import { useAccountStore } from "@/stores/account";
import { useLanguage } from "@/i18n/useLanguage";
import { t } from "@/i18n";
import { shipNameFromOfflineDb } from "@/features/holographic/modelLoader";
import { modeColor, modeKey } from "@/utils/modeColors";
import { prTier, winrateColor } from "@/utils/winrate";
import { useRosterStats, isAiName } from "@/composables/useRosterStats";
import { useBattleClock } from "./useBattleClock";
import { HSpinner } from "@celestia-island/hikari";
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
    /** Realm the battle is played on (from the active client install);
     *  used for both the stats lookup and the lookup-view jump. */
    realm: { type: String, default: "" },
  },
  setup(props) {
    const accounts = useAccountStore();
    const router = useRouter();
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

    const allies = computed(
      () => props.arena?.vehicles.filter((v) => v.relation <= 1) ?? [],
    );
    const enemies = computed(
      () => props.arena?.vehicles.filter((v) => v.relation > 1) ?? [],
    );

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
              <b style={{ color: winrateColor(st.winrate) }}>
                {st.winrate.toFixed(1)}%
              </b>{" "}
              WR ·{" "}
              <b style={{ color: prTier(st.pr).color }}>{st.pr ?? "—"}</b> PR
            </span>
          );
        }
        return "—";
      };

      const cell = (v: VehicleEntry) => {
        const shipName =
          shipNameFromOfflineDb(v.shipId, dataLanguage.value) ?? v.shipName ?? "";
        const clickable = !isAiName(v.name);
        const content = (
          <>
            <span class="live-battle__player-name">
              {v.name}
              {isAiName(v.name) ? (
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
            data-hint={t("replay.live.viewProfile")}
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
