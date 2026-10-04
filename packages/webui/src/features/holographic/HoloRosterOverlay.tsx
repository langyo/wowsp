/**
 * Tab-held scoreboard overlay of the holographic map — the in-game Tab
 * table rebuilt from the replay streams at the CURRENT playhead:
 *
 *   - both teams' players (operations render one allies table — their
 *     relation values still split sides, the enemy scripted block is
 *     simply not listed),
 *   - kills credited so far (post-battle killer attribution joined with
 *     the crossed death times — hidden entirely when the replay carries
 *     no BattleResults packet),
 *   - sunk rows dimmed with their sinking time,
 *   - the game's OWN row order (utils/shipClass.gameTabRowKey, recovered
 *     from the decompiled client): alive rows first in class/tier/nation
 *     order, sunk rows re-sorted to the bottom.
 *
 * Clan tags come from the lazily armed WG roster batch (they participate
 * in the game's sort key via the '[TAG]nick' display name).
 */
import { computed, defineComponent, type PropType } from "vue";

import { t as i18nT } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import type { RosterStat } from "@/composables/useRosterStats";
import { gameTabRowKey } from "@/utils/shipClass";
import BattleIcon from "@/components/base/BattleIcon";
import { shipNameFromModelDb, shipNameFromOfflineDb, shipOfflineEntry } from "./modelLoader";
import { tierRoman } from "@/features/replay/shipLiveStats";
import type { VehicleEntry } from "@/api";
import type { HoloTipState } from "./HoloShipTooltip";

/** mm:ss battle clock for sunk times. */
function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

interface RosterRow {
  vehicle: VehicleEntry;
  shipName: string;
  tier: string | null;
  type: string | null;
  alive: boolean;
  /** Battle seconds the ship sank at (null = still afloat at the playhead). */
  deathTime: number | null;
  kills: number;
  /** Precomputed game Tab sort key (alive flag + class/tier/nation/name)
   *  — built once per row per pass, the comparator only string-compares. */
  sortKey: string;
}

