import { computed, defineComponent, ref, watch } from "vue";

import SModal from "@/components/base/SModal";
import { useAccountStore } from "@/stores/account";
import { useShipStatsStore } from "@/stores/shipStats";
import { useTrendsStore } from "@/stores/trends";
import { api, type ShipInfo } from "@/api";
import { t } from "@/i18n";
import { winrateColor, prTier } from "@/utils/winrate";
import "./ShipDetailModal.scss";

/**
 * Ship detail modal with 4 tabs:
 *  - Specs: WG default_profile fields (HP / artillery / mobility / etc.)
 *  - Armor & Ballistics: GameParams lazy-load (wowsunpack JSON)
 *  - My Stats: per-player per-ship stats from ships/stats + trend line
 *  - Server Trend: community trend placeholder
 *
 * GameParams is fetched on first Armor tab activation (lazy), cached by the
 * Rust layer. My Stats tab also lazy-loads the player's ship stats + trend.
 */
export default defineComponent({
  name: "ShipDetailModal",
  props: {
    ship: { type: Object as () => ShipInfo | null, default: null },
    gameRoot: { type: String, default: "" },
  },
  emits: {
    close: () => true,
  },
  setup(props, { emit }) {
    const accounts = useAccountStore();
    const shipStats = useShipStatsStore();
    const trends = useTrendsStore();

    const tab = ref<"specs" | "armor" | "mystats" | "community">("specs");

    // ── Armor tab: lazy GameParams ─────────────────────────────────────
    const gameparams = ref<unknown>(null);
    const gpLoading = ref(false);
    const gpError = ref<string | null>(null);
    const gpFetched = ref(false);

    async function loadGameparams() {
      if (gpFetched.value || !props.ship || !props.gameRoot) return;
      gpLoading.value = true;
      gpError.value = null;
      try {
        gameparams.value = await api.getShipGameparams(props.ship.shipId, props.gameRoot);
      } catch (e) {
        gpError.value = (e as Error).message;
      } finally {
        gpLoading.value = false;
        gpFetched.value = true;
      }
    }

    // ── My Stats tab: lazy player ship stats + trend ───────────────────
    const myStatsLoaded = ref(false);
    async function loadMyStats() {
      if (myStatsLoaded.value) return;
      const acc = accounts.activeAccount;
      if (!acc || !props.ship) return;
      myStatsLoaded.value = true;
      void shipStats.load(acc.accountId, acc.realm).catch(() => {});
      void trends.loadPlayer(acc.accountId, acc.realm).catch(() => {});
    }

    // Reset state when ship changes (modal reopen).
    watch(
      () => props.ship,
      (s) => {
        tab.value = "specs";
        gameparams.value = null;
        gpFetched.value = false;
        gpError.value = null;
        myStatsLoaded.value = false;
        if (s) void trends.loadCommunity(s.shipId);
      },
    );

    function selectTab(name: typeof tab.value) {
      tab.value = name;
      if (name === "armor") void loadGameparams();
      if (name === "mystats") void loadMyStats();
    }

    const open = computed(() => props.ship !== null);

    const myShipStats = computed(() => {
      const acc = accounts.activeAccount;
      if (!acc || !props.ship) return null;
      return shipStats.getShip(acc.accountId, acc.realm, props.ship.shipId);
    });

    // Trend buckets that affect this ship (patches touching its shipId).
    const relevantPatches = computed(() => {
      if (!props.ship || !trends.playerTrend) return [];
      return trends.playerTrend.patches.filter((p) => p.shipIds.includes(props.ship!.shipId));
    });

    const dp = computed(() => (props.ship?.defaultProfile ?? {}) as Record<string, unknown>);

    function nationLabel(code: string): string {
      return t(`ships.nation.${code}`, {}) || code;
    }
    function typeLabel(code: string): string {
      return t(`ships.type.${code}`, {}) || code;
    }

    return () => (
      <SModal
        modelValue={open.value}
        onUpdate:modelValue={(v: boolean) => !v && emit("close")}
        title={props.ship?.name ?? t("ships.detail.title")}
        width="48rem"
      >
        {!props.ship ? null : (
          <div class="ship-detail">
            {/* identity header */}
            <div class="ship-detail__id">
              <span class="ship-detail__tier">Tier {props.ship.tier}</span>
              <span class="ship-detail__type">{typeLabel(props.ship.type)}</span>
              <span class="ship-detail__nation">{nationLabel(props.ship.nation)}</span>
              {props.ship.isPremium ? (
                <span class="ship-detail__badge">★ Premium</span>
              ) : null}
              {props.ship.isSpecial ? (
                <span class="ship-detail__badge ship-detail__badge--special">◇ Special</span>
              ) : null}
            </div>

            {props.ship.description ? (
              <p class="ship-detail__desc">{props.ship.description}</p>
            ) : null}

            {/* tab bar */}
            <div class="ship-detail__tabs">
              {(["specs", "armor", "mystats", "community"] as const).map((name) => (
                <button
                  class={[
                    "ship-detail__tab",
                    tab.value === name ? "ship-detail__tab--on" : "",
                  ]}
                  onClick={() => selectTab(name)}
                >
                  {t(`ships.detail.tab${name === "specs" ? "Specs" : name === "armor" ? "Armor" : name === "mystats" ? "MyStats" : "Community"}`)}
                </button>
              ))}
            </div>

            {/* tab content */}
            <div class="ship-detail__body">
              {tab.value === "specs" ? (
                <div class="ship-detail__specs">
                  <SpecsGrid label={t("ships.detail.hull")} data={dp.value.hull as object | undefined} />
                  <SpecsGrid label={t("ships.detail.mainBattery")} data={dp.value.artillery as object | undefined} />
                  <SpecsGrid label={t("ships.detail.torpedoes")} data={dp.value.torpedoes as object | undefined} />
                  <SpecsGrid label={t("ships.detail.mobility")} data={dp.value.mobility as object | undefined} />
                  <SpecsGrid label={t("ships.detail.concealment")} data={dp.value.concealment as object | undefined} />
                  <SpecsGrid label={t("ships.detail.antiAircraft")} data={dp.value.anti_aircraft as object | undefined} />
                </div>
              ) : null}

              {tab.value === "armor" ? (
                <div class="ship-detail__armor">
                  {gpLoading.value ? (
                    <p>{t("ships.detail.gameparamsLoading")}</p>
                  ) : gpError.value ? (
                    <p class="ship-detail__error">
                      {t("ships.detail.gameparamsError", { error: gpError.value })}
                    </p>
                  ) : gameparams.value ? (
                    <pre class="ship-detail__json">
                      {JSON.stringify(gameparams.value, null, 2)}
                    </pre>
                  ) : (
                    <p>{t("ships.detail.gameparamsMissing")}</p>
                  )}
                </div>
              ) : null}

              {tab.value === "mystats" ? (
                <div class="ship-detail__mystats">
                  {myShipStats.value ? (
                    <div class="ship-detail__mystats-grid">
                      <Stat label={t("stats.battles")} value={String(myShipStats.value.battles)} />
                      <Stat
                        label={t("stats.winrate")}
                        value={`${myShipStats.value.winrate.toFixed(1)}%`}
                        color={winrateColor(myShipStats.value.winrate)}
                      />
                      <Stat label={t("stats.avgDamage")} value={myShipStats.value.avgDamage.toFixed(0)} />
                      <Stat label={t("stats.kdRatio")} value={(myShipStats.value.frags / Math.max(1, myShipStats.value.battles - myShipStats.value.survivedBattles)).toFixed(2)} />
                    </div>
                  ) : (
                    <p>{t("ships.detail.noMyStats")}</p>
                  )}

                  {trends.playerTrend && trends.playerTrend.buckets.length > 0 ? (
                    <div class="ship-detail__trend">
                      <h4>{t("trend.winrateOverTime")}</h4>
                      <TrendBars
                        buckets={trends.playerTrend.buckets}
                        patches={relevantPatches.value}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}

              {tab.value === "community" ? (
                <div class="ship-detail__community">
                  {trends.communityTrend?.available ? (
                    <TrendBars buckets={trends.communityTrend.buckets} patches={[]} />
                  ) : (
                    <p>{t("ships.detail.communityUnavailable")}</p>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        )}
      </SModal>
    );
  },
});

/** Small inline component: renders a sub-object of default_profile as key/value
 *  rows. Recurses one level for nested objects. */
const SpecsGrid = defineComponent({
  name: "SpecsGrid",
  props: {
    label: { type: String, required: true },
    data: { type: Object, default: undefined },
  },
  setup(props) {
    return () => {
      if (!props.data || typeof props.data !== "object") return null;
      const entries = Object.entries(props.data).slice(0, 12);
      return (
        <div class="specs-grid">
          <h5 class="specs-grid__title">{props.label}</h5>
          <dl class="specs-grid__rows">
            {entries.map(([k, v]) => (
              <div class="specs-grid__row">
                <dt>{k}</dt>
                <dd>{typeof v === "object" ? "…" : String(v)}</dd>
              </div>
            ))}
          </dl>
        </div>
      );
    };
  },
});

const Stat = defineComponent({
  name: "Stat",
  props: {
    label: { type: String, required: true },
    value: { type: String, required: true },
    color: { type: String, default: undefined },
  },
  setup(props) {
    return () => (
      <div class="stat">
        <span class="stat__label">{props.label}</span>
        <span class="stat__value" style={props.color ? { color: props.color } : undefined}>
          {props.value}
        </span>
      </div>
    );
  },
});

/** Mini trend visualization — one bar per version bucket, height = winrate.
 *  Patches touching the ship are annotated above the bar. Pure SVG, no chart
 *  library dependency. */
const TrendBars = defineComponent({
  name: "TrendBars",
  props: {
    buckets: { type: Array as () => Array<{ version: string; winrateAvg: number; avgDamage: number; snapshotCount: number }>, required: true },
    patches: { type: Array as () => Array<{ version: string; summary: string }>, default: () => [] },
  },
  setup(props) {
    return () => {
      if (props.buckets.length === 0) {
        return <p class="trend-bars__empty">{t("trend.noSnapshots")}</p>;
      }
      const maxWr = Math.max(...props.buckets.map((b) => b.winrateAvg), 60);
      const minWr = Math.min(...props.buckets.map((b) => b.winrateAvg), 40);
      const range = Math.max(maxWr - minWr, 1);
      return (
        <div class="trend-bars">
          {props.buckets.map((b) => {
            const heightPct = 20 + (80 * (b.winrateAvg - minWr)) / range;
            const patch = props.patches.find((p) => p.version === b.version);
            return (
              <div class="trend-bars__col">
                {patch ? (
                  <span class="trend-bars__patch" title={patch.summary}>★</span>
                ) : null}
                <div
                  class="trend-bars__bar"
                  style={{
                    height: `${heightPct}%`,
                    background: winrateColor(b.winrateAvg),
                  }}
                  title={`${b.version}: ${b.winrateAvg.toFixed(1)}% WR, ${b.avgDamage.toFixed(0)} avg dmg (${b.snapshotCount} snapshots)`}
                />
                <span class="trend-bars__label">{b.version}</span>
              </div>
            );
          })}
        </div>
      );
    };
  },
});
