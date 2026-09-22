import { computed, defineComponent, ref, Transition, watch } from "vue";
import { Sparkles, Shield, Crosshair, Target, Plane, Gauge, Eye, HelpCircle } from "@lucide/vue";

import { HButton, HModal, HTag, HTabs, useToast } from "@celestia-island/hikari";

import NationFlag from "@/components/base/NationFlag";
import GamePathSetupModal from "@/components/gamedetect/GamePathSetupModal";
import { useAccountStore } from "@/stores/account";
import { useEncyclopediaStore } from "@/stores/encyclopedia";
import { useShipStatsStore } from "@/stores/shipStats";
import { useRankedStore } from "@/stores/ranked";
import { useTrendsStore } from "@/stores/trends";
import { api, type ShipInfo } from "@/api";
import { useLanguage } from "@/i18n/useLanguage";
import { nationNameFromDb } from "@/features/holographic/modelLoader";
import { t } from "@/i18n";
import { winrateColor } from "@/utils/winrate";
import { buildShipSpecs } from "./shipSpecs";
import BuildPlanner from "./BuildPlanner";
import ShipMyStatsPanel from "./ShipMyStatsPanel";
import ServerTrendPanel from "./ServerTrendPanel";
import { emptyBuild, type PlannerBuild } from "./modifierPipeline";
import ShipStage, { type FocusZone, type ArmorZone } from "./ShipStage";
import WeaponBar from "./WeaponBar";
import { shipRarity, RARITY_VARIANT } from "@/utils/shipRarity";
import { SHIP_TYPE_SHORT } from "@/utils/shipAggregation";
import { tierToRoman } from "@/utils/tierRoman";
import "./ShipDetailModal.scss";

/**
 * Ship detail modal with tabs:
 *  - Specs: WG default_profile fields (HP / artillery / mobility / etc.)
 *  - My Stats: per-player per-ship stats + recent windows + trend line
 *  - Server Trend: wows-numbers server-wide averages + community trend
 *  - Captain Skills: skill planner + data observer (replaces 2D/3D preview)
 *
 * Open contexts differ: the encyclopedia opens on "specs" with the
 * holographic stage visible; water-table panels (`source: "water"`) open on
 * "my stats" with the stage collapsed (one click brings it back). The
 * accountId/realm props pin whose per-ship stats "My Stats" shows — the
 * lookup view passes the searched player, otherwise the bound account.
 */
