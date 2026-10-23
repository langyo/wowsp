/**
 * RankedShipTable — the season modal's ship breakdown: the ships the
 * player fielded in the SELECTED season, under the KPI card, filtered
 * like the water-table lists.
 *
 * Rows come from `get_ranked_ship_stats` (per-ship per-season, sliced to
 * the selected season here). CN's vortex mirror has no per-ship season
 * arm — the store's empty ship slot on that realm is the protocol — so
 * the table falls back to the player's CAREER ranked rows from the shared
 * ship-stats cache and says so in a hint line. The league filter still
 * applies there through the season's league→tier metadata.
 *
 * Filters: the full water-table ShipFilterBar EXCEPT the tier slider —
 * its job is taken by the league bracket buttons (黄金/白银/青铜), which
 * map a pick onto that league's ship-tier window of THIS season (every
 * season designates a different band per league) and pre-filter the rows
 * before the bar sees them.
 */
import { computed, defineComponent, ref } from "vue";

import { HkSpinner } from "@celestia-island/hikari";

import ErrorCard from "@/components/base/ErrorCard";
import ShipFilterBar, { type FilterState } from "@/components/ships/ShipFilterBar";
import { useRankedStore } from "@/stores/ranked";
import { useShipStatsStore } from "@/stores/shipStats";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { t } from "@/i18n";
import { useLanguage } from "@/i18n/useLanguage";
import { leagueFromNumber, leagueTierWindow } from "@/utils/ranked";
import { winrateColor } from "@/utils/winrate";
import { shipOfflineEntry } from "@/features/holographic/modelLoader";
import { shipIcon } from "@/features/holographic/shipIcons";
import { tierToRoman } from "@wowsp/holo";
import type { PlayerShipStats, RankedSeasonStats } from "@/api";
import "./RankedShipTable.scss";

/** Ship-type abbreviations (the water-table row's vocabulary). */
const TYPE_SHORT: Record<string, string> = {
  Battleship: "BB",
  AirCarrier: "CV",
  Cruiser: "CA/CL",
  Destroyer: "DD",
  Submarine: "SS",
};