function teamTable(rows: RosterRow[], enemy: boolean, showKills: boolean) {
  const alive = rows.filter((r) => r.alive).length;
  return (
    <div class="holo-roster__team">
      {/* Team title lives OUTSIDE the table: with table-layout fixed the
          first table row defines column widths, and a colspan title row
          would defeat the colgroup shares below. */}
      <div class="holo-roster__team-head">
        <span class={enemy ? "holo-roster__title--enemy" : "holo-roster__title--ally"}>
          {enemy ? i18nT("replay.roster.enemies") : i18nT("replay.roster.allies")}
        </span>
        <span class="holo-roster__alive">
          {i18nT("replay.roster.aliveCount", { alive, total: rows.length })}
        </span>
      </div>
      <table class="holo-roster__table">
        <colgroup>
          <col class="holo-roster__col--icon" />
          <col class="holo-roster__col--player" />
          <col class="holo-roster__col--ship" />
          {showKills ? <col class="holo-roster__col--kills" /> : null}
          <col />
        </colgroup>
        <thead>
          <tr>
            <th class="holo-roster__th holo-roster__th--icon" />
            <th class="holo-roster__th">{i18nT("replay.tip.player")}</th>
            <th class="holo-roster__th">{i18nT("replay.roster.ship")}</th>
            {showKills ? <th class="holo-roster__th holo-roster__th--num">{i18nT("replay.roster.kills")}</th> : null}
            <th class="holo-roster__th">{i18nT("replay.tip.status")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.vehicle.id} class={r.alive ? "" : "holo-roster__row--dead"}>
              <td class="holo-roster__td holo-roster__td--icon">
                <BattleIcon
                  type={r.type ?? ""}
                  variant={
                    r.alive
                      ? r.vehicle.relation === 0
                        ? "white"
                        : enemy
                          ? "enemy"
                          : "ally"
                    : "sunk"
                  }
                  size={14}
                />
              </td>
              <td class="holo-roster__td holo-roster__td--name">
                {r.vehicle.relation === 0 ? <em class="holo-roster__self">{i18nT("replay.camera.me")} </em> : null}
                {r.vehicle.name}
              </td>
              <td class="holo-roster__td">
                {r.tier ? <b class="holo-roster__tier">{r.tier}</b> : null}
                <span class="holo-roster__ship">{r.shipName}</span>
              </td>
              {showKills ? (
                <td class="holo-roster__td holo-roster__td--num">
                  {r.kills > 0 ? <b>{r.kills}</b> : <span class="holo-roster__zero">0</span>}
                </td>
              ) : null}
              <td class="holo-roster__td">
                {r.alive ? (
                  <span class="holo-roster__afloat">{i18nT("replay.tip.afloat")}</span>
                ) : (
                  /* Compact for the narrow status column — the full
                     "已击毁 · 沉没于 mm:ss" phrasing lives in the tooltip. */
                  <span class="holo-roster__sunk">
                    {r.deathTime != null
                      ? i18nT("replay.roster.sunkAt", { time: fmtClock(r.deathTime) })
                      : i18nT("replay.legend.dead")}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default defineComponent({
  name: "HoloRosterOverlay",
  props: {
    vehicles: { type: Array as PropType<VehicleEntry[]>, required: true },
    /** Operation scenario (行动): single allies table, no enemy one. */
    operation: { type: Boolean, default: false },
    /** Current battle seconds — the whole table describes THIS instant. */
    time: { type: Number, required: true },
    /** Roster player id → live state (death time etc.), from the map. */
    rosterState: { type: Object as PropType<Map<number, HoloTipState>>, required: true },
    /** Player id → kills credited by `time` (empty when unattributable). */
    kills: { type: Object as PropType<Map<number, number>>, required: true },
    /** False when the replay has no BattleResults — kills column hidden. */
    showKills: { type: Boolean, default: false },
    /** Career stats (clan tags feed the game's own sort key). */
    stats: { type: Object as PropType<Map<string, RosterStat>>, required: true },
  },
  setup(props) {
    const { dataLanguage } = useLanguage();

    /** The game's own Tab row key: alive-first / sunk-last, then class,
     *  tier desc, nation, localized ship name, '[tag]nickname'. */
    const rows = computed<RosterRow[]>(() => {
      const clanTagOf = (n: string) => props.stats.get(n)?.clanTag ?? null;
      return props.vehicles
        .map((v): RosterRow => {
          const st = props.rosterState.get(v.id);
          const deathTime = st?.deathTime ?? null;
          const alive = deathTime == null || deathTime > props.time;
          return {
            vehicle: v,
            shipName:
              (v.shipId != null ? shipNameFromOfflineDb(v.shipId, dataLanguage.value) : null) ??
              v.shipName ??
              (v.shipId != null ? shipNameFromModelDb(v.shipId) : null) ??
              "",
            tier: tierRoman(shipOfflineEntry(v.shipId)?.tier ?? null),
            type: shipOfflineEntry(v.shipId)?.type ?? null,
            alive,
            deathTime,
            kills: props.kills.get(v.id) ?? 0,
            sortKey: gameTabRowKey(
              { shipId: v.shipId, name: v.name },
              alive,
              dataLanguage.value,
              clanTagOf,
            ),
          };
        })
        .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    });

    // The relation split holds in operations (行动) too — their rosters
    // carry real side semantics (allied escort waves ≤ 1, enemy warships
    // > 1), so the enemy scripted block never rolls into the allies table;
    // only the enemy TABLE stays hidden for them (scripted spawns, and a
    // list nobody reads).
    const allies = computed(() => rows.value.filter((r) => r.vehicle.relation <= 1));
    const enemies = computed(() =>
      props.operation ? [] : rows.value.filter((r) => r.vehicle.relation > 1),
    );

    return () => (
      <div class="holo-map__roster-overlay" aria-hidden="true">
        <div class="holo-map__roster-board">
          {teamTable(allies.value, false, props.showKills)}
          {enemies.value.length ? teamTable(enemies.value, true, props.showKills) : null}
        </div>
      </div>
    );  },
});