export default defineComponent({
  name: "ShipDetailModal",
  props: {
    ship: { type: Object as () => ShipInfo | null, default: null },
    gameRoot: { type: String, default: "" },
    /** Where the modal was opened from — decides the default tab and whether
     *  the holographic stage starts expanded or collapsed. */
    source: {
      type: String as () => "encyclopedia" | "water",
      default: "encyclopedia",
    },
    /** Player whose per-ship stats the "My Stats" tab shows. Falls back to
     *  the bound account when omitted (encyclopedia context). */
    accountId: { type: Number as () => number | null, default: null },
    realm: { type: String as () => string | null, default: null },
  },
  emits: {
    close: () => true,
  },
  setup(props, { emit }) {
    const accounts = useAccountStore();
    const shipStats = useShipStatsStore();
    const ranked = useRankedStore();
    const trends = useTrendsStore();
    const toast = useToast();

    const tab = ref<"specs" | "mystats" | "community" | "skill">("specs");

    /** Holographic stage collapsed (water-table opens hidden; the toggle in
     *  the stage's control row brings it back). */
    const stageHidden = ref(false);

    // ── Build-planner state (skills / commander / flags / upgrades / HP) ──
    const build = ref<PlannerBuild>(emptyBuild());

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
    const showPathSetup = ref(false);

    async function loadGameparams() {
      if (gpFetched.value || !props.ship) return;
      gpLoading.value = true;
      gpError.value = null;
      const toastId = toast.loading(t("ships.detail.gameparamsLoading"));
      // First load per ship unpacks GameParams.data from the install (a few
      // seconds even on release builds) — keep the loading toast up long
      // enough to cover it; the finally block dismisses it on completion.
      const timer = setTimeout(() => toast.remove(toastId), 90_000);
      // Guard the switch-ships-while-loading race: if the user moves to
      // another ship while this fetch is in flight, the watch already reset
      // the state — a late resolve for the OLD ship must not clobber the
      // new ship's gameparams (armor tab, WeaponBar, AA spec rows).
      const requestedId = props.ship.shipId;
      try {
        const gp = await api.getShipGameparams(requestedId, props.gameRoot);
        if (props.ship?.shipId === requestedId) gameparams.value = gp;
      } catch (e) {
        const msg = (e as Error).message || String(e);
        if (props.ship?.shipId === requestedId) gpError.value = msg;
        toast.error(`${t("ships.detail.gameparamsErrorTip")}\n${msg}`);
      } finally {
        clearTimeout(timer);
        gpLoading.value = false;
        gpFetched.value = true;
        toast.remove(toastId);
      }
    }

    function retryGameparams() {
      gpFetched.value = false;
      gpError.value = null;
      void loadGameparams();
    }

    // When the game root changes (user picked a path in the setup modal or
    // the process watcher synthesized one), automatically re-run a failed
    // armor load — no extra click needed.
    watch(
      () => props.gameRoot,
      (root, prev) => {
        if (root && prev !== root && gpError.value && !gpLoading.value) {
          retryGameparams();
        }
      },
    );

    // ── My Stats tab: lazy player ship stats + trend ──────────────────────
    const myStatsLoaded = ref(false);

    /** Whose stats the My Stats tab shows: the explicit player context
     *  (water-table opens pass the viewed player) or the bound account. */
    const playerCtx = computed(() => {
      if (props.accountId != null && props.realm) {
        return { accountId: props.accountId, realm: props.realm };
      }
      return accounts.activeAccount
        ? { accountId: accounts.activeAccount.accountId, realm: accounts.activeAccount.realm }
        : null;
    });

    async function loadMyStats() {
      if (myStatsLoaded.value) return;
      const acc = playerCtx.value;
      if (!acc || !props.ship) return;
      myStatsLoaded.value = true;
      void shipStats.load(acc.accountId, acc.realm).catch(() => {});
      void ranked.load(acc.accountId, acc.realm, 5).catch(() => {});
      void trends.loadPlayer(acc.accountId, acc.realm).catch(() => {});
    }

    watch(
      () => props.ship,
      (s) => {
        // Water-table opens land straight on My Stats with the hologram
        // collapsed; encyclopedia opens keep the specs-first full stage.
        // Closing (ship → null) must NOT run this reset: the leave
        // animation is still folding the old content, and re-seating the
        // tab/stage mid-fold blanks what the user is looking at. Every
        // meaningful open re-runs the reset anyway.
        if (!s) return;
        const water = props.source === "water";
        tab.value = water ? "mystats" : "specs";
        stageHidden.value = water;
        gameparams.value = null;
        gpFetched.value = false;
        gpError.value = null;
        myStatsLoaded.value = false;
        build.value = emptyBuild();
        void loadGameparams();
        void trends.loadCommunity(s.shipId);
        if (water) void loadMyStats();
      },
      { immediate: true },
    );

    function selectTab(name: typeof tab.value) {
      tab.value = name;
      if (name === "mystats") void loadMyStats();
    }

    const open = computed(() => props.ship !== null);

    // ── Leave-animation snapshot ─────────────────────────────────────────
    // Views null the ship prop on the close edge (the `close` emit), so the
    // live prop goes empty while the modal is still folding out. Render
    // against the last non-null ship so the exit animation frames the real
    // content instead of a blank shell — belt-and-braces on top of hikari's
    // modal content hold (same discipline as shittim-chest's log windows,
    // which never clear their payload on the close arm).
    const heldShip = ref<ShipInfo | null>(null);
    watch(
      () => props.ship,
      (s) => {
        if (s) heldShip.value = s;
      },
      { immediate: true },
    );
    const viewShip = computed(() => props.ship ?? heldShip.value);

    const myShipStats = computed(() => {
      const acc = playerCtx.value;
      const ship = viewShip.value;
      if (!acc || !ship) return null;
      return shipStats.getShip(acc.accountId, acc.realm, ship.shipId);
    });

    /** Player-side numbers feeding the server-trend comparison table. */
    const serverCompare = computed(() => {
      const s = myShipStats.value;
      if (!s || s.battles <= 0) return null;
      return {
        winrate: s.winrate,
        avgDamage: s.avgDamage,
        avgFrags: s.frags / Math.max(1, s.battles),
      };
    });

    const relevantPatches = computed(() => {
      const ship = viewShip.value;
      if (!ship || !trends.playerTrend) return [];
      return trends.playerTrend.patches.filter((p) => p.shipIds.includes(ship.shipId));
    });

    const dp = computed(() => (viewShip.value?.defaultProfile ?? {}) as Record<string, unknown>);

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

    const rarity = computed(() => {
      const ship = viewShip.value;
      return ship ? shipRarity(ship) : "common";
    });
    const typeShort = computed(() => {
      const ship = viewShip.value;
      return ship ? SHIP_TYPE_SHORT[ship.type] ?? "?" : "?";
    });

    return () => (
      <HModal
        modelValue={open.value}
        onUpdate:modelValue={(v: boolean) => !v && emit("close")}
        title={viewShip.value ? `${tierToRoman(viewShip.value.tier)} ${useEncyclopediaStore().shipDisplayName(viewShip.value)}` : t("ships.detail.title")}
        width="80vw"
      >
        {!viewShip.value ? null : (
          <div class="ship-detail">
            {/* holographic stage: shown for all tabs except skill (where the
                build planner replaces it). Water-table opens start with the
                stage collapsed — only its control row (3D/2D + visibility
                toggle) remains, everything else is truly unmounted. */}
            {tab.value !== "skill" ? (
              <>
                <ShipStage
                  ref={stageRef}
                  ship={viewShip.value}
                  armorZones={armorZones.value}
                  waterlineDraft={waterlineDraft.value}
                  hidden={stageHidden.value}
                  onUpdate:hidden={(v: boolean) => (stageHidden.value = v)}
                />
                {!stageHidden.value ? (
                  <WeaponBar gameparams={gameparams.value as Record<string, unknown> | null} onFocus={onWeaponFocus} />
                ) : null}
              </>
            ) : null}

            {/* identity header */}
            <div class="ship-detail__id">
              <HTag variant="primary">{tierToRoman(viewShip.value.tier)}</HTag>
              <HTag variant="primary">{typeLabel(viewShip.value.type)} ({typeShort.value})</HTag>
              <NationFlag
                nation={viewShip.value.nation}
                label={nationLabel(viewShip.value.nation)}
                variant="flag"
                size="md"
                showLabel
              />
              <HTag variant={RARITY_VARIANT[rarity.value]}>
                {t(`ships.rarity.${rarity.value}`)}
              </HTag>
            </div>

            {viewShip.value.description ? (
              <p class="ship-detail__desc">{viewShip.value.description}</p>
            ) : null}

            {/* Armor-data failure banner: shows the backend error plus the
                two recovery paths — re-run the load (retry after a path
                change or game update) or open the game-path setup modal. */}
            {gpError.value ? (
              <div class="ship-detail__gp-error">
                <span class="ship-detail__gp-error-msg">{gpError.value}</span>
                <HButton size="sm" variant="secondary" onClick={() => retryGameparams()}>
                  {t("common.retry")}
                </HButton>
                <HButton size="sm" onClick={() => (showPathSetup.value = true)}>
                  {t("common.gamePath.setAction")}
                </HButton>
              </div>
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
                  <div key="specs"><SpecsPanel profile={dp.value} nation={viewShip.value.nation} gameparams={gameparams.value as Record<string, unknown> | null} /></div>
                ) : tab.value === "mystats" ? (
                <div class="ship-detail__mystats" key="mystats">
                  <ShipMyStatsPanel
                    stats={myShipStats.value}
                    accountId={playerCtx.value?.accountId ?? null}
                    realm={playerCtx.value?.realm ?? null}
                    loading={shipStats.loading}
                  />

                  {/* A single version bucket is no trend — hide the chart
                      until there are at least two versions to compare. */}
                  {trends.playerTrend && trends.playerTrend.buckets.length > 1 ? (
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
                  <ServerTrendPanel shipId={viewShip.value.shipId} compare={serverCompare.value} />
                  {trends.communityTrend?.available &&
                  trends.communityTrend.buckets.length > 1 ? (
                    <div class="ship-detail__trend">
                      <h4>{t("trend.winrateOverTime")}</h4>
                      <TrendBars buckets={trends.communityTrend.buckets} patches={[]} />
                    </div>
                  ) : null}
                </div>
              ) : (
                <div class="ship-detail__skill" key="skill">
                  <BuildPlanner
                    ship={viewShip.value}
                    build={build.value}
                    gameRoot={props.gameRoot}
                    gameparams={gameparams.value as Record<string, unknown> | null}
                    onUpdate:build={(b: PlannerBuild) => (build.value = b)}
                  />
                </div>
              )}
              </Transition>
            </div>
          </div>
        )}

        {/* Nested game-path setup (opened from the armor-error banner). */}
        <GamePathSetupModal
          modelValue={showPathSetup.value}
          onUpdate:modelValue={(v: boolean) => (showPathSetup.value = v)}
        />
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
    /** Raw GameParams entry (lazy-fetched by the modal) — feeds the
     *  per-band AA rows the WG profile cannot provide. */
    gameparams: { type: Object as () => Record<string, unknown> | null, default: null },
  },
  setup(props) {
    const toast = useToast();
    const groups = computed(() => buildShipSpecs(props.profile, props.nation, props.gameparams));
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
                          <span class="specs-group__hint" data-hint={t(`ships.spec.${row.hint}`)}>
                            <HelpCircle size={11} />
                          </span>
                        ) : null}
                      </dt>
                      <dd
                        class="specs-group__value"
                        data-hint={t("common.clickToCopy")}
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
                  <span class="trend-bars__patch" data-hint={patch.summary}><Sparkles size={12} /></span>
                ) : null}
                <div
                  class="trend-bars__bar"
                  style={{
                    height: `${heightPct}%`,
                    background: winrateColor(b.winrateAvg),
                  }}
                  data-hint={`${b.version}: ${b.winrateAvg.toFixed(1)}% WR, ${b.avgDamage.toFixed(0)} avg dmg (${b.snapshotCount} snapshots)`}
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