export default defineComponent({
  name: "RankedShipTable",
  props: {
    /** The modal's selected season — supplies the ship rows' season slice
     *  and the league→tier windows behind the bracket buttons. */
    season: { type: Object as () => RankedSeasonStats, required: true },
  },
  setup(props) {
    const ranked = useRankedStore();
    const shipStats = useShipStatsStore();
    const encyclopedia = useEncyclopediaStore();
    const { dataLanguage } = useLanguage();

    /** Picked league number (1/2/3); null = all leagues. */
    const bracket = ref<number | null>(null);

    /** Ship metadata: encyclopedia first, offline DB as fallback (the
     *  same join the water-table rows use). */
    const metaOf = (shipId: number) => {
      const enc = encyclopedia.byId.get(shipId);
      if (enc) return enc;
      const off = shipOfflineEntry(shipId);
      return off
        ? {
            shipId,
            tier: off.tier ?? 0,
            type: off.type ?? "",
            name:
              off.names?.[dataLanguage.value] ??
              off.names?.["en-US"] ??
              `#${shipId}`,
          }
        : null;
    };

    /** True when the rows are the CAREER ranked split (CN fallback) rather
     *  than the season slice: the store leaves its ship slot empty on CN
     *  by protocol AND the fetch itself did not fail (an error state owns
     *  the section then, with no promise of a list under it). */
    const careerFallback = computed(() => {
      if (ranked.shipSeasons.length > 0 || ranked.shipsLoading || ranked.shipsError) {
        return false;
      }
      const id = ranked.accountId;
      const realm = ranked.realm;
      return id != null && realm === "cn";
    });

    /** An empty mode bucket — ShipModeStats minus the fields the row
     *  overwrite fills in. */
    const ZERO_MODE = {
      damageCaused: 0,
      frags: 0,
      survivedBattles: 0,
      winrate: 0,
      avgDamage: 0,
    };

    /** The season's rows in the water-table row shape the filter bar
     *  consumes (career rows on CN already ARE that shape). The mode
     *  splits ride along so the bar's 组队模式 chips filter the season
     *  slice truthfully. */
    const baseRows = computed<PlayerShipStats[]>(() => {
      const id = ranked.accountId;
      const realm = ranked.realm;
      if (id == null || realm == null) return [];
      if (careerFallback.value) {
        return (shipStats.cache.get(`${realm}_${id}`) ?? []).filter(
          (r) => (r.modes?.ranked?.battles ?? 0) > 0,
        );
      }
      return ranked.shipSeasons
        .filter((r) => r.seasonId === props.season.seasonId)
        .map((r) => ({
          shipId: r.shipId,
          name: "",
          battles: r.battles,
          wins: r.wins,
          damageCaused: r.damageDealt,
          frags: r.frags,
          survivedBattles: r.survivedBattles,
          winrate: r.battles > 0 ? (r.wins / r.battles) * 100 : 0,
          avgDamage: r.battles > 0 ? r.damageDealt / r.battles : 0,
          lastBattleTime: 0,
          modes: {
            solo: { ...ZERO_MODE, battles: r.solo.battles, wins: r.solo.wins },
            div2: r.div2 ? { ...ZERO_MODE, battles: r.div2.battles, wins: r.div2.wins } : null,
            div3: r.div3 ? { ...ZERO_MODE, battles: r.div3.battles, wins: r.div3.wins } : null,
            coop: null,
            ranked: { ...ZERO_MODE, battles: r.battles, wins: r.wins },
          },
        }));
    });

    /** The bracket pick pre-filters rows by that league's tier window of
     *  this season before the shared filter bar takes over. */
    const bracketRows = computed<PlayerShipStats[]>(() => {
      if (bracket.value == null) return baseRows.value;
      const win = leagueTierWindow(props.season.leagues, bracket.value);
      if (!win) return baseRows.value;
      const [lo, hi] = win;
      return baseRows.value.filter((r) => {
        const tier = metaOf(r.shipId)?.tier ?? 0;
        return tier >= lo && tier <= hi;
      });
    });

    const filterState = ref<FilterState>({ ships: [], hits: new Map() });
    const filteredShips = computed(() => filterState.value.ships);

    const displayName = (s: PlayerShipStats): string =>
      filterState.value.hits.get(s.shipId) ??
      metaOf(s.shipId)?.name ??
      `#${s.shipId}`;

    /** "IX–X" / "VIII" — the tier band a bracket button stands for. */
    const tierSpan = (lo: number, hi: number) =>
      lo === hi ? tierToRoman(lo) : `${tierToRoman(lo)}–${tierToRoman(hi)}`;

    return () => (
      <div class="ranked-ships">
        <div class="ranked-ships__head">
          <span class="ranked-ships__title">{t("stats.rankedShipsTitle")}</span>
          {props.season.leagues?.length ? (
            <div class="ranked-ships__brackets" role="group" aria-label={t("stats.rankedBracketLabel")}>
              <button
                type="button"
                class={[
                  "ranked-ships__bracket",
                  bracket.value === null ? "ranked-ships__bracket--on" : null,
                ]}
                onClick={() => (bracket.value = null)}
              >
                <span>{t("stats.bracketAll")}</span>
              </button>
              {props.season.leagues.map((l) => {
                const lg = leagueFromNumber(l.league);
                if (!lg) return null;
                return (
                  <button
                    type="button"
                    key={l.league}
                    class={[
                      "ranked-ships__bracket",
                      `ranked-ships__bracket--${lg}`,
                      bracket.value === l.league ? "ranked-ships__bracket--on" : null,
                    ]}
                    onClick={() =>
                      (bracket.value = bracket.value === l.league ? null : l.league)
                    }
                  >
                    <span>{t(`stats.league.${lg}`)}</span>
                    <em>{tierSpan(l.minTier, l.maxTier)}</em>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        {careerFallback.value ? (
          <p class="ranked-ships__note">{t("stats.rankedShipsCareerNote")}</p>
        ) : null}

        {ranked.shipsLoading ? (
          <div class="ranked-ships__state">
            <HkSpinner size="sm" />
          </div>
        ) : ranked.shipsError ? (
          /* Load failure — the standard error card: the localized sentence
             leads, the raw backend failure rides structured in the pane. */
          <ErrorCard error={ranked.shipsError} description={t("stats.rankedShipsError")} />
        ) : baseRows.value.length === 0 ? (
          <p class="ranked-ships__state">{t("stats.rankedShipsEmpty")}</p>
        ) : (
          <>
            <ShipFilterBar
              ships={bracketRows.value}
              realm={ranked.realm ?? ""}
              exclude={["tier"]}
              persistKey="wowsp.shipFilter.ranked.v1"
              onChange={(v) => (filterState.value = v)}
            />
            {filteredShips.value.length === 0 ? (
              <p class="ranked-ships__state">{t("dashboard.noShipsMatchFilter")}</p>
            ) : (
              <div class="ranked-ships__list">
                {filteredShips.value.map((s) => {
                  const meta = metaOf(s.shipId);
                  const icon = shipIcon(meta?.type ?? "", "plain");
                  const typeKey =
                    Object.keys(TYPE_SHORT).find((k) => (meta?.type ?? "").startsWith(k)) ?? "";
                  return (
                    <div class="ranked-ships__ship" key={s.shipId}>
                      <span class="ranked-ships__ship-ico">
                        {icon && icon.complete && icon.naturalWidth > 0 ? (
                          <img src={icon.src} width={22} height={22} alt="" />
                        ) : null}
                      </span>
                      <span class="ranked-ships__ship-type">{TYPE_SHORT[typeKey] ?? "?"}</span>
                      <em class="ranked-ships__ship-tier">
                        {meta?.tier ? tierToRoman(meta.tier) : ""}
                      </em>
                      <span class="ranked-ships__ship-name">{displayName(s)}</span>
                      <span class="ranked-ships__ship-battles">{s.battles.toLocaleString()}</span>
                      <span
                        class="ranked-ships__ship-wr"
                        style={{ color: winrateColor(s.winrate), fontWeight: 600 }}
                      >
                        {s.winrate.toFixed(1)}%
                      </span>
                      <span class="ranked-ships__ship-dmg">
                        {s.battles > 0 && s.avgDamage <= 0
                          ? t("stats.dataAnomaly")
                          : Math.round(s.avgDamage).toLocaleString()}
                      </span>
                      <span class="ranked-ships__ship-kd">
                        {(s.frags / Math.max(1, s.battles)).toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    );
  },
});
