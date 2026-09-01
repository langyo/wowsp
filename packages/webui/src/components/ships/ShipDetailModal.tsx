import { computed, defineComponent, ref, Transition, watch } from "vue";
import { Sparkles, Shield, Crosshair, Target, Plane, Gauge, Eye, HelpCircle } from "lucide-vue-next";

import { HModal, HTag, HTabs, useToast } from "@celestia-island/hikari";

import NationFlag from "@/components/base/NationFlag";
import { useAccountStore } from "@/stores/account";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useShipStatsStore } from "@/stores/shipStats";
import { useTrendsStore } from "@/stores/trends";
import { api, type ShipInfo } from "@/api";
import { useLanguage } from "@/i18n/useLanguage";
import { nationNameFromDb } from "@/features/holographic/modelLoader";
import { t } from "@/i18n";
import { winrateColor } from "@/utils/winrate";
import { buildShipSpecs } from "./shipSpecs";
import SkillBuilder from "./SkillBuilder";
import DataObserver from "./DataObserver";
import ShipStage, { type FocusZone, type ArmorZone } from "./ShipStage";
import WeaponBar from "./WeaponBar";
import { shipRarity, RARITY_VARIANT } from "@/utils/shipRarity";
import { SHIP_TYPE_SHORT } from "@/utils/shipAggregation";
import { tierToRoman } from "@/utils/tierRoman";
import "./ShipDetailModal.scss";

