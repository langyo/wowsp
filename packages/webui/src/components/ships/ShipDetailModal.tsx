import { computed, defineComponent, ref, watch } from "vue";
import { Sparkles, Shield, Crosshair, Target, Plane, Gauge, Eye, HelpCircle } from "lucide-vue-next";

import SModal from "@/components/base/SModal";
import STag from "@/components/base/STag";
import SSpinner from "@/components/base/SSpinner";
import NationFlag from "@/components/base/NationFlag";
import { useAccountStore } from "@/stores/account";
import { useShipStatsStore } from "@/stores/shipStats";
import { useTrendsStore } from "@/stores/trends";
import { api, type ShipInfo } from "@/api";
import { t } from "@/i18n";
import { winrateColor } from "@/utils/winrate";
import { buildShipSpecs } from "./shipSpecs";
import { buildArmorScheme, buildBallistics } from "./ballistics";
import SkillBuilder from "./SkillBuilder";
import ShipyardPanel from "./ShipyardPanel";
import ShipStage, { type FocusZone } from "./ShipStage";
import WeaponBar from "./WeaponBar";
import ArmorBelt from "./ArmorBelt";
import { shipRarity, RARITY_VARIANT } from "@/utils/shipRarity";
import { SHIP_TYPE_SHORT } from "@/utils/shipAggregation";
import { tierToRoman } from "@/utils/tierRoman";
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

    const tab = ref<"specs" | "armor" | "mystats" | "community" | "skill" | "shipyard">("specs");

    // ── Shipyard: shared skill allocation + HP (for trigger skills) ──────
    // Lifted here so switching tabs preserves the build; SkillBuilder (in the
    // skill tab) and ShipyardPanel both bind to these.
    const shipyardRank = ref<Record<string, number>>({});
    const shipyardHealthPct = ref(1);

    // ── Holographic stage (ShipStage owns its own Three.js lifecycle) ──
    const stageRef = ref<InstanceType<typeof ShipStage> | null>(null);
    function onWeaponFocus(zone: FocusZone) {
      stageRef.value?.focusZone(zone);
    }

    // ── Armor tab + WeaponBar: lazy GameParams ─────────────────────────
    const gameparams = ref<unknown>(null);
    const gpLoading = ref(false);
    const gpError = ref<string | null>(null);
    const gpFetched = ref(false);

    async function loadGameparams() {
      if (gpFetched.value || !props.ship) return;
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

    // Reset state when ship changes (modal reopen). Pre-fetch GameParams so the
    // WeaponBar under the stage is populated immediately (ArmorBelt shares it).
    watch(
      () => props.ship,
      (s) => {
        tab.value = "specs";
        gameparams.value = null;
        gpFetched.value = false;
        gpError.value = null;
        myStatsLoaded.value = false;
        if (s) {
          void loadGameparams();
          void trends.loadCommunity(s.shipId);
        }
      },
      { immediate: true },
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

    /** Derived rarity + tier short code for the header. */
    const rarity = computed(() =>
      props.ship ? shipRarity(props.ship) : "common",
    );
    const typeShort = computed(() =>
      props.ship ? SHIP_TYPE_SHORT[props.ship.type] ?? "?" : "?",
    );

    return () => (
      <SModal
        modelValue={open.value}
        onUpdate:modelValue={(v: boolean) => !v && emit("close")}
        title={props.ship ? `${tierToRoman(props.ship.tier)} ${props.ship.name}` : t("ships.detail.title")}
        width="58rem"
      >
        {!props.ship ? null : (
          <div class="ship-detail">
            {/* holographic stage (3D orbit + 2D toggle, owns its own lifecycle) */}
            <ShipStage ref={stageRef} ship={props.ship} />

            {/* weapon module bar — click a module to focus the 3D camera */}
            <WeaponBar gameparams={gameparams.value} onFocus={onWeaponFocus} />

            {/* identity header */}
            <div class="ship-detail__id">
              <STag variant="primary">{tierToRoman(props.ship.tier)}</STag>
              <STag variant="primary">{typeLabel(props.ship.type)} ({typeShort.value})</STag>
              <NationFlag
                nation={props.ship.nation}
                label={nationLabel(props.ship.nation)}
                variant="flag"
                size="md"
                showLabel
              />
              <STag variant={RARITY_VARIANT[rarity.value]}>
                {t(`ships.rarity.${rarity.value}`)}
              </STag>
            </div>

            {props.ship.description ? (
              <p class="ship-detail__desc">{props.ship.description}</p>
            ) : null}

            {/* tab bar */}
            <div class="ship-detail__tabs">
              {(["specs", "armor", "mystats", "community", "skill", "shipyard"] as const).map((name) => (
                <button
                  class={[
                    "ship-detail__tab",
                    tab.value === name ? "ship-detail__tab--on" : "",
                  ]}
                  onClick={() => selectTab(name)}
                >
                  {t(`ships.detail.tab${name === "specs" ? "Specs" : name === "armor" ? "Armor" : name === "mystats" ? "MyStats" : name === "community" ? "Community" : name === "skill" ? "Skill" : "Shipyard"}`)}
                </button>
              ))}
            </div>

            {/* tab content — cross-fade between tabs */}
            <div class="ship-detail__body">
              <Transition name="s-fade-slide" mode="out-in">
                {tab.value === "specs" ? (
                  <div key="specs"><SpecsPanel profile={dp.value} nation={props.ship.nation} /></div>
                ) : tab.value === "armor" ? (
                  <div class="ship-detail__armor" key="armor">
                    {gpLoading.value ? (
                    <SSpinner center size="lg" text={t("ships.detail.gameparamsLoading")} />
                  ) : gpError.value ? (
                    <div class="ship-detail__error-block">
                      <p class="ship-detail__error">
                        {t("ships.detail.gameparamsError", { error: gpError.value })}
                      </p>
                      <p class="ship-detail__hint">{t("ships.detail.gameparamsHint")}</p>
                    </div>
                  ) : gameparams.value ? (
                    <>
                      <ArmorBelt gameparams={gameparams.value as Record<string, any>} />
                      <BallisticsPanel gp={gameparams.value} />
                    </>
                  ) : (
                    <div class="ship-detail__error-block">
                      <p>{t("ships.detail.gameparamsMissing")}</p>
                      <p class="ship-detail__hint">{t("ships.detail.gameparamsHint")}</p>
                    </div>
                  )}
                </div>
              ) : tab.value === "mystats" ? (
                <div class="ship-detail__mystats" key="mystats">
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
              ) : tab.value === "community" ? (
                <div class="ship-detail__community" key="community">
                  {trends.communityTrend?.available ? (
                    <TrendBars buckets={trends.communityTrend.buckets} patches={[]} />
                  ) : (
                    <p>{t("ships.detail.communityUnavailable")}</p>
                  )}
                </div>
              ) : tab.value === "shipyard" ? (
                <div class="ship-detail__shipyard" key="shipyard">
                  <ShipyardPanel
                    ship={props.ship}
                    rank={shipyardRank.value}
                    healthPct={shipyardHealthPct.value}
                    onUpdate:rank={(v: Record<string, number>) => (shipyardRank.value = v)}
                    onUpdate:healthPct={(v: number) => (shipyardHealthPct.value = v)}
                  />
                </div>
              ) : (
                <div class="ship-detail__skill" key="skill">
                  <SkillBuilder shipType={props.ship.type} />
                </div>
              )}
              </Transition>
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
    nation: { type: String, default: undefined },
  },
  setup(props) {
    const groups = computed(() => buildShipSpecs(props.profile, props.nation));
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

/**
 * Armor & ballistics panel — replaces the old raw-JSON dump of the GameParams
 * subtree. Extracts the armor scheme (citadel / deck / belt / torpedo belt /
 * extremities) and shell ballistics (sigma, dispersion, per-shell mass /
 * muzzle / airDrag + estimated penetration) via the `ballistics` module, and
 * renders them as the same grouped card layout as SpecsPanel.
 *
 * The penetration curve is an *estimate* (derived from mass × muzzle² ×
 * airDrag), not the exact in-game krupp formula — the panel labels it as such.
 */
const BallisticsPanel = defineComponent({
  name: "BallisticsPanel",
  props: {
    gp: { type: Object as () => Record<string, unknown> | null, default: null },
  },
  setup(props) {
    const armorGroup = computed(() => buildArmorScheme(props.gp));
    const ballisticsGroups = computed(() => buildBallistics(props.gp));
    const anyGroups = computed(
      () => armorGroup.value != null || ballisticsGroups.value.length > 0,
    );
    const iconFor = (name: string) => {
      switch (name) {
        case "Shield": return Shield;
        case "Crosshair": return Crosshair;
        default: return Shield;
      }
    };
    /** Resolve a row label: armor/ballistics rows use keys under their own
     *  i18n namespaces, falling back to the spec namespace for shared keys. */
    function rowLabel(row: { key: string }): string {
      const armor = t(`ships.armor.${row.key}`, {});
      if (armor && armor !== `ships.armor.${row.key}`) return armor;
      const ball = t(`ships.ballistics.${row.key}`, {});
      if (ball && ball !== `ships.ballistics.${row.key}`) return ball;
      const spec = t(`ships.spec.${row.key}`, {});
      if (spec && spec !== `ships.spec.${row.key}`) return spec;
      return row.key;
    }
    function rowHint(row: { hint?: string }): string | null {
      if (!row.hint) return null;
      const ball = t(`ships.ballistics.${row.hint}`, {});
      if (ball && ball !== `ships.ballistics.${row.hint}`) return ball;
      const spec = t(`ships.spec.${row.hint}`, {});
      if (spec && spec !== `ships.spec.${row.hint}`) return spec;
      return null;
    }
    return () => {
      if (!anyGroups.value) {
        return (
          <div class="ship-detail__error-block">
            <p>{t("ships.detail.noBallistics")}</p>
          </div>
        );
      }
      return (
        <div class="ballistics-panel">
          {armorGroup.value ? (
            <section class="specs-group">
              <header class="specs-group__head">
                <Shield size={14} />
                <h5 class="specs-group__title">{t("ships.armor.groupTitle")}</h5>
              </header>
              <dl class="specs-group__rows">
                {armorGroup.value.rows.map((row) => {
                  const hint = rowHint(row);
                  return (
                    <div class="specs-group__row" key={row.key}>
                      <dt class="specs-group__label">
                        {rowLabel(row)}
                        {hint ? (
                          <span class="specs-group__hint" title={hint}>
                            <HelpCircle size={11} />
                          </span>
                        ) : null}
                      </dt>
                      <dd class="specs-group__value">{row.value}</dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          ) : null}

          {ballisticsGroups.value.map((g, gi) => {
            const Icon = iconFor(g.icon);
            return (
              <section class="specs-group" key={gi}>
                <header class="specs-group__head">
                  <Icon size={14} />
                  <h5 class="specs-group__title">{t("ships.ballistics.groupTitle")}</h5>
                </header>
                <dl class="specs-group__rows">
                  {g.rows.map((row) => {
                    const hint = rowHint(row);
                    return (
                      <div class="specs-group__row" key={row.key}>
                        <dt class="specs-group__label">
                          {rowLabel(row)}
                          {hint ? (
                            <span class="specs-group__hint" title={hint}>
                              <HelpCircle size={11} />
                            </span>
                          ) : null}
                        </dt>
                        <dd class="specs-group__value">{row.value}</dd>
                      </div>
                    );
                  })}
                </dl>
              </section>
            );
          })}

          <p class="ballistics-panel__approx">{t("ships.detail.ballisticsApprox")}</p>
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
