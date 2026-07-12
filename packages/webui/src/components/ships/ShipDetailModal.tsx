import { computed, defineComponent, ref, watch } from "vue";
import { Star, Diamond, Sparkles, Shield, Crosshair, Target, Plane, Gauge, Eye, HelpCircle } from "lucide-vue-next";

import SModal from "@/components/base/SModal";
import STag from "@/components/base/STag";
import SSpinner from "@/components/base/SSpinner";
import { useAccountStore } from "@/stores/account";
import { useShipStatsStore } from "@/stores/shipStats";
import { useTrendsStore } from "@/stores/trends";
import { api, type ShipInfo } from "@/api";
import { t } from "@/i18n";
import { winrateColor, prTier } from "@/utils/winrate";
import { buildShipSpecs } from "./shipSpecs";
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
              <STag variant="primary">Tier {props.ship.tier}</STag>
              <STag variant="primary">{typeLabel(props.ship.type)}</STag>
              <STag variant="neutral">{nationLabel(props.ship.nation)}</STag>
              {props.ship.isPremium ? (
                <STag variant="gold"><Star size={12} fill="currentColor" /> {t("ships.premium")}</STag>
              ) : null}
              {props.ship.isSpecial ? (
                <STag variant="info"><Diamond size={12} /> {t("ships.special")}</STag>
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
                <SpecsPanel profile={dp.value} />
              ) : null}

              {tab.value === "armor" ? (
                <div class="ship-detail__armor">
                  {gpLoading.value ? (
                    <SSpinner center size="lg" text={t("ships.detail.gameparamsLoading")} />
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

/** Player-friendly specs panel. Renders the grouped, labelled, unit-formatted
 *  spec tree produced by `buildShipSpecs` — modelled on 浩舰's grouped layout
 *  (Survivability / Main Battery / Torpedoes / Anti-Air / Mobility /
 *  Concealment). Each group is a card with an icon header; rows show a
 *  human-readable label, the formatted value, and an optional help icon
 *  (hover/focus tooltip) explaining what the stat means to new players.
 *  Groups with no rows are omitted upstream, so a destroyer simply has no
 *  Anti-Air card rather than showing "—". */
const SpecsPanel = defineComponent({
  name: "SpecsPanel",
  props: {
    profile: { type: Object as () => Record<string, unknown> | null, default: null },
  },
  setup(props) {
    const groups = computed(() => buildShipSpecs(props.profile));
    // Map icon name (from shipSpecs) → lucide component, resolved once.
    const iconFor = (name: string) => {
      switch (name) {
        case "Shield": return Shield;
        case "Crosshair": return Crosshair;
        case "Target": return Target;
        case "Plane": return Plane;
        case "Gauge": return Gauge;
        case "Eye": return Eye;
        default: return Shield;
      }
    };
    return () => {
      if (groups.value.length === 0) {
        return <p class="ship-detail__empty">{t("ships.detail.noSpecs")}</p>;
      }
      return (
        <div class="specs-panel">
          {groups.value.map((g) => {
            const Icon = iconFor(g.icon);
            return (
              <section class="specs-group">
                <header class="specs-group__head">
                  <Icon size={14} />
                  <h5 class="specs-group__title">{t(`ships.spec.group.${g.group}`)}</h5>
                </header>
                <dl class="specs-group__rows">
                  {g.rows.map((row) => (
                    <div class="specs-group__row" key={row.key}>
                      <dt class="specs-group__label">
                        {t(`ships.spec.${row.key}`)}
                        {row.hint ? (
                          <span class="specs-group__hint" title={t(`ships.spec.${row.hint}`)}>
                            <HelpCircle size={11} />
                          </span>
                        ) : null}
                      </dt>
                      <dd class="specs-group__value">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
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
                  <span class="trend-bars__patch" title={patch.summary}><Sparkles size={12} /></span>
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