/**
 * Ship detail modal with tabs:
 *  - Specs: WG default_profile fields (HP / artillery / mobility / etc.)
 *  - Armor & Ballistics: GameParams lazy-load (wowsunpack JSON)
 *  - My Stats: per-player per-ship stats + trend line
 *  - Server Trend: community trend
 *  - Captain Skills: skill planner + data observer (replaces 2D/3D preview)
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
    const toast = useToast();

    const tab = ref<"specs" | "mystats" | "community" | "skill">("specs");

    // ── Captain skills state (shared between SkillBuilder + DataObserver) ──
    const skillRank = ref<Record<string, number>>({});
    const skillHealthPct = ref(1);

    // ── Holographic stage ─────────────────────────────────────────────────
    const stageRef = ref<
      | (InstanceType<typeof ShipStage> & { focusZone?: (zone: FocusZone, count?: number) => void })
      | null
    >(null);
    function onWeaponFocus(zone: FocusZone, count?: number) {
      stageRef.value?.focusZone?.(zone, count ?? 1);
    }

    // ── Armor tab: lazy GameParams ─────────────────────────────────────────
    const gameparams = ref<unknown>(null);
    const gpLoading = ref(false);
    const gpError = ref<string | null>(null);
    const gpFetched = ref(false);

    async function loadGameparams() {
      if (gpFetched.value || !props.ship) return;
      gpLoading.value = true;
      gpError.value = null;
      const toastId = toast.loading(t("ships.detail.gameparamsLoading"));
      // Safety timeout: dismiss loading toast after 15s if still pending.
      const timer = setTimeout(() => toast.remove(toastId), 15000);
      try {
        gameparams.value = await api.getShipGameparams(props.ship.shipId, props.gameRoot);
      } catch (e) {
        const msg = (e as Error).message || String(e);
        gpError.value = msg;
        toast.error(`${t("ships.detail.gameparamsErrorTip")}\n${msg}`);
      } finally {
        clearTimeout(timer);
        gpLoading.value = false;
        gpFetched.value = true;
        toast.remove(toastId);
      }
    }

    // ── My Stats tab: lazy player ship stats + trend ──────────────────────
    const myStatsLoaded = ref(false);
    async function loadMyStats() {
      if (myStatsLoaded.value) return;
      const acc = accounts.activeAccount;
      if (!acc || !props.ship) return;
      myStatsLoaded.value = true;
      void shipStats.load(acc.accountId, acc.realm).catch(() => {});
      void trends.loadPlayer(acc.accountId, acc.realm).catch(() => {});
    }

    watch(
      () => props.ship,
      (s) => {
        tab.value = "specs";
        gameparams.value = null;
        gpFetched.value = false;
        gpError.value = null;
        myStatsLoaded.value = false;
        skillRank.value = {};
        skillHealthPct.value = 1;
        if (s) {
          void loadGameparams();
          void trends.loadCommunity(s.shipId);
        }
      },
      { immediate: true },
    );

    function selectTab(name: typeof tab.value) {
      tab.value = name;
      if (name === "mystats") void loadMyStats();
    }

    const open = computed(() => props.ship !== null);

    const myShipStats = computed(() => {
      const acc = accounts.activeAccount;
      if (!acc || !props.ship) return null;
      return shipStats.getShip(acc.accountId, acc.realm, props.ship.shipId);
    });

    const relevantPatches = computed(() => {
      if (!props.ship || !trends.playerTrend) return [];
      return trends.playerTrend.patches.filter((p) => p.shipIds.includes(props.ship!.shipId));
    });

    const dp = computed(() => (props.ship?.defaultProfile ?? {}) as Record<string, unknown>);

    // ── Armor overlay data (from GameParams, passed to ShipStage) ──────────
    const armorZones = computed<ArmorZone[]>(() => {
      const gp = gameparams.value as Record<string, any> | null;
      if (!gp) return [];
      try {
        function num(v: unknown): number | undefined {
          if (v == null) return undefined;
          const n = typeof v === "number" ? v : Number(v);
          return Number.isFinite(n) && n > 0 ? n : undefined;
        }
        function segThickness(seg: unknown): number | undefined {
          if (seg == null) return undefined;
          if (typeof seg === "number") return seg > 0 ? seg : undefined;
          if (typeof seg === "object") {
            const o = seg as Record<string, unknown>;
            return num(o.max) ?? num(o.min) ?? num(o.fore) ?? num(o.aft);
          }
          return undefined;
        }
        // Probe several possible GameParams layouts (varies by unpacker).
        const armor = (gp.ShipArmor ?? gp.Armor ?? gp.HullArmor ?? {}) as Record<string, unknown>;
        const citadel = (armor.Citadel ?? gp.Citadel ?? (gp.A_Hull as any)?.Citadel) as Record<string, unknown> | undefined;
        const zones: ArmorZone[] = [];
        const add = (name: string, mm: number | undefined) => {
          if (mm != null && mm > 0) zones.push({ name, thickness: mm });
        };
        add("citadel", segThickness(citadel)
          ?? segThickness(armor?.MainBelt ?? armor?.Belt)
          ?? segThickness(gp?.mainBelt));
        add("casemate", segThickness(armor?.Casemate ?? armor?.CasemateArmor));
        add("deck", segThickness(armor?.Deck ?? armor?.DeckArmor));
        const extT = segThickness(armor?.Bow ?? armor?.Extremities ?? armor?.Ends);
        add("bow", extT);
        add("stern", extT);
        add("mainBelt", segThickness(armor?.MainBelt ?? armor?.Belt ?? armor?.WaterlineBelt)
          ?? segThickness(gp?.mainBelt));
        // Torpedo belt — reduction % converted to a representative value.
        const tb = (armor?.TorpedoBelt ?? armor?.TorpedoProtection) as Record<string,unknown> | undefined;
        if (tb?.factor != null) add("torpedoBelt", Math.round((1 - Number(tb.factor)) * 100));
        // Fallback: read the flat per-part armour dict (A_Hull.armor).
        // Use DISTINCT sorted thicknesses for zone assignment so each
        // zone gets a visibly different colour.
        if (zones.length === 0) {
          const hull = (gp.A_Hull ?? gp.Hull ?? {}) as Record<string, unknown>;
          const dict = (hull.armor ?? hull.Armor ?? null) as Record<string, number> | null;
          if (dict) {
            const vals = [...new Set(Object.values(dict).filter((v: number) => v > 0))]
              .sort((a: number, b: number) => b - a);
            if (vals.length > 0) {
              add("citadel", vals[0]);
              if (vals.length > 1) add("mainBelt", vals[1]);
              if (vals.length > 2) add("deck", vals[2]);
              if (vals.length > 3) add("casemate", vals[3]);
              if (vals.length > 4) add("bow", vals[Math.min(4, vals.length - 1)]);
              if (vals.length > 5) add("stern", vals[Math.min(5, vals.length - 1)]);
              if (vals.length > 6) add("torpedoBelt", vals[Math.min(6, vals.length - 1)]);
            }
          }
        }
        return zones;
      } catch {
        return [];
      }
    });

    // ── Waterline from GameParams (optional, falls back to geometry) ──────
    const waterlineDraft = computed<number | null>(() => {
      const gp = gameparams.value as Record<string, any> | null;
      if (!gp) return null;
      function num(v: unknown): number | null {
        if (v == null) return null;
        const n = typeof v === "number" ? v : Number(v);
        return Number.isFinite(n) && n > 0 ? n : null;
      }
      const hull = (gp.A_Hull ?? gp.Hull ?? {}) as Record<string, unknown>;
      return num(hull.draft) ?? num(hull.maxDraft) ?? num(hull.Draft) ?? num(hull.MaxDraft) ?? null;
    });

    function nationLabel(code: string): string {
      // Follows the 素材翻译 setting (国服 → X-系 names), UI i18n fallback.
      return (
        nationNameFromDb(code, useLanguage().dataLanguage.value) ??
        (t(`ships.nation.${code}`, {}) || code)
      );
    }
    function typeLabel(code: string): string {
      return t(`ships.type.${code}`, {}) || code;
    }

    const rarity = computed(() =>
      props.ship ? shipRarity(props.ship) : "common",
    );
    const typeShort = computed(() =>
      props.ship ? SHIP_TYPE_SHORT[props.ship.type] ?? "?" : "?",
    );

    return () => (
      <HModal
        modelValue={open.value}
        onUpdate:modelValue={(v: boolean) => !v && emit("close")}
        title={props.ship ? `${tierToRoman(props.ship.tier)} ${useEncyclopediaStore().shipDisplayName(props.ship)}` : t("ships.detail.title")}
        width="80vw"
      >
        {!props.ship ? null : (
          <div class="ship-detail">
            {/* holographic stage: shown for all tabs except skill (where data observer replaces it) */}
            {tab.value !== "skill" ? (
              <>
                <ShipStage ref={stageRef} ship={props.ship} armorZones={armorZones.value} waterlineDraft={waterlineDraft.value} />
                <WeaponBar gameparams={gameparams.value as Record<string, unknown> | null} onFocus={onWeaponFocus} />
              </>
            ) : (
              /* Data observer: replaces the stage when in the captain skills tab */
              <DataObserver
                ship={props.ship}
                rank={skillRank.value}
                healthPct={skillHealthPct.value}
              />
            )}

            {/* identity header */}
            <div class="ship-detail__id">
              <HTag variant="primary">{tierToRoman(props.ship.tier)}</HTag>
              <HTag variant="primary">{typeLabel(props.ship.type)} ({typeShort.value})</HTag>
              <NationFlag
                nation={props.ship.nation}
                label={nationLabel(props.ship.nation)}
                variant="flag"
                size="md"
                showLabel
              />
              <HTag variant={RARITY_VARIANT[rarity.value]}>
                {t(`ships.rarity.${rarity.value}`)}
              </HTag>
            </div>

            {props.ship.description ? (
              <p class="ship-detail__desc">{props.ship.description}</p>
            ) : null}

            {/* tab bar — hikari pill tab strip */}
            <HTabs
              variant="pill"
              modelValue={tab.value}
              onUpdate:modelValue={(v: string) => selectTab(v as typeof tab.value)}
              tabs={(["specs", "mystats", "community", "skill"] as const).map((name) => ({
                key: name,
                label: t(`ships.detail.tab${name === "specs" ? "Specs" : name === "mystats" ? "MyStats" : name === "community" ? "Community" : "Skill"}`),
              }))}
            />

            {/* tab content */}
            <div class="ship-detail__body">
              <Transition name="s-fade-slide" mode="out-in">
                {tab.value === "specs" ? (
                  <div key="specs"><SpecsPanel profile={dp.value} nation={props.ship.nation} /></div>
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
              ) : (
                <div class="ship-detail__skill" key="skill">
                  {/* HP slider for Adrenaline Rush effect in DataObserver */}
                  <div class="ship-detail__hp-slider">
                    <label class="ship-detail__hp-label">
                      {t("ships.shipyard.healthSlider")}:
                      <strong>{Math.round(skillHealthPct.value * 100)}%</strong>
                    </label>
                    <input
                      class="ship-detail__hp-input"
                      type="range"
                      min={1}
                      max={100}
                      step={1}
                      value={Math.round(skillHealthPct.value * 100)}
                      onInput={(e) => (skillHealthPct.value = Number((e.target as HTMLInputElement).value) / 100)}
                    />
                  </div>
                  <SkillBuilder
                    shipType={props.ship.type}
                    modelRank={skillRank.value}
                    onUpdate:modelRank={(r: Record<string, number>) => (skillRank.value = r)}
                  />
                </div>
              )}
              </Transition>
            </div>
          </div>
        )}
      </HModal>
    );
  },
});

/** Player-friendly specs panel. */
const SpecsPanel = defineComponent({
  name: "SpecsPanel",
  props: {
    profile: { type: Object as () => Record<string, unknown> | null, default: null },
    nation: { type: String, default: undefined },
  },
  setup(props) {
    const toast = useToast();
    const groups = computed(() => buildShipSpecs(props.profile, props.nation));
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
    function copy(val: string) {
      navigator.clipboard.writeText(val).then(() => toast.info(t("ships.copied")), () => {});
    }
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
                      <dd
                        class="specs-group__value"
                        title={t("ships.copied")}
                        onClick={() => copy(String(row.value))}
                      >{row.value}</dd>
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
